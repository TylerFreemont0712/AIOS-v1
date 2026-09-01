// Interview mode — the hands-free screen as a practice room.
//
// Two features that are really one feature seen from either end:
//
//   AI as interviewer   it asks, you answer OUT LOUD, it probes the weakest part of
//                       what you said and raises the difficulty when you are solid
//   AI as candidate     you ask, it answers the way a strong candidate would answer
//                       in the room — which is the answer worth keeping and studying
//
// Neither needs a new conversation engine. An interview IS a chat with a very
// particular system prompt and no tools, so a session is an ordinary chat (it shows
// up in the Chat app, it scrolls, it survives a reload) plus a small config file
// remembering what its prompt was built from. Everything in this module is prompt
// composition and two small JSON stores.
//
// The answer bank is the point of the whole thing. A good spoken answer is gone the
// second the session closes unless something writes it down, so ANY turn can be kept
// as a question/answer pair — with the session's topic and level attached — and read
// or re-listened to later in the Interview app.
//
// Why the prompt is composed HERE and not in the browser: the same session has to be
// resumable from the phone view, a mid-session change of mode has to rewrite the
// chat's instructions atomically, and the shape of a spoken reply is not a piece of
// UI state. The client sends { mode, role, topic, ... }; the wording lives here.

import path from 'node:path';
import fs from 'node:fs';
import { DATA } from './config.js';
import { id as genId, now, readJSON, writeJSON, jsonDirIndex } from './util.js';
import * as chat from './chat.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const DIR = path.join(DATA, 'interview');
const SESSIONS = path.join(DIR, 'sessions');
const ANSWERS = path.join(DIR, 'answers');
const sessionFile = (id) => path.join(SESSIONS, id + '.json');
const answerFile = (id) => path.join(ANSWERS, id + '.json');

// ------------------------------------------------------------------- vocabulary
//
// Exported so the setup screen renders exactly the options this file knows how to
// turn into a prompt. A picker offering a mode the composer has never heard of is
// the classic way a feature like this rots.

/** How a spoken reply is shaped. This applies to EVERY voice session, not just interviews. */
export const STYLES = [
  ['natural', 'Natural', 'Conversational. Up to about six sentences.'],
  ['brief', 'Brief', 'Answer first, three sentences at most. For when you are moving.'],
  ['deep', 'In depth', 'Reasoning and trade-offs — still spoken plainly, never a document.'],
  ['socratic', 'Socratic', 'Gives you the smallest push that unblocks you, then asks. Makes you do the work.'],
];

export const LEVELS = [
  ['junior', 'Junior'],
  ['mid', 'Mid-level'],
  ['senior', 'Senior'],
  ['staff', 'Staff / lead'],
];

export const FOCUSES = [
  ['general', 'General', 'A mixed interview — whatever the role would actually ask.'],
  ['coding', 'Coding & algorithms', 'Data structures, complexity, the approach before the code.'],
  ['systems', 'System design', 'Requirements, components, bottlenecks, what breaks first.'],
  ['language', 'Language deep-dive', 'How the language and its runtime actually behave.'],
  ['debugging', 'Debugging & incidents', 'A symptom, and how you would corner the cause.'],
  ['behavioural', 'Behavioural', 'Conflict, ownership, failure — answered with real specifics.'],
];

export const MODES = [
  ['chat', 'Conversation', 'Ordinary hands-free chat, shaped for the ear.'],
  ['interview', 'Interview', 'A practice interview. Pick which side the AI plays.'],
];

export const ROLES = [
  ['interviewer', 'AI interviews me', 'It asks, you answer out loud, it probes.'],
  ['candidate', 'AI answers me', 'You ask; it answers as a strong candidate would. Keep the good ones.'],
];

const has = (list, v) => list.some(([k]) => k === v);

export const DEFAULT_CONFIG = {
  mode: 'chat',
  role: 'interviewer',
  style: 'natural',
  topic: '',
  level: 'mid',
  focus: 'general',
  language: '',       // '' = answer in whatever language the user speaks
  feedback: true,     // interviewer: two lines of coaching after each answer
  tools: false,       // an interview is answered from the head, not from a web search
  custom: '',
};

/** Coerce whatever the client sent into a config this file can compose from. */
export function normalize(input = {}) {
  const c = { ...DEFAULT_CONFIG, ...(input || {}) };
  return {
    mode: has(MODES, c.mode) ? c.mode : 'chat',
    role: has(ROLES, c.role) ? c.role : 'interviewer',
    style: has(STYLES, c.style) ? c.style : 'natural',
    level: has(LEVELS, c.level) ? c.level : 'mid',
    focus: has(FOCUSES, c.focus) ? c.focus : 'general',
    topic: String(c.topic || '').trim().slice(0, 200),
    language: String(c.language || '').trim().slice(0, 20),
    feedback: c.feedback !== false,
    tools: !!c.tools,
    custom: String(c.custom || '').trim().slice(0, 2000),
  };
}

// ------------------------------------------------------------ prompt composition

// Said, not written. This is the block that earns its place on every voice session:
// the shared chat prompt tells the model to "use markdown when it helps", which is
// exactly wrong when a speech synthesizer is going to read the result — asterisks
// become noise or silence, a table becomes a wall of pipes, and a fenced code block
// becomes the words "code block" (see speakableText in server/voice.js, which cleans
// up after a model that ignores this).
const SPOKEN = `You are being SPOKEN TO, and your reply will be read aloud by a speech synthesizer. It will be heard, not read.

- No markdown at all: no asterisks, headings, bullet points, numbered lists, tables, or code fences. They are heard as noise or silently dropped.
- Talk, do not write. Short sentences, one idea each. Contractions are fine.
- Say lists in prose: "three things — first X, then Y, and finally Z".
- Never read code out. Say what it does and name the call or the operator ("wrap it in a try, and swallow only the not-found case"). Offer to put it on screen if they want to see it.
- Numbers and symbols get said: "order n log n", "about two hundred milliseconds", "the arrow function".
- At most ONE question per reply, and it goes last.
- If you did not catch something, say so in one short sentence and ask them to say it again.

Their side of this conversation arrives through speech-to-text, so it has no punctuation and it mangles technical terms and proper nouns ("mutex" as "mute ex", "PostgreSQL" as "post grey"). Read through the transcription noise and answer what they obviously meant. Only ask them to repeat when the meaning — not the spelling — is genuinely unclear.`;

const STYLE_RULES = {
  natural: 'Length: about six sentences. Enough to be useful, short enough to stay a conversation.',
  brief: 'Length: three sentences at most, and the first one is the answer. Detail only if they ask for it.',
  deep: 'Length: up to about twelve sentences. Give the reasoning and the trade-off, not just the conclusion — but keep it spoken language the whole way.',
  socratic: 'They are practising, so do NOT hand over the whole answer. Give the smallest push that unblocks them, then ask the question that makes them find the rest. If they ask outright for the answer, or get it wrong twice, give it plainly.',
};

const FOCUS_RULES = {
  general: 'Cover the ground the role would actually cover, and move between areas rather than drilling one.',
  coding: 'Stay on data structures, algorithms and complexity. Ask for the approach and the cost BEFORE any code — this is spoken, so an approach explained well beats a line-by-line dictation every time.',
  systems: 'Stay on system design: requirements first, then the components, then where it falls over at ten times the load. Push on the trade-off they skipped.',
  language: 'Stay on how the language and its runtime actually behave — semantics, memory, concurrency, the standard library, the classic footguns.',
  debugging: 'Give a symptom and make them corner the cause. Ask what they would look at first and what that would rule out. Answer their diagnostic questions with realistic detail.',
  behavioural: 'Stay on real situations — conflict, ownership, a call that went wrong. Push for specifics: what THEY did, what happened, what they would change. Refuse vague answers politely and ask for the actual example.',
};

const LEVEL_RULES = {
  junior: 'Pitch it at a junior: fundamentals, clear thinking, and whether they can reason out loud. Do not expect scale or production war stories.',
  mid: 'Pitch it at a mid-level engineer: solid fundamentals plus practical judgment and awareness of trade-offs.',
  senior: 'Pitch it at a senior: judgment under ambiguity, trade-offs with reasons, failure modes, and what they would do when the obvious answer is wrong.',
  staff: 'Pitch it at staff level: scope beyond the ticket, second-order consequences, what they would say no to and why, and how they would bring others along.',
};

const subject = (c) => c.topic || 'general software engineering';

/**
 * The AI runs the interview.
 *
 * The rules that matter are the ones that stop it being a chatbot: one question at a
 * time (two questions in one turn is unanswerable out loud), no praise reflex, and a
 * follow-up on the weak part instead of a polite move to the next topic. A model left
 * to its own devices interviews like a quiz show — it asks, says "great answer!", and
 * asks something unrelated, which teaches nothing.
 */
function interviewerBlock(c) {
  const lines = [
    `You are conducting a live technical interview. The role is: ${subject(c)}.`,
    LEVEL_RULES[c.level],
    FOCUS_RULES[c.focus],
    '',
    'How you conduct it:',
    '- Ask ONE question, then stop and wait. Never stack two questions into one turn.',
    '- Probe. When an answer is thin, hand-wavy or partly wrong, follow up on the weakest part before moving on. When it is strong, go harder on the same thread rather than changing subject.',
    '- Stay in character. No "great question", no praise reflex, no summarising back what they just said. An interviewer nods and asks the next thing.',
    '- Do not accept a buzzword as an answer. Ask what it means here, or what it costs.',
    '- Keep your own turns short — you are the one listening.',
  ];
  lines.push(c.feedback
    ? '- After each answer, give at most two sentences of feedback naming the single most important thing that was missing or wrong, then ask the next question. No compliments unless the answer genuinely deserved one, and then only three words of it.'
    : '- Give NO feedback while the interview is running — no verdict, no hints, no encouragement. Just the next question. All assessment waits for the debrief.');
  lines.push(
    '',
    'When they say they are finished, or ask how they did, drop the character completely and give a debrief: what was genuinely strong, the two biggest gaps, and a model answer to the question they handled worst. That model answer is the thing they will keep, so make it the answer you would want to have given.',
    '',
    'Open with one sentence framing the interview, then your first question. Nothing else.');
  return lines.join('\n');
}

/**
 * The AI is the candidate — the case the user described as "model answers".
 *
 * So the shape is the deliverable: a strong spoken answer opens with the answer,
 * earns it, and lands somewhere. A model that free-associates for ninety seconds and
 * then says "but it depends" is useless as something to study afterwards.
 */
function candidateBlock(c) {
  return [
    `You are the CANDIDATE and the user is the interviewer. Answer as a strong ${LEVELS.find(([k]) => k === c.level)?.[1].toLowerCase() || 'mid-level'} candidate for: ${subject(c)}.`,
    FOCUS_RULES[c.focus],
    '',
    'They are recording these to study later, so every answer has to be a MODEL answer — the one they would want to have given, not a lecture on the topic.',
    '',
    'Shape every answer the same way:',
    '- One sentence that answers the question directly. No preamble, no restating the question.',
    '- Then the reason it is the answer: the mechanism, the cost, or the trade-off. Name real things — the actual complexity, the actual system, the actual failure mode.',
    '- Then, when it applies, what you would do in practice and why you would do that.',
    '',
    'Roughly forty-five to ninety seconds of speech. If the honest answer is "it depends", say straight away what it depends on and then answer both branches briefly. If you do not know, say so in one sentence and then say exactly how you would find out — that is a strong answer, not a weak one.',
    'Never bluff, and never pad. If the real answer is two sentences, give two sentences.',
    'Finish by offering ONE specific way to go deeper, phrased as an offer they can accept out loud. Not "let me know if you have questions".',
  ].join('\n');
}

/** The complete per-chat instructions for a voice session. */
export function buildSystem(input) {
  const c = normalize(input);
  const parts = [SPOKEN, STYLE_RULES[c.style]];

  if (c.mode === 'interview') {
    parts.push(c.role === 'candidate' ? candidateBlock(c) : interviewerBlock(c));
    // An interview is answered from the head. Tool chatter ("searching the web…")
    // in the middle of a question is both wrong for the exercise and, in a hands-free
    // session, eight seconds of silence the user cannot account for.
    if (!c.tools) parts.push('Answer from your own knowledge. Do not call tools, look anything up, or offer to.');
  } else if (c.topic) {
    parts.push(`Context for this conversation: ${c.topic}`);
  }

  if (c.language) parts.push(`Speak ${c.language}, whatever language they use.`);
  if (c.custom) parts.push(`Additional instructions from the user:\n${c.custom}`);
  return parts.filter(Boolean).join('\n\n');
}

/**
 * The message that starts the session, or '' when the user speaks first.
 *
 * Only the interviewer needs one: somebody has to ask the first question, and a
 * hands-free screen that opens by listening to silence is a screen where nothing
 * happens. It travels as an ordinary user message (so the model sees a normal turn)
 * and the voice client simply does not draw it in the transcript.
 */
export function kickoff(input) {
  const c = normalize(input);
  if (c.mode !== 'interview' || c.role !== 'interviewer') return '';
  return 'I am ready. Begin the interview with your first question.';
}

/** A short human label — the chip in the voice header, and the session list. */
export function describe(input) {
  const c = normalize(input);
  if (c.mode !== 'interview') return c.topic ? `Conversation · ${c.topic}` : 'Conversation';
  const who = c.role === 'candidate' ? 'AI answers' : 'AI interviews';
  return [who, c.topic || FOCUSES.find(([k]) => k === c.focus)?.[1]].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------- sessions

const sessionIndex = jsonDirIndex(SESSIONS, (s) => ({
  id: s.id, chatId: s.chatId, label: s.label, mode: s.mode, role: s.role,
  topic: s.topic, focus: s.focus, level: s.level,
  createdAt: s.createdAt, updatedAt: s.updatedAt, saved: s.saved || 0,
}));

export function listSessions({ limit = 40 } = {}) {
  return sessionIndex()
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, Math.max(1, Math.min(200, limit)));
}

export function getSession(id) {
  const s = readJSON(sessionFile(String(id || '')));
  if (!s) throw bad('interview session not found', 404);
  return s;
}

/**
 * Start a session: compose the prompt, open the chat it will live in, remember both.
 *
 * The chat is created with `context: false` — the shared prompt normally carries the
 * user's planner, inbox and profile so day-to-day questions answer from real data,
 * and an interviewer that knows about tomorrow's dentist appointment is an
 * interviewer that will eventually mention it.
 */
export function createSession(input = {}, { modelRef } = {}) {
  const cfg = normalize(input);
  const label = describe(cfg);
  const c = chat.createChat({
    modelRef,
    system: buildSystem(cfg),
    tools: cfg.mode === 'interview' ? cfg.tools : true,
    folder: cfg.mode === 'interview' ? 'Interview' : 'Voice',
    title: cfg.mode === 'interview' ? `Interview · ${label}` : label,
    context: cfg.mode !== 'interview',
  });
  const s = {
    id: genId(8), chatId: c.id, label, ...cfg,
    createdAt: now(), updatedAt: now(), saved: 0,
  };
  writeJSON(sessionFile(s.id), s);
  return { session: s, chat: c, kickoff: kickoff(cfg) };
}

/**
 * Change the session mid-conversation — the whole reason the config is stored rather
 * than baked into the prompt at creation. Switching from conversation to interview
 * (or swapping sides) rewrites the chat's instructions in place, so the transcript so
 * far is kept and the next turn is played under the new rules.
 */
export function updateSession(id, patch = {}) {
  const s = getSession(id);
  const cfg = normalize({ ...s, ...patch });
  const next = { ...s, ...cfg, label: describe(cfg), updatedAt: now() };
  writeJSON(sessionFile(s.id), next);
  try {
    chat.updateChat(s.chatId, {
      system: buildSystem(cfg),
      tools: cfg.mode === 'interview' ? cfg.tools : true,
      context: cfg.mode !== 'interview',
    });
  } catch (e) {
    // The chat can be gone (deleted from the Chat app) while the session file is
    // still here. That is recoverable — the caller opens a new chat — so it must not
    // take the config update down with it.
    if (e.status !== 404) throw e;
  }
  return { session: next, kickoff: kickoff(cfg) };
}

export function deleteSession(id) {
  try { fs.unlinkSync(sessionFile(String(id || ''))); } catch { /* already gone */ }
  return { deleted: true };
}

// -------------------------------------------------------------------- answer bank
//
// One file per saved answer, for the same reason chats are one file each: it is a
// store the user is expected to keep for years, edit by hand if they feel like it,
// and back up with the rest of the data directory.

const answerIndex = jsonDirIndex(ANSWERS, (a) => a);

const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n) : t; };

/** Keep a turn. `question` is what was asked; `answer` is the reply worth studying. */
export function saveAnswer(input = {}) {
  const answer = clip(input.answer, 20000);
  if (!answer) throw bad('nothing to save');

  let s = null;
  if (input.sessionId) { try { s = getSession(input.sessionId); } catch { /* session deleted */ } }

  const a = {
    id: genId(8),
    question: clip(input.question, 4000),
    answer,
    // The session is the source of truth for what this answer is ABOUT, so the
    // browser does not get to disagree with it — but a saved answer outlives its
    // session, so the fields are copied rather than referenced.
    topic: clip(input.topic ?? s?.topic ?? '', 200),
    focus: s?.focus || input.focus || 'general',
    level: s?.level || input.level || 'mid',
    role: s?.role || input.role || '',
    tags: Array.isArray(input.tags) ? input.tags.map(t => clip(t, 40)).filter(Boolean).slice(0, 12) : [],
    note: clip(input.note, 4000),
    sessionId: s?.id || '',
    chatId: input.chatId || s?.chatId || '',
    createdAt: now(), updatedAt: now(),
  };
  writeJSON(answerFile(a.id), a);

  if (s) {
    s.saved = (s.saved || 0) + 1;
    s.updatedAt = now();
    writeJSON(sessionFile(s.id), s);
  }
  return a;
}

export function getAnswer(id) {
  const a = readJSON(answerFile(String(id || '')));
  if (!a) throw bad('saved answer not found', 404);
  return a;
}

export function updateAnswer(id, patch = {}) {
  const a = getAnswer(id);
  if (patch.note !== undefined) a.note = clip(patch.note, 4000);
  if (patch.question !== undefined) a.question = clip(patch.question, 4000);
  if (patch.answer !== undefined) a.answer = clip(patch.answer, 20000);
  if (patch.topic !== undefined) a.topic = clip(patch.topic, 200);
  if (patch.tags !== undefined) {
    a.tags = Array.isArray(patch.tags) ? patch.tags.map(t => clip(t, 40)).filter(Boolean).slice(0, 12) : [];
  }
  a.updatedAt = now();
  writeJSON(answerFile(a.id), a);
  return a;
}

export function deleteAnswer(id) {
  try { fs.unlinkSync(answerFile(String(id || ''))); } catch { /* already gone */ }
  return { deleted: true };
}

/**
 * The bank, newest first, optionally filtered.
 *
 * Search is a plain substring match over the question, the answer and the tags. The
 * bank is measured in hundreds of entries, not millions, and a real index here would
 * be a second store to keep honest for no gain anybody would notice.
 */
export function listAnswers({ q = '', focus = '', topic = '', limit = 200 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return answerIndex()
    .filter(a => !focus || a.focus === focus)
    .filter(a => !topic || (a.topic || '').toLowerCase() === topic.toLowerCase())
    .filter(a => !needle
      || (a.question || '').toLowerCase().includes(needle)
      || (a.answer || '').toLowerCase().includes(needle)
      || (a.note || '').toLowerCase().includes(needle)
      || (a.topic || '').toLowerCase().includes(needle)
      || (a.tags || []).some(t => t.toLowerCase().includes(needle)))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, Math.max(1, Math.min(1000, limit)));
}

/** Distinct topics with counts — the filter rail in the Interview app. */
export function topics() {
  const counts = new Map();
  for (const a of answerIndex()) {
    const t = (a.topic || '').trim();
    if (t) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts].map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count);
}

/** Everything the setup screen needs to render itself, in one call. */
export function options() {
  return {
    modes: MODES, roles: ROLES, styles: STYLES, levels: LEVELS, focuses: FOCUSES,
    defaults: DEFAULT_CONFIG,
  };
}
