// AIOS-managed llama.cpp lifecycle (ownership approved 2026-07-11). Two profiles:
// 'big'  — the GPU daily driver
// 'tiny' — a small fast model for quick work and low-VRAM situations
// Freeing the GPU for ComfyUI is no longer a profile swap: suspendForGpu() stops
// llama-server outright and resumeAfterGpu() puts back whatever was serving.
// Pidfile discipline mirrors scripts/aios-launch.sh; a llama-server started by the
// old PyQt launcher is treated as "foreign" and replaced on the first swap.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA, loadConfig } from './config.js';
import { gpuStats } from './gpu.js';

const DIR = path.join(DATA, 'llm');
const PIDFILE = path.join(DIR, 'llama.pid');
const PROFILE_FILE = path.join(DIR, 'profile');
// What was serving before something else needed the whole GPU. Kept in a file
// rather than a module variable so an AIOS restart mid-Studio-session can still
// put the right model back.
const SUSPEND_FILE = path.join(DIR, 'suspended');
const LOG = path.join(DIR, 'llama.log');

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const readPid = () => { try { return Number(fs.readFileSync(PIDFILE, 'utf8').trim()) || 0; } catch { return 0; } };
const alive = (pid) => { try { return pid > 0 && (process.kill(pid, 0), true); } catch { return false; } };
const isLlama = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('llama-server'); } catch { return false; } };

/**
 * PIDs whose command line contains `needle`, read straight out of /proc.
 *
 * This replaced a `spawnSync('pgrep')`, which is a fork — measured at 23.8ms of
 * BLOCKED event loop per call on this box, against 2.4ms for the scan below. It is
 * not a cold path: resolveModel() in router.js asks "what is serving?" up to four
 * times per chat send, and the Models app polls /api/llm/status every 12s, so the
 * old version stalled the whole server for ~95ms on every message. pgrep stays as
 * the fallback for anything without /proc.
 */
export function pidsMatching(needle) {
  let entries;
  try { entries = fs.readdirSync('/proc'); }
  catch {
    const r = spawnSync('pgrep', ['-f', needle], { encoding: 'utf8', timeout: 4000 });
    return (r.stdout || '').split('\n').filter(Boolean).map(Number).filter(Boolean);
  }
  const out = [];
  for (const e of entries) {
    const c = e.charCodeAt(0);
    if (c < 48 || c > 57) continue;                       // only numeric entries are pids
    try { if (fs.readFileSync(`/proc/${e}/cmdline`, 'latin1').includes(needle)) out.push(Number(e)); }
    catch { /* the process exited mid-scan, or is not ours to read */ }
  }
  return out;
}

// The scan is cheap but not free, and one request can ask several times. A beat of
// cache collapses those into one; anything that starts or stops a server clears it.
let pidCache = { at: 0, pids: null };
export const invalidateProcCache = () => { pidCache = { at: 0, pids: null }; };

/** llama-server processes AIOS did not start (e.g. the PyQt launcher's child). */
function foreignPids() {
  if (!pidCache.pids || Date.now() - pidCache.at > 1000) {
    pidCache = { at: Date.now(), pids: pidsMatching('llama-server') };
  }
  const own = readPid();
  return pidCache.pids.filter(p => p && p !== own);
}

export function llmStatus() {
  const cfg = loadConfig().llm || {};
  const pid = readPid();
  const mine = alive(pid) && isLlama(pid);
  let profile = '';
  try { profile = fs.readFileSync(PROFILE_FILE, 'utf8').trim(); } catch { }
  const foreign = foreignPids();
  return {
    managed: cfg.managed !== false,
    running: mine, profile: mine ? profile : '',
    foreign: !mine && foreign.length > 0,
    pid: mine ? pid : (foreign[0] || 0),
    port: cfg.port || 8080,
    profiles: Object.keys(cfg.profiles || {}),
    // Set while Studio/ComfyUI holds the GPU. The UI needs this to distinguish
    // "deliberately stopped so Comfy can render" from "the LLM fell over".
    suspended: gpuSuspendedFor(),
  };
}

/** Open the PyQt launcher GUI on the user's desktop (Whisper/MusicGen/manual llama).
 *  Best-effort DISPLAY: inherit if the server has one, else fall back to :0. */
export function openLauncher() {
  const cfg = loadConfig().llm || {};
  const sh = cfg.launcher;
  if (!sh || !fs.existsSync(sh)) throw err(`launcher not found at ${sh || '(unset)'} — set llm.launcher`, 500);
  const env = { ...process.env };
  if (!env.DISPLAY) env.DISPLAY = ':0';
  if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${os.userInfo().uid}`;
  const child = spawn('/bin/bash', [sh], { detached: true, stdio: 'ignore', env });
  child.unref();
  return { ok: true, launcher: sh, display: env.DISPLAY };
}

async function healthy(port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal }).finally(() => clearTimeout(t));
    return r.ok;
  } catch { return false; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function killPid(pid) {
  if (!alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { }
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { } }
}

/** Stop every llama-server (ours AND foreign) and wait for the port to free. */
export async function stopLlama() {
  const cfg = loadConfig().llm || {};
  const own = readPid();
  if (alive(own) && isLlama(own)) await killPid(own);
  for (const p of foreignPids()) if (isLlama(p)) await killPid(p);
  invalidateProcCache();
  try { fs.unlinkSync(PIDFILE); } catch { }
  try { fs.unlinkSync(PROFILE_FILE); } catch { }
  for (let i = 0; i < 20 && await healthy(cfg.port || 8080); i++) await sleep(250);
  return { stopped: true };
}

/** Free the GPU completely for another tenant (ComfyUI), remembering what was
 *  loaded so it can be restored afterwards.
 *
 *  Stopping beats swapping to the tiny CPU profile: a llama-server process holds
 *  its CUDA context and cuBLAS workspace even at -ngl 0, which is a few hundred MB
 *  that an SDXL checkpoint would rather have. On an 8GB card that margin decides
 *  whether a generation fits. */
export async function suspendForGpu() {
  const cur = llmStatus();
  if (!cur.running && !cur.foreign) return { suspended: false, was: '', reason: 'nothing was serving' };
  const was = cur.running ? (cur.profile || '') : '';
  fs.mkdirSync(DIR, { recursive: true });
  try { fs.writeFileSync(SUSPEND_FILE, was); } catch { }
  await stopLlama();
  return { suspended: true, was, gpu: gpuStats() };
}

/** Put back whatever suspendForGpu() stopped. Falls back to `fallback` when
 *  nothing was remembered, and does nothing if something is already serving. */
export async function resumeAfterGpu({ fallback = 'big' } = {}) {
  let was = '';
  try { was = fs.readFileSync(SUSPEND_FILE, 'utf8').trim(); } catch { }
  try { fs.unlinkSync(SUSPEND_FILE); } catch { }

  const cur = llmStatus();
  if (cur.running) return { resumed: false, profile: cur.profile, reason: 'already serving' };

  const target = was || fallback;
  try {
    if (target.startsWith('model:')) return { resumed: true, ...(await startModel(target.slice(6))) };
    return { resumed: true, ...(await startProfile(target)) };
  } catch (e) {
    // A remembered model that has since been deleted must not leave the box with
    // no LLM at all.
    if (target !== fallback) {
      try { return { resumed: true, ...(await startProfile(fallback)), note: `${target} failed: ${e.message}` }; }
      catch { /* fall through */ }
    }
    return { resumed: false, error: e.message };
  }
}

/** Is a restore pending? Lets the UI say "Studio has the GPU" honestly.
 *  A function declaration, not a const, so llmStatus() above can call it. */
export function gpuSuspendedFor() {
  try { return fs.readFileSync(SUSPEND_FILE, 'utf8').trim() || ''; } catch { return ''; }
}
export const gpuSuspended = () => !!gpuSuspendedFor();

/**
 * Start (or switch to) a profile. Kills whatever llama-server currently runs,
 * spawns the new one detached with logs at data/llm/llama.log, and waits for
 * /health. Model load can take a while for the big profile — be patient.
 */
export async function startProfile(name) {
  const cfg = loadConfig().llm || {};
  if (cfg.managed === false) throw err('AIOS llama management is disabled (config llm.managed)');
  const p = cfg.profiles?.[name];
  if (!p) throw err(`unknown llm profile "${name}" — have: ${Object.keys(cfg.profiles || {}).join(', ')}`);
  const cur = llmStatus();
  if (cur.running && cur.profile === name && await healthy(cfg.port || 8080)) return { ok: true, profile: name, already: true };
  return boot({ model: p.model, alias: p.alias || name, args: p.args || [], label: name, budget: name === 'tiny' ? 60_000 : 240_000 });
}

/** Every .gguf AIOS could serve: profile model folders + AIOS's own model dir.
 *  mmproj/draft files are projector/speculative sidecars, not chat models. */
export function listLocalModels() {
  const cfg = loadConfig().llm || {};
  const dirs = [...new Set([
    ...Object.values(cfg.profiles || {}).map(p => path.dirname(p.model)),
    path.join(DATA, 'llm', 'models'),
  ])];
  const out = [];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.gguf') || /mmproj|draft|dflash/i.test(f)) continue;
        const abs = path.join(dir, f);
        out.push({ file: f, path: abs, sizeGB: Math.round(fs.statSync(abs).size / 1073741824 * 100) / 100 });
      }
    } catch { }
  }
  const seen = new Set();
  return out.filter(m => !seen.has(m.path) && seen.add(m.path)).sort((a, b) => a.file.localeCompare(b.file));
}

export const modelAlias = (file) => String(file).replace(/\.gguf$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48).toLowerCase();

/** The alias the llama-server is answering as right now ('' when down). This is what
 *  joins llmctl's world to the model refs the rest of AIOS (and bench.db) uses. */
export function servingAlias() {
  const st = llmStatus();
  if (!st.running) return '';
  if (st.profile.startsWith('model:')) return st.profile.slice(6);
  return loadConfig().llm?.profiles?.[st.profile]?.alias || st.profile;
}

/** Resolve a served alias back to its gguf (filename slug or a profile alias). */
export function findByAlias(alias) {
  const cfg = loadConfig();
  for (const m of listLocalModels()) {
    if (modelAlias(m.file) === alias) return m;
    for (const p of Object.values(cfg.llm?.profiles || {})) if (p.model === m.path && p.alias === alias) return m;
  }
  return null;
}

/** Vision projector sidecars (mmproj-*.gguf) — pairable with a base model, launcher-style. */
export function listMmproj() {
  const cfg = loadConfig();
  const dirs = [...new Set([
    ...Object.values(cfg.llm?.profiles || {}).map(p => path.dirname(p.model)),
    path.join(DATA, 'llm', 'models'),
  ])];
  const out = [];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.gguf') && /mmproj/i.test(f)) out.push({ file: f, path: path.join(dir, f) });
      }
    } catch { }
  }
  return out;
}

/**
 * Local models that can actually see: their preset names an mmproj projector that is
 * really on disk. This is the single definition of "vision-capable" in AIOS — nothing
 * hardcodes a filename, so pairing a new model with an mmproj in Settings → Models is
 * all it takes for receipt OCR to start offering it.
 *
 * Sorted smallest-first, which on an 8GB card is also load-order preference: a
 * projector plus weights has to fit beside whatever else holds VRAM.
 */
export function visionModels() {
  const have = new Set(listMmproj().map(m => m.file));
  const out = [];
  for (const m of listLocalModels()) {
    const preset = presetFor(m.file, m.sizeGB);
    if (preset.mmproj && have.has(preset.mmproj)) {
      out.push({ ref: `local:${modelAlias(m.file)}`, alias: modelAlias(m.file), file: m.file, sizeGB: m.sizeGB, mmproj: preset.mmproj });
    }
  }
  return out.sort((a, b) => a.sizeGB - b.sizeGB);
}

/**
 * Is this ref a dedicated OCR transcriber rather than a general vision model?
 *
 * The distinction decides the whole pipeline. A transcriber (dots.ocr, DeepSeek-OCR)
 * reads a page far more faithfully than a general VLM but does not answer questions about
 * it — asked for a JSON receipt object it burns its budget and returns nothing useful.
 * Measured here: dots.ocr scored 25% on totals when driven like a VLM, and transcribed
 * every number on the same receipt correctly when asked to do its own job.
 *
 * Declared by the `ocr` tag on the model's preset, so adding a new one is configuration.
 */
export function refIsTranscriber(ref) {
  return !!refPreset(ref)?.tags.includes('ocr');
}

/** The preset behind a model ref, or null when the ref does not resolve to a local gguf
 *  (a cloud model, or one since deleted). The tag/prompt/style lookups all start here. */
export function refPreset(ref) {
  const s = String(ref || '').trim();
  const alias = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  const m = findByAlias(alias);
  return m ? presetFor(m.file, m.sizeGB) : null;
}

/**
 * Can this model ref read an image? Returns true / false / null when unknowable.
 *
 * `null` matters: a ref pointing at an OpenAI-compatible endpoint we do not manage
 * might well be vision-capable, and refusing it would be wrong. Only a ref that
 * resolves to a local gguf with no projector is a definite no.
 */
export function refSeesImages(ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  const provider = s.includes(':') ? s.slice(0, s.indexOf(':')) : '';
  const alias = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  if (provider === 'anthropic') return true;              // every Claude model sees
  if (provider === 'auto') return null;                   // resolved per request
  const m = findByAlias(alias);
  if (!m) return null;                                    // not one of ours — cannot say
  const preset = presetFor(m.file, m.sizeGB);
  return !!(preset.mmproj && listMmproj().some(x => x.file === preset.mmproj));
}

/** Parameter count in billions, from the filename convention (27B, 12b, 1.7B, E4B).
 *  Falls back to a size-based guess for oddly-named files. */
export function paramsB(file, sizeGB) {
  const m = String(file).match(/(?:^|[-_.])[eE]?(\d+(?:\.\d+)?)\s*[bB](?:[-_.]|$)/);
  if (m) return Number(m[1]);
  return Math.max(1, Math.round(sizeGB * 1.6));   // ~Q4-ish bytes-per-param fallback
}

/** VRAM-aware default context. File size alone is NOT enough: a 27B quantized to Q1
 *  is only 3.5GB of weights but still has ~64 layers, so its KV cache per token is
 *  double a 9B's — giving it 32k context would silently overflow the card. Calibrated
 *  against two measured points on this 8GB machine (q8_0 KV): a 9B costs ~0.064 GB per
 *  1k tokens, a 27B ~0.13. f16 KV is double. */
export function fitContext(file, sizeGB, { kv = 'q8_0', usableGB = 7.8 } = {}) {
  const p = paramsB(file, sizeGB);
  const per1k = (0.031 + 0.0037 * p) * (kv === 'f16' ? 2 : 1);
  const headroom = usableGB - sizeGB - 0.6;                  // 0.6 for compute buffers
  for (const ctx of [32768, 24576, 16384, 8192, 4096]) {
    if (headroom >= (ctx / 1000) * per1k) return ctx;
  }
  return 4096;                                               // spills to CPU regardless
}

/** The structured per-model preset (launcher parity), with VRAM-aware defaults. */
export function presetFor(file, sizeGB) {
  const cfg = loadConfig().llm || {};
  const saved = cfg.presets?.[file] || {};
  // small models can afford lossless KV; anything bigger buys layers back with q8_0
  const kv = sizeGB <= 2.5 ? 'f16' : 'q8_0';
  const dflt = { ctx: fitContext(file, sizeGB, { kv }), kv };
  return {
    ctx: Number(saved.ctx) || dflt.ctx,
    ngl: saved.ngl ?? 'auto',                       // 'auto' | number | 999
    kvK: saved.kvK || dflt.kv, kvV: saved.kvV || dflt.kv,
    threads: Number(saved.threads) || 8,
    batch: Number(saved.batch) || 2048, ubatch: Number(saved.ubatch) || 512,
    flashAttn: saved.flashAttn !== false,
    mmproj: saved.mmproj || '',                     // mmproj file name, '' = text-only
    // Gemma 4 and other recent releases ship chat templates that llama.cpp's
    // built-in matcher rejects outright ("this custom template is not supported,
    // try using --jinja"); without this the server silently falls back to a
    // generic format and the model answers in the wrong turn syntax.
    jinja: saved.jinja !== false,
    extra: String(saved.extra || ''),               // raw escape hatch for anything else
    tags: Array.isArray(saved.tags) ? saved.tags : [],
    // How a reader tagged `ocr` wants to be asked, and what shape it answers in.
    // Dedicated OCR models are prompt-sensitive to the point of uselessness when asked
    // wrongly — dots.ocr returns two tokens for "OCR" and a full layout parse for its own
    // instruction — and each new one arrives with its own. Empty means "use the built-in
    // default for this model name" (see ocrPromptFor in receipts.js), so adding a reader
    // is a preset edit rather than a code change.
    ocrPrompt: String(saved.ocrPrompt || ''),
    ocrStyle: saved.ocrStyle === 'layout-json' || saved.ocrStyle === 'lines' ? saved.ocrStyle : '',
    configured: !!cfg.presets?.[file],              // false = running on size defaults
  };
}

/** Serving args for a gguf: legacy raw-string override wins, else the structured
 *  preset (saved or size-defaulted — the launcher's VRAM math for this 8GB card:
 *  big weights get less context, KV quantization buys layers back). */
export function modelArgsFor(file, sizeGB) {
  const legacy = loadConfig().llm?.modelArgs?.[file];
  if (legacy) return String(legacy).split(/\s+/).filter(Boolean);
  const p = presetFor(file, sizeGB);
  const args = [
    '--ctx-size', String(p.ctx),
    '-ngl', String(p.ngl),
    '--threads', String(p.threads),
    '--batch-size', String(p.batch), '--ubatch-size', String(p.ubatch),
    '--flash-attn', p.flashAttn ? 'on' : 'off',
  ];
  // llama-server rejects quantized KV without flash-attn — silently degrade to f16
  // rather than shipping args that fail to boot (the launcher had this same guard)
  if (p.flashAttn && p.kvK !== 'f16') args.push('--cache-type-k', p.kvK);
  if (p.flashAttn && p.kvV !== 'f16') args.push('--cache-type-v', p.kvV);
  if (p.jinja) args.push('--jinja');
  if (p.mmproj) {
    const mm = listMmproj().find(m => m.file === p.mmproj);
    if (mm) args.push('--mmproj', mm.path);
  }
  if (p.extra) args.push(...p.extra.split(/\s+/).filter(Boolean));
  return args;
}

/** Swap the managed llama-server to any local gguf — free model switching, with the
 *  per-model tuned args applied. */
export async function startModel(ggufPath) {
  const cfg = loadConfig().llm || {};
  if (cfg.managed === false) throw err('AIOS llama management is disabled (config llm.managed)');
  const known = listLocalModels().find(m => m.path === ggufPath || m.file === ggufPath);
  if (!known) throw err(`unknown model "${ggufPath}" — pick one from /api/llm/models`, 404);
  const alias = modelAlias(known.file);
  const cur = llmStatus();
  if (cur.running && cur.profile === `model:${alias}` && await healthy(cfg.port || 8080)) return { ok: true, profile: cur.profile, already: true };
  return boot({ model: known.path, alias, args: modelArgsFor(known.file, known.sizeGB), label: `model:${alias}`, budget: 240_000 });
}

/** Last lines of the llama-server log — the launcher's log pane, as an API. */
export function llamaLog(lines = 120) {
  try {
    const t = fs.readFileSync(LOG, 'utf8');
    return t.split('\n').slice(-Math.max(10, Math.min(600, lines))).join('\n');
  } catch { return '(no log yet)'; }
}

/**
 * Is llama mid-generation right now? Routing must never yank a model out from under
 * an in-flight request.
 *
 * Returns `{ busy, certain }`, and the second field is load-bearing. This used to
 * return a bare boolean where "I could not tell" collapsed into "busy" — safe for a
 * second, catastrophic for an hour. Measured 2026-09-05: a llama-server sat for 3h16m
 * with /health answering in 0.3ms while /slots never answered at all (every probe
 * created a task that never completed — the log filled with `stop: cancel task`, two
 * per routing decision, for three hours). Because unknown meant busy, EVERY model swap
 * was refused for that whole time: each receipt scan waited out the full three minutes
 * and then failed with "llama-server has been busy", naming an in-flight generation
 * that did not exist. A wedged server is not a busy one, and unlike a busy one it never
 * gets better on its own. The caller needs to be able to tell those apart.
 */
export async function llamaBusy() {
  const cfg = loadConfig().llm || {};
  const port = cfg.port || 8080;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/slots`, { signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return { busy: true, certain: false };
    const slots = await r.json();
    if (!Array.isArray(slots)) return { busy: true, certain: false };
    return { busy: slots.some(s => s.is_processing), certain: true };
  } catch {
    // Not answering /health either: it is down, which is emphatically not busy.
    if (!(await healthy(port))) return { busy: false, certain: true };
    return { busy: true, certain: false };
  }
}

/**
 * Model swaps run one at a time, in the order they were asked for.
 *
 * Every boot begins by killing whatever llama-server is running, so two boots in
 * flight at once kill each other's server and neither survives. Caught live on
 * 2026-09-05 with one receipt scan racing one chat send, in llama.log:
 *
 *   12:39:56.884 starting "model:hunyuanocr-q8_0" -> couldn't bind socket, port 8080
 *   12:39:58.338 starting "model:hunyuanocr-q8_0" -> model loaded ... listening
 *                        ...0.4s later:               cleaning up before exit
 *
 * The OCR model loads in two seconds and was killed 400ms after it came up, by the
 * competing boot's stopLlama(). The scan saw "did not become healthy", fell back to a
 * text-only chat model that cannot see an image at all, and the receipt failed — nine
 * minutes later, because each of its three attempts also waited out the busy check.
 * From the phone that is simply a photo that never reads.
 *
 * A queue rather than a lock: the second caller still gets its model, just after the
 * first is up. Serializing here rather than in router.js covers every entrance —
 * startModel, startProfile, resumeAfterGpu and the /api/llm routes all land in boot().
 */
let bootChain = Promise.resolve();
function serializeBoot(fn) {
  const next = bootChain.then(fn, fn);         // a rejection must not poison the queue
  bootChain = next.then(() => { }, () => { });
  return next;
}

// …and the queue alone is not enough, because it is per-process. `npm run receipt-bench`
// (scripts/receipt-bench.mjs imports server/receipts.js and calls readReceipt directly),
// `npm run audit` and the e2e scripts each drive the SAME llama-server from their own node
// process with their own queue — so a bench run against the live hub is the identical
// fatal race, and was caught being exactly that: two boots 22ms apart, one per process.
// A lock file is the only thing both sides can see.
//
// Stale locks are how this pattern usually fails, so the holder writes its pid and the
// time, and a lock is stolen when its owner is gone or it has outlived the longest
// legitimate boot. Stealing beats blocking: a lock left by a crashed bench must never be
// able to stop this machine from loading a model.
const LOCK = path.join(DIR, 'boot.lock');
const LOCK_CEILING_MS = 300_000;               // a cold 27B load is minutes, not seconds

function lockIsLive() {
  try {
    const { pid, at } = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (!(Date.now() - at < LOCK_CEILING_MS)) return false;   // also false for a bad `at`
    return pid !== process.pid && alive(pid);
  } catch { return false; }                    // absent or unreadable: nobody holds it
}

async function withBootLock(fn) {
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const fd = fs.openSync(LOCK, 'wx');      // create-or-fail: the atomic bit
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;        // a real fs problem is not ours to paper over
      if (!lockIsLive() || Date.now() - t0 > LOCK_CEILING_MS) {
        try { fs.unlinkSync(LOCK); } catch { /* someone else got there first */ }
        continue;
      }
      await sleep(400);
    }
  }
  try { return await fn(); }
  finally { try { fs.unlinkSync(LOCK); } catch { /* already stolen; nothing to undo */ } }
}

/** Shared spawn+wait: kill whatever runs, start detached, wait for /health. */
const boot = (opts) => serializeBoot(() => withBootLock(() => bootNow(opts)));

async function bootNow({ model, alias, args, label, budget }) {
  const cfg = loadConfig().llm || {};
  // Re-check now that it is our turn. While this call sat in the queue, the boot ahead
  // of it may have started exactly the model we want — two requests for the same model
  // arriving together is the common case, not the rare one. Without this they cost the
  // same 30s load twice, the second one killing a perfectly good server to do it.
  const cur = llmStatus();
  if (cur.running && cur.profile === label && await healthy(cfg.port || 8080)) {
    return { ok: true, profile: label, already: true };
  }
  if (!fs.existsSync(cfg.binary)) throw err(`llama-server binary not found at ${cfg.binary}`, 500);
  if (!fs.existsSync(model)) throw err(`model file missing: ${model} — is the download finished?`, 500);

  await stopLlama();
  fs.mkdirSync(DIR, { recursive: true });
  const argv = ['--model', model, '--host', '0.0.0.0', '--port', String(cfg.port || 8080), '--alias', alias, ...args];
  const out = fs.openSync(LOG, 'a');
  fs.writeSync(out, `\n===== ${new Date().toISOString()} starting "${label}" =====\n`);
  const child = spawn(cfg.binary, argv, { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  // The child dup'd the descriptor into its own table, so OUR copy is now pure leak —
  // and with Studio swapping models on every generation, one per swap adds up.
  try { fs.closeSync(out); } catch { }
  fs.writeFileSync(PIDFILE, String(child.pid));
  fs.writeFileSync(PROFILE_FILE, label);
  invalidateProcCache();

  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    if (await healthy(cfg.port || 8080)) return { ok: true, profile: label, ms: Date.now() - t0 };
    if (!alive(child.pid)) break;
    await sleep(1000);
  }
  let tail = '';
  try { tail = fs.readFileSync(LOG, 'utf8').slice(-600); } catch { }
  throw err(`llama-server (${label}) did not become healthy — log tail:\n${tail}`, 500);
}
