// Chat: streaming conversations with any configured model.

import { el, icon, icons, toast, confirmBox, askText, modelPicker, timeAgo, throttle, thinkingPanel, attachTray, attachmentView } from '../ui.js';
import { get, post, patch, del, wsSend, sub, uploadFile } from '../api.js';
import { renderMd } from '../markdown.js';
import { openApp } from '../wm.js';

export default {
  id: 'chat', title: 'Chat', icon: 'chat', width: 980, height: 660,

  mount(body, opts, win) {
    const ui = {};
    win.chatState = { chatId: null, unsub: null, streaming: false, buf: '' };

    const side = el('div', { class: 'side' },
      el('div', { class: 'side-head' },
        el('span', { class: 'ttl' }, 'Chats'),
        el('button', { class: 'btn sm ghost', title: 'New chat', onclick: () => newChat() }, icon('plus'))),
      ui.list = el('div', { class: 'side-list' }));

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

    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl' }, 'New chat'),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn sm ghost', title: 'System prompt', onclick: editSystem }, icon('edit'), 'system'),
      el('button', { class: 'btn sm ghost danger', title: 'Delete chat', onclick: deleteChat }, icon('trash')));

    body.append(el('div', { class: 'app-cols' }, side, el('div', { class: 'main-pane' }, ui.head, ui.msgs, composer)));

    // --- sidebar ---
    async function refreshList() {
      let chats = [];
      try { chats = await get('/chats'); } catch { }
      ui.list.innerHTML = '';
      for (const c of chats) {
        ui.list.append(el('div', {
          class: 'side-item' + (c.id === win.chatState.chatId ? ' sel' : ''),
          onclick: () => load(c.id),
        }, c.title || 'untitled', el('div', { class: 'sub' }, timeAgo(c.updatedAt))));
      }
      if (!chats.length) ui.list.append(el('div', { class: 'empty', style: { minHeight: '80px' } }, 'no chats yet'));
    }

    async function newChat() {
      const c = await post('/chats', { modelRef: ui.model.getValue() });
      await load(c.id);
      refreshList();
    }

    async function load(id) {
      win.chatState.unsub?.();
      const c = await get('/chats/' + id);
      win.chatState.chatId = id;
      win.chatState.streaming = false;
      live = null;   // drop any streaming turn from the chat we're leaving
      ui.head.querySelector('.ttl').textContent = c.title;
      if (c.modelRef) ui.model.setValue(c.modelRef);
      ui.msgs.innerHTML = '';
      for (const m of c.messages) {
        if (m.role === 'user') appendMsg('user', m.text, m.attachments);
        else appendAsst(m.text, m.reasoning);
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

    // A persisted assistant turn: collapsed reasoning panel (if any) + answer bubble.
    function appendAsst(text, reasoning) {
      const content = el('div', { class: 'msg-content' });
      if (reasoning) { const t = thinkingPanel({ collapsed: true, doneLabel: 'Thought process' }); t.setText(reasoning); content.append(t.node); }
      content.append(el('div', { class: 'msg-bubble' }, renderMd(text)));
      ui.msgs.append(el('div', { class: 'msg asst' }, el('div', { class: 'msg-role' }, 'assistant'), content));
    }

    // Live streaming turn: reasoning streams first (panel open), then the answer;
    // the panel auto-collapses as soon as the answer begins.
    let live = null;
    function ensureLive() {
      if (live) return live;
      const content = el('div', { class: 'msg-content' });
      const msgEl = el('div', { class: 'msg asst' }, el('div', { class: 'msg-role' }, 'assistant'), content);
      ui.msgs.append(msgEl);
      live = { content, think: null, bubble: null };
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
      } else if (ev.type === 'done') {
        if (live?.think?.live) live.think.done();
        if (live?.bubble) { live.bubble.innerHTML = ''; live.bubble.append(renderMd(ev.text || win.chatState.buf)); }
        else if ((ev.text || win.chatState.buf) && live) live.content.append(el('div', { class: 'msg-bubble' }, renderMd(ev.text || win.chatState.buf)));
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
        const c = await post('/chats', { modelRef: ui.model.getValue() });
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
    async function deleteChat() {
      if (!win.chatState.chatId) return;
      if (!await confirmBox('Delete this chat?', 'The transcript will be removed permanently.')) return;
      await del('/chats/' + win.chatState.chatId);
      win.chatState.chatId = null;
      ui.msgs.innerHTML = '';
      ui.head.querySelector('.ttl').textContent = 'New chat';
      refreshList();
    }

    refreshList();
    if (opts.fresh) newChat();
    setTimeout(() => ui.input.focus(), 50);
    this.reopen = (w, o) => { if (o?.fresh) newChat(); };
  },

  unmount(win) { win.chatState?.unsub?.(); },
};
