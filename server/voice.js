// Voice — speech in (faster-whisper) and speech out (Kokoro), both local.
//
// Nothing about this talks to a cloud service: the microphone audio and the
// assistant's replies never leave the box, which is the whole reason the stack is
// two ONNX/CTranslate2 models on the CPU rather than one API key.
//
// The models live in a long-lived Python worker (scripts/voice/worker.py) that this
// module owns — see that file for why. Everything here is lifecycle and framing:
// spawn on demand, serialise requests, match replies by id, and shut the worker down
// again once nobody has spoken for a while so an idle hub isn't holding ~1.2GB of
// speech models hostage on an 8GB machine that also wants to run a language model.
//
// Layout on disk (all overridable in Settings → Voice):
//   <home>/venv/bin/python              the interpreter with the two packages
//   <home>/models/whisper-<size>/       CTranslate2 whisper (Systran/faster-whisper-*)
//   <home>/models/kokoro-v1.0.onnx      Kokoro-82M
//   <home>/models/voices-v1.0.bin       its voice embeddings
// `npm run voice` (scripts/voice-setup.mjs) creates exactly that.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, DATA, ROOT } from './config.js';
import { id as genId, readJSON, writeJSON } from './util.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const TMP = path.join(DATA, 'voice', 'tmp');
const VOICES_CACHE = path.join(DATA, 'voice', 'voices.json');

// Kokoro's own limit is on phonemes and it batches internally, so this cap is about
// not handing a runaway model reply to the speaker for four minutes.
const MAX_TTS_CHARS = 2000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const STT_TIMEOUT_MS = 120_000;   // a 10-minute dictation on `small` is still under this
const TTS_TIMEOUT_MS = 90_000;
const BOOT_TIMEOUT_MS = 60_000;   // first spawn imports torch-free but still heavy wheels

export const DEFAULT_HOME = path.join(os.homedir(), '.local', 'share', 'aios', 'voice');

// The multilingual streaming Zipformer (ar/en/id/ja/ru/th/vi/zh). Chosen over the
// English-only models because half of what gets dictated here is Japanese, and a
// streaming recogniser that cannot hear 五万円 is no use for logging money.
export const DEFAULT_STREAM_MODEL = 'sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10';

/** A sherpa-onnx model directory is usable when it has tokens + the three graphs. */
const streamModelOk = (dir) => {
  try {
    if (!dir || !fs.existsSync(path.join(dir, 'tokens.txt'))) return false;
    const f = fs.readdirSync(dir);
    return ['encoder-', 'decoder-', 'joiner-'].every(p => f.some(n => n.startsWith(p) && n.endsWith('.onnx')));
  } catch { return false; }
};

// ---------------------------------------------------------------- configuration

/** Resolved, absolute view of what this box has — pure filesystem, never spawns. */
export function paths(cfg = loadConfig()) {
  const v = cfg.voice || {};
  const home = v.home || DEFAULT_HOME;
  const python = v.python || path.join(home, 'venv', 'bin', 'python');
  const models = path.join(home, 'models');

  // A bare name ('small', 'base') is a model in <home>/models; anything with a
  // separator is taken as the user pointing somewhere else entirely.
  const sttName = String(v.stt?.model || 'small');
  const sttPath = sttName.includes('/') ? sttName : path.join(models, 'whisper-' + sttName);

  // The model behind the live partials. Empty turns them off entirely.
  const partialName = String(v.stt?.partialModel ?? 'base');
  const partialPath = !partialName ? ''
    : partialName.includes('/') ? partialName : path.join(models, 'whisper-' + partialName);

  // The streaming transducer that produces the live words. A bare name is a directory
  // under <home>/models; '' turns streaming off and the partials fall back to whisper.
  const streamName = String(v.stt?.streamModel ?? DEFAULT_STREAM_MODEL);
  const streamPath = !streamName ? ''
    : streamName.includes('/') ? streamName : path.join(models, streamName);

  const ttsName = String(v.tts?.model || 'kokoro-v1.0.onnx');
  const ttsPath = ttsName.includes('/') ? ttsName : path.join(models, ttsName);
  const voicesName = String(v.tts?.voices || 'voices-v1.0.bin');
  const voicesPath = voicesName.includes('/') ? voicesName : path.join(models, voicesName);

  return { home, python, models, sttName, sttPath, partialName, partialPath,
    streamName, streamPath, ttsName, ttsPath, voicesName, voicesPath };
}

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

/** What's installed, without paying for a spawn. Drives the status chip and Settings. */
export function status() {
  const cfg = loadConfig();
  const v = cfg.voice || {};
  const p = paths(cfg);
  const pythonOk = exists(p.python);
  const sttOk = exists(path.join(p.sttPath, 'model.bin'));
  const ttsOk = exists(p.ttsPath) && exists(p.voicesPath);
  const streamOk = streamModelOk(p.streamPath);
  const installed = pythonOk && (sttOk || ttsOk);

  return {
    enabled: v.enabled !== false,
    installed, pythonOk,
    home: p.home, python: p.python,
    running: !!worker, loaded: { ...loadedState },
    lastError,
    stt: {
      ok: sttOk, model: p.sttName, path: p.sttPath,
      device: v.stt?.device || 'cpu', compute: v.stt?.compute || 'int8',
      language: v.stt?.language || '',
      // Live partials need their own (smaller) model actually present on disk.
      partialModel: p.partialName,
      partial: !!p.partialPath && exists(path.join(p.partialPath, 'model.bin')),
      partialMs: Number(v.stt?.partialMs) || 1100,
      // Live words from a streaming transducer rather than a re-run of whisper.
      // `streaming` is what the client branches on to decide whether to send PCM.
      streaming: streamOk && v.stt?.streaming !== false,
      streamModel: p.streamName, streamPath: p.streamPath, streamInstalled: streamOk,
      streamMs: Number(v.stt?.streamMs) || 200,
      // Which decoder, and how many names are biasing it. Hotwords only exist under
      // a beam search, so reporting the count unconditionally would let Settings
      // claim a bias that the running recogniser cannot apply.
      streamDecoding: String(v.stt?.streamDecoding || 'modified_beam_search'),
      streamHotwords: v.stt?.streamHotwords
        && String(v.stt?.streamDecoding || 'modified_beam_search') === 'modified_beam_search'
        ? hotwordList().split('\n').filter(Boolean).length : 0,
    },
    tts: {
      ok: ttsOk, model: p.ttsName, path: p.ttsPath, voicesPath: p.voicesPath,
      voice: v.tts?.voice || 'af_heart', speed: v.tts?.speed ?? 1,
      blend: v.tts?.blend ?? 0.5, pitch: v.tts?.pitch ?? 1,
      lang: v.tts?.lang || 'en-us', autoSpeak: !!v.tts?.autoSpeak,
      voices: cachedVoices(),
    },
    setup: installed ? null : 'run `npm run voice` in the AIOS folder to install the speech models',
  };
}

/** The voice list survives restarts so Settings can render it without a spawn. */
function cachedVoices() {
  const c = readJSON(VOICES_CACHE, null);
  return Array.isArray(c?.voices) ? c.voices : [];
}
function cacheVoices(voices) {
  if (!Array.isArray(voices) || !voices.length) return;
  try { writeJSON(VOICES_CACHE, { voices, at: Date.now() }); } catch { /* cache only */ }
}

// ------------------------------------------------------------- worker lifecycle

let worker = null;          // ChildProcess
let booting = null;         // Promise<void> while it comes up
let stdoutBuf = '';
let lastError = '';
let idleTimer = null;
let chain = Promise.resolve();
const pending = new Map();  // request id -> { resolve, reject, timer }
const loadedState = { stt: false, tts: false, stream: false };

function killWorker(why = '') {
  clearTimeout(idleTimer); idleTimer = null;
  const w = worker;
  worker = null; booting = null; stdoutBuf = '';
  loadedState.stt = false; loadedState.tts = false; loadedState.stream = false;
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(why || 'voice worker stopped')); }
  pending.clear();
  if (w) { try { w.kill('SIGTERM'); } catch { /* already gone */ } }
}

/** Public stop — Settings and the Studio-style "give me my RAM back" button. */
export function stop() {
  const was = !!worker;
  killWorker('stopped');
  return { stopped: was };
}

function touchIdle() {
  clearTimeout(idleTimer);
  const mins = Number(loadConfig().voice?.idleMinutes ?? 15);
  if (!(mins > 0)) return;
  idleTimer = setTimeout(() => killWorker('idle'), mins * 60_000);
  idleTimer.unref?.();
}

function spawnArgs(cfg) {
  const v = cfg.voice || {};
  const p = paths(cfg);
  const threads = Math.max(1, Math.min(32, Number(v.stt?.threads) || Math.max(2, Math.floor(os.cpus().length / 2))));
  return [
    path.join(ROOT, 'scripts', 'voice', 'worker.py'),
    '--stt-model', p.sttPath,
    '--stt-partial-model', p.partialPath,
    '--stt-device', String(v.stt?.device || 'cpu'),
    '--stt-compute', String(v.stt?.compute || 'int8'),
    '--stt-threads', String(threads),
    '--stt-beam', String(Math.max(1, Math.min(5, Number(v.stt?.beam) || 1))),
    '--stream-model', streamModelOk(p.streamPath) && v.stt?.streaming !== false ? p.streamPath : '',
    '--stream-threads', String(Math.max(1, Math.min(16, Number(v.stt?.streamThreads) || 4))),
    '--stream-provider', String(v.stt?.streamProvider || 'cpu'),
    '--stream-decoding', String(v.stt?.streamDecoding || 'modified_beam_search'),
    '--stream-beam', String(Math.max(1, Math.min(8, Number(v.stt?.streamBeam) || 4))),
    '--stream-hotwords-score', String(Number(v.stt?.streamHotwordScore ?? 2)),
    '--stream-rule2', String(Number(v.stt?.streamRule2 ?? 0.8)),
    '--tts-model', p.ttsPath,
    '--tts-voices', p.voicesPath,
    '--tts-voice', String(v.tts?.voice || 'af_heart'),
    '--tts-lang', String(v.tts?.lang || 'en-us'),
  ];
}

function ensureWorker() {
  if (worker) { touchIdle(); return Promise.resolve(); }
  if (booting) return booting;

  const cfg = loadConfig();
  if (cfg.voice?.enabled === false) return Promise.reject(bad('voice is turned off in Settings'));
  const p = paths(cfg);
  if (!exists(p.python)) {
    return Promise.reject(bad(`no voice python at ${p.python} — run \`npm run voice\` to install it`, 503));
  }

  const boot = new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { lastError = err.message; killWorker(err.message); reject(err); }
      else { lastError = ''; resolve(); }
    };
    const timer = setTimeout(() => done(new Error('voice worker did not start in time')), BOOT_TIMEOUT_MS);

    let child;
    try {
      child = spawn(p.python, spawnArgs(cfg), {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Keep HF/onnx caches inside the voice home rather than scattering them
        // through $HOME, and never let a stray stdout buffer break the protocol.
        env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HOME: path.join(p.home, 'hf'), HF_HUB_OFFLINE: '1' },
      });
    } catch (e) { return done(new Error(`could not start voice worker: ${e.message}`)); }

    worker = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { console.warn('[voice] unparsable line:', line.slice(0, 200)); continue; }
        if (msg.t === 'ready') { done(null); continue; }
        const req = pending.get(msg.id);
        if (!req) continue;
        pending.delete(msg.id);
        clearTimeout(req.timer);
        if (msg.ok) req.resolve(msg); else req.reject(new Error(msg.error || 'voice worker error'));
      }
    });
    // The worker logs model loads and library warnings here; surface them once
    // rather than per-line so a chatty onnxruntime doesn't flood aios.log.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      const t = String(d).trim();
      if (t) console.log('[voice]', t.split('\n').slice(-3).join(' | ').slice(0, 400));
    });
    child.on('error', (e) => done(new Error(`voice worker failed: ${e.message}`)));
    child.on('exit', (code, signal) => {
      if (child !== worker) return;                       // superseded by a restart
      const why = `voice worker exited (${signal || 'code ' + code})`;
      if (!settled) done(new Error(why)); else killWorker(why);
    });
  });

  booting = boot;
  // Cleared through the local, not unconditionally, and on BOTH outcomes. `done()`
  // calls killWorker(), which nulls `booting` — but when the failure is synchronous
  // (spawn throwing rather than emitting 'error') that null happens *inside* the
  // executor, before the assignment above overwrites it with this rejected promise.
  // Every later ensureWorker() then returned that settled rejection, so one bad spawn
  // left voice dead until the server restarted. The identity check keeps a boot that
  // has already been superseded by a restart from clearing the new one.
  const clear = () => { if (booting === boot) booting = null; };
  return boot.then(() => { clear(); touchIdle(); }, (e) => { clear(); throw e; });
}

/**
 * One request/response round trip. Calls are chained because the worker services
 * stdin sequentially anyway — queueing here means a slow synthesis can't make a
 * transcription look like it timed out while it was really just waiting its turn.
 */
function call(op, payload = {}, timeoutMs = 30_000) {
  const run = async () => {
    await ensureWorker();
    return new Promise((resolve, reject) => {
      const rid = genId(8);
      const timer = setTimeout(() => {
        pending.delete(rid);
        // A worker that blew its timeout is in an unknown state — a half-decoded
        // model is not something to hand the next request to.
        killWorker('timed out');
        reject(bad(`voice ${op} timed out`, 504));
      }, timeoutMs);
      pending.set(rid, { resolve, reject, timer });
      try { worker.stdin.write(JSON.stringify({ id: rid, op, ...payload }) + '\n'); }
      catch (e) { pending.delete(rid); clearTimeout(timer); reject(new Error(`voice worker not writable: ${e.message}`)); }
    }).finally(touchIdle);
  };
  // Failures must not poison the chain for everyone behind them.
  const next = chain.then(run, run);
  chain = next.catch(() => { });
  return next;
}

// ------------------------------------------------------------------------ audio

// The browser records webm/opus (Chrome/Firefox) or mp4/aac (Safari); PyAV decodes
// both straight from the file, so there is no ffmpeg hop on this path at all. The
// extension is still set correctly because some demuxers use it as a hint.
const EXT_FOR = {
  'audio/webm': '.webm', 'video/webm': '.webm',
  'audio/ogg': '.ogg', 'audio/opus': '.opus',
  'audio/mp4': '.m4a', 'video/mp4': '.mp4', 'audio/aac': '.aac', 'audio/x-m4a': '.m4a',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/wave': '.wav', 'audio/x-wav': '.wav',
  'audio/flac': '.flac', 'audio/x-flac': '.flac',
};
const extFor = (mime) => EXT_FOR[String(mime || '').split(';')[0].trim().toLowerCase()] || '.webm';

function tmpFile(ext) {
  fs.mkdirSync(TMP, { recursive: true });
  return path.join(TMP, `${Date.now().toString(36)}-${genId(6)}${ext}`);
}
const rm = (p) => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } };

/**
 * Transcribe a recording. Returns { text, language, duration, ms }.
 * An empty `text` is a normal outcome, not an error: the VAD found no speech,
 * which is what a mis-tap or a cough looks like.
 */
export async function transcribe(buffer, { mime = '', language, prompt } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw bad('no audio');
  if (buffer.length > MAX_AUDIO_BYTES) throw bad(`recording too large (max ${Math.round(MAX_AUDIO_BYTES / 1048576)}MB)`, 413);
  const cfg = loadConfig();
  if (!exists(path.join(paths(cfg).sttPath, 'model.bin'))) {
    throw bad('no speech-to-text model installed — run `npm run voice`', 503);
  }

  const file = tmpFile(extFor(mime));
  fs.writeFileSync(file, buffer);
  try {
    const r = await call('stt', {
      path: file,
      language: language ?? (cfg.voice?.stt?.language || ''),
      // Hand whisper this user's own nouns. Without it "Lawson" comes back as
      // "it lost in" and every platform name is a coin toss.
      prompt: prompt ?? vocabularyPrompt(),
    }, STT_TIMEOUT_MS);
    const raw = r.text || '';
    const text = normalizeTranscript(raw);
    return {
      text, raw, changed: text !== raw,
      language: r.language, languageProb: r.languageProb,
      duration: r.duration, ms: r.ms, bytes: buffer.length,
    };
  } finally { rm(file); }
}

// ------------------------------------------------- live partials while you speak
//
// faster-whisper is not a streaming recogniser, and pretending otherwise is where
// this kind of feature usually goes wrong. What works instead — and what the browser
// makes cheap — is re-transcribing the utterance-so-far every second or so.
//
// The enabling fact, measured before any of this was written: a MediaRecorder webm
// stream is decodable at EVERY chunk boundary, because the first chunk carries the
// EBML header and the rest are clusters. So the client sends only the new bytes, the
// server keeps the running concatenation, and each pass decodes the whole utterance
// from the start — which is why the text grows monotonically instead of jittering
// between independently-decoded windows.
//
// Partials are FEEDBACK, not a result. They use the small fast model, they never
// reach the language model, and the authoritative transcription is still the single
// full-quality pass over the complete recording when you stop talking. If any of this
// fails, transcription is completely unaffected — that separation is deliberate.

const streams = new Map();          // id -> { chunks, bytes, mime, at, closed }
const STREAM_TTL_MS = 5 * 60_000;   // a tab closed mid-sentence must not leak audio
const MAX_STREAM_BYTES = 25 * 1024 * 1024;
const MAX_STREAMS = 8;
// Below about a second there is nothing to recognise, and whisper will confidently
// invent something rather than return nothing.
const MIN_PARTIAL_BYTES = 6000;

function sweepStreams() {
  const cutoff = Date.now() - STREAM_TTL_MS;
  for (const [id, s] of streams) if (s.at < cutoff) streams.delete(id);
}

/**
 * Feed one chunk of live audio and return the words so far.
 *
 * TWO ENGINES, chosen by what the client sent.
 *
 * Raw PCM (`audio/pcm`) goes to the streaming transducer: state is carried between
 * chunks, so a 200ms chunk costs ~14ms and the text grows word by word the way phone
 * dictation does. This is the path the current client takes.
 *
 * Anything else is a container (webm/ogg/mp4) from a client that predates streaming,
 * and takes the original route: accumulate, then re-decode the whole utterance with
 * the small whisper. Kept because the phone PWA caches its bundle aggressively and a
 * stale client must degrade to the old feel rather than to no feedback at all.
 */
export async function partialTranscribe(id, buffer, { mime = '', rate = 0 } = {}) {
  if (!id || typeof id !== 'string' || id.length > 64) throw bad('bad stream id');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw bad('no audio');
  sweepStreams();
  if (/pcm|l16/i.test(mime)) return streamFeed(id, buffer, rate);

  let s = streams.get(id);
  if (!s) {
    if (streams.size >= MAX_STREAMS) throw bad('too many live recordings', 429);
    s = { chunks: [], bytes: 0, mime, at: Date.now(), closed: false };
    streams.set(id, s);
  }
  s.chunks.push(buffer);
  s.bytes += buffer.length;
  s.at = Date.now();
  if (s.bytes > MAX_STREAM_BYTES) { streams.delete(id); throw bad('recording too long', 413); }
  if (s.bytes < MIN_PARTIAL_BYTES) return { text: '', tooShort: true, bytes: s.bytes };

  const cfg = loadConfig();
  if (!cfg.voice?.stt?.partialModel) return { text: '', off: true };

  const file = tmpFile(extFor(s.mime || mime));
  fs.writeFileSync(file, Buffer.concat(s.chunks));
  try {
    // The worker runs one request at a time, so a partial can find itself queued
    // behind work that has since made it pointless — the user stopped talking and the
    // final pass is already what matters. Dropping it here keeps a stale partial from
    // overwriting a finished transcription on screen.
    // `s`, not streams.get(id): endPartial sets closed AND removes the entry, so a
    // map lookup here reads undefined and the guard never fires. The captured object
    // is the one endPartial mutates, which is the whole point of the flag.
    if (s.closed) return { text: '', stale: true };
    const r = await call('stt', { path: file, fast: true, language: cfg.voice?.stt?.language || '' }, STT_TIMEOUT_MS);
    if (s.closed) return { text: '', stale: true };
    return { text: normalizeTranscript(r.text || ''), raw: r.text || '', ms: r.ms, bytes: s.bytes };
  } finally { rm(file); }
}

/**
 * One chunk into the streaming transducer.
 *
 * The bookkeeping here is only about lifetime and back-pressure — the recogniser
 * itself keeps the decode state, in the worker. `endpoint: true` means it heard the
 * sentence finish, which is a better signal than a fixed silence timer because it is
 * measured against what was actually decoded rather than against loudness alone.
 */
async function streamFeed(id, buffer, rate = 0) {
  // 16k is what the old client sent and what it never named; anything outside the
  // range a microphone can plausibly run at is a mangled query string, not a device.
  const sr = Number(rate) >= 8000 && Number(rate) <= 192000 ? Math.round(Number(rate)) : 16000;
  let s = streams.get(id);
  if (!s) {
    if (streams.size >= MAX_STREAMS) throw bad('too many live recordings', 429);
    s = { chunks: [], bytes: 0, mime: 'audio/pcm', at: Date.now(), closed: false, live: true, rate: sr };
    streams.set(id, s);
    // The same merchants that go into whisper's prompt, as contextual bias for the
    // transducer — opt-in, because on this ledger it measured as noise (see
    // config.voice.stt.streamHotwords). Read once per utterance: the ledger cannot
    // change mid-sentence, and re-encoding the list every 200ms would be absurd.
    const cfg = loadConfig();
    const hotwords = cfg.voice?.stt?.streamHotwords
      && (cfg.voice?.stt?.streamDecoding || 'modified_beam_search') === 'modified_beam_search'
      ? hotwordList() : '';
    await call('stream.start', { stream: id, hotwords }, 30_000);
  }
  s.bytes += buffer.length;
  s.at = Date.now();
  if (s.bytes > MAX_STREAM_BYTES) { streams.delete(id); throw bad('recording too long', 413); }
  if (s.closed) return { text: '', stale: true };
  const r = await call('stream.feed', { stream: id, rate: sr, pcm: buffer.toString('base64') }, STT_TIMEOUT_MS);
  if (s.closed) return { text: '', stale: true };
  return {
    text: liveText(r.text), raw: r.text || '',
    endpoint: !!r.endpoint, segments: r.segments || 0, bytes: s.bytes, live: true, rate: sr,
  };
}

/**
 * The transducer's text, dressed to look like the reading that will replace it.
 *
 * It spells every number out ("THREE THOUSAND TWO HUNDRED YEN") where whisper writes
 * "3,200 yen", so the live line and the committed line disagreed on screen at exactly
 * the moment the eye is comparing them. Folded HERE and nowhere else: this text is
 * feedback and is never acted on, whereas rewriting whisper's output would put a
 * guess about English number words in front of the ledger.
 */
const liveText = (t) => normalizeTranscript(foldSpokenNumbers(t || ''));

/**
 * The recording is over: stop accepting partials, free the audio, and return the
 * last thing the recogniser had to say.
 *
 * That last part is not bookkeeping. A zipformer decodes in fixed chunks, so the
 * samples in the final partial chunk are never formed into one and the closing word
 * or two is never emitted — the live line sat on "...AT LAWSON ON LUN" for the whole
 * two seconds whisper takes to answer. `stream.end` pads with silence and flushes
 * them, and this used to be fire-and-forget, so nobody ever saw the result.
 */
export async function endPartial(id) {
  const s = streams.get(id);
  if (s) s.closed = true;                 // in-flight decodes check this and bail
  streams.delete(id);
  if (!(s?.live && worker)) return { ended: !!s, text: '' };
  try {
    // Short, and swallowed: the recording has already stopped and whisper's real
    // pass is on its way. A tail that does not arrive costs one moment of a
    // truncated line; a tail that throws would surface as an error on a finished turn.
    const r = await call('stream.end', { stream: id }, 8_000);
    return { ended: true, text: liveText(r.text) };
  } catch { return { ended: true, text: '' }; }
}

export const liveStreamCount = () => streams.size;

/**
 * Synthesize speech. Returns { wav: Buffer, ... }.
 *
 * `text` is expected to be display text — markdown, links and code fences and all —
 * so it is flattened here rather than at each call site. Reading "**twelve**" aloud
 * as "star star twelve star star" is the single most obvious way for a voice reply
 * to sound broken.
 */
export async function speak(text, { voice, speed, lang, blend, pitch } = {}) {
  const cfg = loadConfig();
  const v = cfg.voice || {};
  const clean = speakableText(text);
  if (!clean) throw bad('nothing to say');
  const p = paths(cfg);
  if (!exists(p.ttsPath) || !exists(p.voicesPath)) {
    throw bad('no text-to-speech model installed — run `npm run voice`', 503);
  }

  const chosen = voice || v.tts?.voice || 'af_heart';
  const out = tmpFile('.wav');
  try {
    const r = await call('tts', {
      text: clean, out,
      voice: chosen,
      speed: Number(speed ?? v.tts?.speed ?? 1) || 1,
      // A blend of two voices is a voice the model does not ship — see the worker.
      blend: Number(blend ?? v.tts?.blend ?? 0.5),
      pitch: Number(pitch ?? v.tts?.pitch ?? 1) || 1,
      // A voice belongs to a language and picking one is picking the other. Asking
      // a British voice to read American phonemes, or worse a Japanese voice to read
      // English ones, is a setting nobody wants and everybody can create by accident.
      lang: lang || langForVoice(chosen) || v.tts?.lang || 'en-us',
    }, TTS_TIMEOUT_MS);
    return {
      wav: fs.readFileSync(r.path), sampleRate: r.sampleRate, seconds: r.seconds,
      voice: r.voice, lang: r.lang, g2p: r.g2p, pitch: r.pitch, ms: r.ms, chars: clean.length,
    };
  } finally { rm(out); }
}

// Kokoro voice ids are <language><gender>_<name>: af_heart is American female,
// bm_george British male, jf_alpha Japanese female, and so on.
const VOICE_LANG = {
  a: 'en-us', b: 'en-gb', e: 'es', f: 'fr-fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-br', z: 'cmn',
};
export const langForVoice = (voice) => VOICE_LANG[String(voice || '').trim()[0]] || '';

/** The installed Kokoro voices, cached to disk after the first (spawning) call. */
export async function voices() {
  const cached = cachedVoices();
  if (cached.length) return cached;
  const r = await call('voices', {}, 60_000);
  cacheVoices(r.voices);
  return r.voices || [];
}

/** Pre-load the models so the first real utterance isn't the one that pays for it. */
export async function warm({ stt = true, tts = true, partial = false, stream = false } = {}) {
  const r = await call('load', { stt, tts, partial, stream }, BOOT_TIMEOUT_MS);
  loadedState.stt = !!r.stt; loadedState.tts = !!r.tts; loadedState.stream = !!r.stream;
  return { stt: loadedState.stt, tts: loadedState.tts, stream: loadedState.stream };
}

// -------------------------------------------------------------- text for speech

// What a currency code or symbol should be CALLED out loud. "JPY 12,000" is how the
// Finances app writes money and it is not how anyone says it — espeak spells the
// three letters out, so the most common sentence this hub will ever speak opens with
// "jay pee why". This is the single biggest naturalness win available.
const CURRENCY = {
  JPY: 'yen', USD: 'dollars', EUR: 'euros', GBP: 'pounds', KRW: 'won', CNY: 'yuan',
  AUD: 'Australian dollars', CAD: 'Canadian dollars', NZD: 'New Zealand dollars',
  CHF: 'francs', SGD: 'Singapore dollars', HKD: 'Hong Kong dollars', TWD: 'Taiwan dollars',
  THB: 'baht', INR: 'rupees', PHP: 'pesos', VND: 'dong', MYR: 'ringgit', IDR: 'rupiah',
};
const SYMBOL = { '¥': 'yen', $: 'dollars', '€': 'euros', '£': 'pounds', '₩': 'won', '₹': 'rupees', '฿': 'baht' };

// Order matters: fenced code goes before inline code, links before emphasis, and
// emphasis before the leftover-punctuation sweep, or each pattern eats the next
// one's delimiters.
const SPEAK_RULES = [
  [/```[\s\S]*?```/g, ' (code block) '],          // never read a program out loud
  [/~~~[\s\S]*?~~~/g, ' (code block) '],
  [/`([^`]+)`/g, '$1'],
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],              // image → its alt text
  [/\[([^\]]+)\]\([^)]*\)/g, '$1'],               // link → its label, not the URL
  [/^\s{0,3}#{1,6}\s+/gm, ''],                    // heading markers
  [/^\s{0,3}>\s?/gm, ''],                         // block quotes
  [/^\s{0,3}([-*+])\s+/gm, ''],                   // bullets
  [/^\s{0,3}\d{1,2}[.)]\s+/gm, ''],               // "1." — furniture, not speech
  [/^\s{0,3}\|.*\|\s*$/gm, ' '],                  // table rows read as noise
  [/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/gm, ' '],    // horizontal rules
  [/\*\*([^*]+)\*\*/g, '$1'],
  [/\*([^*]+)\*/g, '$1'],
  [/__([^_]+)__/g, '$1'],
  [/~~([^~]+)~~/g, '$1'],
  [/<[^>]{1,200}>/g, ' '],                        // stray html
  [/https?:\/\/\S+/g, ' link '],
];

/**
 * Whatever markup survived the structural rules — the streaming-chunk case.
 *
 * Replies are spoken sentence by sentence as they arrive, so a chunk routinely ends
 * mid-markup with no closing delimiter anywhere in it. Rules that match balanced
 * pairs are blind to that, and the result is an assistant saying "star star" out
 * loud. A lone delimiter cannot be structure, so here it is simply noise.
 */
function orphanSweep(str) {
  return str
    .replace(/\*{1,3}/g, '')
    .replace(/`+/g, '')
    .replace(/~{1,2}/g, '')
    .replace(/#{1,6}/g, '')
    .replace(/\|/g, ' ')
    // snake_case is read better with the underscores as gaps than as "underscore".
    .replace(/_+/g, ' ')
    .replace(/^\s*[-–—]{2,}\s*$/gm, ' ')
    .replace(/^\s*[-*+•‣◦]\s+/gm, '')
    .replace(/\s[-*+•‣◦](?=\s)/g, ' ');
}

/** Markdown (and other on-screen furniture) flattened into something worth hearing. */
export function speakableText(input, max = MAX_TTS_CHARS) {
  let s = String(input ?? '');
  for (const [re, to] of SPEAK_RULES) s = s.replace(re, to);

  // --- said, not written ---
  // Everything below turns text that READS fine into text that HEARS fine. The
  // arrow rule runs before the emoji sweep because → sits inside the symbol block
  // the sweep removes, and the currency rules run before the minus rule so that
  // "−JPY 5,000" has already become "−5,000 yen" when the sign is spoken.
  s = s
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    // JPY 12,000 → 12,000 yen   ·   ¥12,000 → 12,000 yen
    .replace(/\b([A-Z]{3})\s?(-?[\d,]+(?:\.\d+)?)/g, (m0, code, num) => (CURRENCY[code] ? `${num} ${CURRENCY[code]}` : m0))
    .replace(/([¥$€£₩₹฿])\s?(-?[\d,]+(?:\.\d+)?)/g, (m0, sym, num) => `${num} ${SYMBOL[sym]}`)
    // U+2212 is the sign the Finances UI uses for a negative, and it has to be read
    // BEFORE the symbol sweep below — which covers the block it lives in and would
    // otherwise turn a shortfall into a surplus without a word changing.
    .replace(/−\s*(?=[\d])/g, 'minus ')
    // An arrow between numbers is a range ("Aug 1 → Aug 31"); anywhere else it is
    // punctuation, and reading it as "to" makes a list sound like a sentence.
    .replace(/(\d)\s*[→➔]\s*(?=[^\n]{0,12}\d)/g, '$1 to ')
    .replace(/\s*(?:[→➔]|=>)\s*/g, ', ')
    .replace(/\s[·•‣]\s/g, ', ')
    .replace(/\s&\s/g, ' and ')
    .replace(/…/g, '.')
    // Emoji and pictographs: silent at best, "black medium square" at worst.
    // U+2212 is carved out above — see the minus rule.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2211}\u{2213}-\u{2BFF}\u{FE0F}]/gu, ' ')
    .replace(/(\d)\s?%/g, '$1 percent')
    .replace(/\/\s?(day|week|month|year|hour|person|kg|km|litre|liter)\b/gi, ' per $1')
    .replace(/\be\.g\.\s*/gi, 'for example, ')
    .replace(/\bi\.e\.\s*/gi, 'that is, ')
    .replace(/\betc\.\s*/gi, 'et cetera. ')
    .replace(/\bvs\.?\s/gi, 'versus ')
    .replace(/(^|\s)(?:~|\.{1,2}|[A-Za-z]:)?[\\/][^\s]*[\\/]([^\s\\/]+)/g, '$1$2')
    .replace(/(^|\s)--?(?=[A-Za-z]{2,})/g, '$1')
    .replace(/\b(\d{3,})\s*[-–]\s*(\d{3,})\b/g, '$1 to $2')
    .replace(/\b([a-zA-Z])\s*-\s*(\d+)\b/g, '$1 minus $2')
    .replace(/\s>=\s/g, ' at least ').replace(/\s<=\s/g, ' at most ')
    .replace(/\s>\s/g, ' greater than ').replace(/\s<\s/g, ' less than ')
    .replace(/\s\+\s/g, ' plus ')
    .replace(/\s=\s/g, ' equals ')
    // Leading zeros are spelled out digit by digit by every synthesizer ("007" as
    // "zero zero seven"), but the guard matters more than the rule: a comma is a word
    // boundary, so a naive \b0+ turns 12,000 into 12,0 — a money bug far worse than
    // the reading it was meant to fix. Only a standalone run of digits qualifies.
    .replace(/(?<![\w.,])0+(\d+)(?![\d.,])/g, '$1')
    // A bullet list arrives here as bare lines. Without a full stop the synthesizer
    // runs them into one breathless sentence, so give each line an ending.
    .replace(/([^\s.!?:;,。！？])[ \t]*\n+/g, '$1. ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .trim();

  // Last, because only now is what remains genuinely leftover. This is the pass that
  // handles the streaming case: a chunk that ends mid-markup ("the total is **8,000")
  // has no closing pair for any rule above to match against.
  s = orphanSweep(s)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/^[\s.,;:]+/, '')
    .trim();

  if (s.length <= max) return s;
  // Cut at a sentence end if there is one in the last fifth, so the reply doesn't
  // stop mid-word; otherwise just truncate and say so.
  const head = s.slice(0, max);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n'));
  return (cut > max * 0.8 ? head.slice(0, cut + 1) : head).trim();
}

// ------------------------------------------------------- hearing this user's words
//
// Two things wreck transcription for a bilingual user, and neither is a model
// problem — whisper simply has no idea what THIS person talks about.
//
// 1. Proper nouns it has never heard. "I spent 3000 at Lawson" came back as "I spent
//    three cents and it lost in". Whisper takes an `initial_prompt` as a hint about
//    the vocabulary to expect, so feeding it the user's own merchants, categories and
//    platforms is the single cheapest accuracy win available.
// 2. Japanese counters inside an English sentence. "I made 8 man en" transcribes as
//    "8-man n" — every word heard, the meaning gone, and 万 is *four orders of
//    magnitude*. That one is fixed after the fact, in normalizeTranscript().

let vocabCache = { at: 0, max: -1, text: '' };

/**
 * A short vocabulary hint built from the user's own data.
 *
 * Kept SHORT and comma-separated on purpose: whisper's prompt window is ~224 tokens,
 * and a long or oddly-shaped prompt makes it start quoting the prompt back at you
 * instead of transcribing. Terms are ranked by how likely they are to be said aloud.
 */
export function vocabularyPrompt({ max = 340 } = {}) {
  // Keyed on `max` as well as time: the cached string was built to fill one budget,
  // and handing it to a caller that asked for a smaller one overruns it silently.
  if (vocabCache.max === max && Date.now() - vocabCache.at < 120_000) return vocabCache.text;
  const ordered = vocabularyTerms();
  let text = '';
  for (const t of ordered) {
    const next = text ? `${text}, ${t}` : t;
    if (next.length > max) break;
    text = next;
  }
  vocabCache = { at: Date.now(), max, text };
  return text;
}

/**
 * The words this hub hears that no general model expects — merchants, categories,
 * counters — most-likely-first.
 *
 * Shared by both recognisers on purpose: whisper takes them as an `initial_prompt`
 * and the transducer takes them as hotwords, and having the ledger's own names help
 * one engine but not the other is exactly the sort of split that goes unnoticed.
 */
export function vocabularyTerms() {
  const cfg = loadConfig();
  const terms = [];
  const push = (v) => {
    const s = String(v || '').trim();
    // Single letters and pure numbers help nothing; very long strings eat the budget.
    if (s.length < 2 || s.length > 28 || /^\d+$/.test(s)) return;
    if (!terms.some(t => t.toLowerCase() === s.toLowerCase())) terms.push(s);
  };

  // Anything the user actually says out loud when logging money.
  try {
    const fin = require_finance();
    if (fin) {
      for (const m of fin.suggest({ field: 'merchant', q: '', limit: 18 }) || []) push(m.value ?? m);
      const s = fin.settings();
      for (const c of [...(s.incomeCategories || []), ...(s.expenseCategories || [])]) push(c);
    }
  } catch { /* finance unavailable — the fixed hints below still help */ }

  // The user's own terms go FIRST — the budget is ~340 chars and whisper weights the
  // start of the prompt most, so a name they added by hand outranks the 18th merchant.
  const extra = String(cfg.voice?.stt?.prompt || '').split(/[,\n]/).map(t => t.trim()).filter(Boolean);

  // Seeded regardless: the counter forms whose loss changes an amount by 10,000x,
  // and the currency words a bilingual speaker mixes into English sentences.
  const seed = ['万円', '千円', '八万円', 'man yen', 'sen yen'];

  // One deduped pass. Building the list as extra+seed+terms while ALSO push()ing the
  // extras into `terms` spent the budget twice on the same words.
  const ordered = [];
  const taken = new Set();
  for (const t of [...extra, ...seed, ...terms]) {
    const k = t.toLowerCase();
    if (taken.has(k)) continue;
    taken.add(k);
    ordered.push(t);
  }
  return ordered;
}
export const invalidateVocabulary = () => { vocabCache = { at: 0, max: -1, text: '' }; };

// How many names to bias the transducer with. Hotwords are not free — every one is
// a phrase the beam search carries — and the tail of a merchant list is places
// visited once. 24 covers everywhere this ledger actually goes.
const MAX_HOTWORDS = 24;

/**
 * The vocabulary as contextual bias for the streaming transducer.
 *
 * Three differences from the whisper prompt, all forced by what the model emits:
 * it writes English in UPPER CASE, it has no punctuation, and it splits a compound
 * name the way it was spoken — "FamilyMart" comes back as two words, so a hotword
 * written as one can never match it. Measured on 32 clips: 22.3% -> 20.9% WER, and
 * "FAMILY MARCH" becomes "FAMILY MART".
 */
export function hotwordList() {
  const out = [];
  for (const raw of vocabularyTerms()) {
    const t = String(raw)
      .replace(/([a-z])([A-Z])/g, '$1 $2')      // FamilyMart -> Family Mart
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      // The transducer says numbers, it does not write them: "Micro1" is only ever
      // decoded as "MICRO ONE", so a hotword spelled with the digit can never match
      // and only costs a beam slot.
      .replace(/(?<=\p{L})\s?([0-9])(?![0-9])/gu, (m0, d) => ' ' + DIGIT_WORD[d])
      .replace(/\s+/g, ' ')
      .trim();
    // A single character biases nothing and a long phrase never matches whole.
    if (t.length < 2 || t.split(' ').length > 4) continue;
    const hot = /[\u3040-\u30ff\u3400-\u9fff]/.test(t) ? t : t.toUpperCase();
    if (!out.includes(hot)) out.push(hot);
    if (out.length >= MAX_HOTWORDS) break;
  }
  return out.join('\n');
}

// ---- English number words, for the live line only ----

const DIGIT_WORD = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];

const NUM_WORD = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUM_SCALE = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
const NUM_RE = new RegExp(
  `\\b(?:${[...Object.keys(NUM_WORD), ...Object.keys(NUM_SCALE)].join('|')})(?:[\\s-]+(?:and[\\s-]+)?(?:${[...Object.keys(NUM_WORD), ...Object.keys(NUM_SCALE)].join('|')}))*\\b`,
  'gi');

/**
 * "THREE THOUSAND TWO HUNDRED" -> "3200".
 *
 * ONLY for the transducer's live text. Whisper already writes digits, and running
 * this over the reading that reaches the ledger would turn "one of the receipts"
 * into "1 of the receipts" for no gain at all.
 *
 * "and" is joined only INSIDE a run that has already started, so "milk and eggs"
 * keeps its conjunction while "a hundred and twenty" becomes 120. A run that
 * resolves to nothing is returned untouched rather than replaced with a zero — "one"
 * meaning the article is common and "0" would be a lie.
 */
export function foldSpokenNumbers(text) {
  const src = String(text ?? '');
  return src.replace(NUM_RE, (m, offset) => {
    let total = 0, cur = 0, saw = false;
    for (const w of m.toLowerCase().split(/[\s-]+/)) {
      if (w === 'and') continue;
      if (w in NUM_WORD) { cur += NUM_WORD[w]; saw = true; }
      else if (w === 'hundred') { cur = (cur || 1) * 100; saw = true; }
      else if (w in NUM_SCALE) { total += (cur || 1) * NUM_SCALE[w]; cur = 0; saw = true; }
    }
    if (!saw) return m;
    // A bare "one" is as often the article as it is an amount, so a single word only
    // folds when a counter follows and settles it — "TWELVE MAN" is 120,000 and has
    // to become "12 man" here or normalizeTranscript's counter rules, which all
    // require a digit, never fire on it at all.
    const rest = src.slice(offset + m.length);
    const counted = /^[\s-]*(man|sen|oku|cho|yen|en|end|dollars?|euros?|pounds?)\b/i.test(rest);
    if (!/[\s-]/.test(m) && !counted) return m;
    return String(total + cur);
  })
    // "a hundred and twenty" folds to "a 120"; the article was part of the number.
    .replace(/\b[Aa] (?=\d)/g, '');
}

// finance.js opens a SQLite database on import, so it is INJECTED rather than
// imported: voice then works (and tests) on an install where the ledger has never
// been opened, and this module keeps no database dependency of its own.
let financeMod = null;
const require_finance = () => financeMod;
/** Wired by index.js at boot so voice can read the ledger's vocabulary. */
export function useFinance(mod) { financeMod = mod || null; invalidateVocabulary(); }

// ---- Japanese counters inside any sentence ----

const JP_DIGIT = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ROMAJI = {
  ichi: 1, ni: 2, san: 3, yon: 4, shi: 4, go: 5, roku: 6, nana: 7, shichi: 7,
  hachi: 8, hatchi: 8, kyu: 9, kyuu: 9, ku: 9, ju: 10, juu: 10,
};
const SCALE = { man: 1e4, 万: 1e4, sen: 1e3, 千: 1e3, oku: 1e8, 億: 1e8, cho: 1e12, 兆: 1e12 };

/**
 * 八万 → 80000, 十二 → 12, 二十三 → 23. Small kanji numerals, which is all anyone says.
 *
 * The digits after 十 ADD to it, they do not shift it — 十二 is twelve, not a hundred
 * and two. Treating the string as positional gets that wrong by an order of magnitude,
 * which on a money figure is not a rounding error.
 */
function kanjiNumber(s) {
  let total = 0, section = 0, digit = 0;
  for (const ch of s) {
    if (ch in JP_DIGIT) { digit = JP_DIGIT[ch]; continue; }
    if (ch === '十') { section += (digit || 1) * 10; digit = 0; continue; }
    if (ch in SCALE) { total += (section + digit) * SCALE[ch]; section = 0; digit = 0; continue; }
    return null;
  }
  return (total + section + digit) || null;
}

const group = (n) => Math.round(n).toLocaleString('en-US');

/**
 * Rewrite spoken amounts into figures, so "8 man en" reaches the model — and the
 * confirmation card — as 80,000 yen rather than as the words "8-man n".
 *
 * Deliberately conservative. Every rule needs a NUMBER (or a kanji numeral) adjacent
 * to a counter: "man" on its own is an English word and must stay one, which is why
 * `\d+\s*man` matches and `the man` does not.
 */
export function normalizeTranscript(text) {
  let s = String(text ?? '');
  if (!s) return s;

  // 8万円 / 八万円 / 十二万 — kanji and mixed forms. The counter was written in
  // Japanese, so the currency stays Japanese: dropping " yen" into the middle of a
  // Japanese sentence reads badly and helps nobody.
  s = s.replace(/(\d+(?:\.\d+)?|[〇零一二三四五六七八九十]+)\s*([万千億兆])\s*(円)?/g, (m0, num, scale, yen) => {
    const base = /^\d/.test(num) ? Number(num) : kanjiNumber(num);
    if (!base) return m0;
    return `${group(base * SCALE[scale])}${yen ? '円' : ''}`;
  });

  // 8 man en · 8-man n · 8 man yen · 8 man end.  Whisper renders 円 as "en", "n",
  // "yen" or "end" depending on what follows, and all four have to be consumed —
  // "end" turned up in the capture benchmark and was falling straight through.
  // "and" is deliberately NOT in the list: it is a conjunction far more often than
  // it is a mangled 円, and eating it deletes a word from the sentence.
  s = s.replace(/\b(\d+(?:\.\d+)?)\s*[-–]?\s*(man|sen|oku|cho)\b(?:\s*[-–]?\s*(en|n|yen|end)\b)?/gi,
    (m0, num, scale, yen) => {
      const v = Number(num) * SCALE[scale.toLowerCase()];
      if (!Number.isFinite(v)) return m0;
      return `${group(v)}${yen ? ' yen' : ''}`;
    });

  // hachi man en · san sen — spelled-out numerals, which whisper title-cases and
  // hyphenates ("Hatchi-Man N") because it thinks they are a name.
  s = s.replace(/\b(ichi|ni|san|yon|shi|go|roku|nana|shichi|hachi|hatchi|kyuu?|ku|juu?)\s*[-–]?\s*(man|sen|oku)\b(?:\s*[-–]?\s*(en|n|yen|end)\b)?/gi,
    (m0, num, scale, yen) => {
      const base = ROMAJI[num.toLowerCase()];
      if (!base) return m0;
      return `${group(base * SCALE[scale.toLowerCase()])}${yen ? ' yen' : ''}`;
    });

  // "50k" is said far more often than it is written in a ledger.
  s = s.replace(/\b(\d+(?:\.\d+)?)k\b(?=\s*(yen|en|dollars?|usd|jpy|\b|$))/gi, (m0, n) => group(Number(n) * 1000));

  return s.replace(/\s{2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------- service

/** Registered by index.js so Home shows a Voice chip alongside SearXNG/Ollama. */
export function serviceProbe() {
  const s = status();
  if (!s.enabled) return { status: 'off', detail: 'turned off' };
  if (!s.installed) return { status: 'off', detail: s.pythonOk ? 'models missing' : 'not installed' };
  if (lastError) return { status: 'down', detail: lastError.slice(0, 80) };
  const bits = [s.stt.ok ? `${s.stt.model} · listen` : null, s.tts.ok ? `${s.tts.voice} · speak` : null].filter(Boolean);
  return { status: s.stt.ok || s.tts.ok ? 'up' : 'off', detail: (s.running ? 'loaded · ' : '') + bits.join(' · ') };
}

// Speech models must not outlive the server; a detached python holding the CPU (and
// a stale stdin) is the kind of orphan you only notice via the fan.
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, () => { try { killWorker('server exit'); } catch { } });
