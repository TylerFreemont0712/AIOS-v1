// Vault: your Obsidian second brain. Browse/edit notes, follow [[wikilinks]],
// see backlinks, view the link graph, and grow the vault with AI.

import {
  EditorView, EditorState, basicSetup, keymap, indentWithTab, oneDark, markdown, indentUnit,
} from '../../vendor/codemirror.js';
import { el, icon, icons, toast, askText, confirmBox, modelPicker, debounce } from '../ui.js';
import { get, post, put, wsSend, sub } from '../api.js';
import { state, refreshConfig } from '../state.js';
import { renderMd } from '../markdown.js';

let reqSeq = 0;

export default {
  id: 'vault', title: 'Second Brain', icon: 'vault', width: 1160, height: 720,

  mount(body, opts, win) {
    const S = win.vaultState = { note: null, view: null, dirty: false, preview: true, mode: 'notes', unsubs: [] };
    // expanded folders in the tree sidebar, remembered across sessions
    const OPEN_KEY = 'aios.vault.openFolders';
    try { S.open = new Set(JSON.parse(localStorage.getItem(OPEN_KEY)) || []); }
    catch { S.open = new Set(); }
    if (!S.open.size) S.open.add(state.config?.vault?.wikiFolder || 'AI Wiki');
    const saveOpen = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...S.open])); } catch { } };
    const ui = {};
    body.classList.add('col');
    const root = el('div', { class: 'app-cols', style: { flex: '1', minHeight: '0' } });
    body.append(root);

    init();

    async function init() {
      let status = null;
      try { status = await get('/vault/status'); } catch { }
      if (!status?.exists) { renderSetup(status); return; }
      renderMain();
    }

    // ---------- setup ----------

    function renderSetup(status) {
      root.innerHTML = '';
      const input = el('input', { class: 'input', placeholder: '/home/you/Documents/MyVault', value: status?.path || '' });
      root.append(el('div', { class: 'main-pane' }, el('div', { class: 'empty' },
        el('div', { class: 'big' }, 'Connect your Obsidian vault'),
        el('div', { class: 'muted', style: { maxWidth: '440px' } },
          'Point AIOS at your vault folder — it reads and writes the same markdown files Obsidian does. No vault yet? Enter a path and create one.'),
        el('div', { style: { width: 'min(440px, 90%)' } }, input),
        el('div', { class: 'row' },
          el('button', { class: 'btn primary', onclick: () => connect(false) }, 'Connect'),
          el('button', { class: 'btn', onclick: () => connect(true) }, 'Create new vault here')),
      )));
      async function connect(create) {
        if (!input.value.trim()) return;
        try {
          await post('/vault/path', { path: input.value.trim(), create });
          await refreshConfig();
          toast('vault connected', 'ok');
          renderMain();
        } catch (e) { toast(e.message, 'err'); }
      }
    }

    // ---------- main layout ----------

    function renderMain() {
      root.innerHTML = '';
      ui.search = el('input', { class: 'input', placeholder: 'search notes…', style: { fontSize: '12px', padding: '5px 9px' } });
      ui.noteList = el('div', { class: 'side-list' });
      const side = el('div', { class: 'side vault-side' },
        el('div', { class: 'side-head' },
          el('span', { class: 'ttl' }, 'Notes'),
          el('button', {
            class: 'btn sm ghost', title: 'Rebuild + open the wiki Home index',
            onclick: async () => {
              try {
                const r = await post('/vault/wiki/index', {});
                toast(`wiki index rebuilt (${r.notes} notes)`, 'ok');
                refreshList();
                openNote(r.path);
              } catch (e) { toast(e.message, 'err'); }
            },
          }, icon('home')),
          el('button', { class: 'btn sm ghost', title: 'Graph view', onclick: () => { S.mode = S.mode === 'graph' ? 'notes' : 'graph'; paintCenter(); } }, icon('graph')),
          el('button', { class: 'btn sm ghost', title: 'New note', onclick: newNote }, icon('plus'))),
        el('div', { class: 'vault-search' }, ui.search),
        ui.noteList);

      ui.title = el('span', { class: 'ttl' }, 'pick a note');
      ui.dirtyDot = el('span', { class: 'dirty-dot', style: { display: 'none' } });
      ui.editBtn = el('button', { class: 'btn sm ghost', onclick: () => { S.preview = !S.preview; paintNote(); } }, icon('edit'), 'Edit');
      ui.saveBtn = el('button', { class: 'btn sm', style: { display: 'none' }, onclick: save }, icon('save'), 'Save');
      ui.center = el('div', { class: 'vault-editor' });
      const mainPane = el('div', { class: 'main-pane' },
        el('div', { class: 'pane-head' }, ui.title, ui.dirtyDot, el('span', { class: 'grow' }), ui.editBtn, ui.saveBtn,
          el('button', { class: 'btn sm ghost', title: 'Summarize with AI', onclick: aiSummarize }, icon('sparkle')),
          el('button', { class: 'btn sm ghost danger', title: 'Delete note', onclick: deleteNote }, icon('trash'))),
        ui.center);

      ui.backlinks = el('div', {});
      ui.tags = el('div', { class: 'tag-row' });
      ui.aiBox = el('div', { class: 'ai-box col' });
      const right = el('div', { class: 'vault-right' },
        el('div', { class: 'vr-section' }, el('div', { class: 'ttl' }, 'AI'), ui.aiBox),
        el('div', { class: 'vr-section' }, el('div', { class: 'ttl' }, 'Backlinks'), ui.backlinks),
        el('div', { class: 'vr-section' }, el('div', { class: 'ttl' }, 'Tags'), ui.tags));

      root.append(side, mainPane, right);
      renderAIBox();
      refreshList();
      ui.search.addEventListener('input', debounce(refreshList, 240));
      if (opts.note) openNote(opts.note);
    }

    // ---------- note list ----------

    async function refreshList() {
      const q = ui.search.value?.trim();
      let notes = [];
      try { notes = q ? await get('/vault/search?q=' + encodeURIComponent(q)) : await get('/vault/notes'); }
      catch (e) { toast(e.message, 'err'); return; }
      ui.noteList.innerHTML = '';
      if (!notes.length) { ui.noteList.append(el('div', { class: 'empty', style: { minHeight: '60px' } }, q ? 'no matches' : 'vault is empty')); return; }

      if (q) {
        // search: flat, score-ordered, with excerpts
        for (const n of notes.slice(0, 200)) {
          ui.noteList.append(el('div', { class: 'note-item' + (n.path === S.note ? ' sel' : ''), onclick: () => openNote(n.path) },
            el('div', { class: 'n-title' }, n.title),
            el('div', { class: 'n-sub' }, n.folder ? n.folder + ' · ' : '', n.excerpt || '')));
        }
        return;
      }
      renderTree(notes);
    }

    // Obsidian-like directory tree: collapsible folders first (alphabetical),
    // then root notes. Expanded state persists in localStorage.
    function renderTree(notes) {
      const root = { folders: new Map(), notes: [] };
      for (const n of notes) {
        let cur = root;
        if (n.folder) for (const part of n.folder.split('/')) {
          if (!cur.folders.has(part)) cur.folders.set(part, { folders: new Map(), notes: [] });
          cur = cur.folders.get(part);
        }
        cur.notes.push(n);
      }
      const countAll = (node) => node.notes.length + [...node.folders.values()].reduce((s, f) => s + countAll(f), 0);
      const noteRow = (n, depth) =>
        el('div', {
          class: 'note-item tree-note' + (n.path === S.note ? ' sel' : ''),
          style: { paddingLeft: `${10 + depth * 14}px` },
          title: n.path, onclick: () => openNote(n.path),
        }, el('div', { class: 'n-title' }, n.title));

      const paint = (node, depth, parentPath, into) => {
        for (const name of [...node.folders.keys()].sort((a, b) => a.localeCompare(b))) {
          const full = parentPath ? `${parentPath}/${name}` : name;
          const child = node.folders.get(name);
          const open = S.open.has(full);
          into.append(el('div', {
            class: 'tree-folder' + (open ? ' open' : ''),
            style: { paddingLeft: `${6 + depth * 14}px` },
            onclick: () => { open ? S.open.delete(full) : S.open.add(full); saveOpen(); refreshList(); },
          },
            el('span', { class: 'tree-chevron' }, '▸'),
            el('span', { class: 'tree-name' }, name),
            el('span', { class: 'tree-count' }, String(countAll(child)))));
          if (open) paint(child, depth + 1, full, into);
        }
        for (const n of [...node.notes].sort((a, b) => a.title.localeCompare(b.title))) into.append(noteRow(n, depth));
      };
      paint(root, 0, '', ui.noteList);
    }

    /** Split YAML-ish frontmatter into { props, tags, body }. Tolerant, not a YAML parser. */
    function parseFrontmatter(content) {
      const m = String(content || '').match(/^---\n([\s\S]*?)\n---\n?/);
      if (!m) return { props: {}, tags: [], body: content || '' };
      const props = {}; const tags = [];
      for (const line of m[1].split('\n')) {
        const kv = line.match(/^([\w][\w-]*):\s*(.*)$/);
        if (!kv) continue;
        if (kv[1] === 'tags') {
          for (const t of kv[2].replace(/^\[|\]$/g, '').split(',')) { const v = t.trim().replace(/^["']|["']$/g, ''); if (v) tags.push(v); }
        } else props[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
      }
      return { props, tags, body: content.slice(m[0].length) };
    }

    async function newNote() {
      const name = await askText({ title: 'New note', placeholder: 'Note title (folders ok: Ideas/My Note)', ok: 'Create' });
      if (!name) return;
      const path = name.endsWith('.md') ? name : name + '.md';
      await put('/vault/note', { path, content: `# ${name.split('/').pop().replace(/\.md$/, '')}\n\n` });
      refreshList();
      openNote(path, true);
    }

    // ---------- note view/edit ----------

    async function openNote(path, edit = false) {
      if (S.dirty && !await confirmBox('Discard unsaved changes?', S.note, 'Discard')) return;
      S.note = path; S.dirty = false; S.preview = !edit; S.mode = 'notes';
      // reveal the note in the tree: expand every ancestor folder
      const parts = path.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) S.open.add(parts.slice(0, i).join('/'));
      saveOpen();
      paintCenter();
      refreshList();
    }

    async function paintCenter() {
      if (S.mode === 'graph') { paintGraph(); return; }
      paintNote();
    }

    async function paintNote() {
      ui.center.innerHTML = '';
      S.view?.destroy(); S.view = null;
      updateHead();
      if (!S.note) { ui.center.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, 'Your second brain'), 'Pick a note, search, or use the AI panel to grow the wiki.')); return; }

      let data;
      try { data = await get('/vault/note?path=' + encodeURIComponent(S.note)); }
      catch (e) { ui.center.append(el('div', { class: 'empty' }, e.message)); return; }

      ui.backlinks.innerHTML = '';
      for (const b of data.backlinks) ui.backlinks.append(el('a', { class: 'backlink', onclick: () => openNote(b.path) }, '← ' + b.title));
      if (!data.backlinks.length) ui.backlinks.append(el('div', { class: 'muted small' }, 'none yet'));

      const fm = parseFrontmatter(data.content);
      const tags = [...new Set([
        ...fm.tags,
        ...[...fm.body.matchAll(/(?:^|\s)#([a-zA-Z][\w/-]*)/g)].map(m => m[1]),
      ])];
      ui.tags.innerHTML = '';
      for (const t of tags.slice(0, 12)) ui.tags.append(el('span', { class: 'chip', onclick: () => { ui.search.value = t; refreshList(); } }, '#' + t));
      if (!tags.length) ui.tags.append(el('div', { class: 'muted small' }, 'no tags'));

      if (S.preview) {
        const wrap = el('div', { class: 'md-preview' });
        // frontmatter renders as a tidy properties row, not raw --- text
        if (fm.tags.length || Object.keys(fm.props).length) {
          const props = el('div', { class: 'fm-props' });
          for (const t of fm.tags.slice(0, 12)) props.append(el('span', { class: 'chip', onclick: () => { ui.search.value = t; refreshList(); } }, '#' + t));
          const meta = ['created', 'updated', 'source', 'from', 'type', 'date', 'question']
            .filter(k => fm.props[k]).map(k => `${k} ${String(fm.props[k]).slice(0, 60)}`).join(' · ');
          if (meta) props.append(el('span', { class: 'fm-meta' }, meta));
          wrap.append(props);
        }
        wrap.append(renderMd(fm.body, { onWikilink: followLink }));
        ui.center.append(wrap);
      } else {
        const dark = document.documentElement.dataset.mode === 'dark';
        S.view = new EditorView({
          parent: ui.center,
          state: EditorState.create({
            doc: data.content,
            extensions: [
              basicSetup, keymap.of([indentWithTab]), markdown(), indentUnit.of('  '),
              dark ? oneDark : [],
              EditorView.lineWrapping,
              EditorView.updateListener.of(u => { if (u.docChanged && !S.dirty) { S.dirty = true; updateHead(); } }),
              EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.65', padding: '10px 14px' } }),
            ],
          }),
        });
        Object.assign(S.view.dom.style, { position: 'absolute', inset: '0' });
      }
    }

    function updateHead() {
      ui.title.textContent = S.note ? S.note.replace(/\.md$/, '') : 'pick a note';
      ui.dirtyDot.style.display = S.dirty ? '' : 'none';
      ui.editBtn.innerHTML = '';
      ui.editBtn.append(icon(S.preview ? 'edit' : 'eye'), S.preview ? ' Edit' : ' Read');
      ui.saveBtn.style.display = S.preview ? 'none' : '';
    }

    async function followLink(target) {
      try {
        const r = await get('/vault/resolve?name=' + encodeURIComponent(target));
        if (r.path) { openNote(r.path); return; }
        if (await confirmBox(`Create "${target}"?`, 'This note does not exist yet.', 'Create')) {
          const path = target + '.md';
          await put('/vault/note', { path, content: `# ${target}\n\n` });
          refreshList();
          openNote(path, true);
        }
      } catch (e) { toast(e.message, 'err'); }
    }

    async function save() {
      if (!S.view || !S.note) return;
      await put('/vault/note', { path: S.note, content: S.view.state.doc.toString() });
      S.dirty = false; updateHead();
      toast('saved', 'ok');
    }
    body.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
    });

    async function deleteNote() {
      if (!S.note) return;
      if (!await confirmBox('Delete note?', S.note)) return;
      await post('/vault/delete', { path: S.note });
      S.note = null; S.dirty = false;
      paintCenter(); refreshList();
    }

    // ---------- AI panel ----------

    function renderAIBox() {
      ui.model = modelPicker({ storageKey: 'vault' });
      ui.aiInput = el('textarea', { class: 'input', placeholder: 'Ask your vault anything…', rows: 2, style: { fontSize: '12.5px' } });
      ui.aiOut = el('div', { class: 'ai-answer' });
      const askBtn = el('button', { class: 'btn sm primary', onclick: ask }, icon('search'), 'Ask vault');
      const wikiBtn = el('button', { class: 'btn sm', onclick: wiki }, icon('wand'), 'Grow wiki');
      ui.aiBox.append(ui.model, ui.aiInput, el('div', { class: 'row' }, askBtn, wikiBtn), ui.aiOut);

      ui.aiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
    }

    function aiStream(msg, { onSources } = {}) {
      if (!ui.model.getValue()) { toast('pick a model in the AI panel', 'err'); return; }
      const reqId = 'vq' + (reqSeq++) + Date.now();
      ui.aiOut.innerHTML = '';
      const spin = el('div', { class: 'row' }, el('span', { class: 'spinner' }), el('span', { class: 'muted small' }, 'working…'));
      ui.aiOut.append(spin);
      let buf = '';
      const paint = debounce(() => { ui.aiOut.innerHTML = ''; ui.aiOut.append(renderMd(buf, { onWikilink: followLink })); }, 120);
      const unsub = sub('vaultai:' + reqId, ({ ev }) => {
        if (ev.type === 'delta') { buf += ev.delta; paint(); }
        else if (ev.type === 'sources' && onSources) onSources(ev.sources);
        else if (ev.type === 'status') { spin.lastChild.textContent = ev.message; }
        else if (ev.type === 'created') {
          ui.aiOut.innerHTML = '';
          ui.aiOut.append(el('div', { class: 'col' },
            el('div', { class: 'muted small' }, `created ${ev.notes.length} notes:`),
            ...ev.notes.map(n => el('a', { class: 'backlink', onclick: () => openNote(n.path) }, '+ ' + n.title))));
          refreshList();
        }
        else if (ev.type === 'done') { if (buf) { ui.aiOut.innerHTML = ''; ui.aiOut.append(renderMd(buf || ev.text, { onWikilink: followLink })); } unsub(); }
        else if (ev.type === 'error') { toast(ev.message, 'err'); ui.aiOut.innerHTML = ''; unsub(); }
      });
      wsSend({ ...msg, reqId, modelRef: ui.model.getValue() });
      S.unsubs.push(unsub);
    }

    function ask() {
      const q = ui.aiInput.value.trim();
      if (!q) return;
      aiStream({ t: 'vault.ask', question: q });
    }

    async function wiki() {
      const topic = ui.aiInput.value.trim();
      if (!topic && !S.note) { toast('type a topic, or open a note to expand from', 'err'); return; }
      aiStream(topic ? { t: 'vault.wiki', topic, count: 5 } : { t: 'vault.wiki', sourcePath: S.note, count: 5 });
    }

    function aiSummarize() {
      if (!S.note) { toast('open a note first', 'err'); return; }
      aiStream({ t: 'vault.summarize', path: S.note });
    }

    // ---------- graph ----------

    async function paintGraph() {
      ui.center.innerHTML = '';
      updateHead();
      ui.title.textContent = 'link graph';
      let data;
      try { data = await get('/vault/graph'); } catch (e) { toast(e.message, 'err'); return; }
      const wrap = el('div', { class: 'graph-wrap' });
      const canvas = el('canvas');
      const tip = el('div', { class: 'graph-tip' });
      wrap.append(canvas, tip);
      ui.center.append(wrap);

      const nodes = data.nodes.map((n, i) => ({
        ...n,
        x: Math.cos(i * 2.4) * (80 + 8 * Math.sqrt(i)) , y: Math.sin(i * 2.4) * (80 + 8 * Math.sqrt(i)),
        vx: 0, vy: 0, r: 4 + Math.min(10, (n.in + n.out) * 1.2),
      }));
      const byId = new Map(nodes.map(n => [n.id, n]));
      const edges = data.edges.map(e => ({ s: byId.get(e.s), t: byId.get(e.t) })).filter(e => e.s && e.t);

      let cam = { x: 0, y: 0, k: 1 }, drag = null, hover = null, raf = null, alpha = 1;
      const ctx = canvas.getContext('2d');

      function resize() {
        canvas.width = wrap.clientWidth * devicePixelRatio;
        canvas.height = wrap.clientHeight * devicePixelRatio;
      }
      resize();
      const ro = new ResizeObserver(resize); ro.observe(wrap);
      S.unsubs.push(() => ro.disconnect());

      function tickPhysics() {
        if (alpha < 0.005) return;
        alpha *= 0.985;
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            let dx = a.x - b.x, dy = a.y - b.y;
            let d2 = dx * dx + dy * dy || 1;
            if (d2 < 40000) {
              const f = 900 / d2 * alpha;
              const d = Math.sqrt(d2);
              dx /= d; dy /= d;
              a.vx += dx * f; a.vy += dy * f;
              b.vx -= dx * f; b.vy -= dy * f;
            }
          }
          a.vx -= a.x * 0.0012 * alpha; a.vy -= a.y * 0.0012 * alpha;
        }
        for (const e of edges) {
          const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = (d - 90) * 0.004 * alpha;
          e.s.vx += dx / d * f; e.s.vy += dy / d * f;
          e.t.vx -= dx / d * f; e.t.vy -= dy / d * f;
        }
        for (const n of nodes) {
          if (n === drag?.node) continue;
          n.x += n.vx; n.y += n.vy;
          n.vx *= 0.86; n.vy *= 0.86;
        }
      }

      function draw() {
        tickPhysics();
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        ctx.save();
        ctx.translate(W / 2 + cam.x * devicePixelRatio, H / 2 + cam.y * devicePixelRatio);
        ctx.scale(cam.k * devicePixelRatio, cam.k * devicePixelRatio);
        const styles = getComputedStyle(document.documentElement);
        ctx.strokeStyle = styles.getPropertyValue('--border-strong');
        ctx.lineWidth = 0.7;
        for (const e of edges) { ctx.beginPath(); ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y); ctx.stroke(); }
        const accent = styles.getPropertyValue('--accent').trim();
        const face = styles.getPropertyValue('--faint').trim();
        for (const n of nodes) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, 7);
          ctx.fillStyle = n === hover ? accent : (n.folder?.startsWith(state.config?.vault?.wikiFolder || 'AI Wiki') ? accent + 'aa' : face);
          ctx.fill();
        }
        ctx.fillStyle = styles.getPropertyValue('--muted');
        ctx.font = '10px sans-serif';
        if (cam.k > 0.7) for (const n of nodes) if (n.r > 6 || n === hover) ctx.fillText(n.title.slice(0, 22), n.x + n.r + 3, n.y + 3);
        ctx.restore();
        raf = requestAnimationFrame(draw);
      }
      draw();
      S.unsubs.push(() => cancelAnimationFrame(raf));

      const toWorld = (mx, my) => {
        const r = canvas.getBoundingClientRect();
        return { x: (mx - r.left - r.width / 2 - cam.x) / cam.k, y: (my - r.top - r.height / 2 - cam.y) / cam.k };
      };
      const pick = (mx, my) => {
        const w = toWorld(mx, my);
        return nodes.find(n => { const dx = n.x - w.x, dy = n.y - w.y; return dx * dx + dy * dy < (n.r + 4) ** 2; });
      };

      canvas.addEventListener('mousedown', (e) => {
        const n = pick(e.clientX, e.clientY);
        drag = n ? { node: n } : { pan: true, mx: e.clientX, my: e.clientY, cx: cam.x, cy: cam.y };
      });
      canvas.addEventListener('mousemove', (e) => {
        if (drag?.node) { const w = toWorld(e.clientX, e.clientY); drag.node.x = w.x; drag.node.y = w.y; alpha = Math.max(alpha, 0.3); }
        else if (drag?.pan) { cam.x = drag.cx + e.clientX - drag.mx; cam.y = drag.cy + e.clientY - drag.my; }
        else {
          hover = pick(e.clientX, e.clientY) || null;
          if (hover) {
            tip.style.display = 'block';
            tip.style.left = (e.clientX - wrap.getBoundingClientRect().left + 12) + 'px';
            tip.style.top = (e.clientY - wrap.getBoundingClientRect().top + 8) + 'px';
            tip.textContent = hover.title;
          } else tip.style.display = 'none';
        }
      });
      addEventListener('mouseup', () => {
        if (drag?.node && hover === drag.node) { }
        drag = null;
      });
      canvas.addEventListener('click', (e) => {
        const n = pick(e.clientX, e.clientY);
        if (n) { S.mode = 'notes'; openNote(n.id); }
      });
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        cam.k = Math.min(3, Math.max(0.25, cam.k * (e.deltaY > 0 ? 0.9 : 1.1)));
      }, { passive: false });
    }

    this.reopen = (w, o) => { if (o?.note) openNote(o.note); };
  },

  unmount(win) {
    win.vaultState?.view?.destroy();
    win.vaultState?.unsubs?.forEach(u => { try { u(); } catch { } });
  },
};
