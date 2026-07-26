// Models v2: the llama-launcher, fully absorbed. Per-model structured presets
// (context, offload, KV quant, threads, batching, flash-attn, vision projector,
// extra flags), live GPU/VRAM, the server log pane, fit hints from the 8GB VRAM
// math, bench standings, and the auto-routing table. Serving is one click — and
// mostly unnecessary, because local:<alias> refs auto-serve on demand anywhere.

import { el, icon, toast, modal, timeAgo } from '../ui.js';
import { get, post, put } from '../api.js';

const pctCls = (v) => v >= 0.8 ? 'good' : v >= 0.5 ? 'mid' : 'bad';
const fmt = (v) => v === undefined || v === null ? '—' : Math.round(v * 100) + '%';
// resolved reasoning level for a model: per-ref override, then alias, then filename, then default
const reasoningLevel = (inf, m) => {
  const r = inf?.reasoning || {}, by = r.byModel || {};
  return by[`local:${m.alias}`] ?? by[m.alias] ?? by[m.file] ?? r.default ?? 'off';
};

export default {
  id: 'models', title: 'Models', icon: 'cpu', width: 1220, height: 800,

  mount(body, opts, win) {
    const S = win.modelsState = { info: null, timer: null, logOpen: false, logTimer: null };
    const ui = {};

    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl row', style: { gap: '7px' } }, icon('cpu'), 'Models'),
      ui.chip = el('span', { class: 'chip' }, '…'),
      ui.gpu = el('span', { class: 'models-gpu', title: 'GPU VRAM' }),
      el('span', { class: 'grow' }),
      ui.auto = el('button', { class: 'btn sm', title: 'Have an LLM tag + configure every model that has no preset yet (reads filenames, sizes this machine, pairs vision projectors)', onclick: () => autoSetup() }, icon('sparkle'), 'Auto-setup'),
      ui.logBtn = el('button', { class: 'btn sm ghost', title: 'llama-server log', onclick: toggleLog }, icon('file'), 'Log'),
      el('button', { class: 'btn sm ghost', title: 'Refresh', onclick: () => refresh() }, icon('refresh')),
      el('button', { class: 'btn sm ghost danger', title: 'Stop the llama-server (frees all VRAM)', onclick: stopServer }, icon('stop'), 'Stop server'));

    ui.main = el('div', { class: 'bench-main' });
    body.append(el('div', { class: 'main-pane' }, ui.head, ui.main));

    async function refresh() {
      let status;
      try {
        [S.info, status] = await Promise.all([get('/llm/routing'), get('/llm/status')]);
        S.info.gpu = status.gpu;
      } catch (e) { toast(e.message, 'err'); return; }
      paint();
    }

    function paint() {
      const inf = S.info;
      ui.main.innerHTML = '';
      if (!inf) return;
      const st = inf.status;
      ui.chip.textContent = st.running ? `serving ${inf.serving} :${st.port}` : 'llama-server down';
      ui.chip.style.color = st.running ? 'var(--ok)' : 'var(--err)';
      if (inf.gpu) {
        const used = inf.gpu.usedMB, total = inf.gpu.totalMB;
        ui.gpu.innerHTML = '';
        ui.gpu.append(
          el('span', { class: 'models-gpu-bar' }, el('span', { class: 'models-gpu-fill' + (used / total > 0.9 ? ' hot' : ''), style: { width: Math.round(used / total * 100) + '%' } })),
          el('span', { class: 'muted small' }, `${(used / 1024).toFixed(1)}/${(total / 1024).toFixed(1)}GB`));
      } else ui.gpu.textContent = '';

      if (!inf.provider) {
        ui.main.append(el('div', { class: 'res-hero' },
          el('h1', {}, 'No local provider'),
          el('div', { class: 'sub' }, `Add a custom provider pointing at the managed llama-server (port ${st.port}) in Settings → Providers — e.g. baseUrl http://127.0.0.1:${st.port}/v1.`)));
        return;
      }

      // seamless-serving explainer + routing table
      const cats = Object.entries(inf.table || {});
      ui.main.append(el('div', { class: 'bench-best' },
        el('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
          el('div', { class: 'learn-lbl grow' }, 'AUTO-ROUTING'),
          el('label', { class: 'row small muted', style: { gap: '6px' } },
            el('input', { type: 'checkbox', checked: inf.routing.autoSwitch, onchange: async (e) => {
              try { await put('/config', { llm: { routing: { autoSwitch: e.target.checked } } }); refresh(); }
              catch (err2) { toast(err2.message, 'err'); }
            } }),
            'auto:​ categories may swap models')),
        cats.length
          ? el('div', { class: 'row', style: { gap: '7px', flexWrap: 'wrap' } },
            ...cats.map(([cat, w]) => el('div', { class: 'bench-best-chip' + (w.serving ? ' serving' : '') },
              el('span', { class: 'bench-best-cat' }, 'auto:' + cat),
              el('span', { class: 'mono' }, w.file.replace(/\.gguf$/, '').slice(0, 22)),
              el('span', { class: 'learn-tag sm ' + (cat === 'fast' ? '' : pctCls(w.score)) }, cat === 'fast' ? w.score + ' t/s' : fmt(w.score)))))
          : el('div', { class: 'muted small' }, 'No bench data yet — run Bench once to fill this table.'),
        el('div', { class: 'muted small' },
          'Every model below is always available everywhere as “local:​…” in model pickers — pick one and it is served automatically on demand (in-flight generations are never interrupted). Manual Serve exists for pre-loading.')));

      // the garage
      for (const m of inf.candidates || []) ui.main.append(modelCard(m, inf));

      // log pane
      if (S.logOpen) {
        ui.log = el('pre', { class: 'models-log' }, '…');
        ui.main.append(el('div', {}, el('div', { class: 'learn-lbl' }, 'LLAMA-SERVER LOG'), ui.log));
        loadLog();
      }
    }

    function modelCard(m, inf) {
      const p = m.preset;
      const presetChips = [
        ['ctx', p.ctx.toLocaleString()], ['ngl', String(p.ngl)],
        ['kv', p.flashAttn ? `${p.kvK}/${p.kvV}` : 'f16 (fa off)'],
        ['threads', String(p.threads)], ['batch', `${p.batch}/${p.ubatch}`],
        ['flash-attn', p.flashAttn ? 'on' : 'off'],
        ...(p.mmproj ? [['vision', '🖼 ' + p.mmproj.replace(/^mmproj-|\.gguf$/gi, '').slice(0, 18)]] : []),
        ...(p.extra ? [['extra', p.extra.slice(0, 24)]] : []),
      ];
      return el('div', { class: 'models-card' + (m.serving ? ' serving' : '') },
        el('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-start' } },
          el('div', { class: 'grow' },
            el('div', { class: 'row', style: { gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
              el('b', { class: 'mono', title: m.path }, (m.serving ? '● ' : '') + m.file),
              el('span', { class: 'muted small' }, m.sizeGB + ' GB'),
              el('span', { class: 'learn-tag sm ' + (m.fit === 'fits' ? 'good' : /tight/.test(m.fit) ? 'mid' : 'bad'), title: m.fitDetail || 'VRAM fit at the preset context' }, m.fit),
              m.bench
                ? el('span', { class: 'learn-tag sm ' + pctCls(m.bench.overall), title: `benched ${timeAgo(m.bench.at)} · ${m.bench.covered} tests` }, `bench ${fmt(m.bench.overall)} · ${m.bench.tokS || '—'} t/s`)
                : el('span', { class: 'muted small' }, 'unbenched'),
              (() => { const lv = reasoningLevel(inf, m); return lv && lv !== 'off' && lv !== 'auto' ? el('span', { class: 'learn-tag sm', title: 'reasoning / thinking level' }, '🧠 ' + lv) : null; })(),
              el('span', { class: 'muted small mono' }, `local:${m.alias}`),
              ...(m.preset.tags || []).map(t => el('span', { class: 'learn-tag sm' }, t)),
              !m.preset.configured ? el('button', { class: 'btn sm ghost', style: { padding: '1px 7px' }, title: 'LLM-configure just this model', onclick: () => autoSetup(m.file) }, icon('sparkle'), 'setup') : null),
            el('div', { class: 'models-preset' },
              ...presetChips.map(([k, v]) => el('span', { class: 'models-knob', title: k }, el('i', {}, k), v)))),
          el('div', { class: 'col', style: { gap: '5px', flex: 'none' } },
            el('button', { class: 'btn sm' + (m.serving ? ' ghost' : ''), disabled: m.serving, title: 'Pre-load now (optional — models auto-serve when used)', onclick: () => serve(m) }, m.serving ? 'serving' : 'Serve'),
            el('button', { class: 'btn sm ghost', title: 'Tune this model\'s serving preset', onclick: () => editPreset(m, inf) }, icon('edit'), 'Preset'))));
    }

    async function serve(m) {
      toast(`loading ${m.file} — larger models take a couple of minutes…`, 'ok');
      try { const r = await post('/llm/model', { path: m.path }); toast(`now serving ${r.profile} (${((r.ms || 0) / 1000).toFixed(0)}s)`, 'ok'); }
      catch (e) { toast(e.message, 'err'); }
      refresh();
    }

    /** The launcher's preset panel, structured: every knob a field, not a raw string. */
    async function editPreset(m, inf) {
      const p = m.preset;
      const sel = (opts, val) => el('select', { class: 'input select' }, ...opts.map(o => el('option', { value: String(o), selected: String(o) === String(val) ? '' : undefined }, String(o))));
      const f = {
        ctx: sel([4096, 8192, 16384, 24576, 32768, 49152, 65536], p.ctx),
        ngl: sel(['auto', 0, 8, 16, 24, 32, 48, 999], p.ngl),
        kvK: sel(['f16', 'q8_0', 'q4_0'], p.kvK),
        kvV: sel(['f16', 'q8_0', 'q4_0'], p.kvV),
        threads: sel([4, 6, 8, 12, 16], p.threads),
        batch: sel([512, 1024, 2048, 4096], p.batch),
        ubatch: sel([128, 256, 512, 1024], p.ubatch),
        flashAttn: el('input', { type: 'checkbox', checked: p.flashAttn }),
        reasoning: sel(['auto', 'off', 'low', 'medium', 'high'], reasoningLevel(inf, m)),
        mmproj: el('select', { class: 'input select' },
          el('option', { value: '' }, '(none — text only)'),
          ...(inf.mmproj || []).map(mm => el('option', { value: mm, selected: mm === p.mmproj ? '' : undefined }, mm))),
        extra: el('input', { class: 'input mono', value: p.extra, placeholder: 'extra llama-server flags, e.g. --cache-reuse 256' }),
      };
      const row = (label, node, hint) => el('label', { class: 'row small', style: { gap: '8px', alignItems: 'center' } },
        el('span', { style: { width: '110px', flex: 'none' }, class: 'muted' }, label), node,
        hint ? el('span', { class: 'muted small' }, hint) : null);
      const ok = await modal({
        title: `Serving preset — ${m.file}`,
        sub: `${m.sizeGB} GB weights · ${m.fit}. Bigger context costs VRAM; quantized KV (needs flash-attn) buys layers back. Applies on next serve.`,
        wide: true,
        body: el('div', { class: 'col', style: { gap: '8px' } },
          row('context', f.ctx, 'tokens'),
          row('gpu layers', f.ngl, 'auto fits to free VRAM; 999 = all; 0 = CPU'),
          row('kv cache K/V', el('div', { class: 'row', style: { gap: '6px' } }, f.kvK, f.kvV), 'q8_0 halves KV memory'),
          row('flash-attn', f.flashAttn, 'required for quantized KV'),
          row('reasoning', f.reasoning, 'thinking effort for reasoning models (ornith, Qwen3, R1) — applies per request'),
          row('threads', f.threads),
          row('batch / ubatch', el('div', { class: 'row', style: { gap: '6px' } }, f.batch, f.ubatch)),
          row('vision', f.mmproj, 'pair an mmproj projector — enables image input'),
          row('extra flags', f.extra)),
        actions: [
          { label: 'Reset to defaults', value: 'reset' },
          { label: 'Cancel', value: null },
          { label: 'Save preset', kind: 'primary', value: true },
        ],
      });
      if (!ok) return;
      try {
        const preset = ok === 'reset' ? null : {
          ctx: Number(f.ctx.value), ngl: f.ngl.value === 'auto' ? 'auto' : Number(f.ngl.value),
          kvK: f.kvK.value, kvV: f.kvV.value,
          threads: Number(f.threads.value), batch: Number(f.batch.value), ubatch: Number(f.ubatch.value),
          flashAttn: f.flashAttn.checked, mmproj: f.mmproj.value, extra: f.extra.value.trim(),
        };
        // reasoning applies per-request (not a launch flag), so it takes effect immediately — keyed by alias
        await put('/config', { llm: { presets: { [m.file]: preset }, reasoning: { byModel: { [m.alias]: f.reasoning.value } } } });
        toast(ok === 'reset' ? 'preset reset to size defaults (reasoning kept)' : 'preset saved — applies on next serve' + (m.serving ? ' (hit Serve to reload now)' : ''), 'ok');
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function toggleLog() {
      S.logOpen = !S.logOpen;
      ui.logBtn.classList.toggle('primary', S.logOpen);
      clearInterval(S.logTimer);
      if (S.logOpen) S.logTimer = setInterval(loadLog, 4000);
      paint();
    }

    async function loadLog() {
      try {
        const r = await get('/llm/log?lines=160');
        if (ui.log) { ui.log.textContent = r.log; ui.log.scrollTop = ui.log.scrollHeight; }
      } catch { }
    }

    async function autoSetup(file) {
      toast(file ? `configuring ${file}…` : 'configuring all unconfigured models — the LLM reads each filename and sizes it to this machine…', 'ok');
      try {
        const r = await post('/llm/autosetup', file ? { file } : {});
        const okd = r.configured.filter(c => c.ok);
        if (!okd.length) { toast(r.note || r.configured[0]?.error || 'nothing configured', 'err'); return; }
        toast(okd.map(c => `${c.file.replace(/\.gguf$/, '')}: [${c.tags.join(', ')}]`).join(' · ').slice(0, 160), 'ok');
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function stopServer() {
      try { await post('/llm/stop', {}); toast('llama-server stopped — VRAM freed', 'ok'); } catch (e) { toast(e.message, 'err'); }
      refresh();
    }

    refresh();
    S.timer = setInterval(refresh, 12_000);
  },

  unmount(win) { clearInterval(win.modelsState?.timer); clearInterval(win.modelsState?.logTimer); },
};
