// A hot microphone in a quiet room must produce NO words.
//
// This suite exists because it produced plenty. The live line is driven by a streaming
// zipformer, and a zipformer fed room tone does not sit quiet — it decodes it. Measured
// against the shipped multilingual model, text came back on 6 of 6 speechless clips
// INCLUDING pure digital silence: "SELAMAT 您我们", "こ嗯嗯", "'S 嗯嗯". Worse, the
// endpointer fires on that silence too, and an endpoint COMMITS the segment — so the
// phantom stopped being transient and sat in front of the real sentence. A 2s lead-in
// turned "I SPENT 3200 YEN AT LAWSON…" into "SELAMAT СВОЁ I SPENT 3200 YEN AT LAWSON…".
//
// Whisper never did this — its final pass was clean on all 6 — which is exactly why it
// went unnoticed: the ledger was never wrong, only the screen. The user's report was
// "when the mic is hot it seems to always have some input coming in that doesn't seem
// to have an actual source."
//
// Two gates now stop it, and this suite covers both:
//   - the browser holds audio back until its adaptive noise floor confirms speech,
//     keeping a 400ms pre-roll so the first word still has its onset (voice.js)
//   - the server refuses to feed pre-speech chunks below 0.006 RMS, as a backstop for
//     a cached bundle that predates the first (server/voice.js)
//
// The third assertion is the one that stops the cure being worse: a real sentence must
// still come through whole. Gating too hard would clip the first word, which is a
// quieter and much worse bug than a visible phantom.
//
//   node scripts/e2e/voice-phantom.e2e.mjs
//
// Skips (exit 0) without Chromium or without the streaming model installed.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7991, CDP = 9388;
const BASE = `http://127.0.0.1:${PORT}/api`;
const SENTENCE = 'I spent three thousand two hundred yen at Lawson on lunch today.';

const chromeCandidates = [
  process.env.AIOS_CHROME,
  ...fs.existsSync(path.join(os.homedir(), '.cache/ms-playwright'))
    ? fs.readdirSync(path.join(os.homedir(), '.cache/ms-playwright'))
      .filter(d => d.startsWith('chromium-'))
      .map(d => path.join(os.homedir(), '.cache/ms-playwright', d, 'chrome-linux64', 'chrome'))
    : [],
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
const CHROME = chromeCandidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!CHROME) { console.log('skipped: no Chromium found (set AIOS_CHROME)'); process.exit(0); }

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-phan-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-phan-'));
const micWav = path.join(tmpData, 'mic.wav');

let n = 0, failed = 0;
const ok = (c, label) => { n++; if (!c) { failed++; console.error(`✗ ${label}`); } else console.log(`✓ ${label}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));

try {
  const r = await fetch(BASE + '/status', { signal: AbortSignal.timeout(1500) });
  if (r.ok) { console.error(`✗ something is already serving :${PORT} — kill it first`); process.exit(1); }
} catch { /* free: good */ }

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, AIOS_DATA: tmpData, AIOS_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let slog = ''; server.stdout.on('data', d => slog += d); server.stderr.on('data', d => slog += d);
let chrome = null;
function cleanup(code) {
  try { chrome?.kill('SIGKILL'); } catch { }
  try { server.kill('SIGKILL'); } catch { }
  fs.rmSync(tmpData, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  if (code) console.error('--- server log ---\n' + slog.slice(-2500));
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => cleanup(1));
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/status')).ok) break; } catch { } await wait(250); }

const vs = await (await fetch(BASE + '/voice/status')).json();
if (!vs.installed) { console.log(`skipped: speech models not installed at ${vs.home}`); cleanup(0); }
if (!vs.stt?.streamInstalled) { console.log('skipped: no streaming model installed'); cleanup(0); }

await fetch(BASE + '/voice/warm', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stt: true, tts: true, stream: true }),
}).catch(() => { });

// ---------------------------------------------------------------- the mic track
//
// Chromium LOOPS the fake capture file, so a track of "silence then speech" would be
// entered at an arbitrary phase and the test would be about luck. Room tone alone is
// unambiguous at any offset, and it is precisely the condition being tested.

const RATE = 16000;
function wavOf(samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(b, 44);
  return b;
}
/** `rms` 0..1 of white noise. 0.004 is an ordinary quiet room on a laptop mic. */
function roomTone(sec, rms) {
  const len = Math.round(sec * RATE);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.round((Math.random() * 2 - 1) * rms * 32768);
  return out;
}

fs.writeFileSync(micWav, wavOf(roomTone(12, 0.004)));
ok(true, 'mic track is 12s of room tone at 0.004 RMS — no speech anywhere in it');

chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-sandbox', '--disable-gpu', '--window-size=1280,900',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${micWav}`,
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', () => { });

let targets = null;
for (let i = 0; i < 60; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); if (targets.length) break; } catch { }
  await wait(250);
}
if (!targets?.length) { console.error('✗ chromium did not start'); cleanup(1); }

const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 1 << 28 });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
let id = 0; const waiters = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } });
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; waiters.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => {
  const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    console.error('   eval threw:', String(r.result.exceptionDetails.exception?.description || '').split('\n')[0]);
    return null;
  }
  return r.result?.result?.value;
};

await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await wait(3000);

/**
 * Run one real Recorder for `sec` seconds and report everything it produced.
 *
 * handsFree is OFF so the silence detector cannot end the recording early — the whole
 * point is to hold the microphone open through a long stretch of nothing, which is the
 * state the user described as "hot".
 */
const RUN = (sec) => `(async () => {
  const V = await import('/js/voice.js');
  const partials = [], levels = [];
  const rec = new V.Recorder({
    handsFree: false, streaming: true, streamMs: 200,
    onPartial: (t, o) => partials.push({ t, final: !!(o && o.final) }),
    onLevel: (l) => levels.push(l),
  });
  await rec.start();
  await new Promise(r => setTimeout(r, ${sec} * 1000));
  const spoke = rec.spoke;
  rec.stop();
  await rec.done;
  await new Promise(r => setTimeout(r, 1400));   // let the flush land
  rec.release();
  return {
    partials, spoke,
    maxLevel: levels.length ? Math.max(...levels) : 0,
    avgLevel: levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 0,
  };
})()`;

/**
 * Record until the silence detector ends it, and report what was heard.
 *
 * Tests 1 and 2 hold the microphone open deliberately; this one must not, because the
 * fake capture file LOOPS and a fixed duration straddles the seam — a 7s window over
 * an 8.3s loop reliably caught the tail of one sentence and the head of the next, and
 * read as a phantom ("...TODAY TODAY") when it was really the test wrapping.
 */
const RUN_UNTIL_DONE = () => `(async () => {
  const V = await import('/js/voice.js');
  const partials = [];
  const t0 = performance.now();
  const marks = { firstLoud: 0, shipAt: 0, heldMs: 0 };
  const rec = new V.Recorder({
    handsFree: true, silenceMs: 1200, maxSec: 14, noSpeechSec: 13,
    streaming: true, streamMs: 200,
    onPartial: (t) => partials.push(t),
    onLevel: (l) => { if (l > 0.06 && !marks.firstLoud) marks.firstLoud = performance.now() - t0; },
  });
  // How far back the first shipped burst reaches. The gate can confirm ~700ms after
  // speech starts, so this MUST reach back past the onset — a window measured from
  // "now" instead of from the anchor cuts into the first word and reads as "'S".
  const origDrain = rec._drainPcm.bind(rec);
  rec._drainPcm = function () {
    const had = this._pcmN;
    const out = origDrain();
    if (!marks.shipAt && out && out.length) {
      marks.shipAt = performance.now() - t0;
      marks.heldMs = (had / (this.captureRate || 16000)) * 1000;
    }
    return out;
  };
  await rec.start();
  await rec.done;
  await new Promise(r => setTimeout(r, 1400));
  const spoke = rec.spoke;
  rec.release();
  return { partials, spoke, marks };
})()`;

// ---------------------------------------------------------------- 1. a hot, quiet mic

const quiet = await evalJs(RUN(6));
if (!quiet) { console.error('✗ could not run the recorder'); cleanup(1); }

const texts = (quiet.partials || []).map(p => p.t).filter(t => t && t.trim());
ok(quiet.maxLevel > 0, `the meter saw the room tone (peak ${quiet.maxLevel.toFixed(3)}, mean ${quiet.avgLevel.toFixed(3)})`);
ok(quiet.spoke === false, 'the level meter did NOT call room tone speech');
ok(texts.length === 0,
  texts.length === 0
    ? 'a hot mic in a quiet room produced no words at all'
    : `a hot mic produced phantom text: ${JSON.stringify(texts.slice(0, 4))}`);

// ---------------------------------------------------------------- 2. and on silence

fs.writeFileSync(micWav, wavOf(roomTone(12, 0)));
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?r=2` });
await wait(2500);
const dead = await evalJs(RUN(5));
const deadTexts = (dead?.partials || []).map(p => p.t).filter(t => t && t.trim());
ok(deadTexts.length === 0,
  deadTexts.length === 0
    ? 'digital silence produced no words either'
    : `digital silence produced phantom text: ${JSON.stringify(deadTexts.slice(0, 4))}`);

// ---------------------------------------------------------------- 3. don't over-fix
//
// The gate must not eat the beginning of real speech. A pre-roll is kept precisely so
// the recogniser still gets the onset of the first word; if this fails, the cure is
// worse than the disease — a clipped first word is invisible and permanent, where a
// phantom is at least obvious.

const spokenWav = Buffer.from(await (await fetch(BASE + '/voice/speak', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: SENTENCE }),
})).arrayBuffer());
{
  // Lead-in, the sentence, then a gap — and the whole thing loops, so the recorder
  // always meets quiet before speech no matter where it starts.
  //
  // ROOM TONE, not digital zeros. Zeros are the easy case and passed even while the
  // reported bug was live: the phantom scales with pre-roll length x room LEVEL, and
  // 0.008 RMS is an ordinary quiet room on a laptop mic — the level at which
  // "SELAMAT I SPENT 3200…" was reproduced.
  const rate = spokenWav.readUInt32LE(24);
  const toneBuf = (sec, rms) => {
    const nn = Math.round(sec * rate), b = Buffer.alloc(nn * 2);
    for (let i = 0; i < nn; i++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * rms * 32768), i * 2);
    return b;
  };
  const lead = toneBuf(2, 0.008);
  const tail = toneBuf(3, 0.008);
  const body = Buffer.concat([lead, spokenWav.subarray(44), tail]);
  const out = Buffer.concat([spokenWav.subarray(0, 44), body]);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(body.length, 40);
  fs.writeFileSync(micWav, out);
}
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?r=3` });
await wait(2500);

// Chromium loops the file and capture begins at an arbitrary phase, so a run can
// legitimately open mid-sentence and catch a fragment. Retry until one lands on a
// whole utterance rather than asserting against a coin toss.
// A clean capture is one that STARTS at the start — anything else means capture began
// part-way through the looping sentence, which says nothing about the gate.
const clean = (t) => /^\s*I\s+SPENT\b/i.test(t);
let said = null, best = '';
for (let attempt = 0; attempt < 4 && !clean(best); attempt++) {
  if (attempt) { await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?r=3.${attempt}` }); await wait(2500); }
  said = await evalJs(RUN_UNTIL_DONE());
  const heard = (said?.partials || []).filter(Boolean);
  best = heard.length ? heard[heard.length - 1] : '';
}
ok(said?.spoke === true, 'the meter recognised the synthesized sentence as speech');
ok(/LAWSON/i.test(best), `real speech still transcribes: ${JSON.stringify(best)}`);
// The first word is the one a too-eager gate eats, so it is asserted by name.
ok(/\bI\b/i.test(best) && /SPENT/i.test(best),
  `the first words survived the gate: ${JSON.stringify(best.slice(0, 40))}`);

// The invariant behind that, asserted directly so a regression names itself rather
// than showing up as a mangled first word. A version that took max() against the
// no-anchor fallback looked perfectly healthy — right buffer size, right timings —
// and still cut ~100ms into the speech.
{
  const m = said?.marks || {};
  const reach = m.shipAt - m.heldMs;             // where the first burst starts
  const lead = m.firstLoud - reach;              // how much sits before the speech
  ok(m.firstLoud > 0 && reach < m.firstLoud,
    `the first burst reaches back past the onset (starts ${Math.round(lead)}ms before it)`);
  // Short as well as sufficient: the phantom scales with how much room tone rides
  // along, and 250ms was the largest margin clean at every level measured.
  ok(lead > 0 && lead < 400,
    `and only just — ${Math.round(lead)}ms of lead, so little room tone rides along`);
}

// ---------------------------------------------------------------- 4. the pre-roll size
//
// Asserted against the API with audio built here, because the looping fake microphone
// cannot say where a run started and this needs an exact answer. Both directions
// matter and they pull opposite ways:
//
//   MEASURED, pre-roll of room tone before the sentence: 0/100/200/300/400/600/1000ms
//   all produced ZERO stray words across three runs each. Held-back room tone is not
//   what invents words — nine seconds of it is, which is what the gate now prevents.
//
//   MEASURED, cutting into the onset instead: 50ms was clean, 100ms turned
//   "I SPENT 3200" into "来 1200", and 200ms into "我EN". So a gate that simply
//   discarded pre-speech audio would silently maul the first word of every sentence —
//   a far worse bug than the visible phantom, because nothing on screen would say so.
//
// 400ms sits with a 2.5x margin on the safe side of the first and well clear of the
// second. This check fails if either edge moves.
const wavRate = spokenWav.readUInt32LE(24);
const pcmOf = (buf) => new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
const speechPcm = pcmOf(spokenWav.subarray(44));
const tonePcm = (sec, rms) => {
  const len = Math.round(sec * wavRate);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.round((Math.random() * 2 - 1) * rms * 32768);
  return out;
};
const joinPcm = (...parts) => {
  const total = parts.reduce((a, x) => a + x.length, 0);
  const out = new Int16Array(total); let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
};
async function streamPcm(pcm) {
  const sid = 'phan' + Math.random().toString(36).slice(2, 10);
  const per = Math.round(wavRate * 0.2);
  let last = '';
  for (let o = 0; o < pcm.length; o += per) {
    const sl = pcm.subarray(o, Math.min(o + per, pcm.length));
    const r = await fetch(`${BASE}/voice/partial?id=${sid}&mime=audio%2Fpcm&rate=${wavRate}`, {
      method: 'POST', headers: { 'content-type': 'audio/pcm' },
      body: Buffer.from(sl.buffer, sl.byteOffset, sl.byteLength),
    });
    if (!r.ok) break;
    const j = await r.json();
    if (j.text) last = j.text;
  }
  const d = await fetch(`${BASE}/voice/partial?id=${sid}`, { method: 'DELETE' });
  return ((d.ok ? (await d.json()).text : '') || last).trim();
}
const ALLOWED = new Set('I SPENT THREE THOUSAND TWO HUNDRED 3200 YEN AT LAWSON ON LUNCH TODAY'.split(' '));
const strayWords = (t) => t.toUpperCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').trim()
  .split(/\s+/).filter(Boolean).filter(w => !ALLOWED.has(w));

const withPreroll = await streamPcm(joinPcm(tonePcm(0.4, 0.004), speechPcm));
ok(strayWords(withPreroll).length === 0,
  strayWords(withPreroll).length === 0
    ? '400ms of pre-roll room tone adds no words'
    : `the pre-roll invented words: ${JSON.stringify(strayWords(withPreroll))}`);

const clipped = await streamPcm(speechPcm.subarray(Math.round(wavRate * 0.15)));
ok(!/^\s*I\s+SPENT/i.test(clipped),
  `clipping 150ms of onset DOES damage the first words, so the pre-roll earns its keep: ${JSON.stringify(clipped.slice(0, 34))}`);

console.log(`\n${n - failed}/${n} checks passed`);
cleanup(failed ? 1 : 0);
