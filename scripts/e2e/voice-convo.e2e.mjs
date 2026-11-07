// The hands-free loop, end to end, with no human in it.
//
// Chromium's microphone is a WAV file of someone asking a question — generated here
// by AIOS's own TTS, so the test carries no fixtures — and the model is a scripted
// mock. The assertion is that Voice mode gets all the way round on its own:
//
//   listening → transcribing → thinking → speaking → listening
//
// This is the only test that exercises the parts no unit test can reach: the browser
// recorder, the silence detector, the level meter, MediaRecorder's container, the
// streaming speaker's chunk pipeline, and the chat WebSocket, all at once. Both bugs
// it caught on the way in were in exactly that seam — a noise floor calibrated on the
// speaker's own first syllable, and a "finished speaking" event that fired between
// sentences and made the loop listen to its own answer.
//
//   node scripts/e2e/voice-convo.e2e.mjs
//
// Skips (exit 0) without Chromium or without the speech models installed.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7953, MPORT = 7954, CDP = 9343;
const BASE = `http://127.0.0.1:${PORT}/api`;
const QUESTION = 'How much is left in my grocery budget this month?';
const REPLY = 'You have twelve thousand yen left in the grocery budget. That is about eight hundred yen a day for the rest of the month.';

const chromeCandidates = [
  process.env.AIOS_CHROME,
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'),
  ...fs.existsSync(path.join(os.homedir(), '.cache/ms-playwright'))
    ? fs.readdirSync(path.join(os.homedir(), '.cache/ms-playwright'))
      .filter(d => d.startsWith('chromium-'))
      .map(d => path.join(os.homedir(), '.cache/ms-playwright', d, 'chrome-linux64', 'chrome'))
    : [],
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
const CHROME = chromeCandidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!CHROME) { console.log('skipped: no Chromium found (set AIOS_CHROME)'); process.exit(0); }

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-convo-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-convo-'));
const micWav = path.join(tmpData, 'mic.wav');

let n = 0, failed = 0;
const ok = (c, label) => { n++; if (!c) { failed++; console.error(`✗ ${label}`); } else console.log(`✓ ${label}`); };

// --- scripted model: streams the reply word by word, like a local model does ---
const prompts = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    try { prompts.push(JSON.parse(raw).messages.filter(m => m.role === 'user').pop()?.content ?? ''); } catch { prompts.push(''); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    for (const w of REPLY.match(/\S+\s*/g)) send({ choices: [{ delta: { content: w }, finish_reason: null }] });
    send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 20 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
mock.listen(MPORT);

// A leftover server from a killed run answers on this port perfectly happily, with
// its own data dir — the assertions then fail in ways that have nothing to do with
// the code. Refuse to start rather than test the wrong process.
try {
  const r = await fetch(BASE + '/status', { signal: AbortSignal.timeout(1500) });
  if (r.ok) { console.error(`\u2717 something is already serving :${PORT} — kill it first (a leftover from an interrupted run)`); process.exit(1); }
} catch { /* nothing there: good */ }

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, AIOS_DATA: tmpData, AIOS_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let slog = ''; server.stdout.on('data', d => slog += d); server.stderr.on('data', d => slog += d);

let chrome = null;
function cleanup(code) {
  try { chrome?.kill('SIGKILL'); } catch { }
  try { server.kill('SIGKILL'); } catch { }
  try { mock.close(); } catch { }
  fs.rmSync(tmpData, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  if (code) console.error('--- server log ---\n' + slog.slice(-3000));
  process.exit(code);
}

for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/status')).ok) break; } catch { } await new Promise(r => setTimeout(r, 250)); }

const st = await (await fetch(BASE + '/voice/status')).json();
if (!st.installed) { console.log(`skipped: speech models not installed at ${st.home}`); cleanup(0); }

await fetch(BASE + '/config', {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    providers: { custom: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${MPORT}/v1`, models: ['m1'] }] },
    defaults: { chatModel: 'mock:m1' },
  }),
});

// Load the speech models before anything is timed. The streaming recogniser is ~300MB
// of ONNX and takes about 3.7s the first time; the worker answers one request at a
// time, so a cold load lands inside whichever assertion happens to go first and makes
// it look like a partials bug. Voice mode does this for itself on open — doing it here
// too means the assertions below measure behaviour rather than one-time loading.
await fetch(BASE + '/voice/warm', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stt: true, tts: true, stream: true }),
}).catch(() => { });

// --- build the microphone track: the question, then silence to end the utterance ---
// Chromium loops the file, so without a trailing gap the silence detector never gets
// a gap to detect. The WAV is edited in place rather than shelling out to ffmpeg:
// appending zero samples and fixing two little-endian length fields is the whole job.
const spoken = Buffer.from(await (await fetch(BASE + '/voice/speak', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: QUESTION }),
})).arrayBuffer());
{
  const dataOff = 44;                                        // canonical 16-bit PCM header
  const rate = spoken.readUInt32LE(24);
  const silence = Buffer.alloc(rate * 2 * 3);                // 3s, mono 16-bit
  const out = Buffer.concat([spoken, silence]);
  out.writeUInt32LE(out.length - 8, 4);                      // RIFF chunk size
  out.writeUInt32LE(out.length - dataOff, 40);               // data chunk size
  fs.writeFileSync(micWav, out);
  ok(out.length > spoken.length, `mic track built from our own TTS (${(out.length / 1024 | 0)}KB, ${rate}Hz)`);
}

// --- browser ---
chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-sandbox', '--disable-gpu', '--window-size=1280,900',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${micWav}`,
  '--autoplay-policy=no-user-gesture-required',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', () => { });

let targets = null;
for (let i = 0; i < 60; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); if (targets.length) break; } catch { }
  await new Promise(r => setTimeout(r, 250));
}
if (!targets?.length) { console.error('✗ chromium did not start'); cleanup(1); }

const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 1 << 28 });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
let id = 0; const waiters = new Map(); const errors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
});
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; waiters.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => {
  const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || 'eval failed').slice(0, 300));
  return r.result?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await wait(3500);
ok(await evalJs('!!window.aios'), 'shell booted');

// --- client-side speech helpers ---
const chunks = await evalJs(`import('/js/voice.js').then(v => ({
  two: v.chunkForSpeech('First sentence here. Second sentence here.').length,
  cjk: v.chunkForSpeech('これは一つ目です。これは二つ目です。').length,
  empty: v.chunkForSpeech('   ').length,
  noPunct: v.chunkForSpeech('word '.repeat(400)).every(c => c.length <= 560),
  firstShort: v.chunkForSpeech('Sure thing. Here is the long part of the answer that follows it.')[0],
  // A naive split on '.' cuts a decimal in half, and because each chunk is
  // synthesized alone the listener hears the halves as separate numbers — or a
  // leading "000" read out digit by digit.
  decimal: v.chunkForSpeech('It cost 1,234.56 yen in total.').length,
  decimalKept: v.chunkForSpeech('It cost 1,234.56 yen in total.')[0],
}))`);
ok(chunks.two === 2, `chunking: two English sentences → ${chunks.two} chunks`);
ok(chunks.cjk === 2, `chunking: Japanese 。 splits too → ${chunks.cjk} chunks`);
ok(chunks.empty === 0, 'chunking: whitespace yields nothing to say');
ok(chunks.noPunct, 'chunking: unpunctuated text is still cut into speakable pieces');
ok(chunks.firstShort === 'Sure thing.', `chunking: a short opener ships on its own → "${chunks.firstShort}"`);
ok(chunks.decimal === 1 && chunks.decimalKept.includes('1,234.56'),
  `chunking: a decimal is never split across chunks → "${chunks.decimalKept}"`);

// The regression that made the hands-free loop talk over itself.
//
// The two halves need OPPOSITE kinds of wait, and getting that wrong made this test
// lie. Proving no false 'idle' arrives BETWEEN sentences is an absence, so it needs a
// fixed observation window. Proving 'idle' arrives once flushed is a presence, and a
// fixed sleep there asserts a DEADLINE nobody meant to set: it allowed 4000ms to
// synthesize and play three sentences, which measured at 6236ms on a box that was
// merely busy — the user's own browser open on the hub was enough. It failed as
// "reports finished (["speaking"])", which reads exactly like the bug it was written
// to catch. Polling keeps the assertion (idle must arrive) and drops the accidental
// stopwatch; a genuine regression still fails it, 20s later.
const states = await evalJs(`(async () => {
  const v = await import('/js/voice.js');
  const seen = [];
  const sp = new v.Speaker({ onState: s => seen.push(s) });
  sp.push('One sentence. ');
  await new Promise(r => setTimeout(r, 2500));      // an absence: a fixed window is right
  const mid = [...seen];
  sp.push('Two sentence. Three.');
  sp.flush();
  const t0 = performance.now(), deadline = t0 + 20000;
  while (performance.now() < deadline && !seen.includes('idle')) {
    await new Promise(r => setTimeout(r, 100));
  }
  return { mid, all: seen, ms: Math.round(performance.now() - t0) };
})()`);
ok(!states.mid.includes('idle'), `speaker: no false "finished" between sentences (${JSON.stringify(states.mid)})`);
ok(states.all.includes('idle'),
  `speaker: reports finished once flushed (${JSON.stringify(states.all)}, ${states.ms}ms)`);

// --- the loop ---
/** Open Voice mode and watch it go round once. Returns the observed phases. */
async function runLoop(speech) {
  await evalJs(`localStorage.setItem('aios.voice.prefs', ${JSON.stringify(JSON.stringify({ handsFree: true, speech }))})`);
  await evalJs(`import('/js/voicemode.js').then(m => m.openVoiceMode())`);
  const seen = [];
  let heard = '', reply = '', turns = 0;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const s = await evalJs(`(() => { const o = document.querySelector('.vm-overlay'); if (!o) return null;
      return { phase: o.dataset.phase, heard: o.querySelector('.vm-heard')?.textContent || '',
        turns: o.querySelectorAll('.vm-turn').length,
        reply: o.querySelector('.vm-turn.is-assistant .vm-turn-text')?.textContent || '' }; })()`);
    if (!s) break;
    if (seen[seen.length - 1] !== s.phase) seen.push(s.phase);
    if (s.heard) heard = s.heard;
    if (s.reply) reply = s.reply;
    turns = Math.max(turns, s.turns);
    if (reply.length > 60 && seen.filter(p => p === 'listening').length >= 2) break;
    await wait(250);
  }
  return { phases: seen, heard, reply, turns };
}

// --- live partials must appear WHILE the sentence is still being spoken ---
// Watched from outside: text that grows during the listening phase, is marked
// provisional, and is then REPLACED by the accurate reading rather than appended to.
{
  await evalJs(`localStorage.setItem('aios.voice.prefs', ${JSON.stringify(JSON.stringify({ handsFree: true, speech: 'off' }))})`);
  await evalJs(`import('/js/voicemode.js').then(m => m.openVoiceMode())`);
  const seen = [];
  for (let i = 0; i < 24 && seen.filter(x => !x.partial).length === 0; i++) {
    const snap = await evalJs(`(() => { const h = document.querySelector('.vm-heard');
      const o = document.querySelector('.vm-overlay');
      return h && o ? { t: h.textContent, partial: h.classList.contains('is-partial'), phase: o.dataset.phase } : null; })()`);
    if (snap?.t && (!seen.length || seen[seen.length - 1].t !== snap.t)) seen.push(snap);
    await wait(400);
  }
  const live = seen.filter(x => x.partial && x.phase === 'listening');
  const settled = seen.find(x => !x.partial);
  ok(live.length >= 1, `partials: text appeared while still listening (${live.length} update${live.length === 1 ? '' : 's'})`);
  if (live.length) console.log(`    first partial: "${live[0].t.slice(0, 50)}"`);
  ok(!!settled, 'partials: replaced by a settled reading');
  if (settled) ok(!settled.t.includes(live[0]?.t || '\u0000') || settled.t.length >= (live[0]?.t.length || 0),
    `partials: the final replaces rather than appends — "${settled.t.slice(0, 50)}"`);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await wait(600);
}

const { phases, heard, reply, turns } = await runLoop('auto');
console.log(`\n  phases: ${phases.join(' → ')}`);
ok(phases[0] === 'listening', 'loop: opens straight into listening');
ok(/grocery/i.test(heard), `loop: heard the spoken question — "${heard}"`);
ok(prompts.some(p => /grocery/i.test(p)), 'loop: the model was asked what was actually said');
ok(phases.includes('speaking'), 'loop: spoke the reply back');
ok(reply.startsWith('You have twelve thousand'), 'loop: the reply reached the transcript');
ok(turns >= 2, `loop: both turns on screen (${turns})`);
ok(phases.filter(p => p === 'listening').length >= 2, 'loop: went back to listening by itself');

// Esc must actually tear the thing down — mic, speaker and overlay.
await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await wait(800);
ok(await evalJs(`!document.querySelector('.vm-overlay')`), 'loop: Esc closes voice mode');
ok(await evalJs(`(async () => { const v = await import('/js/voice.js'); return !v.isSpeaking(); })()`), 'loop: nothing is still talking after close');

// --- a mid-sentence pause must NOT end the turn ---
// The single worst capture bug found so far, and it looks exactly like the model
// mishearing you: at a 1100ms silence window a normal 0.9s thinking pause ended the
// recording, the second half of the sentence was never captured at all, and what came
// back was a confident transcription of half a thought. Measured at 62% WER against
// 38% once the window was widened (scripts/voice-bench.mjs).
{
  const half = 'I made 8 man en through Micro1';
  const rest = 'and about 3000 yen at FamilyMart';
  const a1 = Buffer.from(await (await fetch(BASE + '/voice/speak', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: half }),
  })).arrayBuffer());
  const a2 = Buffer.from(await (await fetch(BASE + '/voice/speak', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: rest }),
  })).arrayBuffer());
  // Stitch: lead-in, first half, a 0.9s thinking pause, second half, trailing silence.
  const rate = a1.readUInt32LE(24);
  const sil = (secs) => Buffer.alloc(Math.round(rate * 2 * secs));
  const body = Buffer.concat([sil(0.35), a1.subarray(44), sil(0.9), a2.subarray(44), sil(3)]);
  const wav = Buffer.concat([a1.subarray(0, 44), body]);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.writeUInt32LE(body.length, 40);
  fs.writeFileSync(micWav, wav);

  await evalJs(`localStorage.setItem('aios.voice.prefs', ${JSON.stringify(JSON.stringify({ handsFree: true, speech: 'off' }))})`);
  const paused = await runLoop('off');
  const heard = paused.heard.toLowerCase();
  ok(/micro/.test(heard), `pause: the first half survived — "${paused.heard}"`);
  ok(/familymart|family mart|3,?000/.test(heard),
    `pause: THE SECOND HALF SURVIVED the thinking pause — "${paused.heard}"`);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await wait(500);
}

// --- muted: the same loop as a dictation-only input method ---
// This is the mode where voice is an input method and nothing more, and the risk is
// specific: the loop is driven by "the speaker finished", so with no speaker to
// finish it can simply stop turning. It has to reach the next listening phase
// without ever entering `speaking`.
const before = prompts.length;
const muted = await runLoop('off');
console.log(`  muted phases: ${muted.phases.join(' → ')}`);
ok(!muted.phases.includes('speaking'), 'muted: never enters the speaking phase');
ok(await evalJs(`(async () => { const v = await import('/js/voice.js'); return !v.isSpeaking(); })()`), 'muted: made no sound');
ok(prompts.length > before, 'muted: still sends what it heard to the model');
ok(muted.reply.length > 20, 'muted: the answer still arrives, on screen');
ok(muted.phases.filter(p => p === 'listening').length >= 2, 'muted: the loop keeps turning without a voice to wait on');

await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await wait(500);

const real = errors.filter(e => !/favicon|manifest|sw\.js/i.test(e));
if (real.length) { console.error('✗ console errors:\n  ' + real.join('\n  ')); failed++; }

console.log(failed ? `\n${failed} of ${n} CHECKS FAILED` : `\nALL ${n} VOICE-CONVERSATION CHECKS PASSED`);
cleanup(failed ? 1 : 0);
