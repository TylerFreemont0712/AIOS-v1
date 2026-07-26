// Chat: streaming conversations with any configured model.

import { el, icon, icons, toast, confirmBox, askText, modelPicker, timeAgo, throttle, thinkingPanel, attachTray, attachmentView, perfBadge } from '../ui.js';
import { get, post, patch, del, wsSend, sub, uploadFile } from '../api.js';
import { renderMd } from '../markdown.js';
import { openApp } from '../wm.js';

export default {
  id: 'chat', title: 'Chat', icon: 'chat', width: 980, height: 660,

  mount(body, opts, win) {
    const ui = {};
    win.chatState = { chatId: null, unsub: null, streaming: false, buf: '', tools: true };

    const LS_COLLAPSED = 'aios.chat.collapsedFolders', LS_FOLDERS = 'aios.chat.folders';
    const lsGet = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch { return new Set(); } };
    const lsSet = (k, set) => { try { localStorage.setItem(k, JSON.stringify([...set])); } catch { } };
    const S = { chats: [], selectMode: false, selected: new Set(), collapsed: lsGet(LS_COLLAPSED), emptyFolders: lsGet(LS_FOLDERS) };

    ui.selCount = el('span', { class: 'sel-count' }, '0 selected');
    ui.selbar = el('div', { class: 'chat-selbar', style: { display: 'none' } },
      ui.selCount, el('span', { class: 'grow' }),
      el('button', { class: 'btn xs ghost', onclick: () => moveSelected() }, 'Move'),
      el('button', { class: 'btn xs ghost danger', onclick: () => deleteSelected() }, 'Delete'),
      el('button', { class: 'btn xs ghost', onclick: () => setSelectMode(false) }, 'Cancel'));

    const side = el('div', { class: 'side' },
      el('div', { class: 'side-head' },
        el('span', { class: 'ttl' }, 'Chats'),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn sm ghost', title: 'Select multiple', onclick: () => setSelectMode(!S.selectMode) }, icon('check')),
        el('button', { class: 'btn sm ghost', title: 'New folder', onclick: () => newFolder() }, icon('folder')),
        el('button', { class: 'btn sm ghost', title: 'New chat', onclick: () => newChat() }, icon('plus'))),
      ui.selbar,
      ui.list = el('div', { class: 'side-list chat-list' }));

    ui.msgs = el('div', { class: 'msgs' });
    ui.input = el('textarea', { class: 'composer-input', placeholder: 'Message… (Enter to send, Shift+Enter for newline)', rows: 1 });
    ui.model = modelPicker({ storageKey: 'chat' });
    ui.send = el('button', { class: 'send-btn', title: 'Send' });
    ui.send.innerHTML = icons.send;
    ui.tray = attachTray();
    ui.file = el('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: () => { ui.tray.add([...ui.file.files]); ui.file.value = ''; } });
    ui.attach = el('button', { class: 'btn sm ghost attach-btn', title: 'Attach image, PDF, or file', onclick: () => ui.file.click() }, icon('paperclip'));

    const box = el('div', { class: 'composer-box' },
      ui.tray.node, ui.input,
      el('div', { class: 'composer-row' }, ui.attach, ui.model, el('span', { class: 'grow' }), ui.send));
    const composer = el('div', { class: 'composer' }, box, ui.file);

    // drag-and-drop files onto the composer, and paste images from the clipboard
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
    box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drag'); });
    box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drag'); if (e.dataTransfer?.files?.length) ui.tray.add([...e.dataTransfer.files]); });
    ui.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); ui.tray.add(files); }
    });

    ui.toolsToggle = el('button', { class: 'btn sm ghost tools-toggle', title: 'Tools — let chat search the web and read your notes, inbox, and planner (read-only) to answer with current, grounded information', onclick: toggleTools }, icon('wrench'), 'Tools');
    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl' }, 'New chat'),
      el('span', { class: 'grow' }),
      ui.toolsToggle,
      el('button', { class: 'btn sm ghost', title: 'System prompt', onclick: editSystem }, icon('edit'), 'system'),
      el('button', { class: 'btn sm ghost danger', title: 'Delete chat', onclick: deleteChat }, icon('trash')));

    body.append(el('div', { class: 'app-cols' }, side, el('div', { class: 'main-pane' }, ui.head, ui.msgs, composer)));

    // --- sidebar (grouped by folder, with rename / multi-select / context menus) ---
    async function refreshList() {
      try { S.chats = await get('/chats'); } catch { S.chats = []; }
      renderList();
    }

    function foldersOf() {
      const set = new Set([...S.emptyFolders]);
      for (const c of S.chats) if (c.folder) set.add(c.folder);
      return [...set].sort((a, b) => a.localeCompare(b));
    }

    function renderList() {
      ui.list.innerHTML = '';
      if (!S.chats.length) { ui.list.append(el('div', { class: 'empty', style: { minHeight: '80px' } }, 'no chats yet')); return; }
      const byFolder = new Map();
      for (const c of S.chats) { const f = c.folder || ''; if (!byFolder.has(f)) byFolder.set(f, []); byFolder.get(f).push(c); }
      for (const f of foldersOf()) {
        const open = !S.collapsed.has(f);
        ui.list.append(el('div', {
          class: 'chat-folder-head' + (open ? ' open' : ''),
          onclick: () => toggleFolder(f),
          oncontextmenu: (e) => { e.preventDefault(); folderMenu(e, f); },
        }, el('span', { class: 'tree-chevron' }, '▸'), icon('folder'),
          el('span', { class: 'chat-folder-name' }, f), el('span', { class: 'tree-count' }, String((byFolder.get(f) || []).length))));
        if (open) for (const c of (byFolder.get(f) || [])) ui.list.append(chatItem(c));
      }
      for (const c of (byFolder.get('') || [])) ui.list.append(chatItem(c));
    }

    function chatItem(c) {
      const node = el('div', {
        class: 'side-item' + (c.id === win.chatState.chatId ? ' sel' : '') + (c.folder ? ' in-folder' : ''),
        onclick: () => { if (S.selectMode) toggleSel(c.id); else load(c.id); },
        ondblclick: () => renameChat(c),
        oncontextmenu: (e) => { e.preventDefault(); chatMenu(e, c); },
      });
      if (S.selectMode) node.append(el('input', { type: 'checkbox', class: 'chat-check', checked: S.selected.has(c.id), onclick: (e) => { e.stopPropagation(); toggleSel(c.id); } }));
      node.append(el('div', { class: 'side-item-main' }, el('div', { class: 'side-item-title' }, c.title || 'untitled'), el('div', { class: 'sub' }, timeAgo(c.updatedAt))));
      return node;
    }

    function toggleFolder(f) {
      if (S.collapsed.has(f)) S.collapsed.delete(f); else S.collapsed.add(f);
      lsSet(LS_COLLAPSED, S.collapsed); renderList();
    }
    function toggleSel(id) {
      if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
      ui.selCount.textContent = `${S.selected.size} selected`; renderList();
    }
    function setSelectMode(on) {
      S.selectMode = on; if (!on) S.selected.clear();
      ui.selbar.style.display = on ? '' : 'none';
      ui.selCount.textContent = `${S.selected.size} selected`; renderList();
    }
    const dropCurrentIf = (ids) => { if (ids.includes(win.chatState.chatId)) { win.chatState.chatId = null; ui.msgs.innerHTML = ''; ui.head.querySelector('.ttl').textContent = 'New chat'; } };

    async function deleteSelected() {
      if (!S.selected.size) return;
      if (!await confirmBox(`Delete ${S.selected.size} chat(s)?`, 'This cannot be undone.')) return;
      const ids = [...S.selected];
      await post('/chats/bulk-delete', { ids });
      dropCurrentIf(ids); setSelectMode(false); refreshList();
    }
    async function moveSelected() {
      if (!S.selected.size) return;
      const f = await askText({ title: 'Move to folder', sub: 'Folder name (blank = ungrouped).', value: '', ok: 'Move' });
      if (f === null) return;
      await post('/chats/move', { ids: [...S.selected], folder: f.trim() });
      if (f.trim()) S.emptyFolders.delete(f.trim());
      setSelectMode(false); refreshList();
    }
    async function newFolder() {
      const f = await askText({ title: 'New folder', sub: 'Name for the folder.', value: '', ok: 'Create' });
      if (!f || !f.trim()) return;
      S.emptyFolders.add(f.trim()); lsSet(LS_FOLDERS, S.emptyFolders); S.collapsed.delete(f.trim()); renderList();
    }
    async function renameChat(c) {
      const t = await askText({ title: 'Rename chat', value: c.title || '', ok: 'Rename' });
      if (t === null) return;
      const title = t.trim() || 'untitled';
      await patch('/chats/' + c.id, { title });
      if (c.id === win.chatState.chatId) ui.head.querySelector('.ttl').textContent = title;
      refreshList();
    }
    async function moveChat(c) {
      const f = await askText({ title: 'Move to folder', sub: 'Folder name (blank = ungrouped).', value: c.folder || '', ok: 'Move' });
      if (f === null) return;
      await patch('/chats/' + c.id, { folder: f.trim() });
      if (f.trim()) S.emptyFolders.delete(f.trim());
      refreshList();
    }
    async function deleteChatById(id) {
      if (!await confirmBox('Delete this chat?', 'The transcript will be removed permanently.')) return;
      await del('/chats/' + id);
      dropCurrentIf([id]); refreshList();
    }
    async function renameFolder(f) {
      const t = await askText({ title: 'Rename folder', value: f, ok: 'Rename' });
      if (t === null || !t.trim() || t.trim() === f) return;
      const nf = t.trim();
      const ids = S.chats.filter(c => c.folder === f).map(c => c.id);
      if (ids.length) await post('/chats/move', { ids, folder: nf });
      if (S.emptyFolders.delete(f)) S.emptyFolders.add(nf);
      if (S.collapsed.delete(f)) S.collapsed.add(nf);
      lsSet(LS_FOLDERS, S.emptyFolders); lsSet(LS_COLLAPSED, S.collapsed); refreshList();
    }
    async function deleteFolder(f) {
      const ids = S.chats.filter(c => c.folder === f).map(c => c.id);
      const msg = ids.length ? `Delete folder "${f}" and its ${ids.length} chat(s)?` : `Delete empty folder "${f}"?`;
      if (!await confirmBox(msg, ids.length ? 'All chats inside will be permanently removed.' : '')) return;
      if (ids.length) { await post('/chats/bulk-delete', { ids }); dropCurrentIf(ids); }
      S.emptyFolders.delete(f); lsSet(LS_FOLDERS, S.emptyFolders); refreshList();
    }

    // --- lightweight right-click context menu ---
    function closeMenu() { win.chatState._menu?.remove(); win.chatState._menu = null; }
    function showMenu(e, items) {
      closeMenu();
      const menu = el('div', { class: 'ctx-menu' });
      for (const it of items) {
        if (it.sep) { menu.append(el('div', { class: 'ctx-sep' })); continue; }
        menu.append(el('div', { class: 'ctx-item' + (it.danger ? ' danger' : ''), onclick: () => { closeMenu(); it.run(); } }, it.label));
      }
      document.body.append(menu);
      menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';
      win.chatState._menu = menu;
      setTimeout(() => document.addEventListener('mousedown', onDocDown), 0);
    }
    function onDocDown(e) { if (win.chatState._menu && !win.chatState._menu.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', onDocDown); } }
    function chatMenu(e, c) {
      showMenu(e, [
        { label: 'Rename', run: () => renameChat(c) },
        { label: 'Move to folder…', run: () => moveChat(c) },
        { label: 'Select multiple', run: () => { setSelectMode(true); toggleSel(c.id); } },
        { sep: true },
        { label: 'Delete', danger: true, run: () => deleteChatById(c.id) },
      ]);
    }
    function folderMenu(e, f) {
      showMenu(e, [
        { label: S.collapsed.has(f) ? 'Expand' : 'Collapse', run: () => toggleFolder(f) },
        { label: 'Rename folder', run: () => renameFolder(f) },
        { sep: true },
        { label: 'Delete folder', danger: true, run: () => deleteFolder(f) },
      ]);
    }

    // Delete key removes the current chat (or the selected ones), but never while typing.
    function onKey(e) {
      if (e.key !== 'Delete') return;
      if (!body.isConnected || body.offsetParent === null) return;   // chat app not the visible view
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
      if (S.selectMode && S.selected.size) { e.preventDefault(); deleteSelected(); }
      else if (win.chatState.chatId) { e.preventDefault(); deleteChatById(win.chatState.chatId); }
    }
    document.addEventListener('keydown', onKey);
    win.chatState._onKey = onKey;

    async function newChat() {
      const c = await post('/chats', { modelRef: ui.model.getValue(), tools: win.chatState.tools });
      await load(c.id);
      refreshList();
    }

    function paintTools() { ui.toolsToggle.classList.toggle('on', win.chatState.tools); }
    async function toggleTools() {
      win.chatState.tools = !win.chatState.tools;
      paintTools();
      if (win.chatState.chatId) { try { await patch('/chats/' + win.chatState.chatId, { tools: win.chatState.tools }); } catch { } }
    }

    async function load(id) {
      win.chatState.unsub?.();
      const c = await get('/chats/' + id);
      win.chatState.chatId = id;
      win.chatState.streaming = false;
      live = null;   // drop any streaming turn from the chat we're leaving
      ui.head.querySelector('.ttl').textContent = c.title;
      if (c.modelRef) ui.model.setValue(c.modelRef);
      win.chatState.tools = c.tools !== false; paintTools();
      ui.msgs.innerHTML = '';
      for (const m of c.messages) {
        if (m.role === 'user') appendMsg('user', m.text, m.attachments);
        else appendAsst(m.text, m.reasoning, m.perf, m.tools);
      }
      scrollDown(true);
      win.chatState.unsub = sub('chat:' + id, onEvent);
      refreshList();
      setSending(false);
    }

    // --- messages ---
    function appendMsg(kind, text, attachments) {
      const content = el('div', { class: 'msg-content' });
      const av = attachmentView(attachments);
      if (av) content.append(av);
      const bubble = el('div', { class: 'msg-bubble' });
      if (kind === 'asst') { bubble.append(renderMd(text)); content.append(bubble); }
      else if (text) { bubble.textContent = text; content.append(bubble); }
      const m = el('div', { class: 'msg ' + kind },
        el('div', { class: 'msg-role' }, kind === 'user' ? 'you' : 'assistant'),
        content);
      ui.msgs.append(m);
      return bubble;
    }

    // A persisted assistant turn: collapsed reasoning panel (if any) + answer bubble,
    // plus a compact chip noting any read-only tools the turn used.
    function appendAsst(text, reasoning, perf, tools) {
      const content = el('div', { class: 'msg-content' });
      if (reasoning) { const t = thinkingPanel({ collapsed: true, doneLabel: 'Thought process' }); t.setText(reasoning); content.append(t.node); }
      if (tools?.length) content.append(el('div', { class: 'msg-tools' }, icon('wrench'), 'used ' + tools.join(' · ')));
      content.append(el('div', { class: 'msg-bubble' }, renderMd(text)));
      const badge = perfBadge(perf);
      if (badge) content.append(el('div', { class: 'msg-perf' }, badge));
      ui.msgs.append(el('div', { class: 'msg asst' }, el('div', { class: 'msg-role' }, 'assistant'), content));
    }

    // Live tool cards inside the streaming turn (mirrors the Agent's tool rendering).
    const TOOL_ICON = { web_search: 'globe', fetch_url: 'network', vault_search: 'vault', vault_list: 'vault', vault_read: 'vault', wiki_recall: 'vault', note_template: 'vault', mail_recent: 'send', mail_search: 'send', mail_read: 'send', agenda_view: 'daily', learn_subjects: 'learn', learn_subject: 'learn', learn_lesson_read: 'learn', learn_weak_topics: 'learn' };
    function toolArg(name, args) {
      if (!args) return '';
      if (name === 'web_search') return args.query || '';
      if (name === 'fetch_url') return args.url || '';
      if (name === 'agenda_view') return args.date || '';
      const v = args.query ?? args.path ?? Object.values(args)[0];
      return v ? String(v).slice(0, 100) : '';
    }
    function makeToolCard(callId, name, args, container) {
      const bodyEl = el('div', { class: 'tool-body', style: { display: 'none' } });
      const stateEl = el('span', { class: 't-state' }, el('span', { class: 'spinner', style: { width: '11px', height: '11px' } }));
      const head = el('div', { class: 'tool-head', onclick: () => { bodyEl.style.display = bodyEl.style.display === 'none' ? '' : 'none'; } },
        icon(TOOL_ICON[name] || 'wrench'), el('span', { class: 't-name' }, name), el('span', { class: 't-arg' }, toolArg(name, args)), stateEl);
      container.append(el('div', { class: 'tool-card' }, head, bodyEl));
      return { bodyEl, stateEl };
    }
    function finishToolCard(callId, ok, content) {
      const card = live?.cards?.get(callId);
      if (!card) return;
      card.stateEl.innerHTML = ''; card.stateEl.textContent = ok ? 'done' : 'error';
      card.stateEl.className = 't-state ' + (ok ? 'ok' : 'err');
      card.bodyEl.append(el('pre', {}, content || '(no output)'));
    }

    // Live streaming turn: reasoning streams first (panel open), then the answer;
    // the panel auto-collapses as soon as the answer begins.
    let live = null;
    function ensureLive() {
      if (live) return live;
      const content = el('div', { class: 'msg-content' });
      const msgEl = el('div', { class: 'msg asst' }, el('div', { class: 'msg-role' }, 'assistant'), content);
      ui.msgs.append(msgEl);
      live = { content, think: null, bubble: null, cards: new Map() };
      win.chatState.buf = '';
      return live;
    }
    const rerenderLive = throttle(() => {
      if (!live?.bubble) return;
      live.bubble.innerHTML = '';
      live.bubble.append(renderMd(win.chatState.buf), el('span', { class: 'cursor' }));
      scrollDown();
    }, 60);

    function onEvent({ ev }) {
      if (ev.type === 'user') { /* echoed for other views; ours is already rendered */ }
      else if (ev.type === 'reasoning') {
        const L = ensureLive();
        if (!L.think) { L.think = thinkingPanel({ label: 'Thinking' }); L.content.prepend(L.think.node); }
        L.think.append(ev.delta);
        scrollDown();
      } else if (ev.type === 'delta') {
        const L = ensureLive();
        if (L.think?.live) L.think.done();               // reasoning is over once the answer starts
        if (!L.bubble) { L.bubble = el('div', { class: 'msg-bubble' }); L.content.append(L.bubble); }
        win.chatState.buf += ev.delta;
        rerenderLive();
      } else if (ev.type === 'tool.start') {
        const L = ensureLive();
        if (L.think?.live) L.think.done();
        // drop any interim "let me look that up" text — the real answer streams after the tools
        if (L.bubble) { L.bubble.remove(); L.bubble = null; win.chatState.buf = ''; }
        L.cards.set(ev.callId, makeToolCard(ev.callId, ev.name, ev.args, L.content));
        scrollDown();
      } else if (ev.type === 'tool.end') {
        finishToolCard(ev.callId, ev.ok, ev.content);
        scrollDown();
      } else if (ev.type === 'done') {
        if (live?.think?.live) live.think.done();
        if (live?.bubble) { live.bubble.innerHTML = ''; live.bubble.append(renderMd(ev.text || win.chatState.buf)); }
        else if ((ev.text || win.chatState.buf) && live) live.content.append(el('div', { class: 'msg-bubble' }, renderMd(ev.text || win.chatState.buf)));
        const badge = perfBadge(ev.perf);
        if (badge && live) live.content.append(el('div', { class: 'msg-perf' }, badge));
        live = null;
        setSending(false);
        refreshList();
        scrollDown();
      } else if (ev.type === 'error') {
        toast(ev.message, 'err');
        if (live) { live.content.append(el('div', { class: 'muted small' }, '⚠ ' + ev.message)); live = null; }
        setSending(false);
      }
    }

    function scrollDown(force) {
      const nearBottom = ui.msgs.scrollHeight - ui.msgs.scrollTop - ui.msgs.clientHeight < 160;
      if (force || nearBottom) ui.msgs.scrollTop = ui.msgs.scrollHeight;
    }

    // --- sending ---
    async function sendNow() {
      if (win.chatState.streaming) { wsSend({ t: 'chat.stop', chatId: win.chatState.chatId }); return; }
      const text = ui.input.value.trim();
      const files = ui.tray.items();
      if (!text && !files.length) return;
      if (!ui.model.getValue()) { toast('pick a model first', 'err'); return; }
      if (!win.chatState.chatId) {
        const c = await post('/chats', { modelRef: ui.model.getValue(), tools: win.chatState.tools });
        win.chatState.chatId = c.id;
        win.chatState.unsub = sub('chat:' + c.id, onEvent);
      }
      setSending(true);
      let attachments = [];
      try { if (files.length) attachments = await Promise.all(files.map(uploadFile)); }
      catch (e) { toast('upload failed: ' + e.message, 'err'); setSending(false); return; }
      appendMsg('user', text, attachments);
      scrollDown(true);
      ui.input.value = ''; autoGrow(); ui.tray.clear();
      wsSend({ t: 'chat.send', chatId: win.chatState.chatId, text, modelRef: ui.model.getValue(), attachments });
    }

    function setSending(v) {
      win.chatState.streaming = v;
      ui.send.classList.toggle('stop', v);
      ui.send.innerHTML = v ? icons.stop : icons.send;
      ui.send.title = v ? 'Stop' : 'Send';
    }

    ui.send.addEventListener('click', sendNow);
    ui.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNow(); }
    });
    const autoGrow = () => { ui.input.style.height = 'auto'; ui.input.style.height = Math.min(ui.input.scrollHeight, 220) + 'px'; };
    ui.input.addEventListener('input', autoGrow);

    // --- head actions ---
    async function editSystem() {
      if (!win.chatState.chatId) { toast('start a chat first'); return; }
      const c = await get('/chats/' + win.chatState.chatId);
      const sys = await askText({ title: 'System prompt', sub: 'Sets the assistant\'s behavior for this chat.', value: c.system || '', multiline: true, ok: 'Save' });
      if (sys !== null) { await patch('/chats/' + win.chatState.chatId, { system: sys }); toast('saved', 'ok'); }
    }
    async function deleteChat() { if (win.chatState.chatId) deleteChatById(win.chatState.chatId); }

    /** Open with a message already on its way — the dashboard quick-ask lands here. */
    async function seedChat(text) {
      if (!ui.model.getValue()) { toast('pick a model first — then ask again', 'err'); return; }
      if (win.chatState.streaming) { toast('already generating — wait or stop first', 'err'); return; }
      const c = await post('/chats', { modelRef: ui.model.getValue(), tools: win.chatState.tools });
      win.chatState.unsub?.();
      win.chatState.chatId = c.id;
      win.chatState.unsub = sub('chat:' + c.id, onEvent);
      ui.head.querySelector('.ttl').textContent = 'New chat';
      ui.msgs.innerHTML = '';
      appendMsg('user', text);
      scrollDown(true);
      setSending(true);
      wsSend({ t: 'chat.send', chatId: c.id, text, modelRef: ui.model.getValue(), attachments: [] });
      refreshList();
    }

    paintTools();
    refreshList();
    if (opts.fresh) newChat();
    if (opts.seed) seedChat(String(opts.seed));
    setTimeout(() => ui.input.focus(), 50);
    this.reopen = (w, o) => { if (o?.seed) seedChat(String(o.seed)); else if (o?.fresh) newChat(); };
  },

  unmount(win) {
    win.chatState?.unsub?.();
    if (win.chatState?._onKey) document.removeEventListener('keydown', win.chatState._onKey);
    win.chatState?._menu?.remove();
  },
};
