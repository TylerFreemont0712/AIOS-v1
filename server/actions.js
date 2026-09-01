// Confirmable actions — the assistant proposes, you approve, then it happens.
//
// Chat used to run a small allow-list of additive writes outright: say "I spent 1200
// on lunch" and the row appeared. That is fine right up until the model mishears the
// amount, guesses a category, or files a payment on the wrong day — and the first you
// know of it is a number that does not reconcile weeks later. On the voice path it is
// worse, because "5万" and "5000" are one transcription error apart and nobody is
// looking at the screen.
//
// So every write the assistant wants to make now comes back as a PROPOSAL: one line
// of plain language, the fields laid out and editable, and a Confirm button. Nothing
// touches the ledger, the calendar or the vault until that button is pressed (or, in
// Voice mode, until you say yes).
//
// What lives here is the human-facing half: what each write is CALLED, how to say it
// in one line, which of its fields are worth showing, and what a sensible default is
// for the ones the model left out. The doing is still tools.js — an action is a
// promise to call a tool later, not a second implementation of it.
//
// Adding a new confirmable write is one entry in ACTIONS plus `confirm: true` on the
// tool. Anything not listed here keeps the old behaviour, so this is additive.

import { runTool } from './tools.js';
import * as finance from './finance.js';
import { loadConfig } from './config.js';
import { id as genId } from './util.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const today = () => new Date().toISOString().slice(0, 10);
const num = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const baseCurrency = () => { try { return finance.settings().baseCurrency; } catch { return 'JPY'; } };

/** Money as a person says it: no trailing .00 on a currency that has no minor unit. */
function money(amount, currency = baseCurrency()) {
  const n = num(amount);
  const digits = ['JPY', 'KRW', 'VND', 'IDR'].includes(currency) ? 0 : 2;
  return `${currency} ${n.toLocaleString('en-US', { maximumFractionDigits: digits })}`;
}

/** The same amount for a speaker rather than a reader — "50,000 yen", not "JPY 50,000". */
const CURRENCY_SPOKEN = { JPY: 'yen', USD: 'dollars', EUR: 'euros', GBP: 'pounds', KRW: 'won', CNY: 'yuan' };
function spokenMoney(amount, currency = baseCurrency()) {
  const word = CURRENCY_SPOKEN[currency] || currency;
  return `${num(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${word}`;
}

/** "today" / "tomorrow" / "on Friday the 5th" — a date said the way it is heard. */
function spokenDate(date) {
  if (!date) return 'today';
  const d = String(date).slice(0, 10);
  const t = today();
  if (d === t) return 'today';
  const dt = new Date(`${d}T00:00:00Z`), now = new Date(`${t}T00:00:00Z`);
  const days = Math.round((dt - now) / 86400000);
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1 && days < 7) return `on ${dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}`;
  return `on ${dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })}`;
}

const time12 = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return '';
  const h = Number(m[1]), mm = m[2];
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mm === '00' ? `${h12}${ampm}` : `${h12}:${mm}${ampm}`;
};

// ---------------------------------------------------------------- the registry

const field = (key, label, type, value, extra = {}) => ({ key, label, type, value: value ?? '', ...extra });

const financeCategories = (kind) => {
  try {
    const s = finance.settings();
    return kind === 'income' ? s.incomeCategories : s.expenseCategories;
  } catch { return []; }
};

export const ACTIONS = {
  finance_log: {
    icon: 'briefcase',
    title: (a) => (a.kind === 'income' ? 'Log income' : 'Log expense'),
    // The model is allowed to omit almost everything; the defaults have to be the
    // ones a person would assume, because they are what gets confirmed at a glance.
    normalize(a) {
      const kind = a.kind === 'income' ? 'income' : 'expense';
      const currency = String(a.currency || baseCurrency()).toUpperCase().slice(0, 3);
      const cats = financeCategories(kind);
      let category = String(a.category || '').trim();
      if (category && cats.length) {
        const hit = cats.find(c => c.toLowerCase() === category.toLowerCase());
        category = hit || category;
      }
      if (!category) {
        // Never guess "Main Job": that category sets is_main_job, and the monthly goal
        // measures side income, so a wrong guess here makes earnings vanish from the
        // one number the user is watching. Uncategorised income is Other Income.
        category = kind === 'income'
          ? (cats.find(c => /other/i.test(c)) || cats.find(c => !/main/i.test(c)) || 'Other Income')
          : 'Other';
      }
      return {
        kind, currency, category,
        amount: Math.abs(num(a.amount)),
        merchant: String(a.merchant || '').trim(),
        note: String(a.note || '').trim(),
        date: /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : today(),
      };
    },
    summary: (a) => [
      a.kind === 'income' ? 'Income' : 'Expense',
      money(a.amount, a.currency),
      a.merchant && `from ${a.merchant}`,
      `· ${a.category}`,
      `· ${a.date}`,
    ].filter(Boolean).join(' '),
    spoken: (a) => `Add ${spokenMoney(a.amount, a.currency)} of ${a.kind}`
      + (a.merchant ? ` from ${a.merchant}` : '')
      + ` under ${a.category}, ${spokenDate(a.date)}. Shall I?`,
    fields: (a) => [
      field('kind', 'Type', 'select', a.kind, { options: [['expense', 'Expense'], ['income', 'Income']] }),
      field('amount', 'Amount', 'number', a.amount),
      field('currency', 'Currency', 'text', a.currency, { width: 'xs' }),
      field('category', 'Category', 'select', a.category, { options: financeCategories(a.kind).map(c => [c, c]), free: true }),
      field('merchant', a.kind === 'income' ? 'Payer' : 'Merchant', 'text', a.merchant),
      field('date', 'Date', 'date', a.date),
      field('note', 'Note', 'text', a.note),
    ],
  },

  event_add: {
    icon: 'daily',
    title: () => 'Add to calendar',
    normalize: (a) => ({
      title: String(a.title || '').trim() || 'Event',
      date: /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : today(),
      start: /^\d{1,2}:\d{2}$/.test(a.start || '') ? a.start : '',
      end: /^\d{1,2}:\d{2}$/.test(a.end || '') ? a.end : '',
      recur: ['daily', 'weekly', 'monthly', 'yearly'].includes(a.recur) ? a.recur : '',
      notes: String(a.notes || '').trim(),
    }),
    summary: (a) => `${a.title} · ${a.date}${a.start ? ` ${a.start}${a.end ? `–${a.end}` : ''}` : ' (all day)'}${a.recur ? ` · repeats ${a.recur}` : ''}`,
    spoken: (a) => `Put "${a.title}" in the calendar ${spokenDate(a.date)}`
      + (a.start ? ` at ${time12(a.start)}` : ' all day')
      + (a.recur ? `, repeating ${a.recur}` : '') + '. Shall I?',
    fields: (a) => [
      field('title', 'Event', 'text', a.title, { wide: true }),
      field('date', 'Date', 'date', a.date),
      field('start', 'Starts', 'time', a.start),
      field('end', 'Ends', 'time', a.end),
      field('recur', 'Repeats', 'select', a.recur, { options: [['', 'Once'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']] }),
      field('notes', 'Notes', 'text', a.notes, { wide: true }),
    ],
  },

  task_add: {
    icon: 'check',
    title: () => 'Add a to-do',
    normalize: (a) => ({
      title: String(a.title || '').trim() || 'Task',
      due: /^\d{4}-\d{2}-\d{2}$/.test(a.due || '') ? a.due : '',
      priority: [0, 1, 2].includes(num(a.priority)) ? num(a.priority) : 0,
      notes: String(a.notes || '').trim(),
    }),
    summary: (a) => `${a.title}${a.due ? ` · due ${a.due}` : ' · no due date'}${a.priority ? ` · ${['', 'high', 'urgent'][a.priority]}` : ''}`,
    spoken: (a) => `Add a to-do, "${a.title}"${a.due ? `, due ${spokenDate(a.due)}` : ''}. Shall I?`,
    fields: (a) => [
      field('title', 'Task', 'text', a.title, { wide: true }),
      field('due', 'Due', 'date', a.due),
      field('priority', 'Priority', 'select', a.priority, { options: [[0, 'Normal'], [1, 'High'], [2, 'Urgent']] }),
      field('notes', 'Notes', 'text', a.notes, { wide: true }),
    ],
  },

  finance_budget_set: {
    icon: 'graph',
    title: () => 'Set a monthly budget',
    normalize: (a) => ({
      category: String(a.category || '').trim(),
      amount: Math.abs(num(a.amount)),
      month: /^\d{4}-\d{2}$/.test(a.month || '') ? a.month : '',
    }),
    summary: (a) => `${a.category}: ${money(a.amount)} a month${a.month ? ` (${a.month} only)` : ''}`,
    spoken: (a) => `Set the ${a.category} budget to ${spokenMoney(a.amount)} a month. Shall I?`,
    fields: (a) => [
      field('category', 'Category', 'select', a.category, { options: financeCategories('expense').map(c => [c, c]), free: true }),
      field('amount', 'Monthly cap', 'number', a.amount),
      field('month', 'Only for month', 'month', a.month),
    ],
  },

  finance_goal_set: {
    icon: 'star',
    title: () => 'Set the monthly goal',
    normalize: (a) => ({
      month: /^\d{4}-\d{2}$/.test(a.month || '') ? a.month : today().slice(0, 7),
      minGoal: Math.abs(num(a.minGoal)),
      majorGoal: Math.abs(num(a.majorGoal)),
    }),
    summary: (a) => `${a.month}: target ${money(a.minGoal)}${a.majorGoal ? ` · stretch ${money(a.majorGoal)}` : ''}`,
    spoken: (a) => `Set this month's income goal to ${spokenMoney(a.minGoal)}`
      + (a.majorGoal ? `, with a stretch target of ${spokenMoney(a.majorGoal)}` : '') + '. Shall I?',
    fields: (a) => [
      field('month', 'Month', 'month', a.month),
      field('minGoal', 'Target', 'number', a.minGoal),
      field('majorGoal', 'Stretch target', 'number', a.majorGoal),
    ],
  },

  quick_note: {
    icon: 'vault',
    title: () => 'Save a note',
    normalize: (a) => ({ text: String(a.text || '').trim(), title: String(a.title || '').trim() }),
    summary: (a) => `${a.title ? `"${a.title}" — ` : ''}${a.text.slice(0, 120)}${a.text.length > 120 ? '…' : ''}`,
    spoken: (a) => `Save that as a note${a.title ? `, called "${a.title}"` : ''}. Shall I?`,
    fields: (a) => [
      field('title', 'Title', 'text', a.title, { wide: true }),
      field('text', 'Note', 'textarea', a.text, { wide: true }),
    ],
  },

  daily_log: {
    icon: 'daily',
    title: () => "Add to today's note",
    normalize: (a) => ({ text: String(a.text || '').trim(), date: /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : today() }),
    summary: (a) => `${a.date} — ${a.text.slice(0, 140)}${a.text.length > 140 ? '…' : ''}`,
    spoken: () => 'Add that to your daily note. Shall I?',
    fields: (a) => [
      field('date', 'Date', 'date', a.date),
      field('text', 'Entry', 'textarea', a.text, { wide: true }),
    ],
  },

  vault_append: {
    icon: 'vault',
    title: () => 'Append to a note',
    normalize: (a) => ({ path: String(a.path || '').trim(), content: String(a.content || '').trim() }),
    summary: (a) => `${a.path} ← ${a.content.slice(0, 100)}${a.content.length > 100 ? '…' : ''}`,
    spoken: (a) => `Append that to ${a.path}. Shall I?`,
    fields: (a) => [
      field('path', 'Note', 'text', a.path, { wide: true }),
      field('content', 'Text to add', 'textarea', a.content, { wide: true }),
    ],
  },
};

export const isConfirmable = (tool) => Object.prototype.hasOwnProperty.call(ACTIONS, tool);

/** Every confirmable write, for the Settings list and the agent prompt. */
export const confirmableTools = () => Object.keys(ACTIONS);

// ------------------------------------------------------------------- proposals

/**
 * Turn a tool call into a proposal record. Pure — the caller decides where it is
 * stored (chat.js keeps it on the assistant message so it survives a reload).
 */
export function propose(tool, rawArgs = {}) {
  const spec = ACTIONS[tool];
  if (!spec) throw bad(`"${tool}" is not a confirmable action`);
  const args = spec.normalize ? spec.normalize(rawArgs || {}) : { ...rawArgs };
  return {
    id: genId(10),
    tool,
    icon: spec.icon || 'sparkle',
    title: spec.title(args),
    summary: spec.summary(args),
    spoken: (spec.spoken || spec.summary)(args),
    fields: spec.fields(args),
    args,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

/** Re-derive title/summary/fields after the user edits a field in the card. */
export function reshape(proposal, patch = {}) {
  const spec = ACTIONS[proposal.tool];
  if (!spec) throw bad(`"${proposal.tool}" is not a confirmable action`);
  const merged = { ...proposal.args, ...patch };
  const args = spec.normalize ? spec.normalize(merged) : merged;
  return {
    ...proposal, args,
    title: spec.title(args), summary: spec.summary(args),
    spoken: (spec.spoken || spec.summary)(args),
    fields: spec.fields(args),
  };
}

/**
 * Actually do it. Returns { ok, content } from the underlying tool — deliberately the
 * tool's own words, so the card reports what the ledger/planner actually said rather
 * than a second, prettier story about it.
 */
export async function execute(proposal) {
  const spec = ACTIONS[proposal.tool];
  if (!spec) throw bad(`"${proposal.tool}" is not a confirmable action`);
  if (proposal.status === 'confirmed') throw bad('that has already been done', 409);
  const r = await runTool(proposal.tool, proposal.args, {});
  return { ok: !r.isError, content: String(r.content || '').slice(0, 600) };
}

/** Whether the confirmation step is on at all (Settings → Chat). */
export const confirmEnabled = () => loadConfig().defaults?.confirmActions !== false;

// ------------------------------------------------------------- yes / no by voice

// Deliberately narrow. Anything not clearly an answer is treated as a NEW message
// rather than a decision, because misreading "no, wait — make it Tuesday" as a
// refusal loses the correction, and misreading a fresh question as a yes writes a
// row nobody asked for. Ambiguity means "not an answer".
// No \b: a word boundary is defined by \w, which no kana or kanji is, so "はい\b"
// matches nothing at all. The anchors do the work anyway — "yesterday" cannot match
// ^(yes)[\s.!。、]*$ because "terday" is left over.
const YES = /^(y|ya|yeah|yep|yes|yup|sure|ok|okay|okey|correct|confirm|confirmed|do it|go ahead|please do|sounds good|that's right|thats right|right|affirmative|はい|ハイ|うん|そう|そうです|お願い|おねがい|お願いします|おねがいします|いいよ|オッケー)[\s.!。、ー]*$/i;
const NO = /^(n|no|nope|nah|cancel|don't|dont|do not|stop|discard|forget it|never mind|nevermind|scrap that|wrong|incorrect|いいえ|いえ|いや|ちがう|違う|やめて|やめ|キャンセル|だめ|ダメ)[\s.!。、ー]*$/i;

/** 'yes' | 'no' | '' for an utterance answering a confirmation prompt. */
export function readDecision(text) {
  const t = String(text || '').trim().replace(/^[,\s]+/, '');
  if (!t) return '';
  if (YES.test(t)) return 'yes';
  if (NO.test(t)) return 'no';
  return '';
}
