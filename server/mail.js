// Inbox triage: a minimal zero-dependency IMAP client (node:tls) fetches recent
// message headers + a body peek READ-ONLY (EXAMINE + BODY.PEEK — nothing gets
// marked seen), then one LLM call classifies what actually matters. Important
// messages surface as notifications on the Home screen and (optionally) Discord.
//
// This is not a general IMAP library — it speaks just enough of RFC 3501 for
// "list my recent mail" against mainstream servers (Gmail/Outlook/Fastmail need
// an app password when 2FA is on).

import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { DATA, loadConfig } from './config.js';
import { streamChat } from './llm.js';
import { extractJSON } from './jobai.js';
import { notifyDiscord } from './notify.js';
import { now, readJSON, writeJSON } from './util.js';

const FILE = path.join(DATA, 'mail', 'state.json');
const loadState = () => readJSON(FILE) || { scannedAt: '', account: '', error: '', messages: [], dismissed: [] };
const saveState = (s) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); writeJSON(FILE, s); };

// ---------- IMAP response parsing (exported for tests) ----------

/**
 * Find the completion line for `tag` in a raw response buffer, skipping IMAP
 * literals ({n}\r\n<n bytes>) so a "A1 OK"-looking string inside a message body
 * can't terminate the read early. Returns { end, status } or null if incomplete.
 */
export function findTagLine(s, tag) {
  let i = 0;
  while (i < s.length) {
    const nl = s.indexOf('\r\n', i);
    if (nl < 0) return null;
    const line = s.slice(i, nl);
    const lit = line.match(/\{(\d+)\}$/);
    if (lit) {
      const end = nl + 2 + Number(lit[1]);
      if (s.length < end) return null;      // literal not fully received yet
      i = end;
      continue;
    }
    if (line.startsWith(tag + ' ')) return { end: nl + 2, status: line.slice(tag.length + 1) };
    i = nl + 2;
  }
  return null;
}

/** Decode RFC 2047 encoded-words (=?charset?B/Q?...?=) in headers. */
export function decodeMimeWords(s) {
  if (!s) return '';
  return String(s)
    .replace(/\?=\s+=\?/g, '?==?')          // adjacent encoded words: drop the whitespace
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, data) => {
      try {
        const buf = /b/i.test(enc)
          ? Buffer.from(data, 'base64')
          : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
        const cs = charset.toLowerCase();
        return buf.toString(/^(utf-?8|us-ascii)$/.test(cs) ? 'utf8' : 'latin1');
      } catch { return _; }
    }).replace(/\s+/g, ' ').trim();
}

/** Bytes-as-latin1 → proper UTF-8 string (no-op for plain ASCII). */
export const utf8ify = (s) => { try { return Buffer.from(String(s), 'latin1').toString('utf8'); } catch { return String(s); } };

/** Unfold headers and pull one field (folded continuation lines start with WSP). */
export function headerField(chunk, name) {
  const unfolded = String(chunk).replace(/\r\n[ \t]+/g, ' ');
  const m = unfolded.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'));
  return m ? decodeMimeWords(utf8ify(m[1])) : '';
}

/** Best-effort readable snippet from a raw BODY[TEXT] peek (MIME noise → text). */
export function cleanSnippet(raw, cap = 280) {
  let t = String(raw || '');
  // drop MIME part headers/boundaries at the top
  t = t.replace(/^--[^\r\n]*\r?\n/gm, '');
  t = t.replace(/^(Content-[\w-]+|MIME-Version):[^\r\n]*\r?\n/gim, '');
  // quoted-printable soft breaks + hex escapes, THEN reinterpret the bytes as UTF-8
  // (QP-encoded UTF-8 like =E2=80=94 only becomes text after both steps, in this order)
  t = t.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => { try { return String.fromCharCode(parseInt(h, 16)); } catch { return m; } });
  t = utf8ify(t);
  // a leading base64 blob? try decoding the first chunk
  const head = t.trim().slice(0, 400);
  if (/^[A-Za-z0-9+/=\r\n]{80,}$/.test(head)) {
    try {
      const dec = Buffer.from(head.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (/^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(dec) && dec.trim()) t = dec;
    } catch { }
  }
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');           // html → text
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  t = t.replace(/[​-‏﻿]/g, '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return t.slice(0, cap);
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (d) => `${d.getDate()}-${MON[d.getMonth()]}-${d.getFullYear()}`;

/**
 * Mini query syntax → IMAP SEARCH criteria (exported for tests):
 *   from:alice subject:"weekly report" is:unread invoice
 * → FROM "alice" SUBJECT "weekly report" UNSEEN TEXT "invoice" SINCE <days ago>
 */
export function searchCriteria(query, days = 30) {
  const crit = [];
  let rest = String(query || '').trim();
  for (const [key, imapKey] of [['from', 'FROM'], ['to', 'TO'], ['subject', 'SUBJECT']]) {
    rest = rest.replace(new RegExp(key + ':(?:"([^"]+)"|(\\S+))', 'gi'), (_, q, w) => { crit.push(`${imapKey} ${quote(q || w)}`); return ' '; });
  }
  if (/\bis:unread\b/i.test(rest)) { crit.push('UNSEEN'); rest = rest.replace(/\bis:unread\b/gi, ' '); }
  rest = rest.replace(/\s+/g, ' ').trim();
  if (rest) crit.push(`TEXT ${quote(rest)}`);
  if (days > 0) crit.push(`SINCE ${imapDate(new Date(Date.now() - days * 86400_000))}`);
  return crit.join(' ') || 'ALL';
}

/** Split a FETCH response into per-message chunks and extract the fields we asked for. */
export function parseFetch(raw, host) {
  const out = [];
  for (const chunk of String(raw).split(/\r\n\* \d+ FETCH /).slice(raw.startsWith('* ') ? 0 : 1)) {
    const uid = chunk.match(/UID (\d+)/)?.[1];
    if (!uid) continue;
    const flags = chunk.match(/FLAGS \(([^)]*)\)/)?.[1] || '';
    let snippet = '';
    const lit = chunk.match(/BODY\[TEXT\]<0>\s*\{(\d+)\}\r\n/);
    if (lit) snippet = cleanSnippet(chunk.slice(lit.index + lit[0].length, lit.index + lit[0].length + Number(lit[1])));
    out.push({
      id: `${uid}@${host}`,
      uid: Number(uid),
      from: headerField(chunk, 'From'),
      subject: headerField(chunk, 'Subject') || '(no subject)',
      date: chunk.match(/INTERNALDATE "([^"]+)"/)?.[1] || headerField(chunk, 'Date'),
      seen: /\\Seen/.test(flags),
      snippet,
    });
  }
  return out;
}

// ---------- IMAP session ----------

const quote = (s) => `"${String(s).replace(/([\\"])/g, '\\$1')}"`;

function imapSession({ host, port = 993, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port: Number(port) || 993, servername: host });
    let acc = '';
    let n = 0;
    let waiter = null;   // { tag, resolve, reject, timer }
    let greeting = null; // resolve fn for the untagged greeting

    const fail = (e) => {
      const err = e instanceof Error ? e : new Error(String(e));
      if (greeting) { greeting.reject(err); greeting = null; }
      if (waiter) { clearTimeout(waiter.timer); waiter.reject(err); waiter = null; }
      try { sock.destroy(); } catch { }
      reject(err);
    };
    const connTimer = setTimeout(() => fail(new Error(`IMAP connect timeout (${host}:${port})`)), timeoutMs);

    sock.on('error', fail);
    sock.on('secureConnect', () => {
      clearTimeout(connTimer);
      const api = {
        cmd(command) {
          return new Promise((res, rej) => {
            const tag = 'A' + (++n);
            const timer = setTimeout(() => { waiter = null; rej(new Error(`IMAP timeout on: ${command.split(' ')[0]}`)); }, timeoutMs);
            waiter = { tag, resolve: res, reject: rej, timer };
            sock.write(`${tag} ${command}\r\n`);
          });
        },
        async close() {
          try { await Promise.race([this.cmd('LOGOUT'), new Promise(r => setTimeout(r, 1500))]); } catch { }
          try { sock.destroy(); } catch { }
        },
      };
      // wait for the untagged greeting before resolving the session
      greeting = {
        resolve: () => { greeting = null; resolve(api); },
        reject: (e) => { reject(e); },
      };
      pump();
    });
    // latin1 keeps 1 byte = 1 char, so IMAP literal counts ({n} = n BYTES) line up
    // with string offsets; UTF-8 is decoded per-field later (utf8ify).
    sock.on('data', (d) => { acc += d.toString('latin1'); pump(); });
    sock.on('close', () => { if (waiter || greeting) fail(new Error('IMAP connection closed unexpectedly')); });

    function pump() {
      if (greeting) {
        const nl = acc.indexOf('\r\n');
        if (nl < 0) return;
        const line = acc.slice(0, nl);
        if (/^\* (OK|PREAUTH)/i.test(line)) { acc = acc.slice(nl + 2); greeting.resolve(); }
        else if (line.startsWith('* BYE')) greeting.reject(new Error(`server refused: ${line.slice(0, 120)}`));
        return;
      }
      if (!waiter) return;
      const hit = findTagLine(acc, waiter.tag);
      if (!hit) return;
      const raw = acc.slice(0, hit.end);
      acc = acc.slice(hit.end);
      const w = waiter; waiter = null;
      clearTimeout(w.timer);
      if (/^OK/i.test(hit.status)) w.resolve(raw);
      else w.reject(new Error(`IMAP ${hit.status.slice(0, 160)}`));
    }
  });
}

async function login(imap, { host, user, password }) {
  try {
    await imap.cmd(`LOGIN ${quote(user)} ${quote(password)}`);
  } catch (e) {
    if (/AUTHENTICATIONFAILED|Invalid credentials/i.test(e.message) && /gmail|google/i.test(host)) {
      throw new Error('Gmail rejected the login — regular account passwords do not work over IMAP. Create an app password (myaccount.google.com/apppasswords, requires 2-step verification) and save that instead.');
    }
    throw e;
  }
}

/** Fetch recent messages (read-only). */
export async function fetchRecent({ host, port, user, password, mailbox = 'INBOX', lookbackDays = 3, maxMessages = 30 }) {
  const imap = await imapSession({ host, port });
  try {
    await login(imap, { host, user, password });
    await imap.cmd(`EXAMINE ${quote(mailbox || 'INBOX')}`);
    const since = new Date(Date.now() - Math.max(1, lookbackDays) * 86400_000);
    const search = await imap.cmd(`UID SEARCH SINCE ${imapDate(since)}`);
    const uids = (search.match(/^\* SEARCH([\d ]*)$/m)?.[1] || '').trim().split(/\s+/).filter(Boolean).map(Number);
    if (!uids.length) return [];
    const pick = uids.sort((a, b) => a - b).slice(-Math.max(1, Math.min(maxMessages, 60)));
    const raw = await imap.cmd(
      `UID FETCH ${pick.join(',')} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.600>)`
    );
    return parseFetch(raw, host).sort((a, b) => b.uid - a.uid);
  } finally {
    await imap.close();
  }
}

const requireMail = () => {
  const mc = loadConfig().mail || {};
  if (!mc.host || !mc.user || !mc.password) throw Object.assign(new Error('Mail is not configured — add IMAP details in Settings → Mail & Alerts.'), { status: 400 });
  return mc;
};

/** Search the inbox (read-only) with the mini query syntax. */
export async function searchMail({ query = '', days = 30, limit = 15 } = {}) {
  const mc = requireMail();
  const imap = await imapSession(mc);
  try {
    await login(imap, mc);
    await imap.cmd(`EXAMINE ${quote(mc.mailbox || 'INBOX')}`);
    const raw = await imap.cmd(`UID SEARCH ${searchCriteria(query, days)}`);
    const uids = (raw.match(/^\* SEARCH([\d ]*)$/m)?.[1] || '').trim().split(/\s+/).filter(Boolean).map(Number);
    if (!uids.length) return [];
    const pick = uids.sort((a, b) => a - b).slice(-Math.max(1, Math.min(limit, 30)));
    const fraw = await imap.cmd(
      `UID FETCH ${pick.join(',')} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.400>)`
    );
    return parseFetch(fraw, mc.host).sort((a, b) => b.uid - a.uid);
  } finally { await imap.close(); }
}

/** Read one message in full (read-only, body capped at ~12k chars). */
export async function readMessage(uid) {
  const mc = requireMail();
  if (!Number(uid)) throw Object.assign(new Error('a numeric message uid is required'), { status: 400 });
  const imap = await imapSession(mc);
  try {
    await login(imap, mc);
    await imap.cmd(`EXAMINE ${quote(mc.mailbox || 'INBOX')}`);
    const raw = await imap.cmd(
      `UID FETCH ${Number(uid)} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)] BODY.PEEK[TEXT]<0.60000>)`
    );
    if (!/UID \d+/.test(raw)) throw new Error(`no message with uid ${uid} in ${mc.mailbox || 'INBOX'}`);
    const lit = raw.match(/BODY\[TEXT\]<0>\s*\{(\d+)\}\r\n/);
    const body = lit ? cleanSnippet(raw.slice(lit.index + lit[0].length, lit.index + lit[0].length + Number(lit[1])), 12000) : '';
    return {
      uid: Number(uid),
      from: headerField(raw, 'From'),
      to: headerField(raw, 'To'),
      subject: headerField(raw, 'Subject') || '(no subject)',
      date: raw.match(/INTERNALDATE "([^"]+)"/)?.[1] || headerField(raw, 'Date'),
      body,
    };
  } finally { await imap.close(); }
}

// ---------- triage ----------

const HEUR_IMPORTANT = /urgent|action required|invoice|payment|overdue|interview|offer|deadline|verify|security alert|suspicious|password|account.*(locked|suspended)|面接|請求|重要/i;
const HEUR_NOISE = /unsubscribe|newsletter|% off|sale ends|new arrivals|weekly digest|no.?reply.*promo|限定セール/i;

async function classify(messages, modelRef) {
  const cfg = loadConfig();
  const listing = messages.map((m, i) =>
    `${i + 1}. FROM: ${m.from.slice(0, 90)} | SUBJECT: ${m.subject.slice(0, 120)}${m.snippet ? ` | PREVIEW: ${m.snippet.slice(0, 140)}` : ''}`).join('\n');
  const res = await streamChat({
    modelRef, maxTokens: 1800,
    system: 'You triage an inbox for a busy person. Judge only from the given metadata. Output ONLY JSON, no commentary.',
    messages: [{
      role: 'user',
      text: `User: ${cfg.user?.name || ''} ${cfg.user?.email ? `<${cfg.user.email}>` : ''}
Mark a message important ONLY if the user personally needs to read or act on it soon: direct human correspondence, interviews/job offers, bills/payments, deliveries needing action, security alerts, deadlines, appointments. Newsletters, promotions, social notifications, and automated FYI mail are NOT important.

Output JSON exactly: {"verdicts":[{"n":1,"important":true,"urgency":"high|normal|low","category":"reply|action|meeting|finance|delivery|security|newsletter|promo|social|other","reason":"≤12 words"}]}
One verdict per message, n matches the list:

${listing}`,
    }],
  });
  const j = extractJSON(res.text);
  const map = new Map();
  for (const v of j?.verdicts || []) {
    const i = Number(v.n) - 1;
    if (i >= 0 && i < messages.length) {
      map.set(messages[i].id, {
        important: !!v.important,
        urgency: ['high', 'normal', 'low'].includes(v.urgency) ? v.urgency : 'normal',
        category: String(v.category || 'other').slice(0, 16),
        reason: String(v.reason || '').slice(0, 120),
        via: 'ai',
      });
    }
  }
  return map;
}

const heuristicVerdict = (m) => ({
  important: HEUR_IMPORTANT.test(m.subject + ' ' + m.snippet) && !HEUR_NOISE.test(m.subject + ' ' + m.snippet),
  urgency: 'normal',
  category: HEUR_NOISE.test(m.subject) ? 'promo' : 'other',
  reason: 'keyword heuristic (no model)',
  via: 'heuristic',
});

let scanning = false;

/** Fetch + triage. Only newly-seen messages spend model tokens. */
export async function scanMail({ modelRef = '' } = {}) {
  const cfg = loadConfig();
  const mc = cfg.mail || {};
  if (!mc.host || !mc.user || !mc.password) throw Object.assign(new Error('Mail is not configured — add IMAP details in Settings → Mail & Alerts.'), { status: 400 });
  if (scanning) throw Object.assign(new Error('a scan is already running'), { status: 409 });
  scanning = true;
  const state = loadState();
  try {
    const fetched = await fetchRecent(mc);
    const known = new Map(state.messages.map(m => [m.id, m]));
    const fresh = fetched.filter(m => !known.has(m.id));

    let verdicts = new Map();
    const ref = modelRef || mc.model || cfg.defaults.chatModel;
    if (fresh.length && ref) {
      try { verdicts = await classify(fresh, ref); } catch { /* fall back below */ }
    }
    const merged = fetched.map(m => {
      const old = known.get(m.id);
      if (old?.via === 'ai') return { ...old, seen: m.seen };            // keep the paid verdict
      const v = verdicts.get(m.id) || (old ? old : heuristicVerdict(m));
      return { ...m, important: !!v.important, urgency: v.urgency || 'normal', category: v.category || 'other', reason: v.reason || '', via: v.via || 'heuristic' };
    });

    const newImportant = merged.filter(m => m.important && fresh.some(f => f.id === m.id) && !state.dismissed.includes(m.id));
    state.scannedAt = now();
    state.account = mc.user;
    state.error = '';
    state.messages = merged.slice(0, 100);
    state.dismissed = state.dismissed.filter(id => merged.some(m => m.id === id)).slice(-200);
    saveState(state);

    if (newImportant.length && cfg.notify?.onImportantMail !== false && cfg.notify?.discordWebhook) {
      const lines = newImportant.slice(0, 6).map(m => `• **${m.from.replace(/<[^>]*>/g, '').trim() || m.from}** — ${m.subject}${m.reason ? ` _(${m.reason})_` : ''}`);
      notifyDiscord(`📧 ${newImportant.length} important email${newImportant.length > 1 ? 's' : ''}:\n${lines.join('\n')}`);
    }
    return { scanned: fetched.length, fresh: fresh.length, important: merged.filter(m => m.important).length, classifiedBy: fresh.length ? (verdicts.size ? 'ai' : 'heuristic') : 'cache' };
  } catch (e) {
    state.error = e.message;
    state.scannedAt = now();
    saveState(state);
    throw e;
  } finally {
    scanning = false;
  }
}

export function notifications() {
  const s = loadState();
  const dismissed = new Set(s.dismissed);
  return {
    scannedAt: s.scannedAt, account: s.account, error: s.error,
    items: s.messages
      .filter(m => m.important && !dismissed.has(m.id))
      .sort((a, b) => (b.urgency === 'high') - (a.urgency === 'high') || b.uid - a.uid)
      .slice(0, 12),
  };
}

export function dismiss(id) {
  const s = loadState();
  if (!s.dismissed.includes(id)) s.dismissed.push(id);
  saveState(s);
}

export function mailStatus() {
  const mc = loadConfig().mail || {};
  const s = loadState();
  return {
    configured: !!(mc.host && mc.user && mc.password), enabled: !!mc.enabled,
    scannedAt: s.scannedAt, error: s.error,
    messages: s.messages.length, important: s.messages.filter(m => m.important).length,
  };
}

// ---------- background scanning ----------

let timer = null;
export function startAutoScan() {
  if (timer) return;
  timer = setInterval(() => {
    const mc = loadConfig().mail || {};
    if (!mc.enabled || !(mc.scanIntervalMin > 0) || scanning) return;
    const last = Date.parse(loadState().scannedAt || 0) || 0;
    if (Date.now() - last < mc.scanIntervalMin * 60_000) return;
    scanMail().catch(() => { });   // errors land in state.error
  }, 60_000);
  timer.unref?.();
}
