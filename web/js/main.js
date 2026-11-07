// AIOS boot: theme, apps, dock, topbar, command palette, auth.

import { setToken, post } from './api.js';
import { el, icons, icon, modal, toast, menu, fuzzy, askText } from './ui.js';
import { registerApp, renderDock, openApp, apps } from './wm.js';
import { state, refreshConfig, refreshProjects, refreshStatus, setProject, on } from './state.js';
import { startMatrix, stopMatrix } from './matrix.js';
import { applyPalette } from './themes.js';

import dashboard from './apps/dashboard.js';
import chat from './apps/chat.js';
import agent from './apps/agent.js';
import research from './apps/research.js';
import files from './apps/files.js';
import terminal from './apps/terminal.js';
import projectsApp from './apps/projects.js';
import githubApp from './apps/github.js';
import studio from './apps/studio.js';
import vault from './apps/vault.js';
import learn from './apps/learn.js';
import interviewApp from './apps/interview.js';
import benchApp from './apps/bench.js';
import modelsApp from './apps/models.js';
import planner from './apps/planner.js';
import finance from './apps/finance.js';
import settings from './apps/settings.js';

window.aios = { open: openApp };

// ---------- appearance ----------

// The theme registry moved to themes.js so the phone shell at /m can share it.
// Re-exported here because settings.js and others import it from main.js.
export { THEMES, themeByName } from './themes.js';

let curWallpaper = null;
function applyWallpaper(kind) {
  kind = kind || 'aurora';
  const wp = document.getElementById('wallpaper');
  wp.className = 'wp-' + kind;
  if (kind === curWallpaper) return;          // class refreshed; canvas lifecycle unchanged
  curWallpaper = kind;
  if (kind === 'matrix') startMatrix(wp); else stopMatrix();
}

export function applyAppearance(a = state.config?.appearance || {}) {
  const dark = applyPalette(a);
  applyWallpaper(a.wallpaper);
  const tb = document.getElementById('tb-theme');
  if (tb) tb.innerHTML = dark ? icons.sun : icons.moon;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance());

// ---------- auth ----------

document.addEventListener('aios:unauthorized', async () => {
  if (document.querySelector('.modal-overlay')) return;
  const t = await askText({
    title: 'Pair this device',
    sub: 'Enter the AIOS token shown in the server console (or open the LAN link that includes ?token=…).',
    placeholder: 'pairing token', ok: 'Connect',
  });
  if (t) { setToken(t); location.reload(); }
});

// ---------- topbar ----------

function initTopbar() {
  const clock = document.getElementById('tb-clock');
  const tick = () => clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  tick(); setInterval(tick, 20000);

  document.getElementById('tb-theme').addEventListener('click', async () => {
    // quick light↔dark base toggle (full themes live in Settings → Appearance)
    const next = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
    state.config.appearance.theme = next;
    applyAppearance();
    try { await putConfig({ appearance: { theme: next } }); } catch { }
  });

  document.getElementById('tb-palette').addEventListener('click', openPalette);

  const projBtn = document.getElementById('tb-project');
  projBtn.addEventListener('click', () => {
    const items = state.projects.map(p => ({
      label: (state.project?.id === p.id ? '✓ ' : '') + p.name,
      icon: 'folder',
      onclick: () => setProject(p.id),
    }));
    items.push('-', { label: 'Manage projects…', icon: 'projects', onclick: () => openApp('projects') });
    const r = projBtn.getBoundingClientRect();
    menu(r.left, r.bottom + 6, items);
  });

  on('project', () => renderProjectName());
  on('projects', () => renderProjectName());
  renderProjectName();

  on('status', () => {
    const s = state.status;
    const box = document.getElementById('tb-provider');
    box.innerHTML = '';
    if (!s) return;
    const any = s.providers.anthropic.configured || s.providers.ollama.up || s.providers.custom.some(c => c.up);
    const dot = el('span', { class: 'pdot ' + (any ? 'up' : 'warn') });
    box.title = `Anthropic: ${s.providers.anthropic.configured ? 'key set' : 'no key'} · Ollama: ${s.providers.ollama.up ? s.providers.ollama.models + ' models' : 'offline'}`;
    box.append(dot);
  });
}

async function putConfig(patch) {
  const { put } = await import('./api.js');
  state.config = await put('/config', patch);
}

function renderProjectName() {
  document.getElementById('tb-project-name').textContent = state.project ? state.project.name : 'no project';
}

// ---------- command palette ----------

let palOpen = false;
function openPalette() {
  if (palOpen) return;
  palOpen = true;
  const input = el('input', { class: 'pal-input', placeholder: 'Search apps, projects, notes, actions…' });
  const list = el('div', { class: 'pal-list' });
  const overlay = el('div', { class: 'palette-overlay' }, el('div', { class: 'palette' }, input, list));
  document.body.append(overlay);
  input.focus();

  let sel = 0, items = [];
  const close = () => { overlay.remove(); palOpen = false; };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

  const staticCmds = () => [
    ...apps().map(a => ({ group: 'Apps', label: 'Open ' + a.title, icon: a.icon, run: () => openApp(a.id) })),
    ...state.projects.map(p => ({ group: 'Projects', label: 'Switch to ' + p.name, icon: 'folder', run: () => setProject(p.id) })),
    { group: 'Actions', label: 'New chat', icon: 'chat', run: () => openApp('chat', { fresh: true }) },
    { group: 'Actions', label: 'Voice mode — talk to AIOS', icon: 'waveform', run: () => import('./voicemode.js').then(m => m.openVoiceMode()) },
    {
      group: 'Actions', label: 'Practice interview — hands-free', icon: 'briefcase',
      run: () => import('./interview.js').then(async (iv) => {
        const cfg = await iv.setupDialog({ config: { ...iv.savedConfig(), mode: 'interview' } });
        if (cfg) (await import('./voicemode.js')).openVoiceMode({ config: cfg });
      }),
    },
    { group: 'Actions', label: 'New agent session', icon: 'agent', run: () => openApp('agent', { fresh: true }) },
    { group: 'Actions', label: 'New deep research', icon: 'research', run: () => openApp('research', { fresh: true }) },
    { group: 'Actions', label: 'Today\'s agenda', icon: 'daily', run: () => openApp('planner') },
    { group: 'Actions', label: 'Learning corner', icon: 'learn', run: () => openApp('learn') },
    { group: 'Actions', label: 'Benchmark models', icon: 'graph', run: () => openApp('bench') },
    { group: 'Actions', label: 'Model routing & serving', icon: 'cpu', run: () => openApp('models') },
    { group: 'Actions', label: 'Agent tools & web search', icon: 'wrench', run: () => openApp('settings', { tab: 'tools' }) },
    { group: 'Actions', label: 'Toggle theme', icon: 'moon', run: () => document.getElementById('tb-theme').click() },
  ];

  let vaultHits = [];
  let vaultTimer = null;

  const render = () => {
    const q = input.value.trim();
    let cmds = staticCmds();
    if (q) {
      cmds = cmds.map(c => ({ ...c, score: fuzzy(q, c.label) })).filter(c => c.score > 0).sort((a, b) => b.score - a.score);
      for (const h of vaultHits) cmds.push({ group: 'Vault notes', label: h.title, hint: h.folder, icon: 'vault', run: () => openApp('vault', { note: h.path }) });
    }
    items = cmds.slice(0, 14);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = '';
    let lastGroup = null;
    items.forEach((c, i) => {
      if (c.group !== lastGroup) { list.append(el('div', { class: 'pal-group' }, c.group)); lastGroup = c.group; }
      const it = el('div', { class: 'pal-item' + (i === sel ? ' sel' : ''), onclick: () => { close(); c.run(); } });
      it.append(icon(c.icon || 'chevR'), el('span', { class: 'pal-label' }, c.label));
      if (c.hint) it.append(el('span', { class: 'pal-hint' }, c.hint));
      it.addEventListener('mousemove', () => { sel = i; render(); });
      list.append(it);
    });
    if (!items.length) list.append(el('div', { class: 'empty', style: { minHeight: '70px' } }, 'nothing matches'));
  };

  input.addEventListener('input', () => {
    sel = 0;
    render();
    clearTimeout(vaultTimer);
    const q = input.value.trim();
    if (q.length > 2 && state.config?.vault?.path) {
      vaultTimer = setTimeout(async () => {
        try {
          const { get } = await import('./api.js');
          vaultHits = (await get('/vault/search?q=' + encodeURIComponent(q))).slice(0, 5);
        } catch { vaultHits = []; }
        render();
      }, 220);
    } else vaultHits = [];
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === 'Enter' && items[sel]) { close(); items[sel].run(); }
  });
  render();
}


document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
});

// ---------- boot ----------

async function boot() {
  registerApp(dashboard);
  registerApp(chat);
  registerApp(agent);
  registerApp(research);
  registerApp(files);
  registerApp(terminal);
  registerApp(projectsApp);
  registerApp(githubApp);
  registerApp(studio);
  registerApp(vault);
  registerApp(learn);
  registerApp(interviewApp);
  registerApp(benchApp);
  registerApp(modelsApp);
  registerApp(planner);
  registerApp(finance);
  registerApp(settings);
  // Registered ≠ docked. Bench and Files stay registered (and stay in the command
  // palette) but are not top-level destinations: Bench is something you do TO a model,
  // so it opens from the Models header, and Files is per-project, so it opens from the
  // row of the project you want. Both were dock icons pressed about once a month.
  renderDock(['home', '|', 'chat', 'agent', 'research', '|', 'planner', 'finance', 'github', 'studio', 'vault', 'learn', 'interview', 'models', '|', 'terminal', 'projects', '|', 'settings']);

  // PWA: installable from the pairing link; the SW is a plain passthrough
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });

  // mobile: hamburger toggles the active app's side panel as an overlay
  const menuBtn = document.getElementById('tb-menu');
  menuBtn?.addEventListener('click', () => document.body.classList.toggle('show-side'));
  document.getElementById('views')?.addEventListener('click', (e) => {
    if (document.body.classList.contains('show-side') && !e.target.closest('.side, .set-nav')) {
      document.body.classList.remove('show-side');
    }
  });
  initTopbar();

  try {
    await refreshConfig();
    applyAppearance();
    await refreshProjects();
  } catch (e) {
    applyAppearance({});
    console.warn('boot: ', e.message);
  }
  refreshStatus();
  setInterval(refreshStatus, 60000);

  openApp('home');
}

boot();
