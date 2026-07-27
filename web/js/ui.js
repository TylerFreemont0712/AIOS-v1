// Tiny UI kit: element builder, inline icon set, modals, menus, toasts, misc helpers.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && k !== 'list' && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const I = (paths, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const icons = {
  home: I('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>'),
  chat: I('<path d="M21 12a8 8 0 0 1-8 8H4l2.2-2.6A8 8 0 1 1 21 12z"/>'),
  agent: I('<rect x="4" y="7" width="16" height="13" rx="2.5"/><path d="M12 7V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="12.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="12.5" r="1.1" fill="currentColor" stroke="none"/><path d="M9 16.5h6"/>'),
  files: I('<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4L12 7h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
  file: I('<path d="M6 2.5h8L20 8.5v13h-14z"/><path d="M13.5 3v6h6"/>'),
  terminal: I('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9 3 3-3 3"/><path d="M12.5 15H17"/>'),
  projects: I('<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>'),
  vault: I('<path d="M4 19.5V6a2 2 0 0 1 2-2h13.5v14H6a2 2 0 0 0-2 2z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H19.5v-4"/><path d="M9 8h7M9 11.5h5"/>'),
  learn: I('<path d="M12 4 2.5 8.5 12 13l9.5-4.5z"/><path d="M6.2 10.8V16c0 1.5 2.6 2.9 5.8 2.9s5.8-1.4 5.8-2.9v-5.2"/><path d="M21.5 8.5V14"/>'),
  settings: I('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>'),
  folder: I('<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4L12 7h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  x: I('<path d="M6 6l12 12M18 6 6 18"/>'),
  check: I('<path d="M4 12.5 9.5 18 20 6.5"/>'),
  chevR: I('<path d="m9 5 7 7-7 7"/>'),
  chevD: I('<path d="m5 9 7 7 7-7"/>'),
  send: I('<path d="M4 12 20 4l-4.5 16-4-6.5z"/><path d="M11.5 13.5 20 4"/>'),
  stop: I('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>'),
  trash: I('<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13.5h9l1-13.5"/><path d="M10 11v6M14 11v6"/>'),
  edit: I('<path d="M4 20h4.5L20 8.5a2.1 2.1 0 0 0-3-3L5.5 17z"/><path d="m14.5 8 3 3"/>'),
  refresh: I('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 3v4h-4"/>'),
  search: I('<circle cx="11" cy="11" r="6.5"/><path d="m20.5 20.5-4.9-4.9"/>'),
  play: I('<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>'),
  sparkle: I('<path d="M12 3.5 13.8 9 19.5 11l-5.7 2-1.8 5.5L10.2 13 4.5 11l5.7-2z"/>'),
  sun: I('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4m0 14.2v2.4M4.6 4.6l1.7 1.7m11.4 11.4 1.7 1.7M2.5 12h2.4m14.2 0h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/>'),
  moon: I('<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/>'),
  save: I('<path d="M5 3.5h11L20.5 8v12.5h-15z"/><path d="M8 3.5V9h7V3.5M8 20v-6h8v6"/>'),
  eye: I('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  code: I('<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>'),
  graph: I('<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="8" r="2.2"/><circle cx="9" cy="18" r="2.2"/><path d="M8 7.2 15.8 8M7 16.2 6.5 8.2M10.8 16.8 16.5 9.7"/>'),
  daily: I('<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M8 2.5V7M16 2.5V7M3.5 10.5h17"/>'),
  git: I('<circle cx="6" cy="6" r="2.3"/><circle cx="6" cy="18" r="2.3"/><circle cx="18" cy="12" r="2.3"/><path d="M6 8.3v7.4M8.3 6.6c4 1 7.5 2.6 7.5 5.4"/>'),
  github: I('<path fill="currentColor" stroke="none" d="M12 1C5.923 1 1 5.923 1 12c0 4.867 3.149 8.979 7.521 10.436.55.096.756-.233.756-.522 0-.262-.013-1.128-.013-2.049-2.764.509-3.479-.674-3.699-1.292-.124-.317-.66-1.293-1.127-1.554-.385-.207-.936-.715-.014-.729.866-.014 1.485.797 1.691 1.128.99 1.663 2.571 1.196 3.204.907.096-.715.385-1.196.701-1.471-2.448-.275-5.005-1.224-5.005-5.432 0-1.196.426-2.186 1.128-2.956-.111-.275-.496-1.402.11-2.915 0 0 .921-.288 3.024 1.128a10.19 10.19 0 0 1 2.75-.371c.936 0 1.871.123 2.75.371 2.104-1.43 3.025-1.128 3.025-1.128.605 1.513.221 2.64.111 2.915.701.77 1.127 1.746 1.127 2.956 0 4.222-2.571 5.157-5.019 5.432.399.344.743 1.004.743 2.035 0 1.471-.014 2.654-.014 3.025 0 .289.206.632.756.522C19.851 20.979 23 16.854 23 12c0-6.077-4.923-11-11-11Z"/>'),
  star: I('<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z"/>'),
  wand: I('<path d="m5 19 10-10"/><path d="M15.5 4.5 16.6 2l1.1 2.5L20.2 5.6l-2.5 1.1L16.6 9.2l-1.1-2.5L13 5.6z"/><path d="m4 8 .8-1.8L6.6 5.4 4.8 4.6 4 2.8 3.2 4.6 1.4 5.4l1.8.8z" transform="translate(2,4)"/>'),
  expand: I('<path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6"/>'),
  network: I('<rect x="9" y="2.5" width="6" height="5" rx="1.2"/><rect x="2.5" y="16.5" width="6" height="5" rx="1.2"/><rect x="15.5" y="16.5" width="6" height="5" rx="1.2"/><path d="M12 7.5v4m0 0H5.5v5m6.5-5h6.5v5"/>'),
  key: I('<circle cx="8" cy="14.5" r="4.5"/><path d="m11.5 11.5 8-8M16 7l2.5 2.5M13.5 9.5 16 12"/>'),
  user: I('<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>'),
  download: I('<path d="M12 3.5v11m0 0 4-4m-4 4-4-4"/><path d="M4 17v3.5h16V17"/>'),
  cpu: I('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M12 2.5V6m0 12v3.5M2.5 12H6m12 0h3.5M8 2.5V6m8-3.5V6M8 18v3.5M16 18v3.5M2.5 8H6m-3.5 8H6M18 8h3.5M18 16h3.5"/>'),
  globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13.6 13.6 0 0 1 4 9 13.6 13.6 0 0 1-4 9 13.6 13.6 0 0 1-4-9 13.6 13.6 0 0 1 4-9z"/>'),
  research: I('<circle cx="11" cy="11" r="6.8"/><path d="m20.5 20.5-4.8-4.8"/><path d="M11 7.6l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9z" fill="currentColor" stroke="none"/>'),
  wrench: I('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/>'),
  shield: I('<path d="M12 2.5 4.5 5.4v6.1c0 4.7 3.1 8.1 7.5 10 4.4-1.9 7.5-5.3 7.5-10V5.4z"/><path d="m8.8 12 2.3 2.3 4.1-4.5"/>'),
  briefcase: I('<rect x="3" y="7.5" width="18" height="12.5" rx="2.2"/><path d="M8.5 7.5V5.6A2.1 2.1 0 0 1 10.6 3.5h2.8a2.1 2.1 0 0 1 2.1 2.1v1.9"/><path d="M3 12.5h18"/>'),
  external: I('<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
  paperclip: I('<path d="M20.5 11.5 12 20a5.4 5.4 0 0 1-7.6-7.6l8.4-8.4a3.6 3.6 0 0 1 5.1 5.1l-8.4 8.4a1.8 1.8 0 0 1-2.6-2.6l7.7-7.7"/>'),
  image: I('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.9"/><path d="m4 17 4.5-4.5 3.5 3.5L16 12l4 4.5"/>'),
};

export const icon = (name) => {
  const span = el('span', { class: 'ico', style: { display: 'inline-flex', width: '16px', height: '16px' } });
  span.innerHTML = icons[name] || icons.file;
  span.firstChild.style.width = '100%';
  span.firstChild.style.height = '100%';
  return span;
};

// ---------- toasts ----------

export function toast(msg, kind = '') {
  const t = el('div', { class: 'toast ' + kind }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, kind === 'err' ? 5200 : 2800);
}

// ---------- modals ----------

export function modal({ title, sub, body, actions, wide, xl }) {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'modal-overlay' });
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    const box = el('div', { class: 'modal' + (xl ? ' xl' : wide ? ' wide' : '') },
      title && el('div', { class: 'modal-title' }, title),
      sub && el('div', { class: 'modal-sub' }, sub),
      body,
      actions && el('div', { class: 'modal-actions' },
        ...actions.map(a => el('button', {
          class: 'btn ' + (a.kind || ''),
          onclick: () => { const v = a.value !== undefined ? a.value : a.label; if (a.onpick) { if (a.onpick(close) === false) return; } else close(v); },
        }, a.label))),
    );
    overlay.append(box);
    document.body.append(overlay);
    const esc = (e) => { if (e.key === 'Escape') { close(null); document.removeEventListener('keydown', esc); } };
    document.addEventListener('keydown', esc);
    box.querySelector('input,textarea,select,button')?.focus();
  });
}

export async function askText({ title, sub, placeholder, value = '', multiline, ok = 'OK' }) {
  const input = multiline
    ? el('textarea', { class: 'input', placeholder, rows: 5 })
    : el('input', { class: 'input', placeholder });
  input.value = value;
  const p = modal({
    title, sub, body: el('div', { style: { marginTop: '8px' } }, input),
    actions: [{ label: 'Cancel', value: null }, { label: ok, kind: 'primary', onpick: (close) => close(input.value.trim() || null) }],
  });
  if (!multiline) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.closest('.modal').querySelector('.btn.primary').click(); }
  });
  setTimeout(() => { input.focus(); input.select(); }, 30);
  return p;
}

export function confirmBox(title, sub, okLabel = 'Delete', kind = 'danger') {
  return modal({
    title, sub,
    body: el('div'),
    actions: [{ label: 'Cancel', value: null }, { label: okLabel, kind, value: true }],
  });
}

// ---------- context menu ----------

export function menu(x, y, items) {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  const m = el('div', { class: 'ctx-menu' },
    ...items.map(it => it === '-' ? el('div', { class: 'ctx-sep' }) :
      el('button', { class: 'ctx-item ' + (it.danger ? 'danger' : ''), onclick: () => { m.remove(); it.onclick?.(); } },
        it.icon ? icon(it.icon) : null, it.label)));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
  return m;
}

// ---------- model picker ----------

import { get, mediaUrl } from './api.js';
import { isImageFile } from './imageprep.js';

let modelCache = null;
export async function fetchModels(force = false) {
  if (!modelCache || force) {
    try { modelCache = await get('/models'); } catch { modelCache = []; }
  }
  return modelCache;
}

/**
 * A pill that shows the current model and opens a chooser.
 * opts: { value, onchange(ref), storageKey }
 */
export function modelPicker(opts = {}) {
  let value = opts.value || (opts.storageKey && localStorage.getItem('aios.model.' + opts.storageKey)) || '';
  // allowEmpty: '' is a meaningful value (inherit whatever the default is) rather
  // than "nothing picked yet". Used by optional per-feature model overrides.
  const placeholder = opts.placeholder || (opts.allowEmpty ? 'default' : 'choose model');
  const nameSpan = el('span', { class: 'name' }, prettyModel(value) || placeholder);
  const pill = el('button', { class: 'model-pick', title: 'Choose model' }, icon('cpu'), nameSpan, icon('chevD'));

  pill.addEventListener('click', async (e) => {
    e.stopPropagation();
    const models = await fetchModels();
    const items = [];
    if (!models.length) items.push({ label: 'No models — configure a provider in Settings', onclick: () => window.aios?.open('settings', { tab: 'providers' }) });
    const byProv = {};
    for (const m of models) (byProv[m.provider] ||= []).push(m);
    for (const [prov, list] of Object.entries(byProv)) {
      items.push('-');
      items.push({ label: prov.toUpperCase(), onclick: () => { } });
      for (const m of list.slice(0, 24)) items.push({
        label: (m.ref === value ? '✓ ' : '') + m.label,
        onclick: () => setVal(m.ref),
      });
    }
    if (opts.allowEmpty) {
      items.unshift({ label: (value ? '' : '✓ ') + placeholder, onclick: () => setVal('') });
    }
    items.push('-');
    items.push({ label: 'Refresh model list', icon: 'refresh', onclick: async () => { await fetchModels(true); toast('models refreshed'); } });
    const r = pill.getBoundingClientRect();
    menu(r.left, r.bottom + 4, items);
  });

  function setVal(ref) {
    value = ref;
    nameSpan.textContent = prettyModel(ref) || placeholder;
    if (opts.storageKey) localStorage.setItem('aios.model.' + opts.storageKey, ref);
    opts.onchange?.(ref);
  }
  pill.getValue = () => value;
  pill.setValue = (ref) => { value = ref; nameSpan.textContent = prettyModel(ref) || placeholder; };

  // Default to the first available model instead of sitting on "choose model".
  // Also recovers if the stored ref points at a model that's no longer available.
  //
  // Skipped for allowEmpty pickers: there, empty is a real choice ("inherit the
  // default"), and auto-selecting would both misreport the setting and fire
  // onchange on mount — which for a settings panel means silently writing config
  // the moment the tab is opened.
  if (!opts.allowEmpty) {
    (async () => {
      const models = await fetchModels();
      if (!models.length) return;
      if (!value || !models.some(m => m.ref === value)) setVal(models[0].ref);
    })();
  }

  return pill;
}

export function prettyModel(ref) {
  if (!ref) return '';
  const i = ref.indexOf(':');
  return i < 0 ? ref : ref.slice(i + 1);
}

// ---------- misc ----------

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Throttle: fires at most once per `ms` but KEEPS firing during a continuous stream
// (unlike debounce, which would wait for a pause). Use for live token rendering so
// the answer streams smoothly instead of appearing all at once when the model stops.
export const throttle = (fn, ms) => {
  let last = 0, timer = null, lastArgs;
  return (...a) => {
    lastArgs = a;
    const now = performance.now();
    const run = () => { last = performance.now(); timer = null; fn(...lastArgs); };
    if (now - last >= ms) run();
    else if (!timer) timer = setTimeout(run, ms - (now - last));
  };
};

/** Generation-speed badge from a streamChat `perf` object. One implementation so
 *  chat, agent and research read identically. TTFT is shown separately because on
 *  local models it measures prompt PROCESSING, not generation — a slow ttft with
 *  healthy tok/s means the prompt is too big, not the model too weak. */
export function perfBadge(perf, { compact = false } = {}) {
  if (!perf?.tokS) return null;
  const ttft = perf.ttftMs >= 1000 ? `${(perf.ttftMs / 1000).toFixed(1)}s` : `${perf.ttftMs}ms`;
  const node = el('span', {
    class: 'perf-badge' + (perf.tokS >= 25 ? ' fast' : perf.tokS < 8 ? ' slow' : ''),
    title: `${perf.outTokens} tokens${perf.estimated ? ' (estimated — provider reported no usage)' : ''}`
      + `\n${ttft} to first token (prompt processing)`
      + `\n${((perf.totalMs || 0) / 1000).toFixed(1)}s total`
      + (perf.modelRef ? `\n${perf.modelRef}` : ''),
  }, `${perf.tokS} tok/s`);
  if (!compact) node.append(el('span', { class: 'perf-ttft' }, ` · ${ttft} ttft`));
  return node;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString();
}

export function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

export function fuzzy(needle, hay) {
  needle = needle.toLowerCase(); hay = hay.toLowerCase();
  if (hay.includes(needle)) return 100 - hay.indexOf(needle);
  let i = 0, score = 0;
  for (const c of hay) { if (c === needle[i]) { i++; score += 2; } }
  return i === needle.length ? score : 0;
}

// ---------- attachments ----------

/**
 * A pending-attachment tray for a composer. Holds the File objects the user picked,
 * dropped, or pasted; renders removable chips (image thumbnails inline); and hands the
 * files back on send. Upload to the server happens at send time via api.uploadFile.
 *   opts.onchange() — fired whenever the set changes (toggle the send button, etc.)
 */
export function attachTray(opts = {}) {
  const node = el('div', { class: 'att-tray', style: { display: 'none' } });
  let items = [];   // { file, url? }

  const render = () => {
    node.innerHTML = '';
    node.style.display = items.length ? '' : 'none';
    for (const it of items) {
      const isImg = !!it.url;
      const thumb = isImg
        ? el('img', { class: 'att-thumb', src: it.url })
        : el('span', { class: 'att-ico' }, icon('file'));
      node.append(el('div', { class: 'att-chip' + (isImg ? ' img' : '') },
        thumb,
        el('span', { class: 'att-name' }, it.file.name),
        el('span', { class: 'att-size' }, fmtBytes(it.file.size)),
        el('button', { class: 'att-x', title: 'Remove', onclick: () => remove(it) }, '×')));
    }
  };
  const remove = (it) => { items = items.filter(x => x !== it); if (it.url) URL.revokeObjectURL(it.url); render(); opts.onchange?.(); };

  return {
    node,
    add(files) {
      for (const f of files) {
        if (!f) continue;
        if (items.some(x => x.file.name === f.name && x.file.size === f.size)) continue;
        // isImageFile, not `type.startsWith('image/')`: an iPhone photo often arrives
        // with an EMPTY type, which used to show as a generic file chip with no preview.
        items.push({ file: f, url: isImageFile(f) ? URL.createObjectURL(f) : null });
      }
      render(); opts.onchange?.();
    },
    items: () => items.map(x => x.file),
    count: () => items.length,
    clear() { for (const it of items) if (it.url) URL.revokeObjectURL(it.url); items = []; render(); opts.onchange?.(); },
  };
}

/** Render stored message attachments (meta list) as clickable thumbnails / file chips. */
export function attachmentView(list) {
  if (!list?.length) return null;
  const wrap = el('div', { class: 'msg-atts' });
  for (const a of list) {
    const url = mediaUrl('/uploads/' + a.id);
    if (a.kind === 'image') {
      wrap.append(el('a', { class: 'att-chip img view', href: url, target: '_blank', rel: 'noopener' },
        el('img', { class: 'att-thumb', src: url, alt: a.name })));
    } else {
      wrap.append(el('a', { class: 'att-chip view', href: url, target: '_blank', rel: 'noopener', title: a.name },
        el('span', { class: 'att-ico' }, icon('file')),
        el('span', { class: 'att-name' }, a.name),
        el('span', { class: 'att-size' }, fmtBytes(a.size))));
    }
  }
  return wrap;
}

/**
 * Claude-style collapsible chain-of-thought panel. Expanded and streaming while
 * the model works ("Thinking…"), then auto-collapses when done ("Thought for Ns");
 * click the header to re-expand. Used by chat, agent, and research.
 *   opts.label     header text while live (default "Thinking")
 *   opts.body      an element to show instead of streamed text (research timeline)
 *   opts.collapsed start collapsed (for reloaded history)
 *   opts.doneLabel header text once done (default "Thought process")
 */
export function thinkingPanel(opts = {}) {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const bodyText = el('div', { class: 'think-text' });
  const bodyEl = opts.body || bodyText;
  const body = el('div', { class: 'think-body' }, bodyEl);
  const label = el('span', { class: 'think-label' }, opts.label || 'Thinking');
  const caret = el('span', { class: 'think-caret' }); caret.innerHTML = icons.chevD;
  const head = el('div', { class: 'think-head' },
    el('span', { class: 'think-spark' }, icon('sparkle')), label, el('span', { class: 'grow' }), caret);
  const node = el('div', { class: 'think' + (opts.collapsed ? '' : ' open') + (opts.collapsed ? '' : ' live') }, head, body);
  head.addEventListener('click', () => node.classList.toggle('open'));
  let live = !opts.collapsed;
  let buf = '';
  return {
    node,
    get live() { return live; },
    append(delta) {
      buf += delta;
      bodyText.textContent = buf;
      if (node.classList.contains('open')) body.scrollTop = body.scrollHeight;
    },
    setText(t) { buf = t; bodyText.textContent = t; },
    get text() { return buf; },
    done() {
      if (!live) return;
      live = false;
      node.classList.remove('open', 'live');
      const secs = Math.max(1, Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started) / 1000));
      label.textContent = opts.doneLabel || (buf || opts.body ? `Thought for ${secs}s` : 'Thought process');
    },
  };
}
