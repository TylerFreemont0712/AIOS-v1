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
import { streamChat, listModels } from './llm.js';
import { extractJSON } from './jobai.js';
import { notifyDiscord } from './notify.js';
import { now, readJSON, writeJSON } from './util.js';

const FILE = path.join(DATA, 'mail', 'state.json');
const loadState = () => {
  const s = readJSON(FILE) || {};
  return {
    scannedAt: '', account: '', error: '', messages: [], dismissed: [],
    senders: {},        // sender rules: "addr" or "@domain" → { rule: block|star, kind, via, addedAt }
    senderStats: {},    // "addr" → { dismissed: n } — feeds auto-mute
    ...s,
  };
};
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

/** ISO-2022-JP needs JIS tables we don't carry (zero-dep) — replace undecodable
 *  escape runs with a marker instead of leaking `$B%[%C…` mojibake into the UI
 *  and the triage prompt (it derails small models' JSON output). */
export function deJis(s) {
  if (!/\x1b/.test(String(s || ''))) return s;
  const out = String(s)
    .replace(/\x1b\$[@B][^\x1b]*/g, '〔JP〕')     // JIS X 0208 runs we can't decode
    .replace(/\x1b\(?[A-Za-z]/g, '')             // mode-switch escapes
    .replace(/(?:〔JP〕[ ]*)+/g, '〔JP〕').trim();
  return !out || out === '〔JP〕' ? '(JIS-encoded Japanese)' : out;
}

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

// ---------- MIME part extraction (for rendering the real email) ----------

const splitHeadersBody = (s) => {
  const m = s.match(/\r?\n\r?\n/);
  if (!m) return { headers: s, body: '' };
  return { headers: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
};
const rawHeader = (headers, name) => {
  const m = String(headers).replace(/\r?\n[ \t]+/g, ' ').match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'));
  return m ? m[1].trim() : '';
};

function decodePartBody(body, cte, charset) {
  let buf;
  if (/base64/i.test(cte)) buf = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (/quoted-printable/i.test(cte)) {
    const qp = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    buf = Buffer.from(qp, 'latin1');
  } else buf = Buffer.from(body, 'latin1');
  const cs = String(charset || 'utf-8').toLowerCase();
  if (/iso-8859|latin1|windows-125/.test(cs)) return buf.toString('latin1');
  return buf.toString('utf8');   // utf-8/ascii and best-effort for the rest
}

/**
 * Walk a raw RFC822 message (or part) and return the best renderable body:
 * { html } when a text/html part exists, else { text }, else null.
 * Handles nested multipart (mixed/alternative/related) a few levels deep.
 */
export function bestMimePart(s, depth = 0) {
  if (depth > 4 || !s) return null;
  const { headers, body } = splitHeadersBody(s);
  const ct = rawHeader(headers, 'Content-Type') || 'text/plain';
  const cte = rawHeader(headers, 'Content-Transfer-Encoding');
  const charset = ct.match(/charset="?([^";\s]+)"?/i)?.[1];
  if (/multipart\//i.test(ct)) {
    const boundary = ct.match(/boundary="?([^";]+)"?/i)?.[1];
    if (!boundary) return null;
    let best = null;
    for (const p of body.split('--' + boundary).slice(1)) {
      if (/^--/.test(p.trimStart().slice(0, 2))) continue;      // closing marker
      const r = bestMimePart(p.replace(/^\r?\n/, ''), depth + 1);
      if (r?.html) return r;                                    // html wins outright
      best = best || r;
    }
    return best;
  }
  if (/text\/html/i.test(ct)) return { html: decodePartBody(body, cte, charset) };
  if (/text\/plain/i.test(ct)) return { text: decodePartBody(body, cte, charset) };
  return null;
}

/** Defense-in-depth for the sandboxed viewer: drop scripts and inline handlers. */
export const stripActiveHtml = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<script[^>]*\/?>/gi, '')
  .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
  .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
  .replace(/\son\w+\s*=\s*[^\s>]+/gi, '');

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
      from: deJis(headerField(chunk, 'From')),
      subject: deJis(headerField(chunk, 'Subject')) || '(no subject)',
      date: chunk.match(/INTERNALDATE "([^"]+)"/)?.[1] || headerField(chunk, 'Date'),
      seen: /\\Seen/.test(flags),
      starred: /\\Flagged/.test(flags),
      messageId: headerField(chunk, 'Message-ID').replace(/^<|>$/g, ''),
      snippet,
    });
  }
  return out;
}

/** IMAP INTERNALDATE ("10-Jul-2026 08:15:22 +0900") → epoch ms (0 if unparseable). */
export function parseImapDate(s) {
  const t = Date.parse(String(s || '').trim().replace(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/, '$1 $2 $3'));
  return Number.isFinite(t) ? t : 0;
}

/** Webmail deep-link for a message (Gmail supports search-by-Message-ID). */
export function webmailLink(host, messageId) {
  if (!messageId) return '';
  if (/gmail|googlemail|google/i.test(String(host))) {
    return 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(`rfc822msgid:${messageId}`);
  }
  return '';
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
      `UID FETCH ${pick.join(',')} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] BODY.PEEK[TEXT]<0.600>)`
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

/** Read one message in full (read-only): headers, a plain-text body for models,
 *  and the sanitized HTML part (when present) for the mini-Gmail viewer. */
export async function readMessage(uid) {
  const mc = requireMail();
  if (!Number(uid)) throw Object.assign(new Error('a numeric message uid is required'), { status: 400 });
  const imap = await imapSession(mc);
  try {
    await login(imap, mc);
    await imap.cmd(`EXAMINE ${quote(mc.mailbox || 'INBOX')}`);
    // the WHOLE raw message (capped) so the MIME walker can find the html part
    const raw = await imap.cmd(`UID FETCH ${Number(uid)} (UID INTERNALDATE BODY.PEEK[]<0.300000>)`);
    if (!/UID \d+/.test(raw)) throw new Error(`no message with uid ${uid} in ${mc.mailbox || 'INBOX'}`);
    const lit = raw.match(/BODY\[\]<0>\s*\{(\d+)\}\r\n/);
    const msgRaw = lit ? raw.slice(lit.index + lit[0].length, lit.index + lit[0].length + Number(lit[1])) : '';
    const { headers, body: rawBody } = splitHeadersBody(msgRaw);
    const part = bestMimePart(msgRaw);
    const html = part?.html ? stripActiveHtml(part.html).slice(0, 500_000) : '';
    const text = part?.text ? part.text.replace(/\r\n/g, '\n').trim().slice(0, 12000)
      : cleanSnippet(html || rawBody, 12000);
    const messageId = headerField(headers, 'Message-ID').replace(/^<|>$/g, '');
    return {
      uid: Number(uid),
      from: deJis(headerField(headers, 'From')),
      to: deJis(headerField(headers, 'To')),
      subject: deJis(headerField(headers, 'Subject')) || '(no subject)',
      date: raw.match(/INTERNALDATE "([^"]+)"/)?.[1] || headerField(headers, 'Date'),
      link: webmailLink(mc.host, messageId),
      body: text,
      html,
    };
  } finally { await imap.close(); }
}

// ---------- triage ----------

// Bump when the triage prompt/policy changes — cached verdicts from older
// versions get re-judged on the next scan instead of living forever.
export const TRIAGE_VERSION = 2;

const HEUR_IMPORTANT = /urgent|action required|invoice|payment|overdue|interview|offer letter|deadline|verify|security alert|suspicious|password|account.*(locked|suspended)|shipped|delivery attempt|面接|請求|重要|支払|不正|配達/i;
// bulk-mail tells across EN + JP inboxes: campaign/coupon/digest words and
// bulk-sender address patterns (noreply@, mag@, digest services…)
const HEUR_NOISE = new RegExp([
  'unsubscribe', 'newsletter', '% ?off', 'sale', 'new arrivals', 'digest', 'weekly update',
  'no-?reply', 'donotreply', 'mailmag', 'ダイジェスト', 'メルマガ', 'マガジン', 'キャンペーン',
  'クーポン', 'ポイント', '割引', '限定', 'セール', '特集', 'おすすめ', 'お得', 'おトク',
  '求人をご紹介', '応募が増加', '会員サービス', 'デビュー割', '半額',
].join('|'), 'i');
const HEUR_BULK_SENDER = /noreply|no-reply|donotreply|newsletter|mailmagazine|digest|^\s*"?(mag|info|editor|com|promo|news)@/i;

async function classify(messages, modelRef) {
  const cfg = loadConfig();
  const listing = messages.map((m, i) =>
    `${i + 1}. FROM: ${m.from.slice(0, 90)} | SUBJECT: ${m.subject.slice(0, 120)}${m.snippet ? ` | PREVIEW: ${m.snippet.slice(0, 160)}` : ''}`).join('\n');
  // generous output budget: reasoning models (like the user's local 9B) burn
  // most of it thinking before the first verdict line appears
  const res = await streamChat({
    modelRef, maxTokens: 6000,
    system: 'You triage an inbox for a busy person. Judge only from the given metadata. Think briefly if you must, then output ONLY the verdict lines — no commentary, no code fences.',
    messages: [{
      role: 'user',
      text: `User: ${cfg.user?.name || ''} ${cfg.user?.email ? `<${cfg.user.email}>` : ''}
Mark a message important when a reasonable person would want it surfaced — LEAN TOWARDS IMPORTANT when unsure. Important includes: any mail written by a human to the user, replies, interviews/recruiting, jobs and applications, bills/receipts/refunds/banking, orders and deliveries, security and account notices, appointments/calendar, deadlines, government/school/medical, service status changes, anything the user may need to act on or would regret missing.
NOT important is only clear bulk mail: promotions/sales, newsletters and digests, social-network notifications, product announcements, marketing drip mail, "we miss you" mail.
Urgency: "high" = act today or money/security at stake · "normal" = read soon · "low" = surfaced for awareness.

Output ONE JSON OBJECT PER LINE — one line per message, in order, nothing else:
{"n":1,"important":true,"urgency":"high|normal|low","category":"reply|action|meeting|finance|delivery|security|newsletter|promo|social|other","reason":"≤12 words, concrete"}

Messages:
${listing}`,
    }],
  });
  // line-by-line parse: a truncated reply still contributes every completed line
  const map = new Map();
  for (const line of String(res.text || '').split('\n')) {
    const v = extractJSON(line);
    if (!v || v.n === undefined) continue;
    const i = Number(v.n) - 1;
    if (i >= 0 && i < messages.length && !map.has(messages[i].id)) {
      map.set(messages[i].id, {
        important: !!v.important,
        urgency: ['high', 'normal', 'low'].includes(v.urgency) ? v.urgency : 'normal',
        category: String(v.category || 'other').slice(0, 16),
        reason: String(v.reason || '').slice(0, 120),
        via: 'ai', tv: TRIAGE_VERSION,
      });
    }
  }
  if (!map.size) throw new Error('model reply contained no parseable verdict lines');
  return map;
}

// No-model fallback, matching the "better more than 0" policy: anything that
// isn't recognizable bulk mail surfaces (low urgency); keyword hits upgrade it.
// Important-keywords beat noise-keywords (a real bank alert may say ポイント).
const heuristicVerdict = (m) => {
  const hay = m.subject + ' ' + m.snippet;
  const hot = HEUR_IMPORTANT.test(hay);
  const noise = !hot && (HEUR_NOISE.test(hay) || HEUR_BULK_SENDER.test(m.from || ''));
  return {
    important: !noise,
    urgency: hot ? 'normal' : 'low',
    category: noise ? 'promo' : 'other',
    reason: hot ? 'keyword match (no model)' : noise ? '' : 'not obvious bulk mail (no model)',
    via: 'heuristic', tv: TRIAGE_VERSION,
  };
};

let scanning = false;

/** Pick a model for triage: explicit → mail setting → defaults → ANY reachable model. */
async function resolveModel(modelRef, mc, cfg) {
  const ref = modelRef || mc.model || cfg.defaults.chatModel || cfg.defaults.agentModel;
  if (ref) return ref;
  try { return (await listModels())[0]?.ref || ''; } catch { return ''; }
}

/** Fetch + triage. Only newly-seen messages spend model tokens. */
export async function scanMail({ modelRef = '' } = {}) {
  const cfg = loadConfig();
  const mc = cfg.mail || {};
  if (!mc.host || !mc.user || !mc.password) throw Object.assign(new Error('Mail is not configured — add IMAP details in Settings → Mail & Alerts.'), { status: 400 });
  if (scanning) throw Object.assign(new Error('a scan is already running'), { status: 409 });
  scanning = true;
  const state = loadState();
  try {
    // window covers the starred-tail horizon (10 days) even when lookbackDays is shorter
    const fetched = await fetchRecent({ ...mc, lookbackDays: Math.max(mc.lookbackDays || 3, 10), maxMessages: Math.max(mc.maxMessages || 30, 40) });
    const known = new Map(state.messages.map(m => [m.id, m]));
    // triage what's new — plus anything judged under an older triage policy;
    // muted senders never spend model tokens
    const cachedOk = (old) => old?.via === 'ai' && old.tv === TRIAGE_VERSION;
    const fresh = fetched.filter(m => !cachedOk(known.get(m.id)) && senderRuleFor(state, m.from)?.rule !== 'block');

    // classify in small batches — one giant JSON reply is fragile on small local
    // models (truncation mid-array loses every verdict); per-batch failures degrade
    // to the heuristic for just that batch and the error is REPORTED, not swallowed.
    let verdicts = new Map();
    const triage = { via: 'cache', error: '' };
    const ref = await resolveModel(modelRef, mc, cfg);
    if (fresh.length) {
      if (!ref) triage.error = 'no model configured or reachable';
      else {
        for (let i = 0; i < Math.min(fresh.length, 48); i += 8) {
          const batch = fresh.slice(i, i + 8);
          // one retry per batch — a truncated/garbled JSON reply shouldn't cost coverage
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              for (const [k, v] of await classify(batch, ref)) verdicts.set(k, v);
            } catch (e) { triage.error = e.message.slice(0, 200); }
            if (batch.filter(b => verdicts.has(b.id)).length >= batch.length * 0.7) break;
          }
        }
      }
      triage.judged = verdicts.size;
      triage.of = fresh.length;
      triage.via = verdicts.size ? (verdicts.size < fresh.length ? 'ai+heuristic' : 'ai') : 'heuristic';
    }
    const merged = fetched.map(m => {
      const old = known.get(m.id);
      // keep the paid verdict; live flags (seen/starred) always refresh from the server
      if (cachedOk(old) && !verdicts.has(m.id)) return { ...old, seen: m.seen, starred: m.starred, messageId: m.messageId || old.messageId };
      const v = verdicts.get(m.id) || heuristicVerdict(m);
      return { ...m, important: !!v.important, urgency: v.urgency || 'normal', category: v.category || 'other', reason: v.reason || '', via: v.via || 'heuristic', tv: v.tv || TRIAGE_VERSION };
    });

    // Discord pings only for genuinely new arrivals — not re-triaged old mail.
    // Sender rules apply: muted senders never ping, starred senders always do.
    const newImportant = merged.filter(m => {
      if (m.seen || known.has(m.id) || state.dismissed.includes(m.id)) return false;
      const rule = senderRuleFor(state, m.from)?.rule;
      return rule === 'star' || (m.important && rule !== 'block');
    });
    state.scannedAt = now();
    state.account = mc.user;
    state.error = '';
    state.triage = triage;
    state.messages = merged.slice(0, 100);
    state.dismissed = state.dismissed.filter(id => merged.some(m => m.id === id)).slice(-200);
    saveState(state);

    if (newImportant.length && cfg.notify?.onImportantMail !== false && cfg.notify?.discordWebhook) {
      const lines = newImportant.slice(0, 6).map(m => `• **${m.from.replace(/<[^>]*>/g, '').trim() || m.from}** — ${m.subject}${m.reason ? ` _(${m.reason})_` : ''}`);
      notifyDiscord(`📧 ${newImportant.length} important email${newImportant.length > 1 ? 's' : ''}:\n${lines.join('\n')}`);
    }
    return { scanned: fetched.length, fresh: fresh.length, important: merged.filter(m => m.important).length, classifiedBy: triage.via, triageError: triage.error };
  } catch (e) {
    state.error = e.message;
    state.scannedAt = now();
    saveState(state);
    throw e;
  } finally {
    scanning = false;
  }
}

// ---------- sender rules (the user's ratings: mute noise, fast-track people) ----------

/** "Name <a@b.com>" → "a@b.com" (lowercased; tolerates bare addresses). */
export function addrOf(from) {
  const s = String(from || '');
  const angled = s.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1];
  const bare = angled || s.split(/[\s,;]+/).find(w => /.@./.test(w)) || '';
  return bare.replace(/^["'<]+|[>"']+$/g, '').toLowerCase();
}
const domainOf = (addr) => addr.split('@')[1] || '';

/** The rule governing a message's sender: address rule wins over domain rule. */
export function senderRuleFor(state, from) {
  const addr = addrOf(from);
  if (!addr) return null;
  const s = state.senders || {};
  if (s[addr]?.rule) return { ...s[addr], key: addr };
  const dom = '@' + domainOf(addr);
  if (dom.length > 1 && s[dom]?.rule) return { ...s[dom], key: dom };
  return null;
}

/** Rate a sender: 'block' hides it from notifications forever, 'star' fast-tracks
 *  its unread mail to the top, 'clear' removes the rule. kind 'domain' covers @domain. */
export function setSenderRule({ from, rule, kind = 'address' } = {}) {
  const addr = addrOf(from);
  if (!addr) throw Object.assign(new Error('no email address found in: ' + String(from).slice(0, 80)), { status: 400 });
  const key = kind === 'domain' ? '@' + domainOf(addr) : addr;
  if (key === '@') throw Object.assign(new Error('sender has no domain'), { status: 400 });
  const st = loadState();
  if (rule === 'clear') { delete st.senders[key]; delete st.senderStats[addr]; }
  else if (rule === 'block' || rule === 'star') st.senders[key] = { rule, kind, via: 'user', addedAt: now() };
  else throw Object.assign(new Error('rule must be block, star, or clear'), { status: 400 });
  saveState(st);
  return { key, rule: rule === 'clear' ? null : rule };
}

export function listSenderRules() {
  const st = loadState();
  return Object.entries(st.senders).map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => (a.rule > b.rule ? -1 : a.rule < b.rule ? 1 : a.key.localeCompare(b.key)));
}

/**
 * The Home inbox list: sender-starred unread mail is fast-tracked to the very
 * top, then important UNREAD mail (reading it in the mail client clears it on
 * the next scan), then a tail of message-starred mail from the last 10 days.
 * Muted senders never appear.
 */
export function notifications() {
  const s = loadState();
  const mc = loadConfig().mail || {};
  const dismissed = new Set(s.dismissed);
  const ruleOf = (m) => senderRuleFor(s, m.from)?.rule || null;
  const alive = s.messages.filter(m => !dismissed.has(m.id) && ruleOf(m) !== 'block');

  // fast track: unread mail from senders the user starred — triage can't demote it
  const fast = alive
    .filter(m => !m.seen && ruleOf(m) === 'star')
    .sort((a, b) => parseImapDate(b.date) - parseImapDate(a.date) || b.uid - a.uid);
  const fastIds = new Set(fast.map(m => m.id));

  const rest = alive
    .filter(m => m.important && !m.seen && !fastIds.has(m.id))
    .sort((a, b) => (b.urgency === 'high') - (a.urgency === 'high') || b.uid - a.uid);
  const main = [...fast, ...rest].slice(0, 14);

  const inMain = new Set(main.map(m => m.id));
  const horizon = Date.now() - 10 * 86400_000;
  const starred = alive
    .filter(m => m.starred && !inMain.has(m.id) && (parseImapDate(m.date) || Date.now()) >= horizon)
    .sort((a, b) => parseImapDate(b.date) - parseImapDate(a.date) || b.uid - a.uid)
    .slice(0, 8);

  const pub = (m) => ({
    id: m.id, uid: m.uid, from: m.from, subject: m.subject, date: m.date,
    seen: !!m.seen, starred: !!m.starred, urgency: m.urgency || 'normal',
    category: m.category || 'other', reason: m.reason || '', snippet: m.snippet || '',
    fast: fastIds.has(m.id), senderRule: ruleOf(m),
    link: webmailLink(mc.host, m.messageId),
  });
  return {
    scannedAt: s.scannedAt, account: s.account, error: s.error, triage: s.triage || null,
    items: main.map(pub),
    starred: starred.map(pub),
  };
}

export function dismiss(id) {
  const s = loadState();
  if (!s.dismissed.includes(id)) s.dismissed.push(id);
  // repeated refusals train the filter: 3 dismissals of one sender auto-mutes it
  const m = s.messages.find(x => x.id === id);
  const addr = m ? addrOf(m.from) : '';
  let mutedSender = '';
  if (addr) {
    const st = (s.senderStats[addr] ||= { dismissed: 0 });
    st.dismissed++;
    if (st.dismissed >= 3 && !senderRuleFor(s, m.from)) {
      s.senders[addr] = { rule: 'block', kind: 'address', via: 'auto', addedAt: now() };
      mutedSender = addr;
    }
  }
  saveState(s);
  return { ok: true, mutedSender };
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
