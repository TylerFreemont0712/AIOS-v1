// Install the local speech stack: `npm run voice`.
//
// Everything lands in ONE directory (default ~/.local/share/aios/voice) that AIOS
// never writes to otherwise, so removing voice is `rm -rf` on that path. It is
// deliberately NOT the repo and deliberately NOT an existing venv: the box this was
// written on has a ComfyUI venv with torch in it, and quietly pip-installing into
// somebody's image-generation environment is how you break image generation.
//
//   node scripts/voice-setup.mjs                 # venv + small whisper + Kokoro + CJK
//   node scripts/voice-setup.mjs --stt base      # smaller/faster ASR (worse on names)
//   node scripts/voice-setup.mjs --stt medium    # slower, best accuracy
//   node scripts/voice-setup.mjs --no-cjk        # skip the Japanese/Chinese phonemizers
//   node scripts/voice-setup.mjs --home /path    # somewhere else entirely
//   node scripts/voice-setup.mjs --check         # report what's there, install nothing
//
// Roughly 2GB on disk and a few minutes on a cold cache (1.5GB without --no-cjk).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes('--' + name);

const HOME = path.resolve(flag('home', path.join(os.homedir(), '.local', 'share', 'aios', 'voice')));
const MODELS = path.join(HOME, 'models');
const VENV = path.join(HOME, 'venv');
const PY = path.join(VENV, 'bin', 'python');
const STT_SIZE = flag('stt', 'small');
const CHECK_ONLY = has('check');

// Kokoro-82M as ONNX. Piper was archived in October 2025; Kokoro is the current
// small-and-good option and fits beside a quantized LLM on an 8GB card — it runs on
// the CPU here anyway, at roughly 4x realtime.
const KOKORO_BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
const KOKORO_FILES = [
  ['kokoro-v1.0.onnx', 325_532_387],
  ['voices-v1.0.bin', 28_214_398],
];
const WHISPER_REPO = { tiny: 'Systran/faster-whisper-tiny', base: 'Systran/faster-whisper-base', small: 'Systran/faster-whisper-small', medium: 'Systran/faster-whisper-medium' };

// The streaming transducer behind the live words that appear WHILE you speak.
//
// Whisper cannot do that job: it is a seq2seq model over a fixed 30-second window, so
// it decodes the padding too — measured here, 0.83s of speech costs `small` 1786ms and
// 9.71s costs 2163ms. Short dictation pays the full window price every time, and the
// old partials re-ran it over the whole utterance once a second.
//
// A Zipformer transducer carries state between chunks instead: RTF ~0.065 on four CPU
// threads, so text grows word by word. The multilingual build is the one worth having
// here rather than the (better, smaller) English-only ones, because half of what gets
// dictated into this hub is Japanese.
const STREAM_MODEL = 'sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10';
const STREAM_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${STREAM_MODEL}.tar.bz2`;
const STREAM_BYTES = 258_999_581;

const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`  · ${m}`);
const warn = (m) => console.warn(`  ! ${m}`);

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${argv.slice(0, 3).join(' ')} … exited ${r.status}`);
}

/** The newest CPython that is not so new that wheels are missing for it. 3.14 was
 *  on PATH here and has no ctranslate2 wheel; 3.12 does. */
function findPython() {
  const candidates = [
    process.env.AIOS_VOICE_PYTHON,
    '/usr/bin/python3.12', '/usr/bin/python3.11', '/usr/bin/python3.13', '/usr/bin/python3.10',
    'python3.12', 'python3.11', 'python3',
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import sys,venv;print("%d.%d"%sys.version_info[:2])'], { encoding: 'utf8' });
    if (r.status === 0) {
      const [maj, min] = r.stdout.trim().split('.').map(Number);
      if (maj === 3 && min >= 10 && min <= 13) return { bin: c, version: `${maj}.${min}` };
    }
  }
  return null;
}

async function download(url, dest, expectBytes) {
  if (fs.existsSync(dest)) {
    const size = fs.statSync(dest).size;
    // A partial download from an interrupted run is worse than none: onnxruntime
    // reports it as a corrupt protobuf, which reads like a code bug.
    if (!expectBytes || Math.abs(size - expectBytes) < expectBytes * 0.02) { ok(`${path.basename(dest)} already present`); return; }
    warn(`${path.basename(dest)} looks truncated (${size} bytes) — downloading again`);
  }
  info(`downloading ${path.basename(dest)} …`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  const tmp = dest + '.part';
  await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
  ok(`${path.basename(dest)} (${(fs.statSync(dest).size / 1048576).toFixed(0)} MB)`);
}

function report() {
  const sttDir = path.join(MODELS, 'whisper-' + STT_SIZE);
  const rows = [
    ['python', PY, fs.existsSync(PY)],
    ['whisper (' + STT_SIZE + ')', sttDir, fs.existsSync(path.join(sttDir, 'model.bin'))],
    ['kokoro', path.join(MODELS, 'kokoro-v1.0.onnx'), fs.existsSync(path.join(MODELS, 'kokoro-v1.0.onnx'))],
    ['voices', path.join(MODELS, 'voices-v1.0.bin'), fs.existsSync(path.join(MODELS, 'voices-v1.0.bin'))],
  ];
  // Listed apart from the four above because it is the one optional piece: without it
  // voice still works, it just goes back to whisper-rerun partials.
  const streamDir = path.join(MODELS, STREAM_MODEL);
  const streamOk = fs.existsSync(path.join(streamDir, 'tokens.txt'));
  for (const [name, p, present] of rows) console.log(`  ${present ? '✓' : '✗'} ${name.padEnd(18)} ${p}`);
  console.log(`  ${streamOk ? '✓' : '·'} ${'streaming'.padEnd(18)} ${streamOk ? streamDir : 'not installed — live text falls back to whisper'}`);
  return rows.every(r => r[2]);
}

async function main() {
  console.log(`\nAIOS voice stack → ${HOME}\n`);

  if (CHECK_ONLY) {
    const complete = report();
    console.log(complete ? '\n  all present\n' : '\n  incomplete — run `npm run voice`\n');
    process.exit(complete ? 0 : 1);
  }

  if (!WHISPER_REPO[STT_SIZE]) throw new Error(`--stt must be one of ${Object.keys(WHISPER_REPO).join(', ')}`);
  fs.mkdirSync(MODELS, { recursive: true });

  // 1. interpreter
  if (!fs.existsSync(PY)) {
    const py = findPython();
    if (!py) throw new Error('no suitable python found (need 3.10–3.13 with venv). Set AIOS_VOICE_PYTHON=/path/to/python3.12');
    info(`creating venv with ${py.bin} (${py.version}) …`);
    run(py.bin, ['-m', 'venv', VENV]);
  }
  ok(`python at ${PY}`);

  // 2. packages. faster-whisper brings ctranslate2 + PyAV (which is what lets the
  //    worker read the browser's webm/opus without an ffmpeg hop); kokoro-onnx
  //    brings onnxruntime and a bundled espeak-ng for phonemization.
  const need = spawnSync(PY, ['-c', 'import faster_whisper, kokoro_onnx'], { stdio: 'ignore' }).status !== 0;
  if (need) {
    info('installing faster-whisper + kokoro-onnx (a few hundred MB) …');
    run(PY, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet']);
    run(PY, ['-m', 'pip', 'install', 'faster-whisper', 'kokoro-onnx']);
    if (!has('no-streaming')) run(PY, ['-m', 'pip', 'install', 'sherpa-onnx']);
  }
  ok('faster-whisper + kokoro-onnx installed');

  // Japanese and Mandarin need a real grapheme→phoneme front end. Kokoro's default
  // is espeak-ng, whose Japanese does not read kanji — it reads *about* them, and
  // phonemizes 今月の食費 as "Chinese letter, Chinese letter, Chinese letter". misaki
  // is the G2P Kokoro was trained against; with it, the same sentence takes 3.5s
  // instead of 17.5s and is actually intelligible. Optional, and only these two
  // language families need it.
  if (!has('no-cjk')) {
    const haveCJK = spawnSync(PY, ['-c', 'from misaki import ja, zh'], { stdio: 'ignore' }).status === 0;
    if (!haveCJK) {
      info('installing Japanese/Mandarin phonemizers (misaki) …');
      run(PY, ['-m', 'pip', 'install', 'misaki[ja]', 'misaki[zh]']);
    }
    // fugashi needs the UniDic dictionary itself, which the wheel does not carry.
    const haveDict = spawnSync(PY, ['-c', 'from misaki import ja; ja.JAG2P()'], { stdio: 'ignore' }).status === 0;
    if (!haveDict) {
      info('downloading the UniDic dictionary (~250MB, Japanese only) …');
      run(PY, ['-m', 'unidic', 'download']);
    }
    const cjkOk = spawnSync(PY, ['-c', 'from misaki import ja; ja.JAG2P()'], { stdio: 'ignore' }).status === 0;
    if (cjkOk) ok('Japanese/Mandarin voices will read kanji properly');
    else warn('the CJK phonemizers did not come up — the Japanese voices will fall back to espeak');
  } else info('skipping the CJK phonemizers (--no-cjk)');

  // 3. Kokoro voice model
  for (const [file, size] of KOKORO_FILES) await download(`${KOKORO_BASE}/${file}`, path.join(MODELS, file), size);

  // 4. whisper weights, pinned into models/ instead of the shared HF cache so the
  //    whole stack is one removable directory.
  const sttDir = path.join(MODELS, 'whisper-' + STT_SIZE);
  if (fs.existsSync(path.join(sttDir, 'model.bin'))) ok(`whisper-${STT_SIZE} already present`);
  else {
    info(`downloading whisper-${STT_SIZE} …`);
    run(PY, ['-c',
      'import sys;from huggingface_hub import snapshot_download;snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2])',
      WHISPER_REPO[STT_SIZE], sttDir,
    ], { env: { ...process.env, HF_HOME: path.join(HOME, 'hf') } });
    ok(`whisper-${STT_SIZE}`);
  }

  // 5. the streaming recogniser. Optional: without it the live text falls back to
  //    re-running the small whisper once a second, which is how this used to work.
  const streamDir = path.join(MODELS, STREAM_MODEL);
  if (has('no-streaming')) info('skipping the streaming recogniser (--no-streaming)');
  else if (fs.existsSync(path.join(streamDir, 'tokens.txt'))) ok(`${STREAM_MODEL} already present`);
  else {
    const tar = path.join(MODELS, STREAM_MODEL + '.tar.bz2');
    await download(STREAM_URL, tar, STREAM_BYTES);
    info('extracting …');
    const x = spawnSync('tar', ['xjf', tar, '-C', MODELS], { encoding: 'utf8' });
    if (x.status !== 0) warn(`could not extract it (${(x.stderr || '').trim().slice(0, 120)}) — live text will fall back to whisper`);
    else { fs.rmSync(tar, { force: true }); ok(STREAM_MODEL); }
  }

  // 6. prove it actually runs, here, rather than at the user's first tap of the mic
  info('checking the models load …');
  const probe = spawnSync(PY, ['-c', `
import sys
sys.stderr = open('/dev/null','w') if hasattr(sys,'stderr') else sys.stderr
from faster_whisper import WhisperModel
WhisperModel(${JSON.stringify(sttDir)}, device='cpu', compute_type='int8')
import espeakng_loader
from phonemizer.backend.espeak.wrapper import EspeakWrapper
EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
from kokoro_onnx import Kokoro
k = Kokoro(${JSON.stringify(path.join(MODELS, 'kokoro-v1.0.onnx'))}, ${JSON.stringify(path.join(MODELS, 'voices-v1.0.bin'))})
print(len(k.get_voices()))
`], { encoding: 'utf8' });
  if (probe.status !== 0) {
    warn('the models are downloaded but did not load:');
    console.error((probe.stderr || '').split('\n').slice(-8).join('\n'));
    process.exit(1);
  }
  ok(`both models load · ${(probe.stdout || '').trim()} voices available`);

  console.log(`
  Done. Voice is on in AIOS:
    · Chat composer   — the mic button, or hold Space in Voice mode
    · Voice mode      — the waveform button next to it, for a hands-free back-and-forth
    · Settings → Voice — pick a voice, speed, and whether replies are read aloud

  Speech models are loaded on first use and dropped again after
  ${'`voice.idleMinutes`'} of quiet, so an idle hub isn't holding on to them.
`);
}

main().catch((e) => { console.error(`\n  ✗ ${e.message}\n`); process.exit(1); });
