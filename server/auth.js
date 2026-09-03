// Request authorisation, and the lockout that makes the token worth having.
//
// This used to be four lines inline in index.js doing `token === c.auth.token`. On a
// LAN with only trusted machines that was mostly fine. It stopped being fine the day
// the hub became reachable from outside the house: an 18-byte secret with unlimited
// tries and no log is brute-forcible given enough patience, and what sits behind it is
// a shell, an agent that writes files, an inbox and a ledger.
//
// Three things changed (Roadmap B9):
//   1. timingSafeEqual instead of ===. `===` on strings returns at the first differing
//      byte, so how long it takes to say no leaks how much of the prefix was right.
//   2. A per-IP failure counter with exponential backoff. Guessing is now bounded by
//      wall-clock rather than by the attacker's request rate.
//   3. Failures are logged, with the source classified. A brute-force attempt against
//      this box should leave a trace someone can find afterwards.
//
// Deliberately NOT here: rate-limiting successful requests. Voice streams and terminal
// traffic are chatty by design and throttling them would break the product.

import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { loadConfig } from './config.js';

// ---------- where did this come from ----------

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The v4 address out of whichever spelling node handed us. */
function v4(ip) {
  const s = String(ip || '');
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : s;
}

function inCidr(ip, base, bits) {
  const to = (a) => a.split('.').reduce((n, o) => (n << 8 >>> 0) + (Number(o) & 255), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (to(ip) & mask) >>> 0 === (to(base) & mask) >>> 0;
}

/**
 * Classify the caller: 'local' | 'tailnet' | 'lan' | 'remote'.
 *
 * 'tailnet' is its own class rather than being folded into 'lan'. Tailscale hands out
 * 100.64.0.0/10 (CGNAT), and a request from there has already crossed a WireGuard
 * tunnel that authenticated the *device* — which is a materially different level of
 * assurance from an arbitrary machine on the café Wi-Fi, and worth being able to see
 * in the log and reason about separately.
 */
export function classify(ip) {
  const a = v4(ip);
  if (LOOPBACK.has(String(ip)) || a === '127.0.0.1') return 'local';
  if (inCidr(a, '100.64.0.0', 10)) return 'tailnet';
  if (/^fd7a:115c:a1e0:/i.test(String(ip))) return 'tailnet';   // Tailscale's ULA range
  if (inCidr(a, '10.0.0.0', 8) || inCidr(a, '172.16.0.0', 12) || inCidr(a, '192.168.0.0', 16)) return 'lan';
  if (/^fe80:/i.test(String(ip)) || /^f[cd]/i.test(String(ip))) return 'lan';
  return 'remote';
}

// ---------- lockout ----------

// Keyed by IP. Bounded: entries expire, and the map is swept when it grows.
const failures = new Map();   // ip -> { n, until, first, last }

const BASE_DELAY_MS = 1000;   // after the 4th failure
const MAX_DELAY_MS = 15 * 60 * 1000;
const FREE_TRIES = 3;         // fat-fingering a pasted token shouldn't cost a wait
const FORGET_MS = 60 * 60 * 1000;

function sweep() {
  if (failures.size < 512) return;
  const cutoff = Date.now() - FORGET_MS;
  for (const [ip, f] of failures) if (f.last < cutoff && f.until < Date.now()) failures.delete(ip);
}

/** Milliseconds remaining on this IP's lockout, or 0. */
export function lockedFor(ip) {
  const f = failures.get(ip);
  if (!f) return 0;
  if (f.last < Date.now() - FORGET_MS) { failures.delete(ip); return 0; }
  return Math.max(0, f.until - Date.now());
}

function recordFailure(ip, source, why) {
  const f = failures.get(ip) || { n: 0, until: 0, first: Date.now(), last: 0 };
  f.n += 1;
  f.last = Date.now();
  // 1s, 2s, 4s, … capped at 15m — the 4th wrong guess is the first that waits.
  if (f.n > FREE_TRIES) {
    const delay = Math.min(BASE_DELAY_MS * 2 ** (f.n - FREE_TRIES - 1), MAX_DELAY_MS);
    f.until = Date.now() + delay;
  }
  failures.set(ip, f);
  sweep();
  const wait = f.until > Date.now() ? ` — locked ${Math.round((f.until - Date.now()) / 1000)}s` : '';
  console.warn(`[auth] refused ${source} ${ip}: ${why} (attempt ${f.n})${wait}`);
}

function recordSuccess(ip) { failures.delete(ip); }

// ---------- the check ----------

/** Constant-time string compare that doesn't leak length through an early return. */
function sameSecret(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be the leak. Compare
  // equal-length buffers always, and fold the length difference into the result.
  const len = Math.max(A.length, B.length, 1);
  const pa = Buffer.alloc(len), pb = Buffer.alloc(len);
  A.copy(pa); B.copy(pb);
  return timingSafeEqual(pa, pb) && A.length === B.length && A.length > 0;
}

function presentedToken(req) {
  const header = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (header) return header;
  try { return new URL(req.url, 'http://x').searchParams.get('token') || ''; }
  catch { return ''; }
}

/**
 * Decide whether a request may proceed.
 *
 * Returns { ok, source, ip, reason, retryAfter } rather than a bare boolean so the
 * caller can send a sensible status (401 vs 429) and so the WebSocket upgrade path
 * and the REST path share one implementation — they used to be two, and only the
 * REST one would have gained the lockout.
 */
export function check(req) {
  const ip = req.socket?.remoteAddress || '';
  const source = classify(ip);
  const c = loadConfig();

  if (c.auth.required === 'never') return { ok: true, source, ip, reason: 'auth off' };
  if (c.auth.required === 'lan' && source === 'local') return { ok: true, source, ip, reason: 'localhost' };

  const wait = lockedFor(ip);
  if (wait > 0) return { ok: false, source, ip, reason: 'locked out', retryAfter: Math.ceil(wait / 1000) };

  const token = presentedToken(req);
  if (!token) {
    recordFailure(ip, source, 'no token');
    return { ok: false, source, ip, reason: 'no token', retryAfter: Math.ceil(lockedFor(ip) / 1000) };
  }
  if (!sameSecret(token, c.auth.token)) {
    recordFailure(ip, source, 'bad token');
    return { ok: false, source, ip, reason: 'bad token', retryAfter: Math.ceil(lockedFor(ip) / 1000) };
  }

  recordSuccess(ip);
  return { ok: true, source, ip, reason: 'token' };
}

/** Express middleware. 429 with Retry-After while locked out, 401 otherwise. */
export function middleware(req, res, next) {
  const r = check(req);
  if (r.ok) { req.authSource = r.source; return next(); }
  if (r.reason === 'locked out') {
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ error: `too many failed attempts — try again in ${r.retryAfter}s` });
  }
  return res.status(401).json({ error: 'unauthorized' });
}

/** What the health page shows: who is currently locked out, and how badly. */
export function lockoutReport() {
  const nowMs = Date.now();
  const rows = [];
  for (const [ip, f] of failures) {
    if (f.last < nowMs - FORGET_MS) continue;
    rows.push({ ip, source: classify(ip), attempts: f.n, lockedSec: Math.max(0, Math.ceil((f.until - nowMs) / 1000)), lastAt: new Date(f.last).toISOString() });
  }
  return rows.sort((a, b) => b.attempts - a.attempts);
}

/** Test seam: forget all failure state. */
export function resetLockouts() { failures.clear(); }

export const hostUser = () => os.userInfo().username;
