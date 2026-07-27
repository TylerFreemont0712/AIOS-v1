// ComfyUI connector: submit template workflows to the local instance, stream
// progress over the AIOS WebSocket, save outputs under data/comfy/, and play
// nice with the 8GB GPU — swapping the LLM to the tiny CPU profile before
// generating (autoSwap) and freeing Comfy's VRAM afterwards (autoFree).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, loadConfig } from './config.js';
import { id as genId, now, readJSON, writeJSON } from './util.js';
import { gpuStats } from './gpu.js';
import * as llmctl from './llmctl.js';
import * as uploads from './uploads.js';

const DIR = path.join(DATA, 'comfy');
const JOBS_FILE = path.join(DIR, 'jobs.json');
const PIDFILE = path.join(DIR, 'comfy.pid');
const PROC_LOG = path.join(DIR, 'comfyui.log');
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

let publish = () => { };
export const setPublisher = (fn) => { publish = fn; };
const emit = (jobId, ev) => publish(`comfy:${jobId}`, { t: 'comfy.event', jobId, ev });

const base = () => (loadConfig().comfy?.url || 'http://127.0.0.1:8188').replace(/\/$/, '');

async function api(pathname, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(base() + pathname, {
      method, signal: ctl.signal,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw err(`ComfyUI ${r.status}: ${(await r.text()).slice(0, 200)}`, 502);
    const text = await r.text();
    try { return JSON.parse(text); } catch { return text; }
  } finally { clearTimeout(t); }
}

// ---------- process lifecycle (AIOS starts/stops the ComfyUI server) ----------

const readPid = () => { try { return Number(fs.readFileSync(PIDFILE, 'utf8').trim()) || 0; } catch { return 0; } };
const alive = (pid) => { try { return pid > 0 && (process.kill(pid, 0), true); } catch { return false; } };
const isComfy = (pid) => { try { return /main\.py/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')); } catch { return false; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * ComfyUI processes AIOS didn't start (manually launched, or ours orphaned by a stale
 * pidfile). Reads /proc rather than forking pgrep: procStatus() sits on the Studio and
 * services status paths, where a fork costs ~24ms of blocked event loop (llmctl.js).
 *
 * Identifying one takes two tests, because the two ways it gets launched look
 * different: a manual start names the full path (…/ComfyUI/main.py), while AIOS starts
 * a bare `main.py` with cwd set to the ComfyUI directory — only the cwd gives that one
 * away. Without both, an unrelated `main.py` on the box reads as a rogue ComfyUI.
 */
function foreignComfyPids() {
  const own = readPid();
  const dir = loadConfig().comfy?.dir || '';
  return llmctl.pidsMatching('main.py').filter((p) => {
    if (!p || p === own) return false;
    try { if (/comfyui/i.test(fs.readFileSync(`/proc/${p}/cmdline`, 'latin1'))) return true; } catch { return false; }
    try { return !!dir && fs.readlinkSync(`/proc/${p}/cwd`) === path.resolve(dir); } catch { return false; }
  });
}

export function procStatus() {
  const pid = readPid();
  const mine = alive(pid) && isComfy(pid);
  const foreign = foreignComfyPids();
  return { managed: mine, pid: mine ? pid : (foreign[0] || 0), foreign: !mine && foreign.length > 0 };
}

/** Start ComfyUI detached (config comfy.dir + comfy.python). Waits for the API. */
export async function startComfy() {
  const cfg = loadConfig().comfy || {};
  if (await isUp()) return { ok: true, already: true, url: base() };
  const dir = cfg.dir;
  if (!dir || !fs.existsSync(path.join(dir, 'main.py'))) throw err(`ComfyUI not found at ${dir || '(unset)'} — set comfy.dir`, 500);
  if (!cfg.python || !fs.existsSync(cfg.python)) throw err(`python not found at ${cfg.python || '(unset)'} — set comfy.python`, 500);

  fs.mkdirSync(DIR, { recursive: true });
  const port = String(new URL(base()).port || 8188);
  const out = fs.openSync(PROC_LOG, 'a');
  fs.writeSync(out, `\n===== ${new Date().toISOString()} AIOS starting ComfyUI =====\n`);
  const child = spawn(cfg.python, ['main.py', '--port', port, '--listen', cfg.listen || '0.0.0.0', ...(cfg.args || [])], {
    cwd: dir, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  try { fs.closeSync(out); } catch { }   // the child has its own dup — ours would leak
  fs.writeFileSync(PIDFILE, String(child.pid));

  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {           // torch import + node scan takes a while
    if (await isUp()) return { ok: true, url: base(), ms: Date.now() - t0 };
    if (!alive(child.pid)) break;
    await sleep(1500);
  }
  let tail = '';
  try { tail = fs.readFileSync(PROC_LOG, 'utf8').slice(-700); } catch { }
  throw err(`ComfyUI did not come up — log tail:\n${tail}`, 500);
}

/** Stop ComfyUI (ours or a manually-started one). */
export async function stopComfy() {
  const kill = async (pid) => {
    if (!alive(pid)) return;
    try { process.kill(pid, 'SIGTERM'); } catch { }
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { } }
  };
  const own = readPid();
  if (alive(own) && isComfy(own)) await kill(own);
  for (const p of foreignComfyPids()) if (isComfy(p)) await kill(p);
  try { fs.unlinkSync(PIDFILE); } catch { }
  return { stopped: true };
}

/** Ask ComfyUI to drop models + cached VRAM without stopping it. */
export async function freeVram() {
  await api('/free', { method: 'POST', body: { unload_models: true, free_memory: true }, timeoutMs: 8000 });
  return { freed: true, gpu: gpuStats() };
}

const isUp = async () => { try { await api('/system_stats', { timeoutMs: 2000 }); return true; } catch { return false; } };

/** Lightweight up/down + VRAM for the service chip — no subprocess spawns. */
export async function comfyPing() {
  try {
    const s = await api('/system_stats', { timeoutMs: 2000 });
    const dev = s?.devices?.[0] || {};
    return { up: true, vramFreeMB: Math.round((dev.vram_free || 0) / 1048576) };
  } catch { return { up: false }; }
}

// ---------- status / discovery ----------

export async function comfyStatus() {
  const proc = procStatus();
  try {
    const s = await api('/system_stats', { timeoutMs: 2500 });
    const dev = s?.devices?.[0] || {};
    return {
      up: true, url: base(), proc,
      device: dev.name || '', vramFreeMB: Math.round((dev.vram_free || 0) / 1048576), vramTotalMB: Math.round((dev.vram_total || 0) / 1048576),
      gpu: gpuStats(), llm: llmctl.llmStatus(),
    };
  } catch (e) {
    return { up: false, url: base(), proc, error: e.message, gpu: gpuStats(), llm: llmctl.llmStatus() };
  }
}

export async function listCheckpoints() {
  // ComfyUI ≥0.2x serves /models/<folder>; fall back to object_info for older builds
  try {
    const list = await api('/models/checkpoints');
    if (Array.isArray(list)) return list;
  } catch { }
  const info = await api('/object_info/CheckpointLoaderSimple', { timeoutMs: 15000 });
  return info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
}

export async function listUpscalers() {
  try { const l = await api('/models/upscale_models'); return Array.isArray(l) ? l : []; } catch { return []; }
}

// ---------- source images (img2img / upscale inputs) ----------

/** A source is either one of our own renders ("<job>_0.png") or an AIOS upload ("upload:<id>"). */
function resolveSource(src) {
  src = String(src || '').trim();
  if (!src) throw err('a source image is required for this workflow');
  if (src.startsWith('upload:')) {
    const { meta, buffer } = uploads.readUpload(src.slice(7));
    if (!/^image\//.test(meta.mime || '')) throw err('the source upload is not an image');
    // uploads.js converts HEIC and friends on arrival; if that failed, ComfyUI cannot
    // read the bytes either, so say why instead of handing it a file it will reject.
    if (meta.unreadable) throw err(`that image is a ${meta.convertedFrom || meta.mime} and could not be converted to JPEG — install ffmpeg (or set uploads.ffmpeg)`);
    const ext = (meta.name || '').match(/\.(png|jpe?g|webp)$/i)?.[0] || '.png';
    return { buffer, name: `aios_src_${src.slice(7)}${ext}` };
  }
  return { buffer: fs.readFileSync(imagePath(src)), name: `aios_src_${src}` };
}

/** Push the source into ComfyUI's input folder; returns the name LoadImage wants. */
async function uploadSource(src) {
  const { buffer, name } = resolveSource(src);
  const fd = new FormData();
  fd.append('image', new Blob([buffer]), name);
  fd.append('overwrite', 'true');
  const r = await fetch(base() + '/upload/image', { method: 'POST', body: fd });
  if (!r.ok) throw err(`ComfyUI rejected the source image (${r.status}): ${(await r.text()).slice(0, 200)}`, 502);
  const j = await r.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

// ---------- workflow template (SDXL txt2img, Lightning-aware) ----------
// Lightning (baked or via LoRA) wants euler + sgm_uniform, cfg 1.0, 4/8 steps;
// plain SDXL finetunes (e.g. Animagine) sample normally — unless we can attach
// a Lightning LoRA, which gives finetune quality at Lightning speed.

export function txt2imgWorkflow({ checkpoint, prompt, negative, width, height, steps, cfg, seed, count, lora, sampler = 'euler', scheduler = 'sgm_uniform', hires = false, upscaleModel = null }) {
  const modelSrc = lora ? ['10', 0] : ['4', 0];
  const clipSrc = lora ? ['10', 1] : ['4', 1];
  const wf = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    5: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: count } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: clipSrc } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative || 'blurry, low quality, watermark, text', clip: clipSrc } },
    3: {
      class_type: 'KSampler',
      inputs: {
        model: modelSrc, positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
        seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1,
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'AIOS' } },
  };
  if (lora) wf[10] = { class_type: 'LoraLoader', inputs: { model: ['4', 0], clip: ['4', 1], lora_name: lora, strength_model: 1, strength_clip: 1 } };
  if (hires) {
    // hi-res in PIXEL space — latent upscales turn to mush under few-step
    // (Lightning) models at low denoise. Decode → upscale → re-encode → light
    // repaint is robust; an anime ESRGAN (4x-AnimeSharp) preserves lineart best.
    const w2 = Math.round(width * 1.5 / 8) * 8;
    const h2 = Math.round(height * 1.5 / 8) * 8;
    if (upscaleModel) {
      wf[13] = { class_type: 'UpscaleModelLoader', inputs: { model_name: upscaleModel } };
      wf[14] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['13', 0], image: ['8', 0] } };
      wf[15] = { class_type: 'ImageScale', inputs: { image: ['14', 0], upscale_method: 'lanczos', width: w2, height: h2, crop: 'disabled' } };
    } else {
      wf[15] = { class_type: 'ImageScale', inputs: { image: ['8', 0], upscale_method: 'lanczos', width: w2, height: h2, crop: 'disabled' } };
    }
    wf[16] = { class_type: 'VAEEncode', inputs: { pixels: ['15', 0], vae: ['4', 2] } };
    wf[12] = {
      class_type: 'KSampler',
      inputs: {
        model: modelSrc, positive: ['6', 0], negative: ['7', 0], latent_image: ['16', 0],
        seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 0.45,
      },
    };
    wf[17] = { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['4', 2] } };
    wf[9].inputs.images = ['17', 0];
  }
  return wf;
}

/** img2img: re-render an existing image under a new prompt. The source is scaled
 *  to the requested size (SDXL wants /8 dims), encoded, then repainted at
 *  `denoise` strength — 0.3 keeps the composition, 0.8 basically starts over. */
export function img2imgWorkflow({ checkpoint, prompt, negative, width, height, steps, cfg, seed, count, denoise, lora, sampler = 'euler', scheduler = 'sgm_uniform', image }) {
  const modelSrc = lora ? ['10', 0] : ['4', 0];
  const clipSrc = lora ? ['10', 1] : ['4', 1];
  const wf = {
    1: { class_type: 'LoadImage', inputs: { image } },
    2: { class_type: 'ImageScale', inputs: { image: ['1', 0], upscale_method: 'lanczos', width, height, crop: 'center' } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    5: { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['4', 2] } },
    11: { class_type: 'RepeatLatentBatch', inputs: { samples: ['5', 0], amount: count || 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: clipSrc } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative || 'blurry, low quality, watermark, text', clip: clipSrc } },
    3: {
      class_type: 'KSampler',
      inputs: {
        model: modelSrc, positive: ['6', 0], negative: ['7', 0], latent_image: ['11', 0],
        seed, steps, cfg, sampler_name: sampler, scheduler, denoise,
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'AIOS' } },
  };
  if (lora) wf[10] = { class_type: 'LoraLoader', inputs: { model: ['4', 0], clip: ['4', 1], lora_name: lora, strength_model: 1, strength_clip: 1 } };
  return wf;
}

/** Pure ESRGAN upscale — no checkpoint, tiny VRAM. `scale` trims a 4x model's
 *  output back down (e.g. 2×) in pixel space. */
export function upscaleWorkflow({ image, upscaleModel, scale = 4 }) {
  const native = Number((upscaleModel || '').match(/(\d)\s*x/i)?.[1]) || 4;
  const wf = {
    1: { class_type: 'LoadImage', inputs: { image } },
    2: { class_type: 'UpscaleModelLoader', inputs: { model_name: upscaleModel } },
    3: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
    9: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'AIOS' } },
  };
  if (scale && scale !== native) {
    wf[4] = { class_type: 'ImageScaleBy', inputs: { image: ['3', 0], upscale_method: 'lanczos', scale_by: scale / native } };
    wf[9].inputs.images = ['4', 0];
  }
  return wf;
}

const isFastCkpt = (name) => /lightning|turbo|lcm|hyper/i.test(name);

async function listLoras() {
  try { const l = await api('/models/loras'); return Array.isArray(l) ? l : []; } catch { return []; }
}

/** Pick sampling params + optional Lightning LoRA for the chosen checkpoint.
 *  accel 'lora' opts a finetune INTO the Lightning LoRA (fast but it shreds
 *  complex backgrounds on some finetunes — verified on Animagine 4.0); the
 *  default is the finetune's own proper sampling (Animagine official: 28/cfg 5). */
export async function samplingPlan(checkpoint, steps, accel = 'quality') {
  if (isFastCkpt(checkpoint)) return { steps: [4, 8].includes(steps) ? steps : 4, cfg: 1, lora: null, mode: 'lightning' };
  if (accel === 'lora') {
    const loras = await listLoras();
    const want = `sdxl_lightning_${[4, 8].includes(steps) ? steps : 8}step_lora.safetensors`;
    const fallback = loras.find(l => /sdxl_lightning_\dstep_lora/i.test(l));
    const lora = loras.includes(want) ? want : fallback || null;
    if (lora) return { steps: Number(lora.match(/_(\d)step_/)?.[1]) || 8, cfg: 1, lora, mode: 'finetune+lightning-lora' };
  }
  return { steps: 28, cfg: 5, lora: null, sampler: 'euler_ancestral', scheduler: 'normal', mode: 'standard-sdxl' };
}

// ---------- prompt generator (idea → danbooru-style tags, via the LLM) ----------

export async function expandPrompt({ idea, style = 'anime' } = {}) {
  idea = String(idea || '').trim();
  if (!idea) throw err('describe the idea first');
  const cfg = loadConfig();
  let ref = cfg.defaults.chatModel || cfg.defaults.agentModel;
  if (!ref) { try { ref = (await (await import('./llm.js')).listModels())[0]?.ref || ''; } catch { } }
  if (!ref) throw err('no model available for prompt expansion', 502);

  const { streamChat } = await import('./llm.js');
  const { extractJSON } = await import('./util.js');
  const res = await streamChat({
    modelRef: ref, maxTokens: 1600,   // reasoning models think before they answer
    system: 'You write Stable Diffusion prompts for SDXL anime models (Animagine). Think briefly if needed, then output ONLY the JSON.',
    messages: [{
      role: 'user',
      text: `Idea: ${idea}
Style hint: ${style}

Turn the idea into a danbooru-style tag prompt.
Rules:
- Tag ORDER (Animagine official): subject count first (1girl / 1boy / 1other / no humans), then character/series if any, then subject details (outfit, expression, pose), then scene/background, then lighting/composition/artstyle tags.
- END with quality tags exactly: masterpiece, high score, great score, absurdres
- 15-30 comma-separated tags. No sentences, no quotes, no numbered lists.
- Also write a matching negative prompt: start from "lowres, bad anatomy, bad hands, text, error, extra digits, cropped, worst quality, low quality, signature, watermark, blurry" and add exclusions that fit the idea (e.g. photorealistic for anime).

Output JSON exactly: {"prompt":"...","negative":"..."}`,
    }],
  });
  const j = extractJSON(res.text);
  if (!j?.prompt || String(j.prompt).length < 12) throw err('the model returned no usable prompt — try again', 502);
  return { prompt: String(j.prompt).replace(/\s+/g, ' ').trim().slice(0, 900), negative: String(j.negative || '').replace(/\s+/g, ' ').trim().slice(0, 500), model: ref };
}

// ---------- jobs ----------

const loadJobs = () => readJSON(JOBS_FILE) || [];
const saveJobs = (list) => {
  fs.mkdirSync(DIR, { recursive: true });
  const kept = list.slice(0, 100);
  writeJSON(JOBS_FILE, kept);
  // images of jobs that fell off the ring are orphans — reclaim the disk
  try {
    const keep = new Set(kept.flatMap(j => j.images || []));
    for (const f of fs.readdirSync(DIR)) {
      if (f.endsWith('.png') && !keep.has(f)) fs.unlinkSync(path.join(DIR, f));
    }
  } catch { }
};
export const listJobs = () => loadJobs();
export function getJob(id) {
  const j = loadJobs().find(x => x.id === id);
  if (!j) throw err('job not found', 404);
  return j;
}
function upsertJob(job) {
  const list = loadJobs().filter(j => j.id !== job.id);
  list.unshift(job);
  saveJobs(list);
}

export function imagePath(name) {
  if (!/^[A-Za-z0-9._-]+\.png$/.test(name)) throw err('bad image name');
  const abs = path.join(DIR, name);
  if (!fs.existsSync(abs)) throw err('image not found', 404);
  return abs;
}

// ---------- generation ----------

let running = false;

/** Kick off a generation; resolves fast with the job — progress streams on comfy:<id>.
 *  kind: 'txt2img' (default) · 'img2img' (sourceImage + denoise) · 'upscale' (sourceImage, no prompt). */
export async function generate(opts = {}) {
  const cfgAll = loadConfig();
  const kind = ['img2img', 'upscale'].includes(opts.kind) ? opts.kind : 'txt2img';
  const prompt = String(opts.prompt || '').trim();
  const sourceImage = String(opts.sourceImage || '').trim();
  if (kind !== 'upscale' && !prompt) throw err('prompt is required');
  if (kind !== 'txt2img' && !sourceImage) throw err('a source image is required — pick a render from the strip or upload one');
  if (kind !== 'txt2img') resolveSource(sourceImage);   // fail fast on a bad/missing source
  if (running) throw err('a generation is already running — wait for it to finish', 409);

  // access should be one click, not a ritual: boot ComfyUI ourselves when it's down
  let st = await comfyStatus();
  if (!st.up && cfgAll.comfy?.autoStart !== false && cfgAll.comfy?.dir) {
    await startComfy();
    st = await comfyStatus();
  }
  if (!st.up) throw err(`ComfyUI is not reachable at ${base()} — start it from the Studio header (${st.error || ''})`, 502);

  let checkpoint = null;
  let plan = { steps: 0, cfg: 0, lora: null, mode: 'upscale' };
  if (kind !== 'upscale') {
    const checkpoints = await listCheckpoints();
    if (!checkpoints.length) throw err('no checkpoints installed in ComfyUI — see comfyui-plan.md Phase 0');
    checkpoint = opts.checkpoint && checkpoints.includes(opts.checkpoint) ? opts.checkpoint : checkpoints[0];
    plan = await samplingPlan(checkpoint, Number(opts.steps), opts.accel === 'lora' ? 'lora' : 'quality');
  }
  let upscaleModel = null;
  if (kind === 'upscale' || (kind === 'txt2img' && opts.hires)) {
    const ups = await listUpscalers();
    upscaleModel = (opts.upscaleModel && ups.includes(opts.upscaleModel) ? opts.upscaleModel : null)
      || ups.find(u => /animesharp/i.test(u)) || ups[0] || null;
    if (kind === 'upscale' && !upscaleModel) throw err('no upscale models installed in ComfyUI (models/upscale_models)');
  }
  const r8 = (v, dflt) => Math.round(Math.min(Math.max(Number(v) || dflt, 256), 1536) / 8) * 8;
  const job = {
    id: genId(8), kind, status: 'queued', prompt, negative: String(opts.negative || ''),
    checkpoint, lora: plan.lora, mode: plan.mode, hires: kind === 'txt2img' && !!opts.hires, upscaleModel,
    sampler: plan.sampler || 'euler', scheduler: plan.scheduler || 'sgm_uniform',
    sourceImage: kind === 'txt2img' ? '' : sourceImage,
    denoise: kind === 'img2img' ? Math.min(Math.max(Number(opts.denoise) || 0.55, 0.1), 0.95) : undefined,
    scale: kind === 'upscale' ? ([2, 4].includes(Number(opts.scale)) ? Number(opts.scale) : 4) : undefined,
    width: r8(opts.width, 1024),
    height: r8(opts.height, 1024),
    steps: plan.steps,
    cfg: Number(opts.cfg) || plan.cfg,
    count: Math.min(Math.max(Number(opts.count) || 1, 1), 4),
    seed: Number(opts.seed) || Math.floor(Math.random() * 2 ** 32),
    images: [], error: '', createdAt: now(),
  };
  upsertJob(job);
  running = true;
  run(job).catch(() => { }).finally(() => { running = false; });
  return job;
}

async function run(job) {
  const cfgAll = loadConfig();
  const setStatus = (status, detail = '') => { job.status = status; upsertJob(job); emit(job.id, { type: 'status', status, detail }); };
  // Only set when THIS job stopped the LLM. Studio mode toggled by hand also
  // suspends, and that must stay off until the user turns it back on — but a
  // render should never leave chat and agent dead behind it.
  let weSuspended = false;
  try {
    // VRAM guard: an LLM and SDXL cannot share 8GB, so stop llama.cpp outright
    // rather than swapping it to a CPU profile — a live llama-server keeps its
    // CUDA context and cuBLAS workspace even at -ngl 0, and that margin decides
    // whether a checkpoint fits. resumeAfterGpu() puts the same model back.
    //
    // The condition is "llama holds the GPU at all", not "the big profile is
    // loaded": models served ad hoc report profile "model:<alias>", so the old
    // profile === 'big' test silently skipped the guard for every one of them.
    const llm = llmctl.llmStatus();
    const gpu = gpuStats();
    const needMB = job.kind === 'upscale' ? 2500 : 6500;
    const llmHoldsGpu = llm.running || llm.foreign;
    if (cfgAll.comfy?.autoSwap !== false && cfgAll.llm?.managed !== false && llmHoldsGpu && (gpu ? gpu.freeMB < needMB : true)) {
      setStatus('swapping-llm', 'freeing VRAM: stopping llama.cpp for the duration');
      const r = await llmctl.suspendForGpu();
      weSuspended = !!r.suspended;
    }

    let comfyImage = null;
    if (job.sourceImage) {
      setStatus('uploading-source');
      comfyImage = await uploadSource(job.sourceImage);
    }

    setStatus('submitted');
    const wf = job.kind === 'img2img' ? img2imgWorkflow({ ...job, image: comfyImage })
      : job.kind === 'upscale' ? upscaleWorkflow({ image: comfyImage, upscaleModel: job.upscaleModel, scale: job.scale })
      : txt2imgWorkflow(job);
    const res = await api('/prompt', { method: 'POST', body: { prompt: wf, client_id: 'aios-' + job.id }, timeoutMs: 15000 });
    const pid = res?.prompt_id;
    if (!pid) throw err('ComfyUI did not return a prompt_id: ' + JSON.stringify(res).slice(0, 200), 502);

    // progress over ComfyUI's own websocket; completion via /history polling
    let ws = null;
    try {
      const { default: WebSocket } = await import('ws');
      ws = new WebSocket(base().replace(/^http/, 'ws') + '/ws?clientId=aios-' + job.id);
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(raw);
          if (m.type === 'progress' && m.data?.max) emit(job.id, { type: 'progress', value: m.data.value, max: m.data.max });
        } catch { /* binary preview frames — ignore */ }
      });
      ws.on('error', () => { });
    } catch { }

    setStatus('generating');
    const t0 = Date.now();
    let outputs = null;
    while (Date.now() - t0 < 10 * 60_000) {
      const hist = await api(`/history/${pid}`, { timeoutMs: 8000 }).catch(() => null);
      const entry = hist?.[pid];
      if (entry?.status?.status_str === 'error') {
        const msg = JSON.stringify(entry.status?.messages || []).slice(0, 300);
        throw err('ComfyUI execution error: ' + msg, 502);
      }
      if (entry?.outputs) { outputs = entry.outputs; break; }
      await new Promise(r => setTimeout(r, 1200));
    }
    try { ws?.close(); } catch { }
    if (!outputs) throw err('generation timed out after 10 minutes', 504);

    // pull the images out of ComfyUI and keep our own copies
    fs.mkdirSync(DIR, { recursive: true });
    let i = 0;
    for (const node of Object.values(outputs)) {
      for (const img of node.images || []) {
        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
        const r = await fetch(base() + '/view?' + q);
        if (!r.ok) continue;
        const name = `${job.id}_${i++}.png`;
        fs.writeFileSync(path.join(DIR, name), Buffer.from(await r.arrayBuffer()));
        job.images.push(name);
      }
    }
    if (!job.images.length) throw err('no images in the ComfyUI output', 502);
    job.finishedAt = now();
    setStatus('done');
    emit(job.id, { type: 'done', images: job.images });

    if (cfgAll.comfy?.autoFree !== false) {
      api('/free', { method: 'POST', body: { unload_models: true, free_memory: true } }).catch(() => { });
    }
  } catch (e) {
    job.error = e.message;
    setStatus('error', e.message);
    emit(job.id, { type: 'error', message: e.message });
  } finally {
    // Put the LLM back, including after a failure — the image is already emitted,
    // so this runs behind the result rather than delaying it. Only one job runs at
    // a time (see the `running` guard), so there is nothing left to wait for.
    if (weSuspended) {
      try {
        await api('/free', { method: 'POST', body: { unload_models: true, free_memory: true }, timeoutMs: 8000 }).catch(() => { });
        const back = await llmctl.resumeAfterGpu({ fallback: 'big' });
        emit(job.id, { type: 'llm', restored: back.profile || back.resumed || false });
      } catch (e) {
        console.error('[comfy] could not restart llama.cpp after the job:', e.message);
      }
    }
  }
}

// ---------- studio mode ----------

/** ON = llama.cpp stopped so Comfy gets the whole card · OFF = restore whatever
 *  was serving before. */
export async function setStudio(on) {
  if (on) {
    await llmctl.suspendForGpu();
  } else {
    // Let Comfy drop its models first, or the returning LLM cannot map VRAM.
    await api('/free', { method: 'POST', body: { unload_models: true, free_memory: true }, timeoutMs: 5000 }).catch(() => { });
    await llmctl.resumeAfterGpu({ fallback: 'big' });
  }
  return { studio: !!on, llm: llmctl.llmStatus(), gpu: gpuStats(), suspended: llmctl.gpuSuspended() };
}
