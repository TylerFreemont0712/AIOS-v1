// Voice client: microphone in, synthesized speech out.
//
// Shared by the Chat composer, Voice mode, and anything else that wants to be
// spoken to. The server does the actual speech work (server/voice.js) — this file
// is capture, level metering, silence detection, and a playback queue that starts
// talking before the whole reply exists.
//
// ONE ENVIRONMENTAL FACT drives half the error handling here: getUserMedia is only
// available in a secure context. AIOS is served over plain HTTP, so the microphone
// works on http://localhost:7777 and is *missing entirely* from
// http://192.168.x.x:7777 — no permission prompt, no error, `navigator.mediaDevices`
// is simply undefined. That is a browser rule, not something the server can grant,
// so micProblem() names it precisely instead of letting it read as a broken build.

import { get } from './api.js';

// ------------------------------------------------------------------ preferences

const LS = 'aios.voice.prefs';

// `speech` is one setting with three positions rather than two overlapping booleans,
// because "read everything aloud", "only when I ask" and "never speak" are points on
// one axis and the two-flag version let you set contradictions:
//
//   'auto'  every chat reply is read aloud as it streams
//   'ask'   silent until you press a speaker button (the default)
//   'off'   never speaks at all — voice becomes a dictation-only input method,
//           the speaker buttons disappear, and the TTS model is never loaded
//
// voice/speed empty means "whatever the server is configured with"; the per-device
// override exists mainly so a phone can be quieter than the desk.
// How long a gap ends an utterance. MEASURED, not guessed: at 1100ms a normal
// 0.9s mid-sentence pause ended the recording and the second half of the sentence was
// never captured at all — which sounds exactly like the model mishearing you. The
// effective tolerance is shorter than the number, because noise suppression gates a
// pause to digital silence before the tail of your voice has finished decaying.
const SILENCE_MS = 1500;
// What the streaming recogniser is trained on. Asked of the AudioContext so the
// browser resamples the microphone natively instead of anything here doing it badly.
const TARGET_RATE = 16000;
// How much audio from BEFORE speech was confirmed still gets sent.
//
// A streaming zipformer fed room tone does not sit quiet — it decodes it into words.
// Measured against this box's multilingual model: text came back on 6 of 6 speechless
// clips INCLUDING pure digital silence ("SELAMAT 您我们", "こ嗯嗯"). The endpointer
// fires on that silence too, and an endpoint COMMITS its segment, so the phantom was
// not transient — it sat in front of the real sentence, turning "I SPENT 3200 YEN…"
// into "SELAMAT СВОЁ I SPENT 3200 YEN…".
//
// So audio is held until the meter confirms speech. The length of what is still sent
// is set by two constraints pulling opposite ways, and BOTH were mis-measured once:
//
// 1. Too long and the phantom survives. The first sweep fed leading silence in
//    uniform 200ms chunks and found no strays out to 3000ms — but that is not what
//    the browser does. It releases the whole held window as ONE burst when the gate
//    opens, and re-measured that way the phantom scales with length x room level:
//
//      room tone   400ms  600ms  800ms  1200ms  2000ms   (stray words / 4 runs)
//      0.004 RMS       0      0      4       5       4
//      0.008 RMS       0      2      4       4       4   <- "SELAMAT I SPENT 3200…"
//      0.013 RMS       4      4      4       4       4
//
//    At short margins, 6 runs each, silence through 0.020 RMS: 250ms and below was
//    clean at EVERY level. 300ms strayed at 0.020, 400ms at 0.013.
//
// 2. Too short and the first word is eaten. `spoke` is not set when you start
//    talking: the gate wants 150ms sustained, and a soft word-initial vowel crosses,
//    dips, and restarts that timer. Measured in a real browser on "I spent three
//    thousand…": speech at 2103ms, `spoke` at 2777ms — 674ms late. A fixed 400ms
//    window could not reach back that far and transcribed "'S SPENT 3200…". That is
//    the worse bug of the two, because nothing on screen says a word went missing.
//
// A fixed window ending at "now" cannot satisfy both — 250ms is required by (1) and
// ~700ms by (2). The way out is to stop measuring from now: the window is cut from
// where speech ACTUALLY began (the anchor recorded in _meter()), so the pre-speech
// audio is always ~250ms however late the confirmation lands.
const ONSET_MARGIN_MS = 250;
// How long the level must sit below the gate before a recorded onset is forgotten.
// Longer than a dip inside a phrase — otherwise the pause between "I" and "spent"
// moves the anchor onto the second word — and short enough that a keyboard tap a
// second ago cannot anchor the window back to itself.
const ONSET_FORGET_MS = 350;
// Bound on the held buffer when there is no anchor to cut to. Not normally reachable:
// `spoke` requires a gate crossing and a crossing records an anchor.
const PREROLL_CAP_MS = 400;
// Absolute ceiling on the hold. Only bites if an anchor goes stale without being
// forgotten; it must stay well clear of the ~700ms the confirmation can lag by, or it
// would clip the first word exactly the way a short fixed window did.
const MAX_HOLD_MS = 3000;

const SPEECH_MODES = ['auto', 'ask', 'off'];
const DEFAULT_PREFS = { speech: 'ask', handsFree: true, dictateSend: false, cues: true, silenceMs: 0, voice: '', speed: 0 };

export function prefs() {
  let p;
  try { p = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(LS) || '{}') }; }
  catch { p = { ...DEFAULT_PREFS }; }
  if (!SPEECH_MODES.includes(p.speech)) p.speech = DEFAULT_PREFS.speech;
  return p;
}

/** Is this device allowed to make any sound at all? */
export const speechOn = () => prefs().speech !== 'off';
/** Should replies be read without being asked? */
export const speechAuto = () => prefs().speech === 'auto';
export function setPrefs(patch) {
  const next = { ...prefs(), ...patch };
  try { localStorage.setItem(LS, JSON.stringify(next)); } catch { /* private mode */ }
  document.dispatchEvent(new CustomEvent('aios:voiceprefs', { detail: next }));
  return next;
}

// ----------------------------------------------------------------------- status

let statusCache = null, statusAt = 0, statusInflight = null;

/** Server-side voice status, cached briefly — several widgets ask on mount. */
export async function voiceStatus({ fresh = false } = {}) {
  if (!fresh && statusCache && Date.now() - statusAt < 20_000) return statusCache;
  if (statusInflight) return statusInflight;
  statusInflight = get('/voice/status')
    .then((s) => { statusCache = s; statusAt = Date.now(); return s; })
    // A failed probe is NOT "voice is off". The usual cause is a server that predates
    // the voice routes and has not been restarted, and reporting that as "off" makes
    // every voice control quietly disappear with no way to find out why. `unknown`
    // lets the UI keep its buttons and say what is actually wrong when one is used.
    .catch(() => statusCache || { enabled: true, installed: false, unknown: true, stt: {}, tts: {} })
    .finally(() => { statusInflight = null; });
  return statusInflight;
}
export const invalidateVoiceStatus = () => { statusCache = null; statusAt = 0; };

/** Why the mic is unavailable, in the user's terms — or '' when it should work. */
export function micProblem() {
  if (navigator.mediaDevices?.getUserMedia) return '';
  if (!window.isSecureContext) {
    return `The microphone needs a secure page. Open AIOS at http://localhost:${location.port || 7777} `
      + 'on this machine, or allow this origin under chrome://flags/#unsafely-treat-insecure-origin-as-secure.';
  }
  return 'This browser does not expose a microphone.';
}
export const micSupported = () => !micProblem();

// How many bars the visualiser draws. Speech lives roughly between 80Hz and 6kHz, so
// the bins are grouped on a log-ish curve rather than linearly — a linear split puts
// almost every bar in frequencies a human voice never reaches, and they sit dead.
export const BANDS = 28;
function fillBands(freq, out) {
  const n = freq.length;
  for (let i = 0; i < out.length; i++) {
    const lo = Math.floor(Math.pow(i / out.length, 1.7) * n * 0.42);
    const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / out.length, 1.7) * n * 0.42));
    let sum = 0;
    for (let k = lo; k < hi && k < n; k++) sum += freq[k];
    out[i] = (sum / (hi - lo)) / 255;
  }
  return out;
}

/** The container this browser can actually record. Safari only does mp4/aac. */
function pickMime() {
  const wanted = [
    'audio/webm;codecs=opus', 'audio/webm',
    'audio/ogg;codecs=opus', 'audio/ogg',
    'audio/mp4;codecs=mp4a.40.2', 'audio/mp4',
  ];
  for (const m of wanted) { if (window.MediaRecorder?.isTypeSupported?.(m)) return m; }
  return '';
}

// ------------------------------------------------------------------- recording

/**
 * One microphone session.
 *
 * `onLevel(rms01)` fires ~30x/s for the meter. In hands-free mode the recorder ends
 * itself once you stop talking; `onAuto('silence'|'timeout'|'nospeech')` says why, so
 * the caller can tell "you finished a sentence" apart from "you never started".
 *
 * The silence threshold is calibrated against the room rather than hard-coded: a
 * fixed cut-off either never fires next to a desktop fan or fires mid-sentence in a
 * quiet room. See _meter() for how the floor is estimated — continuously, and
 * emphatically not from the opening moments of the recording.
 */
export class Recorder {
  constructor({
    onLevel, onAuto, handsFree = true, silenceMs = SILENCE_MS, maxSec = 60, noSpeechSec = 9,
    // Capture settings, measurable rather than assumed — see scripts/voice-bench.mjs.
    bitrate = 64000, noiseSuppression = true, autoGainControl = true, echoCancellation = true,
    // Live text while you are still talking. Opt-in: pass a callback and the recorder
    // ships the bytes as they arrive. Purely additive — the final transcription takes
    // exactly the same path whether this is on or off.
    onPartial = null, partialMs = 1100,
    // Streaming: ship raw 16k PCM every `streamMs` to a transducer that keeps its
    // decode state, instead of re-uploading containers for whisper to re-read. Words
    // then appear as they are spoken rather than a second at a time. `onEndpoint`
    // fires when the recogniser decides the sentence finished, which is a better
    // end-of-turn signal than the loudness timer because it knows what it decoded.
    streaming = false, streamMs = 200, onEndpoint = null,
  } = {}) {
    Object.assign(this, {
      onLevel, onAuto, handsFree, silenceMs, maxSec, noSpeechSec,
      bitrate, noiseSuppression, autoGainControl, echoCancellation,
      onPartial, partialMs, streaming, streamMs, onEndpoint,
    });
    this._pcm = [];          // float32 blocks at the context rate, awaiting a ship
    this._pcmN = 0;
    this._pcmTotal = 0;      // every sample ever tapped — the clock the onset is in
    this._onsetSamples = 0;  // _pcmTotal when this talk-spurt first crossed the gate
    this._tap = null;
    this.captureRate = TARGET_RATE;   // settled once the context exists
    this.streamId = onPartial ? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : '';
    this._sent = 0;          // chunks already shipped
    this._inFlight = false;
    this.state = 'idle';       // idle | recording | stopping | done
    this.spoke = false;
    this._chunks = [];
    // `done` settles however the recording ends — the silence detector, the length
    // cap, the caller's stop button, or abort() — which is the only thing a caller
    // driving a hands-free loop can sensibly await. Resolves null if it was aborted.
    this.done = new Promise((res) => { this._finish = res; });
  }

  async start() {
    const problem = micProblem();
    if (problem) throw new Error(problem);
    if (this.state !== 'idle') throw new Error('already recording');

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // The browser's cleanup is tuned for a human listener on a call, not for a
        // speech recogniser, so these are settings rather than assumptions.
        echoCancellation: this.echoCancellation,
        noiseSuppression: this.noiseSuppression,
        autoGainControl: this.autoGainControl,
        channelCount: 1,
      },
    });

    // STOPPED WHILE THE DEVICE WAS STILL OPENING.
    //
    // getUserMedia is a round trip — a permission prompt the first time, tens of
    // milliseconds after that — and every control that ends a recording can be
    // pressed inside that window: a second click on the mic button, Pause, the Mode
    // dialog, closing the overlay. Without this check the recorder carries on and
    // opens the microphone anyway, and because nothing is waiting on the result the
    // browser's recording indicator simply stays lit with no way to turn it off.
    //
    // `state` is the truth rather than a flag of its own: stop() and abort() both
    // move it off 'idle' before this resumes.
    if (this.state !== 'idle') {
      try { this.stream.getTracks().forEach(t => t.stop()); } catch { /* already gone */ }
      this.stream = null;
      return this;
    }

    const mime = pickMime();
    // 64kbps mono opus, not 32: at 32 the codec starts trading away exactly the
    // high-frequency detail that separates one consonant from another, and a ten
    // second utterance is 80KB either way over a LAN.
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: this.bitrate } : undefined);
    this.mime = this.rec.mimeType || mime || 'audio/webm';
    this._chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data?.size) this._chunks.push(e.data); };

    this._blob = new Promise((resolve) => { this.rec.onstop = () => resolve(new Blob(this._chunks, { type: this.mime })); });
    this.rec.start(250);      // periodic chunks so a crash still leaves usable audio
    this.state = 'recording';
    this.startedAt = Date.now();
    this._meter();
    if (this.onPartial) {
      this._startPartials();
      // The tap can fail (no AudioWorklet, a blocked module fetch) and the fallback
      // has to reset the CADENCE as well as the engine: 200ms is right for a
      // transducer that costs 14ms a chunk and far too fast for a whisper pass that
      // costs 700ms, which would otherwise run back-to-back for the whole utterance.
      if (this.streaming) {
        this._openTap().catch(() => {
          this.streaming = false;
          if (this.state === 'recording') this._startPartials();
        });
      }
    }
    return this;
  }

  _meter() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      // Ask for the rate the recogniser wants and let the BROWSER resample, in
      // native code, with a real resampler. The alternative — capture at 48k and
      // average blocks down in JS — is a box filter, which is barely a low-pass:
      // measured against sherpa's own resampler on 32 clips it cost 3.2 points of
      // word error, aliasing exactly the high-frequency detail that separates one
      // consonant from another. A device that refuses the rate falls back to its
      // own, and the samples are shipped at that rate instead (see _drainPcm).
      try { this.ctx = new Ctx({ sampleRate: TARGET_RATE }); }
      catch { this.ctx = new Ctx(); }
      const src = this.ctx.createMediaStreamSource(this.stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0.6;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      // A frequency spectrum as well as a level: the visualiser draws bars from it,
      // and a bar chart that actually tracks what you are saying reads as alive in a
      // way a single pulsing number never does.
      const freq = new Uint8Array(an.frequencyBinCount);
      const bands = new Float32Array(BANDS);

      // The noise floor is ESTIMATED CONTINUOUSLY, not sampled at the start.
      //
      // The obvious version — average the first 400ms and call that the room — is
      // wrong in the exact case a hands-free loop creates: the assistant stops
      // talking, you answer straight away, and your own first syllable becomes the
      // "room noise". The gate then sits at three times your speaking level and
      // nothing you say ever registers. Measured against a 0.17-RMS recording it
      // detected no speech at all.
      //
      // Instead the floor chases quiet frames quickly and loud ones barely, and stops
      // moving once speech is confirmed so a long sentence cannot raise the gate over
      // itself mid-word. The absolute cap matters too: sustained room noise above
      // ~0.06 RMS is rare, while speech is routinely 0.05–0.3, so refusing to raise
      // the gate past it keeps a noisy room from swallowing a quiet talker.
      let floor = 0.006, quietSince = 0, loudSince = 0;
      const tick = () => {
        if (this.state !== 'recording') return;
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now(), age = now - this.startedAt;

        const gate = Math.min(0.06, Math.max(0.014, floor * 3.2));
        if (!this.spoke) floor = rms < floor ? floor * 0.85 + rms * 0.15 : floor * 0.97 + rms * 0.03;

        an.getByteFrequencyData(freq);
        fillBands(freq, bands);
        this.onLevel?.(Math.min(1, rms / 0.25), bands);

        if (rms > gate) {
          quietSince = 0;
          if (!loudSince) loudSince = now;
          // WHERE the talk-spurt began, in samples — the anchor the pre-roll is cut
          // to. Recorded on the FIRST crossing and deliberately not moved by the
          // confirmation 150ms later, because those are different instants: a soft
          // word-initial vowel ("I spent…") crosses, dips below, and restarts the
          // sustain timer, so `spoke` can land most of a second after the sentence
          // actually started. Anchoring on confirmation would cut the first word off.
          if (!this._onsetSamples) this._onsetSamples = this._pcmTotal;
          // 150ms above the gate before it counts, so a keyboard tap is not "speech"
          if (!this.spoke && now - loudSince > 150) this.spoke = true;
        } else {
          loudSince = 0;
          if (!quietSince) quietSince = now;
          // Let a stale anchor go, but only after a gap longer than the dip inside a
          // phrase — otherwise the pause between "I" and "spent" moves the anchor to
          // the second word, which is the thing this whole mechanism exists to avoid.
          if (!this.spoke && now - quietSince > ONSET_FORGET_MS) this._onsetSamples = 0;
        }

        if (this.handsFree && age > 400) {
          if (this.spoke && quietSince && now - quietSince > this.silenceMs) return this._auto('silence');
          if (!this.spoke && age > this.noSpeechSec * 1000) return this._auto('nospeech');
        }
        if (age > this.maxSec * 1000) return this._auto('timeout');
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    } catch {
      // No AudioContext: recording still works, it just cannot end itself. The
      // caller's stop button is the fallback, so this is not worth failing over.
      this.spoke = true;
    }
  }

  /**
   * Send everything recorded since last time and show what it adds up to.
   *
   * Only the NEW chunks go up — the server keeps the running concatenation, so this
   * costs one chunk's worth of bytes per pass rather than re-uploading the whole
   * utterance every second.
   *
   * Nothing here is allowed to matter: one request in flight at a time, silence
   * before speech is skipped entirely, and every failure is swallowed. A partial that
   * does not arrive costs a moment of missing feedback; a partial that throws would
   * cost the recording.
   */
  async _shipPartial() {
    if (this._inFlight || this.state !== 'recording') return;

    // Nothing is sent until the meter confirms speech — see ONSET_MARGIN_MS. Streaming
    // used to ship PCM from the very first block on the grounds that the recogniser
    // needs the leading audio and its endpointer wants the surrounding silence. The
    // first half is true and is why a pre-roll is kept rather than discarded; the
    // second half was a mistake, because a zipformer decodes room tone into words and
    // the endpoint it then fires COMMITS them in front of the real sentence.
    //
    // Trailing silence is unaffected: once `spoke` is set every block goes, which is
    // what the endpointer actually needs. The container path waits for speech too,
    // because re-decoding silence with whisper is pure cost.
    //
    // PCM when the tap is producing it, containers otherwise — decided per pass, not
    // once at startup. A tap that opens but delivers nothing (a suspended
    // AudioContext, a muted device) would otherwise silently kill live text
    // altogether, which is worse than the slower engine it replaced.
    let body, mime, rate = 0;
    let pcm = null;
    if (this.streaming && this._tap) {
      if (this.spoke) pcm = this._drainPcm();
      else this._holdPreroll();
    }
    if (pcm?.length) {
      body = pcm.buffer; mime = 'audio/pcm'; rate = this.captureRate;
    } else {
      if (!this.spoke) return;
      const fresh = this._chunks.slice(this._sent);
      if (!fresh.length) return;
      this._sent = this._chunks.length;
      body = new Blob(fresh, { type: this.mime }); mime = this.mime;
    }

    this._inFlight = true;
    try {
      const token = localStorage.getItem('aios.token') || '';
      const headers = { 'content-type': mime || 'application/octet-stream' };
      if (token) headers.authorization = 'Bearer ' + token;
      const r = await fetch(`/api/voice/partial?id=${encodeURIComponent(this.streamId)}&mime=${encodeURIComponent(mime)}`
        + (rate ? `&rate=${rate}` : ''), { method: 'POST', headers, body });
      if (!r.ok) return;
      const j = await r.json();
      // A partial that lands after the recording stopped is worse than no partial:
      // it would overwrite the finished transcription with a rougher guess.
      if (this.state !== 'recording') return;
      if (j.text) this.onPartial?.(j.text);
      // The recogniser heard the sentence end. Reported rather than acted on here —
      // the hands-free loop decides whether that should stop the recording, because
      // only it knows if the user is mid-turn.
      if (j.endpoint) this.onEndpoint?.(j.text || '');
    } catch { /* feedback only */ }
    finally { this._inFlight = false; }
  }

  /** (Re)arm the partial interval at the cadence the current engine wants. */
  _startPartials() {
    clearInterval(this._partialTimer);
    this._partialTimer = setInterval(() => this._shipPartial(), this.streaming ? this.streamMs : this.partialMs);
  }

  /**
   * Open the microphone tap that feeds the streaming recogniser.
   *
   * Hangs off the AudioContext the level meter already built, rather than a second
   * one: two contexts on one device is twice the graph and an easy way to get the
   * two of them fighting over the same input. Failure here is deliberately soft —
   * `streaming` goes false, the interval keeps running, and the shipper falls back
   * to sending containers for whisper. Worse feedback, never no recording.
   */
  async _openTap() {
    if (!this.ctx || !this.ctx.audioWorklet) throw new Error('no audio worklet');
    // A context created outside a user gesture starts suspended, and a suspended
    // graph never calls the processor — the tap would look connected and deliver
    // nothing at all.
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch { } }
    await this.ctx.audioWorklet.addModule('/js/voice-worklet.js');
    if (this.state !== 'recording') return;               // stopped while loading
    const src = this.ctx.createMediaStreamSource(this.stream);
    // Whatever the context settled on — the rate asked for, or the device's own.
    this.captureRate = Math.round(this.ctx.sampleRate) || TARGET_RATE;
    this._tap = new AudioWorkletNode(this.ctx, 'pcm-tap');
    this._tap.port.onmessage = (e) => {
      if (this.state !== 'recording') return;
      this._pcm.push(e.data);
      this._pcmN += e.data.length;
      this._pcmTotal += e.data.length;
    };
    // Web Audio pulls the graph BACKWARDS from the destination, so a node with
    // nothing downstream is never rendered and its process() is never called — the
    // tap looks perfectly connected and delivers not one sample. (Built that way
    // first; the browser e2e caught it.) The fix is to give it somewhere to go, and
    // a gain of exactly 0 is what keeps the microphone out of the speakers on the
    // way — this path is a pull, not a monitor.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(this._tap);
    this._tap.connect(mute);
    mute.connect(this.ctx.destination);
    this._mute = mute;
  }

  /**
   * The captured blocks as one mono Int16 buffer, at whatever rate the context runs.
   *
   * There is deliberately no resampling here any more. This used to average blocks
   * down to 16k — a box filter, which is a poor low-pass, and measurably so: 3.2
   * points of word error against a proper one. Resampling well in JS means owning a
   * windowed-sinc kernel; resampling badly costs accuracy on every utterance. Both
   * are avoidable, because the AudioContext is asked for 16kHz up front and sherpa
   * resamples anything else in C++. The rate travels with the bytes.
   */
  /**
   * Before speech: keep only what sits just before the onset, and send nothing.
   *
   * Cut from the ANCHOR rather than from now. The buffer would otherwise hold a fixed
   * window ending at this instant, and since the gate can confirm most of a second
   * after the sentence began, a window long enough to still contain the first word is
   * also long enough to carry a phantom — measured, the two constraints have no
   * overlap. Cutting to `_onsetSamples - ONSET_MARGIN_MS` satisfies both: the pre-
   * speech audio handed to the recogniser is always ~250ms no matter how late the
   * confirmation, and the first word is always inside it.
   *
   * Sample counts, not timestamps: the tap's clock and Date.now() drift apart, and
   * this has to be exact to a couple of blocks at the point it matters.
   */
  _holdPreroll() {
    if (!this._pcmN) return;
    const rate = this.captureRate || TARGET_RATE;
    const ms = (n) => Math.round(rate * n / 1000);
    // Absolute index of the first sample worth keeping.
    //
    // The anchor WINS when there is one. Writing this as a max() against the fallback
    // was the first attempt and it silently defeated the whole mechanism: the onset is
    // routinely further back than the fallback window, so the max() picked the
    // fallback every time and the cut landed ~100ms INSIDE the speech. It still looked
    // like it worked — the buffer was the expected size — and the first word came out
    // as "'S". The fallback is for having no anchor at all, nothing else.
    const want = this._onsetSamples
      ? this._onsetSamples - ms(ONSET_MARGIN_MS)
      : this._pcmTotal - ms(PREROLL_CAP_MS);
    // An absolute ceiling on the hold, so a stale anchor cannot pin the buffer open.
    const bounded = Math.max(want, this._pcmTotal - ms(MAX_HOLD_MS));
    let drop = bounded - (this._pcmTotal - this._pcmN);
    if (drop <= 0) return;
    while (drop > 0 && this._pcm.length && this._pcm[0].length <= drop) {
      const b = this._pcm.shift();
      drop -= b.length;
      this._pcmN -= b.length;
    }
    // Part of a block: 128 samples is 8ms, which is worth being right about when the
    // whole margin is 250.
    if (drop > 0 && this._pcm.length) {
      this._pcm[0] = this._pcm[0].subarray(drop);
      this._pcmN -= drop;
    }
  }

  _drainPcm() {
    if (!this._pcmN) return null;
    const flat = new Float32Array(this._pcmN);
    let o = 0;
    for (const b of this._pcm) { flat.set(b, o); o += b.length; }
    this._pcm = []; this._pcmN = 0;

    const out = new Int16Array(flat.length);
    for (let i = 0; i < flat.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, Math.round(flat[i] * 32768)));
    }
    return out;
  }

  /**
   * Close the utterance out: ship what is left, then let the server go.
   *
   * Two things here are not tidying-up. The last drain matters because up to one
   * whole interval of audio — 200ms, routinely the final syllable — is sitting in
   * `_pcm` when the recording stops and was simply being discarded. And the DELETE
   * reply matters because that is where the server flushes the recogniser: a
   * zipformer decodes in fixed chunks and never emits the words in the last partial
   * one, so the live line read "...AT LAWSON ON LUN" for the whole two seconds
   * whisper takes to answer with the real sentence. Both are best-effort; a tail
   * that never arrives costs a moment of a short line, and nothing else.
   */
  _endPartial() {
    clearInterval(this._partialTimer);
    this._partialTimer = null;
    const id = this.streamId;
    if (!id) return;
    this.streamId = '';
    // Drained NOW, synchronously: release() clears the buffer and closes the context
    // on the next line, so anything read later is already gone.
    //
    // Still gated on `spoke`. A recording that ended because nobody said anything
    // ('nospeech', or a stop button pressed by mistake) holds nothing but the
    // pre-roll, and sending it here would hand the recogniser a last mouthful of room
    // tone to turn into words — the phantom line this whole gate exists to stop,
    // arriving at the one moment it is guaranteed to be the only thing on screen.
    const last = this.spoke && this.streaming && this._tap ? this._drainPcm() : null;
    const rate = this.captureRate;
    const token = localStorage.getItem('aios.token') || '';
    const auth = token ? { authorization: 'Bearer ' + token } : {};
    const url = `/api/voice/partial?id=${encodeURIComponent(id)}`;

    (async () => {
      if (last?.length) {
        await fetch(`${url}&mime=audio%2Fpcm&rate=${rate}`,
          { method: 'POST', headers: { ...auth, 'content-type': 'audio/pcm' }, body: last.buffer })
          .catch(() => { });
      }
      // keepalive so it still goes out if the page is closing.
      const r = await fetch(url, { method: 'DELETE', headers: auth, keepalive: true }).catch(() => null);
      if (!r?.ok) return;
      const j = await r.json().catch(() => null);
      // Flagged `final` so a caller that hides live text once it stops listening can
      // still take this one — it is the complete sentence, not another guess.
      if (j?.text) this.onPartial?.(j.text, { final: true });
    })();
  }

  _auto(reason) {
    this._autoReason = reason;
    this.stop();
    this.onAuto?.(reason);
  }

  /** Ends capture and resolves to the recorded Blob (also available as .result). */
  stop() {
    // Pressed before the device finished opening: there is no recording to keep, so
    // this is an abort rather than a stop — and it moves `state` off 'idle', which
    // is what start() checks when it resumes. Without it the click was swallowed
    // (stop() returned early, start() went on to open the mic) and the button was
    // left showing a recording the user had already cancelled.
    if (this.state === 'idle') { this.abort(); return this.done; }
    if (this.state !== 'recording') return this.done;
    this.state = 'stopping';
    cancelAnimationFrame(this._raf);
    try { this.rec.stop(); } catch { /* already stopped */ }
    this.result = this._blob.then((b) => { this.state = 'done'; this._finish(b); return b; });
    this.release();
    return this.done;
  }

  /** Drop the mic (and the browser's recording indicator) as soon as we are done. */
  release() {
    cancelAnimationFrame(this._raf);
    this._endPartial();
    // Stop the worklet before the context goes: a processor still returning true
    // keeps the graph alive and the browser's recording indicator lit.
    try { this._tap?.port.postMessage('stop'); this._tap?.disconnect(); this._mute?.disconnect(); } catch { }
    this._tap = null; this._mute = null; this._pcm = []; this._pcmN = 0;
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch { }
    try { this.ctx?.close(); } catch { }
    this.ctx = null;
    this.onLevel?.(0);
  }

  /** Throw the recording away — used when the user cancels mid-sentence. */
  abort() {
    this.state = 'stopping';
    try { this.rec?.stop(); } catch { }
    this.release();
    this.state = 'done';
    this._chunks = [];
    this._finish(null);
  }
}

/** Send a recording for transcription. Resolves to { text, language, ms, … }. */
export async function transcribe(blob, { language } = {}) {
  if (!blob?.size) throw new Error('nothing was recorded');
  const qs = new URLSearchParams({ mime: blob.type || 'audio/webm' });
  if (language) qs.set('language', language);
  const token = localStorage.getItem('aios.token') || '';
  const headers = { 'content-type': blob.type || 'application/octet-stream' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch('/api/voice/transcribe?' + qs, { method: 'POST', headers, body: blob });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

// -------------------------------------------------------------------- speaking

// Sentence-at-a-time is what makes a reply start being spoken in under a second
// instead of after the model has finished writing it. These bounds keep chunks long
// enough to carry prosody and short enough that the first one is quick.
//
// The FIRST chunk gets a much lower bar than the rest, because it alone decides how
// long the silence before the answer is. Synthesis time tracks output length, so
// shipping a short opening sentence on its own is time-to-first-word bought cheaply;
// everything after it is already playing behind audio, where a longer chunk reads
// better and costs nothing.
const FIRST_CHUNK = 10, MIN_CHUNK = 40, MAX_CHUNK = 260;

// A CJK character carries far more of a sentence than a Latin one, so a 40-character
// minimum that is sensible in English is a paragraph in Japanese. Counting them
// double is crude but it puts the two languages in the same ballpark.
const weigh = (s) => s.length + (s.match(/[　-鿿＀-￯]/g)?.length || 0);

/**
 * Sentence boundaries — the careful version.
 *
 * A naive split on [.!?] cuts "1,234.56" in half, and since each chunk is synthesized
 * on its own the listener hears "one thousand two hundred and thirty four" then
 * "fifty six" — or worse, a leading "000" read out as "zero zero zero". A full stop
 * only ends a sentence when it is NOT between two digits and IS followed by space or
 * end of text.
 */
function splitSentences(clean) {
  const out = [];
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (!'.!?…。！？'.includes(ch)) continue;
    if (ch === '.' && /\d/.test(clean[i - 1] || '') && /\d/.test(clean[i + 1] || '')) continue;
    let j = i + 1;
    while (j < clean.length && '."\')]»”'.includes(clean[j])) j++;   // trailing quotes/brackets
    // "a full stop is followed by a space" is a rule of LATIN typography. Japanese
    // runs 。 straight into the next sentence, so demanding a space there merges the
    // whole paragraph into one chunk and the reply is spoken as a single breath.
    const cjkStop = '。！？'.includes(ch);
    if (!cjkStop && j < clean.length && !/\s/.test(clean[j])) continue;   // mid-token
    while (j < clean.length && /\s/.test(clean[j])) j++;             // keep the gap with this part
    out.push(clean.slice(start, j));
    start = j;
    i = j - 1;
  }
  if (start < clean.length) out.push(clean.slice(start));
  return out.length ? out : [clean];
}

/** Split text into speakable chunks at sentence boundaries where possible. */
export function chunkForSpeech(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  // Break after ., !, ?, …, and the CJK full stop / question mark the user's
  // Japanese replies actually end with.
  const parts = splitSentences(clean);
  const out = [];
  let buf = '';
  for (const p of parts) {
    if (buf && (weigh(buf) + weigh(p) > MAX_CHUNK)) { out.push(buf.trim()); buf = ''; }
    buf += p;
    const min = out.length ? MIN_CHUNK : FIRST_CHUNK;
    if (weigh(buf) >= min && /[.!?…。！？]\s*$/.test(buf)) { out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  // A single monstrous "sentence" (a URL dump, a code line that slipped through)
  // still has to be cut somewhere.
  return out.flatMap(s => (s.length <= MAX_CHUNK * 2 ? [s] : s.match(new RegExp(`.{1,${MAX_CHUNK}}(\\s|$)`, 'g')) || [s]))
    .map(s => s.trim()).filter(Boolean);
}

async function fetchSpeech(text, { voice, speed, signal }) {
  const token = localStorage.getItem('aios.token') || '';
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch('/api/voice/speak', {
    method: 'POST', headers, signal,
    body: JSON.stringify({ text, voice: voice || undefined, speed: speed || undefined }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `speech failed (${r.status})`);
  }
  return r.blob();
}

/**
 * A speaking session you can feed while it is already talking.
 *
 * Chunks are synthesized one ahead of playback: while sentence N plays, N+1 is
 * already being generated, so after the first chunk the gaps disappear. Everything
 * runs behind a single AbortController — barge-in has to be instant, and a half-
 * finished fetch that lands after cancel() must not start playing.
 */
export class Speaker {
  constructor({ voice, speed, onState } = {}) {
    Object.assign(this, { voice, speed, onState });
    this.queue = [];
    this.pending = '';
    this.playing = false;
    this.cancelled = false;
    this.audio = null;
    this.ac = new AbortController();
    this._urls = new Set();
  }

  get active() { return this.playing || this.queue.length > 0; }

  /** Feed streamed text; complete sentences start speaking, the tail waits. */
  push(text) {
    if (this.cancelled) return;
    this.pending += text;
    const chunks = chunkForSpeech(this.pending);
    if (chunks.length > 1) {
      // keep the last (possibly unfinished) chunk back until flush()
      const ready = chunks.slice(0, -1);
      this.pending = chunks[chunks.length - 1];
      this._enqueue(ready);
    }
  }

  /** Speak everything held back, and mark the utterance complete. */
  flush() {
    if (this.cancelled) return;
    const tail = this.pending.trim();
    this.pending = '';
    this.done = true;                       // set BEFORE enqueuing, so the drain
    if (tail) this._enqueue(chunkForSpeech(tail));   // knows this is the last of it
    // Nothing left to say and nothing playing: the caller is waiting for an 'idle'
    // that no drain is going to emit.
    if (!this.playing && !this.queue.length) this.onState?.('idle');
  }

  /** One-shot: speak this text now. */
  say(text) { this._enqueue(chunkForSpeech(text)); this.done = true; return this; }

  _enqueue(chunks) {
    if (!chunks?.length || this.cancelled) return;
    for (const c of chunks) this.queue.push(c);
    if (!this.playing) this._drain().catch(() => { });
  }

  _synth(text) {
    return fetchSpeech(text, { voice: this.voice, speed: this.speed, signal: this.ac.signal })
      .catch((e) => { if (!this.cancelled) this.onState?.('error', e); return null; });
  }

  async _drain() {
    this.playing = true;
    this.onState?.('speaking');
    let ahead = null;      // audio for the chunk after this one, already in flight
    try {
      while (!this.cancelled) {
        let audioP = ahead;
        ahead = null;
        if (!audioP) {
          if (!this.queue.length) break;
          audioP = this._synth(this.queue.shift());
        }
        // Start generating the next chunk BEFORE waiting on this one: that overlap is
        // what removes the pause between sentences after the first.
        if (this.queue.length && !this.cancelled) ahead = this._synth(this.queue.shift());

        const blob = await audioP;
        if (this.cancelled) break;
        if (blob) await this._play(blob);
      }
    } finally {
      this.playing = false;
      this._revoke();
      // 'idle' means THE REPLY IS OVER, not "the queue happens to be empty". During
      // a stream the speaker regularly outruns the model and drains between
      // sentences; reporting idle there made the hands-free loop start listening
      // over the second half of its own answer.
      const finished = this.done && !this.queue.length && !this.pending;
      this.onState?.(this.cancelled ? 'cancelled' : finished ? 'idle' : 'waiting');
    }
  }

  _play(blob) {
    return new Promise((resolve) => {
      if (this.cancelled) return resolve();
      const url = URL.createObjectURL(blob);
      this._urls.add(url);
      const a = new Audio(url);
      this.audio = a;
      const end = () => { this.audio = null; URL.revokeObjectURL(url); this._urls.delete(url); resolve(); };
      a.onended = end;
      a.onerror = end;
      // Route through Web Audio so the visualiser can show the ASSISTANT's voice, not
      // just the microphone. Strictly best-effort: if the graph cannot be built the
      // element still plays on its own, because a silent assistant is a far worse bug
      // than a still picture.
      try { attachOutputAnalyser(a); } catch { /* plain playback, no bars */ }
      a.play().catch(end);   // autoplay refused (no gesture yet) — don't hang the queue
    });
  }

  _revoke() {
    for (const u of this._urls) { try { URL.revokeObjectURL(u); } catch { } }
    this._urls.clear();
  }

  /** Stop immediately: playback, queue, and anything still in flight. */
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.queue.length = 0;
    this.pending = '';
    try { this.ac.abort(); } catch { }
    if (this.audio) { try { this.audio.pause(); } catch { } this.audio = null; }
    this._revoke();
    this.onState?.('cancelled');
  }
}

// ---- what the assistant's own voice looks like ----
//
// One AudioContext and one analyser for the whole page: createMediaElementSource can
// only be called once per element, and a context per utterance leaks hardware voices
// until the browser refuses to open more.

let outCtx = null, outAnalyser = null, outFreq = null;
const outBands = new Float32Array(BANDS);

// Opt-in, and that matters. Routing an <audio> through Web Audio replaces its direct
// output: if the context is suspended — which it is until the page gets a gesture —
// the element goes SILENT where a plain .play() would have been heard. Voice mode is
// always opened by a click so it can safely ask for this; chat auto-speak can fire
// with no recent gesture at all, so it keeps plain playback and simply has no bars.
let vizWanted = false;
export function setSpeechVisualization(on) {
  vizWanted = !!on;
  if (!on) return;
  // Warm the context on the gesture that turned it on, so the first reply is audible.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx && !outCtx) { outCtx = new Ctx(); }
    if (outCtx?.state === 'suspended') outCtx.resume().catch(() => { });
  } catch { /* no Web Audio here; playback is unaffected */ }
}

function attachOutputAnalyser(audioEl) {
  if (!vizWanted) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!outCtx) outCtx = new Ctx();
  // A suspended context would mute the element we are about to capture. Leave it
  // alone and let it play normally.
  if (outCtx.state !== 'running') { outCtx.resume().catch(() => { }); return; }
  if (!outAnalyser) {
    outAnalyser = outCtx.createAnalyser();
    outAnalyser.fftSize = 512;
    outAnalyser.smoothingTimeConstant = 0.72;
    outAnalyser.connect(outCtx.destination);
    outFreq = new Uint8Array(outAnalyser.frequencyBinCount);
  }
  const src = outCtx.createMediaElementSource(audioEl);
  // Once the element is captured it no longer reaches the speakers on its own, so if
  // the analyser hop fails for any reason it still has to be wired to the output —
  // a visualiser is worth nothing next to an assistant that cannot be heard.
  try { src.connect(outAnalyser); } catch { src.connect(outCtx.destination); }
}

/**
 * Earcons — the small tones that tell you the microphone opened and closed.
 *
 * Hands-free means not looking at the screen, and without them you cannot tell "it is
 * listening" from "it is thinking" from "it has stopped" without checking. Synthesised
 * from oscillators rather than shipped as files: they are three notes, they must never
 * be a 404, and they have to work with the speech muted (that is when they matter
 * most). Kept quiet and short — a loud chime every turn is a thing you disable.
 */
const CUES = {
  listen: [[660, 0], [880, 0.07]],     // rising: your turn
  stop: [[520, 0]],                    // one soft note: got it
  confirm: [[784, 0], [1046, 0.08]],   // brighter: a decision is wanted
  error: [[300, 0], [220, 0.10]],      // falling
};

export function earcon(kind = 'listen', { volume = 0.05 } = {}) {
  const notes = CUES[kind];
  if (!notes) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!outCtx) outCtx = new Ctx();
    if (outCtx.state === 'suspended') { outCtx.resume().catch(() => { }); return; }
    const now = outCtx.currentTime;
    for (const [freq, at] of notes) {
      const osc = outCtx.createOscillator();
      const gain = outCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // A short exponential fade: a square-edged tone clicks, and the click is the
      // part people find irritating, not the note.
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(volume, now + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.13);
      osc.connect(gain).connect(outCtx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.15);
    }
  } catch { /* no Web Audio: the UI still says everything the tones do */ }
}

/** Live spectrum of whatever is being spoken, for the visualiser. */
export function speakingBands() {
  if (!outAnalyser || !outFreq) return null;
  outAnalyser.getByteFrequencyData(outFreq);
  return fillBands(outFreq, outBands);
}

// ---------------------------------------------------- one shared output channel

// Only one thing should ever be talking. A second reply arriving while the first is
// still being read has to interrupt it, not overlap it.
let current = null;

/**
 * Speak text through the shared channel, replacing whatever was speaking.
 * Returns null when this device is set to never speak — callers treat that as
 * "nothing is going to talk", which is what keeps a muted hands-free loop moving.
 *
 * `force` is for the explicit preview button in Settings: choosing a voice has to
 * play it even on a device that has speech switched off, or you are picking a voice
 * for other devices blind.
 */
export function speak(text, opts = {}) {
  stopSpeaking();
  const p = prefs();
  if (p.speech === 'off' && !opts.force) return null;
  current = new Speaker({ voice: opts.voice ?? p.voice, speed: opts.speed ?? p.speed, onState: opts.onState });
  current.say(text);
  return current;
}

/** Open a streaming speaking session (chat replies arrive token by token). */
export function speakStream(opts = {}) {
  stopSpeaking();
  const p = prefs();
  if (p.speech === 'off') return null;
  current = new Speaker({ voice: opts.voice ?? p.voice, speed: opts.speed ?? p.speed, onState: opts.onState });
  return current;
}

export function stopSpeaking() {
  if (current) { current.cancel(); current = null; }
}
export const isSpeaking = () => !!current?.active;

/**
 * Play one sentence in a specific voice and report what actually happened.
 *
 * Separate from speak() because choosing a voice needs the metadata: a Japanese or
 * Mandarin voice falls back to espeak when its phonemizer is missing, which sounds
 * wrong in a way that is very hard to attribute if the UI does not say so. Returns
 * { lang, g2p, seconds } — `g2p` is 'misaki:ja', 'espeak:en-us', and so on.
 */
export async function previewVoice(text, { voice, speed, blend, pitch } = {}) {
  stopSpeaking();
  const token = localStorage.getItem('aios.token') || '';
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch('/api/voice/speak', {
    method: 'POST', headers,
    body: JSON.stringify({ text, voice: voice || undefined, speed: speed || undefined, blend, pitch }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `preview failed (${r.status})`);
  const meta = {
    lang: r.headers.get('x-voice-lang') || '',
    g2p: r.headers.get('x-voice-g2p') || '',
    seconds: Number(r.headers.get('x-voice-seconds')) || 0,
  };
  const url = URL.createObjectURL(await r.blob());
  const a = new Audio(url);
  previewAudio?.pause();
  previewAudio = a;
  a.onended = a.onerror = () => URL.revokeObjectURL(url);
  await a.play().catch(() => { });
  return meta;
}
let previewAudio = null;
