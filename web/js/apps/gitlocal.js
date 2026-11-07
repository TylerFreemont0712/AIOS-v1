// GitHub tab → Local: every project folder on this machine at a glance (newest change
// first), and for any one of them the full workspace — staged/unstaged changes with
// per-file and per-hunk staging, a diff viewer, reviewed commits, history with a branch
// graph, branches, stashes, and fetch / pull / push with a preview of what will move.
// The shape follows the Git workspace in WorkHub (ui/git_widget.py); the server side is
// server/gitwork.js and server/repos.js.

import { el, icon, toast, modal, confirmBox, askText, menu, timeAgo } from '../ui.js';
import { get, post, mediaUrl } from '../api.js';
import { state, setProject, refreshProjects } from '../state.js';
import { openApp } from '../wm.js';
import { parseDiff, splitPatch, renderDiff, layoutGraph, graphCell } from './gitdiff.js';

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null && v !== false).map(([k, v]) => [k, v === true ? '1' : String(v)])).toString();
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const when = (iso) => (iso ? el('span', { title: new Date(iso).toLocaleString() }, timeAgo(iso)) : '');
const pm = (a, d) => (a == null && d == null ? el('span', { class: 'muted small' }, 'bin') : el('span', { class: 'gl-pm' }, a ? el('b', { class: 'gl-add' }, `+${a}`) : null, d ? el('b', { class: 'gl-del' }, `−${d}`) : null));

const FILTERS = [
  ['all', 'All', () => true],
  ['dirty', 'Uncommitted', (r) => r.repo && r.dirty > 0],
  ['push', 'Unpushed', (r) => r.repo && r.hasCommits && r.remote && (r.ahead > 0 || !r.hasUpstream)],
  ['behind', 'Behind', (r) => r.repo && r.behind > 0],
  ['noremote', 'No remote', (r) => r.repo && !r.remote],
  ['notgit', 'Not git', (r) => !r.repo],
];

/** Anything that needs the user ranks higher: conflicts, then uncommitted work, then unsynced commits. */
const attention = (r) => !r.repo ? 0 : (r.counts?.conflicts ? 1000 : 0) + (r.dirty ? 100 + Math.min(r.dirty, 99) : 0) + (r.ahead || 0) * 5 + (r.behind || 0) * 3;

function bucketOf(iso) {
  if (!iso) return 'Never';
  const t = new Date(iso).getTime(), d = new Date(); d.setHours(0, 0, 0, 0);
  const day = 86400_000, start = d.getTime();
  if (t >= start) return 'Today';
  if (t >= start - day) return 'Yesterday';
  if (t >= start - 6 * day) return 'This week';
  if (t >= start - 29 * day) return 'This month';
  return 'Older';
}

export function createLocal({ publish } = {}) {
  const L = {
    rows: [], totals: null, root: '', loadedAt: 0, error: '',
    sort: localStorage.getItem('aios.gl.sort') || 'recent', filter: '', chip: 'all',
    repoId: null, sub: localStorage.getItem('aios.gl.sub') || 'changes',
    st: null, sel: null, diffOpts: { context: 3, ws: false, wrap: false }, msgs: {}, busy: '',
    hist: null, branches: null, stashes: null, seq: 0, visible: false,
  };
  const root = el('div', { class: 'gl' });
  let focusTimer = null;

  // ---------- plumbing ----------

  const api = (id, p) => `/projects/${id}/git/${p}`;
  const row = () => L.rows.find((r) => r.id === L.repoId);

  async function loadList(fresh = false) {
    try {
      const r = await get('/repos' + (fresh ? '?fresh=1' : ''));
      L.rows = r.repos; L.totals = r.totals; L.root = r.root; L.loadedAt = Date.now(); L.error = '';
    } catch (e) { L.error = e.message; }
  }

  async function loadStatus() {
    const id = L.repoId;
    try {
      const st = await get(api(id, 'status'));
      if (id !== L.repoId) return;
      L.st = st; L.error = '';
      // keep the selection if that file is still changed; otherwise move to the first one
      const has = (path, side) => st.files.some((f) => f.path === path && (side === 'staged' ? f.staged : (f.unstaged || f.conflict)));
      if (!L.sel || !has(L.sel.path, L.sel.side)) {
        const other = L.sel && st.files.find((f) => f.path === L.sel.path && (f.staged || f.unstaged));
        if (other) L.sel = { path: other.path, side: other.unstaged ? 'unstaged' : 'staged' };
        else {
          const f = st.files.find((x) => x.unstaged || x.conflict) || st.files.find((x) => x.staged);
          L.sel = f ? { path: f.path, side: (f.unstaged || f.conflict) ? 'unstaged' : 'staged' } : null;
        }
      }
    } catch (e) { L.error = e.message; L.st = null; }
    paint();
  }

  /** Run a write against the open repo, then redraw from the server's word. */
  async function act(path, body, okMsg) {
    try {
      const r = await post(api(L.repoId, path), body);
      if (okMsg) toast(okMsg, 'ok');
      return r || true;
    } catch (e) { toast(e.message, 'err'); return null; }
    finally { L.hist = null; L.branches = null; L.stashes = null; L.diffCache = null; await loadStatus(); }
  }

  const setSub = (s) => { L.sub = s; localStorage.setItem('aios.gl.sub', s); paint(); };

  // ---------- list view ----------

  function chipFor(r) {
    const out = [];
    if (!r.repo) {
      if (r.missing) return [el('span', { class: 'chip gl-warn' }, 'folder missing')];
      return [el('span', { class: 'chip' }, r.empty ? 'empty folder' : `not a git repo · ${r.files}${r.filesTruncated ? '+' : ''} ${r.files === 1 ? 'file' : 'files'}`),
        r.contains?.length ? el('span', { class: 'chip' }, `holds ${r.contains.join(', ')}`) : null];
    }
    out.push(el('span', { class: 'chip gl-branch', title: r.upstream ? `tracking ${r.upstream}` : 'no upstream' }, icon('git'), r.branch));
    if (r.counts?.conflicts) out.push(el('span', { class: 'chip gl-err' }, plural(r.counts.conflicts, 'conflict')));
    if (r.dirty) {
      const c = r.counts;
      out.push(el('span', { class: 'chip gl-dirty', title: `${c.staged} staged · ${c.unstaged} modified · ${c.untracked} untracked` },
        `${r.dirty} changed`, c.staged ? el('span', { class: 'gl-staged-dot', title: `${c.staged} staged` }, ` ● ${c.staged}`) : null));
    } else if (r.hasCommits) out.push(el('span', { class: 'chip gl-clean' }, 'clean'));
    if (r.ahead) out.push(el('span', { class: 'chip gl-sync', title: `${r.ahead} commit(s) not on ${r.upstream}` }, `↑${r.ahead}`));
    if (r.behind) out.push(el('span', { class: 'chip gl-sync', title: `${r.behind} commit(s) on ${r.upstream} you don't have` }, `↓${r.behind}`));
    if (r.hasCommits && r.remote && !r.hasUpstream && !r.detached) out.push(el('span', { class: 'chip gl-warn', title: 'this branch has never been pushed' }, 'unpushed branch'));
    if (!r.remote) out.push(el('span', { class: 'chip gl-faint', title: 'no remote configured' }, 'local only'));
    if (!r.hasCommits) out.push(el('span', { class: 'chip gl-faint' }, 'no commits'));
    if (r.stashes) out.push(el('span', { class: 'chip', title: 'saved stashes' }, `${plural(r.stashes, 'stash')}`));
    if (r.detached) out.push(el('span', { class: 'chip gl-warn' }, 'detached'));
    if (r.alsoAt?.length) out.push(el('span', { class: 'chip gl-faint', title: `Same remote as ${r.alsoAt.map((a) => a.path).join(', ')} — edits to one never show up in the other` }, `clone of ${r.alsoAt[0].name}`));
    return out;
  }

  function listRow(r) {
    const tone = !r.repo ? 'off' : r.counts?.conflicts ? 'err' : r.dirty ? 'warn' : (r.ahead || r.behind) ? 'sync' : 'ok';
    const active = state.project?.id === r.id;
    const node = el('div', { class: 'gl-row' + (r.repo ? '' : ' nogit'), onclick: () => r.repo ? openRepo(r.id) : null },
      el('span', { class: 'gl-dot ' + tone, title: { off: 'not a git repo', err: 'conflicts', warn: 'uncommitted changes', sync: 'commits to push or pull', ok: 'clean and in sync' }[tone] }),
      el('div', { class: 'gl-row-main' },
        el('div', { class: 'gl-row-top' },
          r.favorite ? el('span', { class: 'fav' }, '★') : null,
          el('span', { class: 'gl-name' }, r.name),
          active ? el('span', { class: 'chip accent' }, 'active') : null,
          ...chipFor(r)),
        el('div', { class: 'gl-row-sub' },
          r.repo && r.lastCommit
            ? [el('span', { class: 'mono gl-hash' }, r.lastCommit.short), el('span', { class: 'gl-subj' }, r.lastCommit.subject), el('span', { class: 'muted' }, ` · ${r.lastCommit.author}`)]
            : el('span', { class: 'muted' }, r.path))),
      el('div', { class: 'gl-row-side' },
        el('span', { class: 'gl-when', title: r.activityAt ? `${r.activityKind === 'uncommitted' ? 'last edit to an uncommitted file' : r.activityKind === 'files' ? 'newest file in the folder' : 'last commit'} — ${new Date(r.activityAt).toLocaleString()}` : '' },
          r.activityAt ? timeAgo(r.activityAt) : ''),
        el('span', { class: 'muted small' }, r.activityKind === 'uncommitted' ? 'edited' : r.activityKind === 'files' ? 'modified' : r.activityAt ? 'committed' : '')),
      r.repo ? el('button', {
        class: 'btn xs ghost gl-kebab', title: 'More',
        onclick: (ev) => { ev.stopPropagation(); const b = ev.currentTarget.getBoundingClientRect(); rowMenu(r, b.right - 160, b.bottom + 2); },
      }, '⋯') : el('button', {
        class: 'btn xs', title: 'Run git init in this folder',
        onclick: async (ev) => {
          ev.stopPropagation();
          if (!await confirmBox('Initialise a git repository?', `Runs git init in ${r.path}. Nothing is committed.`, 'git init', 'primary')) return;
          try { await post(api(r.id, 'init'), {}); toast('repository created', 'ok'); await loadList(true); paint(); } catch (e) { toast(e.message, 'err'); }
        },
      }, 'git init'));
    if (!r.repo && r.missing) node.querySelector('button')?.remove();
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); if (r.repo) rowMenu(r, e.clientX, e.clientY); });
    return node;
  }

  function rowMenu(r, x, y) {
    menu(x, y, [
      { label: 'Open workspace', icon: 'git', onclick: () => openRepo(r.id) },
      { label: 'Make active project', icon: 'projects', onclick: () => { setProject(r.id); toast(`${r.name} is the active project`, 'ok'); paint(); } },
      '-',
      { label: 'Files', icon: 'files', onclick: () => { setProject(r.id); openApp('files', { root: r.id }); } },
      { label: 'Terminal here', icon: 'terminal', onclick: () => { setProject(r.id); openApp('terminal', { cwd: r.path }); } },
      { label: 'Agent', icon: 'agent', onclick: () => { setProject(r.id); openApp('agent'); } },
      r.github ? '-' : null,
      r.github ? { label: 'View on GitHub', icon: 'external', onclick: () => window.open(`https://github.com/${r.github}`, '_blank', 'noreferrer') } : null,
    ].filter(Boolean));
  }

  function paintList() {
    root.textContent = '';
    const t = L.totals;

    const search = el('input', { class: 'input', placeholder: 'filter by name, branch, commit…', value: L.filter, style: { maxWidth: '260px' } });
    search.addEventListener('input', () => { L.filter = search.value; paintListBody(); });
    const sortSeg = el('div', { class: 'seg' }, ...[['recent', 'Latest change'], ['attention', 'Needs attention'], ['name', 'Name']].map(([v, l]) => el('button', {
      class: 'seg-btn' + (L.sort === v ? ' on' : ''), onclick: () => { L.sort = v; localStorage.setItem('aios.gl.sort', v); paintList(); },
    }, l)));
    const head = el('div', { class: 'gl-toolbar' },
      search, sortSeg, el('span', { class: 'grow' }),
      el('button', { class: 'btn sm', title: 'Look through the projects folder for repos and folders that are not registered yet', onclick: scanFolder }, icon('folder'), 'Scan folder'),
      el('button', { class: 'btn sm ghost', title: 'Re-read every repository', onclick: async () => { await loadList(true); paint(); } }, icon('refresh')));

    const chips = el('div', { class: 'gl-chips' }, ...FILTERS.map(([v, label, fn]) => {
      const n = L.rows.filter(fn).length;
      if (v !== 'all' && !n && L.chip !== v) return null;
      return el('button', { class: 'gl-chip' + (L.chip === v ? ' on' : ''), onclick: () => { L.chip = v; paintList(); } }, label, el('span', { class: 'gl-chip-n' }, n));
    }));

    const summary = t ? el('div', { class: 'gl-summary muted small' },
      `${plural(t.projects, 'project')} in `, el('span', { class: 'mono' }, L.root || 'your projects folder'),
      t.uncommitted ? ` · ${t.uncommitted} with uncommitted changes` : ' · nothing uncommitted',
      t.unpushed ? ` · ${t.unpushed} ahead of their remote` : '',
      t.behind ? ` · ${t.behind} behind` : '') : null;

    const body = el('div', { class: 'gl-list' });
    root.append(head, chips, summary, body);
    L.listBody = body;
    paintListBody();
  }

  function paintListBody() {
    const body = L.listBody;
    if (!body) return;
    body.textContent = '';
    if (L.error && !L.rows.length) { body.append(el('div', { class: 'empty' }, '⚠ ' + L.error, el('button', { class: 'btn sm', onclick: async () => { await loadList(true); paint(); } }, 'Retry'))); return; }
    const q = L.filter.trim().toLowerCase();
    const rows = L.rows.filter((r) => {
      const f = FILTERS.find((x) => x[0] === L.chip)[2];
      return f(r) && (!q || r.name.toLowerCase().includes(q) || (r.branch || '').toLowerCase().includes(q) || (r.lastCommit?.subject || '').toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
    });
    if (L.sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    else if (L.sort === 'attention') rows.sort((a, b) => attention(b) - attention(a) || (b.activityAt || '').localeCompare(a.activityAt || ''));
    if (!rows.length) {
      body.append(el('div', { class: 'empty' }, L.rows.length ? 'nothing matches that filter' : el('div', {}, el('div', { class: 'big' }, 'No projects registered'), el('div', { class: 'muted small' }, 'Use “Scan folder” to add the repos in your projects folder.'))));
      return;
    }
    let last = '';
    for (const r of rows) {
      if (L.sort === 'recent') {
        const b = r.repo || r.activityAt ? bucketOf(r.activityAt) : 'Never';
        if (b !== last) { body.append(el('div', { class: 'gl-bucket' }, b)); last = b; }
      }
      body.append(listRow(r));
    }
  }

  async function scanFolder() {
    let d;
    try { d = await get('/repos/discover'); } catch (e) { toast(e.message, 'err'); return; }
    const picks = new Map();
    const list = el('div', { class: 'gl-scan' });
    if (!d.items.length) list.append(el('div', { class: 'muted small' }, `nothing found in ${d.root}`));
    for (const it of d.items) {
      const cb = el('input', { type: 'checkbox', checked: !!it.suggested, disabled: it.registered || it.kind === 'symlink' || it.kind === 'empty' || it.kind === 'container' });
      if (it.suggested) picks.set(it.path, it);
      cb.addEventListener('change', () => { cb.checked ? picks.set(it.path, it) : picks.delete(it.path); });
      list.append(el('label', { class: 'gl-scan-row' + (cb.disabled ? ' dim' : '') },
        cb, el('span', { class: 'gl-scan-name' }, it.name),
        el('span', { class: 'chip' }, it.registered ? 'added' : it.kind),
        el('span', { class: 'muted small gl-scan-note' }, it.note)));
    }
    const res = await modal({
      title: 'Scan projects folder', wide: true,
      sub: `Looking in ${d.root}. Adding a folder only records its path — nothing is copied or changed.`,
      body: list,
      actions: [{ label: 'Close', value: null }, { label: 'Add selected', kind: 'primary', onpick: (close) => close([...picks.values()].map((p) => ({ path: p.path, name: p.name }))) }],
    });
    if (!res?.length) return;
    try {
      const r = await post('/repos/register', { items: res });
      toast(`added ${plural(r.added.length, 'project')}`, 'ok');
      await refreshProjects();
      await loadList(true); paint();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------- opening a repo ----------

  async function openRepo(id) {
    L.repoId = id; L.st = null; L.sel = null; L.hist = null; L.branches = null; L.stashes = null; L.error = '';
    paint();
    await loadStatus();
  }

  function backToList() {
    L.repoId = null; L.st = null;
    paint();
    loadList().then(() => { if (!L.repoId) paint(); });
  }

  // ---------- repo header ----------

  function repoHeader() {
    const r = row() || {};
    const st = L.st;
    const dirty = st?.counts.total || 0;
    const branchBtn = el('button', { class: 'btn sm gl-branchbtn', title: 'Switch branch', onclick: (ev) => branchMenu(ev.currentTarget) }, icon('git'), st ? st.branch : '…', el('span', { class: 'gl-caret' }, '▾'));
    const sync = st && (st.hasUpstream
      ? el('span', { class: 'chip gl-sync', title: `tracking ${st.upstream}` }, st.upstream, ' ', st.ahead ? `↑${st.ahead}` : '', st.behind ? ` ↓${st.behind}` : (st.ahead ? '' : ' ✓'))
      : st.remotes && Object.keys(st.remotes).length && st.hasCommits ? el('span', { class: 'chip gl-warn', title: 'push will create the branch on the remote' }, 'not pushed yet')
        : el('span', { class: 'chip gl-faint' }, 'local only'));
    const busy = !!L.busy;
    const b = (label, fn, o = {}) => el('button', { class: 'btn sm' + (o.primary ? ' primary' : ''), disabled: busy || o.disabled, title: o.title || '', onclick: fn }, o.icon ? icon(o.icon) : null, label);
    return el('div', { class: 'gl-head' },
      el('button', { class: 'btn sm ghost', onclick: backToList, title: 'All projects' }, '←'),
      el('div', { class: 'gl-title' },
        el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, el('b', { class: 'gl-name' }, r.name || ''), branchBtn, sync,
          st?.inProgress ? el('span', { class: 'chip gl-err' }, `${st.inProgress} in progress`) : null),
        el('div', { class: 'muted small gl-path mono' }, r.path || '')),
      el('span', { class: 'grow' }),
      b(L.busy === 'fetch' ? 'Fetching…' : 'Fetch', () => remoteAction('fetch'), { icon: 'refresh', disabled: !st || !Object.keys(st.remotes || {}).length, title: 'git fetch --prune' }),
      b(L.busy === 'pull' ? 'Pulling…' : `Pull${st?.behind ? ` ↓${st.behind}` : ''}`, pullFlow, { icon: 'download', primary: !!st?.behind, disabled: !st || !st.hasUpstream, title: 'Fast-forward pull — shows what is coming first' }),
      b(L.busy === 'push' ? 'Pushing…' : `Push${st?.ahead ? ` ↑${st.ahead}` : ''}`, pushFlow, { icon: 'send', primary: !!st?.ahead || (st && !st.hasUpstream && st.hasCommits), disabled: !st || !st.hasCommits, title: 'Shows exactly which commits would be sent before anything is' }),
      el('button', { class: 'btn sm ghost', disabled: !st, onclick: (ev) => { const bb = ev.currentTarget.getBoundingClientRect(); moreMenu(bb.right - 190, bb.bottom + 2); }, title: 'More' }, '⋯'));
  }

  function moreMenu(x, y) {
    const r = row() || {}, st = L.st;
    const dl = (scope) => { const a = el('a', { href: mediaUrl(`/projects/${L.repoId}/git/patch?scope=${scope}`), download: '' }); document.body.append(a); a.click(); a.remove(); };
    menu(x, y, [
      { label: 'Stash changes…', icon: 'save', onclick: () => stashFlow() },
      '-',
      { label: 'Export patch — all tracked changes', icon: 'download', onclick: () => dl('all') },
      { label: 'Export patch — staged only', icon: 'download', onclick: () => dl('staged') },
      '-',
      { label: 'Make active project', icon: 'projects', onclick: () => { setProject(L.repoId); toast(`${r.name} is the active project`, 'ok'); } },
      { label: 'Files', icon: 'files', onclick: () => { setProject(L.repoId); openApp('files', { root: L.repoId }); } },
      { label: 'Terminal here', icon: 'terminal', onclick: () => { setProject(L.repoId); openApp('terminal', { cwd: r.path }); } },
      st?.github ? '-' : null,
      st?.github ? { label: 'View on GitHub', icon: 'external', onclick: () => window.open(`https://github.com/${st.github}`, '_blank', 'noreferrer') } : null,
      st && !Object.keys(st.remotes || {}).length && st.hasCommits && publish ? '-' : null,
      st && !Object.keys(st.remotes || {}).length && st.hasCommits && publish ? { label: 'Publish to GitHub…', icon: 'github', onclick: () => publish(r) } : null,
    ].filter(Boolean));
  }

  async function branchMenu(btn) {
    try { if (!L.branches) L.branches = await get(api(L.repoId, 'branches')); } catch (e) { toast(e.message, 'err'); return; }
    const b = btn.getBoundingClientRect();
    const items = L.branches.locals.slice(0, 14).map((x) => ({
      label: x.name, sel: x.current, hint: x.current ? 'current branch' : undefined,
      onclick: () => x.current ? null : switchTo({ branch: x.name }),
    }));
    menu(b.left, b.bottom + 2, [
      ...items, '-',
      { label: 'New branch…', icon: 'plus', onclick: () => newBranch() },
      { label: 'All branches…', icon: 'git', onclick: () => setSub('branches') },
    ]);
  }

  async function switchTo(body) {
    const dirty = L.st?.counts.total || 0;
    if (L.st?.inProgress && !await confirmBox('A ' + L.st.inProgress + ' is in progress', 'Switching branches now will probably fail or make it harder to finish. Continue anyway?', 'Switch', 'primary')) return;
    const r = await act('checkout', body);
    if (r) toast(`on ${r.branch}${dirty ? ` — your ${plural(dirty, 'uncommitted change')} came along` : ''}`, 'ok');
  }

  async function newBranch(from = '') {
    const name = await askText({ title: 'New branch', sub: from ? `Starts at ${from}.` : `Starts at your current commit on ${L.st?.branch}. Uncommitted changes come with you.`, placeholder: 'feature/my-change', ok: 'Create & switch' });
    if (!name) return;
    const r = await act('branch', { name, from, checkout: true });
    if (r) toast(`created and switched to ${name}`, 'ok');
  }

  // ---------- remote actions ----------

  async function remoteAction(kind, body = {}) {
    L.busy = kind; paint();
    try {
      const r = await post(api(L.repoId, kind === 'fetch' ? 'fetch' : kind === 'push' ? 'push-branch' : 'pull-ff'), body);
      toast(kind === 'fetch' ? 'fetched' : kind === 'push' ? `pushed ${r.branch} → ${r.remote}` : (/up to date/i.test(r.out || '') ? 'already up to date' : 'pulled'), 'ok');
      return r;
    } catch (e) { toast(e.message, 'err'); return { error: e }; }
    finally { L.busy = ''; L.branches = null; L.hist = null; await loadStatus(); }
  }

  const commitList = (commits, cap = 12) => el('div', { class: 'gl-pv-commits' },
    ...commits.slice(0, cap).map((c) => el('div', { class: 'gl-pv-commit' }, el('span', { class: 'mono gl-hash' }, c.short), el('span', { class: 'gl-subj' }, c.subject), el('span', { class: 'muted small' }, ` ${c.author} · `, when(c.at)))),
    commits.length > cap ? el('div', { class: 'muted small' }, `… and ${commits.length - cap} more`) : null);

  async function pushFlow() {
    let o;
    try { o = await get(api(L.repoId, 'outgoing')); } catch (e) { toast(e.message, 'err'); return; }
    const r = row() || {};
    if (o.detached) { toast('You are on a detached HEAD — switch to a branch before pushing', 'err'); return; }
    if (o.noRemote) {
      if (publish && await confirmBox('No remote yet', `${r.name} is not on GitHub. Publish it — this creates the repository under your account and pushes this branch.`, 'Publish…', 'primary')) publish(r);
      return;
    }
    const remoteNames = Object.keys(o.remotes);
    const sel = el('select', { class: 'input select', style: { width: 'auto' } }, ...remoteNames.map((n) => el('option', { value: n, selected: n === o.remote }, n)));
    const files = o.files || [];
    const adds = files.reduce((a, f) => a + (f.additions || 0), 0), dels = files.reduce((a, f) => a + (f.deletions || 0), 0);
    const blocked = o.incoming.length > 0;
    const body = el('div', { class: 'col', style: { gap: '10px', minWidth: '440px' } },
      el('div', { class: 'gl-pv-line' }, el('b', { class: 'mono' }, o.branch), ' → ', o.setUpstreamNeeded ? [sel, el('span', { class: 'muted small' }, ` (new branch on the remote — it will track ${o.branch})`)] : el('b', { class: 'mono' }, o.upstream)),
      blocked ? el('div', { class: 'gl-pv-warn' }, `The remote has ${plural(o.incoming.length, 'commit')} you don't have yet. Pull first, then push — otherwise git will reject this push.`, commitList(o.incoming, 5)) : null,
      el('div', { class: 'lbl' }, o.outgoing.length ? `${plural(o.outgoing.length, 'commit')} will be sent${files.length ? ` · ${plural(files.length, 'file')} · +${adds} −${dels}` : ''}` : 'Nothing to send'),
      o.outgoing.length ? commitList(o.outgoing) : el('div', { class: 'muted small' }, 'Everything on this branch is already on the remote.'),
      files.length ? el('details', { class: 'gl-pv-files' }, el('summary', { class: 'small muted' }, 'Files in these commits'),
        ...files.slice(0, 60).map((f) => el('div', { class: 'gl-pv-file' }, el('span', { class: 'mono' }, f.path), pm(f.additions, f.deletions)))) : null);
    const go = await modal({
      title: 'Push', sub: 'Nothing is sent until you press Push. Uncommitted changes are never part of a push.', body, wide: true,
      actions: [{ label: 'Cancel', value: null }, { label: blocked ? 'Pull first' : o.outgoing.length ? `Push ${plural(o.outgoing.length, 'commit')}` : 'Push anyway', kind: 'primary', value: 'go', onpick: blocked ? () => false : undefined }],
    });
    if (go !== 'go') return;
    await remoteAction('push', { remote: sel.value, branch: o.branch, setUpstream: o.setUpstreamNeeded });
  }

  async function pullFlow() {
    let o;
    try { o = await get(api(L.repoId, 'outgoing')); } catch (e) { toast(e.message, 'err'); return; }
    if (!o.incoming.length) {
      // nothing local says it's behind — ask the remote
      const r = await remoteAction('fetch');
      if (r?.error) return;
      try { o = await get(api(L.repoId, 'outgoing')); } catch { return; }
      if (!o.incoming.length) { toast('already up to date', 'ok'); return; }
    }
    const diverged = o.outgoing.length > 0;
    const go = await modal({
      title: 'Pull', wide: true,
      sub: diverged ? 'Both sides have new commits, so this cannot fast-forward.' : 'Fast-forward only: your branch simply moves ahead. Nothing is merged or rewritten.',
      body: el('div', { class: 'col', style: { gap: '8px' } },
        el('div', { class: 'lbl' }, `${plural(o.incoming.length, 'incoming commit')}`), commitList(o.incoming),
        diverged ? el('div', { class: 'gl-pv-warn' }, `You also have ${plural(o.outgoing.length, 'local commit')} the remote lacks. “Pull with rebase” replays them on top; a conflict aborts and leaves your tree untouched.`) : null),
      actions: [{ label: 'Cancel', value: null }, diverged ? { label: 'Pull with rebase', kind: 'primary', value: 'rebase' } : { label: 'Pull (fast-forward)', kind: 'primary', value: 'ff' }],
    });
    if (!go) return;
    await remoteAction('pull', { mode: go });
  }

  // ---------- changes view ----------

  function fileRow(f, side) {
    const staged = side === 'staged';
    const letter = staged ? f.x : f.conflict ? '!' : f.untracked ? 'U' : f.y;
    const cls = { A: 'new', U: 'new', M: 'mod', D: 'del', R: 'ren', C: 'ren', T: 'mod', '!': 'del' }[letter] || 'mod';
    const on = L.sel && L.sel.path === f.path && L.sel.side === side;
    const act1 = staged
      ? el('button', { class: 'gl-ib', title: 'Unstage this file', onclick: (ev) => { ev.stopPropagation(); act('unstage', { paths: [f.path] }); } }, '−')
      : el('button', { class: 'gl-ib', title: 'Stage this file', onclick: (ev) => { ev.stopPropagation(); act('stage', { paths: [f.path] }); } }, '+');
    const discard = !staged && !f.conflict ? el('button', {
      class: 'gl-ib danger', title: f.untracked ? 'Delete this untracked file' : 'Discard changes to this file',
      onclick: async (ev) => {
        ev.stopPropagation();
        if (!await confirmBox(f.untracked ? 'Delete this file?' : 'Discard these changes?', `${f.path}\n${f.untracked ? 'It is not tracked by git, so it cannot be recovered.' : 'The file goes back to what is staged (or the last commit). This cannot be undone.'}`, f.untracked ? 'Delete file' : 'Discard')) return;
        act('discard', { paths: [f.path], confirm: true }, 'discarded');
      },
    }, '↶') : null;
    return el('div', { class: 'gl-file' + (on ? ' on' : ''), dataset: { path: f.path, side }, title: f.orig ? `${f.orig} → ${f.path}` : f.path, onclick: () => selectFile(f.path, side) },
      el('span', { class: `gl-st s-${cls}` }, letter),
      el('span', { class: 'gl-fname' }, el('span', { class: 'gl-fdir' }, dirName(f.path)), baseName(f.path), f.orig ? el('span', { class: 'muted small' }, `  ← ${baseName(f.orig)}`) : null),
      // git has no numbers for a file it does not track yet — show none rather than "bin"
      f.untracked && !staged ? null : pm(staged ? f.addS : f.addU, staged ? f.delS : f.delU),
      el('span', { class: 'gl-acts' }, discard, act1));
  }

  function fileSection(title, files, side, buttons) {
    const CAP = 400;
    const sec = el('div', { class: 'gl-sec' },
      el('div', { class: 'gl-sec-head' }, el('b', {}, title), el('span', { class: 'chip' }, files.length), el('span', { class: 'grow' }), ...buttons));
    if (!files.length) { sec.append(el('div', { class: 'gl-sec-empty muted small' }, side === 'staged' ? 'Nothing staged. Stage files with + to build a commit.' : 'No other changes.')); return sec; }
    const list = el('div', { class: 'gl-files' });
    const paintFiles = (cap) => {
      list.textContent = '';
      for (const f of files.slice(0, cap)) list.append(fileRow(f, side));
      if (files.length > cap) list.append(el('button', { class: 'btn sm gl-more', onclick: () => paintFiles(Infinity) }, `Show ${files.length - cap} more files`));
    };
    paintFiles(CAP);
    sec.append(list);
    return sec;
  }

  function paintChanges(host) {
    const st = L.st;
    if (!st) return;
    const staged = st.files.filter((f) => f.staged);
    const unstaged = st.files.filter((f) => (f.unstaged || f.conflict) && !f.conflict);
    const conflicts = st.files.filter((f) => f.conflict);
    const left = el('div', { class: 'gl-left' });
    left.append(el('div', { class: 'gl-files-scroll' },
      conflicts.length ? el('div', { class: 'gl-sec' }, el('div', { class: 'gl-sec-head' }, el('b', { class: 'gl-err-t' }, 'Merge conflicts'), el('span', { class: 'chip gl-err' }, conflicts.length)),
        el('div', { class: 'gl-files' }, ...conflicts.map((f) => fileRow(f, 'unstaged'))),
        el('div', { class: 'muted small', style: { padding: '2px 6px 6px' } }, 'Resolve these in your editor, then stage them.')) : null,
      fileSection('Staged', staged, 'staged', [staged.length ? el('button', { class: 'btn xs', onclick: () => act('unstage', { all: true }) }, 'Unstage all') : null]),
      fileSection('Changes', unstaged, 'unstaged', [unstaged.length ? el('button', { class: 'btn xs', title: 'git add -A', onclick: () => act('stage', { all: true }) }, 'Stage all') : null]),
      st.truncated ? el('div', { class: 'muted small', style: { padding: '6px' } }, 'Only the first 4,000 changed paths are listed.') : null,
      !st.files.length ? el('div', { class: 'empty sm' }, st.hasCommits ? '✓ Working tree clean' : 'Empty repository — create a file to get started') : null));
    left.append(commitBox(staged));
    host.append(left, el('div', { class: 'gl-right' }, (L.diffHost = el('div', { class: 'gl-diffhost' }))));
    loadDiff();
  }

  function commitBox(staged) {
    const id = L.repoId;
    const ta = el('textarea', { class: 'input gl-msg', rows: 3, placeholder: staged.length ? 'Commit message — subject on the first line' : 'Stage some changes, then describe them here' });
    ta.value = L.msgs[id] || '';
    ta.addEventListener('input', () => { L.msgs[id] = ta.value; sync(); });
    const commitBtn = el('button', { class: 'btn primary', onclick: reviewCommit }, `Review & commit`);
    const draft = el('button', {
      class: 'btn sm', title: 'Draft a message from the staged diff with your local model (loads it if it is not running)',
      onclick: async () => {
        draft.disabled = true; const old = draft.textContent; draft.textContent = 'drafting…';
        try { const r = await post(api(id, 'message'), { staged: true }); ta.value = r.message; L.msgs[id] = r.message; sync(); if (!r.generated) toast('no model answered — used a plain template', ''); }
        catch (e) { toast(e.message, 'err'); }
        draft.disabled = false; draft.textContent = old;
      },
    }, icon('sparkle'), 'Draft');
    function sync() { commitBtn.disabled = !staged.length || !ta.value.trim(); draft.disabled = !staged.length; }
    sync();
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !commitBtn.disabled) reviewCommit(); });
    return el('div', { class: 'gl-commit' },
      ta,
      el('div', { class: 'row' }, el('span', { class: 'muted small' }, staged.length ? `${plural(staged.length, 'file')} will be committed; everything else stays as it is` : ''), el('span', { class: 'grow' }), draft, commitBtn));
  }

  async function reviewCommit() {
    const id = L.repoId, message = (L.msgs[id] || '').trim();
    if (!message) return;
    let sp;
    try { sp = await get(api(id, 'staged-patch')); } catch (e) { toast(e.message, 'err'); return; }
    if (!sp.files.length) { toast('nothing is staged', 'err'); return; }
    const files = splitPatch(sp.patch);
    const adds = sp.files.reduce((a, f) => a + (f.additions || 0), 0), dels = sp.files.reduce((a, f) => a + (f.deletions || 0), 0);
    const blocks = el('div', { class: 'gl-review' });
    for (const f of files) {
      const st = sp.files.find((x) => x.path === f.path);
      const det = el('details', { class: 'gl-review-file', open: files.length <= 6 },
        el('summary', {}, el('span', { class: 'mono' }, f.path), pm(st?.additions, st?.deletions)));
      let drawn = false;
      const draw = () => { if (drawn) return; drawn = true; det.append(f.binary ? el('div', { class: 'muted small', style: { padding: '6px 10px' } }, 'binary file') : renderDiff(f.hunks)); };
      det.addEventListener('toggle', () => { if (det.open) draw(); });
      if (det.open) draw();
      blocks.append(det);
    }
    if (sp.truncated) blocks.append(el('div', { class: 'muted small', style: { padding: '6px' } }, 'The patch is large — only the beginning is shown. The commit still includes everything staged.'));
    const go = await modal({
      title: 'Review staged changes', xl: true,
      sub: `${plural(sp.files.length, 'file')} · +${adds} −${dels} → ${L.st?.branch}. Unstaged changes are not included.`,
      body: el('div', { class: 'col', style: { gap: '10px' } }, el('pre', { class: 'gl-review-msg' }, message), blocks),
      actions: [{ label: 'Back', value: null }, { label: `Commit ${plural(sp.files.length, 'file')}`, kind: 'primary', value: 'go' }],
    });
    if (go !== 'go') return;
    try {
      const r = await post(api(id, 'commit-staged'), { message, digest: sp.digest });
      L.msgs[id] = '';
      toast(`committed ${r.hash} — ${r.message}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    L.hist = null; L.branches = null;
    await loadStatus();
  }

  function selectFile(path, side) {
    L.sel = { path, side };
    root.querySelectorAll('.gl-left .gl-file').forEach((n) => n.classList.toggle('on', n.dataset.path === path && n.dataset.side === side));
    loadDiff();
  }

  async function loadDiff() {
    const host = L.diffHost;
    if (!host) return;
    host.textContent = '';
    const sel = L.sel;
    if (!sel) { host.append(el('div', { class: 'empty' }, L.st?.files.length ? 'Select a file to see its changes' : 'No changes to show')); return; }
    const f = L.st.files.find((x) => x.path === sel.path);
    if (!f) return;
    const seq = ++L.seq;
    const key = JSON.stringify([L.repoId, sel, L.diffOpts, f.x, f.y, f.addU, f.delU, f.addS, f.delS, L.st.head]);
    if (L.diffCache?.key === key) { host.append(...L.diffCache.nodes); return; }
    const both = f.staged && (f.unstaged || f.conflict);
    const head = el('div', { class: 'gl-diffhead' },
      el('div', { class: 'gl-diffpath' }, el('span', { class: 'gl-fdir' }, dirName(f.path)), el('b', {}, baseName(f.path))),
      both ? el('div', { class: 'seg' }, ...[['unstaged', 'Working tree'], ['staged', 'Staged']].map(([v, l]) => el('button', { class: 'seg-btn' + (sel.side === v ? ' on' : ''), onclick: () => { L.sel = { path: f.path, side: v }; paint(true); } }, l))) : el('span', { class: 'chip' }, sel.side === 'staged' ? 'staged' : f.untracked ? 'untracked' : 'working tree'),
      el('span', { class: 'grow' }));
    const ctxSel = el('select', { class: 'input select gl-mini', title: 'Lines of context' }, ...[['3', '3 lines'], ['10', '10 lines'], ['25', '25 lines'], ['full', 'whole file']].map(([v, l]) => el('option', { value: v, selected: String(L.diffOpts.context) === v }, l)));
    ctxSel.addEventListener('change', () => { L.diffOpts.context = ctxSel.value; loadDiff(); });
    const ws = el('label', { class: 'gl-tog small' }, el('input', { type: 'checkbox', checked: L.diffOpts.ws, onchange: (e) => { L.diffOpts.ws = e.target.checked; loadDiff(); } }), 'ignore whitespace');
    const wrap = el('label', { class: 'gl-tog small' }, el('input', { type: 'checkbox', checked: L.diffOpts.wrap, onchange: (e) => { L.diffOpts.wrap = e.target.checked; loadDiff(); } }), 'wrap');
    const stageBtn = sel.side === 'staged'
      ? el('button', { class: 'btn sm', onclick: () => act('unstage', { paths: [f.path] }) }, 'Unstage file')
      : f.conflict ? null : el('button', { class: 'btn sm primary', onclick: () => act('stage', { paths: [f.path] }) }, 'Stage file');
    const histBtn = !f.untracked && L.st.hasCommits ? el('button', { class: 'btn sm ghost', title: 'Commits that touched this file', onclick: () => { L.hist = null; L.histPath = f.path; setSub('history'); } }, 'History') : null;
    head.append(ctxSel, ws, wrap, histBtn, stageBtn);
    const body = el('div', { class: 'gl-diffbody' }, el('div', { class: 'empty', style: { minHeight: '80px' } }, el('span', { class: 'spinner' })));
    host.append(head, body);
    try {
      const d = await get(api(L.repoId, 'file-diff') + '?' + qs({ path: f.path, staged: sel.side === 'staged', context: L.diffOpts.context, ws: L.diffOpts.ws }));
      if (seq !== L.seq) return;
      body.textContent = '';
      if (d.binary) body.append(el('div', { class: 'empty' }, 'Binary file — no text diff'));
      else if (!d.diff) body.append(el('div', { class: 'empty' }, d.note || 'No changes'));
      else {
        const canHunk = !f.untracked && !f.conflict && !L.diffOpts.ws && !d.truncated;
        const hunks = parseDiff(d.diff);
        const stat = el('div', { class: 'gl-diffstat muted small' }, plural(hunks.length, 'hunk'), ' · ', pm(d.additions, d.deletions), d.truncated ? ' · truncated (very large file)' : '');
        body.append(stat, renderDiff(hunks, {
          wrap: L.diffOpts.wrap,
          hunkAction: canHunk ? {
            label: sel.side === 'staged' ? 'Unstage hunk' : 'Stage hunk', title: 'Only this block of changes',
            run: (i, h) => act('stage-hunk', { path: f.path, index: i, header: h.raw, reverse: sel.side === 'staged', context: L.diffOpts.context }),
          } : null,
        }));
      }
      if (seq === L.seq) L.diffCache = { key, nodes: [head, body] };
    } catch (e) { if (seq === L.seq) { body.textContent = ''; body.append(el('div', { class: 'empty' }, '⚠ ' + e.message)); } }
  }

  // ---------- history ----------

  async function loadHistory(more = false) {
    const id = L.repoId;
    const h = L.hist || (L.hist = { commits: [], hasMore: false, scope: 'current', search: '', path: L.histPath || '', sel: null, detail: null });
    if (!more) { h.commits = []; }
    try {
      const r = await get(api(id, 'log') + '?' + qs({ all: h.scope === 'all', ref: h.scope !== 'all' && h.scope !== 'current' ? h.scope : '', limit: 60, skip: h.commits.length, search: h.search, path: h.path }));
      if (id !== L.repoId) return;
      h.commits.push(...r.commits); h.hasMore = r.hasMore; h.err = '';
    } catch (e) { h.err = e.message; }
    if (L.sub === 'history') paint(true);
  }

  async function openCommit(c) {
    const h = L.hist;
    h.sel = c.hash; h.detail = null; h.file = null;
    paint(true);
    try { h.detail = await get(api(L.repoId, `commit/${c.hash}`)); } catch (e) { h.detailErr = e.message; }
    if (h.sel === c.hash && L.sub === 'history') paint(true);
  }

  async function paintHistory(host) {
    if (!L.hist || L.hist.path !== (L.histPath || '')) { L.hist = null; }
    if (!L.hist) { host.append(el('div', { class: 'empty' }, el('span', { class: 'spinner' }))); await loadHistory(); return; }
    const h = L.hist;
    if (!L.branches) { try { L.branches = await get(api(L.repoId, 'branches')); } catch { } }
    const scope = el('select', { class: 'input select gl-mini', title: 'Which commits' },
      el('option', { value: 'current', selected: h.scope === 'current' }, `Current branch (${L.st?.branch})`),
      el('option', { value: 'all', selected: h.scope === 'all' }, 'All branches'),
      ...(L.branches?.locals || []).filter((b) => !b.current).map((b) => el('option', { value: b.name, selected: h.scope === b.name }, b.name)));
    scope.addEventListener('change', () => { h.scope = scope.value; loadHistory(); });
    const search = el('input', { class: 'input gl-mini', placeholder: 'search messages…', value: h.search, style: { width: '190px' } });
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { h.search = search.value.trim(); loadHistory(); } });
    const bar = el('div', { class: 'gl-histbar' }, scope, search,
      h.path ? el('span', { class: 'chip accent' }, el('span', { class: 'mono' }, h.path), el('button', { class: 'gl-x', title: 'Clear', onclick: () => { L.histPath = ''; L.hist = null; paint(true); } }, '×')) : null,
      el('span', { class: 'grow' }), el('span', { class: 'muted small' }, `${h.commits.length}${h.hasMore ? '+' : ''} commits`));
    const { rows, width } = layoutGraph(h.commits);
    const list = el('div', { class: 'gl-commits' });
    h.commits.forEach((c, i) => {
      list.append(el('div', { class: 'gl-commit-row' + (h.sel === c.hash ? ' on' : ''), onclick: () => openCommit(c) },
        graphCell(rows[i], width),
        el('div', { class: 'gl-cr-main' },
          el('div', { class: 'gl-cr-top' },
            ...c.refs.map((r) => el('span', { class: `gl-ref r-${r.type}${r.head ? ' head' : ''}` }, r.name)),
            el('span', { class: 'gl-subj' }, c.subject)),
          el('div', { class: 'muted small' }, el('span', { class: 'mono' }, c.short), ` · ${c.author} · `, when(c.at)))));
    });
    if (h.hasMore) list.append(el('button', { class: 'btn sm gl-more', onclick: () => loadHistory(true) }, 'Load more'));
    if (h.err) list.append(el('div', { class: 'empty' }, '⚠ ' + h.err));
    if (!h.commits.length && !h.err) list.append(el('div', { class: 'empty' }, L.st?.hasCommits ? 'No commits match' : 'No commits yet'));
    host.append(el('div', { class: 'gl-left wide' }, bar, el('div', { class: 'gl-files-scroll' }, list)), el('div', { class: 'gl-right' }, commitDetail(h)));
  }

  function commitDetail(h) {
    if (!h.sel) return el('div', { class: 'empty' }, 'Select a commit');
    const d = h.detail;
    if (!d) return h.detailErr ? el('div', { class: 'empty' }, '⚠ ' + h.detailErr) : el('div', { class: 'empty' }, el('span', { class: 'spinner' }));
    const box = el('div', { class: 'gl-cdetail' });
    const diffHost = el('div', { class: 'gl-diffbody' }, el('div', { class: 'empty sm' }, 'Click a file to see what changed'));
    box.append(...[
      el('div', { class: 'gl-cd-head' },
        el('div', { class: 'gl-cd-subj' }, d.subject),
        el('div', { class: 'muted small' }, `${d.author} <${d.email}> · `, when(d.at), ' · ', el('span', { class: 'mono' }, d.short),
          el('button', { class: 'gl-x', title: 'Copy full hash', onclick: () => { navigator.clipboard?.writeText(d.hash); toast('hash copied', 'ok'); } }, '⧉'),
          d.parents.length > 1 ? ` · merge of ${d.parents.map((p) => p.slice(0, 7)).join(' + ')}` : d.parents.length === 0 ? ' · root commit' : '')),
      d.message.includes('\n') ? el('pre', { class: 'gl-cd-body' }, d.message.split('\n').slice(1).join('\n').trim()) : null,
      el('div', { class: 'lbl', style: { padding: '6px 10px 2px' } }, `${plural(d.files.length, 'file')} changed`),
      el('div', { class: 'gl-files' }, ...d.files.map((f) => el('div', { class: 'gl-file' + (h.file === f.path ? ' on' : ''), onclick: async () => {
        h.file = f.path;
        box.querySelectorAll('.gl-file').forEach((n) => n.classList.remove('on'));
        diffHost.textContent = ''; diffHost.append(el('div', { class: 'empty sm' }, el('span', { class: 'spinner' })));
        try {
          const r = await get(api(L.repoId, 'file-diff') + '?' + qs({ path: f.path, commit: d.hash, context: L.diffOpts.context, ws: L.diffOpts.ws }));
          diffHost.textContent = '';
          diffHost.append(r.binary ? el('div', { class: 'empty sm' }, 'Binary file') : r.diff ? renderDiff(parseDiff(r.diff), { wrap: L.diffOpts.wrap }) : el('div', { class: 'empty sm' }, r.note || 'No textual changes'));
        } catch (e) { diffHost.textContent = ''; diffHost.append(el('div', { class: 'empty sm' }, '⚠ ' + e.message)); }
        paintMarks();
      }, dataset: { path: f.path } },
      el('span', { class: `gl-st s-${{ A: 'new', M: 'mod', D: 'del', R: 'ren', C: 'ren' }[f.status] || 'mod'}` }, f.status),
      el('span', { class: 'gl-fname' }, el('span', { class: 'gl-fdir' }, dirName(f.path)), baseName(f.path)),
      pm(f.additions, f.deletions)))),
      diffHost].filter(Boolean));
    function paintMarks() { box.querySelectorAll('.gl-file').forEach((n) => n.classList.toggle('on', n.dataset.path === h.file)); }
    return box;
  }

  // ---------- branches ----------

  async function paintBranches(host) {
    if (!L.branches) {
      host.append(el('div', { class: 'empty' }, el('span', { class: 'spinner' })));
      try { L.branches = await get(api(L.repoId, 'branches')); } catch (e) { host.textContent = ''; host.append(el('div', { class: 'empty' }, '⚠ ' + e.message)); return; }
      if (L.sub === 'branches') paint(true);
      return;
    }
    const B = L.branches;
    const filter = el('input', { class: 'input', placeholder: 'filter branches…', value: L.bFilter || '', style: { maxWidth: '240px' } });
    filter.addEventListener('input', () => { L.bFilter = filter.value; drawRows(); });
    const table = el('div', { class: 'gl-btable' });
    const remoteBox = el('div', { class: 'gl-btable' });
    const drawRows = () => {
      const q = (L.bFilter || '').toLowerCase();
      table.textContent = ''; remoteBox.textContent = '';
      for (const b of B.locals.filter((x) => !q || x.name.toLowerCase().includes(q))) {
        table.append(el('div', { class: 'gl-brow' + (b.current ? ' cur' : '') },
          el('span', { class: 'gl-bmark' }, b.current ? '●' : ''),
          el('div', { class: 'gl-bmain' },
            el('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, el('b', { class: 'mono' }, b.name),
              b.upstream ? el('span', { class: 'chip' }, b.upstream, b.ahead ? ` ↑${b.ahead}` : '', b.behind ? ` ↓${b.behind}` : '', b.gone ? ' (gone)' : '') : el('span', { class: 'chip gl-faint' }, 'no upstream'),
              b.name === B.base ? el('span', { class: 'chip accent' }, 'default') : null,
              b.merged ? el('span', { class: 'chip gl-clean', title: `fully merged into ${B.base} — safe to delete` }, 'merged') : null),
            el('div', { class: 'muted small gl-subj' }, `${b.subject} · `, when(b.at))),
          el('div', { class: 'gl-bacts' },
            b.current ? null : el('button', { class: 'btn xs', onclick: () => switchTo({ branch: b.name }) }, 'Switch'),
            b.current ? null : el('button', { class: 'btn xs', title: `Compare with ${B.current}`, onclick: () => compareFlow(B.current, b.name) }, 'Compare'),
            b.current ? null : el('button', { class: 'btn xs danger', onclick: () => deleteBranch(b) }, 'Delete'))));
      }
      const rem = B.remotes.filter((x) => !q || x.name.toLowerCase().includes(q));
      for (const r of rem) {
        remoteBox.append(el('div', { class: 'gl-brow' },
          el('span', { class: 'gl-bmark' }),
          el('div', { class: 'gl-bmain' }, el('b', { class: 'mono' }, r.name), el('div', { class: 'muted small gl-subj' }, `${r.subject} · `, when(r.at))),
          el('div', { class: 'gl-bacts' },
            r.hasLocal ? el('span', { class: 'chip' }, 'checked out locally') : el('button', { class: 'btn xs', title: 'Create a local branch that tracks it', onclick: () => switchTo({ remoteBranch: r.name }) }, 'Check out'),
            el('button', { class: 'btn xs', onclick: () => compareFlow(B.current, r.name) }, 'Compare'))));
      }
      if (!rem.length) remoteBox.append(el('div', { class: 'muted small', style: { padding: '8px 10px' } }, 'no remote branches — fetch to look for some'));
    };
    drawRows();
    host.append(el('div', { class: 'gl-full' },
      el('div', { class: 'gl-histbar' }, filter, el('span', { class: 'grow' }), el('button', { class: 'btn sm primary', onclick: () => newBranch() }, icon('plus'), 'New branch')),
      el('div', { class: 'gl-files-scroll' },
        el('div', { class: 'gl-sec-head' }, el('b', {}, 'Local'), el('span', { class: 'chip' }, B.locals.length)), table,
        el('div', { class: 'gl-sec-head', style: { marginTop: '14px' } }, el('b', {}, 'Remote'), el('span', { class: 'chip' }, B.remotes.length)), remoteBox)));
  }

  async function deleteBranch(b) {
    if (!await confirmBox(`Delete ${b.name}?`, b.merged ? 'It is fully merged, so no commits are lost.' : 'Git will refuse if it has commits that exist nowhere else.', 'Delete branch')) return;
    try {
      await post(api(L.repoId, 'branch/delete'), { name: b.name });
      toast(`deleted ${b.name}`, 'ok');
    } catch (e) {
      if (/nowhere else/.test(e.message)) {
        if (await confirmBox(`Really delete ${b.name}?`, e.message + '\n\nThis cannot be undone from here.', 'Delete and lose them')) {
          try { await post(api(L.repoId, 'branch/delete'), { name: b.name, force: true, confirm: true }); toast(`deleted ${b.name}`, 'ok'); } catch (e2) { toast(e2.message, 'err'); }
        }
      } else toast(e.message, 'err');
    }
    L.branches = null; await loadStatus();
  }

  async function compareFlow(base, head) {
    let c;
    try { c = await get(api(L.repoId, 'compare') + '?' + qs({ base, head })); } catch (e) { toast(e.message, 'err'); return; }
    const diffHost = el('div', { class: 'gl-diffbody gl-cmp-diff' }, el('div', { class: 'empty sm' }, 'Click a file to see its changes'));
    const adds = c.files.reduce((a, f) => a + (f.additions || 0), 0), dels = c.files.reduce((a, f) => a + (f.deletions || 0), 0);
    const files = el('div', { class: 'gl-files' }, ...c.files.map((f) => el('div', {
      class: 'gl-file', onclick: async (ev) => {
        ev.currentTarget.parentElement.querySelectorAll('.gl-file').forEach((n) => n.classList.remove('on')); ev.currentTarget.classList.add('on');
        diffHost.textContent = ''; diffHost.append(el('div', { class: 'empty sm' }, el('span', { class: 'spinner' })));
        try {
          const r = await get(api(L.repoId, 'file-diff') + '?' + qs({ path: f.path, range: `${base}...${head}`, context: L.diffOpts.context }));
          diffHost.textContent = '';
          diffHost.append(r.binary ? el('div', { class: 'empty sm' }, 'Binary file') : r.diff ? renderDiff(parseDiff(r.diff)) : el('div', { class: 'empty sm' }, r.note || 'No changes'));
        } catch (e) { diffHost.textContent = ''; diffHost.append(el('div', { class: 'empty sm' }, '⚠ ' + e.message)); }
      },
    }, el('span', { class: `gl-st s-${{ A: 'new', M: 'mod', D: 'del', R: 'ren', C: 'ren' }[f.status] || 'mod'}` }, f.status),
    el('span', { class: 'gl-fname' }, el('span', { class: 'gl-fdir' }, dirName(f.path)), baseName(f.path)), pm(f.additions, f.deletions))));
    await modal({
      title: `${head} vs ${base}`, xl: true,
      sub: `${head} is ${plural(c.ahead, 'commit')} ahead and ${plural(c.behind, 'commit')} behind ${base}. Files below are what a pull request from ${head} would change (+${adds} −${dels}).`,
      body: el('div', { class: 'col', style: { gap: '10px' } },
        c.commits.length ? el('div', {}, el('div', { class: 'lbl' }, `Commits in ${head} not in ${base}`), commitList(c.commits, 8)) : el('div', { class: 'muted small' }, `${head} has nothing ${base} lacks.`),
        el('div', { class: 'lbl' }, plural(c.files.length, 'changed file')), el('div', { class: 'gl-cmp' }, files, diffHost)),
      actions: [{ label: 'Close', value: null }],
    });
  }

  // ---------- stashes ----------

  async function stashFlow() {
    const msg = el('input', { class: 'input', placeholder: 'what is this work? (optional)' });
    const unt = el('input', { type: 'checkbox', checked: true });
    const r = await modal({
      title: 'Stash changes', sub: 'Shelves your uncommitted work and gives you a clean tree. You can apply it again later; it is kept until you drop it.',
      body: el('div', { class: 'col', style: { gap: '10px', marginTop: '6px', minWidth: '380px' } }, msg, el('label', { class: 'row small', style: { gap: '6px' } }, unt, 'include untracked files')),
      actions: [{ label: 'Cancel', value: null }, { label: 'Stash', kind: 'primary', onpick: (close) => close({ message: msg.value.trim(), includeUntracked: unt.checked }) }],
    });
    if (!r) return;
    L.stashes = null;
    await act('stash', r, 'stashed');
  }

  async function paintStashes(host) {
    if (!L.stashes) {
      host.append(el('div', { class: 'empty' }, el('span', { class: 'spinner' })));
      try { L.stashes = (await get(api(L.repoId, 'stashes'))).stashes; } catch (e) { host.textContent = ''; host.append(el('div', { class: 'empty' }, '⚠ ' + e.message)); return; }
      if (L.sub === 'stashes') paint(true);
      return;
    }
    const list = el('div', { class: 'gl-btable' });
    for (const s of L.stashes) {
      list.append(el('div', { class: 'gl-brow' },
        el('span', { class: 'gl-bmark' }, '▤'),
        el('div', { class: 'gl-bmain' }, el('div', { class: 'gl-subj' }, s.message.replace(/^On [^:]+: /, '')), el('div', { class: 'muted small' }, el('span', { class: 'mono' }, s.ref), ' · ', when(s.at))),
        el('div', { class: 'gl-bacts' },
          el('button', { class: 'btn xs', onclick: () => previewStash(s) }, 'Preview'),
          el('button', { class: 'btn xs', title: 'Apply and keep the stash', onclick: () => applyStash(s, false) }, 'Apply'),
          el('button', { class: 'btn xs', title: 'Apply and remove the stash', onclick: () => applyStash(s, true) }, 'Pop'),
          el('button', { class: 'btn xs danger', onclick: async () => { if (await confirmBox('Drop this stash?', `${s.message}\nThe saved changes are deleted for good.`, 'Drop stash')) { L.stashes = null; await act('stash/drop', { oid: s.oid, confirm: true }, 'dropped'); } } }, 'Drop'))));
    }
    host.append(el('div', { class: 'gl-full' },
      el('div', { class: 'gl-histbar' }, el('span', { class: 'muted small' }, 'Work parked with “Stash changes”.'), el('span', { class: 'grow' }), el('button', { class: 'btn sm primary', onclick: stashFlow }, icon('save'), 'Stash changes')),
      el('div', { class: 'gl-files-scroll' }, L.stashes.length ? list : el('div', { class: 'empty' }, 'No stashes'))));
  }

  async function applyStash(s, drop) {
    L.stashes = null;
    const r = await act('stash/apply', { oid: s.oid, drop }, drop ? 'applied and removed' : 'applied (stash kept)');
    if (r) setSub('changes');
  }

  async function previewStash(s) {
    let d;
    try { d = await get(api(L.repoId, `stash/${s.oid}`)); } catch (e) { toast(e.message, 'err'); return; }
    await modal({
      title: s.message.replace(/^On [^:]+: /, ''), xl: true, sub: `${plural(d.files.length, 'file')} in ${s.ref}`,
      body: el('div', { class: 'col', style: { gap: '8px' } },
        el('div', { class: 'gl-files' }, ...d.files.map((f) => el('div', { class: 'gl-file' }, el('span', { class: 'gl-fname' }, el('span', { class: 'gl-fdir' }, dirName(f.path)), baseName(f.path)), pm(f.additions, f.deletions)))),
        d.diff ? el('div', { class: 'gl-diffbody gl-cmp-diff' }, ...splitPatch(d.diff).map((f) => el('details', { class: 'gl-review-file' }, el('summary', {}, el('span', { class: 'mono' }, f.path)), renderDiff(f.hunks)))) : null),
      actions: [{ label: 'Close', value: null }],
    });
  }

  // ---------- paint ----------

  function paint(keepScroll = false) {
    if (!L.visible) return;
    if (!L.repoId) { paintList(); return; }
    const scrollTop = keepScroll ? root.querySelector('.gl-files-scroll')?.scrollTop : 0;
    root.textContent = '';
    const r = row();
    if (!r) { backToList(); return; }
    const st = L.st;
    const tab = (v, label, n) => el('button', { class: 'seg-btn' + (L.sub === v ? ' on' : ''), onclick: () => setSub(v) }, label, n ? el('span', { class: 'gl-tab-n' }, n) : null);
    const seg = el('div', { class: 'gl-subtabs' },
      el('div', { class: 'seg' },
        tab('changes', 'Changes', st?.counts.total || 0), tab('history', 'History'), tab('branches', 'Branches', L.branches?.locals.length || 0), tab('stashes', 'Stashes', st?.stashCount || 0)),
      st ? el('span', { class: 'muted small' }, st.lastCommit ? el('span', {}, 'last commit ', el('span', { class: 'mono' }, st.lastCommit.short), ' ', st.lastCommit.subject.slice(0, 70), ' · ', when(st.lastCommit.at)) : 'no commits yet') : null);
    const host = el('div', { class: 'gl-split' + (L.sub === 'branches' || L.sub === 'stashes' ? ' single' : L.sub === 'history' ? ' hist' : '') });
    root.append(repoHeader(), seg);
    if (L.error && !st) {
      root.append(el('div', { class: 'empty' }, '⚠ ' + L.error, el('button', { class: 'btn sm', onclick: () => loadStatus() }, 'Retry')));
      return;
    }
    if (!st) { root.append(el('div', { class: 'empty' }, el('span', { class: 'spinner' }))); return; }
    root.append(host);
    if (L.sub === 'changes') paintChanges(host);
    else if (L.sub === 'history') paintHistory(host);
    else if (L.sub === 'branches') paintBranches(host);
    else paintStashes(host);
    if (scrollTop) requestAnimationFrame(() => { const s = root.querySelector('.gl-files-scroll'); if (s) s.scrollTop = scrollTop; });
  }

  // ---------- lifecycle ----------

  const onFocus = () => {
    if (!L.visible) return;
    clearTimeout(focusTimer);
    // coming back to the window: pick up commits made in a terminal meanwhile
    focusTimer = setTimeout(async () => {
      if (L.repoId) { if (!L.busy) { L.diffCache = null; await loadStatus(); } } else { await loadList(); if (!L.repoId) paint(); }
    }, 400);
  };
  window.addEventListener('focus', onFocus);

  return {
    root,
    async show() {
      L.visible = true;
      if (!L.rows.length || Date.now() - L.loadedAt > 20_000) {
        if (!L.rows.length) { root.textContent = ''; root.append(el('div', { class: 'empty' }, el('span', { class: 'spinner' }))); }
        await loadList();
      }
      if (L.repoId && !L.rows.some((r) => r.id === L.repoId)) L.repoId = null;
      paint();
      if (L.repoId) loadStatus();
    },
    hide() { L.visible = false; },
    dispose() { L.visible = false; window.removeEventListener('focus', onFocus); clearTimeout(focusTimer); },
    open: openRepo,
    refresh: async () => { await loadList(true); if (L.repoId) await loadStatus(); else paint(); },
  };
}

