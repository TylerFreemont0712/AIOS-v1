// View manager: attached full-page views, one per app, switched via the dock,
// palette, or openApp(). Apps mount once and stay alive in the background when
// you switch away — terminals keep running, agent streams keep streaming.
// Right-click a dock icon to quit (unmount) an app.

import { el, icons, menu } from './ui.js';

const registry = new Map();   // appId -> app def
const views = new Map();      // appId -> view record (the old `win` contract)
let activeId = null;

const container = () => document.getElementById('views');

export function registerApp(app) { registry.set(app.id, app); }
export function apps() { return [...registry.values()]; }
export const activeApp = () => activeId;

export function openApp(appId, opts = {}) {
  const app = registry.get(appId);
  if (!app) return null;

  let v = views.get(appId);
  if (!v) {
    v = createView(app);
    views.set(appId, v);
    try { app.mount(v.body, opts, v); }
    catch (err) { console.error(err); v.body.append(el('div', { class: 'empty' }, 'app crashed: ' + err.message)); }
  } else {
    v.app.reopen?.(v, opts);
  }
  activate(appId);
  return v;
}

export function closeApp(appId) {
  const v = views.get(appId);
  if (!v) return;
  try { v.app.unmount?.(v); } catch (err) { console.error(err); }
  v.node.remove();
  views.delete(appId);
  renderDockState();
  if (activeId === appId) { activeId = null; openApp('home'); }
}

function createView(app) {
  const body = el('div', { class: 'page-body' });
  const node = el('section', { class: 'page', dataset: { app: app.id } }, body);
  container().append(node);
  const v = {
    appId: app.id, app, node, body, title: app.title,
    setTitle(t) { v.title = t || app.title; if (activeId === app.id) crumb(v.title); },
  };
  return v;
}

function activate(appId) {
  const v = views.get(appId);
  if (!v) return;
  if (activeId !== appId) {
    activeId = appId;
    for (const [id, view] of views) view.node.classList.toggle('active', id === appId);
  }
  crumb(v.title);
  renderDockState();
  requestAnimationFrame(() => v.app.resized?.(v));  // xterm/editors refit once visible
}

function crumb(title) {
  const node = document.getElementById('tb-view');
  if (node) node.textContent = title || '';
}

// ---------- dock ----------

export function renderDock(order) {
  const dock = document.getElementById('dock');
  dock.innerHTML = '';
  for (const id of order) {
    if (id === '|') { dock.append(el('div', { class: 'dock-sep' })); continue; }
    const app = registry.get(id);
    if (!app) continue;
    const btn = el('button', { class: 'dock-item', 'data-tip': app.title, dataset: { app: id } });
    btn.innerHTML = icons[app.icon] || icons.file;
    btn.append(el('span', { class: 'dot' }));
    btn.addEventListener('click', () => openApp(id));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!views.has(id)) return;
      menu(e.clientX, e.clientY - 46, [{ label: `Quit ${app.title}`, icon: 'x', onclick: () => closeApp(id) }]);
    });
    dock.append(btn);
  }
  renderDockState();
}

function renderDockState() {
  for (const btn of document.querySelectorAll('.dock-item')) {
    btn.classList.toggle('running', views.has(btn.dataset.app));
    btn.classList.toggle('open', btn.dataset.app === activeId);
  }
}

addEventListener('resize', () => {
  const v = views.get(activeId);
  v?.app.resized?.(v);
});
