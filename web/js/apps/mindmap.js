// Mindmaps: SVG tidy-tree with pan/zoom, inline node CRUD, AI generate/expand,
// autosave, and export into the vault.

import { el, icon, toast, askText, confirmBox, modelPicker, timeAgo, debounce } from '../ui.js';
import { get, post, put, del } from '../api.js';
import { openApp } from '../wm.js';

const NODE_H = 34, GAP_Y = 14, GAP_X = 70;

export default {
  id: 'mindmap', title: 'Mindmaps', icon: 'mindmap', width: 1060, height: 680,

  mount(body, opts, win) {
    const S = win.mmState = { map: null, sel: null, cam: { x: 60, y: 0, k: 1 }, svg: null, busy: false };
    const ui = {};

    ui.list = el('div', { class: 'side-list' });
    const side = el('div', { class: 'side' },
      el('div', { class: 'side-head' },
        el('span', { class: 'ttl' }, 'Maps'),
        el('button', { class: 'btn sm ghost', title: 'New map', onclick: newMap }, icon('plus')),
        el('button', { class: 'btn sm ghost', title: 'Generate with AI', onclick: aiNew }, icon('sparkle'))),
      ui.list);

    ui.model = modelPicker({ storageKey: 'mindmap' });
    ui.toolbar = el('div', { class: 'mm-toolbar' },
      el('button', { class: 'btn sm', onclick: () => addNode(true) }, icon('plus'), 'Child'),
      el('button', { class: 'btn sm', onclick: () => addNode(false) }, 'Sibling'),
      el('button', { class: 'btn sm', onclick: renameNode }, icon('edit'), 'Rename'),
      el('button', { class: 'btn sm danger', onclick: deleteNode }, icon('trash')),
      el('span', { style: { width: '10px' } }),
      el('button', { class: 'btn sm', onclick: aiExpand }, icon('sparkle'), 'AI expand'),
      ui.model,
      el('span', { class: 'grow' }),
      el('button', { class: 'btn sm', onclick: exportVault }, icon('vault'), 'To vault'),
      el('button', { class: 'btn sm ghost danger', title: 'Delete map', onclick: deleteMap }, icon('trash'), 'map'));

    ui.canvas = el('div', { class: 'mm-canvas' });
    ui.hint = el('div', { class: 'muted small', style: { padding: '4px 12px' } },
      'click: select · double-click: rename · Tab: child · Enter: sibling · Del: remove · drag bg: pan · wheel: zoom');

    body.append(el('div', { class: 'app-cols' }, side,
      el('div', { class: 'main-pane' }, ui.toolbar, ui.canvas, ui.hint)));

    // ---------- maps list ----------

    async function refreshList() {
      let maps = [];
      try { maps = await get('/mindmaps'); } catch { }
      ui.list.innerHTML = '';
      for (const m of maps) {
        ui.list.append(el('div', { class: 'side-item' + (m.id === S.map?.id ? ' sel' : ''), onclick: () => load(m.id) },
          m.name, el('div', { class: 'sub' }, `${m.nodes} nodes · ${timeAgo(m.updatedAt)}`)));
      }
      if (!maps.length) ui.list.append(el('div', { class: 'empty', style: { minHeight: '70px' } }, 'no maps yet'));
    }

    async function newMap() {
      const name = await askText({ title: 'New mindmap', placeholder: 'Central idea', ok: 'Create' });
      if (!name) return;
      const m = await post('/mindmaps', { name });
      await load(m.id);
      refreshList();
    }

    async function aiNew() {
      if (!ui.model.getValue()) { toast('pick a model in the toolbar', 'err'); return; }
      const topic = await askText({ title: 'Generate a mindmap', sub: 'The AI designs the whole tree — you can edit and expand it after.', placeholder: 'e.g. Learning Rust, Home lab setup, Novel plot…', ok: 'Generate' });
      if (!topic) return;
      setBusy(true, 'designing map…');
      try {
        const m = await post('/mindmaps/generate', { topic, modelRef: ui.model.getValue() });
        await load(m.id);
        refreshList();
      } catch (e) { toast(e.message, 'err'); }
      setBusy(false);
    }

    async function load(id) {
      S.map = await get('/mindmaps/' + id);
      S.sel = S.map.root.id;
      S.cam = { x: 60, y: 0, k: 1 };
      render();
      refreshList();
    }

    async function deleteMap() {
      if (!S.map) return;
      if (!await confirmBox('Delete this mindmap?', S.map.name)) return;
      await del('/mindmaps/' + S.map.id);
      S.map = null; render(); refreshList();
    }

    const autosave = debounce(async () => {
      if (!S.map) return;
      try { await put('/mindmaps/' + S.map.id, { root: S.map.root, name: S.map.name }); refreshList(); }
      catch (e) { toast('save failed: ' + e.message, 'err'); }
    }, 700);

    // ---------- tree ops ----------

    const findNode = (n, id) => n.id === id ? n : (n.children || []).reduce((r, c) => r || findNode(c, id), null);
    const findParent = (n, id) => (n.children || []).some(c => c.id === id) ? n : (n.children || []).reduce((r, c) => r || findParent(c, id), null);
    const genId = () => Math.random().toString(36).slice(2, 9);

    async function addNode(asChild) {
      if (!S.map || !S.sel) return;
      const text = await askText({ title: asChild ? 'New child node' : 'New sibling node', placeholder: 'label', ok: 'Add' });
      if (!text) return;
      const node = { id: genId(), text, children: [] };
      if (asChild) {
        const p = findNode(S.map.root, S.sel);
        p.children = p.children || []; p.children.push(node); p.collapsed = false;
      } else {
        const p = findParent(S.map.root, S.sel);
        if (!p) { toast('root has no siblings'); return; }
        p.children.splice(p.children.findIndex(c => c.id === S.sel) + 1, 0, node);
      }
      S.sel = node.id;
      render(); autosave();
    }

    async function renameNode() {
      if (!S.map || !S.sel) return;
      const n = findNode(S.map.root, S.sel);
      const text = await askText({ title: 'Rename node', value: n.text, ok: 'Rename' });
      if (!text) return;
      n.text = text;
      if (n === S.map.root) S.map.name = text;
      render(); autosave();
    }

    function deleteNode() {
      if (!S.map || !S.sel) return;
      if (S.sel === S.map.root.id) { toast('cannot delete the root'); return; }
      const p = findParent(S.map.root, S.sel);
      p.children = p.children.filter(c => c.id !== S.sel);
      S.sel = p.id;
      render(); autosave();
    }

    async function aiExpand() {
      if (!S.map || !S.sel) return;
      if (!ui.model.getValue()) { toast('pick a model in the toolbar', 'err'); return; }
      setBusy(true, 'expanding branch…');
      try {
        await put('/mindmaps/' + S.map.id, { root: S.map.root, name: S.map.name }); // sync first
        await post(`/mindmaps/${S.map.id}/expand`, { nodeId: S.sel, modelRef: ui.model.getValue(), count: 4 });
        const fresh = await get('/mindmaps/' + S.map.id);
        S.map = fresh;
        const n = findNode(S.map.root, S.sel);
        if (n) n.collapsed = false;
        render(); refreshList();
      } catch (e) { toast(e.message, 'err'); }
      setBusy(false);
    }

    async function exportVault() {
      if (!S.map) return;
      try {
        const r = await post(`/mindmaps/${S.map.id}/export`, { wikilinks: false });
        toast('exported to ' + r.path, 'ok');
        openApp('vault', { note: r.path });
      } catch (e) { toast(e.message, 'err'); }
    }

    function setBusy(v, msg) {
      S.busy = v;
      ui.hint.textContent = v ? msg : 'click: select · double-click: rename · Tab: child · Enter: sibling · Del: remove · drag bg: pan · wheel: zoom';
    }

    // ---------- layout & render ----------

    const textW = (t) => Math.min(Math.max(t.length * 6.6 + 26, 60), 240);

    function layout(node, depth = 0, y0 = 0) {
      // returns subtree height; assigns node._x,_y,_w
      node._w = textW(node.text);
      const kids = node.collapsed ? [] : (node.children || []);
      if (!kids.length) {
        node._h = NODE_H;
        node._y = y0;
      } else {
        let y = y0, total = 0;
        for (const c of kids) {
          const h = layout(c, depth + 1, y);
          y += h + GAP_Y; total += h + GAP_Y;
        }
        total -= GAP_Y;
        node._h = Math.max(NODE_H, total);
        node._y = y0 + (total - NODE_H) / 2;
      }
      node._x = depth === 0 ? 0 : undefined; // x assigned in second pass
      return node._h;
    }

    function assignX(node, x = 0) {
      node._px = x;
      const kids = node.collapsed ? [] : (node.children || []);
      for (const c of kids) assignX(c, x + node._w + GAP_X);
    }

    function render() {
      ui.canvas.innerHTML = '';
      if (!S.map) {
        ui.canvas.append(el('div', { class: 'empty' },
          el('div', { class: 'big' }, 'Mindmaps'),
          'Create a map by hand, or let a model design one for you.',
          el('div', { class: 'row' },
            el('button', { class: 'btn', onclick: newMap }, 'New map'),
            el('button', { class: 'btn primary', onclick: aiNew }, '✦ Generate with AI'))));
        return;
      }
      layout(S.map.root);
      assignX(S.map.root);

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      S.svg = svg;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      svg.append(g);
      const apply = () => g.setAttribute('transform', `translate(${S.cam.x},${S.cam.y + ui.canvas.clientHeight / 2}) scale(${S.cam.k})`);
      apply();

      const drawEdges = (n) => {
        const kids = n.collapsed ? [] : (n.children || []);
        for (const c of kids) {
          const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          const x1 = n._px + n._w, y1 = n._y + NODE_H / 2 - S.map.root._y - S.map.root._h / 2 + NODE_H / 2;
          const x2 = c._px, y2 = c._y + NODE_H / 2 - S.map.root._y - S.map.root._h / 2 + NODE_H / 2;
          p.setAttribute('d', `M ${x1} ${y1} C ${x1 + GAP_X / 2} ${y1}, ${x2 - GAP_X / 2} ${y2}, ${x2} ${y2}`);
          p.setAttribute('class', 'mm-edge');
          g.append(p);
          drawEdges(c);
        }
      };

      const drawNodes = (n, isRoot = false) => {
        const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const y = n._y - S.map.root._y - S.map.root._h / 2 + NODE_H / 2;
        grp.setAttribute('transform', `translate(${n._px},${y})`);
        grp.setAttribute('class', 'mm-node' + (isRoot ? ' root' : '') + (n.id === S.sel ? ' sel' : ''));
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('width', n._w); rect.setAttribute('height', NODE_H);
        rect.setAttribute('rx', 9);
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', 13); text.setAttribute('y', NODE_H / 2 + 4);
        text.textContent = n.text.length > 34 ? n.text.slice(0, 33) + '…' : n.text;
        grp.append(rect, text);
        if (n.children?.length) {
          const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          badge.setAttribute('x', n._w - 4); badge.setAttribute('y', NODE_H / 2 + 3.5);
          badge.setAttribute('class', 'mm-count');
          badge.textContent = n.collapsed ? '+' + countAll(n) : '';
          grp.append(badge);
        }
        grp.addEventListener('click', (e) => { e.stopPropagation(); S.sel = n.id; render(); });
        grp.addEventListener('dblclick', (e) => { e.stopPropagation(); S.sel = n.id; renameNode(); });
        grp.addEventListener('contextmenu', (e) => {
          e.preventDefault(); e.stopPropagation();
          S.sel = n.id;
          n.collapsed = !n.collapsed;
          render(); autosave();
        });
        g.append(grp);
        const kids = n.collapsed ? [] : (n.children || []);
        for (const c of kids) drawNodes(c);
      };

      drawEdges(S.map.root);
      drawNodes(S.map.root, true);
      ui.canvas.append(svg);

      // pan & zoom
      let pan = null;
      svg.addEventListener('mousedown', (e) => { pan = { mx: e.clientX, my: e.clientY, x: S.cam.x, y: S.cam.y }; svg.classList.add('panning'); });
      addEventListener('mousemove', (e) => { if (pan) { S.cam.x = pan.x + e.clientX - pan.mx; S.cam.y = pan.y + e.clientY - pan.my; apply(); } });
      addEventListener('mouseup', () => { pan = null; svg.classList.remove('panning'); });
      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        S.cam.k = Math.min(2.5, Math.max(0.3, S.cam.k * (e.deltaY > 0 ? 0.9 : 1.1)));
        apply();
      }, { passive: false });
    }

    const countAll = (n) => (n.children || []).reduce((s, c) => s + 1 + countAll(c), 0);

    body.addEventListener('keydown', (e) => {
      if (!S.map || S.busy) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Tab') { e.preventDefault(); addNode(true); }
      else if (e.key === 'Enter') { e.preventDefault(); addNode(false); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteNode(); }
      else if (e.key === 'F2') { e.preventDefault(); renameNode(); }
    });

    refreshList().then(async () => {
      if (opts.fresh) { newMap(); return; }
      try {
        const maps = await get('/mindmaps');
        if (maps.length) load(maps[0].id); else render();
      } catch { render(); }
    });
    this.reopen = (w, o) => { if (o?.fresh) newMap(); };
  },

  resized(win) { /* svg is 100% — nothing to do */ },
};
