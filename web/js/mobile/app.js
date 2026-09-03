// The phone shell at /m.
//
// This used to be one screen (receipt capture). It is now the whole hub in a
// phone-shaped form: a tab bar, a screen registry, and a router — with every screen
// talking to the same REST + WebSocket API the desktop uses, so there is no second
// backend to keep in step.
//
// It still shares nothing with the desktop shell but theme.css, api.js, themes.js and
// imageprep.js. That isolation is the reason this file can be opinionated about
// layout without any risk of moving a desktop pixel.
//
// Screens are lazily imported. The first paint should not pay for the terminal
// emulator or the chat markdown renderer, and on a phone over a tailnet that
// difference is felt.

import { get, setToken } from '../api.js';
import { applyPalette } from '../themes.js';
import { el, fill, icon, toast, sheet, ICONS, loading, errorBox } from './ui.js';

// ---------- screen registry ----------
//
// `tab: true` puts it in the bottom bar. Everything else is reachable from More.
// The order here is the order in both places.

const SCREENS = [
  { id: 'home', title: 'Home', icon: 'home', tab: true, load: () => import('./screens/home.js') },
  { id: 'chat', title: 'Chat', icon: 'chat', tab: true, load: () => import('./screens/chat.js') },
  { id: 'money', title: 'Money', icon: 'money', tab: true, load: () => import('./screens/money.js') },
  { id: 'tasks', title: 'Tasks', icon: 'tasks', tab: true, load: () => import('./screens/tasks.js') },

  { id: 'notes', title: 'Notes', icon: 'note', desc: 'Search and read your second brain', load: () => import('./screens/notes.js') },
  { id: 'files', title: 'Files', icon: 'folder', desc: 'Browse the box’s filesystem', load: () => import('./screens/files.js') },
  { id: 'agent', title: 'Agent', icon: 'agent', desc: 'Coding sessions and approvals', load: () => import('./screens/agent.js') },
  { id: 'terminal', title: 'Terminal', icon: 'terminal', desc: 'A shell on the box', load: () => import('./screens/terminal.js') },
  { id: 'settings', title: 'Settings', icon: 'settings', desc: 'Remote access, theme, models', load: () => import('./screens/settings.js') },
];

export const screenById = (id) => SCREENS.find(s => s.id === id);
export const allScreens = () => SCREENS;

// ---------- app state ----------

export const state = {
  config: null,
  status: null,
  screen: null,
  online: navigator.onLine,
  wsUp: false,
};

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt)?.delete(fn);
}
export function emit(evt, data) { for (const fn of listeners.get(evt) || []) { try { fn(data); } catch (e) { console.error(e); } } }

// ---------- DOM skeleton ----------

const root = document.getElementById('m-app');

const headTitle = el('h1', { class: 'm-title' });
const headSub = el('div', { class: 'm-sub' });
const headDot = el('span', { class: 'm-dot' });
const headLeft = el('div', { class: 'm-head-left' });
const headRight = el('div', { class: 'm-head-right' });

const head = el('header', { class: 'm-head' },
  el('div', { class: 'm-head-row' },
    headLeft,
    el('div', { class: 'm-grow' }, headTitle, headSub),
    headRight,
    headDot));

const stage = el('main', { class: 'm-stage' });
const tabbar = el('nav', { class: 'm-tabs' });

root.append(head, stage, tabbar);

// ---------- header API (screens drive this) ----------

export const ui = {
  setTitle(t, sub = '') { headTitle.textContent = t; headSub.textContent = sub; headSub.style.display = sub ? '' : 'none'; },
  /** Left slot: normally empty (the tab bar is the nav), a Back button on a pushed screen. */
  setLeft(...nodes) { fill(headLeft, ...nodes); },
  /** Right slot: per-screen actions. */
  setActions(...nodes) { fill(headRight, ...nodes); },
  action(iconName, label, onclick) {
    return el('button', { class: 'm-head-btn', 'aria-label': label, title: label, onclick }, el('span', { html: ICONS[iconName] || '' }));
  },
};

function setConnDot() {
  const up = state.online && state.wsUp;
  headDot.className = 'm-dot ' + (up ? 'is-up' : state.online ? 'is-warn' : 'is-down');
  headDot.title = up ? 'Connected' : state.online ? 'Reconnecting…' : 'Offline';
}

// ---------- router ----------
//
// One screen is mounted at a time. Unlike the desktop's wm.js — which keeps every app
// alive because switching is cheap on a laptop — a phone's memory budget is smaller and
// the screens here are cheap to rebuild, so a switch tears down and remounts. Screens
// that own something expensive (a terminal, a live chat stream) get told via unmount()
// and are responsible for releasing it.

let current = null;      // { def, mod, api }
let navToken = 0;

export async function go(id, params = {}, { replace = false } = {}) {
  const def = screenById(id) || SCREENS[0];
  const token = ++navToken;

  if (current) {
    try { current.api?.unmount?.(); } catch (e) { console.error(e); }
    current = null;
  }

  state.screen = def.id;
  ui.setLeft();
  ui.setActions();
  ui.setTitle(def.title);
  renderTabs();
  fill(stage, loading());

  let mod;
  try {
    mod = await def.load();
  } catch (e) {
    if (token !== navToken) return;
    fill(stage, errorBox(`Could not load ${def.title}: ${e.message}`, () => go(id, params)));
    return;
  }
  if (token !== navToken) return;   // the user tapped something else while we loaded

  const host = el('div', { class: 'm-screen', 'data-screen': def.id });
  fill(stage, host);

  try {
    const api = await mod.default({ host, params, ui, go, state });
    if (token !== navToken) { try { api?.unmount?.(); } catch { } return; }
    current = { def, mod, api };
  } catch (e) {
    if (token !== navToken) return;
    console.error(e);
    fill(stage, errorBox(e, () => go(id, params)));
  }

  const url = `#${def.id}` + (Object.keys(params).length ? '?' + new URLSearchParams(params) : '');
  if (replace) history.replaceState({ id: def.id, params }, '', url);
  else if (location.hash !== url) history.pushState({ id: def.id, params }, '', url);

  emit('screen', def.id);
}

/** Push a sub-screen and give it a Back button that returns here. */
export function pushBack(label, onBack) {
  ui.setLeft(el('button', { class: 'm-head-btn', 'aria-label': label || 'Back', onclick: onBack },
    el('span', { html: ICONS.back })));
}

window.addEventListener('popstate', (e) => {
  const id = e.state?.id || (location.hash || '#home').slice(1).split('?')[0];
  go(id, e.state?.params || {}, { replace: true });
});

// ---------- tab bar ----------

function renderTabs() {
  const tabs = SCREENS.filter(s => s.tab);
  fill(tabbar, ...tabs.map(s => el('button', {
    class: 'm-tab' + (state.screen === s.id ? ' is-on' : ''),
    'aria-label': s.title,
    'aria-current': state.screen === s.id ? 'page' : null,
    onclick: () => go(s.id),
  }, icon(s.icon, 'm-tab-i'), el('span', { class: 'm-tab-l' }, s.title))),
    el('button', {
      class: 'm-tab' + (!tabs.some(t => t.id === state.screen) ? ' is-on' : ''),
      'aria-label': 'More',
      onclick: openMore,
    }, icon('more', 'm-tab-i'), el('span', { class: 'm-tab-l' }, 'More')));
}

function openMore() {
  sheet('More', (body, close) => {
    const rest = SCREENS.filter(s => !s.tab);
    body.append(el('div', { class: 'm-menu' }, ...rest.map(s => el('button', {
      class: 'm-menu-row' + (state.screen === s.id ? ' is-on' : ''),
      onclick: () => { close(); go(s.id); },
    },
      icon(s.icon, 'm-menu-i'),
      el('div', { class: 'm-grow' },
        el('div', { class: 'm-menu-t' }, s.title),
        s.desc ? el('div', { class: 'm-menu-d' }, s.desc) : null),
    ))));
  });
}

// ---------- pairing ----------
//
// A 401 anywhere raises aios:unauthorized (api.js). On the phone the token normally
// arrives in the link, so this is the fallback for a hand-typed URL or a cleared
// browser — and the place a lockout has to be explained, since a phone that keeps
// retrying a stale token now gets a 429 rather than a silent failure.

let pairingOpen = false;
document.addEventListener('aios:unauthorized', () => {
  if (pairingOpen) return;
  pairingOpen = true;
  sheet('Pair this phone', (body, close) => {
    const input = el('input', { class: 'm-input', type: 'text', placeholder: 'pairing token', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    body.append(
      el('p', { class: 'm-sheet-text' },
        'This phone is not paired with your hub. Open the link AIOS printed at boot — it carries the token — or paste the token here.'),
      input,
      el('div', { class: 'm-actions' },
        el('button', { class: 'm-btn is-primary', onclick: () => {
          const t = input.value.trim();
          if (!t) return;
          setToken(t);
          close();
          location.reload();
        } }, 'Connect')),
    );
    setTimeout(() => input.focus(), 80);
  }, { onClose: () => { pairingOpen = false; } });
});

// ---------- boot ----------

async function boot() {
  // Theme before anything paints, so there is no light flash on a dark phone.
  applyPalette({ theme: 'system' });

  window.addEventListener('online', () => { state.online = true; setConnDot(); emit('net', true); });
  window.addEventListener('offline', () => { state.online = false; setConnDot(); emit('net', false); });
  document.addEventListener('aios:ws', (e) => { state.wsUp = !!e.detail?.up; setConnDot(); emit('ws', state.wsUp); });
  setConnDot();

  try {
    state.config = await get('/config');
    const dark = applyPalette(state.config.appearance || {});
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#262624' : '#efede4');
  } catch {
    // Unauthorized or offline: the pairing sheet or the screen's own error covers it.
  }

  // Refresh /status in the background — Home wants it, and nothing should block on it.
  get('/status').then(s => { state.status = s; emit('status', s); }).catch(() => { });

  const hash = (location.hash || '#home').slice(1);
  const [id, qs] = hash.split('?');
  go(screenById(id) ? id : 'home', Object.fromEntries(new URLSearchParams(qs || '')), { replace: true });
}

boot();

// The service worker is a no-op passthrough today (web/sw.js). Registering it anyway is
// what makes iOS treat /m as installable, which is the whole point of the HTTPS work.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { });
}
