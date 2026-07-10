// Planner: calendar events with rich recurrence, birthdays, soft recurring
// reminders (with per-day logs), and a task list — one JSON file. Dates are plain
// 'YYYY-MM-DD' local strings, times 'HH:MM'; no timezone gymnastics on a
// single-machine hub. Modeled on the user's LocalSyncOrganization feature set.

import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { id as genId, now, readJSON, writeJSON } from './util.js';

const FILE = path.join(DATA, 'planner', 'planner.json');
const load = () => {
  const db = readJSON(FILE) || {};
  return { events: db.events || [], tasks: db.tasks || [], birthdays: db.birthdays || [], reminders: db.reminders || [], reminderLogs: db.reminderLogs || [] };
};
const save = (db) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); writeJSON(FILE, db); };

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;
const COLORS = ['accent', 'blue', 'green', 'purple', 'orange', 'red', 'teal', 'pink'];
export const CATEGORIES = ['', 'work', 'birthday', 'trip', 'holiday', 'major', 'health', 'social'];
const MAJOR_CATS = new Set(['birthday', 'trip', 'holiday', 'major']);

export const todayStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const assertDate = (s, what = 'date') => {
  if (!DATE_RX.test(String(s || ''))) throw Object.assign(new Error(`${what} must be YYYY-MM-DD`), { status: 400 });
  return s;
};
const cleanTime = (s) => { s = String(s || '').trim(); return TIME_RX.test(s) ? s : ''; };
const dparts = (s) => s.split('-').map(Number);
const weekdayOf = (s) => { const [y, m, d] = dparts(s); return new Date(y, m - 1, d).getDay(); }; // Sun=0

// ---------- recurrence ----------
// '' | daily | weekly | weekly:0,3 (JS weekdays, Sun=0) | monthly | yearly
// | nth_weekday:2:6 ("2nd Saturday"; both parts accept comma lists)

export function parseRecur(rec) {
  rec = String(rec || '');
  if (!rec) return { type: 'none' };
  if (['daily', 'monthly', 'yearly'].includes(rec)) return { type: rec };
  let m = rec.match(/^weekly(?::([0-6](?:,[0-6])*))?$/);
  if (m) return { type: 'weekly', days: m[1] ? [...new Set(m[1].split(',').map(Number))] : null };
  m = rec.match(/^nth_weekday:([1-5](?:,[1-5])*):([0-6](?:,[0-6])*)$/);
  if (m) return { type: 'nth_weekday', weeks: m[1].split(',').map(Number), days: m[2].split(',').map(Number) };
  return { type: 'none', invalid: true };
}

const cleanRecur = (rec) => (parseRecur(rec).invalid || !rec ? '' : String(rec));

/** Does a recurring thing anchored at `anchor` (with recur string) land on day d? */
export function recursOn({ anchor, recur, until }, d) {
  if (d < anchor) return false;
  if (until && d > until) return false;
  const r = parseRecur(recur);
  if (r.type === 'none') return anchor === d;
  const [ay, am, ad] = dparts(anchor);
  const [dy, dm, dd] = dparts(d);
  switch (r.type) {
    case 'daily': return true;
    case 'weekly': {
      const days = r.days || [weekdayOf(anchor)];
      return days.includes(weekdayOf(d));
    }
    case 'monthly': return ad === dd;
    case 'yearly': return am === dm && ad === dd;
    case 'nth_weekday': {
      const nth = Math.ceil(dd / 7);           // this date is the nth of its weekday in the month
      return r.days.includes(weekdayOf(d)) && r.weeks.includes(nth);
    }
    default: return anchor === d;
  }
}

export const occursOn = (e, d) => recursOn({ anchor: e.date, recur: e.recur, until: e.until }, d);

// ---------- events ----------

function sanitizeEvent(e, prev = {}) {
  const out = {
    id: prev.id || genId(8),
    title: String(e.title ?? prev.title ?? '').trim().slice(0, 200),
    date: e.date !== undefined ? assertDate(e.date) : (prev.date || todayStr()),
    start: e.start !== undefined ? cleanTime(e.start) : (prev.start || ''),
    end: e.end !== undefined ? cleanTime(e.end) : (prev.end || ''),
    allDay: e.allDay !== undefined ? !!e.allDay : (prev.allDay ?? false),
    recur: e.recur !== undefined ? cleanRecur(e.recur) : (prev.recur || ''),
    until: e.until !== undefined ? (e.until && DATE_RX.test(e.until) ? e.until : '') : (prev.until || ''),
    color: COLORS.includes(e.color) ? e.color : (prev.color || 'accent'),
    category: CATEGORIES.includes(e.category) ? e.category : (prev.category || ''),
    notes: String(e.notes ?? prev.notes ?? '').slice(0, 4000),
    createdAt: prev.createdAt || now(),
    updatedAt: now(),
  };
  if (!out.title) throw Object.assign(new Error('event title is required'), { status: 400 });
  if (!out.start) out.allDay = true;
  if (out.end && out.start && out.end <= out.start) out.end = '';
  return out;
}

export function addEvent(e) { const db = load(); const ev = sanitizeEvent(e || {}); db.events.push(ev); save(db); return ev; }
export function updateEvent(id, patch) {
  const db = load();
  const i = db.events.findIndex(x => x.id === id);
  if (i < 0) throw Object.assign(new Error('event not found'), { status: 404 });
  db.events[i] = sanitizeEvent(patch || {}, db.events[i]);
  save(db);
  return db.events[i];
}
export function deleteEvent(id) { const db = load(); db.events = db.events.filter(x => x.id !== id); save(db); }

// ---------- birthdays ----------

function sanitizeBirthday(b, prev = {}) {
  const out = {
    id: prev.id || genId(8),
    name: String(b.name ?? prev.name ?? '').trim().slice(0, 120),
    month: Math.min(12, Math.max(1, Number(b.month ?? prev.month) || 1)),
    day: Math.min(31, Math.max(1, Number(b.day ?? prev.day) || 1)),
    year: b.year !== undefined ? (Number(b.year) || 0) : (prev.year || 0),   // 0 = unknown
    notes: String(b.notes ?? prev.notes ?? '').slice(0, 1000),
    createdAt: prev.createdAt || now(),
    updatedAt: now(),
  };
  if (!out.name) throw Object.assign(new Error('birthday name is required'), { status: 400 });
  return out;
}

export function listBirthdays() { return load().birthdays.sort((a, b) => a.month - b.month || a.day - b.day || a.name.localeCompare(b.name)); }
export function addBirthday(b) { const db = load(); const bd = sanitizeBirthday(b || {}); db.birthdays.push(bd); save(db); return bd; }
export function updateBirthday(id, patch) {
  const db = load();
  const i = db.birthdays.findIndex(x => x.id === id);
  if (i < 0) throw Object.assign(new Error('birthday not found'), { status: 404 });
  db.birthdays[i] = sanitizeBirthday(patch || {}, db.birthdays[i]);
  save(db);
  return db.birthdays[i];
}
export function deleteBirthday(id) { const db = load(); db.birthdays = db.birthdays.filter(x => x.id !== id); save(db); }

/** Birthdays landing on day d, as synthetic all-day event instances. */
function birthdaysOn(db, d) {
  const [y, m, dd] = dparts(d);
  return db.birthdays.filter(b => b.month === m && b.day === dd).map(b => ({
    id: 'bd_' + b.id, birthdayId: b.id, kind: 'birthday',
    title: b.name, date: d, start: '', end: '', allDay: true,
    recur: 'yearly', until: '', color: 'pink', category: 'birthday',
    notes: b.notes, age: b.year ? y - b.year : 0,
  }));
}

// ---------- reminders (soft recurring, with per-day logs) ----------

function sanitizeReminder(r, prev = {}) {
  const out = {
    id: prev.id || genId(8),
    title: String(r.title ?? prev.title ?? '').trim().slice(0, 160),
    notes: String(r.notes ?? prev.notes ?? '').slice(0, 1000),
    color: COLORS.includes(r.color) ? r.color : (prev.color || 'green'),
    anchor: r.anchor !== undefined ? assertDate(r.anchor, 'anchor') : (prev.anchor || todayStr()),
    recur: r.recur !== undefined ? (cleanRecur(r.recur) || 'daily') : (prev.recur || 'daily'),
    createdAt: prev.createdAt || now(),
    updatedAt: now(),
  };
  if (!out.title) throw Object.assign(new Error('reminder title is required'), { status: 400 });
  return out;
}

export function listReminders() { return load().reminders.sort((a, b) => a.title.localeCompare(b.title)); }
export function addReminder(r) { const db = load(); const rem = sanitizeReminder(r || {}); db.reminders.push(rem); save(db); return rem; }
export function updateReminder(id, patch) {
  const db = load();
  const i = db.reminders.findIndex(x => x.id === id);
  if (i < 0) throw Object.assign(new Error('reminder not found'), { status: 404 });
  db.reminders[i] = sanitizeReminder(patch || {}, db.reminders[i]);
  save(db);
  return db.reminders[i];
}
export function deleteReminder(id) {
  const db = load();
  db.reminders = db.reminders.filter(x => x.id !== id);
  db.reminderLogs = db.reminderLogs.filter(l => l.templateId !== id);
  save(db);
}

/** Mark a reminder done (or update its note) for one day; text optional. */
export function logReminder(id, date, text = '') {
  const db = load();
  if (!db.reminders.some(r => r.id === id)) throw Object.assign(new Error('reminder not found'), { status: 404 });
  assertDate(date);
  const prev = db.reminderLogs.find(l => l.templateId === id && l.date === date);
  if (prev) { prev.text = String(text).slice(0, 500); prev.at = now(); }
  else db.reminderLogs.push({ templateId: id, date, text: String(text).slice(0, 500), at: now() });
  save(db);
}
export function unlogReminder(id, date) {
  const db = load();
  db.reminderLogs = db.reminderLogs.filter(l => !(l.templateId === id && l.date === date));
  save(db);
}
export function reminderLogs(id, limit = 30) {
  return load().reminderLogs.filter(l => l.templateId === id).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

/** Reminders due on day d, with logged state for that day. */
export function remindersOn(d, db = load()) {
  const logs = new Map(db.reminderLogs.filter(l => l.date === d).map(l => [l.templateId, l]));
  return db.reminders
    .filter(r => recursOn({ anchor: r.anchor, recur: r.recur, until: '' }, d))
    .map(r => ({ ...r, logged: logs.has(r.id), logText: logs.get(r.id)?.text || '' }));
}

// ---------- range expansion / upcoming ----------

/** Expand events + birthdays into per-day instances for [from, to] inclusive (≤ 62 days). */
export function eventsInRange(from, to) {
  assertDate(from, 'from'); assertDate(to, 'to');
  const db = load();
  const out = [];
  const start = new Date(from + 'T00:00:00');
  for (let i = 0; i < 62; i++) {
    const cur = new Date(start.getTime() + i * 86400_000);
    const d = todayStr(cur);
    if (d > to) break;
    for (const e of db.events) if (occursOn(e, d)) out.push({ ...e, date: d, seriesDate: e.date, kind: 'event' });
    out.push(...birthdaysOn(db, d));
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : (a.start || '').localeCompare(b.start || '')));
}

/** Next `limit` major events (birthdays + events in major categories), scanning ~13 months. */
export function upcoming(limit = 6, from = todayStr()) {
  assertDate(from, 'from');
  const db = load();
  const majors = db.events.filter(e => MAJOR_CATS.has(e.category));
  const out = [];
  const start = new Date(from + 'T00:00:00');
  for (let i = 0; i < 400 && out.length < limit; i++) {
    const d = todayStr(new Date(start.getTime() + i * 86400_000));
    for (const e of majors) if (occursOn(e, d)) out.push({ kind: 'event', id: e.id, date: d, title: e.title, category: e.category, color: e.color, start: e.start });
    for (const b of birthdaysOn(db, d)) out.push({ kind: 'birthday', id: b.birthdayId, date: d, title: b.title, category: 'birthday', color: b.color, age: b.age });
  }
  return out.slice(0, limit);
}

// ---------- tasks ----------

function sanitizeTask(t, prev = {}) {
  const out = {
    id: prev.id || genId(8),
    title: String(t.title ?? prev.title ?? '').trim().slice(0, 200),
    due: t.due !== undefined ? (t.due && DATE_RX.test(t.due) ? t.due : '') : (prev.due || ''),
    priority: [0, 1, 2].includes(Number(t.priority)) ? Number(t.priority) : (prev.priority ?? 0),
    category: String(t.category ?? prev.category ?? '').trim().slice(0, 40),
    notes: String(t.notes ?? prev.notes ?? '').slice(0, 4000),
    done: t.done !== undefined ? !!t.done : (prev.done ?? false),
    doneAt: prev.doneAt || '',
    createdAt: prev.createdAt || now(),
    updatedAt: now(),
  };
  if (!out.title) throw Object.assign(new Error('task title is required'), { status: 400 });
  out.doneAt = out.done ? (prev.done ? prev.doneAt : now()) : '';
  return out;
}

export function listTasks() {
  return load().tasks.sort((a, b) =>
    (a.done - b.done)
    || ((a.due || '9999').localeCompare(b.due || '9999'))
    || (b.priority - a.priority)
    || a.createdAt.localeCompare(b.createdAt));
}
export function addTask(t) { const db = load(); const task = sanitizeTask(t || {}); db.tasks.push(task); save(db); return task; }
export function updateTask(id, patch) {
  const db = load();
  const i = db.tasks.findIndex(x => x.id === id);
  if (i < 0) throw Object.assign(new Error('task not found'), { status: 404 });
  db.tasks[i] = sanitizeTask(patch || {}, db.tasks[i]);
  save(db);
  return db.tasks[i];
}
export function deleteTask(id) {
  const db = load();
  db.tasks = db.tasks.filter(x => x.id !== id);
  save(db);
}

// ---------- agenda ----------

/** One day, assembled: events + birthdays, reminders due, tasks due, open overdue. */
export function agenda(date = todayStr()) {
  assertDate(date);
  const db = load();
  const tasks = db.tasks;
  return {
    date,
    events: eventsInRange(date, date),
    reminders: remindersOn(date, db),
    tasks: tasks.filter(t => t.due === date && !t.done),
    overdue: tasks.filter(t => t.due && t.due < date && !t.done)
      .sort((a, b) => a.due.localeCompare(b.due)).slice(0, 20),
    doneToday: tasks.filter(t => t.done && (t.doneAt || '').slice(0, 10) === date).length,
  };
}
