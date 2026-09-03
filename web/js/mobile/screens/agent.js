// Agent — watch a coding session, and answer the questions it is blocked on.
//
// The reason this screen earns a place on a phone is approvals. An agent run started
// at the desk stops dead the moment it wants to write a file, and until someone says
// yes it is simply idle. Being able to approve from a train turns a two-hour gap into
// a two-minute one.
//
// Starting a fresh session from here is possible but secondary: the prompt is the part
// you want a keyboard for.

import { get, post, del, wsSend, sub } from '../../api.js';
import { el, fill, icon, toast, sheet, askSheet, confirmSheet, ICONS, loading, empty, errorBox, relTime, toBottom, atBottom, buzz } from '../ui.js';
import { renderMarkdown, enhanceCode } from '../md.js';

export default async function agentScreen({ host, params, ui }) {
  let unsub = null;
  let sessionId = params.id || null;
  let live = null;             // the assistant bubble being streamed into
  const approvals = new Map(); // callId -> card

  const scroll = el('div', { class: 'm-scroll' });
  host.append(scroll);

  ui.setTitle('Agent');

  // ---------- session list ----------

  async function showList() {
    sessionId = null;
    unsub?.(); unsub = null;
    ui.setLeft();
    ui.setTitle('Agent');
    ui.setActions(ui.action('refresh', 'Refresh', showList));
    fill(scroll, loading());
    try {
      const list = await get('/agent/sessions');
      if (!list.length) return fill(scroll, empty('No agent sessions', 'Start one at the desk; approvals will show up here.'));
      fill(scroll, el('div', { class: 'm-rows' }, ...list.map(sessionRow)));
    } catch (e) {
      fill(scroll, errorBox(e, showList));
    }
  }

  const sessionRow = (s) => el('button', { class: 'm-row m-row-tap', onclick: () => openSession(s.id) },
    el('span', { class: 'm-row-i' + (s.running ? ' is-live' : ''), html: ICONS.agent }),
    el('div', { class: 'm-grow' },
      el('div', { class: 'm-row-t' }, s.title || 'Untitled session'),
      el('div', { class: 'm-row-m' }, [
        s.running ? 'running' : null,
        `${s.messages || 0} messages`,
        s.mode,
        relTime(s.updatedAt),
      ].filter(Boolean).join(' · '))),
    el('span', { class: 'm-row-chev' }, '›'));

  // ---------- one session ----------

  async function openSession(id) {
    sessionId = id;
    approvals.clear();
    live = null;
    ui.setLeft(el('button', { class: 'm-head-btn', 'aria-label': 'Back', onclick: showList }, el('span', { html: ICONS.back })));
    fill(scroll, loading());

    unsub?.();
    unsub = sub(`agent:${id}`, onEvent);

    try {
      const s = await get('/agent/sessions/' + id);
      ui.setTitle(s.title || 'Session', s.running ? 'running' : s.mode || '');
      ui.setActions(
        s.running ? ui.action('stop', 'Cancel run', () => wsSend({ t: 'agent.cancel', sessionId: id })) : null,
        ui.action('send', 'Reply', reply),
      );
      fill(scroll);
      for (const m of s.messages || []) {
        if (m.role === 'user') addBubble('user', m.content || m.text || '');
        else if (m.role === 'assistant' && (m.content || m.text)) addBubble('assistant', m.content || m.text);
      }
      // A session that stopped on an approval re-advertises it on reconnect; if it did
      // not, the pending call is still on the record.
      for (const p of s.pendingApprovals || []) addApproval(p);
      enhanceCode(scroll);
      toBottom(scroll);
    } catch (e) {
      fill(scroll, errorBox(e, () => openSession(id)));
    }
  }

  function addBubble(role, content) {
    const body = el('div', { class: 'm-bubble' });
    body.innerHTML = role === 'user'
      ? String(content).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>')
      : renderMarkdown(content);
    const wrap = el('div', { class: 'm-msg is-' + role }, body);
    scroll.append(wrap);
    return { wrap, body };
  }

  // ---------- approvals ----------

  function addApproval(ev) {
    const card = el('div', { class: 'm-approve' },
      el('div', { class: 'm-approve-head' },
        el('span', { class: 'm-prop-badge is-ask' }, 'Approve?'),
        el('div', { class: 'm-prop-title' }, ev.name)),
      ev.args ? el('pre', { class: 'm-pre m-approve-args' }, JSON.stringify(ev.args, null, 2).slice(0, 1200)) : null,
      ev.diff ? el('pre', { class: 'm-pre m-diff' }, String(ev.diff).slice(0, 4000)) : null,
      el('div', { class: 'm-prop-actions' },
        el('button', { class: 'm-btn is-primary', onclick: () => decide(ev.callId, 'allow') }, 'Allow'),
        el('button', { class: 'm-btn', onclick: () => decide(ev.callId, 'always') }, 'Always'),
        el('button', { class: 'm-btn is-ghost is-danger', onclick: () => decide(ev.callId, 'deny') }, 'Deny')));
    approvals.set(ev.callId, card);
    scroll.append(card);
    buzz(15);
    toBottom(scroll, true);
    return card;
  }

  function decide(callId, decision) {
    wsSend({ t: 'agent.approve', sessionId, callId, decision });
    const card = approvals.get(callId);
    if (card) {
      card.classList.add('is-settled');
      fill(card, el('div', { class: 'm-approve-head' },
        el('span', { class: 'm-prop-badge' }, decision === 'deny' ? 'Denied' : 'Allowed')));
    }
    approvals.delete(callId);
    buzz();
  }

  // ---------- events ----------

  function onEvent({ ev }) {
    if (!ev) return;
    const stick = atBottom(scroll);
    switch (ev.type) {
      case 'user':
        addBubble('user', ev.text || '');
        break;
      case 'text.delta':
        if (!live) { live = addBubble('assistant', ''); live.buf = ''; }
        live.buf += ev.delta || '';
        live.body.innerHTML = renderMarkdown(live.buf);
        break;
      case 'text.done':
        if (live) { enhanceCode(live.body); live = null; }
        break;
      case 'tool.start':
        live = null;
        scroll.append(el('div', { class: 'm-tool is-run' }, el('span', { class: 'm-tool-n' }, ev.name)));
        break;
      case 'tool.end':
        scroll.append(el('div', { class: 'm-tool ' + (ev.ok === false ? 'is-err' : 'is-ok') },
          el('span', { class: 'm-tool-n' }, ev.name)));
        break;
      case 'approval.request':
        live = null;
        addApproval(ev);
        break;
      case 'approval.resolved': {
        const card = approvals.get(ev.callId);
        if (card) { card.classList.add('is-settled'); approvals.delete(ev.callId); }
        break;
      }
      case 'plan.proposed':
        live = null;
        scroll.append(planCard(ev));
        break;
      case 'status':
        ui.setTitle(document.querySelector('.m-title')?.textContent || 'Session', ev.message || '');
        break;
      case 'turn.done':
        live = null;
        ui.setTitle(document.querySelector('.m-title')?.textContent || 'Session', 'idle');
        break;
      case 'error':
        live = null;
        scroll.append(el('div', { class: 'm-msg-err' }, ev.message || 'Agent error'));
        break;
    }
    if (stick) toBottom(scroll);
  }

  function planCard(ev) {
    const card = el('div', { class: 'm-approve' },
      el('div', { class: 'm-approve-head' },
        el('span', { class: 'm-prop-badge is-ask' }, 'Plan'),
        el('div', { class: 'm-prop-title' }, 'Approve this plan?')),
      (() => { const a = el('article', { class: 'm-md' }); a.innerHTML = renderMarkdown(ev.plan || ev.text || ''); return a; })(),
      el('div', { class: 'm-prop-actions' },
        el('button', { class: 'm-btn is-primary', onclick: () => { wsSend({ t: 'agent.plan', sessionId, decision: 'approve' }); card.classList.add('is-settled'); } }, 'Approve'),
        el('button', { class: 'm-btn is-ghost', onclick: () => { wsSend({ t: 'agent.plan', sessionId, decision: 'reject' }); card.classList.add('is-settled'); } }, 'Reject')));
    return card;
  }

  // ---------- reply ----------

  async function reply() {
    const text = await askSheet('Reply to the agent', { placeholder: 'Your message', ok: 'Send', multiline: true });
    if (!text) return;
    addBubble('user', text);
    toBottom(scroll, true);
    wsSend({ t: 'agent.user', sessionId, text, attachments: [] });
  }

  // ---------- boot ----------

  if (sessionId) await openSession(sessionId);
  else await showList();

  return { unmount() { unsub?.(); } };
}
