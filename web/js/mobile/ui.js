// Phone-shell primitives. Deliberately tiny and dependency-free.
//
// The desktop shell's ui.js is ~24KB of things a phone has no use for (menus at
// coordinates, resizable modals, hover affordances). Rather than import it and ship
// the weight, /m keeps its own small vocabulary — this file is the whole of it, and
// the receipts screen's private copies of el()/toast()/svg() were folded in here so
// there is exactly one of each.

// ---------- DOM ----------

export function el(tag, attrs = {}, ...kids) {
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

export const frag = (...kids) => { const f = document.createDocumentFragment(); f.append(...kids.flat(Infinity).filter(k => k != null && k !== false)); return f; };

/** Replace a node's children in one shot. */
export const fill = (node, ...kids) => { node.replaceChildren(); node.append(...kids.flat(Infinity).filter(k => k != null && k !== false)); return node; };

// ---------- icons ----------

export const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

export const ICONS = {
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M9.5 20v-6h5v6"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12z"/>'),
  money: svg('<rect x="2.5" y="6" width="19" height="12.5" rx="2.5"/><circle cx="12" cy="12.2" r="2.8"/><path d="M6 10v4.5M18 10v4.5"/>'),
  tasks: svg('<path d="M4 6.5h2M4 12h2M4 17.5h2"/><path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20"/>'),
  more: svg('<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  camera: svg('<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2a2 2 0 0 0 1.7-.95l.5-.8A2 2 0 0 1 10.6 3h2.8a2 2 0 0 1 1.7 1.25l.5.8A2 2 0 0 0 17.3 6h1.2A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.4"/>'),
  library: svg('<rect x="3" y="4" width="18" height="15" rx="2.5"/><path d="M3 15.5l4.5-4.2a2 2 0 0 1 2.7 0L15 15.5"/><circle cx="15.5" cy="8.5" r="1.6"/>'),
  mic: svg('<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3.5"/>'),
  send: svg('<path d="M4 12l16-8-5.5 16-3-6.5z"/>'),
  stop: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  note: svg('<path d="M6 3h8l4.5 4.5V21H6z"/><path d="M14 3v5h4.5"/><path d="M9 12.5h6M9 16.5h6"/>'),
  file: svg('<path d="M6 3h8l4.5 4.5V21H6z"/><path d="M14 3v5h4.5"/>'),
  folder: svg('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z"/>'),
  terminal: svg('<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>'),
  agent: svg('<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4"/><circle cx="9" cy="13" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.3" fill="currentColor" stroke="none"/>'),
  settings: svg('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1L5.3 5.3"/>'),
  remote: svg('<path d="M12 20.5v-6"/><circle cx="12" cy="12.5" r="2"/><path d="M8.5 9a5 5 0 0 1 7 0M5.5 5.8a9.5 9.5 0 0 1 13 0"/>'),
  refresh: svg('<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3.5V9h-5.5"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  weather: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.4 5.6l-1.4 1.4M7 17l-1.4 1.4M18.4 18.4L17 17M7 7L5.6 5.6"/>'),
  bell: svg('<path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5z"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/>'),
  trash: svg('<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5V20h11V6.5"/><path d="M10 10v6.5M14 10v6.5"/>'),
  cal: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  spark: svg('<path d="M12 3l2.2 5.9L20 11l-5.8 2.1L12 19l-2.2-5.9L4 11l5.8-2.1z"/>'),
};

export const icon = (name, cls = 'm-i') => el('span', { class: cls, html: ICONS[name] || '' });

// ---------- toast ----------

let toastTimer = null;
export function toast(msg, kind = '') {
  document.querySelector('.m-toast')?.remove();
  const node = el('div', { class: 'm-toast' + (kind ? ' is-' + kind : '') }, msg);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), kind === 'err' ? 5200 : 2600);
}

// ---------- sheet (bottom modal) ----------

/**
 * A bottom sheet. Returns { close }. Backdrop tap and the drag handle both close it,
 * because on a phone there is no Escape key and a modal with only an X button in the
 * corner is a reach across the whole screen.
 */
export function sheet(title, buildBody, { onClose } = {}) {
  const body = el('div', { class: 'm-sheet-body' });
  const panel = el('div', { class: 'm-sheet' },
    el('div', { class: 'm-sheet-grab' }),
    title ? el('div', { class: 'm-sheet-head' }, el('div', { class: 'm-sheet-title' }, title),
      el('button', { class: 'm-x', 'aria-label': 'Close', onclick: () => close() }, el('span', { html: ICONS.close }))) : null,
    body);
  const wrap = el('div', { class: 'm-sheet-wrap' }, panel);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.classList.add('is-out');
    setTimeout(() => wrap.remove(), 180);
    onClose?.();
  };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-in'));
  buildBody(body, close);
  return { close, body };
}

/** Confirm dialog as a sheet. Resolves true/false. */
export function confirmSheet(title, message, { ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const s = sheet(title, (body, close) => {
      body.append(
        el('p', { class: 'm-sheet-text' }, message),
        el('div', { class: 'm-actions' },
          el('button', { class: 'm-btn', onclick: () => { finish(false); close(); } }, 'Cancel'),
          el('button', { class: 'm-btn ' + (danger ? 'is-danger' : 'is-primary'), onclick: () => { finish(true); close(); } }, ok)),
      );
    }, { onClose: () => finish(false) });
    return s;
  });
}

/** Single-line text prompt as a sheet. Resolves the string, or null. */
export function askSheet(title, { placeholder = '', value = '', ok = 'Save', multiline = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    sheet(title, (body, close) => {
      const input = multiline
        ? el('textarea', { class: 'm-input m-textarea', placeholder, rows: 4 })
        : el('input', { class: 'm-input', placeholder, type: 'text', enterkeyhint: 'done' });
      input.value = value;
      if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { finish(input.value.trim()); close(); } });
      body.append(input, el('div', { class: 'm-actions' },
        el('button', { class: 'm-btn', onclick: () => { finish(null); close(); } }, 'Cancel'),
        el('button', { class: 'm-btn is-primary', onclick: () => { finish(input.value.trim()); close(); } }, ok)));
      setTimeout(() => input.focus(), 60);
    }, { onClose: () => finish(null) });
  });
}

// ---------- states ----------

export const spinner = (cls = '') => el('span', { class: 'm-spin ' + cls });

export const empty = (text, sub = '') => el('div', { class: 'm-empty' },
  el('div', { class: 'm-empty-text' }, text),
  sub ? el('div', { class: 'm-empty-sub' }, sub) : null);

export const loading = (text = 'Loading…') => el('div', { class: 'm-loading' }, spinner(), el('span', {}, text));

export const errorBox = (e, retry) => el('div', { class: 'm-errbox' },
  el('div', { class: 'm-errbox-text' }, typeof e === 'string' ? e : (e?.message || 'Something went wrong')),
  retry ? el('button', { class: 'm-btn-tiny', onclick: retry }, 'Retry') : null);

// ---------- formatting ----------

export const money = (n, cur = 'JPY') => {
  const v = Number(n || 0);
  // JPY has no minor unit; everything else gets two places. Intl would do this via
  // currency formatting, but that also prepends a symbol we don't always want.
  const frac = cur === 'JPY' || cur === 'KRW' ? 0 : 2;
  return `${cur} ${v.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
};

export const compactMoney = (n, cur = 'JPY') => {
  const v = Math.abs(Number(n || 0));
  if (v >= 1_000_000) return `${cur} ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${cur} ${Math.round(v / 1000)}k`;
  return money(n, cur);
};

export function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return 'a minute ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export const dayLabel = (isoDate) => {
  if (!isoDate) return '';
  const d = new Date(isoDate + (isoDate.length === 10 ? 'T12:00:00' : ''));
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- haptics ----------

/** A short tap of feedback where the platform allows it. iOS Safari ignores this
 *  (no Vibration API), so it must never be load-bearing — it is decoration. */
export const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { } };

// ---------- pull to refresh ----------

/**
 * Pull-to-refresh on a scroll container.
 *
 * Only engages when the container is already at the top AND the gesture is clearly
 * vertical, so it cannot steal a horizontal swipe from a chip row. `overscroll-behavior:
 * contain` in the CSS stops iOS's own rubber-band from fighting it.
 *
 * IDEMPOTENT PER ELEMENT, and that is load-bearing rather than tidiness. Screens
 * naturally call this twice — once while building the shell and again after the first
 * load replaces the container's children — and Settings calls its loader on every
 * Refresh tap. Attaching a fresh set of touch listeners each time meant one pull fired
 * N concurrent refreshes, growing for as long as the screen stayed open. Later calls
 * now only swap the handler and re-attach the indicator that `fill()` removed.
 */
export function pullToRefresh(scroller, onRefresh) {
  if (scroller.__ptr) {
    scroller.__ptr.handler = onRefresh;
    if (!scroller.__ptr.ind.isConnected) scroller.prepend(scroller.__ptr.ind);
    return;
  }
  let startY = 0, startX = 0, pulling = false, armed = false;
  const THRESHOLD = 64;
  const ind = el('div', { class: 'm-ptr' }, spinner());
  scroller.prepend(ind);
  scroller.__ptr = { ind, handler: onRefresh };

  const setPull = (px) => { ind.style.height = `${Math.min(px, 90)}px`; ind.classList.toggle('is-armed', px >= THRESHOLD); };

  scroller.addEventListener('touchstart', (e) => {
    if (scroller.scrollTop > 0 || e.touches.length !== 1) { pulling = false; return; }
    startY = e.touches[0].clientY; startX = e.touches[0].clientX;
    pulling = true; armed = false;
  }, { passive: true });

  scroller.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    const dx = Math.abs(e.touches[0].clientX - startX);
    if (dy <= 0 || dx > Math.abs(dy)) { pulling = false; setPull(0); return; }
    armed = dy >= THRESHOLD;
    setPull(dy * 0.5);
  }, { passive: true });

  let busy = false;
  const end = async () => {
    if (!pulling) return;
    pulling = false;
    if (!armed) return setPull(0);
    // A second pull while the first is still in flight would double-fetch and race the
    // two renders; on a flaky connection that is exactly when people pull again.
    if (busy) return setPull(0);
    busy = true;
    ind.classList.add('is-busy');
    setPull(46);
    try { await scroller.__ptr.handler(); } catch { /* the screen shows its own error */ }
    busy = false;
    ind.classList.remove('is-busy', 'is-armed');
    setPull(0);
  };
  scroller.addEventListener('touchend', end, { passive: true });
  scroller.addEventListener('touchcancel', end, { passive: true });
}

// ---------- misc ----------

/** Trailing-edge debounce, for search-as-you-type against the box. */
export function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Scroll a container to the bottom, tolerating the layout not having settled yet. */
export const toBottom = (node, smooth = false) => {
  if (!node) return;
  requestAnimationFrame(() => node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }));
};

/** True when the container is close enough to the bottom that auto-scroll is wanted. */
export const atBottom = (node, slack = 80) => !node || node.scrollHeight - node.scrollTop - node.clientHeight < slack;
