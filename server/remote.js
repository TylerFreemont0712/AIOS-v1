// Remote access — reaching this hub from outside the house.
//
// The transport is Tailscale: a private WireGuard mesh, so AIOS is never on the
// public internet the way a port-forward or a Cloudflare tunnel would put it.
// `tailscale serve` then fronts port 7777 with a real Let's Encrypt certificate on
// the machine's permanent `<host>.<tailnet>.ts.net` name.
//
// The certificate is the point, not a nicety. Two things on the phone need a
// *secure context* and silently do not exist without one:
//   - getUserMedia — the microphone. Voice has never worked on a phone over the
//     LAN's plain http, and the failure mode is that navigator.mediaDevices is
//     undefined rather than a permission prompt being denied (see voice.js).
//   - a stable origin for Add to Home Screen. The PWA is pinned to an origin, so
//     a name that changes (a quick tunnel's random subdomain) means a new icon,
//     an empty localStorage and re-pairing every restart.
// A ts.net name is permanent and its cert is real, so both just work.
//
// Nothing here shells out with a shell: every call is execFile with an argv array,
// so a tailnet name with a quote in it cannot become a command.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { loadConfig } from './config.js';

const run = promisify(execFile);

// `tailscale status` on a box whose daemon is wedged blocks rather than failing, and
// this is called from a status endpoint the dashboard polls. Every call is bounded.
const TIMEOUT = 6000;

/** execFile that resolves to {ok, out, err} instead of throwing. */
async function tsc(args, timeout = TIMEOUT) {
  try {
    const { stdout } = await run('tailscale', args, { timeout, encoding: 'utf8' });
    return { ok: true, out: stdout.trim(), err: '' };
  } catch (e) {
    // ENOENT means not installed; a non-zero exit means installed but unhappy, and
    // its stderr is the actionable half ("Logged out.", "needs login", …).
    return { ok: false, out: (e.stdout || '').trim(), err: (e.stderr || e.message || '').trim(), code: e.code };
  }
}

let cached = null;
let cachedAt = 0;
const CACHE_MS = 4000;   // the phone's Home screen polls; don't fork twice a second

/** Drop the memoised status — call after anything that changes serve/login state. */
export function invalidate() { cached = null; }

/**
 * Everything the UI needs to describe the remote-access situation in one call,
 * including what the user must do next when it isn't working yet.
 */
export async function status({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < CACHE_MS) return cached;

  const port = loadConfig().server.port;
  const out = {
    transport: 'tailscale',
    installed: false, version: '', daemon: 'absent', loggedIn: false, backendState: '',
    self: null, tailnet: '', magicDNS: false,
    operatorOk: false, https: false, serve: { on: false, url: '', target: '' },
    url: '', port, hint: '', hintCmd: '',
  };

  const ver = await tsc(['version']);
  if (!ver.ok && ver.code === 'ENOENT') {
    out.hint = 'Tailscale is not installed on this machine.';
    out.hintCmd = 'npm run remote-setup';
    cached = out; cachedAt = Date.now();
    return out;
  }
  out.installed = true;
  out.version = ver.out.split('\n')[0] || '';

  const st = await tsc(['status', '--json']);
  if (!st.ok && !st.out) {
    // The CLI is present but the daemon isn't answering.
    out.daemon = 'stopped';
    out.hint = 'The tailscaled daemon is not running.';
    out.hintCmd = 'sudo systemctl enable --now tailscaled';
    cached = out; cachedAt = Date.now();
    return out;
  }

  let js = null;
  try { js = JSON.parse(st.out); } catch { /* fall through to the generic hint below */ }
  if (!js) {
    out.daemon = 'stopped';
    out.hint = st.err || 'Could not read Tailscale status.';
    out.hintCmd = 'tailscale status';
    cached = out; cachedAt = Date.now();
    return out;
  }

  out.daemon = 'running';
  out.backendState = js.BackendState || '';
  out.loggedIn = out.backendState === 'Running';
  out.magicDNS = !!(js.CurrentTailnet?.MagicDNSEnabled);
  out.tailnet = js.CurrentTailnet?.Name || (js.MagicDNSSuffix || '');

  if (js.Self) {
    // DNSName arrives fully qualified with a trailing dot — "nitro.tail1234.ts.net."
    const dns = String(js.Self.DNSName || '').replace(/\.$/, '');
    out.self = {
      host: js.Self.HostName || os.hostname(),
      dnsName: dns,
      ip: (js.Self.TailscaleIPs || []).find(a => a.includes('.')) || '',
      online: !!js.Self.Online,
    };
  }

  if (!out.loggedIn) {
    out.hint = out.backendState === 'NeedsLogin' || out.backendState === 'Stopped'
      ? 'Tailscale is installed but this machine has not joined your tailnet yet.'
      : `Tailscale backend state: ${out.backendState || 'unknown'}.`;
    out.hintCmd = 'sudo tailscale up';
    cached = out; cachedAt = Date.now();
    return out;
  }

  // Can we drive `tailscale serve` as this (non-root) user? Without the operator set,
  // serve needs sudo, which a server process must never attempt on its own.
  const who = await tsc(['debug', 'prefs']);
  if (who.ok) {
    try { out.operatorOk = (JSON.parse(who.out).OperatorUser || '') === os.userInfo().username; }
    catch { /* older CLI without that field — the serve probe below settles it anyway */ }
  }

  const sv = await tsc(['serve', 'status', '--json']);
  if (sv.ok && sv.out && sv.out !== 'null') {
    try {
      const cfg = JSON.parse(sv.out);
      // Shape: { TCP: {443:{HTTPS:true}}, Web: { "host:443": { Handlers: { "/": {Proxy:"http://127.0.0.1:7777"} } } } }
      for (const [hostPort, web] of Object.entries(cfg.Web || {})) {
        for (const [route, handler] of Object.entries(web.Handlers || {})) {
          const proxy = handler.Proxy || '';
          if (!proxy.includes(`:${port}`)) continue;
          out.serve = { on: true, url: `https://${hostPort.replace(/:443$/, '')}${route === '/' ? '' : route}`, target: proxy };
        }
      }
    } catch { /* unparseable serve config — treated as off */ }
  } else if (!sv.ok && /permission|operator|access denied/i.test(sv.err)) {
    out.operatorOk = false;
  }

  out.https = out.serve.on;
  out.url = out.serve.on ? out.serve.url : (out.self?.dnsName ? `http://${out.self.dnsName}:${port}` : '');

  if (!out.serve.on) {
    out.hint = out.operatorOk
      ? 'Connected to your tailnet. Turn on HTTPS to enable the phone microphone and Add to Home Screen.'
      : 'Connected, but AIOS cannot run `tailscale serve` as this user yet.';
    out.hintCmd = out.operatorOk ? '' : `sudo tailscale set --operator=${os.userInfo().username}`;
  }

  cached = out; cachedAt = Date.now();
  return out;
}

/**
 * Put port 7777 behind HTTPS on the tailnet name.
 *
 * The first call is slow — Tailscale fetches a Let's Encrypt certificate, which
 * needs HTTPS certificates enabled for the tailnet in the admin console. That is a
 * one-time checkbox and it is the single most common reason this fails, so the
 * error is matched and translated rather than passed through raw.
 */
export async function enableServe() {
  const s = await status({ fresh: true });
  if (!s.installed) throw Object.assign(new Error('Tailscale is not installed — run `npm run remote-setup`.'), { status: 400 });
  if (!s.loggedIn) throw Object.assign(new Error('This machine has not joined your tailnet — run `sudo tailscale up`.'), { status: 400 });

  const r = await tsc(['serve', '--bg', '--https=443', String(s.port)], 90000);
  invalidate();
  if (!r.ok) {
    const err = r.err || 'tailscale serve failed';
    if (/HTTPS.*(not enabled|disabled)|cert.*not.*enabled|EnableHTTPS/i.test(err)) {
      throw Object.assign(new Error(
        'Tailscale needs HTTPS certificates enabled for your tailnet. Open the admin console → DNS → enable HTTPS Certificates, then try again.'
      ), { status: 400 });
    }
    if (/permission|operator|access denied|must be root/i.test(err)) {
      throw Object.assign(new Error(
        `AIOS cannot run \`tailscale serve\` as this user. Run: sudo tailscale set --operator=${os.userInfo().username}`
      ), { status: 400 });
    }
    throw Object.assign(new Error(err), { status: 500 });
  }
  return status({ fresh: true });
}

/** Take the HTTPS front-end down. The tailnet IP keeps working on :7777. */
export async function disableServe() {
  const r = await tsc(['serve', '--https=443', 'off'], 20000);
  invalidate();
  if (!r.ok && !/not.*serving|no serve config/i.test(r.err)) {
    throw Object.assign(new Error(r.err || 'could not turn serve off'), { status: 500 });
  }
  return status({ fresh: true });
}

/**
 * The URLs to hand a phone, best first, each carrying the pairing token so the
 * link works from a photo or a message without typing the token by hand.
 */
export function pairingUrls(s, token) {
  const urls = [];
  const add = (u, label, secure) => u && urls.push({ url: u + (token ? `/?token=${encodeURIComponent(token)}` : ''), label, secure });
  if (s.serve.on) add(s.serve.url, 'Tailscale HTTPS', true);
  if (s.self?.dnsName) add(`http://${s.self.dnsName}:${s.port}`, 'Tailnet name', false);
  if (s.self?.ip) add(`http://${s.self.ip}:${s.port}`, 'Tailnet IP', false);
  return urls;
}
