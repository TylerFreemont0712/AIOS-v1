// Files — browse the box and read what's on it.
//
// Read-only on purpose. Editing source on a phone is not a thing anyone wants to do,
// and a stray tap that writes to a file in a project is a bad way to find out the
// screen exists. Looking at a config, a log tail, or a README from the train is.

import { get } from '../../api.js';
import { el, fill, icon, toast, sheet, ICONS, loading, empty, errorBox, relTime, debounce } from '../ui.js';
import { renderMarkdown, enhanceCode, escapeHtml } from '../md.js';

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|css|html|py|sh|bash|yml|yaml|toml|ini|conf|sql|rs|go|java|c|h|cpp|rb|php|swift|kt)$/i;
const TEXT_EXT = /\.(md|markdown|txt|log|env|gitignore|editorconfig)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

const fmtSize = (n) => n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
  : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

export default async function filesScreen({ host, ui }) {
  let roots = [];
  let root = null;          // { id, path, name }
  let cwd = '';             // path relative to root
  const stack = [];         // breadcrumb of previous cwds, for Back

  const crumbs = el('div', { class: 'm-crumbs' });
  const scroll = el('div', { class: 'm-scroll' });
  host.append(crumbs, scroll);

  ui.setTitle('Files');

  // ---------- navigation ----------

  function renderCrumbs() {
    if (!root) return fill(crumbs);
    const parts = cwd ? cwd.split('/') : [];
    fill(crumbs,
      el('button', { class: 'm-crumb', onclick: () => openDir('') }, root.name),
      ...parts.map((p, i) => el('button', {
        class: 'm-crumb' + (i === parts.length - 1 ? ' is-on' : ''),
        onclick: () => openDir(parts.slice(0, i + 1).join('/')),
      }, p)),
    );
    crumbs.scrollLeft = crumbs.scrollWidth;
  }

  function setBrowseActions() {
    ui.setLeft(cwd || root
      ? el('button', { class: 'm-head-btn', 'aria-label': 'Up', onclick: goUp }, el('span', { html: ICONS.back }))
      : null);
    ui.setActions(ui.action('folder', 'Change root', pickRoot));
  }

  function goUp() {
    if (cwd) return openDir(cwd.includes('/') ? cwd.slice(0, cwd.lastIndexOf('/')) : '');
    pickRoot();
  }

  function pickRoot() {
    sheet('Location', (body, close) => {
      body.append(el('div', { class: 'm-menu' }, ...roots.map(r => el('button', {
        class: 'm-menu-row' + (r.id === root?.id ? ' is-on' : ''),
        onclick: () => { close(); root = r; openDir(''); },
      }, icon('folder', 'm-menu-i'),
        el('div', { class: 'm-grow' },
          el('div', { class: 'm-menu-t' }, r.name),
          el('div', { class: 'm-menu-d' }, r.path))))));
    });
  }

  // ---------- listing ----------

  async function openDir(path) {
    cwd = path;
    ui.setTitle(root?.name || 'Files', cwd || '');
    setBrowseActions();
    renderCrumbs();
    fill(scroll, loading());
    try {
      const r = await get(`/fs/tree?root=${encodeURIComponent(root.id)}&path=${encodeURIComponent(path)}`);
      const entries = r.entries || [];
      // Directories first, then names — the ordering every file manager uses, and the
      // server returns raw readdir order.
      entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      if (!entries.length) return fill(scroll, empty('Empty folder'));
      fill(scroll, el('div', { class: 'm-rows' }, ...entries.map(entryRow)));
      scroll.scrollTop = 0;
    } catch (e) {
      fill(scroll, errorBox(e, () => openDir(path)));
    }
  }

  const entryRow = (e) => el('button', {
    class: 'm-row m-row-tap',
    onclick: () => e.dir ? openDir(cwd ? `${cwd}/${e.name}` : e.name) : openFile(cwd ? `${cwd}/${e.name}` : e.name, e),
  },
    el('span', { class: 'm-row-i', html: e.dir ? ICONS.folder : ICONS.file }),
    el('div', { class: 'm-grow' },
      el('div', { class: 'm-row-t' }, e.name),
      el('div', { class: 'm-row-m' }, [e.dir ? '' : fmtSize(e.size), relTime(new Date(e.mtime).toISOString())].filter(Boolean).join(' · '))),
    e.dir ? el('span', { class: 'm-row-chev' }, '›') : null);

  // ---------- viewing ----------

  async function openFile(path, entry) {
    if (IMG_EXT.test(path)) return openImage(path);
    if (entry?.size > 2 * 1024 * 1024) return toast('Too large to open on a phone', 'err');

    ui.setTitle(path.split('/').pop(), cwd);
    ui.setLeft(el('button', { class: 'm-head-btn', 'aria-label': 'Back', onclick: () => openDir(cwd) }, el('span', { html: ICONS.back })));
    ui.setActions();
    fill(scroll, loading());

    try {
      const r = await get(`/fs/file?root=${encodeURIComponent(root.id)}&path=${encodeURIComponent(path)}`);
      // The server flags binaries rather than sending mojibake; trust that over the
      // extension, which is absent on plenty of files worth opening.
      if (r.binary) return fill(scroll, empty('Binary file', `${fmtSize(r.size || 0)} — nothing to show.`));
      const text = r.content ?? r.text ?? '';
      let node;
      if (/\.(md|markdown)$/i.test(path)) {
        node = el('article', { class: 'm-md' });
        node.innerHTML = renderMarkdown(text);
        enhanceCode(node);
      } else if (CODE_EXT.test(path) || TEXT_EXT.test(path) || !/\./.test(path.split('/').pop())) {
        node = el('pre', { class: 'm-pre m-filepre' }, text);
      } else {
        node = empty('Not a text file', 'Only text and images open here.');
      }
      fill(scroll, node);
      scroll.scrollTop = 0;
    } catch (e) {
      fill(scroll, errorBox(e, () => openFile(path, entry)));
    }
  }

  function openImage(path) {
    // /fs/raw is fetched by the browser directly, so the token has to ride the URL —
    // an <img src> cannot carry an Authorization header.
    const token = localStorage.getItem('aios.token') || '';
    const src = `/api/fs/raw?root=${encodeURIComponent(root.id)}&path=${encodeURIComponent(path)}`
      + (token ? `&token=${encodeURIComponent(token)}` : '');
    sheet(path.split('/').pop(), (body) => {
      body.append(el('img', { class: 'm-img', src, alt: path }));
    });
  }

  // ---------- boot ----------

  try {
    roots = await get('/fs/roots');
    // An early return here used to hand the router an element instead of a screen
    // handle. It survived only because the caller uses `api?.unmount?.()`.
    if (!roots.length) fill(scroll, empty('No locations', 'Register a project on the desktop, or set a vault path.'));
    else { root = roots[0]; await openDir(''); }
  } catch (e) {
    fill(scroll, errorBox(e, () => location.reload()));
  }

  return { unmount() { } };
}
