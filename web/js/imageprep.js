// Getting a picked photo into a shape a model can read, in the browser, before upload.
//
// The problem this solves is entirely an iPhone problem. iPhones shoot HEIC, which no
// model provider accepts, and iOS hands a web page files in several inconvenient ways:
//
//   - from the camera roll:      type "image/heic" (unless Formats = Most Compatible)
//   - shared in from another app: type "" — no MIME at all
//   - through Files → Browse:     "image/heic" only if `accept` names the extension
//
// Decoding locally and re-encoding as JPEG fixes all three at once, because Safari can
// always decode HEIC — it is the OS image format — so the canvas round-trip IS the
// conversion. It also downscales, which matters more than it sounds: a 12MP photo is
// 3-5MB of detail the vision model throws away anyway, and shipping it over Wi-Fi is
// the slowest part of reading a receipt.
//
// The server can convert these too (uploads.js, via ffmpeg), so nothing here is
// load-bearing: when a browser cannot decode a file, we hand over the original bytes
// and let the server deal with it. Two chances, and the fast one is tried first.

const LONG_EDGE = 1600;      // plenty for receipt text; keeps uploads ~300-600KB
const JPEG_QUALITY = 0.85;

// What every file input that accepts photos should use. "image/*" alone does NOT
// surface HEIC in the Files/Browse branch of the iOS sheet, so the extensions have to
// be named — and named in both cases, because the match is case-sensitive there.
export const IMAGE_ACCEPT = 'image/*,.heic,.HEIC,.heif,.HEIF,.jpg,.jpeg,.png,.webp,.avif,.tif,.tiff,.bmp';

// Types a provider takes as they are. Anything else that is still an image gets
// converted; a PNG screenshot is left exactly alone, artifacts and all.
const SAFE = /^image\/(png|jpeg|gif|webp)$/i;
const RAW_EXT = /\.(heic|heif|hif|avif|tiff?|bmp|jp2|tga)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|hif|avif|tiff?|bmp|jp2|ico|tga)$/i;

/** Does this look like a photo? Extension included, because iOS often sends no type. */
export function isImageFile(file) {
  if (!file) return false;
  const type = String(file.type || '');
  if (/^image\//i.test(type)) return true;
  if (type && !/^application\/(octet-stream|binary)$/i.test(type)) return false;
  return IMAGE_EXT.test(file.name || '');
}

/** Already in a format every provider reads, at a sane size? Then leave it be. */
function needsWork(file) {
  if (RAW_EXT.test(file.name || '')) return true;
  if (!SAFE.test(file.type || '')) return true;              // includes the empty-type case
  return file.size > 3 * 1024 * 1024;                        // big photo → worth shrinking
}

/** Decode a File into something canvas-drawable, honouring EXIF orientation.
 *  Three attempts, because no single path covers every iPhone case:
 *    1. createImageBitmap with from-image orientation — fastest, off the main thread,
 *       but Safari has historically refused HEIC here.
 *    2. createImageBitmap without options — older Safari lacks the options argument.
 *    3. <img> + object URL — the reliable HEIC path, since HEIC is the OS format and
 *       WebKit can always render it into an element. iOS applies EXIF rotation itself. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    for (const opts of [{ imageOrientation: 'from-image' }, undefined]) {
      try { return await createImageBitmap(file, opts); } catch { /* next strategy */ }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('the browser could not render this file'));
      img.src = url;
    });
    if (img.decode) { try { await img.decode(); } catch { /* already loaded */ } }
    if (!img.naturalWidth) throw new Error('the browser decoded an empty image');
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Downscale to `longEdge` and re-encode as JPEG.
 * Resolves to { blob, name, width, height, converted } — or to null when this browser
 * cannot decode the file, which is the caller's signal to upload the original and let
 * the server try. Never throws for an undecodable image.
 */
export async function prepareImage(file, { longEdge = LONG_EDGE, quality = JPEG_QUALITY, force = false } = {}) {
  if (!file || !isImageFile(file)) return null;
  if (!force && !needsWork(file)) return null;

  let src;
  try { src = await decode(file); } catch { return null; }

  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) { src.close?.(); return null; }

  const scale = Math.min(1, longEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  try { ctx.drawImage(src, 0, 0, w, h); } catch { src.close?.(); return null; }
  src.close?.();

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  // Free the backing store immediately: on iOS Safari, canvases hold their memory until
  // GC gets round to them, and a batch of 12 photos is enough to be told off for it.
  canvas.width = canvas.height = 1;
  if (!blob) return null;

  return {
    blob, width: w, height: h,
    name: (file.name || 'photo').replace(/\.[^./\\]*$/, '') + '.jpg',
    converted: true,
  };
}

/** Human-readable reason a photo could not be prepared, for the phone's error card. */
export function undecodableHint(file) {
  const heic = /heic|heif/i.test(file?.name || '') || /heic|heif/i.test(file?.type || '');
  return heic
    ? 'This iPhone photo is in HEIC and this browser would not decode it. AIOS will try to '
      + 'convert it on the server; if that fails, set Settings → Camera → Formats to '
      + '"Most Compatible" and retake it.'
    : `Could not read ${file?.name || 'this file'} as an image in the browser — sending it to AIOS to convert.`;
}
