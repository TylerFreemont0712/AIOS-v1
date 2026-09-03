// The wall that stands between the internet and a box with a shell on it.
//
// This suite exists because the hub is now reachable from outside the house. On a LAN
// with only trusted machines, `token === c.auth.token` with unlimited tries was
// tolerable. Once a request can arrive from anywhere, the auth path is the whole of
// the security model, and the two things most likely to be wrong about it are both
// invisible from the outside:
//
//   1. The WebSocket upgrade is a SECOND door. api.js reconnects automatically on
//      close, so an unpaired client hammers /ws rather than /api — if the lockout only
//      guards REST, the socket is a free brute-force oracle.
//   2. A lockout that lets the right token through while locked would let an attacker
//      confirm a guess after tripping it, which defeats the point of having one.
//
// Runs against a real server on a throwaway data dir, with auth forced to 'always' so
// that loopback does not bypass the check.
//
//   node scripts/e2e/remote-auth.e2e.mjs

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7992;
const BASE = `http://127.0.0.1:${PORT}`;

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-auth-'));
let n = 0, failed = 0;
const ok = (c, label) => { n++; if (!c) { failed++; console.error(`✗ ${label}`); } else console.log(`✓ ${label}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));

try {
  const r = await fetch(BASE + '/api/status', { signal: AbortSignal.timeout(1500) });
  if (r.ok) { console.error(`✗ something is already serving :${PORT} — kill it first`); process.exit(1); }
} catch { /* free: good */ }

// Seed a config with auth forced on for every caller, including loopback.
fs.mkdirSync(tmpData, { recursive: true });
const TOKEN = 'e2e-token-' + Math.random().toString(36).slice(2, 12);
fs.writeFileSync(path.join(tmpData, 'config.json'),
  JSON.stringify({ auth: { required: 'always', token: TOKEN } }, null, 2));

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, AIOS_DATA: tmpData, AIOS_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let slog = ''; server.stdout.on('data', d => slog += d); server.stderr.on('data', d => slog += d);
function cleanup(code) {
  try { server.kill('SIGKILL'); } catch { }
  fs.rmSync(tmpData, { recursive: true, force: true });
  if (code) console.error('--- server log ---\n' + slog.slice(-2000));
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => cleanup(1));
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(BASE + '/api/status', { headers: { authorization: 'Bearer ' + TOKEN } })).ok) break; } catch { }
  await wait(250);
}

const call = (token, p = '/api/status') => fetch(BASE + p, token === null ? {} : { headers: { authorization: 'Bearer ' + token } });

// ---------------------------------------------------------------- the basics

ok((await call(TOKEN)).status === 200, 'the right token is accepted');
ok((await call(null)).status === 401, 'no token is refused');
// Config must not be readable without the token — it carries provider settings.
ok((await call(null, '/api/config')).status === 401, 'no token cannot read /api/config');

// A prefix of the real token must not pass. This is what a non-constant-time compare
// leaks the shape of, and what a `startsWith` bug would let straight through.
ok((await call(TOKEN.slice(0, 8))).status === 401, 'a prefix of the token is refused');
ok((await call(TOKEN + 'x')).status === 401, 'the token plus a suffix is refused');

// ---------------------------------------------------------------- static vs API
// The shell itself is deliberately public — the phone must be able to load /m in
// order to show the pairing prompt. Nothing behind /api is.
ok((await fetch(BASE + '/m')).status === 200, '/m loads without a token (so pairing can be offered)');

// ---------------------------------------------------------------- lockout

// Three free tries, then backoff. Burn through them from this IP.
let sawLock = false, lockAt = 0;
for (let i = 1; i <= 6; i++) {
  const r = await call('definitely-wrong-' + i);
  if (r.status === 429) { sawLock = true; lockAt = lockAt || i; break; }
}
ok(sawLock, `repeated wrong tokens trip a 429 lockout (at attempt ${lockAt})`);

const locked = await call('wrong-again');
ok(locked.status === 429, 'further attempts stay locked out');
ok(Number(locked.headers.get('retry-after')) > 0, `429 carries a Retry-After (${locked.headers.get('retry-after')}s)`);

// THE IMPORTANT ONE: a locked-out caller must be refused even holding the right
// token, or the lockout becomes an oracle that confirms a successful guess.
ok((await call(TOKEN)).status === 429, 'the right token is ALSO refused while locked out');

// ---------------------------------------------------------------- the second door

const wsTry = (token) => new Promise((resolve) => {
  const url = `ws://127.0.0.1:${PORT}/ws` + (token ? `?token=${encodeURIComponent(token)}` : '');
  const s = new WebSocket(url);
  const done = (v) => { try { s.close(); } catch { } resolve(v); };
  s.on('open', () => done('open'));
  s.on('unexpected-response', (_req, res) => done(res.statusCode));
  s.on('error', () => done('error'));
  setTimeout(() => done('timeout'), 4000);
});

// Still locked from the REST attempts above — the counter is per-IP and shared, which
// is the whole point: the socket must not be a separate, unguarded budget.
const wsLocked = await wsTry(TOKEN);
ok(wsLocked === 429, `the WebSocket upgrade honours the same lockout (got ${wsLocked})`);

// Wait out the backoff, then confirm both doors reopen for the right token and stay
// shut for the wrong one.
const waitSec = Number(locked.headers.get('retry-after')) || 2;
await wait((waitSec + 1) * 1000);

ok((await call(TOKEN)).status === 200, 'the right token works again once the lockout expires');
ok(await wsTry(TOKEN) === 'open', 'the WebSocket accepts the right token');

const wsBad = await wsTry('nope-not-it');
ok(wsBad === 401, `the WebSocket refuses a bad token (got ${wsBad})`);
ok(await wsTry(null) === 401, 'the WebSocket refuses no token');

// ---------------------------------------------------------------- remote status

const rs = await (await call(TOKEN, '/api/remote/status')).json();
ok(rs.transport === 'tailscale', 'remote status reports the transport');
ok(typeof rs.installed === 'boolean' && typeof rs.serve?.on === 'boolean', 'remote status has the shape the UI expects');
// Whatever state the box is in, an un-set-up transport must say what to DO about it.
ok(rs.installed ? true : !!rs.hint, 'an unconfigured transport explains itself');

// The pairing links carry the token, so they must never be handed to a non-local
// caller — this request came over loopback, so it legitimately gets them.
ok(Array.isArray(rs.pairing), 'pairing links are present for a localhost caller');

console.log(`\n${n - failed}/${n} checks passed`);
cleanup(failed ? 1 : 0);
