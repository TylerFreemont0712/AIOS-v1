// Interview mode, browser side — the setup screen and the answer bank client.
//
// Shared by the hands-free overlay (voicemode.js) and the Interview app, because they
// are two views of one thing: the overlay is where a session HAPPENS and the app is
// where it is reviewed, and both need the same configuration, the same labels and the
// same "keep this answer" call.
//
// The configuration is remembered per device rather than per session. Setting up an
// interview is a dozen small decisions, and the second one you run is almost always
// the first one again with the topic changed — so the dialog opens where you left it.

import { el, toast, modal } from './ui.js';
import { get, post, patch, del } from './api.js';

const LS = 'aios.interview.config';

// Mirrors server/interview.js DEFAULT_CONFIG. Kept here too so the dialog can open
// (and the overlay can label itself) before the options call has come back.
export const DEFAULT_CONFIG = {
  mode: 'chat', role: 'interviewer', style: 'natural', topic: '',
  level: 'mid', focus: 'general', language: '', feedback: true, tools: false, custom: '',
};

let optionsCache = null;

/** The pickable values, from the server that will compose the prompt out of them. */
export async function options() {
  if (optionsCache) return optionsCache;
  try {
    optionsCache = await get('/interview/options');
  } catch (e) {
    // The overwhelmingly likely cause is a server that predates this feature and has
    // not been restarted, which otherwise shows up as an empty dialog with no reason.
    throw new Error(/404|not found/i.test(e.message)
      ? 'This AIOS server does not have interview mode yet — restart it (npm start) and try again.'
      : e.message);
  }
  return optionsCache;
}

export function savedConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(LS) || '{}') }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
export function rememberConfig(cfg) {
  try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch { /* private mode */ }
  return cfg;
}

/** A short label for a header chip — same shape as the server's describe(). */
export function describe(c) {
  if (!c || c.mode !== 'interview') return c?.topic ? `Conversation · ${c.topic}` : 'Conversation';
  const who = c.role === 'candidate' ? 'AI answers' : 'AI interviews';
  return [who, c.topic].filter(Boolean).join(' · ');
}

// --------------------------------------------------------------------- the dialog

const seg = (values, current, onpick) => {
  const wrap = el('div', { class: 'seg' });
  wrap.append(...values.map(([v, label, hint]) => el('button', {
    class: 'seg-btn' + (v === current ? ' on' : ''), title: hint || '', type: 'button',
    onclick: () => onpick(v),
  }, label)));
  return wrap;
};

const select = (values, current, onpick) => {
  const s = el('select', { class: 'input sm', onchange: () => onpick(s.value) },
    ...values.map(([v, label]) => el('option', { value: v, selected: v === current }, label)));
  return s;
};

const switchBtn = (on, fn) => el('button', {
  class: 'switch' + (on ? ' on' : ''), role: 'switch', type: 'button',
  'aria-checked': String(on), onclick: () => fn(!on),
});

const row = (name, sub, ...ctl) => el('div', { class: 'set-row' },
  el('div', { class: 'set-info' },
    el('div', { class: 'set-name' }, name),
    sub ? el('div', { class: 'set-sub' }, sub) : null),
  el('div', { class: 'set-ctl' }, ...ctl));

// Setting up an interview from nothing is the friction that stops you practising, so
// the topic field offers somewhere to start. Deliberately roles rather than
// technologies — "Senior backend engineer" produces a better interview than "Node".
const TOPIC_PICKS = [
  'Backend engineer — Node, Postgres',
  'Frontend engineer — React, TypeScript',
  'Full-stack engineer — small team',
  'Python / data engineering',
  'Infrastructure & reliability',
];

const LANGUAGES = [['', 'Follow me'], ['English', 'English'], ['Japanese', '日本語']];

/**
 * The customization screen behind the hands-free overlay.
 *
 * Resolves to a config object, or null if it was dismissed. Rows appear and disappear
 * with the mode — a "give feedback after each answer" switch means nothing when the AI
 * is the one being interviewed, and a dialog full of inapplicable settings is how you
 * end up with a feature nobody configures correctly.
 */
export async function setupDialog({ config, title = 'Voice & interview mode', ok = 'Start' } = {}) {
  let opts;
  try { opts = await options(); }
  catch (e) { toast(e.message, 'err'); return null; }

  const c = { ...DEFAULT_CONFIG, ...savedConfig(), ...(config || {}) };
  const bodyEl = el('div', { class: 'iv-setup' });

  const paint = () => {
    const rows = [];
    rows.push(row('Mode', 'What this hands-free session is for.',
      seg(opts.modes, c.mode, (v) => { c.mode = v; paint(); })));

    if (c.mode === 'interview') {
      rows.push(row('Which side', 'Who plays the interviewer.',
        seg(opts.roles, c.role, (v) => { c.role = v; paint(); })));

      const topic = el('input', {
        class: 'input sm', placeholder: 'Senior backend engineer — Node, Postgres',
        oninput: () => { c.topic = topic.value; },
      });
      topic.value = c.topic;
      rows.push(el('div', { class: 'set-row set-row-stack' },
        el('div', { class: 'set-info' },
          el('div', { class: 'set-name' }, 'The role'),
          el('div', { class: 'set-sub' }, 'Say it the way a job ad would. This is what the questions are pitched at.')),
        topic,
        el('div', { class: 'iv-picks' }, ...TOPIC_PICKS.map(t => el('button', {
          class: 'chip', type: 'button', onclick: () => { c.topic = t; topic.value = t; },
        }, t)))));

      rows.push(row('Level', 'How hard it goes at you.',
        select(opts.levels, c.level, (v) => { c.level = v; })));
      rows.push(row('Focus', opts.focuses.find(([k]) => k === c.focus)?.[2] || '',
        select(opts.focuses, c.focus, (v) => { c.focus = v; paint(); })));

      if (c.role === 'interviewer') {
        rows.push(row('Coach as it goes',
          'Two lines on what was missing after each answer. Off is closer to a real interview — you find out at the end.',
          switchBtn(c.feedback, (v) => { c.feedback = v; paint(); })));
      }
      rows.push(row('Let it look things up',
        'Off by default: an interview is answered from the head, and a web search mid-question is a silence you cannot account for.',
        switchBtn(c.tools, (v) => { c.tools = v; paint(); })));
    } else {
      const topic = el('input', {
        class: 'input sm', placeholder: 'Optional — what this session is about',
        oninput: () => { c.topic = topic.value; },
      });
      topic.value = c.topic;
      rows.push(row('Subject', 'Optional context for the conversation.', topic));
    }

    rows.push(row('Answer style', opts.styles.find(([k]) => k === c.style)?.[2] || '',
      select(opts.styles, c.style, (v) => { c.style = v; paint(); })));
    rows.push(row('Language', 'Which language it speaks, regardless of yours.',
      select(LANGUAGES, c.language, (v) => { c.language = v; })));

    const custom = el('textarea', {
      class: 'input sm', rows: 3,
      placeholder: 'Anything else — "push me on complexity", "no hints", "interrupt me if I ramble"',
      oninput: () => { c.custom = custom.value; },
    });
    custom.value = c.custom;
    rows.push(el('div', { class: 'set-row set-row-stack' },
      el('div', { class: 'set-info' },
        el('div', { class: 'set-name' }, 'In your own words'),
        el('div', { class: 'set-sub' }, 'Added to its instructions verbatim.')),
      custom));

    bodyEl.replaceChildren(...rows);
  };
  paint();

  const picked = await modal({
    title, sub: 'How the AI behaves when you talk to it. Changing this mid-session takes effect on the next thing you say.',
    wide: true, body: bodyEl,
    actions: [{ label: 'Cancel', value: null }, { label: ok, kind: 'primary', value: 'ok' }],
  });
  if (picked !== 'ok') return null;
  return rememberConfig({ ...c });
}

// ------------------------------------------------------------------- the API calls

/** Open a session: composes the prompt server-side and returns the chat to run it in. */
export const startSession = (config, modelRef) => post('/interview/sessions', { config, modelRef });

/** Change a running session. Rewrites the chat's instructions in place. */
export const patchSession = (id, config) => patch(`/interview/sessions/${id}`, { config });

export const listSessions = () => get('/interview/sessions');
export const deleteSession = (id) => del(`/interview/sessions/${id}`);

/** Keep a question/answer pair in the bank. */
export const saveAnswer = (body) => post('/interview/answers', body);
export const listAnswers = (q = {}) => get('/interview/answers?' + new URLSearchParams(
  Object.entries(q).filter(([, v]) => v !== '' && v !== undefined && v !== null)).toString());
export const updateAnswer = (id, body) => patch(`/interview/answers/${id}`, body);
export const deleteAnswer = (id) => del(`/interview/answers/${id}`);
export const answerTopics = () => get('/interview/topics');
