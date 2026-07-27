// Phone view: photograph receipts, let the AIOS box read them, file them under
// Finances. Served only at /m — the desktop shell never loads this.
//
// The iPhone-specific photo handling (HEIC, EXIF rotation, downscaling before upload)
// now lives in ../imageprep.js, shared with the desktop shell's attach points — the
// phone was the only place that got it right for a while, which is exactly why a
// receipt photographed from the desktop view used to fail. What stays here is the
// iOS *picker* handling, which is genuinely specific to this screen: see makePicker().

import { get, post, patch, setToken, uploadBlob } from '../api.js';
import { applyPalette } from '../themes.js';
import { IMAGE_ACCEPT, prepareImage, isImageFile, undecodableHint } from '../imageprep.js';

const MAX_BATCH = 12;        // server caps attachments at 12 per message

const app = document.getElementById('m-app');

const state = {
  currency: 'JPY',
  monthSpent: 0,
  categories: [],
  queue: [],            // { key, name, thumb, status, error, receipt }
  recent: [],
  appearance: null,
  online: null,
  seq: 0,
};

// ---------- tiny DOM helper (mobile.html loads no shared UI code) ----------

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    n.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return n;
}

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const ICON_CAMERA = svg('<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2a2 2 0 0 0 1.7-.95l.5-.8A2 2 0 0 1 10.6 3h2.8a2 2 0 0 1 1.7 1.25l.5.8A2 2 0 0 0 17.3 6h1.2A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.4"/>');
const ICON_LIBRARY = svg('<rect x="3" y="4" width="18" height="15" rx="2.5"/><path d="M3 15.5l4.5-4.2a2 2 0 0 1 2.7 0L15 15.5"/><circle cx="15.5" cy="8.5" r="1.6"/>');

let toastTimer = null;
function toast(msg, kind = '') {
  document.querySelector('.m-toast')?.remove();
  const node = el('div', { class: 'm-toast' + (kind ? ' is-' + kind : '') }, msg);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), kind === 'err' ? 5200 : 2600);
}

const money = (n) => `${state.currency} ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

// ---------- flow ----------

async function handleFiles(files) {
  if (!files.length) {
    // Never fail silently here again: an empty selection used to look exactly
    // like a working upload that did nothing.
    toast('No photo came back from the picker — try again', 'err');
    return;
  }
  if (files.length > MAX_BATCH) {
    toast(`Taking the first ${MAX_BATCH} of ${files.length} photos`, '');
    files.length = MAX_BATCH;
  }
  // Add every photo to the queue up front so the list shows the whole batch, then
  // process one at a time — the vision model serves one request anyway, and a
  // parallel burst would just fight over VRAM.
  const items = files.map((file) => {
    const item = { key: 'q' + (++state.seq), name: file.name || 'photo.jpg', file, thumb: '', status: 'waiting', error: '', receipt: null };
    state.queue.unshift(item);
    return item;
  });
  render();
  for (const item of items) await processOne(item);
  loadContext();
}

async function processOne(item) {
  const set = (status, extra = {}) => { Object.assign(item, { status, ...extra }); render(); };
  try {
    set('preparing');
    // A PDF or a video shared in from another app is not a receipt; say so before
    // spending a decode on it.
    if (!isImageFile(item.file)) {
      throw new Error(`${item.name} is${item.file.type ? ` a ${item.file.type},` : ''} not a photo. Receipts need an image.`);
    }
    // force: receipts are always worth downscaling, even a JPEG straight from the
    // camera — 1600px reads perfectly and uploads in a fraction of the time.
    const prepped = await prepareImage(item.file, { force: true });
    if (!prepped) toast(undecodableHint(item.file), '');    // ffmpeg on the box gets a turn
    const body = prepped ? prepped.blob : item.file;
    item.thumb = URL.createObjectURL(body);
    set('uploading');
    const up = await uploadBlob(body, prepped ? prepped.name : item.name);
    item.file = null;                                  // release the original
    set('reading');
    const rec = await post('/finance/receipts/scan', { uploadId: up.id });
    if (rec.status !== 'parsed') {
      set('failed', { error: rec.error || 'could not read that receipt', receipt: rec });
      return;
    }
    set('parsed', { receipt: rec, chosenCategory: rec.parsed?.category || '' });
  } catch (e) {
    set('failed', { error: e.message });
  }
}

async function applyReceipt(item, mode) {
  const rec = item.receipt;
  if (!rec) return;
  try {
    item.status = 'saving'; render();
    const overrides = item.chosenCategory && item.chosenCategory !== rec.parsed?.category
      ? { category: item.chosenCategory } : {};
    const res = await post(`/finance/receipts/${rec.id}/apply`, { mode, overrides });
    item.status = 'applied';
    item.savedCount = res.created.length;
    toast(`Added ${res.created.length} ${res.created.length === 1 ? 'entry' : 'entries'}`, 'ok');
    render();
    loadContext();
  } catch (e) {
    item.status = 'parsed';
    toast(e.message, 'err');
    render();
  }
}

// ---------- data ----------

/** Match the desktop's palette. Without this the phone renders whatever :root
 *  defaults to (light), which looks broken next to a dark AIOS. */
function paint(appearance) {
  const dark = applyPalette(appearance || {});
  // Keep the iOS status bar / theme-color in step with the resolved palette.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || (dark ? '#262624' : '#efede4'));
}

async function loadContext() {
  try {
    const [sum, cats, cfg] = await Promise.all([
      get('/finance/summary?range=this-month'),
      state.categories.length ? Promise.resolve(null) : get('/finance/categories'),
      state.appearance ? Promise.resolve(null) : get('/config').catch(() => null),
    ]);
    if (cfg?.appearance) { state.appearance = cfg.appearance; paint(cfg.appearance); }
    state.currency = sum.currency || state.currency;
    state.monthSpent = sum.spent;
    if (cats) state.categories = cats.expense || [];
    state.online = true;
  } catch (e) {
    state.online = false;
    if (/unauthor/i.test(e.message)) return renderPairing();
    toast(e.message, 'err');
  }
  render();
}

async function loadRecent() {
  try {
    const list = await get('/finance/receipts?limit=8');
    state.recent = list.filter(r => r.status === 'applied' || r.status === 'parsed');
    render();
  } catch { /* the header already shows the connection state */ }
}

// ---------- render ----------

const STATUS_TEXT = {
  waiting: 'Waiting…',
  preparing: 'Preparing the photo…',
  uploading: 'Sending to AIOS…',
  reading: 'Reading the receipt…',
  saving: 'Saving…',
};

function render() {
  if (!app) return;
  // Only the inner region scrolls, so preserve ITS offset — the document itself
  // is locked to the viewport.
  const scroller = app.querySelector('.m-scroll');
  const scroll = scroller ? scroller.scrollTop : 0;
  app.innerHTML = '';

  app.append(
    el('header', { class: 'm-head' },
      el('div', { class: 'm-head-row' },
        el('span', { class: 'm-title' }, 'Receipts'),
        el('span', { class: 'm-grow' }),
        el('span', {
          class: 'm-dot' + (state.online === true ? ' is-up' : state.online === false ? ' is-down' : ''),
          title: state.online ? 'Connected to AIOS' : 'Not connected',
        })),
      el('div', { class: 'm-sub' }, state.online === false
        ? 'Cannot reach AIOS — is it running on your network?'
        : `${money(state.monthSpent)} spent this month`)),

    captureBar(),

    el('div', { class: 'm-scroll' },
      state.queue.length
        ? el('section', { class: 'm-section' },
          el('h2', { class: 'm-section-title' }, 'This batch'),
          el('ul', { class: 'm-list' }, state.queue.map(queueCard)))
        : null,

      !state.queue.length && state.recent.length
        ? el('section', { class: 'm-section' },
          el('h2', { class: 'm-section-title' }, 'Recent'),
          el('ul', { class: 'm-list' }, state.recent.map(recentCard)))
        : null,

      !state.queue.length && !state.recent.length
        ? el('div', { class: 'm-empty' },
          'No receipts yet.',
          el('div', { class: 'm-empty-hint' },
            'Point your camera at a receipt. It is read on your own machine — the photo never leaves your network.'))
        : null,

      el('footer', { class: 'm-foot' },
        el('a', { href: '/?desktop=1' }, 'Open the full AIOS desktop →'))),
  );
  const next = app.querySelector('.m-scroll');
  if (next && scroll) next.scrollTop = scroll;
}

// The two file inputs are built ONCE and parked in <body>, deliberately outside
// #m-app. render() replaces the whole of #m-app, and an <input type=file> that is
// removed from the document while its picker is still open never fires `change` on
// iOS — which is how picking a photo used to appear to work and then do nothing.
//
// They are visually hidden rather than display:none, because some iOS versions
// refuse to open a picker for an input that is not laid out.
const HIDDEN = {
  position: 'fixed', left: '0', top: '0', width: '1px', height: '1px',
  opacity: '0', pointerEvents: 'none', zIndex: '-1',
};

function makePicker({ capture, multiple }) {
  const input = el('input', {
    // IMAGE_ACCEPT names the HEIC extensions explicitly: "image/*" alone does not
    // surface them in the Files/Browse branch of the iOS sheet, and photos shared in
    // from other apps often arrive with an empty MIME type.
    type: 'file', accept: IMAGE_ACCEPT,
    capture: capture ? 'environment' : null,
    multiple: multiple ? 'multiple' : null,
    style: HIDDEN,
  });
  input.addEventListener('change', () => {
    // Copy the FileList BEFORE resetting value — `input.files` is live, so
    // clearing value empties the very list we are about to read. That single
    // ordering mistake swallowed every upload.
    const files = Array.from(input.files || []);
    input.value = '';
    handleFiles(files);
  });
  document.body.append(input);
  return input;
}

const pickers = {
  camera: makePicker({ capture: true }),
  library: makePicker({ multiple: true }),
};

function captureBar() {
  const busy = state.queue.some(q => ['waiting', 'preparing', 'uploading', 'reading'].includes(q.status));
  const blocked = busy || state.online === false;

  return el('section', { class: 'm-capture' },
    el('button', {
      class: 'm-btn-big is-primary', disabled: blocked,
      onclick: () => pickers.camera.click(),
    }, el('span', { html: ICON_CAMERA }), busy ? 'Working…' : 'Take a photo'),
    el('button', {
      class: 'm-btn-big', disabled: blocked,
      onclick: () => pickers.library.click(),
    }, el('span', { html: ICON_LIBRARY }), 'Choose from library'),
    el('p', { class: 'm-hint' }, busy
      ? 'Reading — keep this screen open.'
      : `Several at once is fine, up to ${MAX_BATCH}.`),
  );
}

function queueCard(item) {
  const p = item.receipt?.parsed || {};
  const done = item.status === 'parsed' || item.status === 'applied';
  const pending = STATUS_TEXT[item.status];

  return el('li', { class: 'm-card' + (item.status === 'failed' ? ' is-failed' : '') + (item.status === 'applied' ? ' is-applied' : '') },
    item.thumb
      ? el('img', { class: 'm-thumb', src: item.thumb, alt: '' })
      : el('div', { class: 'm-thumb-ph' }, '▤'),
    el('div', { class: 'm-card-main' },
      el('div', { class: 'm-merchant' },
        done ? (p.merchant || 'Unnamed receipt') : item.status === 'failed' ? 'Could not read' : item.name),
      pending ? el('div', { class: 'm-status' }, el('span', { class: 'm-spin' }), pending) : null,
      item.error ? el('div', { class: 'm-err' }, item.error) : null,
      done
        ? el('div', {},
          el('div', { class: 'm-total' }, money(p.total)),
          el('div', { class: 'm-meta' },
            [p.date, p.paymentMethod, `${(p.items || []).length} item${(p.items || []).length === 1 ? '' : 's'}`]
              .filter(Boolean).join(' · ')),
          checkNote(p),
          (p.items || []).length ? el('ul', { class: 'm-items' },
            p.items.map((it, i) => el('li', { class: it.warn?.length ? 'is-suspect' : '' },
              el('span', {}, it.qty > 1 ? `${it.name} ×${it.qty}` : it.name),
              el('span', {}, Number(it.amount).toLocaleString('en-US')),
              // A phantom line is the common failure, and it has to be removable here:
              // the phone is where receipts get photographed, so it is where they get
              // corrected. The removal is what teaches the shop-specific fix.
              item.status === 'applied' ? null : el('button', {
                class: 'm-x', title: 'Not on the receipt',
                onclick: () => dropLine(item, i),
              }, '×')))) : null,
          item.status === 'applied'
            ? el('div', { class: 'm-meta' }, `Filed under ${item.chosenCategory || p.category} · ${item.savedCount} entr${item.savedCount === 1 ? 'y' : 'ies'}`)
            : el('div', {}, categoryChips(item, p), actions(item, p)))
        : null,
      item.status === 'failed'
        ? el('div', { class: 'm-actions' },
          el('button', { class: 'm-btn-ghost', onclick: () => { state.queue = state.queue.filter(q => q !== item); render(); } }, 'Dismiss'))
        : null),
  );
}

/** Do the lines add up? An invented line makes the sum overshoot by its own amount,
 *  which is the most actionable thing this screen can tell you. */
function checkNote(p) {
  const c = p.check;
  if (!c || c.ok !== false) return null;
  const amt = Math.abs(c.delta).toLocaleString('en-US');
  return el('div', { class: 'm-check' },
    c.delta > 0
      ? `The lines add up to ${amt} more than the receipt — one is probably not real. Remove it with ×.`
      : `The lines add up to ${amt} less than the receipt — one was missed.`);
}

/** Remove a line and save it, so the correction is recorded before applying. */
async function dropLine(item, index) {
  const p = item.receipt?.parsed;
  if (!p) return;
  const items = (p.items || []).filter((_, i) => i !== index);
  try {
    const updated = await patch(`/finance/receipts/${item.receipt.id}`, { ...p, items });
    item.receipt = updated;
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/** The model's category guess is usually right but not always; one tap fixes it
 *  before anything is written to the ledger. */
function categoryChips(item, p) {
  const chosen = item.chosenCategory || p.category || '';
  const list = [chosen, ...state.categories.filter(c => c !== chosen)].filter(Boolean).slice(0, 10);
  if (!list.length) return null;
  return el('div', { class: 'm-chips' }, list.map(c => el('button', {
    class: 'm-chip' + (c === chosen ? ' is-on' : ''),
    onclick: () => { item.chosenCategory = c; render(); },
  }, c)));
}

function actions(item, p) {
  const many = (p.items || []).length > 1;
  return el('div', { class: 'm-actions' },
    el('button', { class: 'm-btn is-primary', onclick: () => applyReceipt(item, 'total') },
      'Add ' + money(p.total)),
    many ? el('button', { class: 'm-btn', onclick: () => applyReceipt(item, 'items') },
      `Split ${p.items.length}`) : null);
}

function recentCard(r) {
  const p = r.parsed || {};
  return el('li', { class: 'm-card' + (r.status === 'applied' ? ' is-applied' : '') },
    r.uploadId
      ? el('img', { class: 'm-thumb', src: mediaSrc(`/uploads/${r.uploadId}`), alt: '', loading: 'lazy' })
      : el('div', { class: 'm-thumb-ph' }, '▤'),
    el('div', { class: 'm-card-main' },
      el('div', { class: 'm-merchant' }, p.merchant || 'Unnamed receipt'),
      el('div', { class: 'm-meta' }, [p.date, money(p.total), r.status === 'applied' ? 'filed' : 'not filed yet']
        .filter(Boolean).join(' · '))));
}

/** api.js keeps its token private, so rebuild the media URL from storage. */
function mediaSrc(p) {
  const t = localStorage.getItem('aios.token') || '';
  return '/api' + p + (t ? (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t) : '');
}

function renderPairing() {
  app.innerHTML = '';
  const input = el('input', {
    type: 'text', placeholder: 'pairing token', autocapitalize: 'off',
    autocorrect: 'off', spellcheck: 'false',
  });
  app.append(el('div', { class: 'm-pair' },
    el('h2', {}, 'Pair with AIOS'),
    el('p', {}, 'Open Settings on the desktop to copy the pairing token, or use the LAN link AIOS prints when it starts — that link carries the token for you.'),
    input,
    el('button', {
      class: 'm-btn-big is-primary',
      onclick: async () => {
        const v = input.value.trim();
        if (!v) return toast('Enter the token', 'err');
        setToken(v);
        state.online = null;
        await loadContext();
        if (state.online) { loadRecent(); toast('Paired', 'ok'); }
      },
    }, 'Connect')));
}

// ---------- boot ----------

document.addEventListener('aios:unauthorized', renderPairing);

// Follow the OS preference for the very first frame, then switch to the user's
// configured AIOS theme once /config comes back — otherwise the page flashes
// light on a dark phone.
paint({ theme: 'system' });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => paint(state.appearance));

// Paint the shell immediately — waiting on the first request means a blank screen
// for as long as the LAN round trip takes.
render();
loadContext().then(() => { if (state.online) loadRecent(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { });
}
