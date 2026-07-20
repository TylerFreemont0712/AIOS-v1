// Bench: which model is best at which job — measured, not vibes.
// Pick models → run the deterministic suite → scores and speed land in SQLite and the
// leaderboard updates. "Best for task" names a winner per category. The local-model
// switcher swaps the managed llama-server to any gguf on disk.

import { el, icon, toast, menu, timeAgo } from '../ui.js';
import { get, post, del, sub } from '../api.js';

const pctCls = (v) => v >= 0.8 ? 'good' : v >= 0.5 ? 'mid' : 'bad';
const fmt = (v) => v === undefined ? '—' : Math.round(v * 100) + '%';

export default {
  id: 'bench', title: 'Bench', icon: 'graph', width: 1200, height: 760,

  mount(body, opts, win) {
    const S = win.benchState = { models: [], picked: new Set(), board: null, unsub: null, running: false, log: [] };
    const ui = {};

    ui.pickBtn = el('button', { class: 'btn sm', onclick: pickModels }, icon('cpu'), ' Models ', el('span', { class: 'chip' }, '0'));
    ui.run = el('button', { class: 'btn sm primary', onclick: () => runSuite() }, icon('play'), 'Run suite');
    ui.stop = el('button', { class: 'btn sm danger', style: { display: 'none' }, onclick: () => post('/bench/stop', {}) }, icon('stop'), 'Stop');
    ui.swap = el('button', { class: 'btn sm ghost', title: 'Swap the managed llama-server to another local gguf', onclick: pickLocalModel }, icon('refresh'), 'Local model');

    ui.sweep = el('button', { class: 'btn sm', title: 'Run the full suite over EVERY local model in sequence — each auto-serves on its turn. Start it and walk away.', onclick: runSweep }, icon('cpu'), 'Sweep local');
    ui.clear = el('button', { class: 'btn sm ghost danger', title: 'Delete ALL recorded results — fresh start (e.g. after the suite changes)', onclick: clearAll }, icon('trash'), 'Clear results');

    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl row', style: { gap: '7px' } }, icon('graph'), 'LLM Bench'),
      ui.pickBtn, ui.run, ui.sweep, ui.stop,
      el('span', { class: 'grow' }),
      ui.clear, ui.swap);

    ui.main = el('div', { class: 'bench-main' });
    body.append(el('div', { class: 'main-pane' }, ui.head, ui.main));

    async function refresh() {
      try { S.board = await get('/bench'); } catch (e) { toast(e.message, 'err'); return; }
      S.running = S.board.running;
      ui.stop.style.display = S.running ? '' : 'none';
      ui.run.disabled = S.running;
      paint();
    }

    function paint() {
      const b = S.board;
      ui.main.innerHTML = '';
      if (!b) return;

      // best-for-task strip — the headline answer to "which model for this job?"
      const cats = Object.entries(b.best || {});
      if (cats.length) {
        ui.main.append(el('div', { class: 'bench-best' },
          el('div', { class: 'learn-lbl' }, 'BEST FOR TASK'),
          el('div', { class: 'row', style: { gap: '7px', flexWrap: 'wrap' } },
            ...cats.map(([cat, w]) => el('div', { class: 'bench-best-chip' },
              el('span', { class: 'bench-best-cat' }, cat),
              el('span', { class: 'mono' }, shortModel(w.model)),
              el('span', { class: 'learn-tag sm ' + pctCls(w.score) }, fmt(w.score)))))));
      }

      // live progress during a run
      if (S.log.length) {
        ui.main.append(el('div', { class: 'bench-log' },
          el('div', { class: 'learn-lbl' }, 'RUNNING'),
          ...S.log.slice(-12).map(l => el('div', { class: 'res-line ' + (l.cls || 'info') }, icon(l.ico || 'chevR'), el('span', {}, l.text)))));
      }

      // leaderboard
      const catNames = [...new Set((b.tests || []).map(t => t.category))];
      if (b.models?.length) {
        const table = el('table', { class: 'bench-table' });
        table.append(el('thead', {}, el('tr', {},
          el('th', {}, 'model'), el('th', { title: 'average score across all tests' }, 'quality'),
          el('th', { title: 'quality 70% + speed 30% — what you actually feel using it' }, 'value'),
          ...catNames.map(c => el('th', {}, c)),
          el('th', {}, 'tok/s'), el('th', { title: 'average time to first token — prompt processing' }, 'ttft'),
          el('th', {}, 'coverage'), el('th', {}, 'last run'))));
        const tb = el('tbody');
        b.models.forEach((m, i) => {
          tb.append(el('tr', { class: i === 0 ? 'lead' : '' },
            el('td', { class: 'mono', title: m.model }, (i === 0 ? '🏆 ' : '') + shortModel(m.model)),
            el('td', {}, el('span', { class: 'learn-tag ' + pctCls(m.overall) }, fmt(m.overall))),
            el('td', {}, el('span', { class: 'learn-tag ' + pctCls(m.value ?? 0), title: 'quality + speed' }, fmt(m.value))),
            ...catNames.map(c => el('td', {},
              m.categories[c] === undefined ? el('span', { class: 'muted' }, '—')
                : el('span', { class: 'learn-tag sm ' + pctCls(m.categories[c]) }, fmt(m.categories[c])))),
            el('td', { class: 'mono', title: m.speedScore !== undefined ? `speed score ${fmt(m.speedScore)} (40 tok/s = full marks)` : '' }, m.tokS ? String(m.tokS) : '—'),
            el('td', { class: 'mono muted small' }, m.ttftMs ? (m.ttftMs >= 1000 ? (m.ttftMs / 1000).toFixed(1) + 's' : m.ttftMs + 'ms') : '—'),
            el('td', { class: 'muted small' }, `${m.covered}/${(b.tests || []).length}`),
            el('td', { class: 'muted small' }, timeAgo(m.at))));
        });
        table.append(tb);
        ui.main.append(el('div', { class: 'bench-scroll' }, table));
      } else {
        ui.main.append(el('div', { class: 'res-hero' },
          el('h1', {}, 'No results yet'),
          el('div', { class: 'sub' }, 'Pick models, run the suite. Every test is scored programmatically — parsed, matched, or executed — never judged by another LLM, so scores stay comparable as you hop between models. Speed is recorded too, because on local hardware tok/s decides as much as IQ.'),
          el('button', { class: 'btn primary', style: { marginTop: '14px' }, onclick: pickModels }, icon('cpu'), 'Pick models')));
      }

      // the suite itself
      ui.main.append(el('div', { class: 'bench-tests' },
        el('div', { class: 'learn-lbl' }, 'THE SUITE'),
        ...(b.tests || []).map(t => el('div', { class: 'bench-test-row' },
          el('span', { class: 'learn-tag sm' }, t.category),
          el('b', {}, t.name),
          el('span', { class: 'muted small' }, t.what)))));
    }

    const shortModel = (ref) => String(ref).split(':').pop().slice(0, 28);

    async function pickModels() {
      let models = [];
      try { models = await get('/models'); } catch (e) { toast(e.message, 'err'); return; }
      if (!models.length) { toast('no models reachable — check Settings → Providers', 'err'); return; }
      const r = ui.pickBtn.getBoundingClientRect();
      menu(r.left, r.bottom + 4, models.slice(0, 20).map(m => ({
        label: (S.picked.has(m.ref) ? '✓ ' : '') + m.label,
        onclick: () => {
          S.picked.has(m.ref) ? S.picked.delete(m.ref) : S.picked.add(m.ref);
          ui.pickBtn.querySelector('.chip').textContent = String(S.picked.size);
          pickModels();   // reopen so multi-select feels continuous
        },
      })));
    }

    async function pickLocalModel() {
      let r0;
      try { r0 = await get('/llm/models'); } catch (e) { toast(e.message, 'err'); return; }
      if (!r0.models.length) { toast('no local gguf models found', 'err'); return; }
      const r = ui.swap.getBoundingClientRect();
      menu(r.left, r.bottom + 4, r0.models.map(m => ({
        label: `${m.file} (${m.sizeGB} GB)`,
        onclick: async () => {
          toast(`loading ${m.file} — big models take a while…`, 'ok');
          try { const res = await post('/llm/model', { path: m.path }); toast(`llama-server now serves ${res.profile} (${((res.ms || 0) / 1000).toFixed(0)}s)`, 'ok'); }
          catch (e) { toast(e.message, 'err'); }
        },
      })));
    }

    async function runSweep() {
      S.log = [];
      try { const r = await post('/bench/sweep', {}); toast(`sweeping ${r.models.length} local models — each loads automatically as its turn comes`, 'ok'); }
      catch (e) { toast(e.message, 'err'); return; }
      S.running = true; ui.run.disabled = true; ui.sweep.disabled = true; ui.stop.style.display = '';
    }

    async function clearAll() {
      const { confirmBox } = await import('../ui.js');
      if (!await confirmBox('Clear ALL bench results?', 'Every recorded score and speed measurement is deleted. The suite itself stays. This is the fresh-start for a new test generation.', 'Clear everything')) return;
      try { const r = await del('/bench/runs'); toast(`cleared ${r.cleared} recorded runs`, 'ok'); S.log = []; refresh(); }
      catch (e) { toast(e.message, 'err'); }
    }

    async function runSuite() {
      if (!S.picked.size) { toast('pick at least one model first', 'err'); return; }
      S.log = [];
      try { await post('/bench/run', { models: [...S.picked] }); }
      catch (e) { toast(e.message, 'err'); return; }
      S.running = true;
      ui.run.disabled = true;
      ui.stop.style.display = '';
    }

    function onEvent({ ev }) {
      if (ev.type === 'test.start') S.log.push({ text: `${shortModel(ev.model)} · ${ev.test} …`, ico: 'play' });
      else if (ev.type === 'test.done') S.log.push({ text: `${shortModel(ev.model)} · ${ev.test} → ${fmt(ev.score)} (${ev.detail}${ev.tokS ? ` · ${ev.tokS} tok/s` : ''})`, cls: ev.score >= 0.8 ? 'info' : 'error', ico: ev.score >= 0.5 ? 'check' : 'x' });
      else if (ev.type === 'model.done') S.log.push({ text: `${shortModel(ev.model)} — done`, ico: 'check' });
      else if (ev.type === 'done') { S.log.push({ text: ev.cancelled ? 'stopped' : 'suite complete', ico: 'check' }); ui.sweep.disabled = false; refresh(); return; }
      paint();
    }

    S.unsub = sub('bench', onEvent);
    refresh();
  },

  unmount(win) { win.benchState?.unsub?.(); },
};
