// Measure the transcription pipeline instead of guessing at it.
//
//   npm run voice-bench                 the defaults, on a realistic phrase set
//   npm run voice-bench -- --models small,medium,turbo
//   npm run voice-bench -- --beams 1,5 --compute int8,int8_float32
//   npm run voice-bench -- --degrade    also score a noisy, low-bitrate version
//   npm run voice-bench -- --phrases my.txt
//   npm run voice-bench -- --stream     score the LIVE recogniser instead
//
// `--stream` measures a different thing: the streaming transducer that writes words
// on screen while you are still talking, fed 200ms at a time exactly as the browser
// feeds it. It reports word error rate, how long you speak before the first word
// appears, and RTF. Its accuracy is not comparable to whisper's — that is the point
// of having both — so compare its configurations against each other.
//
// HOW IT WORKS. The phrase set is turned into audio by AIOS's own Kokoro voices —
// several of them, at different speaking rates — then fed back through the same
// worker the microphone uses, and scored with word error rate against the text that
// went in. Changing one knob at a time gives a number rather than an opinion.
//
// THE HONEST CAVEAT, because it decides how much to trust the output: synthesised
// speech is cleaner and more uniform than a person at a laptop microphone, so the
// ABSOLUTE error rates here are optimistic. What the harness is good for is RELATIVE
// comparison — model A versus model B, beam 1 versus beam 5, with and without the
// vocabulary hint — because every configuration hears exactly the same audio.
// `--degrade` narrows the gap by re-encoding through 24kbps opus with added hiss,
// which is roughly what a cheap mic in a room does to the signal.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, dflt = '') => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const has = (n) => args.includes('--' + n);

const HOME = process.env.AIOS_VOICE_HOME || path.join(os.homedir(), '.local', 'share', 'aios', 'voice');
const PY = path.join(HOME, 'venv', 'bin', 'python');
const MODELS = path.join(HOME, 'models');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-vbench-'));

if (!fs.existsSync(PY)) { console.error(`no voice python at ${PY} — run \`npm run voice\``); process.exit(1); }

// Phrases chosen to exercise what this hub is actually asked out loud: money with
// Japanese counters, merchant and platform names, dates and times, and the plain
// sentences that should never be a problem.
const DEFAULT_PHRASES = [
  'How much is left in my grocery budget this month?',
  'I made 8 man en through Micro1 today',
  'I got 12 man from Upwork yesterday',
  'I spent 2400 yen at FamilyMart',
  'Log 1250 yen for lunch at Matsuzakaya',
  'I have a dentist appointment next Tuesday at 3pm',
  'Add milk and eggs to my shopping list',
  'What did I spend on groceries last month?',
  'Set my grocery budget to 45000 yen a month',
  'Remind me to send the invoice on Friday',
  'My goal this month is 100000 yen',
  'How am I doing against my savings goal?',
];

const phraseFile = flag('phrases');
const PHRASES = phraseFile
  ? fs.readFileSync(phraseFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  : DEFAULT_PHRASES;

const MODEL_ALIAS = { tiny: 'whisper-tiny', base: 'whisper-base', small: 'whisper-small', medium: 'whisper-medium', turbo: 'whisper-turbo' };
const wanted = flag('models', 'small').split(',').map(s => s.trim()).filter(Boolean);
const models = wanted.filter((m) => {
  const dir = path.join(MODELS, MODEL_ALIAS[m] || m);
  const ok = fs.existsSync(path.join(dir, 'model.bin'));
  if (!ok) console.warn(`  · skipping ${m}: not installed at ${dir}`);
  return ok;
});
if (!models.length) { console.error('none of the requested models are installed'); process.exit(1); }

const beams = flag('beams', '1').split(',').map(Number).filter(Boolean);
const computes = flag('compute', 'int8').split(',').map(s => s.trim()).filter(Boolean);
const VOCAB = has('no-vocab') ? '' : '万円, 千円, man yen, Micro1, Upwork, FamilyMart, Matsuzakaya, Kusuri no Aoki, Groceries, Food & Drink';

// ---------------------------------------------------------------- scoring

/** Compare the way a listener would: case, punctuation and thousands separators are
 *  not errors. "12,000" and "12000" are the same number heard. */
function normalize(s) {
  return String(s).toLowerCase()
    .replace(/[，,](?=\d)/g, '')
    .replace(/[.,!?;:"'`´’“”…()\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word error rate: edit distance over words, as a fraction of the reference. */
function wer(ref, hyp) {
  const r = normalize(ref).split(' ').filter(Boolean);
  const h = normalize(hyp).split(' ').filter(Boolean);
  if (!r.length) return h.length ? 1 : 0;
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = r[i - 1] === h[j - 1] ? d[i - 1][j - 1]
        : 1 + Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1]);
    }
  }
  return d[r.length][h.length] / r.length;
}

// ---------------------------------------------------------------- the worker

function talkTo(workerArgs, requests) {
  const proc = spawnSync(PY, workerArgs, {
    input: requests.map(r => JSON.stringify(r)).join('\n') + '\n',
    encoding: 'utf8', maxBuffer: 1 << 28,
  });
  if (proc.error) throw proc.error;
  const out = [];
  for (const line of (proc.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* not protocol */ }
  }
  return out;
}

const baseArgs = (model, beam, compute) => [
  path.join(ROOT, 'scripts', 'voice', 'worker.py'),
  '--stt-model', path.join(MODELS, MODEL_ALIAS[model] || model),
  '--stt-compute', compute, '--stt-beam', String(beam),
  '--stt-threads', String(Math.max(2, Math.min(16, os.cpus().length))),
  '--tts-model', path.join(MODELS, 'kokoro-v1.0.onnx'),
  '--tts-voices', path.join(MODELS, 'voices-v1.0.bin'),
];

// ---------------------------------------------------------------- 1. make the audio

// Several voices and rates, so a result is not an artefact of one synthetic speaker.
const SPEAKERS = [
  { voice: 'af_heart', speed: 1.0 },
  { voice: 'am_fenrir', speed: 0.95 },
  { voice: 'bf_emma', speed: 1.08 },
];

console.log(`\nBuilding ${PHRASES.length * SPEAKERS.length} clips from ${SPEAKERS.length} voices…`);
const clips = [];
{
  const reqs = [];
  PHRASES.forEach((text, i) => SPEAKERS.forEach((sp, k) => {
    const out = path.join(WORK, `c${i}_${k}.wav`);
    clips.push({ text, out, voice: sp.voice });
    reqs.push({ id: `${i}_${k}`, op: 'tts', text, voice: sp.voice, speed: sp.speed, out });
  }));
  reqs.push({ id: 'x', op: 'exit' });
  const res = talkTo(baseArgs(models[0], 1, computes[0]), reqs);
  const made = res.filter(r => r.ok && r.path).length;
  if (!made) { console.error('could not synthesize any audio — is Kokoro installed?'); process.exit(1); }
  console.log(`  ${made} clips ready`);
}

// Optionally rough them up: 24kbps opus plus hiss, which is roughly what a cheap
// microphone in a room does to a signal before whisper ever sees it.
if (has('degrade')) {
  const ffmpeg = ['ffmpeg', '/usr/bin/ffmpeg', '/home/linuxbrew/.linuxbrew/bin/ffmpeg']
    .find(p => spawnSync(p, ['-version'], { stdio: 'ignore' }).status === 0);
  if (!ffmpeg) console.warn('  · --degrade needs ffmpeg; skipping');
  else {
    process.stdout.write('  degrading clips (24kbps opus + hiss)… ');
    for (const c of clips) {
      const noisy = c.out.replace(/\.wav$/, '.webm');
      spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', c.out,
        '-filter_complex', 'anoisesrc=a=0.004:d=60[n];[0:a][n]amix=inputs=2:duration=first,highpass=f=80,lowpass=f=7000',
        '-c:a', 'libopus', '-b:a', '24k', noisy], { stdio: 'ignore' });
      if (fs.existsSync(noisy)) c.out = noisy;
    }
    console.log('done');
  }
}

// ------------------------------------------------- 2a. the streaming transducer

// `--stream` scores the LIVE recogniser instead of whisper: a different model, a
// different failure mode, and until now no numbers at all. It is fed the way the
// browser feeds it — 200ms at a time, state carried between chunks — so what comes
// out is what appears on screen while you are still talking, not a batch score.
if (has('stream')) {
  const dir = flag('stream-model', path.join(MODELS, 'sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10'));
  if (!fs.existsSync(path.join(dir, 'tokens.txt'))) {
    console.error(`no streaming model at ${dir} — run \`npm run voice\``);
    process.exit(1);
  }

  /** The samples out of a RIFF file, plus the rate they were recorded at. */
  const readWav = (p) => {
    const b = fs.readFileSync(p);
    let off = 12, rate = 16000, data = Buffer.alloc(0);
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
      if (id === 'fmt ') rate = b.readUInt32LE(off + 12);
      if (id === 'data') { data = b.subarray(off + 8, off + 8 + size); break; }
      off += 8 + size + (size & 1);
    }
    return { rate, data };
  };

  // The same list the server biases with, so the bench measures the shipped thing
  // rather than a hand-written approximation of it.
  const { hotwordList, foldSpokenNumbers } = await import('../server/voice.js');
  const HOT = flag('hotwords', hotwordList());

  const streamArgs = (decoding) => [
    path.join(ROOT, 'scripts', 'voice', 'worker.py'),
    '--stream-model', dir,
    '--stream-threads', flag('stream-threads', '4'),
    '--stream-decoding', decoding,
    '--stream-beam', flag('stream-beam', '4'),
    '--stream-hotwords-score', flag('hotwords-score', '2'),
    '--stream-rule2', flag('rule2', '0.8'),
  ];

  const chunkMs = Number(flag('stream-ms', '200'));
  const cases = [];
  for (const decoding of flag('decoding', 'greedy_search,modified_beam_search').split(',').map(x => x.trim()).filter(Boolean)) {
    for (const hot of (decoding === 'modified_beam_search' && HOT ? [false, true] : [false])) {
      cases.push({ decoding, hot });
    }
  }

  console.log(`\nStreaming transducer · ${path.basename(dir)} · ${chunkMs}ms chunks`);
  const srows = [];
  for (const { decoding, hot } of cases) {
    const label = `${decoding.replace('_search', '')}${hot ? ' +hotwords' : ''}`;
    process.stdout.write(`\n${label.padEnd(34)} `);

    // Every clip's whole conversation goes in as one stdin script — the worker
    // answers strictly in order, so the replies come back matched by id.
    const reqs = [];
    const plan = [];
    clips.forEach((c, i) => {
      const { rate, data } = readWav(c.out.endsWith('.wav') ? c.out : c.out);
      const per = Math.floor(rate * chunkMs / 1000) * 2;      // int16 mono
      const feeds = [];
      reqs.push({ id: `s${i}`, op: 'stream.start', stream: String(i), hotwords: hot ? HOT : '' });
      for (let o = 0, k = 0; o < data.length; o += per, k++) {
        const id = `f${i}_${k}`;
        feeds.push({ id, at: Math.min((o + per) / 2 / rate, data.length / 2 / rate) });
        reqs.push({ id, op: 'stream.feed', stream: String(i), rate, pcm: data.subarray(o, o + per).toString('base64') });
      }
      reqs.push({ id: `e${i}`, op: 'stream.end', stream: String(i) });
      plan.push({ i, feeds, seconds: data.length / 2 / rate });
    });
    reqs.push({ id: 'x', op: 'exit' });

    const t0 = Date.now();
    const res = talkTo(streamArgs(decoding), reqs);
    const secs = (Date.now() - t0) / 1000;
    const byId = new Map(res.filter(r => r.id !== undefined).map(r => [String(r.id), r]));

    let total = 0, exact = 0, firsts = [], audio = 0, worst = null, ends = 0;
    for (const { i, feeds, seconds } of plan) {
      audio += seconds;
      let first = null;
      for (const f of feeds) {
        const t = byId.get(f.id);
        if (t?.endpoint) ends++;
        if (first === null && t?.text) first = f.at;
      }
      // What the user is left looking at: the flush, which is the only thing that
      // emits the words in the final partial decode chunk.
      const heard = foldSpokenNumbers(byId.get(`e${i}`)?.text || '');
      const e = wer(clips[i].text, heard);
      total += e;
      if (e === 0) exact++;
      if (first !== null) firsts.push(first);
      if (!worst || e > worst.e) worst = { e, said: clips[i].text, heard };
    }
    const avg = total / clips.length;
    const first = firsts.length ? firsts.reduce((a, b) => a + b, 0) / firsts.length : 0;
    srows.push({ label, wer: avg, exact, n: clips.length, first, rtf: secs / audio, worst, ends });
    process.stdout.write(`WER ${(avg * 100).toFixed(1)}%  first word ${first.toFixed(2)}s  RTF ${(secs / audio).toFixed(3)}`);
  }

  console.log('\n\n' + '═'.repeat(78));
  console.log('LIVE RECOGNISER'.padEnd(30) + 'WER'.padStart(8) + 'EXACT'.padStart(10) + 'FIRST WORD'.padStart(14) + 'RTF'.padStart(10));
  console.log('─'.repeat(78));
  for (const r of srows) {
    console.log(r.label.padEnd(30)
      + `${(r.wer * 100).toFixed(1)}%`.padStart(8)
      + `${r.exact}/${r.n}`.padStart(10)
      + `${r.first.toFixed(2)}s`.padStart(14)
      + `${r.rtf.toFixed(3)}`.padStart(10));
  }
  console.log('═'.repeat(78));
  console.log('\nThe live text is FEEDBACK — whisper still does the pass that is acted on, so');
  console.log('read these against each other, not against the table above. RTF is per second');
  console.log('of audio: anything under 1 keeps up with speech, and this budget is 200ms a chunk.');
  console.log('First word is how long you talk before anything appears.\n');
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(0);
}

// ---------------------------------------------------------------- 2. score each config

const rows = [];
for (const model of models) {
  for (const compute of computes) {
    for (const beam of beams) {
      for (const useVocab of (has('vocab-both') ? [false, true] : [!!VOCAB])) {
        const label = `${model} ${compute} beam${beam}${VOCAB ? (useVocab ? ' +vocab' : ' -vocab') : ''}`;
        process.stdout.write(`\n${label.padEnd(34)} `);
        const reqs = clips.map((c, i) => ({
          id: String(i), op: 'stt', path: c.out, prompt: useVocab ? VOCAB : '',
        }));
        reqs.push({ id: 'x', op: 'exit' });
        const t0 = Date.now();
        const res = talkTo(baseArgs(model, beam, compute), reqs);
        const byId = new Map(res.filter(r => r.id !== undefined).map(r => [String(r.id), r]));

        let total = 0, worst = null, exact = 0;
        for (let i = 0; i < clips.length; i++) {
          const heard = byId.get(String(i))?.text || '';
          const e = wer(clips[i].text, heard);
          total += e;
          if (e === 0) exact++;
          if (!worst || e > worst.e) worst = { e, said: clips[i].text, heard };
        }
        const avg = total / clips.length;
        const secs = (Date.now() - t0) / 1000;
        rows.push({ label, wer: avg, exact, n: clips.length, secs: secs / clips.length, worst });
        process.stdout.write(`WER ${(avg * 100).toFixed(1)}%  exact ${exact}/${clips.length}  ${(secs / clips.length).toFixed(2)}s/clip`);
      }
    }
  }
}

// ---------------------------------------------------------------- 3. report

console.log('\n\n' + '═'.repeat(78));
console.log('CONFIGURATION'.padEnd(36) + 'WER'.padStart(8) + 'EXACT'.padStart(10) + 'SEC/CLIP'.padStart(12));
console.log('─'.repeat(78));
for (const r of [...rows].sort((a, b) => a.wer - b.wer)) {
  console.log(r.label.padEnd(36)
    + `${(r.wer * 100).toFixed(1)}%`.padStart(8)
    + `${r.exact}/${r.n}`.padStart(10)
    + `${r.secs.toFixed(2)}s`.padStart(12));
}
console.log('═'.repeat(78));

const best = [...rows].sort((a, b) => a.wer - b.wer)[0];
console.log(`\nBest: ${best.label} — ${(best.wer * 100).toFixed(1)}% WER at ${best.secs.toFixed(2)}s a clip.`);
if (best.worst && best.worst.e > 0) {
  console.log(`Its worst phrase (${(best.worst.e * 100).toFixed(0)}% WER):`);
  console.log(`  said : ${best.worst.said}`);
  console.log(`  heard: ${best.worst.heard.trim()}`);
}
console.log('\nSynthesised speech is cleaner than a real microphone, so treat these as');
console.log('RELATIVE scores. Re-run with --degrade for a harsher, more realistic signal.\n');

fs.rmSync(WORK, { recursive: true, force: true });
