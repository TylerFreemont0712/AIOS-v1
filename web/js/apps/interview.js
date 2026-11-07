// Interview — the practice room's other half.
//
// Voice mode is where an interview HAPPENS; this is where it is reviewed. The two
// halves matter equally: a spoken answer that was good is gone the moment the session
// closes, and an archive nobody re-reads is just a slower way of forgetting. So the
// bank is built as flashcards rather than as a transcript — the question shows, the
// answer is hidden until you ask for it, and the obvious next move on any card is to
// be asked it again out loud.
//
// Everything here is the same handful of records the overlay writes (server/
// interview.js). Nothing in this app can start a conversation of its own: "Practise"
// opens the hands-free screen, because that is the only place an interview belongs.

import { el, icon, toast, confirmBox, timeAgo, debounce } from '../ui.js';
import { renderMd } from '../markdown.js';
import { speak, stopSpeaking } from '../voice.js';
import {
  setupDialog, savedConfig, describe,
  listAnswers, updateAnswer, deleteAnswer, answerTopics, listSessions, deleteSession,
} from '../interview.js';
import { openVoiceMode } from '../voicemode.js';

const FOCUS_LABEL = {
  general: 'General', coding: 'Coding', systems: 'System design',
  language: 'Language', debugging: 'Debugging', behavioural: 'Behavioural',
};
const LEVEL_LABEL = { junior: 'Junior', mid: 'Mid', senior: 'Senior', staff: 'Staff' };

export default {
  id: 'interview', title: 'Interview', icon: 'briefcase', width: 1100, height: 760,

  mount(body, opts, win) {
    const S = win.interviewState = { answers: [], sessions: [], topic: '', q: '', focus: '', open: new Set() };
    const ui = {};

    // ---------- chrome ----------

    ui.search = el('input', {
      class: 'input sm', type: 'search', placeholder: 'Search questions, answers, notes…',
      oninput: debounce(() => { S.q = ui.search.value.trim(); refresh(); }, 220),
    });
    ui.focus = el('select', { class: 'input sm', onchange: () => { S.focus = ui.focus.value; refresh(); } },
      el('option', { value: '' }, 'Every focus'),
      ...Object.entries(FOCUS_LABEL).map(([v, l]) => el('option', { value: v }, l)));

    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl' }, 'Answer bank'),
      ui.count = el('span', { class: 'chip' }, '0'),
      el('span', { class: 'grow' }),
      ui.search, ui.focus,
      el('button', { class: 'btn sm primary', onclick: () => newSession() }, icon('mic'), 'New session'));

    ui.list = el('div', { class: 'iv-list' });

    ui.side = el('div', { class: 'side' },
      el('div', { class: 'side-head' },
        el('span', { class: 'ttl' }, 'Interview'),
        el('button', { class: 'btn sm ghost', title: 'Start a practice session', onclick: () => newSession() }, icon('plus'))),
      ui.rail = el('div', { class: 'side-list' }));

    body.append(el('div', { class: 'app-cols' }, ui.side, el('div', { class: 'main-pane' }, ui.head, ui.list)));

    // ---------- starting a session ----------

    /**
     * Configure, then hand over to the hands-free screen.
     *
     * `over` lets a card launch a session aimed at one question without disturbing the
     * saved defaults — the dialog is skipped entirely, because "ask me this again" is
     * one decision and should cost one click.
     */
    async function newSession(over) {
      const cfg = over ? { ...savedConfig(), ...over } : await setupDialog({ config: savedConfig() });
      if (!cfg) return;
      openVoiceMode({ config: cfg });
    }

    const practiseAgain = (a) => newSession({
      mode: 'interview', role: 'interviewer', topic: a.topic || '',
      focus: a.focus || 'general', level: a.level || 'mid',
      // The question is the point of this launch, so it goes in verbatim rather than
      // being paraphrased into the role description and asked in some other form.
      custom: a.question
        ? `Open with exactly this question, word for word: "${a.question}"\nThen follow up on the answer as normal.`
        : '',
    });

    // ---------- the rail: topics, then the sessions themselves ----------

    async function refreshRail() {
      let topics = [], sessions = [];
      try { [topics, sessions] = await Promise.all([answerTopics(), listSessions()]); }
      catch (e) { ui.rail.replaceChildren(el('div', { class: 'empty sm' }, e.message)); return; }
      S.sessions = sessions;

      const rows = [
        el('div', { class: 'side-item' + (S.topic ? '' : ' sel'), onclick: () => { S.topic = ''; refresh(); refreshRail(); } },
          'All answers', el('div', { class: 'sub' }, `${S.answers.length} kept`)),
      ];
      for (const t of topics) {
        rows.push(el('div', {
          class: 'side-item' + (S.topic === t.topic ? ' sel' : ''),
          onclick: () => { S.topic = t.topic; refresh(); refreshRail(); },
        }, t.topic, el('div', { class: 'sub' }, `${t.count} answer${t.count === 1 ? '' : 's'}`)));
      }

      rows.push(el('div', { class: 'side-sep' }, 'Sessions'));
      const runs = sessions.filter(s => s.mode === 'interview');
      if (!runs.length) rows.push(el('div', { class: 'empty sm' }, 'no interviews yet'));
      for (const s of runs.slice(0, 12)) {
        rows.push(el('div', { class: 'side-item' },
          el('div', { class: 'row' },
            el('span', { class: 'grow' }, s.label || s.topic || 'Interview'),
            el('button', {
              class: 'btn xs ghost', title: 'Run this setup again',
              onclick: (e) => { e.stopPropagation(); newSession({ mode: 'interview', role: s.role, topic: s.topic, focus: s.focus, level: s.level }); },
            }, icon('refresh')),
            el('button', {
              class: 'btn xs ghost danger', title: 'Forget this session (the chat itself is kept)',
              onclick: async (e) => { e.stopPropagation(); await deleteSession(s.id); refreshRail(); },
            }, icon('trash'))),
          el('div', { class: 'sub' }, `${timeAgo(s.updatedAt)} · ${s.saved || 0} kept`)));
      }
      ui.rail.replaceChildren(...rows);
    }

    // ---------- the bank ----------

    async function refresh() {
      try { S.answers = await listAnswers({ q: S.q, focus: S.focus, topic: S.topic }); }
      catch (e) { ui.list.replaceChildren(el('div', { class: 'empty' }, e.message)); return; }
      ui.count.textContent = String(S.answers.length);
      paint();
    }

    function paint() {
      if (!S.answers.length) {
        ui.list.replaceChildren(el('div', { class: 'empty' },
          icon('briefcase'),
          el('div', { class: 'big' }, S.q || S.topic || S.focus ? 'Nothing matches' : 'No answers kept yet'),
          el('div', {}, S.q || S.topic || S.focus
            ? 'Try a wider search.'
            : 'Start a session, and press Keep (or S) on any answer worth studying.')));
        return;
      }
      ui.list.replaceChildren(...S.answers.map(card));
    }

    /**
     * One kept exchange.
     *
     * The answer starts HIDDEN. That is the difference between an archive and a study
     * tool: the question alone is a prompt to answer it yourself, and revealing is the
     * moment you find out whether you would have.
     */
    function card(a) {
      const open = S.open.has(a.id);
      const bodyEl = el('div', { class: 'iv-a' });
      if (open) bodyEl.append(renderMd(a.answer || ''));

      const reveal = el('button', {
        class: 'btn sm' + (open ? ' ghost' : ''), onclick: () => {
          if (S.open.has(a.id)) S.open.delete(a.id); else S.open.add(a.id);
          paint();
        },
      }, icon(open ? 'chevD' : 'eye'), open ? 'Hide' : 'Show answer');

      const note = el('textarea', {
        class: 'input sm iv-note', rows: 2, placeholder: 'Your note — what you would say differently',
        onchange: async () => {
          try { await updateAnswer(a.id, { note: note.value }); a.note = note.value; toast('note saved', 'ok'); }
          catch (e) { toast(e.message, 'err'); }
        },
      });
      note.value = a.note || '';

      return el('div', { class: 'iv-card', dataset: { open: open ? '1' : '' } },
        el('div', { class: 'iv-q' }, a.question || '(no question recorded)'),
        el('div', { class: 'iv-meta' },
          a.topic ? el('span', { class: 'chip accent' }, a.topic) : null,
          el('span', { class: 'chip' }, FOCUS_LABEL[a.focus] || a.focus || 'General'),
          el('span', { class: 'chip' }, LEVEL_LABEL[a.level] || a.level || ''),
          a.role === 'candidate' ? el('span', { class: 'chip' }, 'model answer') : null,
          el('span', { class: 'muted small' }, timeAgo(a.createdAt))),
        bodyEl,
        open ? note : null,
        el('div', { class: 'iv-actions' },
          reveal,
          el('button', { class: 'btn sm ghost', title: 'Read it out loud', onclick: () => say(a) }, icon('speaker'), 'Listen'),
          el('button', { class: 'btn sm ghost', title: 'Be asked this again, out loud', onclick: () => practiseAgain(a) }, icon('mic'), 'Practise'),
          el('span', { class: 'grow' }),
          el('button', {
            class: 'btn sm ghost', title: 'Copy the answer', onclick: () => {
              navigator.clipboard?.writeText(a.answer || '').then(() => toast('copied', 'ok'), () => toast('could not copy', 'err'));
            },
          }, icon('files')),
          el('button', {
            class: 'btn sm ghost danger', title: 'Delete this answer', onclick: async () => {
              if (!await confirmBox('Delete this answer?', a.question || '', 'Delete')) return;
              try { await deleteAnswer(a.id); } catch (e) { return toast(e.message, 'err'); }
              S.open.delete(a.id);
              refresh(); refreshRail();
            },
          }, icon('trash'))));
    }

    /** Hear it rather than read it — the form it was given in, and the one being drilled. */
    function say(a) {
      stopSpeaking();
      if (!speak(a.answer || '')) toast('speech is off for this device — Settings → Voice');
    }

    // A session that just ended is the most likely reason this app is being looked at,
    // so the bank refreshes itself rather than waiting to be told.
    S.reload = () => { refresh(); refreshRail(); };
    document.addEventListener('aios:voicemode-closed', S.reload);
    S.off = () => document.removeEventListener('aios:voicemode-closed', S.reload);

    refresh().then(refreshRail);
  },

  // Apps stay mounted in the background, so coming back to this one has to re-read the
  // bank — answers kept from the overlay while it was hidden are exactly what you came
  // back to look at.
  reopen(win) { win.interviewState?.reload?.(); },
  unmount(win) { win.interviewState?.off?.(); },
};
