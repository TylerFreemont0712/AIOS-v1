// Files: lazy tree explorer + CodeMirror editor with save/rename/delete,
// image preview and markdown preview. Scoped to registered roots.

import {
  EditorView, EditorState, basicSetup, keymap, indentWithTab, oneDark,
  javascript, python, markdown, html, css, json, indentUnit,
} from '../../vendor/codemirror.js';
import { el, icon, toast, menu, askText, confirmBox, fmtBytes, debounce } from '../ui.js';
import { get, put, post } from '../api.js';
import { state, on } from '../state.js';
import { renderMd } from '../markdown.js';

const langFor = (path) => {
  const ext = path.split('.').pop().toLowerCase();
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) return javascript({ typescript: ext.startsWith('ts'), jsx: ext.endsWith('x') });
  if (ext === 'py') return python();
  if (['md', 'markdown'].includes(ext)) return markdown();
  if (['html', 'htm', 'vue', 'svelte', 'xml'].includes(ext)) return html();
  if (ext === 'css') return css();
  if (ext === 'json') return json();
  return [];
};
const isImg = (p) => /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(p);

export default {
  id: 'files', title: 'Files', icon: 'files', width: 1080, height: 700,

  mount(body, opts, win) {
    const S = win.filesState = { root: null, file: null, view: null, dirty: false, mtime: 0, offs: [], mdPreview: false };
    const ui = {};

    ui.rootSel = el('select', { class: 'select', style: { fontSize: '12px', padding: '4px 8px' } });
    ui.rootSel.addEventListener('change', () => { S.root = ui.rootSel.value; loadTree(); });

    ui.search = el('input', { class: 'input', placeholder: 'search files…', style: { fontSize: '12px', padding: '5px 9px' } });
    ui.searchResults = el('div', { style: { display: 'none' } });
    ui.tree = el('div', { class: 'ftree' });

    const side = el('div', { class: 'side', style: { width: '260px' } },
      el('div', { class: 'side-head' }, ui.rootSel,
        el('button', { class: 'btn sm ghost', title: 'New file', onclick: () => newEntry(false) }, icon('plus')),
        el('button', { class: 'btn sm ghost', title: 'Refresh', onclick: () => loadTree() }, icon('refresh'))),
      el('div', { style: { padding: '0 10px 8px' } }, ui.search),
      ui.searchResults, ui.tree);

    ui.pathLabel = el('span', { class: 'ttl mono', style: { fontSize: '12.5px' } }, 'no file open');
    ui.dirtyDot = el('span', { class: 'dirty-dot', style: { display: 'none' } });
    ui.saveBtn = el('button', { class: 'btn sm', onclick: () => save() }, icon('save'), 'Save');
    ui.previewBtn = el('button', { class: 'btn sm ghost', style: { display: 'none' }, onclick: () => { S.mdPreview = !S.mdPreview; renderEditorArea(); } }, icon('eye'), 'Preview');
    ui.head = el('div', { class: 'pane-head' }, ui.pathLabel, ui.dirtyDot, el('span', { class: 'grow' }), ui.previewBtn, ui.saveBtn);
    ui.editorArea = el('div', { class: 'editor-holder' });

    body.append(el('div', { class: 'app-cols' }, side, el('div', { class: 'main-pane' }, ui.head, ui.editorArea)));

    // ---------- roots & tree ----------

    async function loadRoots(keepRoot) {
      let roots = [];
      try { roots = await get('/fs/roots'); } catch { }
      ui.rootSel.innerHTML = '';
      for (const r of roots) ui.rootSel.append(el('option', { value: r.id }, r.name));
      if (!roots.length) { ui.tree.innerHTML = ''; ui.tree.append(el('div', { class: 'empty' }, 'no roots — register a project first')); return; }
      const prefer = keepRoot || (state.project?.id && roots.find(r => r.id === state.project.id)?.id) || roots[0].id;
      ui.rootSel.value = prefer;
      S.root = prefer;
      loadTree();
    }

    async function loadTree() {
      ui.tree.innerHTML = '';
      ui.tree.append(await dirChildren(''));
    }

    async function dirChildren(relPath) {
      const box = el('div', { class: relPath ? 'fkids' : '' });
      let data;
      try { data = await get(`/fs/tree?root=${encodeURIComponent(S.root)}&path=${encodeURIComponent(relPath)}`); }
      catch (e) { box.append(el('div', { class: 'muted small', style: { padding: '4px 10px' } }, e.message)); return box; }
      for (const e2 of data.entries) {
        const p = relPath ? relPath + '/' + e2.name : e2.name;
        box.append(e2.dir ? dirNode(p, e2.name) : fileNode(p, e2.name));
      }
      if (!data.entries.length) box.append(el('div', { class: 'muted small', style: { padding: '2px 10px' } }, 'empty'));
      return box;
    }

    function dirNode(path, name) {
      let open = false, kids = null;
      const chev = icon('chevR');
      const node = el('div', { class: 'fnode dir' }, chev, icon('folder'), el('span', { class: 'fname' }, name));
      const wrap = el('div', {}, node);
      node.addEventListener('click', async () => {
        open = !open;
        chev.firstChild.style.transform = open ? 'rotate(90deg)' : '';
        if (open && !kids) { kids = await dirChildren(path); wrap.append(kids); }
        else if (kids) kids.style.display = open ? '' : 'none';
      });
      node.addEventListener('contextmenu', (e) => ctxMenu(e, path, true));
      return wrap;
    }

    function fileNode(path, name) {
      const node = el('div', { class: 'fnode', dataset: { path } }, el('span', { style: { width: '14px', flex: 'none' } }), icon('file'), el('span', { class: 'fname' }, name));
      node.addEventListener('click', () => openFile(path));
      node.addEventListener('contextmenu', (e) => ctxMenu(e, path, false));
      return node;
    }

    function ctxMenu(e, path, isDir) {
      e.preventDefault();
      menu(e.clientX, e.clientY, [
        isDir && { label: 'New file here', icon: 'plus', onclick: () => newEntry(false, path) },
        isDir && { label: 'New folder here', icon: 'folder', onclick: () => newEntry(true, path) },
        { label: 'Rename', icon: 'edit', onclick: async () => {
          const nn = await askText({ title: 'Rename', value: path, ok: 'Rename' });
          if (nn && nn !== path) { await post('/fs/rename', { root: S.root, from: path, to: nn }); loadTree(); toast('renamed', 'ok'); }
        } },
        '-',
        { label: 'Delete', icon: 'trash', danger: true, onclick: async () => {
          if (!await confirmBox(`Delete ${path}?`, isDir ? 'The folder and its contents will be removed.' : 'The file will be removed.')) return;
          await post('/fs/delete', { root: S.root, path });
          if (S.file === path) { S.file = null; renderEditorArea(); }
          loadTree(); toast('deleted', 'ok');
        } },
      ].filter(Boolean));
    }

    async function newEntry(isDir, base = '') {
      const name = await askText({ title: isDir ? 'New folder' : 'New file', sub: base ? 'inside ' + base : 'at project root', placeholder: isDir ? 'folder name' : 'name.ext', ok: 'Create' });
      if (!name) return;
      const path = base ? base + '/' + name : name;
      if (isDir) await post('/fs/mkdir', { root: S.root, path });
      else await put('/fs/file', { root: S.root, path, content: '' });
      loadTree();
      if (!isDir) openFile(path);
    }

    // ---------- search ----------

    ui.search.addEventListener('input', debounce(async () => {
      const q = ui.search.value.trim();
      if (q.length < 2) { ui.searchResults.style.display = 'none'; ui.tree.style.display = ''; return; }
      let hits = [];
      try { hits = await get(`/fs/search?root=${encodeURIComponent(S.root)}&q=${encodeURIComponent(q)}`); } catch { }
      ui.searchResults.innerHTML = '';
      ui.searchResults.style.display = ''; ui.tree.style.display = 'none';
      ui.searchResults.className = 'ftree';
      for (const h of hits) {
        ui.searchResults.append(el('div', { class: 'fnode', onclick: () => openFile(h.path) },
          icon(h.kind === 'name' ? 'file' : 'search'),
          el('span', { class: 'fname', title: h.excerpt || '' }, h.path + (h.line ? ':' + h.line : ''))));
      }
      if (!hits.length) ui.searchResults.append(el('div', { class: 'muted small', style: { padding: '6px 10px' } }, 'no matches'));
    }, 280));

    // ---------- editor ----------

    async function openFile(path) {
      if (S.dirty && !await confirmBox('Discard unsaved changes?', S.file + ' has edits that are not saved.', 'Discard')) return;
      S.file = path; S.dirty = false; S.mdPreview = false;
      for (const n of ui.tree.querySelectorAll('.fnode.sel')) n.classList.remove('sel');
      ui.tree.querySelector(`[data-path="${CSS.escape(path)}"]`)?.classList.add('sel');
      renderEditorArea();
    }

    async function renderEditorArea() {
      ui.editorArea.innerHTML = '';
      S.view?.destroy(); S.view = null;
      ui.previewBtn.style.display = 'none';
      updateHead();
      if (!S.file) { ui.editorArea.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, 'Open a file'), 'Pick something from the tree, or right-click for actions.')); return; }

      if (isImg(S.file)) {
        const img = el('img', { src: `/api/fs/raw?root=${encodeURIComponent(S.root)}&path=${encodeURIComponent(S.file)}${tokenParam()}` });
        ui.editorArea.append(el('div', { class: 'img-preview' }, img));
        return;
      }

      let data;
      try { data = await get(`/fs/file?root=${encodeURIComponent(S.root)}&path=${encodeURIComponent(S.file)}`); }
      catch (e) { ui.editorArea.append(el('div', { class: 'empty' }, e.message)); return; }
      if (data.binary) { ui.editorArea.append(el('div', { class: 'empty' }, `binary file · ${fmtBytes(data.size)}`)); return; }
      S.mtime = data.mtime;

      const isMd = /\.(md|markdown)$/i.test(S.file);
      ui.previewBtn.style.display = isMd ? '' : 'none';

      if (isMd && S.mdPreview) {
        ui.editorArea.append(el('div', { class: 'md-preview' }, renderMd(data.content)));
        return;
      }

      const dark = document.documentElement.dataset.mode === 'dark';
      S.view = new EditorView({
        parent: ui.editorArea,
        state: EditorState.create({
          doc: data.content,
          extensions: [
            basicSetup, keymap.of([indentWithTab]), langFor(S.file), indentUnit.of('  '),
            dark ? oneDark : [],
            EditorView.updateListener.of(u => { if (u.docChanged && !S.dirty) { S.dirty = true; updateHead(); } }),
            EditorView.theme({ '&': { height: '100%' } }),
          ],
        }),
      });
    }

    function tokenParam() {
      const t = localStorage.getItem('aios.token');
      return t ? '&token=' + encodeURIComponent(t) : '';
    }

    function updateHead() {
      ui.pathLabel.textContent = S.file || 'no file open';
      ui.dirtyDot.style.display = S.dirty ? '' : 'none';
      ui.saveBtn.disabled = !S.dirty;
    }

    async function save() {
      if (!S.file || !S.view || !S.dirty) return;
      try {
        const r = await put('/fs/file', { root: S.root, path: S.file, content: S.view.state.doc.toString(), mtime: S.mtime });
        S.mtime = r.mtime; S.dirty = false; updateHead();
        toast('saved ' + S.file, 'ok');
      } catch (e) {
        if (e.message.includes('changed on disk')) {
          if (await confirmBox('File changed on disk', 'Someone (maybe the agent) modified this file while you were editing. Overwrite with your version?', 'Overwrite')) {
            const r = await put('/fs/file', { root: S.root, path: S.file, content: S.view.state.doc.toString() });
            S.mtime = r.mtime; S.dirty = false; updateHead();
          }
        } else toast(e.message, 'err');
      }
    }

    body.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
    });

    S.offs.push(on('project', () => loadRoots(null)));
    loadRoots(opts.root).then(() => { if (opts.file) { S.root = opts.root || S.root; openFile(opts.file); } });
    this.reopen = (w, o) => { if (o?.file) { if (o.root) { S.root = o.root; ui.rootSel.value = o.root; } openFile(o.file); } };
  },

  unmount(win) {
    win.filesState?.view?.destroy();
    win.filesState?.offs?.forEach(off => off());
  },
};
