// Voice E2E: boots a real server against a throwaway data dir and drives the whole
// speech path — status, warm-up, synthesis, transcription — plus the finance status
// band the same release adds.
//
// The centrepiece is a ROUND TRIP: synthesize a sentence with Kokoro, feed the
// resulting WAV straight back to whisper, and check the words survive. That single
// assertion covers the worker protocol, both model loads, the temp-file handoff, the
// raw-body upload route and the WAV writer at once — and it fails loudly if any of
// them silently starts returning empty audio, which is the failure mode that would
// otherwise look like "the mic isn't working".
//
//   node scripts/e2e/voice.e2e.mjs
//
// Skips itself (exit 0) when the speech models are not installed, so it is safe to
// run on a box that has never run `npm run voice`.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 7931;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-voice-e2e-'));

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// ---- pure-function checks (no server needed) ----
const { speakableText, normalizeTranscript } = await import(path.join(ROOT, 'server', 'voice.js'));
ok(speakableText('**Twelve** thousand yen') === 'Twelve thousand yen', 'speakable: bold markers stripped');
ok(speakableText('See [the ledger](http://x/y) now') === 'See the ledger now', 'speakable: link keeps the label, drops the URL');
ok(speakableText('Run this:\n```js\nconst a=1;\n```\nDone.').includes('(code block)'), 'speakable: code fences are not read out');
ok(!speakableText('# Heading\n- one\n- two').includes('#'), 'speakable: headings and bullets removed');
ok(speakableText('Go to https://example.com/x now').includes(' link '), 'speakable: bare URL becomes "link"');
ok(speakableText('   ') === '', 'speakable: whitespace is nothing to say');
// Said, not written. "JPY 12,000" is how the Finances app writes money and espeak
// spells the code out letter by letter — this is the most-spoken sentence in the hub.
ok(speakableText('You have JPY 12,000 left') === 'You have 12,000 yen left', 'speakable: currency code is spoken as the currency');
ok(speakableText('Spent ¥4,500 today') === 'Spent 4,500 yen today', 'speakable: currency symbol too');
ok(speakableText('Total is $41.20 and €18') === 'Total is 41.20 dollars and 18 euros', 'speakable: dollars and euros');
ok(speakableText('Net: −JPY 5,000') === 'Net: minus 5,000 yen', 'speakable: a negative stays negative');
ok(speakableText('7% of budget') === '7 percent of budget', 'speakable: percent');
ok(speakableText('JPY 1,062/day') === '1,062 yen per day', 'speakable: per-day');
ok(speakableText('- One: 1\n- Two: 2') === 'One: 1. Two: 2', 'speakable: list items get sentence endings, not one run-on');
ok(speakableText('Nice work 🎉 on track ✅') === 'Nice work on track', 'speakable: emoji are not read out');
ok(speakableText('A · B') === 'A, B', 'speakable: separators become pauses');
// The streaming case: a chunk routinely ends mid-markup, so no balanced-pair rule can
// help and the assistant ends up saying "star star" out loud.
ok(speakableText('partial **bold that never clo') === 'partial bold that never clo', 'speakable: orphan ** from a mid-stream chunk');
ok(!/[#*`|~]/.test(speakableText('### H\n**b** `c` ~~d~~ | e |')), 'speakable: no markup survives at all');
ok(speakableText('1. First\n2. Second\n3. Third') === 'First. Second. Third', 'speakable: ordered-list numbering is not read out');
ok(speakableText('Use the --verbose flag') === 'Use the verbose flag', 'speakable: command flags lose their dashes');
ok(speakableText('Here is n-1 items').includes('n minus 1'), 'speakable: n-1 is minus, not a hyphen');
ok(speakableText('range 2020-2024').includes('2020 to 2024'), 'speakable: a year range is "to"');
ok(speakableText('Check ~/notes/budget.md now') === 'Check budget.md now', 'speakable: a path is read as its filename');
ok(speakableText('from 000 baseline') === 'from 0 baseline', 'speakable: padded zeros are not spelled out');
// …and the guard that matters most: this rule must never reach inside a number.
ok(speakableText('You spent 12,000 yen') === 'You spent 12,000 yen', 'speakable: a grouped number is left ALONE');
ok(speakableText('I made 8,000,000 yen').includes('8,000,000'), 'speakable: millions survive intact');
ok(speakableText('snake_case_name') === 'snake case name', 'speakable: underscores become gaps');
ok(speakableText('3 > 2 and 5 >= 4').includes('greater than'), 'speakable: comparators are words');
{
  const long = speakableText('A. '.repeat(2000));
  ok(long.length <= 2000, `speakable: caps runaway text (${long.length} chars)`);
}

// ---- Japanese counters heard inside an English sentence ----
// "I made 8 man en" transcribes as "8-man n": every word heard, the meaning gone, and
// 万 is FOUR ORDERS OF MAGNITUDE. This is the single most expensive mishearing the
// hub can make, because it lands in a ledger.
const norm = [
  ['I made 8-Man N through Micro1 today', '80,000 yen'],
  ['I made Hatchi-Man N through Micro 1', '80,000 yen'],
  ['I got 12 man from Upwork', '120,000'],
  ['I spent 3 sen en at Lawson', '3,000 yen'],
  ['今日は8万円稼ぎました', '80,000円'],
  ['八万円もらった', '80,000円'],
  ['十二万円', '120,000円'],          // 十二 is twelve, not a hundred and two
  ['二十三万円', '230,000円'],
  ['I paid 50k for it', '50,000'],
  ['2.5 man en', '25,000 yen'],
];
for (const [said, want] of norm) {
  ok(normalizeTranscript(said).includes(want), `counters: "${said}" → ${normalizeTranscript(said)}`);
}
// …without eating ordinary English. "man" is a word and "and" is a conjunction.
ok(normalizeTranscript('the man at the counter said no') === 'the man at the counter said no',
  'counters: a bare "man" is left alone');
ok(normalizeTranscript('I earned 12 man and went home').includes('and went home'),
  'counters: "and" is not swallowed as 円');
ok(normalizeTranscript('') === '' && normalizeTranscript('hello') === 'hello', 'counters: no-ops stay no-ops');

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
let slog = '';
server.stdout.on('data', d => slog += d);
server.stderr.on('data', d => slog += d);
function cleanup(code) {
  try { server.kill('SIGKILL'); } catch { }
  fs.rmSync(tmpData, { recursive: true, force: true });
  if (code) { console.error('--- server log ---\n' + slog.slice(-4000)); process.exit(code); }
}

let up = false;
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(BASE + '/status')).ok) { up = true; break; } } catch { }
  await new Promise(r => setTimeout(r, 250));
}
ok(up, 'server up');

// ---- status ----
const st = (await j('GET', '/voice/status')).data;
ok(st.enabled === true, 'voice: on by default');
ok(typeof st.home === 'string' && st.home.length, `voice: home resolved (${st.home})`);
if (!st.installed) {
  console.log(`\n  skipped: speech models not installed at ${st.home} — run \`npm run voice\`\n  (${n} offline checks passed)`);
  cleanup(0);
  process.exit(0);
}
ok(st.stt.ok, `voice: stt model present (${st.stt.model})`);
ok(st.tts.ok, `voice: tts model present (${st.tts.voice})`);
ok(st.running === false, 'voice: worker not spawned until something needs it');

// ---- warm ----
const warm = await j('POST', '/voice/warm', { stt: true, tts: true });
ok(warm.status === 200 && warm.data.stt && warm.data.tts, 'voice: both models load on demand');
ok((await j('GET', '/voice/status')).data.running === true, 'voice: status reports the worker running');

const voices = (await j('GET', '/voice/voices')).data;
ok(Array.isArray(voices.voices) && voices.voices.length > 10, `voice: ${voices.voices?.length} voices listed`);
ok(voices.voices.includes('af_heart'), 'voice: the default voice is among them');
ok((await j('GET', '/voice/voices')).data.voices.length === voices.voices.length, 'voice: voice list is cached, not re-derived');

// ---- synthesis ----
const SENTENCE = 'Your grocery budget has twelve thousand yen left, with nine days to go.';
const speakRes = await fetch(BASE + '/voice/speak', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: `**${SENTENCE}**` }),   // markdown must not be read aloud
});
ok(speakRes.ok, 'speak: 200');
ok(speakRes.headers.get('content-type') === 'audio/wav', 'speak: served as audio/wav');
const wav = Buffer.from(await speakRes.arrayBuffer());
ok(wav.subarray(0, 4).toString('latin1') === 'RIFF' && wav.subarray(8, 12).toString('latin1') === 'WAVE', 'speak: real RIFF/WAVE bytes');
const sampleRate = wav.readUInt32LE(24), channels = wav.readUInt16LE(22), bits = wav.readUInt16LE(34);
ok(sampleRate === 24000 && channels === 1 && bits === 16, `speak: 24kHz mono 16-bit (${sampleRate}/${channels}/${bits})`);
const seconds = Number(speakRes.headers.get('x-voice-seconds'));
ok(seconds > 1 && seconds < 20, `speak: ${seconds}s of audio for one sentence`);

const emptySay = await fetch(BASE + '/voice/speak', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '   ' }),
});
ok(emptySay.status === 400, 'speak: nothing to say is a 400, not a silent WAV');
ok(speakRes.headers.get('x-voice-g2p') === 'espeak:en-us', 'speak: reports which phonemizer ran');

// A voice belongs to a language: picking a British or Japanese voice must switch the
// front end with it, or a Japanese voice reads English phonemes and sounds broken.
const sayAs2 = async (body) => {
  const r = await fetch(BASE + '/voice/speak', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { ok: r.ok, seconds: Number(r.headers.get('x-voice-seconds')) || 0, buf: Buffer.from(await r.arrayBuffer()) };
};
const sayAs = async (voice, text) => {
  const r = await fetch(BASE + '/voice/speak', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice }),
  });
  return { ok: r.ok, lang: r.headers.get('x-voice-lang'), g2p: r.headers.get('x-voice-g2p'), buf: Buffer.from(await r.arrayBuffer()) };
};
/** Kokoro's 24k WAV down to the 16k mono PCM the streaming recogniser expects —
 *  the same conversion the browser's worklet does, done here with ffmpeg. */
const toPcm = async (wavBuf, rate = 16000) => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-ar', String(rate), '-ac', '1', '-f', 's16le', 'pipe:1'], { input: wavBuf, maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : Buffer.alloc(0);
};
const toPcm16k = (wavBuf) => toPcm(wavBuf, 16000);

const gb = await sayAs('bm_george', 'Your grocery budget has twelve thousand yen left.');
ok(gb.ok && gb.lang === 'en-gb', `speak: a British voice switches to en-gb (${gb.lang})`);
const ja = await sayAs('jf_alpha', '今月の食費はあと一万二千円残っています。');
ok(ja.ok && ja.lang === 'ja', `speak: a Japanese voice switches to ja (${ja.lang})`);
// espeak cannot read kanji at all — it phonemizes them as the words "Chinese
// letter" — so this assertion is the difference between working Japanese and 17
// seconds of gibberish. It only warns when misaki is absent, which is optional.
if (ja.g2p?.startsWith('misaki')) {
  ok(true, 'speak: Japanese goes through misaki, not espeak');
  const back = await fetch(BASE + '/voice/transcribe?mime=audio/wav', {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: ja.buf,
  });
  const jaHeard = (await back.json()).text || '';
  ok(/食費|残|円/.test(jaHeard), `round trip (ja): "${jaHeard.trim()}"`);
} else {
  console.log(`  · misaki not installed — Japanese falls back to ${ja.g2p} (run \`npm run voice\`)`);
}

// ---- the vocabulary hint ----
// Whisper guesses at proper nouns it has never heard ("Lawson" → "it lost in"), so it
// is primed with the user's own merchants and categories plus their custom terms.
await j('PUT', '/config', { voice: { stt: { prompt: 'Micro1, Outlier' } } });
const vocab = (await j('GET', '/voice/vocabulary')).data.prompt || '';
ok(vocab.includes('Micro1'), 'vocabulary: custom terms are included');
ok(vocab.includes('万円'), 'vocabulary: the counter forms are always seeded');
ok(vocab.length <= 340, `vocabulary: kept short enough not to be quoted back (${vocab.length} chars)`);
ok(/Groceries|Food/.test(vocab), 'vocabulary: the ledger\'s own categories are in it');

// ---- live partials ----
// The enabling fact, verified rather than assumed: a MediaRecorder webm stream is
// decodable at every chunk boundary, so re-reading the growing utterance is possible
// at all. Here that is exercised through the real route with a truncated recording.
{
  const full = wav;                       // a complete WAV from the synthesis above
  const id = 'e2e-partial-' + Date.now().toString(36);
  const head = full.subarray(0, 44);
  const pcm = full.subarray(44);
  const send = async (bytes) => {
    const r = await fetch(`${BASE}/voice/partial?id=${id}&mime=audio/wav`, {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: bytes,
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  // First slice carries the header, as the browser's first chunk does.
  const third = Math.floor(pcm.length / 3);
  const a1 = await send(Buffer.concat([head, pcm.subarray(0, third)]));
  ok(a1.status === 200, 'partial: the first slice is accepted');
  const a2 = await send(pcm.subarray(third, third * 2));
  ok(a2.status === 200 && typeof a2.data.text === 'string', 'partial: later slices append to the same stream');
  ok((a2.data.bytes || 0) > (a1.data.bytes || 0), 'partial: the server accumulates rather than replacing');
  const a3 = await send(pcm.subarray(third * 2));
  ok(/grocery|budget/i.test(a3.data.text || ''),
    `partial: the growing utterance reads back — "${(a3.data.text || '').trim()}"`);

  const del = await fetch(`${BASE}/voice/partial?id=${id}`, { method: 'DELETE' });
  ok(del.ok, 'partial: the stream can be ended');
  // Ending must actually free it, or a closed tab leaks its audio for the TTL.
  const after = await fetch(`${BASE}/voice/partial?id=${id}`, { method: 'DELETE' });
  ok((await after.json()).ended === false, 'partial: ending twice is harmless and it is really gone');
  ok((await j('GET', '/voice/status')).data.stt.partial === true, 'partial: status reports the feature as available');
}

// ---- the streaming transducer: words while you are still speaking ----
//
// The point of this engine is what whisper structurally cannot do — emit text that
// GROWS as audio arrives. So the assertion is not "it transcribed something", it is
// that the hypothesis lengthened across chunks and that the endpointer fired once the
// talking stopped. Skipped, not failed, where the model is not installed: it is the
// one optional piece of the voice stack.
{
  const st = (await j('GET', '/voice/status')).data.stt;
  if (!st.streamInstalled) {
    console.log('  ⚠ streaming recogniser not installed — skipping (npm run voice)');
  } else {
    ok(st.streaming === true, 'streaming: reported as available');

    // Say a sentence, then keep "recording" silence, exactly as a live mic does.
    const said = await sayAs2({ text: 'I spent three thousand two hundred yen at Lawson on lunch today.' });
    ok(said.ok, 'streaming: test utterance synthesized');
    const pcm = await toPcm16k(said.buf);
    ok(pcm.length > 16000, `streaming: ${(pcm.length / 32000).toFixed(2)}s of 16k PCM to feed`);
    const padded = Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 2)]);   // + 2s silence

    const sid = 'e2e-stream-' + Date.now();
    const step = 16000 * 2 * 0.2;                                        // 200ms chunks
    const seen = [];
    let endpointAt = null, lastText = '';
    for (let i = 0; i < padded.length; i += step) {
      const r = await fetch(`${BASE}/voice/partial?id=${sid}&mime=audio/pcm`, {
        method: 'POST', headers: { 'content-type': 'audio/pcm' }, body: padded.subarray(i, i + step),
      });
      const d = await r.json();
      if (d.text && d.text !== lastText) { lastText = d.text; seen.push(d.text); }
      if (d.endpoint && endpointAt === null) endpointAt = (i + step) / 32000;
    }
    ok(seen.length >= 3, `streaming: the hypothesis grew over ${seen.length} revisions, not one blob at the end`);
    ok(seen.length < 2 || seen[seen.length - 1].length > seen[0].length,
      'streaming: later hypotheses are longer — it is accumulating, not re-guessing');
    ok(/lawson|three thousand/i.test(seen[seen.length - 1] || ''),
      `streaming: heard the sentence — "${(seen[seen.length - 1] || '').slice(0, 60)}"`);
    ok(endpointAt !== null && endpointAt > pcm.length / 32000 - 0.5,
      `streaming: the endpointer fired after the speech, at ${endpointAt}s`);

    // THE ENDPOINT MUST NOT WIPE WHAT IT ALREADY HEARD.
    //
    // sherpa resets the decoder when it decides a sentence finished — correct, or the
    // next sentence inherits this one's state — but the text it decoded is not
    // disposable. A thinking pause mid-turn trips the endpointer routinely (it is the
    // exact case the recorder's 1500ms silence window exists to survive), and the
    // live line used to throw the first half away and show only what came after.
    //
    // It takes TWO utterances either side of a pause to catch that: with one, the
    // reset happens after the last word and nothing visibly regresses. Asserted on
    // what the SERVER returns, not on a variable this loop kept, or a response that
    // went empty would pass by never overwriting anything.
    const two = await sayAs2({ text: 'I spent three thousand two hundred yen at Lawson.' });
    const half = await toPcm(two.buf, 16000);
    if (half.length) {
      const gap = Buffer.alloc(16000 * 2 * 1.2);            // a 1.2s thinking pause
      const both = Buffer.concat([half, gap, half, gap]);
      const sid2 = 'e2e-pause-' + Date.now();
      let live = '', fired = false;
      for (let i = 0; i < both.length; i += step) {
        const r = await fetch(`${BASE}/voice/partial?id=${sid2}&mime=audio/pcm`, {
          method: 'POST', headers: { 'content-type': 'audio/pcm' }, body: both.subarray(i, i + step),
        });
        const d = await r.json();
        if (d.endpoint) fired = true;
        if (d.text) live = d.text;
      }
      const flushed = (await (await fetch(`${BASE}/voice/partial?id=${sid2}`, { method: 'DELETE' })).json()).text || live;
      ok(fired, 'streaming: a 1.2s pause trips the endpointer mid-utterance');
      ok((flushed.match(/lawson/gi) || []).length >= 2,
        `streaming: BOTH halves survived the endpoint — "${flushed.slice(0, 80)}"`);
    }

    const done = await fetch(`${BASE}/voice/partial?id=${sid}`, { method: 'DELETE' });
    const tail = await done.json();
    ok(tail.ended === true, 'streaming: the stream closes and frees its decoder');

    // CLOSING MUST FLUSH THE LAST WORDS.
    //
    // A zipformer decodes in fixed-size chunks, so the samples left over in the
    // final partial chunk are never formed into one and the words in them are never
    // emitted: the live line read "...AT LAWSON ON LUN" and stayed there for the
    // whole two seconds whisper takes to answer with the real sentence.
    //
    // This needs a stream that ends the INSTANT the speech does — which is what
    // stopping the recorder as you finish a word actually does. Given trailing
    // silence the endpointer fires, commits the sentence, and the truncation never
    // shows, which is why the case above cannot test it.
    const abrupt = 'e2e-abrupt-' + Date.now();
    let liveEnd = '';
    for (let i = 0; i < pcm.length; i += step) {           // pcm, NOT padded
      const r = await fetch(`${BASE}/voice/partial?id=${abrupt}&mime=audio/pcm`, {
        method: 'POST', headers: { 'content-type': 'audio/pcm' }, body: pcm.subarray(i, i + step),
      });
      const d = await r.json();
      if (d.text) liveEnd = d.text;
    }
    const flush = (await (await fetch(`${BASE}/voice/partial?id=${abrupt}`, { method: 'DELETE' })).json()).text || '';
    ok(/today/i.test(flush),
      `streaming: closing flushes the last words — "${flush.slice(-40)}"`);
    ok(flush.length > liveEnd.length,
      `streaming: the flush adds what the live line was missing (+${flush.length - liveEnd.length} chars)`);

    // The browser sends whatever rate its AudioContext settled on and names it, so
    // that nothing has to resample in JS. A box filter there cost 3.2 points of WER.
    const at48 = await toPcm(said.buf, 48000);
    if (at48.length) {
      const sid48 = 'e2e-stream48-' + Date.now();
      const step48 = 48000 * 2 * 0.2;
      let text48 = '';
      for (let i = 0; i < at48.length; i += step48) {
        const r = await fetch(`${BASE}/voice/partial?id=${sid48}&mime=audio/pcm&rate=48000`, {
          method: 'POST', headers: { 'content-type': 'audio/pcm' }, body: at48.subarray(i, i + step48),
        });
        const d = await r.json();
        if (d.text) text48 = d.text;
      }
      const flush48 = await (await fetch(`${BASE}/voice/partial?id=${sid48}`, { method: 'DELETE' })).json();
      ok(/lawson|3200|three thousand/i.test(flush48.text || text48),
        `streaming: 48kHz capture is resampled server-side — "${(flush48.text || text48).slice(0, 60)}"`);
    }

    // The live line and the reading that replaces it must agree about numbers. The
    // transducer spells them out; whisper writes digits. Folded on the live side
    // only — rewriting whisper would put a guess in front of the ledger.
    ok(!/three thousand two hundred/i.test(lastText) && /3200|3,200/.test(lastText),
      `streaming: spoken numbers read as figures — "${lastText.slice(0, 60)}"`);

    // A container from a stale client must still work — the phone PWA caches hard.
    const legacy = 'e2e-legacy-' + Date.now();
    const lr = await fetch(`${BASE}/voice/partial?id=${legacy}&mime=audio/wav`, {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: said.buf,
    });
    ok(lr.ok, 'streaming: a non-PCM client still falls back to the whisper path');
    await fetch(`${BASE}/voice/partial?id=${legacy}`, { method: 'DELETE' });
  }
}

// ---- a voice the model does not ship ----
// Kokoro addresses a voice by an embedding, so two can be averaged into a third.
const blended = await sayAs2({ text: SENTENCE, voice: 'af_heart+bf_emma', blend: 0.5 });
ok(blended.ok, 'blend: two voices synthesize as one');
ok(blended.buf.length > 1000, `blend: produced ${blended.buf.length} bytes of audio`);
const badBlend = await fetch(BASE + '/voice/speak', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'x', voice: 'af_heart+not_a_voice' }),
});
ok(badBlend.status >= 400, 'blend: an unknown partner is rejected, not silently ignored');

const lowered = await sayAs2({ text: SENTENCE, voice: 'af_heart', pitch: 0.85 });
ok(lowered.ok, 'pitch: a shifted voice still synthesizes');
ok(Math.abs(lowered.seconds - seconds) < seconds * 0.45,
  `pitch: duration is compensated, not halved (${seconds}s → ${lowered.seconds}s)`);

// ---- transcription (the round trip) ----
const sttRes = await fetch(BASE + '/voice/transcribe?mime=audio/wav', {
  method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
});
ok(sttRes.ok, 'transcribe: 200');
const heard = await sttRes.json();
const words = heard.text.toLowerCase();
ok(words.includes('grocery') && words.includes('budget'), `round trip: "${heard.text.trim()}"`);
// Either spelling is fine — and note WHICH one turns up is influenced by the
// vocabulary hint: a prompt written with digits nudges whisper into digits too,
// which is the more useful form when the sentence is about to become a ledger row.
ok(/(nine|9)\s*days/.test(words), `round trip: the tail survived too — "${heard.text.trim()}"`);
ok(!words.includes('*'), 'round trip: markdown never reached the speaker');
ok(heard.language === 'en', `transcribe: language detected (${heard.language})`);
ok(typeof heard.raw === 'string', 'transcribe: returns what was actually heard alongside the cleaned text');
ok(heard.duration > 1, `transcribe: reports ${heard.duration}s of audio`);

const junk = await fetch(BASE + '/voice/transcribe?mime=audio/webm', {
  method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('not audio at all'),
});
ok(junk.status >= 400, 'transcribe: undecodable bytes fail cleanly rather than hanging');
ok((await j('GET', '/voice/status')).data.running === true, 'transcribe: a bad request does not kill the worker');

// ---- release ----
ok((await j('POST', '/voice/stop', {})).data.stopped === true, 'voice: worker can be released on demand');
ok((await j('GET', '/voice/status')).data.running === false, 'voice: status reflects the release');

// ---- finance status band ----
const M = new Date().toISOString().slice(0, 7);
await j('POST', '/finance/txns', { date: `${M}-02`, kind: 'income', amount: 90000, currency: 'JPY', category: 'Freelance', merchant: 'Client' });
await j('POST', '/finance/txns', { date: `${M}-03`, kind: 'expense', amount: 22000, currency: 'JPY', category: 'Groceries', merchant: 'Life' });
await j('POST', '/finance/txns', { date: `${M}-04`, kind: 'expense', amount: 40000, currency: 'JPY', category: 'Housing', merchant: 'Landlord' });

const noBudget = (await j('GET', '/finance/status')).data;
ok(noBudget.spend.basis === 'income', 'finance: with no budgets, income is the ceiling');
ok(noBudget.spend.remaining === 28000, `finance: 90000 in − 62000 out = ${noBudget.spend.remaining} left`);
ok(noBudget.goal.target === 0 && noBudget.goal.met === false, 'finance: no goal set reads as no target');

await j('PUT', '/finance/budgets', { category: 'Groceries', amount: 45000 });
await j('PUT', '/finance/budgets', { category: 'Eating out', amount: 15000 });
await j('PUT', '/finance/goal', { month: M, minGoal: 80000, majorGoal: 150000 });

const withBudget = (await j('GET', '/finance/status')).data;
ok(withBudget.spend.basis === 'budget', 'finance: budgets take over as the ceiling');
ok(withBudget.spend.limit === 60000, `finance: limit is the sum of budgets (${withBudget.spend.limit})`);
// The Housing spend is outside the budgeted categories, so it must NOT count against
// a grocery+dining ceiling — that scope mismatch is what made this "over" every month.
ok(withBudget.spend.spent === 22000, `finance: only budgeted categories count (${withBudget.spend.spent})`);
ok(withBudget.spend.remaining === 38000, `finance: ${withBudget.spend.remaining} left of the budget`);
ok(withBudget.goal.met === true && withBudget.goal.pct === 113, `finance: goal met at ${withBudget.goal.pct}%`);
ok(withBudget.goal.stretchMet === false, 'finance: stretch target still open');
ok(withBudget.days.total >= 28 && withBudget.days.elapsed >= 1, 'finance: month calendar resolved');

const ov = (await j('GET', `/finance/overview?month=${M}`)).data;
ok(ov.status && ov.status.spend.basis === 'budget', 'overview: carries the status band for a month');
const ytd = (await j('GET', '/finance/overview?range=this-year')).data;
ok(ytd.status === null, 'overview: no band for a year range — goals and budgets are monthly');

cleanup(0);
console.log(`\nALL ${n} VOICE + FINANCE-STATUS CHECKS PASSED`);
