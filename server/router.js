// Automatic model routing: `auto:<category>` model refs resolve to the best LOCAL
// model for that kind of work — as measured by the Bench suite, not by vibes — and
// the managed llama-server is swapped to it when needed.
//
// The contract: pick "Auto — coding" once in any model picker, and from then on the
// harness (a) looks up which local gguf currently wins the coding category, (b) swaps
// llama-server to it if something else is loaded (never mid-generation), and (c)
// resolves to the concrete provider ref the app actually calls. No bench data → the
// currently-served model wins by default, so auto never strands a request.

import os from 'node:os';
import { loadConfig, updateConfig } from './config.js';
import { leaderboard } from './bench.js';
import { listLocalModels, listMmproj, llmStatus, startModel, servingAlias, modelAlias, modelArgsFor, presetFor, paramsB, fitContext, findByAlias, llamaBusy } from './llmctl.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Hostnames that mean "this machine": loopback plus every local interface address —
 *  users legitimately point their provider at the LAN IP (works from other devices). */
function selfHosts() {
  const hosts = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1']);
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) hosts.add(i.address);
  }
  return hosts;
}

export const AUTO_CATEGORIES = [
  ['best', 'highest overall score'],
  ['fast', 'highest measured tok/s'],
  ['coding', 'best at writing working code'],
  ['reasoning', 'best at multi-step reasoning'],
  ['agent', 'best at tool calling'],
  ['structure', 'best at strict JSON'],
  ['accuracy', 'best at exact extraction'],
  ['instructions', 'best at format obedience'],
  ['context', 'best at long-context retrieval'],
  ['judgment', 'least likely to fabricate — refuses false premises'],
];

/** The custom provider entry that points at the managed llama-server's port. */
export function localProviderId() {
  const cfg = loadConfig();
  const port = String(cfg.llm?.port || 8080);
  const hosts = selfHosts();
  const c = (cfg.providers?.custom || []).find(p => {
    try {
      const u = new URL(String(p.baseUrl));
      return u.port === port && hosts.has(u.hostname);
    } catch { return false; }
  });
  return c ? `custom_${c.id}` : null;
}

/** Every local gguf joined to its bench standing (matched by served alias). */
export function candidates() {
  const cfg = loadConfig();
  const prov = localProviderId();
  const lb = leaderboard();
  const current = servingAlias();
  return listLocalModels().map(m => {
    const aliases = new Set([modelAlias(m.file)]);
    for (const p of Object.values(cfg.llm?.profiles || {})) if (p.model === m.path && p.alias) aliases.add(p.alias);
    // bench rows may be keyed local:<alias> (picker refs) or <provider>:<alias> (older
    // runs / direct refs) — both are this machine's models, both count
    const bench = lb.models.find(x => {
      const i = x.model.indexOf(':');
      if (i <= 0) return false;
      const [pv, alias] = [x.model.slice(0, i), x.model.slice(i + 1)];
      return (pv === prov || pv === 'local') && aliases.has(alias);
    }) || null;
    const benchAlias = bench ? bench.model.slice(bench.model.indexOf(':') + 1) : null;
    const preset = presetFor(m.file, m.sizeGB);
    // Honest fit hint for the 8GB card: weights PLUS the KV cache this context costs,
    // which depends on layer count (params), not just file size — a 27B at Q1 has tiny
    // weights and a huge KV. Recomputed against the preset actually in force.
    const p = paramsB(m.file, m.sizeGB);
    const kvGB = (preset.ctx / 1000) * (0.031 + 0.0037 * p) * (preset.kvK === 'f16' ? 2 : 1);
    const need = m.sizeGB + kvGB + 0.6;
    const fit = need <= 6.4 ? 'fits' : need <= 7.8 ? 'tight' : 'partial CPU offload';
    const fitDetail = `${m.sizeGB.toFixed(1)}GB weights + ~${kvGB.toFixed(1)}GB KV at ${(preset.ctx / 1024)}k ctx ≈ ${need.toFixed(1)}GB of 7.8GB usable`;
    return {
      ...m, aliases: [...aliases],
      alias: benchAlias || modelAlias(m.file),
      serving: aliases.has(current),
      preset, fit, fitDetail, paramsB: p,
      args: modelArgsFor(m.file, m.sizeGB).join(' '),
      bench: bench ? { overall: bench.overall, tokS: bench.tokS, categories: bench.categories, covered: bench.covered, at: bench.at } : null,
    };
  });
}

/** category → winning local model, by bench data. Only benched models can win. */
export function routeTable() {
  const cands = candidates().filter(c => c.bench);
  const pick = (score) => cands.filter(c => score(c) !== undefined && score(c) !== null)
    .sort((a, b) => score(b) - score(a) || b.bench.overall - a.bench.overall)[0] || null;
  const table = {};
  for (const [cat] of AUTO_CATEGORIES) {
    const win = cat === 'best' ? pick(c => c.bench.overall)
      : cat === 'fast' ? pick(c => c.bench.tokS)
        : pick(c => c.bench.categories[cat]);
    if (win) {
      table[cat] = {
        file: win.file, path: win.path, alias: win.alias, serving: win.serving,
        score: cat === 'fast' ? win.bench.tokS : (cat === 'best' ? win.bench.overall : win.bench.categories[cat]),
      };
    }
  }
  return table;
}

/** Resolve auto:<category> to a concrete `custom_x:alias` ref, swapping the served
 *  model when allowed and safe. Never switches while llama is mid-generation. */
export async function resolveAuto(category) {
  const cfg = loadConfig();
  const prov = localProviderId();
  if (!prov) throw err('auto routing needs a custom provider pointing at the managed llama-server (Settings → Providers)');
  const cat = AUTO_CATEGORIES.some(([c]) => c === category) ? category : 'best';
  const target = routeTable()[cat];
  const current = servingAlias();

  if (!target) {
    if (current) return `${prov}:${current}`;   // no bench data — whatever serves, serves
    throw err('nothing is serving and there is no bench data to pick a model — run Bench once, or start a model in the Models app');
  }
  if (target.serving) return `${prov}:${servingAlias() || target.alias}`;

  const autoSwitch = cfg.llm?.routing?.autoSwitch !== false;
  if (!current) {                                // nothing up: boot the winner regardless
    await startModel(target.path);
    return `${prov}:${servingAlias()}`;
  }
  if (autoSwitch && !(await llamaBusy())) {
    await startModel(target.path);               // waits for /health — first call pays the load time
    return `${prov}:${servingAlias()}`;
  }
  return `${prov}:${current}`;                   // busy or switching disabled — degrade gracefully
}

/** Make sure llama-server is answering as `alias`, swapping if needed. Waits out an
 *  in-flight generation (bounded) rather than killing it — this is what makes every
 *  local model safely selectable from any picker with zero manual serve/unserve. */
export async function ensureServing(alias, { waitBusyMs = 180_000 } = {}) {
  if (servingAlias() === alias) return;
  const m = findByAlias(alias);
  if (!m) throw err(`no local model answers to "${alias}" — check the Models app`, 404);
  const t0 = Date.now();
  while (llmStatus().running && await llamaBusy()) {
    if (Date.now() - t0 > waitBusyMs) throw err('llama-server has been busy for 3 minutes — try again, or stop the running generation', 503);
    await sleep(2000);
  }
  await startModel(m.path);   // waits for /health; first request pays the load time
}

/** local:<alias> → serve it (if needed) and rewrite to the concrete provider ref. */
export async function resolveLocal(alias) {
  const prov = localProviderId();
  if (!prov) throw err('local models need a custom provider pointing at the managed llama-server (Settings → Providers)');
  await ensureServing(alias);
  return `${prov}:${servingAlias()}`;
}

// ---------- LLM auto-setup ----------
//
// New gguf lands in the folder → one call and the model configures itself: an LLM
// reads the filename/size (which encode family, quant, purpose by convention),
// proposes tags + a serving preset sized to this machine, pairs an mmproj when one
// obviously matches, and the result is saved as the model's preset. The heuristics
// stay as the fallback; this is the "a librarian shelves it properly" pass.

function extractJSONLoose(text) {
  const m = String(text || '').replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function autoSetup({ file, modelRef } = {}) {
  const cfg = loadConfig();
  const ref = modelRef || cfg.defaults.chatModel || cfg.defaults.agentModel;
  if (!ref) throw err('auto-setup needs a model (defaults.chatModel) to do the thinking');
  const all = listLocalModels();
  const targets = file ? all.filter(m => m.file === file) : all.filter(m => !cfg.llm?.presets?.[m.file]);
  if (!targets.length) return { configured: [], note: file ? `unknown file "${file}"` : 'every local model already has a preset' };

  const { streamChat } = await import('./llm.js');
  const mmprojs = listMmproj().map(m => m.file);
  const configured = [];
  for (const m of targets) {
    const res = await streamChat({
      modelRef: ref, maxTokens: 900,
      system: 'You configure local llama.cpp models. Output STRICT JSON only — no fences, no commentary.',
      messages: [{
        role: 'user',
        text: `Configure this local model for an 8GB-VRAM machine (RTX 3070 Ti laptop, ~7.8GB usable; Ryzen 8C/16T).
File: ${m.file}  (${m.sizeGB} GB on disk, ~${paramsB(m.file, m.sizeGB)}B parameters)
Largest context that actually fits alongside these weights: ${fitContext(m.file, m.sizeGB, { kv: 'q8_0' })} tokens (already computed from VRAM math — do not exceed it)
Available vision projectors (mmproj files): ${mmprojs.join(', ') || '(none)'}

Filename conventions carry the facts: family (qwen/gemma/llama/...), parameter count, quant (Q4_K_M etc.), purpose (coding/instruct/it/vision).
Rules: KV cache cost scales with PARAMETER COUNT, not file size — a heavily-quantized large model has small weights but a huge cache, so never give it a big context. q8_0 KV halves cache memory and needs flash-attn. Use ngl "auto" unless the model comfortably fits. Pair an mmproj ONLY when its name clearly matches this model's family+size. Tags: 3-6 short lowercase strings — family, size class, purpose, notable traits.

Output STRICT JSON:
{"tags":["...")],"ctx":16384,"ngl":"auto","kvK":"q8_0","kvV":"q8_0","flashAttn":true,"mmproj":"<file or empty>","threads":8,"batch":2048,"ubatch":512,"why":"<one sentence>"}`,
      }],
    });
    const j = extractJSONLoose(res.text);
    if (!j) { configured.push({ file: m.file, ok: false, error: 'model returned no usable JSON' }); continue; }
    // Validate against PHYSICS, not just an allowlist: the model can propose whatever
    // it likes, but a context that doesn't fit in VRAM gets clamped to one that does.
    // (This is exactly how a 27B-at-Q1 previously talked its way into 32k + ngl 999.)
    const kvChoice = ['f16', 'q8_0', 'q4_0'].includes(j.kvK) ? j.kvK : 'q8_0';
    const maxCtx = fitContext(m.file, m.sizeGB, { kv: kvChoice });
    const wanted = [4096, 8192, 16384, 24576, 32768, 49152, 65536].includes(Number(j.ctx)) ? Number(j.ctx) : maxCtx;
    const fits = m.sizeGB + (maxCtx / 1000) * (0.031 + 0.0037 * paramsB(m.file, m.sizeGB)) + 0.6 <= 7.0;
    const preset = {
      ctx: Math.min(wanted, maxCtx),
      // 999 (force every layer onto the GPU) is only safe when it demonstrably fits;
      // otherwise 'auto' lets llama.cpp place what it can and spill the rest.
      ngl: j.ngl === 999 && !fits ? 'auto' : (j.ngl === 'auto' || Number.isFinite(Number(j.ngl)) ? j.ngl : 'auto'),
      kvK: kvChoice,
      kvV: ['f16', 'q8_0', 'q4_0'].includes(j.kvV) ? j.kvV : 'q8_0',
      threads: Math.max(2, Math.min(16, Number(j.threads) || 8)),
      batch: Number(j.batch) || 2048, ubatch: Number(j.ubatch) || 512,
      flashAttn: j.flashAttn !== false,
      mmproj: mmprojs.includes(j.mmproj) ? j.mmproj : '',
      extra: '',
      tags: (Array.isArray(j.tags) ? j.tags : []).map(t => String(t).toLowerCase().slice(0, 24)).slice(0, 6),
      why: String(j.why || '').slice(0, 200),
      autoConfigured: true,
    };
    updateConfig({ llm: { presets: { [m.file]: preset } } });
    configured.push({ file: m.file, ok: true, tags: preset.tags, ctx: preset.ctx, mmproj: preset.mmproj, why: preset.why });
  }
  return { configured };
}

/** Everything the Models app needs in one call. */
export function routingInfo() {
  const cfg = loadConfig();
  return {
    provider: localProviderId(),
    status: llmStatus(),
    serving: servingAlias(),
    routing: { autoSwitch: cfg.llm?.routing?.autoSwitch !== false },
    candidates: candidates(),
    mmproj: listMmproj().map(m => m.file),
    table: routeTable(),
    autoRefs: AUTO_CATEGORIES.map(([c, why]) => ({ ref: `auto:${c}`, category: c, why })),
  };
}