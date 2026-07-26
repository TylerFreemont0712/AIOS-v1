// Bench: which model is best at which job — measured, not vibes.
// Pick models → run the deterministic suite → scores and speed land in SQLite and the
// leaderboard updates. "Best for task" names a winner per category. Click any model to
// drill into HOW it did on every skill — the exact per-case breakdown of the last run,
// straight from SQL — and overlay models on a radar chart to see who wins where.

import { el, icon, toast, menu, timeAgo, modal, confirmBox } from '../ui.js';
import { get, post, del, sub } from '../api.js';

const pctCls = (v) => v >= 0.8 ? 'good' : v >= 0.5 ? 'mid' : 'bad';
const fmt = (v) => v === undefined || v === null ? '—' : Math.round(v * 100) + '%';
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const shortModel = (ref) => String(ref).split(':').pop().slice(0, 28);
const RADAR_PALETTE = ['#4f8cff', '#ff7a59', '#38b000', '#c05cff', '#ffb703', '#00c2c7', '#ff5d8f', '#8d99ae'];

export default {
  id: 'bench', title: 'Bench', icon: 'graph', width: 1220, height: 780,

  mount(body, opts, win) {
    const S = win.benchState = { board: null, picked: new Set(), pickedTests: new Set(), reasoning: 'medium', unsub: null, running: false, log: [], detailModel: null, detailRender: null };
    const ui = {};

    ui.pickBtn = el('button', { class: 'btn sm', onclick: pickModels }, icon('cpu'), ' Models ', el('span', { class: 'chip' }, '0'));
    ui.skillBtn = el('button', { class: 'btn sm', title: 'Run only selected skills instead of the whole suite', onclick: pickSkills }, icon('graph'), ' Skills ', el('span', { class: 'chip' }, 'all'));
    ui.reasonBtn = el('button', { class: 'btn sm', title: 'How hard the model thinks before answering. Reasoning models (ornith, Qwen3, R1) get a bigger token budget at higher levels so they are never cut off mid-thought.', onclick: pickReasoning }, icon('sparkle'), ' Think: ', el('span', { class: 'chip' }, S.reasoning));
    ui.run = el('button', { class: 'btn sm primary', onclick: () => runSuite() }, icon('play'), 'Run');
    ui.stop = el('button', { class: 'btn sm danger', style: { display: 'none' }, onclick: () => post('/bench/stop', {}) }, icon('stop'), 'Stop');
    ui.radar = el('button', { class: 'btn sm', title: 'Overlay models on a capability radar', onclick: () => openRadar() }, icon('graph'), 'Radar');
    ui.swap = el('button', { class: 'btn sm ghost', title: 'Swap the managed llama-server to another local gguf', onclick: pickLocalModel }, icon('refresh'), 'Local model');
    ui.sweep = el('button', { class: 'btn sm', title: 'Run the full suite over EVERY local model in sequence — each auto-serves on its turn. Start it and walk away.', onclick: runSweep }, icon('cpu'), 'Sweep');
    ui.clear = el('button', { class: 'btn sm ghost danger', title: 'Delete ALL recorded results — fresh start (e.g. after the suite changes)', onclick: clearAll }, icon('trash'), 'Clear');

    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl row', style: { gap: '7px' } }, icon('graph'), 'LLM Bench'),
      ui.pickBtn, ui.skillBtn, ui.reasonBtn, ui.run, ui.stop, ui.sweep, ui.radar,
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

      // leaderboard — the models are the star of the show; click a row to drill in
      const catNames = [...new Set((b.tests || []).map(t => t.category))];
      if (b.models?.length) {
        const table = el('table', { class: 'bench-table' });
        table.append(el('thead', {}, el('tr', {},
          el('th', {}, 'model'), el('th', { title: 'average score across all tests' }, 'quality'),
          el('th', { title: 'quality 70% + speed 30% — what you actually feel using it' }, 'value'),
          ...catNames.map(c => el('th', {}, c)),
          el('th', {}, 'tok/s'), el('th', { title: 'average time to first token — prompt processing' }, 'ttft'),
          el('th', {}, 'coverage'), el('th', {}, 'last run'), el('th', {}, ''))));
        const tb = el('tbody');
        b.models.forEach((m, i) => {
          tb.append(el('tr', { class: (i === 0 ? 'lead ' : '') + 'clickable', title: 'Click to inspect every skill', onclick: () => openModelDetail(m.model) },
            el('td', { class: 'mono', title: m.model }, (i === 0 ? '🏆 ' : '') + shortModel(m.model)),
            el('td', {}, el('span', { class: 'learn-tag ' + pctCls(m.overall) }, fmt(m.overall))),
            el('td', {}, el('span', { class: 'learn-tag ' + pctCls(m.value ?? 0), title: 'quality + speed' }, fmt(m.value))),
            ...catNames.map(c => el('td', {},
              m.categories[c] === undefined ? el('span', { class: 'muted' }, '—')
                : el('span', { class: 'learn-tag sm ' + pctCls(m.categories[c]) }, fmt(m.categories[c])))),
            el('td', { class: 'mono', title: m.speedScore !== undefined ? `speed score ${fmt(m.speedScore)} (40 tok/s = full marks)` : '' }, m.tokS ? String(m.tokS) : '—'),
            el('td', { class: 'mono muted small' }, m.ttftMs ? (m.ttftMs >= 1000 ? (m.ttftMs / 1000).toFixed(1) + 's' : m.ttftMs + 'ms') : '—'),
            el('td', { class: 'muted small' }, `${m.covered}/${(b.tests || []).length}`),
            el('td', { class: 'muted small' }, timeAgo(m.at)),
            el('td', { class: 'muted' }, icon('expand'))));
        });
        table.append(tb);
        ui.main.append(el('div', { class: 'bench-scroll' }, table));
        ui.main.append(el('div', { class: 'muted small', style: { marginTop: '-6px' } },
          `${(b.tests || []).length} skills across ${catNames.length} categories · ${langSummary(b.tests)} · click a model to see the per-case breakdown of its last run`));
      } else {
        ui.main.append(el('div', { class: 'res-hero' },
          el('h1', {}, 'No results yet'),
          el('div', { class: 'sub' }, 'Pick models, run the suite. Every test is scored programmatically — parsed, matched, or executed in Python, JavaScript, Go and C++ — never judged by another LLM. Each run records exactly what the model produced, case by case, so you can drill into how it did. Speed is recorded too: on local hardware tok/s decides as much as IQ.'),
          el('button', { class: 'btn primary', style: { marginTop: '14px' }, onclick: pickModels }, icon('cpu'), 'Pick models')));
      }
    }

    const langSummary = (tests) => {
      const langs = [...new Set((tests || []).map(t => t.lang).filter(Boolean))];
      return langs.length ? `code: ${langs.join(', ')}` : 'text + code';
    };

    // ---------- model drill-down ----------

    function stat(label, value, cls) {
      return el('div', { class: 'bench-stat' },
        el('div', { class: 'bench-stat-v' + (cls ? ' ' + cls : '') }, value),
        el('div', { class: 'bench-stat-l' }, label));
    }

    function openModelDetail(ref) {
      const bodyEl = el('div', { class: 'bench-detail' });
      const render = () => {
        const b = S.board;
        const m = b.models.find(x => x.model === ref);
        bodyEl.innerHTML = '';
        if (!m) { bodyEl.append(el('div', { class: 'muted' }, 'No results recorded for this model.')); return; }
        bodyEl.append(el('div', { class: 'bench-detail-stats' },
          stat('quality', fmt(m.overall), pctCls(m.overall)),
          stat('value', fmt(m.value), pctCls(m.value)),
          stat('tok/s', m.tokS ? String(m.tokS) : '—'),
          stat('ttft', m.ttftMs ? (m.ttftMs >= 1000 ? (m.ttftMs / 1000).toFixed(1) + 's' : m.ttftMs + 'ms') : '—'),
          stat('coverage', `${m.covered}/${b.tests.length}`),
          stat('last run', timeAgo(m.at))));

        const byCat = {};
        for (const t of b.tests) (byCat[t.category] ||= []).push(t);
        for (const [cat, tests] of Object.entries(byCat)) {
          const catScore = m.categories[cat];
          const sec = el('div', { class: 'bench-detail-cat' });
          sec.append(el('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginBottom: '4px' } },
            el('div', { class: 'learn-lbl grow' }, cat),
            catScore !== undefined ? el('span', { class: 'learn-tag sm ' + pctCls(catScore) }, fmt(catScore)) : el('span', { class: 'muted small' }, 'not run')));
          for (const t of tests) sec.append(testRow(m, t));
          bodyEl.append(sec);
        }
      };
      S.detailModel = ref; S.detailRender = render;
      render();
      modal({
        title: shortModel(ref), sub: ref, xl: true, body: bodyEl,
        actions: [
          { label: 'Radar compare', onpick: () => { openRadar([ref]); return false; } },
          { label: 'Re-run all skills', onpick: (close) => { rerunSkill(ref, []); close(null); } },
          { label: 'Close', value: null },
        ],
      }).then(() => { S.detailModel = null; S.detailRender = null; });
    }

    function testRow(m, t) {
      const res = m.tests[t.id];
      const panel = el('div', { class: 'bench-trow-panel', style: { display: 'none' } });
      let built = false;
      const head = el('div', { class: 'bench-trow-head' },
        icon('chevR'),
        res ? el('span', { class: 'learn-tag sm ' + pctCls(res.score) }, fmt(res.score)) : el('span', { class: 'muted small' }, '—'),
        el('b', {}, t.name),
        t.lang ? el('span', { class: 'learn-tag sm' }, t.lang) : null,
        res?.reasoning ? el('span', { class: 'learn-tag sm', title: 'reasoning level used for this run' }, '🧠 ' + res.reasoning) : null,
        el('span', { class: 'muted small grow ell' }, res ? res.detail : 'not run'),
        el('button', { class: 'btn sm ghost', title: 'Run just this skill for this model', onclick: (e) => { e.stopPropagation(); rerunSkill(m.model, t.id); } }, icon('refresh'), 'run'));
      head.addEventListener('click', () => {
        const open = panel.style.display === 'none';
        panel.style.display = open ? '' : 'none';
        head.classList.toggle('open', open);
        if (open && !built) { built = true; buildPanel(panel, t, res); }
      });
      return el('div', { class: 'bench-trow' }, head, panel);
    }

    function buildPanel(panel, t, res) {
      panel.append(el('div', { class: 'muted small', style: { marginBottom: '6px' } }, t.what || ''));
      if (!res) { panel.append(el('div', { class: 'muted small' }, 'This skill has not been run for this model yet — hit “run”.')); return; }
      const bd = res.breakdown || [];
      if (bd.length) {
        const table = el('table', { class: 'bk-table' });
        table.append(el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'check'), el('th', {}, 'expected'), el('th', {}, 'got'))));
        const tb = el('tbody');
        for (const r of bd) tb.append(el('tr', { class: r.pass ? '' : 'bk-fail' },
          el('td', { class: 'bk-mark' }, r.pass ? '✓' : '✗'),
          el('td', { class: 'mono small' }, r.label + (r.note ? ` — ${r.note}` : '')),
          el('td', { class: 'mono small' }, clip(r.expected, 46)),
          el('td', { class: 'mono small' }, clip(r.got, 46))));
        table.append(tb);
        panel.append(el('div', { class: 'bench-scroll' }, table));
      } else {
        panel.append(el('div', { class: 'muted small' }, 'No per-case breakdown recorded (older run — re-run this skill to capture it).'));
      }
      if (res.output) {
        const pre = el('pre', { class: 'bench-output', style: { display: 'none' } }, res.output);
        panel.append(el('button', { class: 'btn sm ghost', style: { marginTop: '6px' }, onclick: () => { pre.style.display = pre.style.display === 'none' ? '' : 'none'; } }, icon('eye'), 'raw model output'), pre);
      }
    }

    // ---------- radar compare ----------

    function radarSVG(cats, series, size = 460) {
      const cx = size / 2, cy = size / 2 + 4, R = size / 2 - 78;
      const n = cats.length || 1;
      const ang = (i) => -Math.PI / 2 + i * 2 * Math.PI / n;
      const P = (i, r) => [(cx + Math.cos(ang(i)) * R * r).toFixed(1), (cy + Math.sin(ang(i)) * R * r).toFixed(1)];
      const poly = (pts) => pts.map(p => p.join(',')).join(' ');
      const rings = [0.25, 0.5, 0.75, 1].map(r =>
        `<polygon points="${poly(cats.map((_, i) => P(i, r)))}" fill="none" stroke="var(--border)" stroke-width="1" opacity="${r === 1 ? 0.9 : 0.45}"/>`).join('');
      const spokes = cats.map((_, i) => { const [x, y] = P(i, 1); return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--border)" stroke-width="1" opacity="0.45"/>`; }).join('');
      const labels = cats.map((c, i) => {
        const [x, y] = P(i, 1.17); const co = Math.cos(ang(i));
        const anchor = Math.abs(co) < 0.3 ? 'middle' : (co > 0 ? 'start' : 'end');
        return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle" font-size="11" fill="var(--muted)">${c.label}</text>`;
      }).join('');
      const shapes = series.map(s => {
        const pts = cats.map((c, i) => P(i, Math.max(0.015, s.values[c.key] ?? 0)));
        const dots = pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="2.6" fill="${s.color}"/>`).join('');
        return `<polygon points="${poly(pts)}" fill="${s.color}" fill-opacity="0.12" stroke="${s.color}" stroke-width="2"/>${dots}`;
      }).join('');
      return `<svg viewBox="0 0 ${size} ${size}" width="100%" style="max-width:${size}px;display:block;margin:0 auto">${rings}${spokes}${labels}${shapes}</svg>`;
    }

    function openRadar(preselect) {
      const b = S.board;
      if (!b?.models?.length) { toast('no results yet — run the suite first', 'err'); return; }
      const cats = [...new Set(b.tests.map(t => t.category))].map(c => ({ key: c, label: c }));
      const colorOf = (ref) => RADAR_PALETTE[b.models.findIndex(m => m.model === ref) % RADAR_PALETTE.length];
      const sel = new Set(preselect && preselect.length ? preselect : b.models.slice(0, 4).map(m => m.model));
      const chart = el('div', { class: 'radar-chart' });
      const legend = el('div', { class: 'radar-legend' });
      function render() {
        const series = b.models.filter(m => sel.has(m.model)).map(m => ({
          label: shortModel(m.model), color: colorOf(m.model),
          values: Object.fromEntries(cats.map(c => [c.key, m.categories[c.key] ?? 0])),
        }));
        chart.innerHTML = series.length ? radarSVG(cats, series) : '<div class="muted" style="padding:60px;text-align:center">Select at least one model.</div>';
        legend.innerHTML = '';
        b.models.forEach(m => legend.append(el('label', { class: 'radar-leg' + (sel.has(m.model) ? '' : ' off') },
          el('input', { type: 'checkbox', checked: sel.has(m.model), onchange: () => { sel.has(m.model) ? sel.delete(m.model) : sel.add(m.model); render(); } }),
          el('span', { class: 'radar-swatch', style: { background: colorOf(m.model) } }),
          el('span', { class: 'mono small grow ell', title: m.model }, shortModel(m.model)),
          el('span', { class: 'learn-tag sm ' + pctCls(m.overall) }, fmt(m.overall)))));
      }
      render();
      modal({
        title: 'Capability radar', sub: 'Each axis is a task category (average score, 0–100%). Overlay models to see exactly who wins where.',
        xl: true, body: el('div', { class: 'radar-wrap' }, chart, legend),
        actions: [{ label: 'Close', value: null }],
      });
    }

    // ---------- actions ----------

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
          pickModels();
        },
      })));
    }

    function updateSkillChip() {
      ui.skillBtn.querySelector('.chip').textContent = S.pickedTests.size ? String(S.pickedTests.size) : 'all';
    }

    async function pickSkills() {
      const b = S.board;
      if (!b?.tests?.length) { toast('no suite loaded yet', 'err'); return; }
      const r = ui.skillBtn.getBoundingClientRect();
      const byCat = {};
      for (const t of b.tests) (byCat[t.category] ||= []).push(t);
      const items = [
        { label: (S.pickedTests.size ? '' : '● ') + 'All skills', onclick: () => { S.pickedTests.clear(); updateSkillChip(); pickSkills(); } },
        '-',
      ];
      for (const [cat, tests] of Object.entries(byCat)) {
        items.push({ label: cat.toUpperCase(), onclick: () => { const all = tests.every(t => S.pickedTests.has(t.id)); tests.forEach(t => all ? S.pickedTests.delete(t.id) : S.pickedTests.add(t.id)); updateSkillChip(); pickSkills(); } });
        for (const t of tests) items.push({ label: (S.pickedTests.has(t.id) ? '✓ ' : '   ') + t.name + (t.lang ? ` · ${t.lang}` : ''), onclick: () => { S.pickedTests.has(t.id) ? S.pickedTests.delete(t.id) : S.pickedTests.add(t.id); updateSkillChip(); pickSkills(); } });
      }
      menu(r.left, r.bottom + 4, items);
    }

    function pickReasoning() {
      const r = ui.reasonBtn.getBoundingClientRect();
      const levels = [
        ['off', 'no thinking — fastest, small token budget'],
        ['low', 'brief reasoning'],
        ['medium', 'balanced (default) — reasoning models get room to think'],
        ['high', 'deep reasoning — up to ~20k thinking tokens, no cutoffs'],
      ];
      menu(r.left, r.bottom + 4, levels.map(([lv, desc]) => ({
        label: (S.reasoning === lv ? '✓ ' : '   ') + lv + ' — ' + desc,
        onclick: () => { S.reasoning = lv; ui.reasonBtn.querySelector('.chip').textContent = lv; },
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
      try { const r = await post('/bench/sweep', { reasoning: S.reasoning, ...(S.pickedTests.size ? { tests: [...S.pickedTests] } : {}) }); toast(`sweeping ${r.models.length} local models at ${r.reasoning} reasoning — each loads automatically as its turn comes`, 'ok'); }
      catch (e) { toast(e.message, 'err'); return; }
      S.running = true; ui.run.disabled = true; ui.sweep.disabled = true; ui.stop.style.display = '';
    }

    async function clearAll() {
      if (!await confirmBox('Clear ALL bench results?', 'Every recorded score, speed measurement and per-case breakdown is deleted. The suite itself stays. This is the fresh-start for a new test generation.', 'Clear everything')) return;
      try { const r = await del('/bench/runs'); toast(`cleared ${r.cleared} recorded runs`, 'ok'); S.log = []; refresh(); }
      catch (e) { toast(e.message, 'err'); }
    }

    async function runSuite() {
      if (!S.picked.size) { toast('pick at least one model first', 'err'); return; }
      S.log = [];
      try { await post('/bench/run', { models: [...S.picked], tests: [...S.pickedTests], reasoning: S.reasoning }); }
      catch (e) { toast(e.message, 'err'); return; }
      S.running = true; ui.run.disabled = true; ui.stop.style.display = '';
    }

    async function rerunSkill(model, testId) {
      const tests = Array.isArray(testId) ? testId : [testId];
      try { await post('/bench/run', { models: [model], tests, reasoning: S.reasoning }); }
      catch (e) { toast(e.message, 'err'); return; }
      toast((tests.length ? `re-running ${tests.length} skill${tests.length > 1 ? 's' : ''}` : 're-running all skills') + ` on ${shortModel(model)} at ${S.reasoning} reasoning…`, 'ok');
      S.running = true; ui.run.disabled = true; ui.stop.style.display = '';
    }

    function onEvent({ ev }) {
      if (ev.type === 'test.start') S.log.push({ text: `${shortModel(ev.model)} · ${ev.test} …`, ico: 'play' });
      else if (ev.type === 'test.done') S.log.push({ text: `${shortModel(ev.model)} · ${ev.test} → ${fmt(ev.score)} (${ev.detail}${ev.tokS ? ` · ${ev.tokS} tok/s` : ''})`, cls: ev.score >= 0.8 ? 'info' : 'error', ico: ev.score >= 0.5 ? 'check' : 'x' });
      else if (ev.type === 'model.done') S.log.push({ text: `${shortModel(ev.model)} — done`, ico: 'check' });
      else if (ev.type === 'done') {
        S.log.push({ text: ev.cancelled ? 'stopped' : 'suite complete', ico: 'check' });
        ui.sweep.disabled = false;
        // if a drill-down is open, refresh it live with the freshly-recorded runs
        get('/bench').then(b => { S.board = b; S.running = b.running; ui.stop.style.display = b.running ? '' : 'none'; ui.run.disabled = b.running; paint(); S.detailRender?.(); }).catch(() => refresh());
        return;
      }
      paint();
    }

    S.unsub = sub('bench', onEvent);
    refresh();
  },

  unmount(win) { win.benchState?.unsub?.(); },
};
