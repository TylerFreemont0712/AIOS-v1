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
import { spawn, spawnSync } from 'node:child_process';
import { DATA, loadConfig } from './config.js';
import { id as genId, now } from './util.js';

const DIR = path.join(DATA, 'uploads');
const MAX_BYTES = 25 * 1024 * 1024;          // 25MB per file (raw body limit is 32mb)
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_ATTACHMENTS = 12;
const MAX_EDGE = 2048;                       // long edge after transcode; models see no more
const RESIZE_ABOVE_BYTES = 2 * 1024 * 1024;  // past this a JPEG is over MAX_EDGE in practice

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

/**
 * The EXIF Orientation tag of a JPEG, 1-8, or 0 when there is none.
 *
 * Worth 40 lines of byte-walking to avoid a subprocess, because it closes a defect that
 * made the orientation feature actively harmful. Every camera phone stores a portrait photo
 * as a LANDSCAPE raster plus Orientation=6. ffmpeg's `-i` banner — which imageSize() parses
 * — reports the coded size and ignores the tag, so detectSideways() saw 4032x3024, called a
 * correctly-taken portrait receipt "sideways", and rotated it. Meanwhile every ffmpeg
 * ENCODE in this file autorotates by default, so the rotation was applied to an image that
 * had just been straightened: the result was genuinely sideways, with the tag now gone so
 * nothing could recover it. The model was then handed the receipt at 90° — precisely the
 * failure the feature exists to prevent.
 *
 * Only JPEG carries this in practice (PNG has no orientation concept), so that is all this
 * reads. A truncated or malformed header returns 0 and the caller changes nothing.
 */
export function exifOrientation(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return 0;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return 0;             // not a JPEG
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return 0;                              // desynchronised
    const marker = buf[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return 0;           // image data — no EXIF
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) return 0;
    if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      const tiff = p + 10;
      if (tiff + 8 > buf.length) return 0;
      const le = buf.toString('latin1', tiff, tiff + 2) === 'II';
      const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      if (u16(tiff + 2) !== 0x2a) return 0;                     // not a TIFF header
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > buf.length) return 0;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > buf.length) return 0;
        if (u16(e) === 0x0112) {                                // Orientation
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 0;
        }
      }
      return 0;
    }
    p += 2 + len;
  }
  return 0;
}

/** Pixel size of a stored image, via ffmpeg. Returns null when it cannot be read. */
export function imageSize(buf) {
  const bin = ffmpegBin();
  if (!bin) return null;
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-dim-')); } catch { return null; }
  const src = path.join(dir, 'in.bin');
  try {
    fs.writeFileSync(src, buf);
    const r = spawnSync(bin, ['-hide_banner', '-i', src], { encoding: 'utf8', timeout: 15_000 });
    const m = /,\s(\d{2,6})x(\d{2,6})[\s,]/.exec(r.stderr || '');
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
}

/** A downscaled greyscale raster, for cheap image analysis without a CV dependency. */
export function greyRaster(buf, n = 256) {
  const bin = ffmpegBin();
  if (!bin) return null;
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-grey-')); } catch { return null; }
  const src = path.join(dir, 'in.bin');
  try {
    fs.writeFileSync(src, buf);
    const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-i', src,
      '-vf', `scale=${n}:${n}:force_original_aspect_ratio=disable,format=gray`,
      '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26, timeout: 20_000 });
    return r.status === 0 && r.stdout?.length === n * n ? { n, data: r.stdout } : null;
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
}

/**
 * A greyscale raster with the picture's own proportions kept.
 *
 * greyRaster() forces a square, which is right for the checks that only care about
 * relative structure — but fatal for anything measuring an ANGLE. Squashing a 1200×1600
 * photo into 256×256 stretches the vertical by 1.33×, and a text line printed at 4°
 * arrives at the detector reading 5.3°. Deskew would then confidently over-rotate every
 * portrait photo it was given.
 */
export function greyFit(buf, maxDim = 320) {
  const bin = ffmpegBin();
  if (!bin) return null;
  const dim = imageSize(buf);
  if (!dim?.width || !dim?.height) return null;
  const scale = Math.min(1, maxDim / Math.max(dim.width, dim.height));
  // Even dimensions: rawvideo gray is 1 byte per pixel so odd sizes are legal, but
  // ffmpeg's scaler is happier and the arithmetic below stays exact.
  const w = Math.max(16, Math.round(dim.width * scale / 2) * 2);
  const h = Math.max(16, Math.round(dim.height * scale / 2) * 2);
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-greyfit-')); } catch { return null; }
  const src = path.join(dir, 'in.bin');
  try {
    fs.writeFileSync(src, buf);
    const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-i', src,
      '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'],
      { maxBuffer: 1 << 26, timeout: 20_000 });
    return r.status === 0 && r.stdout?.length === w * h ? { w, h, data: r.stdout } : null;
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
}

/**
 * How far the printing on this photo is tilted, in degrees. Positive = the text runs
 * downhill to the right, which is what a right-handed person holding a receipt produces.
 *
 * Projection profiling, the classical method and the one that needs no training: rotate
 * the ink mask through a range of candidate angles and, for each, add up the ink in every
 * horizontal row. When the rows line up with the printing, the profile is a comb — dense
 * bands of text separated by empty paper — and when they do not, the ink smears evenly
 * across every row. The score is the summed squared difference between neighbouring rows,
 * which is largest exactly when that comb is sharpest.
 *
 * Bounded to ±`maxDeg` on purpose. A hand-held photo is tilted a few degrees; anything
 * claiming 30° is the detector locking onto a table edge or a shadow, and a confident
 * 30° rotation of a straight receipt is far worse than leaving a 4° one alone. Whole
 * quarter-turns are somebody else's job (see planAngle in receipts.js).
 */
export function detectSkew(buf, { maxDeg = 12, step = 0.5, maxDim = 320 } = {}) {
  const g = greyFit(buf, maxDim);
  if (!g) return null;
  const { w, h, data } = g;

  // Ink mask, thresholded the same way cropToContent does it: midway between the dark and
  // bright deciles, so a dim photo and a blown-out one both separate.
  const hist = new Array(256).fill(0);
  for (const v of data) hist[v]++;
  let acc = 0, lo = 0, hi = 255;
  const tenth = data.length * 0.1;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= tenth) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= tenth) { hi = i; break; } }
  if (hi - lo < 30) return null;                       // flat image: no printing to align
  const th = (lo + hi) / 2;

  const cx = w / 2, cy = h / 2;
  const score = (deg) => {
    const rad = deg * Math.PI / 180;
    const sin = Math.sin(rad), cos = Math.cos(rad);
    const rows = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      const dy = y - cy;
      for (let x = 0; x < w; x++) {
        if (data[y * w + x] >= th) continue;            // paper, not ink
        const dx = x - cx;
        // Where this ink lands once the picture is turned by -deg. Only the row matters.
        const ry = Math.round(cy + (-dx * sin + dy * cos));
        if (ry >= 0 && ry < h) rows[ry]++;
      }
    }
    let s = 0;
    for (let y = 1; y < h; y++) { const d = rows[y] - rows[y - 1]; s += d * d; }
    return s;
  };

  let best = 0, bestScore = -1;
  for (let deg = -maxDeg; deg <= maxDeg + 1e-9; deg += step) {
    const s = score(deg);
    if (s > bestScore) { bestScore = s; best = deg; }
  }
  const flat = score(0);
  return {
    // Round to the search grid: reporting 3.9999999999 invites callers to treat a
    // floating-point artefact as a meaningful difference from 4.
    degrees: Math.round(best / step) * step,
    // How much better the winning angle is than leaving it alone. Below a few percent the
    // "tilt" is noise, and the caller should decline rather than re-encode for nothing.
    gain: flat > 0 ? (bestScore - flat) / flat : 0,
  };
}

/**
 * Straighten the printing on a photo. Returns JPEG bytes and what it did, or null when
 * there is nothing worth straightening.
 *
 * Rotation only — NOT four-corner perspective correction, though ffmpeg has the filter and
 * the temptation is obvious. Keystoning needs the four corners of the paper found
 * reliably, and on a white receipt lying on a pale table the corner search fails quietly
 * and often; a wrong perspective transform does not gently under-correct, it shears the
 * text into something no model can read. A bounded rotation cannot fail that way: the
 * worst case is a slightly tilted receipt, which is where it started.
 *
 * The canvas grows to hold the turned image and the new corners are filled white, because
 * this runs before cropToContent — black corners would read as background and drag the
 * crop box out to the full frame, undoing the one preprocessing step already known to
 * matter more than any other.
 */
export function deskew(buf, { minDeg = 0.75, minGain = 0.04, ...opts } = {}) {
  const found = detectSkew(buf, opts);
  if (!found) return null;
  const { degrees, gain } = found;
  // Two independent guards. A tiny angle is not worth a re-encode (JPEG is lossy, and
  // this runs before the model sees anything); a weak gain means the detector never found
  // a comb and is reporting the best of a set of equally bad options.
  if (Math.abs(degrees) < minDeg || gain < minGain) return null;

  const bin = ffmpegBin();
  if (!bin) return null;
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-deskew-')); } catch { return null; }
  const src = path.join(dir, 'in.bin'), dst = path.join(dir, 'out.jpg');
  try {
    fs.writeFileSync(src, buf);
    const rad = (-degrees * Math.PI / 180).toFixed(6);       // undo the tilt
    const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src,
      '-vf', `rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):fillcolor=white`,
      '-q:v', '2', dst], { timeout: 60_000 });
    if (r.status !== 0 || !fs.existsSync(dst)) return null;
    return { buffer: fs.readFileSync(dst), degrees, gain: Math.round(gain * 100) / 100 };
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
}

/**
 * Trim a photo down to the bright document sitting in it. Returns JPEG bytes, or null
 * when there is nothing worth cropping.
 *
 * This is a resolution problem, not a tidiness one. A receipt photographed on a table
 * fills only 37-46% of the frame on every real example here, and the model downsamples
 * whatever it is given to a fixed size — so more than half the pixel budget goes to
 * woodgrain. Measured: an uncropped receipt transcribed to **86 characters** (the model
 * found only the big text on the card slip and missed every product); cropped, the same
 * photo gave **698 characters** and a perfect reading.
 *
 * Deliberately conservative. A row or column counts as document only if a quarter of it
 * is bright, so one specular highlight cannot stretch the box, and the crop is skipped
 * entirely unless it saves real area and leaves a plausible shape.
 */
export function cropToContent(buf, { pad = 0.03, maxArea = 0.8 } = {}) {
  const n = 192;
  const g = greyRaster(buf, n);
  if (!g) return null;
  const px = g.data;

  // Threshold midway between the darkest and brightest deciles — robust to both a dim
  // photo and a blown-out one, where a fixed cutoff is robust to neither.
  const hist = new Array(256).fill(0);
  for (const v of px) hist[v]++;
  let acc = 0, lo = 0, hi = 255;
  const tenth = px.length * 0.1;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= tenth) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= tenth) { hi = i; break; } }
  const th = (lo + hi) / 2;
  if (hi - lo < 30) return null;                       // flat image: nothing to separate

  let x0 = n, y0 = n, x1 = -1, y1 = -1, rows = 0;
  for (let y = 0; y < n; y++) {
    let c = 0;
    for (let x = 0; x < n; x++) if (px[y * n + x] > th) c++;
    if (c > n * 0.25) { if (y < y0) y0 = y; if (y > y1) y1 = y; rows++; }
  }
  for (let x = 0; x < n; x++) {
    let c = 0;
    for (let y = 0; y < n; y++) if (px[y * n + x] > th) c++;
    if (c > n * 0.25) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  }
  if (rows < n * 0.1 || x1 <= x0 || y1 <= y0) return null;

  const fx0 = Math.max(0, x0 / n - pad), fy0 = Math.max(0, y0 / n - pad);
  const fx1 = Math.min(1, (x1 + 1) / n + pad), fy1 = Math.min(1, (y1 + 1) / n + pad);
  const w = fx1 - fx0, h = fy1 - fy0;
  if (w * h > maxArea) return null;                    // already fills the frame
  if (w < 0.12 || h < 0.12) return null;               // implausibly small — trust it less

  const bin = ffmpegBin();
  if (!bin) return null;
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-crop-')); } catch { return null; }
  const src = path.join(dir, 'in.bin'), dst = path.join(dir, 'out.jpg');
  try {
    fs.writeFileSync(src, buf);
    const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src,
      '-vf', `crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${fx0.toFixed(4)}:ih*${fy0.toFixed(4)}`,
      '-q:v', '2', dst], { timeout: 60_000 });
    if (r.status !== 0 || !fs.existsSync(dst)) return null;
    return { buffer: fs.readFileSync(dst), area: Math.round(w * h * 100) };
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
}

/**
 * Cut a long strip into overlapping horizontal bands. Returns JPEG buffers, or null when
 * the image is not long enough for this to be worth doing.
 *
 * Same problem cropToContent() solves, one step further along. A vision model resizes its
 * input to a fixed budget before it reads anything, so detail survives in proportion to
 * how square the picture is. A cropped till receipt is typically 3-6× taller than it is
 * wide, and squeezing that into a square budget throws away most of the vertical
 * resolution — which is precisely the resolution the *small* text is written in. Product
 * names are small text. Totals are not, which is why a bad scan so often gets the total
 * right and the names wrong: the failure is not that the model cannot read, it is that by
 * the time it looks, half the strokes are gone.
 *
 * Bands are aimed at roughly 1.4:1, the shape that survives that resize best, and they
 * OVERLAP: a cut through the middle of a line would otherwise lose it from both halves,
 * and a lost line is invisible where a repeated one is caught by the arithmetic. The
 * overlap is what the stitcher upstream aligns on, so it has to be several lines deep,
 * not a few pixels.
 */
export function sliceTall(buf, { max = 3, overlap = 0.14, minHeight = 1200, minAspect = 2 } = {}) {
  const bin = ffmpegBin();
  if (!bin || max < 2) return null;
  const size = imageSize(buf);
  if (!size || !size.width || !size.height) return null;
  const aspect = size.height / size.width;
  if (aspect < minAspect || size.height < minHeight) return null;   // already a readable shape

  const n = Math.min(Math.trunc(max), Math.max(2, Math.round(aspect / 1.4)));
  const bandH = size.height / (1 + (n - 1) * (1 - overlap));
  const step = bandH * (1 - overlap);

  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-slice-')); } catch { return null; }
  const src = path.join(dir, 'in.bin');
  try {
    fs.writeFileSync(src, buf);
    const bands = [];
    for (let i = 0; i < n; i++) {
      const y = Math.min(Math.round(i * step), size.height - Math.round(bandH));
      const dst = path.join(dir, `b${i}.jpg`);
      const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src,
        '-vf', `crop=${size.width}:${Math.round(bandH)}:0:${Math.max(0, y)}`,
        '-q:v', '2', dst], { timeout: 60_000 });
      if (r.status !== 0 || !fs.existsSync(dst)) return null;       // all or nothing: a
      bands.push(fs.readFileSync(dst));                             // partial strip is worse
    }                                                               // than the whole photo
    return { bands, n, overlap, width: size.width, height: size.height, bandHeight: Math.round(bandH) };
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
}

/**
 * Rotate a stored image in place, clockwise, and update its metadata.
 *
 * In place on purpose: the photo shown in the review editor has to be the same one the
 * model was given, or "check the reading against the paper" stops meaning anything.
 */
export function rotateStored(id, degrees) {
  const deg = ((Math.round(Number(degrees) / 90) * 90) % 360 + 360) % 360;
  const meta = getMeta(id);
  if (!meta) throw bad('upload not found', 404);
  if (!deg) return meta;
  const bin = ffmpegBin();
  if (!bin) throw bad('rotating needs ffmpeg — install it, or set uploads.ffmpeg');

  // transpose=1 is 90° clockwise, transpose=2 is 90° counter-clockwise.
  const vf = deg === 90 ? 'transpose=1' : deg === 180 ? 'transpose=1,transpose=1' : 'transpose=2';
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-rot-')); } catch { throw bad('could not rotate'); }
  const src = path.join(dir, 'in.bin');
  const dst = path.join(dir, 'out.jpg');
  try {
    fs.copyFileSync(dataFile(id), src);
    const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', src, '-vf', vf, '-q:v', '3', dst], { timeout: 60_000 });
    if (r.status !== 0 || !fs.existsSync(dst)) throw bad('ffmpeg could not rotate that image');
    const out = fs.readFileSync(dst);
    fs.writeFileSync(dataFile(id), out);
    const next = { ...meta, mime: 'image/jpeg', size: out.length, rotatedBy: ((meta.rotatedBy || 0) + deg) % 360 };
    fs.writeFileSync(metaFile(id), JSON.stringify(next));
    return next;
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
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
  // A provider-safe JPEG that carries a rotation tag is straightened here and nowhere else.
  //
  // Nothing downstream agrees about EXIF: imageSize() reads the coded size and ignores the
  // tag, while every ffmpeg encode (toJpeg, cropToContent, rotateStored) silently
  // autorotates first. That disagreement is what let detectSideways() rotate an already-
  // upright photo — see exifOrientation(). Re-encoding once at the door makes the stored
  // raster match what every reader will see, and costs one ffmpeg pass on the small
  // fraction of uploads that actually carry a non-trivial tag.
  const safe = meta.kind === 'image' && isProviderSafeImage(meta.mime);
  const needsUpright = safe && exifOrientation(buffer) > 1;
  // MAX_EDGE was only ever applied on the transcode path, so a provider-safe image was
  // stored and shipped at native size — a 25MB phone JPEG becomes ~33MB of base64 in the
  // request body, for pixels the model downsamples away anyway. Size is used as the trigger
  // rather than probing every upload: an ffmpeg spawn per attachment to measure something
  // this cheap to over-approximate is the wrong trade, and anything past a couple of MB is
  // over 2048px in practice. GIF is excluded — `-frames:v 1` would silently drop animation.
  const needsShrink = safe && buffer.length > RESIZE_ABOVE_BYTES && meta.mime !== 'image/gif';
  if (needsUpright || needsShrink) {
    const upright = await toJpeg(buffer, { ext: path.extname(cleanName) || '.jpg' });
    if (upright) {
      meta.mime = 'image/jpeg';
      meta.size = upright.length;
      if (needsUpright) meta.uprighted = true;
      if (needsShrink) { meta.originalSize = buffer.length; meta.resized = true; }
      bytes = upright;
    } else if (needsUpright) {
      // No ffmpeg: leave the bytes alone and say so, so detectSideways can decline to
      // guess rather than guessing from dimensions it cannot trust.
      meta.exifRotated = true;
    }
  } else if (meta.kind === 'image' && !isProviderSafeImage(meta.mime)) {
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

/** Store bytes we produced ourselves (a crop, a rotation) — already a safe JPEG, so it
 *  skips the sniff/transcode path and stays synchronous for callers inside a pipeline. */
export function saveUploadSync({ name = 'image.jpg', mime = 'image/jpeg', buffer } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw bad('no file data');
  fs.mkdirSync(DIR, { recursive: true });
  const meta = { id: genId(12), name, mime, size: buffer.length, kind: 'image', createdAt: now(), derived: true };
  fs.writeFileSync(dataFile(meta.id), buffer);
  fs.writeFileSync(metaFile(meta.id), JSON.stringify(meta));
  return meta;
}

/** Remove a stored upload. Used for the transient images the OCR pipeline derives. */
export function deleteUpload(id) {
  if (!ID_RE.test(String(id || ''))) return false;
  try { fs.rmSync(dataFile(id), { force: true }); fs.rmSync(metaFile(id), { force: true }); return true; }
  catch { return false; }
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
