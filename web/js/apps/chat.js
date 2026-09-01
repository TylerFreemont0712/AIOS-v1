// Chat: streaming conversations with any configured model.

import { el, icon, icons, toast, confirmBox, askText, menu, modelPicker, timeAgo, throttle, thinkingPanel, attachTray, attachmentView, perfBadge } from '../ui.js';
import { get, post, patch, del, wsSend, sub, uploadFile } from '../api.js';
import { renderMd } from '../markdown.js';
import { openApp } from '../wm.js';
import { Recorder, transcribe, speak, speakStream, stopSpeaking, voiceStatus, micProblem, prefs as voicePrefs, setPrefs as setVoicePrefs } from '../voice.js';
import { openVoiceMode } from '../voicemode.js';

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

    // --- voice ---
    // The two live where the two jobs live: talking sits next to Send, because it is
    // a way of composing a message; how it talks BACK is a setting, so it sits with
    // the other settings next to Tools.
    ui.mic = el('button', { class: 'btn sm ghost mic-btn', title: 'Dictate (click again to stop)', onclick: () => toggleMic() }, icon('mic'));
    ui.voiceMode = el('button', {
      class: 'btn sm ghost mic-btn', title: 'Voice mode — talk to AIOS hands-free',
      onclick: () => startVoiceMode(),
    }, icon('waveform'));

    const box = el('div', { class: 'composer-box' },
      ui.tray.node, ui.input,
      el('div', { class: 'composer-row' },
        ui.attach, ui.model,
        el('span', { class: 'grow' }), ui.mic, ui.voiceMode, ui.send));
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
    ui.speakToggle = el('button', {
      class: 'btn sm ghost speak-toggle', title: 'How replies are spoken',
      onclick: (e) => voiceMenu(e),
    }, icon('speaker'), el('span', { class: 'speak-label' }, 'Voice'));

    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl' }, 'New chat'),
      el('span', { class: 'grow' }),
      ui.toolsToggle,
      ui.speakToggle,
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
      // Leaving a conversation stops its voice with it — otherwise the previous
      // chat's answer keeps being read out over the one you just opened.
      stopSpeaking(); autoSpeaker = null;
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
        else appendAsst(m.text, m.reasoning, m.perf, m.tools, m.proposals);
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
    function appendAsst(text, reasoning, perf, tools, proposals) {
      const content = el('div', { class: 'msg-content' });
      if (reasoning) { const t = thinkingPanel({ collapsed: true, doneLabel: 'Thought process' }); t.setText(reasoning); content.append(t.node); }
      if (tools?.length) content.append(el('div', { class: 'msg-tools' }, icon('wrench'), 'used ' + tools.join(' · ')));
      content.append(el('div', { class: 'msg-bubble' }, renderMd(text)));
      if (proposals?.length) content.append(el('div', { class: 'prop-list' }, proposals.map(proposalCard)));
      const badge = perfBadge(perf), read = readAloudBtn(() => text);
      if (badge || read) content.append(el('div', { class: 'msg-perf' }, badge, read));
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
        if (!L.bubble) { L.bubble = el('div', { class: 'msg-bubble' }); L.content.insertBefore(L.bubble, L.props || null); }
        win.chatState.buf += ev.delta;
        rerenderLive();
        speakDelta(ev.delta);
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
      } else if (ev.type === 'proposal') {
        // What gets read aloud is the card, not the model's sentence about the card:
        // the card's line is built from the fields that are actually about to be
        // written, so it cannot drift from them.
        turnProposals.push(ev.proposal);
        if (autoSpeaker) { stopSpeaking(); autoSpeaker = null; }
        // The card lands as soon as the model asks for the write, before the reply
        // text finishes — so it is on screen by the time the sentence explaining it is.
        const L = ensureLive();
        if (!L.props) { L.props = el('div', { class: 'prop-list' }); L.content.append(L.props); }
        L.props.append(proposalCard(ev.proposal));
        scrollDown();
      } else if (ev.type === 'proposal.update') {
        updateProposal(ev.proposal);
      } else if (ev.type === 'done') {
        if (live?.think?.live) live.think.done();
        const finalText = ev.text || win.chatState.buf;
        if (live?.bubble) { live.bubble.innerHTML = ''; live.bubble.append(renderMd(finalText)); }
        else if (finalText && live) live.content.append(el('div', { class: 'msg-bubble' }, renderMd(finalText)));
        if (live && finalText) {
          const badge = perfBadge(ev.perf), read = readAloudBtn(() => finalText);
          if (badge || read) live.content.append(el('div', { class: 'msg-perf' }, badge, read));
        }
        speakDone(finalText, turnProposals);
        turnProposals = [];
        live = null;
        setSending(false);
        refreshList();
        scrollDown();
      } else if (ev.type === 'error') {
        turnProposals = [];
        toast(ev.message, 'err');
        if (live) { live.content.append(el('div', { class: 'muted small' }, '⚠ ' + ev.message)); live = null; }
        setSending(false);
      }
    }

    function scrollDown(force) {
      const nearBottom = ui.msgs.scrollHeight - ui.msgs.scrollTop - ui.msgs.clientHeight < 160;
      if (force || nearBottom) ui.msgs.scrollTop = ui.msgs.scrollHeight;
    }

    // --- voice ---
    //
    // Two separate things share these buttons. The mic DICTATES: what you say lands
    // in the composer so you can fix a misheard word before it is sent, which is the
    // right default for a thing that will act on what it hears. Voice mode is the
    // other half — send-as-you-speak, replies read back — and it lives in its own
    // overlay because it is a different posture, not a different button state.
    let voiceInfo = null, mic = null, autoSpeaker = null;
    // Writes staged during the turn in flight — they decide what gets spoken at the end.
    let turnProposals = [];

    async function initVoice() {
      voiceInfo = await voiceStatus();
      paintAutoSpeak();
    }

    /**
     * Why nothing here hides itself.
     *
     * The first cut hid the mic whenever voice was unavailable, which made a blocked
     * microphone and an absent feature look identical — and the most common reason
     * for "unavailable" is not a missing model, it is that the page was opened on the
     * LAN address, where browsers do not expose a microphone at all. A hidden button
     * cannot say that. So the buttons are always there and the click explains.
     */
    function voiceBlocker() {
      if (voiceInfo?.enabled === false) return 'Voice is turned off in Settings → Voice.';
      if (voiceInfo?.unknown) return 'This server has no voice support yet — restart AIOS so it picks up the voice routes.';
      if (!voiceInfo?.stt?.ok) return voiceInfo?.setup || 'No speech model installed yet — run `npm run voice` in the AIOS folder.';
      return micProblem();
    }

    /**
     * True when we can proceed; otherwise says why and returns false.
     *
     * Re-probes when the cached answer was a bad one. Apps stay mounted for the life
     * of the session here, so a status fetched before the server had voice routes —
     * or before `npm run voice` had finished — would otherwise be believed until the
     * whole app was closed and reopened. Asking again at the moment of use means
     * "restart AIOS, then press the mic" does what the user expects.
     */
    async function voiceReady() {
      if (voiceBlocker()) {
        voiceInfo = await voiceStatus({ fresh: true });
        paintAutoSpeak();
      }
      const why = voiceBlocker();
      if (!why) return true;
      toast(why, 'err');
      return false;
    }

    async function startVoiceMode() {
      if (!await voiceReady()) return;
      openVoiceMode({ chatId: win.chatState.chatId });
    }

    // How replies are spoken: three named positions rather than a button you click
    // repeatedly to discover. It sits beside Tools because it is the same kind of
    // thing — a switch that changes how the assistant behaves in this app.
    const SPEAK_MODES = [
      ['auto', 'Always on', 'Every reply is read aloud as it arrives'],
      ['ask', 'On click', 'Silent until you press the speaker on a message'],
      ['off', 'Muted', 'Never speaks — the microphone still works'],
    ];
    const SPEAK_LOOK = {
      auto: ['speaker', 'Always on'],
      ask: ['speaker', 'On click'],
      off: ['speakerOff', 'Muted'],
    };

    function paintAutoSpeak() {
      const mode = voicePrefs().speech;
      const [ic, label] = SPEAK_LOOK[mode] || SPEAK_LOOK.ask;
      ui.speakToggle.classList.toggle('on', mode === 'auto');
      ui.speakToggle.classList.toggle('is-muted', mode === 'off');
      ui.speakToggle.replaceChildren(icon(ic), el('span', { class: 'speak-label' }, label));
      ui.speakToggle.title = `Spoken replies: ${label} — click to change`;
      // With speech off there is nothing for the per-message buttons to do.
      ui.msgs.classList.toggle('is-muted', mode === 'off');
    }

    function setSpeech(mode) {
      setVoicePrefs({ speech: mode });
      if (mode !== 'auto') { stopSpeaking(); autoSpeaker = null; }
      paintAutoSpeak();
    }

    function voiceMenu(e) {
      const cur = voicePrefs().speech;
      const items = SPEAK_MODES.map(([v, label, hint]) => ({
        label, hint, sel: cur === v,
        icon: v === 'off' ? 'speakerOff' : 'speaker',
        onclick: () => setSpeech(v),
      }));
      items.push('-',
        { label: 'Voice mode — talk hands-free', icon: 'waveform', onclick: () => startVoiceMode() },
        { label: 'Voice settings…', icon: 'settings', onclick: () => openApp('settings', { tab: 'voice' }) });
      const r = e.currentTarget.getBoundingClientRect();
      menu(r.left, r.bottom + 6, items);
    }

    function setMicState(on) {
      ui.mic.classList.toggle('is-rec', on);
      ui.mic.title = on ? 'Stop and transcribe' : 'Dictate (click again to stop)';
      if (!on) ui.mic.style.removeProperty('--mic-level');
    }

    async function toggleMic() {
      if (mic) { mic.stop(); return; }
      if (!await voiceReady()) return;
      try {
        // Live text in the composer while you talk, when the streaming recogniser is
        // installed. This is the case that feels most like phone dictation, so it is
        // worth the extra state: `dictBase` is what was in the box before the mic
        // opened, and each partial redraws base + heard-so-far. Redrawing rather than
        // appending is what lets the transducer revise a word it got wrong mid-phrase.
        const streaming = !!voiceInfo?.stt?.streaming;
        const dictBase = ui.input.value.replace(/\s+$/, '');
        let dictated = false, settled = false;
        mic = new Recorder({
          // Dictation is not hands-free: you stop when you say you have stopped.
          // Auto-cutting a sentence someone is still composing is far more annoying
          // here than in Voice mode, where the turn-taking is the point.
          handsFree: false, maxSec: 180,
          streaming, streamMs: voiceInfo?.stt?.streamMs || 200,
          onPartial: !streaming ? null : (text) => {
            // `settled` is the guard against the last word arriving after the real
            // one. The flush that completes the utterance is a request of its own,
            // so it races the accurate pass — usually by a wide margin, but a guess
            // that lands on top of the finished reading is the one failure this
            // whole path must not have.
            if (!text || settled) return;
            dictated = true;
            ui.input.value = dictBase ? `${dictBase} ${text}` : text;
            autoGrow();
          },
          onLevel: (v) => ui.mic.style.setProperty('--mic-level', String(v)),
        });
        await mic.start();
        setMicState(true);
      } catch (e) { mic = null; setMicState(false); toast(e.message, 'err'); return; }

      const blob = await mic.done;
      const spoke = mic.spoke;
      mic = null;
      setMicState(false);
      if (!blob?.size || !spoke) { if (blob) toast('nothing was said'); return; }

      ui.mic.classList.add('is-busy');
      try {
        const heard = await transcribe(blob);
        settled = true;
        const text = (heard.text || '').trim();
        if (!text) {
          if (dictated) { ui.input.value = dictBase; autoGrow(); }   // undo the guess
          toast('did not catch that');
          return;
        }
        // The accurate pass replaces the live text rather than appending to it —
        // the provisional words are the same sentence, punctuated and cased properly
        // this time. `dictBase` is the anchor, so anything typed before the mic
        // opened survives and nothing the transducer guessed is left behind.
        const cur = dictated ? dictBase : ui.input.value.replace(/\s+$/, '');
        ui.input.value = cur ? `${cur} ${text}` : text;
        autoGrow();
        ui.input.focus();
        if (voicePrefs().dictateSend) sendNow();
      } catch (e) { toast(e.message, 'err'); }
      finally { ui.mic.classList.remove('is-busy'); }
    }

    /** Called from onEvent: keep the spoken reply in step with the streamed one. */
    function speakDelta(delta) {
      if (voicePrefs().speech !== 'auto' || !voiceInfo?.tts?.ok) return;
      if (!autoSpeaker) autoSpeaker = speakStream();
      autoSpeaker?.push(delta);
    }
    function speakDone(finalText, proposals) {
      if (voicePrefs().speech !== 'auto' || !voiceInfo?.tts?.ok) return;
      if (proposals?.length) {                 // ask for the confirmation, don't narrate it
        speak(proposals.map(p => p.spoken).join(' '));
        autoSpeaker = null;
        return;
      }
      if (autoSpeaker) { autoSpeaker.flush(); autoSpeaker = null; }
      else if (finalText) speak(finalText);   // a reply that arrived without deltas
    }

    // --- confirmable actions ---
    //
    // The assistant proposes a write; this card is where it becomes real. Everything
    // is shown before anything happens — the amount, the category, the date — because
    // the whole point is catching a misheard "5万" before it is in the ledger rather
    // than after. Fields are editable in place, so a wrong guess costs a keystroke
    // instead of a re-explanation.
    function proposalCard(p) {
      const card = el('div', { class: 'prop-card', dataset: { id: p.id } });
      const render = (prop) => {
        card.dataset.status = prop.status;
        const settled = prop.status !== 'pending';
        const inputs = new Map();

        const head = el('div', { class: 'prop-head' },
          icon(prop.icon || 'sparkle'),
          el('span', { class: 'prop-title' }, prop.title),
          el('span', { class: 'grow' }),
          el('span', { class: 'prop-state' },
            prop.status === 'confirmed' ? 'added'
              : prop.status === 'discarded' ? 'discarded'
                : prop.status === 'failed' ? 'failed'
                  : prop.status === 'running' ? 'saving…' : 'needs your ok'));

        const body = el('div', { class: 'prop-summary' }, prop.summary);

        // Editing is behind a toggle: the summary line is the thing to read, and a
        // form of six inputs in the middle of a conversation is not.
        const form = el('div', { class: 'prop-fields', style: { display: 'none' } },
          prop.fields.map((f) => {
            let input;
            if (f.type === 'select') {
              input = el('select', { class: 'input sm' },
                (f.options || []).map(([v, label]) => el('option', { value: String(v), selected: String(v) === String(f.value) }, label)));
              // `free` fields accept a value the model invented that is not in the list
              if (f.free && f.value && !(f.options || []).some(([v]) => String(v) === String(f.value))) {
                input.prepend(el('option', { value: String(f.value), selected: true }, String(f.value)));
              }
            } else if (f.type === 'textarea') {
              input = el('textarea', { class: 'input sm', rows: 3 });
              input.value = f.value ?? '';
            } else {
              input = el('input', {
                class: 'input sm',
                type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : f.type === 'month' ? 'month' : 'text',
              });
              input.value = f.value ?? '';
            }
            inputs.set(f.key, input);
            return el('label', { class: 'prop-field' + (f.wide ? ' wide' : '') },
              el('span', { class: 'prop-field-label' }, f.label), input);
          }));

        const collect = () => {
          const out = {};
          for (const [k, node] of inputs) out[k] = node.value;
          return out;
        };

        const settle = async (decision) => {
          card.classList.add('is-busy');
          try {
            const next = await post(`/chats/${win.chatState.chatId}/actions/${prop.id}`,
              { decision, args: decision === 'confirm' ? collect() : undefined });
            render(next);
            if (next.status === 'confirmed') toast(next.title + ' — done', 'ok');
            else if (next.status === 'failed') toast(next.result || 'that did not work', 'err');
          } catch (e) { toast(e.message, 'err'); }
          finally { card.classList.remove('is-busy'); }
        };

        const actionsRow = settled
          ? el('div', { class: 'prop-result' }, prop.result || (prop.status === 'discarded' ? 'Nothing was saved.' : ''))
          : el('div', { class: 'prop-actions' },
            el('button', { class: 'btn sm primary', onclick: () => settle('confirm') }, icon('check'), 'Confirm'),
            el('button', {
              class: 'btn sm ghost', onclick: () => { form.style.display = form.style.display === 'none' ? '' : 'none'; },
            }, icon('edit'), 'Edit'),
            el('button', { class: 'btn sm ghost', onclick: () => settle('discard') }, 'Discard'));

        card.replaceChildren(head, body, form, actionsRow);
        // Voice mode listens for these so a spoken "yes" can settle the same card.
        card.settle = settle;
        card.proposal = prop;
      };
      render(p);
      return card;
    }

    /** Live updates (another tab confirmed it, or Voice mode did). */
    function updateProposal(prop) {
      const card = ui.msgs.querySelector(`.prop-card[data-id="${prop.id}"]`);
      if (!card) return;
      const fresh = proposalCard(prop);
      card.replaceWith(fresh);
    }

    /** The per-message speaker button — for reading one answer back on demand.
     *  null when this box has no speech model, so the row simply isn't drawn. */
    function readAloudBtn(getText) {
      if (!voiceInfo?.tts?.ok || voiceInfo?.enabled === false) return null;
      // Rendered even when muted and hidden by CSS, so flipping the setting does not
      // leave every message already on screen without a button until you reload.
      return el('button', {
        class: 'btn xs ghost msg-speak', title: 'Read this aloud',
        onclick: (e) => {
          const btn = e.currentTarget;
          if (btn.classList.contains('on')) { stopSpeaking(); btn.classList.remove('on'); return; }
          for (const b of ui.msgs.querySelectorAll('.msg-speak.on')) b.classList.remove('on');
          btn.classList.add('on');
          const s = speak(getText(), { onState: (st) => { if (st !== 'speaking') btn.classList.remove('on'); } });
          if (!s) btn.classList.remove('on');
        },
      }, icon('speaker'));
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
    initVoice().catch(() => { });
    refreshList();
    if (opts.fresh) newChat();
    if (opts.seed) seedChat(String(opts.seed));
    setTimeout(() => ui.input.focus(), 50);
    win.chatState._voiceCleanup = () => {
      try { mic?.abort(); } catch { /* already released */ }
      mic = null; autoSpeaker = null;
      stopSpeaking();
    };
    this.reopen = (w, o) => { if (o?.seed) seedChat(String(o.seed)); else if (o?.fresh) newChat(); };
  },

  unmount(win) {
    win.chatState?.unsub?.();
    if (win.chatState?._onKey) document.removeEventListener('keydown', win.chatState._onKey);
    win.chatState?._menu?.remove();
    win.chatState?._voiceCleanup?.();
  },
};
