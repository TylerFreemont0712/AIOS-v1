// Uploaded media (images, PDFs, documents, text files) for chat & agent input.
// Bytes live in DATA/uploads/<id>.bin; a sidecar <id>.json holds the metadata so the
// file can be served back (previews in reloaded transcripts) with the right type.
// Messages only ever store the lightweight meta — never base64 — so context trimming
// and on-disk transcripts stay small. llm.js materializes the bytes at send time.
//
// Everything that arrives here is normalized to something every provider can read,
// because the alternative is what used to happen: an iPhone photo landed as
// kind:"other" and the vision model never saw it. Three things make that work —
//
//  1. The BYTES decide the type, not the client. iOS hands us `image/heic` for a
//     camera roll photo, an EMPTY type for anything shared in from another app or
//     picked through Files, and occasionally the wrong type outright. Only the
//     file's own header is trustworthy, so we sniff it first and fall back to the
//     declared type, then the extension.
//  2. HEIC/HEIF/AVIF/TIFF/BMP are transcoded to JPEG on the way in. No provider
//     accepts them (Anthropic documents png/jpeg/gif/webp; llama.cpp and Ollama
//     decode roughly the same set), so converting once at the door means nothing
//     downstream — llm.js, receipts.js, comfy.js — has to know they exist.
//  3. Classification never depends on a MIME type alone.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, loadConfig } from './config.js';
import { id as genId, now } from './util.js';

const DIR = path.join(DATA, 'uploads');
const MAX_BYTES = 25 * 1024 * 1024;          // 25MB per file (raw body limit is 32mb)
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_ATTACHMENTS = 12;
const MAX_EDGE = 2048;                       // long edge after transcode; models see no more

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// The only image types EVERY vision provider accepts.
const SAFE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Camera and scanner formats no provider accepts — transcoded to JPEG on arrival.
// HEIC is first for a reason: it is what an iPhone shoots unless the owner has
// changed Settings → Camera → Formats to "Most Compatible".
const CONVERT_IMAGE_MIMES = new Set([
  'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence', 'image/heix',
  'image/avif', 'image/avif-sequence', 'image/tiff', 'image/x-tiff', 'image/bmp',
  'image/x-ms-bmp', 'image/jp2', 'image/jpx', 'image/jpm', 'image/x-icon',
  'image/vnd.microsoft.icon', 'image/x-portable-pixmap', 'image/x-portable-anymap',
  'image/x-tga', 'image/x-targa',
]);

// Extension → MIME, used when the client sends no type at all. iOS does this
// routinely, and without the fallback a perfectly good JPEG classified as 'other'.
const IMAGE_EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
  '.hif': 'image/heif', '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.bmp': 'image/bmp', '.jp2': 'image/jp2', '.ico': 'image/x-icon', '.tga': 'image/x-tga',
};

// Types that carry no information — treat them as "the client didn't say".
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/binary', 'application/unknown']);

// Text-ish files we inline as readable text for any model (not just vision ones).
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb',
  '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.php', '.sh',
  '.bash', '.zsh', '.sql', '.log', '.ini', '.toml', '.conf', '.env', '.svg', '.tex',
]);

/** What the bytes actually are, ignoring the name and the client's claim. */
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return '';
  const ascii = (a, b) => buf.toString('latin1', a, b);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 3) === 'GIF') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00)) return 'image/tiff';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  // ISOBMFF: [size]"ftyp"[brand]. HEIC, AVIF and MP4 all live in this container, so the
  // brand is what separates "iPhone photo" from "video the user attached by mistake".
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12).toLowerCase();
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return 'image/heic';
    if (/^(avif|avis)$/.test(brand)) return 'image/avif';
  }
  return '';
}

/** Best guess at a type from what the client claimed plus the filename. */
export function normalizeMime(mime = '', name = '') {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!GENERIC_MIMES.has(m) && m.includes('/')) return m;
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT_MIME[ext]) return IMAGE_EXT_MIME[ext];
  if (ext === '.pdf') return 'application/pdf';
  if (TEXT_EXT.has(ext)) return 'text/plain';
  return m || 'application/octet-stream';
}

/** image | pdf | text | other — decides how a provider will consume the file. */
export function classify(mime = '', name = '') {
  const m = String(mime || '').toLowerCase();
  const ext = path.extname(name).toLowerCase();
  // .svg is text (we inline the markup); every other image/* is an image, including
  // types we have no name for — better to try it than to reject it as "other".
  if (m === 'image/svg+xml' || ext === '.svg') return 'text';
  if (SAFE_IMAGE_MIMES.has(m) || CONVERT_IMAGE_MIMES.has(m) || m.startsWith('image/')) return 'image';
  if (m === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml'
    || m === 'application/javascript' || TEXT_EXT.has(ext)) return 'text';
  if (IMAGE_EXT_MIME[ext]) return 'image';
  return 'other';
}

/** Can a provider read this as-is? */
export const isProviderSafeImage = (mime) => SAFE_IMAGE_MIMES.has(String(mime || '').toLowerCase());

// ---------- transcoding ----------
//
// ffmpeg 7.1+ decodes HEIC/HEIF natively — its ISOBMFF demuxer reads the image items
// and the built-in hevc decoder does the rest, so no libheif and no new npm
// dependency. Measured on this box against the Nokia HEIF conformance suite: ~45ms
// for a 12MP still. Everything degrades gracefully: no ffmpeg → the file is stored
// untouched and the consumer says what is wrong, rather than a crash.

let ffmpegPath;
function ffmpegBin() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const configured = loadConfig().uploads?.ffmpeg;
  const fromPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(d => path.join(d, 'ffmpeg'));
  const candidates = [configured, process.env.FFMPEG, ...fromPath,
    '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg',
    '/home/linuxbrew/.linuxbrew/bin/ffmpeg'];
  ffmpegPath = candidates.find(p => { try { return p && fs.statSync(p).isFile(); } catch { return false; } }) || null;
  if (!ffmpegPath) console.warn('[uploads] ffmpeg not found — HEIC/TIFF uploads cannot be converted (set uploads.ffmpeg)');
  return ffmpegPath;
}

/** True when this box can convert the awkward formats. Surfaced in /api/status. */
export const canConvertImages = () => !!ffmpegBin();

/** Only ever shrink: an image already under the cap passes through at native size. */
const scaleFilter = (edge) =>
  `scale=w='if(gt(max(iw,ih),${edge}),if(gte(iw,ih),${edge},-2),iw)'`
  + `:h='if(gt(max(iw,ih),${edge}),if(gte(iw,ih),-2,${edge}),ih)'`;

/**
 * Re-encode an image as JPEG, downscaled to `maxEdge`. Resolves to a Buffer, or to
 * null when ffmpeg is unavailable or cannot make sense of the bytes.
 *
 * A temp file rather than a pipe because the HEIF demuxer needs to seek, and
 * `-map 0:v:0 -frames:v 1` because a Live Photo or a burst HEIC carries several
 * streams — without it ffmpeg tries to write all of them.
 */
function toJpeg(buf, { maxEdge = MAX_EDGE, ext = '.bin', timeoutMs = 30_000 } = {}) {
  const bin = ffmpegBin();
  if (!bin) return Promise.resolve(null);
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-img-')); }
  catch { return Promise.resolve(null); }

  const src = path.join(dir, 'in' + (ext || '.bin'));
  const dst = path.join(dir, 'out.jpg');
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } };

  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (done) return; done = true; cleanup(); resolve(val); };
    try { fs.writeFileSync(src, buf); } catch { return finish(null); }

    const child = spawn(bin, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', src, '-map', '0:v:0', '-frames:v', '1', '-update', '1',
      '-vf', scaleFilter(maxEdge), '-q:v', '3', '-an', '-sn', '-dn', dst,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const errBuf = [];
    child.stderr?.on('data', d => { if (errBuf.length < 20) errBuf.push(d); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { } }, timeoutMs);
    timer.unref?.();

    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      let out = null;
      try { if (fs.statSync(dst).size > 0) out = fs.readFileSync(dst); } catch { }
      if (!out) {
        const why = Buffer.concat(errBuf).toString('utf8').trim().split('\n')[0] || 'no output';
        console.warn('[uploads] ffmpeg could not convert this image:', why.slice(0, 200));
      }
      finish(out);
    });
  });
}

const dataFile = (id) => path.join(DIR, id + '.bin');
const metaFile = (id) => path.join(DIR, id + '.json');

/** Store bytes, converting the image formats no provider can read. */
async function store({ name, mime, buffer }) {
  if (!buffer?.length) throw bad('empty file');
  if (buffer.length > MAX_BYTES) throw bad(`file too large (max ${Math.round(MAX_BYTES / 1048576)}MB)`, 413);

  const cleanName = String(name || 'file').replace(/[\r\n\t]/g, ' ').trim().slice(0, 200) || 'file';
  const declared = normalizeMime(mime, cleanName);
  const sniffed = sniffMime(buffer);
  const meta = {
    id: genId(12), name: cleanName,
    mime: sniffed || declared,
    size: buffer.length, kind: '', createdAt: now(),
  };
  meta.kind = classify(meta.mime, cleanName);

  let bytes = buffer;
  if (meta.kind === 'image' && !isProviderSafeImage(meta.mime)) {
    const jpeg = await toJpeg(buffer, { ext: path.extname(cleanName) || '.heic' });
    if (jpeg) {
      meta.convertedFrom = meta.mime;
      meta.originalName = cleanName;
      meta.originalSize = buffer.length;
      meta.mime = 'image/jpeg';
      meta.name = cleanName.replace(/\.[^./\\]*$/, '') + '.jpg';
      meta.size = jpeg.length;
      bytes = jpeg;
    } else {
      // Stored anyway (the user may still want the file back) but flagged, so
      // llm.js can explain the problem instead of shipping bytes no model can read.
      meta.unreadable = `${meta.mime} could not be converted to JPEG on this machine`;
    }
  }

  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(dataFile(meta.id), bytes);
  fs.writeFileSync(metaFile(meta.id), JSON.stringify(meta));
  return meta;
}

/** Store a base64 (or data: URL) upload, returning its metadata. */
export async function saveUpload({ name, mime, data } = {}) {
  if (typeof data !== 'string' || !data) throw bad('no file data');
  const b64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;   // tolerate data: URLs
  return store({ name, mime, buffer: Buffer.from(b64, 'base64') });
}

/** Store raw bytes — the binary upload route, which skips base64 entirely. */
export async function saveUploadBuffer({ name, mime, buffer } = {}) {
  if (!Buffer.isBuffer(buffer)) throw bad('no file data');
  return store({ name, mime, buffer });
}

export function getMeta(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')); } catch { return null; }
}

/** Bytes + meta for a stored upload (used by llm.js when building provider messages). */
export function readUpload(id) {
  const meta = getMeta(id);
  if (!meta) throw bad('upload not found', 404);
  return { meta, buffer: fs.readFileSync(dataFile(id)) };
}

/** For serving bytes back to the browser (transcript previews). */
export function uploadFile(id) {
  const meta = getMeta(id);
  if (!meta) throw bad('upload not found', 404);
  return { abs: path.resolve(dataFile(id)), mime: meta.mime, name: meta.name };
}

/** Validate & normalize an attachment list from a client into trusted stored meta. */
export function resolveAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, MAX_ATTACHMENTS)) {
    const meta = getMeta(a?.id);
    if (meta) out.push({ id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, kind: meta.kind, unreadable: meta.unreadable });
  }
  return out;
}
