// Seamless local model serving: a `local:<alias>` ref names one exact gguf, and asking
// for it is enough — llama-server is swapped to that model on demand (never
// mid-generation) and the ref is rewritten to the concrete provider ref the app calls.
// So every local model is selectable from every picker with no manual serve/unserve.
//
// This module also owns LLM auto-setup: a new gguf lands in the folder and a model
// reads its filename and size to propose serving args, tags and an mmproj pairing.
//
// It used to own `auto:<category>` routing as well — bench-driven pseudo-models that
// picked a winner per request. Removed 2026-07-27: ten extra entries in every model
// picker to express a preference the Local list already expresses directly, and the
// per-category bench winners it displayed are in the Bench app anyway. legacyAutoRef()
// is all that remains, so refs saved before the removal still resolve.

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

/**
 * What a pre-removal `auto:<category>` ref should resolve to now.
 *
 * Old chats and agent sessions still carry these, and a saved transcript must not stop
 * working because the routing feature went away. Preference order: whatever
 * llama-server is already serving (no swap, no load wait), then the configured default
 * chat model, then the smallest local gguf.
 */
export async function legacyAutoRef() {
  const prov = localProviderId();
  const current = prov ? servingAlias() : '';
  if (prov && current) return `${prov}:${current}`;

  const dflt = String(loadConfig().defaults?.chatModel || '').trim();
  if (dflt && !dflt.startsWith('auto:')) return dflt;

  const smallest = listLocalModels().sort((a, b) => a.sizeGB - b.sizeGB)[0];
  if (smallest) return `local:${modelAlias(smallest.file)}`;
  throw err('this chat was saved with the old "Auto" model setting, which has been removed — pick a model from the picker');
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
    reasoning: cfg.llm?.reasoning || { default: 'off', byModel: {} },
    candidates: candidates(),
    mmproj: listMmproj().map(m => m.file),
  };
}