// Research: deep, cited web research runs. The server orchestrates the loop
// (plan → search → read → reflect → synthesize); this app streams the progress
// timeline and renders the final report with sources.

import { el, icon, toast, confirmBox, modelPicker, timeAgo, throttle, thinkingPanel, perfBadge } from '../ui.js';
import { get, post, del, wsSend, sub } from '../api.js';
import { renderMd } from '../markdown.js';

const DEPTHS = [['quick', 'Quick'], ['standard', 'Standard'], ['deep', 'Deep']];

export default {
  id: 'research', title: 'Research', icon: 'research',

  mount(body, opts, win) {
    const S = win.researchState = { id: null, unsub: null, running: false, buf: '', reportEl: null, think: null, reasonEl: null };
    const ui = {};

    const side = el('div', { class: 'side' },
      el('div', { class: 'side-head' },
        el('span', { class: 'ttl' }, 'Research'),
        el('button', { class: 'btn sm ghost', title: 'New research', onclick: () => reset() }, icon('plus'))),
      ui.list = el('div', { class: 'side-list' }));

    ui.model = modelPicker({ storageKey: 'research' });
    ui.depth = el('div', { class: 'seg' }, ...DEPTHS.map(([v, label]) =>
      el('button', {
        class: 'seg-btn' + (savedDepth() === v ? ' on' : ''), dataset: { depth: v },
        onclick: () => { localStorage.setItem('aios.research.depth', v); paintDepth(v); },
      }, label)));
    ui.stop = el('button', { class: 'btn sm danger', style: { display: 'none' }, onclick: () => wsSend({ t: 'research.cancel', id: S.id }) }, icon('stop'), 'Stop');
    ui.exportBtn = el('button', { class: 'btn sm ghost', style: { display: 'none' }, title: 'Save report into your vault', onclick: exportVault }, icon('vault'), 'To vault');
    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl' }, 'Deep research'),
      ui.depth, ui.model, ui.stop, ui.exportBtn,
      el('span', { class: 'grow' }),
      el('button', { class: 'btn sm ghost danger', title: 'Delete this research', onclick: deleteRun }, icon('trash')));

    ui.events = el('div', { class: 'agent-events' });
    body.append(el('div', { class: 'app-cols' }, side, el('div', { class: 'main-pane' }, ui.head, ui.events)));

    function savedDepth() { return localStorage.getItem('aios.research.depth') || 'standard'; }
    function paintDepth(v) { for (const b of ui.depth.children) b.classList.toggle('on', b.dataset.depth === v); }

    // ---------- runs list ----------

    async function refreshList() {
      let runs = [];
      try { runs = await get('/research'); } catch { }
      ui.list.innerHTML = '';
      for (const r of runs) {
        ui.list.append(el('div', { class: 'side-item' + (r.id === S.id ? ' sel' : ''), onclick: () => load(r.id) },
          (r.status === 'running' ? '● ' : '') + r.question,
          el('div', { class: 'sub' }, `${timeAgo(r.updatedAt)} · ${r.sources} sources · ${r.depth}${r.status === 'error' ? ' · failed' : ''}`)));
      }
      if (!runs.length) ui.list.append(el('div', { class: 'empty', style: { minHeight: '70px' } }, 'no research yet'));
    }

    // ---------- composer (new run) ----------

    function reset() {
      S.unsub?.(); S.unsub = null; S.id = null; S.buf = ''; S.reportEl = null; S.think = null; S.reasonEl = null; S.reportDone = false;
      setRunning(false);
      ui.exportBtn.style.display = 'none';
      ui.events.innerHTML = '';
      const input = el('textarea', { class: 'composer-input', rows: 3, placeholder: 'What do you want to know?  e.g. "What are the tradeoffs between SQLite and Postgres for a small self-hosted app?"' });
      const start = el('button', { class: 'btn primary', onclick: () => startRun(input.value) }, icon('research'), 'Start research');
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startRun(input.value); } });
      ui.events.append(el('div', { class: 'res-hero' },
        el('h1', {}, 'Deep research'),
        el('div', { class: 'sub' }, 'Plans searches, reads real sources via SearXNG, loops on the gaps, and writes a cited report. Deeper = more rounds, more sources, more time.'),
        el('div', { class: 'composer-box', style: { marginTop: '14px' } }, input,
          el('div', { class: 'composer-row' }, el('span', { class: 'grow' }), start))));
      refreshList();
      setTimeout(() => input.focus(), 50);
    }

    async function startRun(question) {
      question = (question || '').trim();
      if (!question) return;
      if (!ui.model.getValue()) { toast('pick a model first', 'err'); return; }
      try {
        const r = await post('/research', { question, modelRef: ui.model.getValue(), depth: savedDepth() });
        await load(r.id);
      } catch (e) { toast(e.message, 'err'); }
    }

    // ---------- load & render a run ----------

    async function load(id) {
      S.unsub?.();
      const r = await get('/research/' + id);
      S.id = id; S.buf = ''; S.reportEl = null; S.reasonEl = null; S.reportDone = false;
      ui.events.innerHTML = '';
      ui.exportBtn.style.display = r.report ? '' : 'none';
      setRunning(r.running);

      ui.events.append(el('div', { class: 'ev-user' }, r.question));
      // the progress timeline lives inside a collapsible "thinking" panel that
      // auto-collapses once the report is ready
      ui.log = el('div', { class: 'res-log' });
      const settled = !r.running && !!r.report;
      S.think = thinkingPanel({ label: settled ? 'Research process' : 'Researching', doneLabel: 'Research process', body: ui.log, collapsed: settled });
      ui.events.append(S.think.node);

      if (r.subs?.length) logLine('plan', `sub-questions: ${r.subs.join(' · ')}`);
      if (r.queries.length) logLine('plan', `queries: ${r.queries.join(' · ')}`);
      for (const s of r.sources) logLine('source', `[${s.n}] ${s.title}`, s.url);
      if (r.status === 'error') logLine('error', r.error || 'failed');
      if (r.status === 'cancelled') logLine('info', 'cancelled');
      if (r.report) renderReport(r.report);
      if (r.running) S.unsub = sub('research:' + id, onEvent);
      refreshList();
      scrollDown(true);
    }

    function logLine(kind, text, href) {
      S.reasonEl = null; // a concrete step commits any in-progress reasoning line
      const line = el('div', { class: 'res-line ' + kind },
        icon(kind === 'source' ? 'file' : kind === 'search' ? 'search' : kind === 'error' ? 'x' : kind === 'round' ? 'refresh' : kind === 'plan' ? 'research' : 'chevR'),
        href ? el('a', { href, target: '_blank', rel: 'noreferrer' }, text) : el('span', {}, text));
      ui.log.append(line);
      return line;
    }

    // the model's live thinking during plan/reflect/synthesis — streamed into the timeline
    function reasonStream(delta) {
      if (!S.reasonEl) {
        S.reasonEl = el('div', { class: 'res-line reason' }, icon('sparkle'), el('span', { class: 'reason-text' }));
        ui.log.append(S.reasonEl);
        S.reasonEl._buf = '';
      }
      S.reasonEl._buf += delta;
      S.reasonEl.querySelector('.reason-text').textContent = S.reasonEl._buf;
      if (S.think?.node.classList.contains('open')) ui.log.scrollTop = ui.log.scrollHeight;
    }

    function renderReport(md) {
      if (!S.reportEl) { S.reportEl = el('div', { class: 'ev-text res-report' }); ui.events.append(S.reportEl); }
      S.reportEl.innerHTML = '';
      S.reportEl.append(renderMd(md));
    }
    const rerenderLive = throttle(() => { if (S.reportDone) return; renderReport(S.buf + ' ▍'); scrollDown(); }, 80);

    function onEvent({ ev }) {
      switch (ev.type) {
        case 'status':
          ui.statusLine?.remove();
          if (ev.phase !== 'done') ui.statusLine = logLine('info', `${ev.phase}${ev.detail ? ` — ${ev.detail.slice(0, 90)}` : ''}…`);
          scrollDown();
          break;
        case 'perf': {
          // running aggregate across the run's many model calls
          if (!ui.perf) { ui.perf = el('span', { class: 'chip usage-chip' }); ui.head?.insertBefore(ui.perf, ui.head.querySelector('.grow')); }
          ui.perf.innerHTML = '';
          const b = perfBadge({ tokS: ev.tokS, ttftMs: 0, outTokens: ev.tokens, totalMs: ev.genMs }, { compact: true });
          if (b) ui.perf.append(b);
          ui.perf.title = `${ev.tokens} tokens generated across ${ev.calls} model call(s) · ${ev.tokS} tok/s average (last call ${ev.lastTokS})`;
          break;
        }
        case 'plan':
          if (ev.subs?.length) logLine('plan', `sub-questions: ${ev.subs.join(' · ')}`);
          logLine('plan', `queries: ${ev.queries.join(' · ')}`);
          break;
        case 'coverage':
          logLine('info', `coverage: ${ev.covered} answered${ev.gaps.length ? ` · gaps: ${ev.gaps.map(g => g.slice(0, 60)).join(' · ')}` : ' — all sub-questions covered'}`);
          break;
        case 'round': if (ev.n > 1) logLine('round', `round ${ev.n}/${ev.of}: ${ev.queries.join(' · ')}`); break;
        case 'search': logLine('search', `"${ev.query}" → ${ev.found} results${ev.error ? ` (${ev.error})` : ''}`); break;
        case 'source': logLine('source', `[${ev.n}] ${ev.title}`, ev.url); break;
        case 'note': if (ev.skipped) logLine('info', `      skipped (${ev.skipped})`); break;
        case 'reason.delta': reasonStream(ev.delta); scrollDown(); break;
        case 'report.delta': S.reasonEl = null; S.buf += ev.delta; rerenderLive(); break;
        case 'done':
          ui.statusLine?.remove();
          S.reportDone = true;         // stop the debounced live render from clobbering the final report
          S.think?.done();
          if (ev.cancelled) { logLine('info', 'cancelled'); setRunning(false); refreshList(); break; }
          renderReport(ev.report);
          ui.exportBtn.style.display = '';
          setRunning(false);
          refreshList();
          scrollDown();
          break;
        case 'error':
          ui.statusLine?.remove();
          logLine('error', ev.message);
          S.think?.done();
          toast(ev.message, 'err');
          setRunning(false);
          refreshList();
          break;
      }
    }

    // ---------- actions ----------

    async function exportVault() {
      if (!S.id) return;
      try {
        const r = await post(`/research/${S.id}/export`);
        toast('saved to vault: ' + r.path, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }

    async function deleteRun() {
      if (!S.id) { reset(); return; }
      if (!await confirmBox('Delete this research?', 'The report and its sources will be removed.')) return;
      await del('/research/' + S.id);
      reset();
    }

    function setRunning(v) {
      S.running = v;
      ui.stop.style.display = v ? '' : 'none';
    }

    function scrollDown(force) {
      const nearBottom = ui.events.scrollHeight - ui.events.scrollTop - ui.events.clientHeight < 240;
      if (force || nearBottom) ui.events.scrollTop = ui.events.scrollHeight;
    }

    if (opts.id) load(opts.id); else reset();
    this.reopen = (w, o) => { if (o?.fresh) reset(); else if (o?.id) load(o.id); };
  },

  unmount(win) { win.researchState?.unsub?.(); },
};
