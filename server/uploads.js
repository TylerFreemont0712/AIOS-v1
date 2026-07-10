// Uploaded media (images, PDFs, documents, text files) for chat & agent input.
// Bytes live in DATA/uploads/<id>.bin; a sidecar <id>.json holds the metadata so the
// file can be served back (previews in reloaded transcripts) with the right type.
// Messages only ever store the lightweight meta — never base64 — so context trimming
// and on-disk transcripts stay small. llm.js materializes the bytes at send time.

import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { id as genId, now } from './util.js';

const DIR = path.join(DATA, 'uploads');
const MAX_BYTES = 25 * 1024 * 1024;          // 25MB per file (json body limit is 60mb)
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_ATTACHMENTS = 12;

// Image types every vision provider (Anthropic / OpenAI-compatible / Ollama) accepts.
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Text-ish files we inline as readable text for any model (not just vision ones).
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb',
  '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.php', '.sh',
  '.bash', '.zsh', '.sql', '.log', '.ini', '.toml', '.conf', '.env', '.svg', '.tex',
]);

/** image | pdf | text | other — decides how a provider will consume the file. */
export function classify(mime = '', name = '') {
  const m = String(mime).toLowerCase();
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_MIMES.has(m)) return 'image';
  if (m === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml'
    || m === 'application/javascript' || TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

const dataFile = (id) => path.join(DIR, id + '.bin');
const metaFile = (id) => path.join(DIR, id + '.json');

/** Store a base64 (or data: URL) upload, returning its metadata. */
export function saveUpload({ name, mime, data } = {}) {
  if (typeof data !== 'string' || !data) throw Object.assign(new Error('no file data'), { status: 400 });
  const b64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;   // tolerate data: URLs
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw Object.assign(new Error('empty file'), { status: 400 });
  if (buf.length > MAX_BYTES) throw Object.assign(new Error(`file too large (max ${Math.round(MAX_BYTES / 1048576)}MB)`), { status: 413 });

  fs.mkdirSync(DIR, { recursive: true });
  const cleanName = String(name || 'file').replace(/[\r\n\t]/g, ' ').trim().slice(0, 200) || 'file';
  const m = String(mime || 'application/octet-stream').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  const meta = { id: genId(12), name: cleanName, mime: m, size: buf.length, kind: classify(m, cleanName), createdAt: now() };
  fs.writeFileSync(dataFile(meta.id), buf);
  fs.writeFileSync(metaFile(meta.id), JSON.stringify(meta));
  return meta;
}

export function getMeta(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')); } catch { return null; }
}

/** Bytes + meta for a stored upload (used by llm.js when building provider messages). */
export function readUpload(id) {
  const meta = getMeta(id);
  if (!meta) throw Object.assign(new Error('upload not found'), { status: 404 });
  return { meta, buffer: fs.readFileSync(dataFile(id)) };
}

/** For serving bytes back to the browser (transcript previews). */
export function uploadFile(id) {
  const meta = getMeta(id);
  if (!meta) throw Object.assign(new Error('upload not found'), { status: 404 });
  return { abs: path.resolve(dataFile(id)), mime: meta.mime, name: meta.name };
}

/** Validate & normalize an attachment list from a client into trusted stored meta. */
export function resolveAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, MAX_ATTACHMENTS)) {
    const meta = getMeta(a?.id);
    if (meta) out.push({ id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, kind: meta.kind });
  }
  return out;
}
