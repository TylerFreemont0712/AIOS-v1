#!/usr/bin/env bash
# AIOS desktop launcher — make running the hub a one-click affair.
#
#   aios-launch.sh            RESTART: kill any running server, start a fresh one, open it
#   aios-launch.sh --restart  same as the default click (explicit)
#   aios-launch.sh --start    start only if it's down, else just open it (never kills)
#   aios-launch.sh --open     just open the hub in your browser
#   aios-launch.sh --stop     stop the server
#
# The desktop icon's default click is a *restart* button: it always brings up a
# fresh server (so code changes take effect), killing an existing instance first.
#
# Env hooks (handy for scripting/testing):
#   AIOS_NO_OPEN=1   don't launch the browser
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

stop_server() {
  local pid=""
  [ -f "$PIDFILE" ] && pid="$(cat "$PIDFILE" 2>/dev/null)"

  # Prefer the recorded PID, but only if it's really our server.
  is_aios_pid "$pid" && kill "$pid" 2>/dev/null || true
  # Sweep for any server/index.js under this project too — covers a stale pidfile,
  # `npm start`, or an orphaned instance the launcher never recorded.
  pkill -f "${PROJECT_DIR}/server/index.js" 2>/dev/null || true
  pkill -f "server/index.js"                2>/dev/null || true

  # Wait for the port to actually free; escalate to SIGKILL if it clings on.
  local i
  for i in $(seq 1 20); do
    is_up || { rm -f "$PIDFILE"; notify "Server stopped."; return 0; }
    sleep 0.5
  done
  is_aios_pid "$pid" && kill -9 "$pid" 2>/dev/null || true
  pkill -9 -f "${PROJECT_DIR}/server/index.js" 2>/dev/null || true
  pkill -9 -f "server/index.js"                2>/dev/null || true
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
  echo $! > "$PIDFILE"

  # Wait up to ~20s for it to answer, then open the browser.
  local _n
  for _n in $(seq 1 40); do
    if is_up; then
      notify "Running at ${URL}"
      open_url
      return 0
    fi
    sleep 0.5
  done
  notify "Didn't start within 20s — see $(basename "$LOG")"
  command -v zenity >/dev/null 2>&1 && zenity --error --title="AIOS" \
    --text="AIOS didn't come up within 20 seconds.\nCheck ${LOG}" 2>/dev/null || true
  return 1
}

# Kill whatever is running (if anything), then bring up a fresh server.
restart_server() {
  if is_up; then
    notify "Restarting AIOS…"
    stop_server
  else
    # Nothing answering on the port — clear a stale pidfile / orphan quietly.
    rm -f "$PIDFILE"
    pkill -f "${PROJECT_DIR}/server/index.js" >/dev/null 2>&1 || true
  fi
  start_server
}

case "${1:-}" in
  --stop)    stop_server;    exit 0 ;;
  --open)    open_url;       exit 0 ;;
  --restart) restart_server; exit $? ;;
  --start)
    # Start only if it's down; otherwise just bring it to the front (never kills).
    if is_up; then open_url; exit 0; fi
    start_server; exit $? ;;
esac

# Default double-click = restart button: always bring up a fresh server.
restart_server
exit $?
