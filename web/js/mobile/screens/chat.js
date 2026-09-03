// Chat — the reason to open this thing from a train.
//
// Speaks exactly the protocol the desktop does (POST /chats, then `chat.send` over the
// socket, then `chat:<id>` events), so a conversation started on the phone is the same
// conversation on the laptop, with the same transcript file behind it.
//
// Three things here are phone-specific rather than a shrunken desktop pane:
//   - Confirmation cards are full-width and thumb-sized. These are the writes the
//     assistant wants to make to the ledger or the planner, and confirming one by
//     accident is the expensive mistake, so Confirm is never adjacent to Discard.
//   - The composer grows to a few lines then scrolls, and never triggers iOS zoom
//     (16px, enforced in CSS).
//   - Voice input is offered only when the microphone actually exists — on plain http
//     navigator.mediaDevices is undefined rather than denied, so the button is hidden
//     rather than shown-and-broken. That is the whole reason for the HTTPS work.

import { get, post, del, wsSend, sub, uploadFile } from '../../api.js';
import { el, fill, icon, toast, sheet, confirmSheet, ICONS, loading, empty, relTime, money, toBottom, atBottom, buzz, spinner } from '../ui.js';
import { IMAGE_ACCEPT, isImageFile } from '../../imageprep.js';
import { renderMarkdown, enhanceCode } from '../md.js';

export default async function chatScreen({ host, params, ui, go }) {
  const S = {
    chatId: null, unsub: null, streaming: false,
    live: null,          // { wrap, body, buf } of the assistant bubble being typed
    model: '', models: [], chats: [],
    attachments: [],
    pendingProposals: new Map(),
  };

  // ---------- layout ----------

  const msgs = el('div', { class: 'm-msgs' });
  const scroll = el('div', { class: 'm-scroll m-chat-scroll' }, msgs);

  const input = el('textarea', {
    class: 'm-compose-input', rows: 1, placeholder: 'Message…',
    enterkeyhint: 'send', autocapitalize: 'sentences',
  });
  const attachStrip = el('div', { class: 'm-attach-strip', style: { display: 'none' } });
  const sendBtn = el('button', { class: 'm-send', 'aria-label': 'Send', onclick: onSend }, el('span', { html: ICONS.send }));
  const micBtn = el('button', { class: 'm-compose-btn', 'aria-label': 'Dictate', onclick: onMic }, el('span', { html: ICONS.mic }));
  const clipBtn = el('button', { class: 'm-compose-btn', 'aria-label': 'Attach', onclick: () => filePicker.click() }, el('span', { html: ICONS.library }));

  const composer = el('div', { class: 'm-compose' },
    attachStrip,
    el('div', { class: 'm-compose-row' }, clipBtn, input, micBtn, sendBtn));

  host.append(scroll, composer);

  // The picker lives in <body>, not in the re-rendered tree: a file input removed from
  // the document while its picker is open never fires `change` on iOS. Same trap the
  // receipts screen documented.
  const filePicker = el('input', { type: 'file', accept: IMAGE_ACCEPT, multiple: true, style: { display: 'none' } });
  document.body.append(filePicker);
  filePicker.addEventListener('change', async () => {
    // input.files is LIVE — copy it before resetting value, or the reset empties the
    // very FileList being held.
    const picked = Array.from(filePicker.files || []);
    filePicker.value = '';
    if (!picked.length) return toast('No file came back from the picker', 'err');
    await addAttachments(picked);
  });

  // ---------- composer behaviour ----------

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  };
  input.addEventListener('input', autosize);
  // Enter sends on a hardware keyboard; on the soft keyboard `enterkeyhint=send` gives
  // a Send key that fires the same path. Shift+Enter is a newline either way.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); onSend(); }
  });

  function setStreaming(on) {
    S.streaming = on;
    sendBtn.innerHTML = on ? ICONS.stop : ICONS.send;
    sendBtn.classList.toggle('is-stop', on);
    sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
  }

  // ---------- attachments ----------

  async function addAttachments(files) {
    for (const f of files.slice(0, 8)) {
      if (!isImageFile(f) && !/^text\//.test(f.type)) { toast(`${f.name} is not an image`, 'err'); continue; }
      const chip = el('div', { class: 'm-attach' }, spinner(), el('span', { class: 'm-attach-n' }, f.name));
      attachStrip.append(chip);
      attachStrip.style.display = '';
      try {
        const up = await uploadFile(f);          // decodes HEIC + downscales on the way
        S.attachments.push(up.id || up);
        fill(chip, el('span', { class: 'm-attach-n' }, f.name),
          el('button', { class: 'm-attach-x', 'aria-label': 'Remove', onclick: () => {
            const i = S.attachments.indexOf(up.id || up);
            if (i >= 0) S.attachments.splice(i, 1);
            chip.remove();
            if (!attachStrip.children.length) attachStrip.style.display = 'none';
          } }, '×'));
      } catch (e) {
        chip.remove();
        toast(`Could not attach ${f.name}: ${e.message}`, 'err');
      }
    }
    if (!attachStrip.children.length) attachStrip.style.display = 'none';
  }

  function clearAttachments() {
    S.attachments = [];
    fill(attachStrip);
    attachStrip.style.display = 'none';
  }

  // ---------- rendering ----------

  function bubble(role, content) {
    const wrap = el('div', { class: 'm-msg is-' + role });
    const body = el('div', { class: 'm-bubble' });
    if (typeof content === 'string') body.innerHTML = role === 'user' ? escapeToHtml(content) : renderMarkdown(content);
    else if (content) body.append(content);
    wrap.append(body);
    msgs.append(wrap);
    return { wrap, body };
  }

  const escapeToHtml = (s) => String(s ?? '')
    .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/\n/g, '<br>');

  /** The assistant bubble currently being streamed into, created on first delta. */
  function ensureLive() {
    if (!S.live) {
      const b = bubble('assistant', '');
      S.live = { ...b, buf: '' };
      b.body.classList.add('is-live');
    }
    return S.live;
  }

  function endLive() {
    if (!S.live) return;
    S.live.body.classList.remove('is-live');
    S.live = null;
  }

  // ---------- confirmation cards ----------
  //
  // The staged write, rendered so it can be read at arm's length and settled with one
  // deliberate tap. Editing a field re-derives the card server-side (PATCH), so what
  // you confirm is always what the server will execute — never a client-side guess.

  function proposalCard(p) {
    const card = el('div', { class: 'm-prop is-' + p.status, 'data-pid': p.id });
    S.pendingProposals.set(p.id, card);
    renderProposal(card, p);
    return card;
  }

  function renderProposal(card, p) {
    card.className = 'm-prop is-' + p.status;
    const settled = p.status !== 'pending';

    const fields = (p.fields || []).map(f => el('div', { class: 'm-prop-f' },
      el('span', { class: 'm-prop-fl' }, f.label),
      el('span', { class: 'm-prop-fv' }, String(f.value ?? '—'))));

    fill(card,
      el('div', { class: 'm-prop-head' },
        el('span', { class: 'm-prop-badge' }, settled ? (p.status === 'confirmed' ? 'Done' : p.status === 'failed' ? 'Failed' : 'Discarded') : 'Confirm?'),
        el('div', { class: 'm-prop-title' }, p.title || p.summary || 'Action')),
      fields.length ? el('div', { class: 'm-prop-fs' }, ...fields) : null,
      p.result ? el('div', { class: 'm-prop-result' }, p.result) : null,
      settled ? null : el('div', { class: 'm-prop-actions' },
        el('button', { class: 'm-btn is-primary m-prop-ok', onclick: () => decide(p, 'confirm') }, 'Confirm'),
        el('button', { class: 'm-btn', onclick: () => editProposal(p) }, 'Edit'),
        el('button', { class: 'm-btn is-ghost', onclick: () => decide(p, 'discard') }, 'Discard')),
    );
  }

  async function decide(p, decision) {
    const card = S.pendingProposals.get(p.id);
    if (card) card.classList.add('is-busy');
    try {
      const next = await post(`/chats/${S.chatId}/actions/${p.id}`, { decision });
      if (card) renderProposal(card, next);
      buzz();
      if (decision === 'confirm') toast(next.status === 'confirmed' ? 'Done' : 'Failed', next.status === 'confirmed' ? 'ok' : 'err');
    } catch (e) {
      toast(e.message, 'err');
      if (card) card.classList.remove('is-busy');
    }
  }

  function editProposal(p) {
    sheet('Edit before confirming', (body, close) => {
      const inputs = new Map();
      for (const f of p.fields || []) {
        let node;
        if (f.type === 'select' && Array.isArray(f.options)) {
          node = el('select', { class: 'm-input' }, ...f.options.map(([v, label]) =>
            el('option', { value: v, selected: String(v) === String(f.value) ? '' : null }, label)));
          // `free: true` means the model may invent a value outside the list; keep it.
          if (f.free && !f.options.some(([v]) => String(v) === String(f.value))) {
            node.prepend(el('option', { value: f.value, selected: '' }, String(f.value)));
          }
        } else {
          node = el('input', {
            class: 'm-input', type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text',
            inputmode: f.type === 'number' ? 'decimal' : null,
          });
          node.value = f.value ?? '';
        }
        inputs.set(f.key, node);
        body.append(el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, f.label), node));
      }
      body.append(el('div', { class: 'm-actions' },
        el('button', { class: 'm-btn', onclick: close }, 'Cancel'),
        el('button', { class: 'm-btn is-primary', onclick: async () => {
          const patch = {};
          for (const [k, node] of inputs) patch[k] = node.value;
          try {
            const next = await post(`/chats/${S.chatId}/actions/${p.id}`, { decision: 'confirm', args: patch });
            const card = S.pendingProposals.get(p.id);
            if (card) renderProposal(card, next);
            close();
            buzz();
            toast(next.status === 'confirmed' ? 'Done' : 'Failed', next.status === 'confirmed' ? 'ok' : 'err');
          } catch (e) { toast(e.message, 'err'); }
        } }, 'Save & confirm')));
    });
  }

  // ---------- tool cards ----------

  const toolCards = new Map();
  function startTool(ev) {
    const card = el('div', { class: 'm-tool is-run' },
      spinner('m-tool-spin'),
      el('span', { class: 'm-tool-n' }, ev.name));
    toolCards.set(ev.callId, card);
    msgs.append(card);
    return card;
  }
  function endTool(ev) {
    const card = toolCards.get(ev.callId);
    if (!card) return;
    card.className = 'm-tool ' + (ev.ok ? 'is-ok' : 'is-err');
    fill(card, el('span', { class: 'm-tool-i', html: ev.ok ? ICONS.check : ICONS.close }),
      el('span', { class: 'm-tool-n' }, ev.name));
    // The output is usually long and rarely what you want on a phone — one tap away.
    if (ev.content) {
      card.classList.add('is-tappable');
      card.onclick = () => sheet(ev.name, (b) => b.append(el('pre', { class: 'm-pre' }, String(ev.content).slice(0, 8000))));
    }
  }

  // ---------- streaming ----------

  function onEvent({ ev }) {
    const stick = atBottom(scroll);
    if (ev.type === 'delta') {
      const L = ensureLive();
      L.buf += ev.delta || '';
      L.body.innerHTML = renderMarkdown(L.buf);
    } else if (ev.type === 'tool.start') {
      endLive();
      startTool(ev);
    } else if (ev.type === 'tool.end') {
      endTool(ev);
    } else if (ev.type === 'proposal') {
      endLive();
      msgs.append(proposalCard(ev.proposal));
      buzz(12);
    } else if (ev.type === 'proposal.update') {
      const card = S.pendingProposals.get(ev.proposal.id);
      if (card) renderProposal(card, ev.proposal);
    } else if (ev.type === 'done') {
      if (S.live && !S.live.buf && ev.text) S.live.body.innerHTML = renderMarkdown(ev.text);
      // Highlight once the turn is over. Doing it per-delta would re-highlight the same
      // block on every token, which is what makes a streaming reply drop frames.
      if (S.live) enhanceCode(S.live.body);
      endLive();
      setStreaming(false);
    } else if (ev.type === 'error') {
      endLive();
      setStreaming(false);
      msgs.append(el('div', { class: 'm-msg-err' }, ev.message || 'Something went wrong'));
    }
    if (stick) toBottom(scroll);
  }

  function listen(chatId) {
    S.unsub?.();
    S.unsub = sub(`chat:${chatId}`, onEvent);
  }

  // ---------- send ----------

  async function onSend() {
    if (S.streaming) { wsSend({ t: 'chat.stop', chatId: S.chatId }); setStreaming(false); return; }
    const text = input.value.trim();
    if (!text && !S.attachments.length) return;

    if (!S.model) {
      toast('No model available — check Settings', 'err');
      return;
    }

    try {
      if (!S.chatId) {
        const c = await post('/chats', { modelRef: S.model });
        S.chatId = c.id;
        listen(c.id);
      }
    } catch (e) { return toast(e.message, 'err'); }

    const atts = S.attachments.slice();
    bubble('user', text || `${atts.length} attachment${atts.length === 1 ? '' : 's'}`);
    input.value = '';
    autosize();
    clearAttachments();
    setStreaming(true);
    toBottom(scroll, true);

    wsSend({ t: 'chat.send', chatId: S.chatId, text, modelRef: S.model, attachments: atts });
  }

  // ---------- voice ----------
  //
  // getUserMedia is absent, not denied, outside a secure context — so feature-detect
  // and hide the button rather than offering one that throws. Over the tailnet's HTTPS
  // it is present, which is the point of remote.js.

  const micAvailable = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!micAvailable) micBtn.style.display = 'none';

  let rec = null, recChunks = [], recStream = null;

  async function onMic() {
    if (rec) return stopMic();
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      return toast(e.name === 'NotAllowedError' ? 'Microphone permission denied' : `No microphone: ${e.message}`, 'err');
    }
    recChunks = [];
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported?.(t)) || '';
    rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (e) => { if (e.data?.size) recChunks.push(e.data); };
    rec.onstop = onMicStopped;
    rec.start();
    micBtn.classList.add('is-rec');
    buzz(15);
    toast('Listening — tap again to stop');
  }

  function stopMic() {
    try { rec?.stop(); } catch { }
    micBtn.classList.remove('is-rec');
  }

  async function onMicStopped() {
    const blob = new Blob(recChunks, { type: rec?.mimeType || 'audio/webm' });
    rec = null;
    for (const t of recStream?.getTracks() || []) t.stop();
    recStream = null;
    if (!blob.size) return;

    micBtn.classList.add('is-busy');
    try {
      const buf = await blob.arrayBuffer();
      const r = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm', ...authHeader() },
        body: buf,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `${r.status}`);
      const text = (data.text || '').trim();
      if (!text) return toast('Nothing heard', 'err');
      input.value = input.value ? `${input.value} ${text}` : text;
      autosize();
      input.focus();
    } catch (e) {
      toast(`Transcription failed: ${e.message}`, 'err');
    } finally {
      micBtn.classList.remove('is-busy');
    }
  }

  const authHeader = () => {
    const t = localStorage.getItem('aios.token');
    return t ? { authorization: 'Bearer ' + t } : {};
  };

  // ---------- history ----------

  async function openChat(id) {
    S.chatId = id;
    S.pendingProposals.clear();
    toolCards.clear();
    fill(msgs);
    listen(id);
    try {
      const c = await get('/chats/' + id);
      S.model = c.modelRef || S.model;
      for (const m of c.messages || []) {
        if (m.role === 'user') bubble('user', m.content || m.text || '');
        else if (m.role === 'assistant') {
          if (m.content || m.text) bubble('assistant', m.content || m.text);
          for (const p of m.proposals || []) msgs.append(proposalCard(p));
        }
      }
      enhanceCode(msgs);
      ui.setTitle(c.title || 'Chat', modelLabel());
      toBottom(scroll);
    } catch (e) { toast(e.message, 'err'); }
  }

  function newChat() {
    S.unsub?.();
    S.unsub = null;
    S.chatId = null;
    S.pendingProposals.clear();
    toolCards.clear();
    fill(msgs);
    endLive();
    setStreaming(false);
    ui.setTitle('Chat', modelLabel());
    input.focus();
  }

  function openHistory() {
    sheet('Chats', async (body, close) => {
      body.append(loading());
      try {
        const list = await get('/chats');
        S.chats = list;
        fill(body,
          el('button', { class: 'm-btn is-primary m-full', onclick: () => { close(); newChat(); } }, 'New chat'),
          list.length ? el('div', { class: 'm-menu' }, ...list.slice(0, 40).map(c => el('div', { class: 'm-menu-row' + (c.id === S.chatId ? ' is-on' : '') },
            el('button', { class: 'm-menu-main', onclick: () => { close(); openChat(c.id); } },
              el('div', { class: 'm-menu-t' }, c.title || 'Untitled'),
              el('div', { class: 'm-menu-d' }, `${c.messages || c.count || 0} messages · ${relTime(c.updatedAt || c.createdAt)}`)),
            el('button', { class: 'm-x', 'aria-label': 'Delete', onclick: async (e) => {
              e.stopPropagation();
              if (!await confirmSheet('Delete chat?', c.title || 'Untitled', { ok: 'Delete', danger: true })) return;
              try { await del('/chats/' + c.id); toast('Deleted'); close(); if (c.id === S.chatId) newChat(); }
              catch (err) { toast(err.message, 'err'); }
            } }, el('span', { html: ICONS.trash })))))
            : empty('No chats yet'));
      } catch (e) { fill(body, el('div', { class: 'm-errbox' }, e.message)); }
    });
  }

  // ---------- model picker ----------

  const modelLabel = () => (S.model || '').split(':').pop() || 'no model';

  function openModels() {
    sheet('Model', (body, close) => {
      if (!S.models.length) return body.append(empty('No models available', 'Start a local model, or add an API key in Settings.'));
      body.append(el('div', { class: 'm-menu' }, ...S.models.map(m => {
        const ref = m.ref || `${m.provider}:${m.id}`;
        return el('button', { class: 'm-menu-row' + (ref === S.model ? ' is-on' : ''), onclick: () => {
          S.model = ref;
          ui.setTitle(document.querySelector('.m-title')?.textContent || 'Chat', modelLabel());
          close();
        } },
          el('div', { class: 'm-grow' },
            el('div', { class: 'm-menu-t' }, m.name || m.id),
            el('div', { class: 'm-menu-d' }, m.provider || '')));
      })));
    });
  }

  // ---------- boot ----------

  ui.setActions(
    ui.action('spark', 'Model', openModels),
    ui.action('chat', 'Chats', openHistory),
    ui.action('plus', 'New chat', newChat),
  );

  try {
    const models = await get('/models');
    S.models = Array.isArray(models) ? models : (models.models || []);
    const cfg = await get('/config').catch(() => null);
    S.model = cfg?.defaults?.chatModel || S.models[0]?.ref || (S.models[0] ? `${S.models[0].provider}:${S.models[0].id}` : '');
  } catch { /* the send path reports it */ }

  ui.setTitle('Chat', modelLabel());

  if (params.fresh) newChat();
  else {
    // Reopen the most recent conversation — on a phone you are usually continuing
    // something, not starting fresh, and a blank screen hides the history entirely.
    try {
      const list = await get('/chats');
      if (list.length) await openChat(list[0].id);
    } catch { /* start empty */ }
  }

  if (params.voice && micAvailable) setTimeout(onMic, 300);

  return {
    unmount() {
      S.unsub?.();
      stopMic();
      for (const t of recStream?.getTracks() || []) t.stop();
      filePicker.remove();
    },
  };
}
