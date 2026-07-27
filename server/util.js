import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

export const id = (n = 10) => randomBytes(n).toString('base64url');

export const now = () => new Date().toISOString();

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * Atomic JSON write.
 *
 * `pretty` is on by default because most of what AIOS stores is meant to be readable
 * by hand (config, presets, project registries). Transcripts pass `false`: they are
 * written on EVERY streamed turn, they grow all session, and indenting them costs both
 * the extra bytes and the event-loop time to produce them — writeFileSync blocks, so a
 * long chat was charging every message for the length of its own history.
 */
export function writeJSON(file, data, { pretty = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/**
 * A list view over a directory of JSON records, cached by mtime.
 *
 * Sidebars (chats, agent sessions, research) need a handful of fields per record —
 * usually including a message COUNT, which is why this was reading and parsing every
 * transcript in full on every refresh. That is O(all bytes ever written) for a list
 * that changes one row at a time, it blocks the event loop, and it gets slower every
 * day the box stays up. Now an unchanged file costs one stat().
 *
 * The cache is bounded by the directory: entries for deleted files are evicted on the
 * next pass, so nothing accumulates.
 */
export function jsonDirIndex(dir, summarize) {
  const cache = new Map();                   // filename -> { mtimeMs, value }
  return function index() {
    let names;
    try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
    const out = [];
    const seen = new Set(names);
    for (const f of names) {
      const abs = path.join(dir, f);
      let mtimeMs;
      try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { continue; }
      const hit = cache.get(f);
      if (hit && hit.mtimeMs === mtimeMs) { if (hit.value) out.push(hit.value); continue; }
      const data = readJSON(abs);
      let value = null;
      try { value = data ? summarize(data) : null; } catch { value = null; }
      cache.set(f, { mtimeMs, value });
      if (value) out.push(value);
    }
    for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
    return out;
  };
}

/** Resolve `p` inside `root`; throws if it escapes. Returns absolute path. */
export function safePath(root, p = '') {
  const abs = path.resolve(root, String(p).replace(/^[/\\]+/, ''));
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw Object.assign(new Error(`path escapes root: ${p}`), { status: 400 });
  }
  return abs;
}

/** Middle-out truncation for long tool output. */
export function truncate(str, max = 30000) {
  if (typeof str !== 'string') str = String(str ?? '');
  if (str.length <= max) return str;
  const half = Math.floor(max / 2);
  const omitted = str.length - max;
  return str.slice(0, half) + `\n... [${omitted} chars truncated] ...\n` + str.slice(-half);
}

// Middle-truncate a single message so it fits a context budget (keeps the start and
// end, which usually carry the intent/answer). Weighted toward the start.
export function clampMiddle(str, max) {
  if (typeof str !== 'string' || str.length <= max) return str;
  const head = Math.max(200, Math.floor(max * 0.6));
  const tail = Math.max(120, max - head - 60);
  return str.slice(0, head) + '\n\n…[long message trimmed to fit the context window]…\n\n' + str.slice(str.length - tail);
}

export function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function estTokens(str) { return Math.ceil((str?.length || 0) / 4); }

/** Pull the first JSON object out of model output, tolerating fences and trailing prose.
 *  String-aware brace walker with a trailing-comma repair fallback. */
/** Every balanced {...} block in `text` that parses as JSON, in order. Exported so
 *  callers that must choose between several candidate objects (a model echoing the
 *  prompt's template before answering) can score them rather than guess. */
export function jsonBlocks(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const out = [];
  let start = -1, depth = 0, inStr = false, esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const cand = cleaned.slice(start, i + 1);
        let val = null;
        try { val = JSON.parse(cand); }
        catch { try { val = JSON.parse(cand.replace(/,\s*([}\]])/g, '$1')); } catch { /* not JSON */ } }
        if (val && typeof val === 'object') out.push(val);
        start = -1;
      }
    }
  }
  return out;
}

/** Pull a JSON object out of a model reply.
 *
 *  `require` names the key(s) the real answer must contain. Supply it whenever the
 *  prompt itself shows a JSON template: reasoning models routinely echo the
 *  template back before answering, and taking the first {...} then returns the
 *  placeholder — "name_en": "..." — as if it were the result. With `require` set,
 *  the LAST block carrying one of those keys wins, which is the answer.
 */
export function extractJSON(text, { require: req } = {}) {
  if (!text) return null;
  const blocks = jsonBlocks(text);
  if (!blocks.length) return null;
  if (!req) return blocks[0];
  const keys = Array.isArray(req) ? req : [req];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (keys.some(k => blocks[i][k] !== undefined)) return blocks[i];
  }
  return null;
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2',
};
export const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

/** Walk a directory tree, calling cb(absPath, relPath, dirent). Skips heavy dirs. */
export function walk(root, cb, { skip = ['node_modules', '.git', '.obsidian', 'dist', 'build', '__pycache__', '.venv', 'venv', '.next', 'target'], maxFiles = 20000 } = {}) {
  let count = 0;
  const rec = (dir, rel) => {
    if (count >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count >= maxFiles) return;
      if (e.name.startsWith('.') && e.isDirectory() && skip.includes(e.name)) continue;
      if (skip.includes(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      count++;
      cb(abs, r, e);
      if (e.isDirectory()) rec(abs, r);
    }
  };
  rec(root, '');
}
