// Voice mode — a hands-free conversation with the hub.
//
// A full-page overlay rather than a panel inside Chat, because the whole point is
// that you are not looking at the screen. It runs the ordinary chat pipeline
// underneath (same WebSocket, same model, same tools), so anything you can ask by
// typing you can ask by speaking, the transcript is a normal chat you can scroll
// back through afterwards, and nothing here needs its own server endpoint.
//
// The loop is a small state machine:
//
//   idle ──tap/space──▶ listening ──you stop talking──▶ thinking
//     ▲                     │                              │
//     └──── hands-free off ─┴──── speaking ◀───────────────┘
//                                    │
//                                barge-in (tap/space) starts listening again
//
// Two rules keep it from talking over itself: the mic is never open while the
// speaker is playing (echo cancellation helps but does not survive a laptop at
// volume), and any new utterance cancels whatever was being said.

import { el, icon, toast, modelPicker } from './ui.js';
import { post, sub, wsSend } from './api.js';
import { Recorder, speak, speakStream, stopSpeaking, transcribe, voiceStatus, micProblem, prefs, setPrefs, speakingBands, setSpeechVisualization, earcon, BANDS } from './voice.js';
import { VoiceOrb } from './voiceviz.js';
import { savedConfig, setupDialog, startSession, patchSession, saveAnswer, describe } from './interview.js';

let openInstance = null;

/**
 * Open (or focus) Voice mode.
 *   opts.chatId   continue an existing conversation (its own instructions are kept)
 *   opts.config   open straight into a configured session — how the Interview app
 *                 starts a practice run without making you set it up twice
 */
export function openVoiceMode(opts = {}) {
  // Already open: honour the configuration rather than silently ignoring it, so
  // "practise this" from the Interview app means the same thing whether or not the
  // overlay happened to be up already.
  if (openInstance) {
    if (opts.config) openInstance.applyConfig(opts.config);
    return openInstance;
  }
  openInstance = new VoiceMode(opts);
  return openInstance;
}
export const voiceModeOpen = () => !!openInstance;

const STATUS_TEXT = {
  idle: 'Tap the circle or press Space to talk',
  listening: 'Listening…',
  transcribing: 'Getting that down…',
  thinking: 'Thinking…',
  speaking: 'Speaking — tap to interrupt',
  // Muted: the answer is arriving but nothing is being said out loud. It needs its
  // own phase or the screen claims to be speaking in silence.
  answering: 'Answering — tap to stop',
  confirm: 'Say “yes” to confirm, or “no” to cancel',
  error: 'Something went wrong',
};

// An interview is a different kind of silence. "Listening…" while you gather your
// thoughts for eight seconds reads as a machine waiting for you to hurry up.
const INTERVIEW_STATUS = {
  idle: 'Tap the circle or press Space when you are ready to answer',
  listening: 'Listening — take your time',
  thinking: 'Considering that…',
};

class VoiceMode {
  constructor(opts) {
    this.chatId = opts.chatId || null;
    this.unsub = null;
    this.rec = null;
    this.speaker = null;
    this.phase = 'idle';
    this.paused = false;
    this.turns = 0;             // completed exchanges, for the header read-out
    this.p = prefs();
    // How the AI is to behave when spoken to. Every voice session has one — the plain
    // conversation is just the mode where the only thing it says is "you are being
    // heard, not read". `session` is set once the server has composed it into a chat.
    this.cfg = opts.config || savedConfig();
    this.sessionId = null;
    this.kickoff = '';
    // The question half of anything saved to the answer bank.
    this.lastHeard = '';
    // Opening straight into an interview the AI runs: it speaks first, so the ready
    // check must NOT open the microphone on the way in.
    this.opening = opts.config?.mode === 'interview' && opts.config?.role === 'interviewer';
    this.build();
    this.checkReady().then(() => {
      if (this.opening && !this.closed && this.phase !== 'error') this.applyConfig(this.cfg, { fresh: true });
    });
  }

  get interviewing() { return this.cfg?.mode === 'interview'; }

  // ------------------------------------------------------------------ chrome

  build() {
    // The stage: the agent on the left, the conversation on the right. Split rather
    // than stacked because in a voice session the transcript is something you glance
    // at while the avatar is what you look at — and a column of chat that scrolls
    // under a big orb pushes the orb off screen the moment you say three things.
    this.canvas = el('canvas', { class: 'vm-canvas' });
    this.orb = el('button', {
      class: 'vm-orb', type: 'button', title: 'Talk (Space)',
      onclick: () => this.tap(),
    }, this.canvas, el('span', { class: 'vm-orb-hit' }));

    this.statusEl = el('div', { class: 'vm-status' }, STATUS_TEXT.idle);
    this.heardEl = el('div', { class: 'vm-heard' });
    // Instrument read-out. Deliberately monospace and small: it is telemetry, not
    // copy, and it is what makes the level meter legible as a *register* rather than
    // a decoration.
    this.meter = el('div', { class: 'vm-meter' },
      ...Array.from({ length: 32 }, () => el('i')));
    this.readout = el('div', { class: 'vm-readout' },
      this.readState = el('span', { class: 'vm-read-k' }, 'IDLE'),
      el('span', { class: 'vm-read-sep' }, '·'),
      this.readLvl = el('span', {}, 'LVL 000'),
      el('span', { class: 'vm-read-sep' }, '·'),
      this.readLang = el('span', {}, 'AUTO'));

    this.log = el('div', { class: 'vm-log' });

    this.model = modelPicker({ storageKey: 'chat' });

    this.handsBtn = el('button', {
      class: 'btn sm ghost' + (this.p.handsFree ? ' on' : ''),
      title: 'Hands-free: keep listening after each reply',
      onclick: () => {
        this.p = setPrefs({ handsFree: !this.p.handsFree });
        this.handsBtn.classList.toggle('on', this.p.handsFree);
        toast(this.p.handsFree ? 'Hands-free on' : 'Hands-free off — tap to talk');
      },
    }, icon('waveform'), 'Hands-free');

    // In a hands-free conversation there is no middle position: either it answers
    // out loud or the whole thing is a dictation loop that writes into a transcript.
    // Muting here is what makes voice usable in a room with other people in it.
    this.muteBtn = el('button', {
      class: 'btn sm ghost' + (this.speaks ? ' on' : ''),
      title: 'Speak the replies (off = listen only, answers stay on screen)',
      onclick: () => {
        this.p = setPrefs({ speech: this.speaks ? 'off' : 'auto' });
        if (!this.speaks) stopSpeaking();
        this.paintMute();
        // A reply being read when you mute has to stop mid-word, not finish first.
        if (!this.speaks && this.phase === 'speaking') this.afterSpeaking();
      },
    });
    this.paintMute();

    // The one control that changes what kind of session this is: ordinary hands-free
    // conversation, or an interview with the AI on either side of the table. It sits
    // in the header rather than behind Settings because it is a per-session decision,
    // and because the screen you change it on is the screen you are talking to.
    this.modeBtn = el('button', {
      class: 'btn sm ghost', title: 'How the AI answers you — conversation or interview (I)',
      onclick: () => this.configure(),
    }, icon('briefcase'), this.modeLabel = el('span', {}, 'Mode'));

    this.node = el('div', { class: 'vm-overlay' },
      el('div', { class: 'vm-head' },
        el('span', { class: 'vm-title' }, icon('waveform'), 'Voice mode'),
        el('span', { class: 'vm-dot' }),
        el('span', { class: 'grow' }),
        this.turnsEl = el('span', { class: 'vm-meta' }, '0 turns · 0:00'),
        this.model, this.modeBtn, this.handsBtn, this.muteBtn,
        el('button', { class: 'btn sm ghost', title: 'Close (Esc)', onclick: () => this.close() }, icon('x'))),

      el('div', { class: 'vm-body' },
        el('div', { class: 'vm-stage' },
          el('div', { class: 'vm-orb-wrap' }, this.orb),
          this.readout,
          this.meter,
          this.statusEl,
          this.heardEl,
          el('div', { class: 'vm-actions' },
            this.pauseBtn = el('button', { class: 'btn sm ghost', title: 'Pause the loop (P)', onclick: () => this.togglePause() }, icon('stop'), 'Pause'),
            el('button', { class: 'btn sm ghost', title: 'Say the last answer again (R)', onclick: () => this.repeatLast() }, icon('refresh'), 'Repeat'),
            el('button', { class: 'btn sm ghost', title: 'Keep the last answer in the interview bank (S)', onclick: () => this.keepLast() }, icon('star'), 'Keep'),
            el('button', { class: 'btn sm ghost', title: 'Save this conversation to your notes', onclick: () => this.saveTranscript() }, icon('vault'), 'Save')),
          el('div', { class: 'vm-hints' },
            el('kbd', {}, 'Space'), ' talk · ',
            el('kbd', {}, 'M'), ' mute · ',
            el('kbd', {}, 'H'), ' hands-free · ',
            el('kbd', {}, 'R'), ' repeat · ',
            el('kbd', {}, 'S'), ' keep · ',
            el('kbd', {}, 'I'), ' mode · ',
            el('kbd', {}, 'P'), ' pause · ',
            el('kbd', {}, 'Esc'), ' close')),
        el('div', { class: 'vm-side' },
          el('div', { class: 'vm-side-head' }, 'Transcript'),
          this.log,
          this.jumpBtn = el('button', {
            class: 'vm-jump', onclick: () => { this.follow = true; this.scrollLog(true); },
          }, icon('chevD'), 'Jump to latest'))),
    );

    document.body.append(this.node);
    document.body.classList.add('vm-open');

    // Hands-free means the keyboard is the only thing you might still touch, so it
    // covers every control on screen rather than just the two obvious ones. Guarded
    // against text fields — the model picker behind the overlay is a <select>.
    this.onKey = (e) => {
      // A dialog on top of the overlay owns the keyboard. Without this, Escape closed
      // the setup screen AND the whole session behind it, and Space tapped the orb
      // from inside a form.
      if (document.querySelector('.modal-overlay')) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
      const k = e.key.toLowerCase();
      if (e.code === 'Space') { e.preventDefault(); this.tap(); }
      else if (k === 'm') { e.preventDefault(); this.muteBtn.click(); }
      else if (k === 'h') { e.preventDefault(); this.handsBtn.click(); }
      else if (k === 'r') { e.preventDefault(); this.repeatLast(); }
      else if (k === 's') { e.preventDefault(); this.keepLast(); }
      else if (k === 'i') { e.preventDefault(); this.configure(); }
      else if (k === 'p') { e.preventDefault(); this.togglePause(); }
    };
    document.addEventListener('keydown', this.onKey);

    // Follow the tail until the user scrolls away from it, then leave them alone.
    this.follow = true;
    this.log.addEventListener('scroll', () => {
      const atEnd = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
      this.follow = atEnd;
      this.jumpBtn.classList.toggle('show', !atEnd);
    });

    this.startedAt = Date.now();
    this.tick = setInterval(() => this.paintMeta(), 1000);

    this.viz = new VoiceOrb(this.canvas, { bands: BANDS });
    this.viz.start();
    this.viz.setPhase('idle');
    // Opened by a click, so this is the moment we are allowed to bring up the audio
    // graph that lets the avatar react to the assistant's own voice.
    setSpeechVisualization(true);
    this.paintMode();
  }

  /** Does this device speak at all right now? */
  get speaks() { return this.p.speech !== 'off'; }

  paintMute() {
    const on = this.speaks;
    this.muteBtn.classList.toggle('on', on);
    this.muteBtn.replaceChildren(icon(on ? 'speaker' : 'speakerOff'), on ? 'Voice' : 'Muted');
  }

  // ------------------------------------------------------------------- the session
  //
  // "How should it answer me" is a property of the conversation, not of the app, so it
  // is composed into the chat's own instructions (server/interview.js) rather than
  // prepended to each message here. That is what lets an interview survive a reload,
  // be continued from the Chat app, and be re-read months later as a plain transcript.

  paintMode() {
    const on = this.interviewing;
    this.modeBtn.classList.toggle('on', on);
    this.modeLabel.textContent = on ? describe(this.cfg) : 'Mode';
    this.node.dataset.mode = this.cfg?.mode || 'chat';
  }

  /** Open the setup screen and apply whatever comes back. */
  async configure() {
    const wasListening = this.phase === 'listening';
    if (wasListening) { try { this.rec?.abort(); } catch { } this.rec = null; this.setPhase('idle'); }
    stopSpeaking();
    const next = await setupDialog({
      config: this.cfg,
      ok: this.sessionId ? 'Apply' : 'Start',
    });
    if (!next) { if (wasListening && this.p.handsFree) this.listen(); return; }
    await this.applyConfig(next);
  }

  /**
   * Put a configuration into effect.
   *
   * Three cases, and they are genuinely different:
   *  - no conversation yet    remember it; the session opens with the first utterance
   *  - our own session        patch it, so the transcript so far is kept
   *  - somebody else's chat   (opened from Chat with `chatId`) start fresh instead of
   *                           rewriting the instructions of a conversation we did not
   *                           create — and say so, because a silent new chat is a
   *                           transcript the user thinks they are still in.
   */
  async applyConfig(cfg, { fresh = false } = {}) {
    this.cfg = cfg;
    this.paintMode();

    if (this.sessionId && !fresh) {
      try { this.kickoff = (await patchSession(this.sessionId, cfg)).kickoff || ''; }
      catch (e) { toast(e.message, 'err'); return; }
      this.addNote(this.interviewing ? `interview · ${describe(cfg)}` : 'back to ordinary conversation');
    } else if (this.chatId) {
      // Abandoning this conversation, so anything still generating in it is now an
      // answer to a question nobody is listening to — and its deltas would be written
      // into transcript nodes that are about to be thrown away.
      this.stopTurn();
      this.unsub?.(); this.unsub = null;
      this.chatId = null; this.sessionId = null;
      this.log.replaceChildren();
      this.turns = 0; this.startedAt = Date.now(); this.paintMeta();
      if (!fresh) toast('started a new session — the previous conversation is still in Chat');
    }

    // The interviewer has to speak first: a hands-free screen that opens by listening
    // to silence is a screen where nothing happens.
    if (this.interviewing && this.cfg.role === 'interviewer') await this.beginInterview();
    else if (this.phase === 'idle' && this.p.handsFree && !this.paused) this.listen();
  }

  async beginInterview() {
    stopSpeaking();
    try { this.rec?.abort(); } catch { }
    this.rec = null;
    const modelRef = this.model.getValue();
    if (!modelRef) { toast('pick a model first', 'err'); return; }
    this.setPhase('thinking');
    // Open the conversation FIRST: the opening line is the server's (it knows which
    // side the AI is playing), and it only exists once the session does.
    try { await this.ensureChat(modelRef); }
    catch (e) { toast(e.message, 'err'); this.setPhase('idle'); return; }
    this.addNote(`interview · ${describe(this.cfg)}`);
    await this.send(this.kickoff || 'I am ready. Begin the interview with your first question.');
  }

  async checkReady() {
    const problem = micProblem();
    if (problem) return this.fail(problem);
    const s = await voiceStatus();
    if (!s.enabled) return this.fail('Voice is turned off in Settings → Voice.');
    if (!s.stt?.ok) return this.fail(s.setup || 'No speech-to-text model installed. Run `npm run voice`.');
    if (!s.tts?.ok && this.speaks) toast('Speech output is not installed — replies will be text only', 'warn');
    this.ttsReady = !!s.tts?.ok;
    // Streaming beats the whisper-rerun partials whenever it is installed: the words
    // arrive as they are spoken rather than a second at a time. `partials` stays true
    // for either engine — it only says whether live text is available at all.
    this.streaming = !!s.stt?.streaming;
    this.streamMs = s.stt?.streamMs || 200;
    this.partials = this.streaming || !!s.stt?.partial;
    this.partialMs = s.stt?.partialMs || 1100;
    // Loading whisper takes ~0.5s and Kokoro ~0.9s. Doing it now means the first
    // thing said is answered as fast as the tenth.
    // Nothing loads the speech model on a device that has been told never to speak.
    const warming = post('/voice/warm', {
      stt: true, tts: this.speaks && !!s.tts?.ok,
      partial: this.partials && !this.streaming, stream: this.streaming,
    }).catch(() => { });

    // The streaming model is ~300MB of ONNX and takes about 3.7s to load. The worker
    // answers one request at a time, so opening the mic before that finishes means
    // the first chunks queue BEHIND the load and the whole first utterance goes by
    // with no live text — the one turn where a new user is deciding whether this
    // works. Waiting for it costs nothing a person would notice (the overlay is
    // already up) and is capped so a wedged load cannot keep the mic shut.
    if (this.streaming) {
      this.statusEl.textContent = 'Warming up the recogniser…';
      await Promise.race([warming, new Promise(r => setTimeout(r, 12_000))]);
      if (this.closed) return;
      this.statusEl.textContent = '';
    }
    if (this.p.handsFree && !this.opening) this.listen();
  }

  fail(msg) {
    this.setPhase('error');
    this.statusEl.textContent = msg;
    this.orb.disabled = true;
  }

  setPhase(phase) {
    this.phase = phase;
    this.node.dataset.phase = phase;
    const said = (this.interviewing && INTERVIEW_STATUS[phase]) || STATUS_TEXT[phase];
    if (said) this.statusEl.textContent = said;
    this.viz?.setPhase(phase);
    this.readState.textContent = String(phase).toUpperCase();
    // The assistant's own voice drives the visualiser while it talks; the microphone
    // drives it while it listens. Nothing else needs a live feed, so the poll stops.
    if (phase === 'speaking') this.watchOutput(); else this.stopWatchOutput();
    if (phase !== 'listening' && phase !== 'speaking') this.level(0);
  }

  /** One place that moves every audio-reactive thing: HUD, bar meter, read-out. */
  level(v, bands) {
    const lv = Math.min(1, Math.max(0, v || 0));
    this.viz?.setAudio(lv, bands);
    this.readLvl.textContent = 'LVL ' + String(Math.round(lv * 999)).padStart(3, '0');
    const bars = this.meter.children;
    for (let i = 0; i < bars.length; i++) {
      const b = bands ? (bands[Math.floor(i * (bands.length / bars.length))] || 0) : lv;
      bars[i].style.transform = `scaleY(${(0.08 + b * 0.92).toFixed(3)})`;
    }
  }

  watchOutput() {
    if (this._outRaf) return;
    const tick = () => {
      if (this.closed || this.phase !== 'speaking') { this._outRaf = 0; return; }
      const b = speakingBands();
      if (b) { let s = 0; for (let i = 0; i < b.length; i++) s += b[i]; this.level(s / b.length * 1.6, b); }
      this._outRaf = requestAnimationFrame(tick);
    };
    this._outRaf = requestAnimationFrame(tick);
  }
  stopWatchOutput() { cancelAnimationFrame(this._outRaf); this._outRaf = 0; }

  // ------------------------------------------------------------------- input

  /** The one gesture that means "your turn / my turn" in every phase. */
  tap() {
    if (this.phase === 'listening') { this.rec?.stop(); return; }   // "I'm done"
    if (this.phase === 'speaking') { stopSpeaking(); this.listen(); return; }  // barge-in
    if (this.phase === 'thinking' || this.phase === 'answering') { this.stopTurn(); return; }
    this.listen();
  }

  async listen() {
    if (this.phase === 'listening' || this.paused) return;
    stopSpeaking();
    this.heardEl.textContent = '';
    this.heardEl.classList.remove('is-partial');
    this.setPhase('listening');
    this.cue('listen');
    try {
      this.rec = new Recorder({
        handsFree: this.p.handsFree,
        // Live text as you speak. It is a rougher model than the one that produces
        // the real transcription, so it is shown as provisional and replaced wholesale
        // the moment the accurate pass lands.
        partialMs: this.partialMs,
        streaming: this.streaming, streamMs: this.streamMs,
        onPartial: this.partials === false ? null : (text, { final } = {}) => {
          // The `final` one arrives just after the recording stops — it is the tail
          // the transducer only emits once its stream is flushed, so it completes a
          // line that would otherwise sit truncated for the two seconds whisper
          // takes. Still provisional, and still replaced by the real reading: the
          // is-partial class is the test for "the accurate pass has not landed yet",
          // which is exactly the condition under which a guess may still be shown.
          if (final ? !this.heardEl.classList.contains('is-partial') : this.phase !== 'listening') return;
          this.heardEl.textContent = text;
          this.heardEl.classList.add('is-partial');
        },
        // NOT wired to stop the recording, deliberately.
        //
        // The transducer's endpointer fires on trailing silence measured against what
        // it decoded — about 1.0s at rule2=0.8. That is shorter than the windows this
        // loop is tuned for (1100ms here, 2400ms in an interview), and those numbers
        // were not guesses: a 0.9s thinking pause used to end the turn mid-sentence,
        // and the transcription that came back was a confident reading of half a
        // thought, 62% WER against 38% once the window was widened. Letting a second
        // opinion cut the turn sooner reintroduces exactly that.
        //
        // The signal is worth having anyway — the useful direction is the opposite
        // one, EXTENDING a turn when the recogniser thinks the sentence is not
        // finished. That needs tuning against real speech, so it is a roadmap item
        // rather than a guess wired in here.
        // How long a pause ends your turn. Per-device, because a room with other
        // people in it and a quiet study are not the same conversation.
        //
        // An interview answer is not a chat message: you think mid-sentence, you
        // restart, and you take a few seconds before you begin at all. At the
        // conversational thresholds the recorder cuts you off in the middle of your
        // own answer, which is the single most infuriating thing this feature could
        // do — so an interview gets a longer pause, a longer silence before it gives
        // up on you, and three minutes of headroom instead of one.
        silenceMs: this.p.silenceMs || (this.interviewing ? 2400 : undefined),
        noSpeechSec: this.interviewing ? 20 : undefined,
        maxSec: this.interviewing ? 180 : undefined,
        onLevel: (v, bands) => this.level(v, bands),
        onAuto: (why) => { if (why === 'nospeech') this.setPhase('idle'); },
      });
      await this.rec.start();
      // Whatever ends the recording — the silence detector, another tap, the length
      // cap — settles `done`. This await IS the listening phase.
      const audio = await this.rec.done;
      this.level(0);
      if (this.closed) return;
      if (!this.rec.spoke) return this.nobodySpoke();
      this.quietRounds = 0;
      await this.handleAudio(audio);
    } catch (e) {
      this.level(0);
      this.fail(e.message);
    }
  }

  /**
   * A listening window that heard nothing.
   *
   * Hands-free retries, because the usual cause is that you were still thinking.
   * But it retries a bounded number of times: an unattended tab that re-opens the
   * microphone every nine seconds forever is a recording indicator that never goes
   * out, and there is no way for the user to tell it apart from a bug.
   */
  nobodySpoke() {
    this.quietRounds = (this.quietRounds || 0) + 1;
    this.setPhase('idle');
    if (this.p.handsFree && this.quietRounds < 3) {
      this.statusEl.textContent = 'Listening…';
      setTimeout(() => { if (!this.closed && this.phase === 'idle') this.listen(); }, 400);
    } else {
      this.quietRounds = 0;
      this.statusEl.textContent = 'Still there? Tap the circle or press Space.';
    }
  }

  async handleAudio(blob) {
    if (!blob?.size) { this.setPhase('idle'); return; }
    this.setPhase('transcribing');
    let heard;
    try { heard = await transcribe(blob); }
    catch (e) { toast(e.message, 'err'); this.setPhase('idle'); return; }
    if (this.closed) return;

    const text = (heard.text || '').trim();
    if (!text) {
      this.statusEl.textContent = 'Did not catch that — try again';
      this.setPhaseSoon('idle');
      if (this.p.handsFree) setTimeout(() => this.phase === 'idle' && this.listen(), 900);
      return;
    }
    this.cue('stop');
    this.turns++; this.paintMeta();
    this.heardEl.classList.remove('is-partial');   // this one is the real reading
    this.heardEl.textContent = text;
    this.lastHeard = text;                         // the question half of a kept answer
    if (heard.language) this.readLang.textContent = String(heard.language).toUpperCase();
    this.addTurn('you', text);
    await this.send(text);
  }

  setPhaseSoon(phase) { setTimeout(() => { if (!this.closed) this.setPhase(phase); }, 1200); }

  // ------------------------------------------------------------------ the model

  /**
   * The conversation this session runs in, opened on demand.
   *
   * Cold-opening a chat when the overlay appears would litter the Chat app with empty
   * conversations every time it is glanced at, so nothing exists until something is
   * said. The session record — which is what carries "answer me like this" — is
   * created in the same call, by the server, so the composed instructions and the chat
   * they belong to can never drift apart.
   */
  async ensureChat(modelRef) {
    if (this.chatId) return this.chatId;
    const r = await startSession(this.cfg, modelRef);
    this.sessionId = r.session?.id || null;
    this.kickoff = r.kickoff || '';
    this.chatId = r.chat.id;
    this.unsub = sub('chat:' + this.chatId, (m) => this.onEvent(m.ev));
    return this.chatId;
  }

  async send(text) {
    const modelRef = this.model.getValue();
    if (!modelRef) { toast('pick a model first', 'err'); this.setPhase('idle'); return; }
    this.setPhase('thinking');

    try { await this.ensureChat(modelRef); }
    catch (e) { toast(e.message, 'err'); this.setPhase('idle'); return; }

    this.reply = '';
    this.pending = null;
    this.replyEl = this.addTurn('assistant', '');
    this.speaker = (this.speaks && this.ttsReady)
      ? speakStream({ onState: (s) => { if (s === 'idle' && this.phase === 'speaking') this.afterSpeaking(); } })
      : null;

    wsSend({ t: 'chat.send', chatId: this.chatId, text, modelRef });
  }

  onEvent(ev) {
    if (this.closed || !ev) return;
    if (ev.type === 'delta') {
      const arriving = this.speaker ? 'speaking' : 'answering';
      if (this.phase !== arriving) this.setPhase(arriving);
      this.reply += ev.delta;
      this.replyEl.textContent = this.reply;
      this.scrollLog();
      this.speaker?.push(ev.delta);
    } else if (ev.type === 'proposal') {
      // Hold it back rather than reading the model's sentence about it. The card's
      // own line is generated from the actual fields, so it cannot drift from what
      // is about to be written — which is the only sentence worth trusting when the
      // user is not looking at the screen.
      this.pending = ev.proposal;
      this.cue('confirm');
      this.showProposal(ev.proposal);
    } else if (ev.type === 'proposal.update') {
      if (this.pending?.id === ev.proposal.id) this.pending = null;
      this.markProposal(ev.proposal);
    } else if (ev.type === 'tool.start') {
      // In the transcript too: when you are not watching the screen, "it went quiet
      // for eight seconds" and "it is searching the web" feel identical otherwise.
      this.statusEl.textContent = `Looking that up (${ev.name})…`;
      this.addNote(`used ${String(ev.name).replace(/_/g, ' ')}`);
    } else if (ev.type === 'done') {
      const final = (ev.text || this.reply || '').trim();
      this.reply = final;
      this.replyEl.textContent = final || '(no answer)';
      if (this.pending && this.speaker) {
        // Say the card, not the commentary — and only the card, or you hear the same
        // thing twice in slightly different words.
        this.speaker.cancel();
        this.speaker = speakStream({ onState: (s) => { if (s === 'idle') this.afterConfirmAsked(); } });
        this.speaker.say(this.pending.spoken);
        this.setPhase('speaking');
        return;
      }
      if (this.pending) { this.afterConfirmAsked(); return; }
      if (this.speaker) {
        this.speaker.flush();
        // If nothing was ever queued (empty reply, or muted mid-turn) the 'idle'
        // state event never comes, so the loop would stall here.
        if (!this.speaker.active) this.afterSpeaking();
        else this.setPhase('speaking');   // still reading it out
      } else {
        this.afterSpeaking();
      }
    } else if (ev.type === 'error') {
      this.cue('error');
      this.addNote(ev.message);
      toast(ev.message, 'err');
      this.setPhase('idle');
    }
  }

  paintMeta() {
    if (this.closed) return;
    const secs = Math.floor((Date.now() - this.startedAt) / 1000);
    const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, '0');
    this.turnsEl.textContent = `${this.turns} turn${this.turns === 1 ? '' : 's'} · ${mm}:${ss}`;
  }

  /** A short tone, when the user has not turned them off. */
  cue(kind) { if (this.p.cues !== false) earcon(kind); }

  /**
   * Stop the loop without leaving. The alternative is closing the overlay, which
   * throws away the transcript — and "hold on a minute" is a thing that happens
   * constantly in a conversation you are having while doing something else.
   */
  togglePause() {
    this.paused = !this.paused;
    this.pauseBtn.classList.toggle('on', this.paused);
    this.pauseBtn.replaceChildren(icon(this.paused ? 'play' : 'stop'), this.paused ? 'Resume' : 'Pause');
    if (this.paused) {
      try { this.rec?.abort(); } catch { }
      this.rec = null;
      stopSpeaking();
      this.setPhase('idle');
      this.statusEl.textContent = 'Paused — press P or Resume when you are ready';
      this.cue('stop');
    } else {
      this.cue('listen');
      this.listen();
    }
  }

  /** Say the last answer again — for the times you were not in the room for it. */
  repeatLast() {
    const last = [...this.log.querySelectorAll('.vm-turn.is-assistant .vm-turn-text')].pop();
    if (!last?.textContent.trim()) { toast('nothing to repeat yet'); return; }
    if (!this.speaks) { toast('speech is muted — press M to turn it on'); return; }
    stopSpeaking();
    this.setPhase('speaking');
    const sp = speak(last.textContent, { onState: (s) => { if (s === 'idle' || s === 'cancelled') this.afterSpeaking(); } });
    if (!sp) this.afterSpeaking();
  }

  /**
   * Keep the conversation. A voice session is the easiest thing in the hub to lose —
   * it is already a real chat (so it is in the Chat app), but the thing you actually
   * want later is the gist in your daily note, next to everything else from that day.
   */
  async saveTranscript() {
    const turns = [...this.log.querySelectorAll('.vm-turn')].map((t) => {
      const who = t.classList.contains('is-you') ? 'You' : 'AIOS';
      const said = t.querySelector('.vm-turn-text')?.textContent.trim() || '';
      return said ? `**${who}:** ${said}` : '';
    }).filter(Boolean);
    if (!turns.length) { toast('nothing said yet'); return; }
    const when = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    try {
      await post('/vault/daily', { text: `### Voice session · ${when}\n\n${turns.join('\n\n')}` });
      toast('saved to today\'s note', 'ok');
    } catch (e) {
      // The usual cause is no vault connected, which is worth saying plainly rather
      // than as a raw error — the conversation is still in the Chat app either way.
      toast(/vault/i.test(e.message) ? 'No second brain connected — Settings → Vault' : e.message, 'err');
    }
  }

  /** A quiet aside in the transcript — tool activity, errors, state. */
  addNote(text) {
    this.log.append(el('div', { class: 'vm-note' }, icon('wrench'), text));
    this.scrollLog();
  }

  /** Keep the newest turn visible — unless the user has scrolled back to read. */
  scrollLog(force = false) {
    if (!force && !this.follow) return;
    this.follow = true;
    this.jumpBtn?.classList.remove('show');
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** A write is waiting on a yes. Show it, then listen for the answer. */
  showProposal(p) {
    this.propEl = el('div', { class: 'vm-prop' },
      el('div', { class: 'vm-prop-title' }, p.title),
      el('div', { class: 'vm-prop-summary' }, p.summary),
      el('div', { class: 'vm-prop-actions' },
        el('button', { class: 'btn sm primary', onclick: () => this.decide('confirm') }, 'Confirm'),
        el('button', { class: 'btn sm ghost', onclick: () => this.decide('discard') }, 'Discard')));
    this.log.append(this.propEl);
    this.scrollLog(true);   // a card needs a decision: always bring it into view
  }

  markProposal(p) {
    if (!this.propEl) return;
    this.propEl.dataset.status = p.status;
    this.propEl.querySelector('.vm-prop-actions')?.replaceChildren(
      el('span', { class: 'muted small' },
        p.status === 'confirmed' ? 'Added' : p.status === 'failed' ? (p.result || 'failed') : 'Discarded'));
  }

  /** The buttons, for when you ARE looking at the screen. */
  async decide(decision) {
    const p = this.pending;
    if (!p || !this.chatId) return;
    this.pending = null;
    stopSpeaking();
    try {
      const next = await post(`/chats/${this.chatId}/actions/${p.id}`, { decision });
      this.markProposal(next);
    } catch (e) { toast(e.message, 'err'); }
    if (this.p.handsFree) this.listen(); else this.setPhase('idle');
  }

  /**
   * The question has been asked out loud. Now listen for the answer — the spoken
   * "yes" travels as an ordinary message and the SERVER decides it is a decision
   * (see chat.settleByReply), so there is no second, divergent yes/no parser here.
   */
  afterConfirmAsked() {
    if (this.closed) return;
    this.speaker = null;
    this.setPhase('confirm');
    if (this.p.handsFree) setTimeout(() => { if (!this.closed && this.phase === 'confirm') this.listen(); }, 350);
  }

  /** The reply is over: either go back to listening, or wait to be tapped. */
  afterSpeaking() {
    if (this.closed) return;
    this.speaker = null;
    if (this.p.handsFree) setTimeout(() => { if (!this.closed && this.phase !== 'listening') this.listen(); }, 350);
    else this.setPhase('idle');
  }

  stopTurn() {
    if (this.chatId) wsSend({ t: 'chat.stop', chatId: this.chatId });
    stopSpeaking();
    this.setPhase('idle');
  }

  addTurn(role, text) {
    const body = el('div', { class: 'vm-turn-text' }, text);
    const head = el('div', { class: 'vm-turn-head' }, el('div', { class: 'vm-turn-role' }, role));
    const turn = el('div', { class: 'vm-turn is-' + role }, head, body);
    // Anything the AI says can be kept. This is the whole reason the feature exists:
    // a good spoken answer is gone the moment the session closes, and deciding
    // afterwards which ones were good is a job nobody does. So the button is on the
    // turn itself, and the question it was answering is captured with it.
    if (role === 'assistant') {
      turn.question = this.lastHeard;
      turn.keepBtn = el('button', {
        class: 'vm-keep', title: 'Keep this answer for later (S)', onclick: () => this.keep(turn),
      }, icon('star'), 'Keep');
      head.append(turn.keepBtn);
    }
    this.log.append(turn);
    this.scrollLog();
    return body;
  }

  // -------------------------------------------------------------- the answer bank

  /** Put one exchange in the bank, where the Interview app can find it later. */
  async keep(turn) {
    const answer = turn?.querySelector('.vm-turn-text')?.textContent.trim();
    if (!answer) { toast('nothing to keep yet'); return; }
    if (turn.dataset.kept) { toast('already kept'); return; }
    turn.dataset.kept = 'saving';
    try {
      await saveAnswer({
        question: turn.question || '',
        answer,
        sessionId: this.sessionId || '',
        chatId: this.chatId || '',
        topic: this.cfg?.topic || '',
      });
      turn.dataset.kept = '1';
      turn.keepBtn?.replaceChildren(icon('check'), 'Kept');
      toast('kept — review it in the Interview app', 'ok');
    } catch (e) {
      delete turn.dataset.kept;
      toast(e.message, 'err');
    }
  }

  /** The same thing without looking: keep whatever it said last. */
  keepLast() {
    const last = [...this.log.querySelectorAll('.vm-turn.is-assistant')].pop();
    if (!last) { toast('nothing to keep yet'); return; }
    this.keep(last);
  }

  // ------------------------------------------------------------------- teardown

  close() {
    if (this.closed) return;
    this.closed = true;
    document.removeEventListener('keydown', this.onKey);
    this.viz?.stop();
    this.stopWatchOutput();
    clearInterval(this.tick);
    setSpeechVisualization(false);
    try { this.rec?.abort(); } catch { }
    stopSpeaking();
    if (this.chatId) { try { wsSend({ t: 'chat.stop', chatId: this.chatId }); } catch { } }
    this.unsub?.();
    this.node.remove();
    document.body.classList.remove('vm-open');
    openInstance = null;
    document.dispatchEvent(new CustomEvent('aios:voicemode-closed', { detail: { chatId: this.chatId } }));
  }
}
