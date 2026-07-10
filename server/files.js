// File APIs for the explorer/editor. Every call is scoped to a registered root
// (a project id or 'vault') and path-confined inside it.

import fs from 'node:fs';
import path from 'node:path';
import { safePath, isBinary, mimeFor, walk } from './util.js';
import { allowedRoots } from './projects.js';

function rootPath(rootId) {
  const r = allowedRoots().get(rootId);
  if (!r) throw Object.assign(new Error('unknown root: ' + rootId), { status: 404 });
  return r;
}

export function tree(rootId, rel = '') {
  const abs = safePath(rootPath(rootId), rel);
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter(e => !['node_modules', '.git'].includes(e.name))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 800)
    .map(e => {
      let size = 0, mtime = 0;
      try { const st = fs.statSync(path.join(abs, e.name)); size = st.size; mtime = st.mtimeMs; } catch { }
      return { name: e.name, dir: e.isDirectory(), size, mtime };
    });
  return { path: rel, entries };
}

export function readFile(rootId, rel) {
  const abs = safePath(rootPath(rootId), rel);
  const st = fs.statSync(abs);
  if (st.size > 5_000_000) return { binary: true, size: st.size, reason: 'too large' };
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) return { binary: true, size: st.size, mime: mimeFor(rel) };
  return { binary: false, size: st.size, content: buf.toString('utf8'), mtime: st.mtimeMs };
}

export function writeFile(rootId, rel, content, expectedMtime) {
  const abs = safePath(rootPath(rootId), rel);
  if (expectedMtime && fs.existsSync(abs)) {
    const cur = fs.statSync(abs).mtimeMs;
    if (Math.abs(cur - expectedMtime) > 1) {
      throw Object.assign(new Error('file changed on disk since it was opened'), { status: 409 });
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content ?? '');
  return { size: Buffer.byteLength(content ?? ''), mtime: fs.statSync(abs).mtimeMs };
}

export function mkdir(rootId, rel) {
  fs.mkdirSync(safePath(rootPath(rootId), rel), { recursive: true });
}

export function rename(rootId, from, to) {
  const root = rootPath(rootId);
  const a = safePath(root, from), b = safePath(root, to);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(a, b);
}

export function remove(rootId, rel) {
  const root = rootPath(rootId);
  const abs = safePath(root, rel);
  if (abs === path.resolve(root)) throw Object.assign(new Error('refusing to delete root'), { status: 400 });
  fs.rmSync(abs, { recursive: true, force: true });
}

export function raw(rootId, rel) {
  const abs = safePath(rootPath(rootId), rel);
  return { abs, mime: mimeFor(rel), size: fs.statSync(abs).size };
}

/** Quick search: filename matches + content hits (small files only). */
export function search(rootId, q, { maxResults = 60 } = {}) {
  const root = rootPath(rootId);
  const needle = q.toLowerCase();
  const nameHits = [], contentHits = [];
  walk(root, (abs, rel, e) => {
    if (nameHits.length + contentHits.length >= maxResults) return;
    if (e.isDirectory()) return;
    if (rel.toLowerCase().includes(needle)) { nameHits.push({ path: rel, kind: 'name' }); return; }
    try {
      const st = fs.statSync(abs);
      if (st.size > 300_000) return;
      const buf = fs.readFileSync(abs);
      if (isBinary(buf)) return;
      const text = buf.toString('utf8');
      const idx = text.toLowerCase().indexOf(needle);
      if (idx >= 0) {
        const line = text.slice(0, idx).split('\n').length;
        const excerpt = text.slice(Math.max(0, idx - 40), idx + 80).replace(/\n/g, ' ');
        contentHits.push({ path: rel, kind: 'content', line, excerpt });
      }
    } catch { }
  }, { maxFiles: 6000 });
  return [...nameHits, ...contentHits].slice(0, maxResults);
}
