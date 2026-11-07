#!/usr/bin/env bash
# AIOS desktop launcher — make running the hub a one-click affair.
#
#   aios-launch.sh            RESTART: kill any running server, start a fresh one,
#                             reset the Tailscale front-end, open it
#   aios-launch.sh --restart  same as the default click (explicit)
#   aios-launch.sh --start    start only if it's down, else just open it (never kills)
#   aios-launch.sh --tunnel   reset the Tailscale HTTPS front-end only
#   aios-launch.sh --open     just open the hub in your browser
#   aios-launch.sh --stop     stop the server (leaves the tunnel configured)
#
# The desktop icon's default click is a *restart* button: it always brings up a
# fresh server (so code changes take effect), killing an existing instance first —
# and then puts `tailscale serve` back in front of it, so the hub works from the
# phone and from outside the house, not just on localhost.
#
# Env hooks (handy for scripting/testing):
#   AIOS_NO_OPEN=1     don't launch the browser
#   AIOS_NO_TUNNEL=1   leave Tailscale alone
set -u

# Desktop launchers inherit a bare PATH — make sure brew's node and the system
# tools (xdg-open, notify-send, curl) resolve no matter who invokes us.
export PATH="/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SELF="$(readlink -f "$0")"
PROJECT_DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
PORT=7777
URL="http://localhost:${PORT}"
LOG="${PROJECT_DIR}/aios.log"
PIDFILE="${PROJECT_DIR}/aios.pid"
ICON="${PROJECT_DIR}/scripts/aios.svg"

notify() { command -v notify-send >/dev/null 2>&1 && notify-send -a "AIOS" -i "$ICON" "AIOS" "$1" >/dev/null 2>&1 || true; }
open_url() {
  [ -n "${AIOS_NO_OPEN:-}" ] && return 0
  command -v xdg-open >/dev/null 2>&1 && setsid xdg-open "$URL" >/dev/null 2>&1 &
  return 0
}

is_up() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 2 "${URL}/api/status" 2>/dev/null
  else
    (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null && exec 3>&-
  fi
}

# Does PID $1 belong to a live AIOS server? Guards against a stale pidfile whose
# number has since been recycled by an unrelated process.
is_aios_pid() {
  local p="${1:-}"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null || return 1
  ps -p "$p" -o args= 2>/dev/null | grep -q "server/index.js"
}

# Whoever is actually LISTENING on our port, however it was started.
#
# This is the authority, not the pidfile and not a cmdline pattern. A server started
# by hand (`npm start`), from an editor, or by a launcher whose pidfile has since gone
# stale answers on the port just the same — and a restart that cannot find it leaves
# the old code running while the new instance dies of EADDRINUSE. That is exactly what
# happened here: a six-day-old server kept serving while every restart quietly failed,
# so shipped changes never took effect.
port_owner() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :${PORT}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  elif command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null
  fi
}

# Has the port actually been released? port_owner is the authority here and costs
# ~5ms; is_up is the fallback for a box with neither ss nor lsof.
#
# Waiting on `is_up` instead is a trap, and it is the same trap as before, one step
# over: /api/status probes the model providers, so it answers in ~1ms warm but was
# measured at 3.9s on a COLD cache — against a 2s curl budget. A live server that is
# merely slow then reads as "stopped", stop_server returns early, and start_server
# races an instance that never died. Asking the OS who holds the port cannot be
# fooled by a slow handler.
port_free() {
  if command -v ss >/dev/null 2>&1 || command -v lsof >/dev/null 2>&1; then
    [ -z "$(port_owner)" ]
  else
    ! is_up
  fi
}

stop_server() {
  local pid=""
  [ -f "$PIDFILE" ] && pid="$(cat "$PIDFILE" 2>/dev/null)"

  # Prefer the recorded PID, but only if it's really our server.
  is_aios_pid "$pid" && kill "$pid" 2>/dev/null || true
  # Sweep for any server/index.js under this project too — covers a stale pidfile,
  # `npm start`, or an orphaned instance the launcher never recorded.
  pkill -f "${PROJECT_DIR}/server/index.js" 2>/dev/null || true
  pkill -f "server/index.js"                2>/dev/null || true
  # …and whatever still holds the port, which is the only check that cannot miss.
  # SIGTERM first: the server's handler stops MCP children and closes the socket,
  # and killing it outright orphans them.
  local owner
  for owner in $(port_owner); do kill "$owner" 2>/dev/null || true; done

  # Wait for the port to actually free; escalate to SIGKILL if it clings on.
  local i
  for i in $(seq 1 20); do
    port_free && { rm -f "$PIDFILE"; notify "Server stopped."; return 0; }
    sleep 0.5
  done
  is_aios_pid "$pid" && kill -9 "$pid" 2>/dev/null || true
  pkill -9 -f "${PROJECT_DIR}/server/index.js" 2>/dev/null || true
  pkill -9 -f "server/index.js"                2>/dev/null || true
  for owner in $(port_owner); do kill -9 "$owner" 2>/dev/null || true; done
  sleep 0.5
  rm -f "$PIDFILE"
  notify "Server stopped."
}

# Make sure node resolves (brew install lives outside a launcher's bare PATH).
ensure_node() {
  command -v node >/dev/null 2>&1 && return 0
  [ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1 || true
  [ -f "$HOME/.bashrc" ]  && . "$HOME/.bashrc"  >/dev/null 2>&1 || true
  command -v node >/dev/null 2>&1 && return 0
  notify "Couldn't find node — edit PATH in scripts/aios-launch.sh"
  command -v zenity >/dev/null 2>&1 && zenity --error --title="AIOS" \
    --text="node was not found on PATH.\nEdit the PATH line in scripts/aios-launch.sh." 2>/dev/null || true
  return 1
}

start_server() {
  ensure_node || return 1
  # Start detached so the hub outlives this launcher, and remember the PID.
  cd "$PROJECT_DIR" || { notify "Project folder missing: $PROJECT_DIR"; return 1; }
  setsid node server/index.js >> "$LOG" 2>&1 < /dev/null &
  local newpid=$!
  echo "$newpid" > "$PIDFILE"

  # Wait up to ~20s for it to answer, then open the browser.
  #
  # "Answers on the port" is NOT enough to call this started. If an old instance
  # survived the stop, it answers happily while the one we just launched dies of
  # EADDRINUSE — and the launcher reports success while the running code is whatever
  # was there before. That failure is invisible and can persist for days, so the
  # process we started has to be the one holding the port.
  local _n
  for _n in $(seq 1 40); do
    if is_up; then
      if kill -0 "$newpid" 2>/dev/null && port_owner | grep -qx "$newpid"; then
        notify "Running at ${URL}"
        open_url
        return 0
      fi
      # Someone else owns it. Say so loudly rather than pretending we restarted.
      if ! kill -0 "$newpid" 2>/dev/null; then
        notify "Start failed — an older AIOS still holds port ${PORT}. See $(basename "$LOG")"
        echo "aios-launch: the new server exited; port ${PORT} is held by: $(port_owner | tr '\n' ' ')" >&2
        return 1
      fi
    fi
    sleep 0.5
  done
  notify "Didn't start within 20s — see $(basename "$LOG")"
  command -v zenity >/dev/null 2>&1 && zenity --error --title="AIOS" \
    --text="AIOS didn't come up within 20 seconds.\nCheck ${LOG}" 2>/dev/null || true
  return 1
}

# ---------- the Tailscale front-end ----------
#
# Away-from-home access is half of "make the hub work again", so the restart button
# owns it too: `tailscale serve` is what fronts :7777 with a real certificate on the
# permanent <host>.<tailnet>.ts.net name, and that certificate is not a nicety. On the
# phone, getUserMedia (the microphone) and Add to Home Screen need a *secure context*
# and are silently ABSENT without one — see server/remote.js. A restart that fixes
# only localhost leaves the phone on a stale tunnel or none at all.
#
# Four rules here, all deliberate:
#   * It never escalates. `tailscale up` and `tailscale serve` run fine as the
#     operator (`sudo tailscale set --operator=$USER`, once). The things that need
#     root — the installer, starting tailscaled — are reported with the exact
#     command and never run. A launcher that sudo's on its own is a bad habit.
#   * It never fails the restart. Tailscale is optional; the hub is completely
#     usable on localhost and the LAN without it, so every path here returns 0 and
#     the launcher's exit code stays the server's.
#   * Every call is bounded. A wedged tailscaled BLOCKS rather than erroring, and
#     this sits on the critical path of a button someone just clicked.
#   * Errors are read from stdout as well as stderr. `tailscale serve` prints its
#     one-click "enable Serve for your tailnet" link on STDOUT with a non-zero exit;
#     reading stderr alone turns a one-tap fix into "Command failed".
TS_OUT=""
ts() {                       # ts <seconds> <args…> — combined output lands in $TS_OUT
  local t="$1"; shift
  TS_OUT="$(timeout "$t" tailscale "$@" 2>&1)"
}

ts_state() {                 # BackendState: Running | Stopped | NeedsLogin | …
  ts 10 status --json || return 1
  printf '%s' "$TS_OUT" | tr -d ' \n' | grep -o '"BackendState":"[A-Za-z]*"' | head -1 | cut -d'"' -f4
}

ts_dnsname() {               # joejin-nitro-an515-46.tail0036a2.ts.net (no trailing dot)
  ts 10 status --json || return 1
  printf '%s' "$TS_OUT" | tr -d ' \n' | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//'
}

# Is serve already fronting OUR port? Anything else — no config, or a handler left
# pointing at some other port — counts as off, because it is, for us.
tunnel_on() {
  ts 10 serve status --json || return 1
  printf '%s' "$TS_OUT" | tr -d ' \n' | grep -Eq "\"Proxy\":\"[^\"]*:${PORT}\""
}

# Turn tailscale's failure into the one sentence that fixes it. Mirrors the
# translations in server/remote.js so the icon and Settings → Remote say the same thing.
tunnel_explain() {
  local err="$1" link msg
  link="$(printf '%s' "$err" | grep -o 'https://login\.tailscale\.com/[^ ]*' | head -1)"
  if printf '%s' "$err" | grep -qi 'serve is not enabled'; then
    msg="Serve isn't enabled for your tailnet — enable it once: ${link:-https://login.tailscale.com/admin/settings/features}"
  elif printf '%s' "$err" | grep -qiE 'HTTPS.*(not enabled|disabled)|cert.*not.*enabled|EnableHTTPS'; then
    msg="Tailscale needs HTTPS certificates for your tailnet: admin console → DNS → Enable HTTPS Certificates."
  elif printf '%s' "$err" | grep -qiE 'permission|operator|access denied|must be root'; then
    msg="AIOS can't run \`tailscale serve\` as $(id -un). Run: sudo tailscale set --operator=$(id -un)"
  else
    msg="$(printf '%s' "$err" | head -1)"
  fi
  notify "Remote access: ${msg}"
  echo "aios-launch: tailscale serve failed — ${msg}" >&2
}

# Prove the tunnel end-to-end rather than trusting the flag: a serve config can look
# perfect while nothing answers through it.
#
# It probes `/`, deliberately NOT an /api route. Only /api sits behind the token
# (server/index.js mounts auth.middleware on it), and through `serve` this request
# arrives classified `tailnet` rather than loopback — so probing /api/status would 401
# *and* record a failed attempt against this machine's own tailnet IP on every single
# restart. Those accrue the per-IP backoff in server/auth.js (3 free tries, then 1s
# doubling to 15m), and a locked-out caller is refused even WITH the right token — so
# a handful of restarts in a row could lock this box out of its own hub. Measured:
# /api/status adds one refusal per probe, / adds none and answers 200 in ~20ms.
#
# Any HTTP reply counts as alive: TLS terminated and the proxy reached the hub. The
# real negative is a transport failure, which curl reports as 000 or as nothing.
tunnel_verify() {
  local dns="$1" code
  command -v curl >/dev/null 2>&1 || return 0
  code="$(timeout 15 curl -o /dev/null -s -w '%{http_code}' --max-time 12 "https://${dns}/" 2>/dev/null)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

# tunnel_up ensure  — bring it up if it isn't; leave a working one alone (--start)
# tunnel_up reset   — cycle it off and on again, like the server (--restart)
#
# Skip the whole thing with AIOS_NO_TUNNEL=1.
tunnel_up() {
  local mode="${1:-ensure}"
  [ -n "${AIOS_NO_TUNNEL:-}" ] && return 0
  command -v tailscale >/dev/null 2>&1 || return 0
  command -v timeout   >/dev/null 2>&1 || return 0

  local state
  state="$(ts_state)" || {
    notify "Tailscale daemon isn't answering — remote access is off."
    echo "aios-launch: tailscaled not answering. Start it with: sudo systemctl enable --now tailscaled" >&2
    return 0
  }

  # "Stopped" means the credentials are here and someone ran `tailscale down` (or the
  # daemon came up wanting to stay off). That is precisely what a reset button should
  # fix, and as the operator it needs no sudo. NeedsLogin/NeedsMachineAuth want a
  # browser and a human, so they are reported instead.
  if [ "$state" = "Stopped" ]; then
    notify "Bringing Tailscale back up…"
    ts 25 up --timeout=20s || true
    state="$(ts_state)" || state=""
  fi
  if [ "$state" != "Running" ]; then
    notify "Tailscale isn't connected (${state:-unknown}) — remote access is off."
    echo "aios-launch: tailscale backend state=${state:-unknown}; run: sudo tailscale up" >&2
    return 0
  fi

  local was_on=0
  tunnel_on && was_on=1

  if [ "$mode" = "reset" ] && [ "$was_on" = 1 ]; then
    # Surgical: only OUR :443 handler. `tailscale serve reset` would wipe every
    # service this node publishes, which is not what resetting AIOS means.
    ts 20 serve --https=443 off || true
  fi

  if [ "$mode" = "reset" ] || [ "$was_on" = 0 ]; then
    # A first cert can take a while; re-applying a cached one is instant.
    [ "$was_on" = 1 ] || notify "Setting up HTTPS on your tailnet…"
    ts 90 serve --bg --https=443 "$PORT" || { tunnel_explain "$TS_OUT"; return 0; }
  fi

  local dns; dns="$(ts_dnsname)" || dns=""
  [ -n "$dns" ] || return 0

  # Only worth probing when something is actually listening locally; a tunnel to a
  # stopped server is correctly configured and correctly unreachable.
  if ! port_free && ! tunnel_verify "$dns"; then
    notify "HTTPS is configured but https://${dns} didn't answer."
    echo "aios-launch: serve is on but https://${dns}/ did not respond" >&2
    return 0
  fi

  [ "$mode" = "reset" ] && notify "Remote access ready — https://${dns}"
  return 0
}

# Kill whatever is running (if anything), then bring up a fresh server, then put the
# tunnel back in front of it.
#
# stop_server runs UNCONDITIONALLY. The old code only swept properly when `is_up`
# said the server was answering; the "not answering" branch pkill'd the
# absolute-path pattern alone, which never matches how the server is actually
# started (`node server/index.js`, relative, from the project dir). So one flaky
# health check — a two-second curl timeout is all it takes — left the running
# instance untouched, the new one died of EADDRINUSE, and the launcher reported
# success. That is how a server from six days earlier kept serving stale code
# through every restart. stop_server is idempotent and costs nothing when nothing
# is running, so there is no reason to guess first.
#
# tunnel_up runs whatever the server did, and cannot change the exit code: the
# restart's verdict is the server's, and remote access is an optional extra.
restart_server() {
  is_up && notify "Restarting AIOS…"
  stop_server
  start_server
  local rc=$?
  tunnel_up reset
  return $rc
}

case "${1:-}" in
  # Stopping deliberately leaves serve configured: the config costs nothing while
  # the hub is down, survives to the next start without re-fetching a certificate,
  # and keeps the phone's Home-screen origin pointing somewhere real.
  --stop)    stop_server;    exit 0 ;;
  --open)    open_url;       exit 0 ;;
  --tunnel)  tunnel_up reset; exit 0 ;;
  --restart) restart_server; exit $? ;;
  --start)
    # Start only if it's down; otherwise just bring it to the front (never kills).
    # Same contract for the tunnel: ensure one exists, don't cycle a working one.
    if is_up; then open_url; tunnel_up ensure; exit 0; fi
    start_server; rc=$?; tunnel_up ensure; exit $rc ;;
esac

# Default double-click = restart button: always bring up a fresh server.
restart_server
exit $?
