import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

export const id = (n = 10) => randomBytes(n).toString('base64url');

export const now = () => new Date().toISOString();

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
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
export function extractJSON(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === '{') depth++;
    else if (!inStr && ch === '}') {
      depth--;
      if (depth === 0) {
        const cand = cleaned.slice(start, i + 1);
        try { return JSON.parse(cand); } catch { }
        try { return JSON.parse(cand.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }  // strip trailing commas
      }
    }
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
