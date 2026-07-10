// Planner: weekly calendar with a todo panel below, and a right rail holding an
// interactive mini month + selected-day detail + upcoming major events (birthdays,
// trips, holidays). Modeled on the user's LocalSyncOrganization app, rebuilt for AIOS.

import { el, icon, toast, confirmBox, modal, askText } from '../ui.js';
import { get, post, patch, del } from '../api.js';
import { renderMiniMonth } from '../minimonth.js';

const DAY_MS = 86400_000;
const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CAT = {
  '': ['📅', 'General'], work: ['💼', 'Work'], birthday: ['🎂', 'Birthday'], trip: ['✈️', 'Trip'],
  holiday: ['🎉', 'Holiday'], major: ['⭐', 'Major'], health: ['🏥', 'Health'], social: ['🎭', 'Social'],
};
const COLORS = ['accent', 'blue', 'green', 'purple', 'orange', 'red', 'teal', 'pink'];
const NTH = ['1st', '2nd', '3rd', '4th', '5th'];

const ds = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromDs = (s) => new Date(s + 'T00:00:00');
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const prettyDay = (s) => fromDs(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const catEmoji = (c) => (CAT[c] || CAT[''])[0];

export default {
  id: 'planner', title: 'Planner', icon: 'daily', width: 1280, height: 800,

  mount(body, opts, win) {
    const S = win.plannerState = {
      view: 'week', anchor: new Date(), selected: ds(new Date()), mini: new Date(),
      events: [], miniEvents: [], tasks: [], upcoming: [], day: null,
      showDone: false, taskFilter: '', taskScope: 'day',
    };
    const ui = {};
    body.classList.add('col');
    const root = el('div', { class: 'app-cols', style: { flex: '1', minHeight: '0' } });
    body.append(root);

    // ================= layout =================

    ui.title = el('span', { class: 'ttl planner-title' });
    ui.center = el('div', { class: 'planner-center' });
    ui.todo = el('div', { class: 'planner-todo' });
    ui.mini = el('div', { class: 'mini-month' });
    ui.detail = el('div', { class: 'day-detail' });
    ui.upcoming = el('div', { class: 'upcoming' });

    const jump = el('input', { class: 'input jump-date', type: 'date', title: 'Jump to date' });
    jump.addEventListener('change', () => { if (jump.value) gotoDate(jump.value); });

    const seg = el('div', { class: 'seg' },
      ...[['week', 'Week'], ['month', 'Month']].map(([v, label]) => el('button', {
        class: 'seg-btn' + (S.view === v ? ' on' : ''), 'data-view': v,
        onclick: (e) => { S.view = v; for (const b of e.target.parentElement.children) b.classList.toggle('on', b.dataset.view === v); refresh(); },
      }, label)));

    const nav = (n) => () => {
      S.anchor = S.view === 'month' ? new Date(S.anchor.getFullYear(), S.anchor.getMonth() + n, 1) : addDays(S.anchor, n * 7);
      refresh();
    };
    const mainPane = el('div', { class: 'main-pane' },
      el('div', { class: 'pane-head' },
        el('button', { class: 'btn sm ghost', title: 'Previous', onclick: nav(-1) }, '‹'),
        el('button', { class: 'btn sm', onclick: () => gotoDate(ds(new Date())) }, 'Today'),
        el('button', { class: 'btn sm ghost', title: 'Next', onclick: nav(1) }, '›'),
        ui.title, jump, el('span', { class: 'grow' }), seg,
        el('button', { class: 'btn sm ghost', title: 'Manage birthdays', onclick: birthdayManager }, '🎂'),
        el('button', { class: 'btn sm ghost', title: 'Manage recurring reminders', onclick: reminderManager }, '⏰'),
        el('button', { class: 'btn sm primary', onclick: () => eventModal({ date: S.selected }) }, icon('plus'), 'Event')),
      ui.center, ui.todo);

    const rail = el('div', { class: 'planner-rail' }, ui.mini, ui.detail, ui.upcoming);
    root.append(mainPane, rail);
    // Home's mini calendar (and anything else) can deep-link to a date
    opts?.date ? gotoDate(String(opts.date)) : refresh();
    this.reopen = (w, o) => { if (o?.date) gotoDate(String(o.date)); };

    function gotoDate(dateStr) {
      S.selected = dateStr;
      S.anchor = fromDs(dateStr);
      S.mini = fromDs(dateStr);
      refresh();
    }

    // ================= data =================

    function range() {
      if (S.view === 'month') {
        const first = new Date(S.anchor.getFullYear(), S.anchor.getMonth(), 1);
        const start = addDays(first, -first.getDay());
        return { start, days: 42 };
      }
      return { start: addDays(S.anchor, -S.anchor.getDay()), days: 7 };
    }

    async function refresh() {
      const { start, days } = range();
      const miniFirst = new Date(S.mini.getFullYear(), S.mini.getMonth(), 1);
      const miniStart = addDays(miniFirst, -miniFirst.getDay());
      try {
        [S.events, S.tasks, S.upcoming, S.day, S.miniEvents] = await Promise.all([
          get(`/planner/events?from=${ds(start)}&to=${ds(addDays(start, days - 1))}`),
          get('/planner/tasks'),
          get('/planner/upcoming?limit=6'),
          get('/planner/agenda?date=' + S.selected),
          get(`/planner/events?from=${ds(miniStart)}&to=${ds(addDays(miniStart, 41))}`),
        ]);
      } catch (e) { toast(e.message, 'err'); return; }
      renderCenter(); renderTodo(); renderMini(); renderDetail(); renderUpcoming();
    }

    // ================= center: week strip / month grid =================

    const chip = (e, compact = false) => el('div', {
      class: `ev-chip c-${e.color || 'accent'}` + (compact ? ' compact' : ''),
      title: `${e.title}${e.notes ? '\n' + e.notes.slice(0, 200) : ''}`,
      onclick: (ev) => { ev.stopPropagation(); e.kind === 'birthday' ? birthdayModal({ id: e.birthdayId }) : eventModal(e); },
    },
      el('span', { class: 'ev-emoji' }, catEmoji(e.category)),
      e.allDay || !e.start ? null : el('span', { class: 'ev-time' }, e.start),
      `${e.title}${e.kind === 'birthday' && e.age ? ` (${e.age})` : ''}`);

    const dueChip = (t) => el('div', {
      class: 'ev-chip task' + (t.done ? ' done' : ''), title: t.title,
      onclick: (ev) => { ev.stopPropagation(); taskModal(t); },
    }, '☐ ' + t.title);

    function renderCenter() {
      ui.center.innerHTML = '';
      const { start } = range();
      ui.title.textContent = S.view === 'month'
        ? `${MONTHS[S.anchor.getMonth()]} ${S.anchor.getFullYear()}`
        : weekLabel(start);
      S.view === 'week' ? renderWeek(start) : renderMonth(start);
    }

    function weekLabel(start) {
      const end = addDays(start, 6);
      const f = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return `${f(start)} – ${f(end)}${end.getFullYear() !== new Date().getFullYear() ? ' ' + end.getFullYear() : ''}`;
    }

    function renderWeek(start) {
      const today = ds(new Date());
      const strip = el('div', { class: 'week-strip' });
      for (let i = 0; i < 7; i++) {
        const d = addDays(start, i);
        const key = ds(d);
        const evs = S.events.filter(e => e.date === key);
        const due = S.tasks.filter(t => t.due === key && !t.done);
        const col = el('div', {
          class: 'wcol' + (key === today ? ' today' : '') + (key === S.selected ? ' sel' : ''),
          onclick: () => { S.selected = key; refresh(); },
          ondblclick: () => eventModal({ date: key }),
        },
          el('div', { class: 'wcol-head' },
            el('span', { class: 'wcol-wday' }, WDAYS[d.getDay()]),
            el('span', { class: 'wcol-num' }, String(d.getDate())),
            el('button', { class: 'wcol-add', title: 'Add event', onclick: (e) => { e.stopPropagation(); eventModal({ date: key }); } }, '+')),
          el('div', { class: 'wcol-body' },
            ...evs.map(e => chip(e)),
            ...due.map(dueChip),
            !evs.length && !due.length ? el('div', { class: 'wcol-empty' }, '·') : null));
        strip.append(col);
      }
      ui.center.append(strip);
    }

    function renderMonth(start) {
      const today = ds(new Date());
      const month = S.anchor.getMonth();
      const grid = el('div', { class: 'cal-month' }, ...WDAYS.map(w => el('div', { class: 'cal-wday' }, w)));
      for (let i = 0; i < 42; i++) {
        const d = addDays(start, i);
        const key = ds(d);
        const items = [...S.events.filter(e => e.date === key).map(e => chip(e, true)),
                       ...S.tasks.filter(t => t.due === key && !t.done).map(dueChip)];
        const cell = el('div', {
          class: 'cal-cell' + (d.getMonth() !== month ? ' dim' : '') + (key === today ? ' today' : '') + (key === S.selected ? ' sel' : ''),
          onclick: () => { S.selected = key; refresh(); },
          ondblclick: () => eventModal({ date: key }),
        },
          el('div', { class: 'cal-num' }, String(d.getDate())),
          ...items.slice(0, 3),
          items.length > 3 ? el('div', { class: 'cal-more', onclick: (e) => { e.stopPropagation(); S.selected = key; refresh(); } }, `+${items.length - 3} more`) : null);
        grid.append(cell);
      }
      ui.center.append(grid);
    }

    // ================= right rail: mini month =================

    function renderMini() {
      renderMiniMonth(ui.mini, {
        month: S.mini, selected: S.selected, events: S.miniEvents,
        onPick: gotoDate,
        onMonth: (d) => { S.mini = d; refresh(); },
      });
    }

    // ================= right rail: day detail =================

    function renderDetail() {
      ui.detail.innerHTML = '';
      const a = S.day;
      ui.detail.append(el('div', { class: 'rail-head' },
        el('span', { class: 'rail-title' }, prettyDay(S.selected)),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn sm ghost', title: 'Add event on this day', onclick: () => eventModal({ date: S.selected }) }, icon('plus'))));
      if (!a) return;
      const list = el('div', { class: 'detail-list' });
      for (const e of a.events) list.append(el('div', {
        class: 'detail-row', onclick: () => e.kind === 'birthday' ? birthdayModal({ id: e.birthdayId }) : eventModal(e),
      },
        el('span', { class: 'd-time c-' + (e.color || 'accent') }, e.allDay || !e.start ? '—' : e.start),
        el('span', { class: 'd-title' }, `${catEmoji(e.category)} ${e.title}${e.kind === 'birthday' && e.age ? ` (turns ${e.age})` : ''}`)));
      for (const r of a.reminders) {
        const box = el('input', {
          type: 'checkbox', onclick: async (ev) => {
            ev.stopPropagation();
            try { await post(`/planner/reminders/${r.id}/log`, { date: S.selected, undo: !ev.target.checked }); refresh(); }
            catch (e2) { toast(e2.message, 'err'); }
          },
        });
        box.checked = r.logged;
        list.append(el('div', {
          class: 'detail-row rem' + (r.logged ? ' done' : ''), title: r.notes || 'recurring reminder',
          onclick: async () => {
            const text = await askText({ title: r.title, sub: 'Log a note for today (marks it done)', value: r.logText || '', ok: 'Log' });
            if (text === null) return;
            try { await post(`/planner/reminders/${r.id}/log`, { date: S.selected, text }); refresh(); } catch (e2) { toast(e2.message, 'err'); }
          },
        }, box, el('span', { class: 'd-title' }, `⏰ ${r.title}${r.logText ? ` — ${r.logText.slice(0, 40)}` : ''}`)));
      }
      for (const t of a.tasks) {
        const box = el('input', {
          type: 'checkbox', onclick: async (ev) => {
            ev.stopPropagation();
            try { await patch('/planner/tasks/' + t.id, { done: true }); refresh(); } catch (e2) { toast(e2.message, 'err'); }
          },
        });
        list.append(el('div', { class: 'detail-row', onclick: () => taskModal(t) }, box, el('span', { class: 'd-title' }, t.title)));
      }
      if (!a.events.length && !a.reminders.length && !a.tasks.length) list.append(el('div', { class: 'muted small', style: { padding: '4px' } }, 'nothing on this day'));
      ui.detail.append(list);
    }

    // ================= right rail: upcoming =================

    function renderUpcoming() {
      ui.upcoming.innerHTML = '';
      ui.upcoming.append(el('div', { class: 'rail-head' }, el('span', { class: 'rail-title' }, 'Upcoming')));
      if (!S.upcoming.length) { ui.upcoming.append(el('div', { class: 'muted small', style: { padding: '4px' } }, 'no major events — set an event\'s category to Birthday/Trip/Holiday/Major, or add birthdays 🎂')); return; }
      const today = fromDs(ds(new Date()));
      for (const u of S.upcoming) {
        const days = Math.round((fromDs(u.date) - today) / DAY_MS);
        ui.upcoming.append(el('div', { class: 'up-card c-' + (u.color || 'accent'), onclick: () => gotoDate(u.date) },
          el('div', { class: 'up-date' }, prettyDay(u.date)),
          el('div', { class: 'up-title' }, `${catEmoji(u.category)} ${u.title}${u.kind === 'birthday' && u.age ? ` (turns ${u.age})` : ''}`),
          el('div', { class: 'up-days' }, days === 0 ? 'today!' : days === 1 ? 'tomorrow' : `in ${days} days`)));
      }
    }

    // ================= todo panel =================

    function renderTodo() {
      ui.todo.innerHTML = '';
      const today = ds(new Date());
      const week = ds(addDays(new Date(), 7));
      const dayMode = S.taskScope === 'day';
      const cats = [...new Set(S.tasks.map(t => t.category).filter(Boolean))].sort();
      const filter = el('select', { class: 'input select sm', onchange: (e) => { S.taskFilter = e.target.value; renderTodo(); } },
        el('option', { value: '' }, 'all categories'),
        ...cats.map(c => el('option', { value: c, selected: S.taskFilter === c }, c)));
      if (S.taskFilter && !cats.includes(S.taskFilter)) S.taskFilter = '';

      // scope: tasks for the day selected on the calendar, or everything grouped
      const scopeSeg = el('div', { class: 'seg' }, ...[['day', 'Day'], ['all', 'All']].map(([v, label]) => el('button', {
        class: 'seg-btn' + (S.taskScope === v ? ' on' : ''),
        onclick: () => { S.taskScope = v; renderTodo(); },
      }, label)));

      const title = el('input', { class: 'input', placeholder: dayMode ? `Add a task for ${prettyDay(S.selected)}… (Enter)` : 'Add a task… (Enter)', style: { flex: '1', minWidth: '160px' } });
      const due = el('input', { class: 'input task-due-input', type: 'date', title: 'Due date (optional)' });
      if (dayMode) due.value = S.selected;
      title.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' || !title.value.trim()) return;
        try {
          await post('/planner/tasks', { title: title.value.trim(), due: due.value || '', category: S.taskFilter });
          title.value = '';
          refresh();
        } catch (err) { toast(err.message, 'err'); }
      });
      ui.todo.append(el('div', { class: 'todo-head' },
        el('span', { class: 'rail-title' }, 'Tasks'),
        dayMode ? el('span', { class: 'muted small' }, prettyDay(S.selected)) : null,
        scopeSeg, filter, title, due));

      const list = el('div', { class: 'todo-list' });
      const visible = S.tasks.filter(t => !S.taskFilter || t.category === S.taskFilter);

      if (dayMode) {
        // the selected calendar day's tasks (+ overdue spill-over when that day is today)
        const dayTasks = visible.filter(t => t.due === S.selected);
        const open = dayTasks.filter(t => !t.done);
        const overdue = S.selected === today ? visible.filter(t => t.due && t.due < today && !t.done) : [];
        if (overdue.length) {
          list.append(el('div', { class: 'task-group overdue' }, 'Overdue', el('span', { class: 'task-count' }, String(overdue.length))));
          for (const t of overdue) list.append(taskRow(t));
        }
        if (open.length) {
          list.append(el('div', { class: 'task-group' }, S.selected === today ? 'Due today' : 'Due this day', el('span', { class: 'task-count' }, String(open.length))));
          for (const t of open) list.append(taskRow(t));
        }
        const done = dayTasks.filter(t => t.done);
        if (done.length) {
          list.append(el('div', { class: 'task-group done-toggle', onclick: () => { S.showDone = !S.showDone; renderTodo(); } },
            `${S.showDone ? '▾' : '▸'} Done`, el('span', { class: 'task-count' }, String(done.length))));
          if (S.showDone) for (const t of done.slice(-20).reverse()) list.append(taskRow(t));
        }
        if (!open.length && !overdue.length && !done.length) list.append(el('div', { class: 'muted small', style: { padding: '6px' } },
          `nothing due ${S.selected === today ? 'today' : 'on this day'} — add a task above, or switch to “All”`));
        ui.todo.append(list);
        return;
      }

      const open = visible.filter(t => !t.done);
      const groups = [
        ['Overdue', open.filter(t => t.due && t.due < today), 'overdue'],
        ['Today', open.filter(t => t.due === today), ''],
        ['Next 7 days', open.filter(t => t.due > today && t.due <= week), ''],
        ['Later / someday', open.filter(t => !t.due || t.due > week), ''],
      ];
      for (const [label, items, cls] of groups) {
        if (!items.length) continue;
        list.append(el('div', { class: 'task-group ' + cls }, label, el('span', { class: 'task-count' }, String(items.length))));
        for (const t of items) list.append(taskRow(t));
      }
      const done = visible.filter(t => t.done);
      if (done.length) {
        list.append(el('div', { class: 'task-group done-toggle', onclick: () => { S.showDone = !S.showDone; renderTodo(); } },
          `${S.showDone ? '▾' : '▸'} Done`, el('span', { class: 'task-count' }, String(done.length))));
        if (S.showDone) for (const t of done.slice(-20).reverse()) list.append(taskRow(t));
      }
      if (!visible.length) list.append(el('div', { class: 'muted small', style: { padding: '6px' } }, 'no tasks yet — add one above'));
      ui.todo.append(list);
    }

    function taskRow(t) {
      const today = ds(new Date());
      const box = el('input', {
        type: 'checkbox', onclick: async (e) => {
          e.stopPropagation();
          try { await patch('/planner/tasks/' + t.id, { done: e.target.checked }); refresh(); } catch (err) { toast(err.message, 'err'); }
        },
      });
      box.checked = t.done;
      return el('div', { class: 'task-row' + (t.done ? ' done' : ''), onclick: () => taskModal(t) },
        box,
        el('span', { class: 'task-title' }, t.title),
        t.category ? el('span', { class: 'task-cat' }, t.category) : null,
        t.priority ? el('span', { class: 'task-pri p' + t.priority }, 'P' + t.priority) : null,
        t.due ? el('span', { class: 'task-due' + (t.due < today && !t.done ? ' overdue' : '') }, t.due.slice(5)) : null);
    }

    // ================= modals =================

    const formRow = (label, ...nodes) => el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
      el('span', { class: 'muted small', style: { width: '68px', flex: 'none' } }, label), ...nodes);

    async function eventModal(e = {}) {
      const editing = !!e.id;
      const rec = e.recur || '';
      const recType = rec.startsWith('weekly') ? 'weekly' : rec.startsWith('nth_weekday') ? 'nth_weekday' : rec;
      const f = {
        title: el('input', { class: 'input', placeholder: 'Event title', value: e.title || '' }),
        date: el('input', { class: 'input', type: 'date', value: e.seriesDate || e.date || S.selected }),
        allDay: el('input', { type: 'checkbox' }),
        start: el('input', { class: 'input', type: 'time', value: e.start || '' }),
        end: el('input', { class: 'input', type: 'time', value: e.end || '' }),
        category: el('select', { class: 'input select' },
          ...Object.entries(CAT).map(([v, [em, label]]) => el('option', { value: v, selected: (e.category || '') === v }, `${em} ${label}`))),
        recur: el('select', { class: 'input select' },
          ...[['', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly (pick days)'], ['monthly', 'Monthly (same day)'], ['nth_weekday', 'Monthly (nth weekday)'], ['yearly', 'Yearly']]
            .map(([v, l]) => el('option', { value: v, selected: recType === v }, l))),
        until: el('input', { class: 'input', type: 'date', value: e.until || '', title: 'Repeat until (optional)' }),
        notes: el('textarea', { class: 'input', rows: 3, placeholder: 'Notes (optional)' }),
      };
      f.notes.value = e.notes || '';
      f.allDay.checked = e.allDay ?? !e.start;
      const syncTimes = () => { f.start.disabled = f.end.disabled = f.allDay.checked; };
      f.allDay.addEventListener('change', syncTimes); syncTimes();

      // weekly day checkboxes + nth-weekday selects, shown per recurrence type
      const recDays = new Set((rec.match(/^weekly:([\d,]+)/)?.[1] || '').split(',').filter(Boolean).map(Number));
      const dayBoxes = WDAYS.map((w, i) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = recDays.has(i);
        return el('label', { class: 'row small', style: { gap: '3px' } }, cb, w);
      });
      const weeklyRow = el('div', { class: 'row', style: { gap: '9px', flexWrap: 'wrap' } }, ...dayBoxes);
      const nthM = rec.match(/^nth_weekday:(\d+):(\d+)$/);
      const nthWeek = el('select', { class: 'input select' }, ...NTH.map((n, i) => el('option', { value: String(i + 1), selected: nthM ? +nthM[1] === i + 1 : false }, n)));
      const nthDay = el('select', { class: 'input select' }, ...WDAYS.map((w, i) => el('option', { value: String(i), selected: nthM ? +nthM[2] === i : false }, w)));
      const nthRow = el('div', { class: 'row', style: { gap: '6px' } }, nthWeek, nthDay, el('span', { class: 'muted small' }, 'of each month'));
      const recExtra = el('div', {});
      const syncRec = () => {
        recExtra.innerHTML = '';
        if (f.recur.value === 'weekly') recExtra.append(weeklyRow);
        if (f.recur.value === 'nth_weekday') recExtra.append(nthRow);
      };
      f.recur.addEventListener('change', syncRec); syncRec();

      let color = e.color || 'accent';
      const swatches = el('div', { class: 'color-row' },
        ...COLORS.map(c => el('button', {
          class: `color-swatch c-${c}` + (c === color ? ' on' : ''), title: c,
          onclick: (ev) => { color = c; for (const b of ev.target.parentElement.children) b.classList.toggle('on', b === ev.target); },
        })));

      const bodyEl = el('div', { class: 'col', style: { gap: '9px', marginTop: '8px', minWidth: '400px' } },
        f.title,
        formRow('Date', f.date, el('label', { class: 'row small muted', style: { gap: '5px' } }, f.allDay, 'all-day')),
        formRow('Time', f.start, el('span', { class: 'muted' }, '–'), f.end),
        formRow('Category', f.category),
        formRow('Repeat', f.recur), recExtra,
        formRow('Until', f.until),
        formRow('Color', swatches),
        f.notes,
        editing && e.recur ? el('div', { class: 'muted small' }, 'Repeating event — changes apply to the whole series.') : null);

      const buildRecur = () => {
        if (f.recur.value === 'weekly') {
          const days = dayBoxes.map((lbl, i) => lbl.querySelector('input').checked ? i : -1).filter(i => i >= 0);
          return days.length ? `weekly:${days.join(',')}` : 'weekly';
        }
        if (f.recur.value === 'nth_weekday') return `nth_weekday:${nthWeek.value}:${nthDay.value}`;
        return f.recur.value;
      };
      const actions = [];
      if (editing) actions.push({
        label: 'Delete', kind: 'ghost danger',
        onpick: async (close) => {
          if (!await confirmBox('Delete this event?', e.title + (e.recur ? ' (the whole series)' : ''))) return false;
          try { await del('/planner/events/' + e.id); close('deleted'); refresh(); } catch (err) { toast(err.message, 'err'); }
          return false;
        },
      });
      actions.push({ label: 'Cancel', value: null }, {
        label: editing ? 'Save' : 'Create', kind: 'primary',
        onpick: async (close) => {
          const payload = {
            title: f.title.value.trim(), date: f.date.value, allDay: f.allDay.checked,
            start: f.allDay.checked ? '' : f.start.value, end: f.allDay.checked ? '' : f.end.value,
            category: f.category.value, recur: buildRecur(), until: f.until.value || '', color, notes: f.notes.value,
          };
          if (!payload.title || !payload.date) { toast('title and date are required', 'err'); return false; }
          try {
            editing ? await patch('/planner/events/' + e.id, payload) : await post('/planner/events', payload);
            close('saved'); refresh();
          } catch (err) { toast(err.message, 'err'); }
          return false;
        },
      });
      await modal({ title: editing ? 'Edit event' : 'New event', body: bodyEl, actions });
    }

    async function taskModal(t) {
      const f = {
        title: el('input', { class: 'input', value: t.title }),
        due: el('input', { class: 'input', type: 'date', value: t.due || '' }),
        priority: el('select', { class: 'input select' },
          ...[[0, 'Normal'], [1, 'High'], [2, 'Urgent']].map(([v, l]) => el('option', { value: String(v), selected: t.priority === v }, l))),
        category: el('input', { class: 'input', value: t.category || '', placeholder: 'e.g. errands, work' }),
        notes: el('textarea', { class: 'input', rows: 3, placeholder: 'Notes' }),
      };
      f.notes.value = t.notes || '';
      await modal({
        title: 'Edit task',
        body: el('div', { class: 'col', style: { gap: '9px', marginTop: '8px', minWidth: '340px' } },
          f.title, formRow('Due', f.due), formRow('Priority', f.priority), formRow('Category', f.category), f.notes),
        actions: [
          { label: 'Delete', kind: 'ghost danger', onpick: async (close) => { if (!await confirmBox('Delete this task?', t.title)) return false; try { await del('/planner/tasks/' + t.id); close(); refresh(); } catch (e) { toast(e.message, 'err'); } return false; } },
          { label: 'Cancel', value: null },
          {
            label: 'Save', kind: 'primary',
            onpick: async (close) => {
              try {
                await patch('/planner/tasks/' + t.id, { title: f.title.value.trim(), due: f.due.value || '', priority: Number(f.priority.value), category: f.category.value.trim(), notes: f.notes.value });
                close(); refresh();
              } catch (e) { toast(e.message, 'err'); }
              return false;
            },
          },
        ],
      });
    }

    // ---------- birthdays ----------

    async function birthdayManager() {
      let all = [];
      try { all = await get('/planner/birthdays'); } catch (e) { toast(e.message, 'err'); return; }
      const search = el('input', { class: 'input', placeholder: 'search…', style: { flex: '1' } });
      const list = el('div', { class: 'col', style: { gap: '3px', maxHeight: '46vh', overflowY: 'auto', marginTop: '8px' } });
      const paint = () => {
        const q = search.value.trim().toLowerCase();
        list.innerHTML = '';
        for (const b of all.filter(x => !q || x.name.toLowerCase().includes(q))) {
          list.append(el('div', {
            class: 'detail-row',
            // close the manager before opening the editor so modals don't stack stale
            onclick: (ev) => { ev.target.closest('.modal-overlay')?.remove(); birthdayModal(b); },
          },
            el('span', { class: 'd-title' }, `🎂 ${b.name}`),
            el('span', { class: 'muted small' }, `${MONTHS[b.month - 1].slice(0, 3)} ${b.day}${b.year ? ` · ${b.year}` : ''}`)));
        }
        if (!list.children.length) list.append(el('div', { class: 'muted small' }, 'no birthdays yet'));
      };
      search.addEventListener('input', paint);
      paint();
      modal({
        title: 'Birthdays', sub: 'They appear on the calendar and in Upcoming every year.',
        body: el('div', {}, el('div', { class: 'row', style: { marginTop: '8px' } }, search), list),
        actions: [
          { label: '+ Add birthday', onpick: (close) => { close(); birthdayModal({}); } },
          { label: 'Close', kind: 'primary' },
        ],
      });
    }

    async function birthdayModal(b = {}) {
      if (b.id && b.name === undefined) {
        try { b = (await get('/planner/birthdays')).find(x => x.id === b.id) || b; } catch { }
      }
      const editing = !!b.id;
      const f = {
        name: el('input', { class: 'input', value: b.name || '', placeholder: 'Name' }),
        month: el('select', { class: 'input select' }, ...MONTHS.map((mn, i) => el('option', { value: String(i + 1), selected: (b.month || 1) === i + 1 }, mn))),
        day: el('input', { class: 'input', type: 'number', min: 1, max: 31, value: b.day || 1, style: { width: '70px' } }),
        year: el('input', { class: 'input', type: 'number', placeholder: 'year (opt.)', value: b.year || '', style: { width: '110px' } }),
        notes: el('input', { class: 'input', value: b.notes || '', placeholder: 'notes (gift ideas…)' }),
      };
      const actions = [];
      if (editing) actions.push({
        label: 'Delete', kind: 'ghost danger',
        onpick: async (close) => {
          if (!await confirmBox('Delete this birthday?', b.name)) return false;
          try { await del('/planner/birthdays/' + b.id); close(); refresh(); } catch (e) { toast(e.message, 'err'); }
          return false;
        },
      });
      actions.push({ label: 'Cancel', value: null }, {
        label: editing ? 'Save' : 'Add', kind: 'primary',
        onpick: async (close) => {
          const payload = { name: f.name.value.trim(), month: +f.month.value, day: +f.day.value, year: +f.year.value || 0, notes: f.notes.value };
          if (!payload.name) { toast('name is required', 'err'); return false; }
          try {
            editing ? await patch('/planner/birthdays/' + b.id, payload) : await post('/planner/birthdays', payload);
            close(); refresh();
          } catch (e) { toast(e.message, 'err'); }
          return false;
        },
      });
      await modal({
        title: editing ? 'Edit birthday' : 'New birthday',
        body: el('div', { class: 'col', style: { gap: '9px', marginTop: '8px', minWidth: '340px' } },
          f.name, formRow('Date', f.month, f.day), formRow('Year', f.year), f.notes),
        actions,
      });
    }

    // ---------- reminders ----------

    const recurLabel = (r) => {
      if (r === 'daily') return 'every day';
      if (r === 'monthly') return 'monthly';
      if (r === 'yearly') return 'yearly';
      const w = r.match(/^weekly(?::([\d,]+))?$/);
      if (w) return 'weekly' + (w[1] ? ` (${w[1].split(',').map(i => WDAYS[+i]).join(', ')})` : '');
      const n = r.match(/^nth_weekday:(\d+):(\d+)$/);
      if (n) return `${NTH[+n[1] - 1]} ${WDAYS[+n[2]]} monthly`;
      return r || 'once';
    };

    async function reminderManager() {
      let all = [];
      try { all = await get('/planner/reminders'); } catch (e) { toast(e.message, 'err'); return; }
      const list = el('div', { class: 'col', style: { gap: '3px', maxHeight: '46vh', overflowY: 'auto', marginTop: '8px' } });
      for (const r of all) {
        list.append(el('div', {
          class: 'detail-row',
          onclick: (ev) => { ev.target.closest('.modal-overlay')?.remove(); reminderModal(r); },
        },
          el('i', { class: 'dot c-' + r.color, style: { flex: 'none' } }),
          el('span', { class: 'd-title' }, r.title),
          el('span', { class: 'muted small' }, recurLabel(r.recur))));
      }
      if (!all.length) list.append(el('div', { class: 'muted small' }, 'no recurring reminders yet — things like "water the plants" or "weekly review"'));
      modal({
        title: 'Recurring reminders', sub: 'Soft habits — they show on their days with a check-off + note log.',
        body: list,
        actions: [
          { label: '+ Add reminder', onpick: (close) => { close(); reminderModal({}); } },
          { label: 'Close', kind: 'primary' },
        ],
      });
    }

    async function reminderModal(r = {}) {
      const editing = !!r.id;
      const rec = r.recur || 'daily';
      const recType = rec.startsWith('weekly') ? 'weekly' : rec;
      const f = {
        title: el('input', { class: 'input', value: r.title || '', placeholder: 'e.g. Water the plants' }),
        recur: el('select', { class: 'input select' },
          ...[['daily', 'Daily'], ['weekly', 'Weekly (pick days)'], ['monthly', 'Monthly'], ['yearly', 'Yearly']]
            .map(([v, l]) => el('option', { value: v, selected: recType === v }, l))),
        anchor: el('input', { class: 'input', type: 'date', value: r.anchor || ds(new Date()) }),
        notes: el('input', { class: 'input', value: r.notes || '', placeholder: 'notes' }),
      };
      const recDays = new Set((rec.match(/^weekly:([\d,]+)/)?.[1] || '').split(',').filter(Boolean).map(Number));
      const dayBoxes = WDAYS.map((w, i) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = recDays.has(i);
        return el('label', { class: 'row small', style: { gap: '3px' } }, cb, w);
      });
      const weeklyRow = el('div', { class: 'row', style: { gap: '9px', flexWrap: 'wrap' } }, ...dayBoxes);
      const recExtra = el('div', {});
      const syncRec = () => { recExtra.innerHTML = ''; if (f.recur.value === 'weekly') recExtra.append(weeklyRow); };
      f.recur.addEventListener('change', syncRec); syncRec();

      let color = r.color || 'green';
      const swatches = el('div', { class: 'color-row' },
        ...COLORS.map(c => el('button', {
          class: `color-swatch c-${c}` + (c === color ? ' on' : ''),
          onclick: (ev) => { color = c; for (const btn of ev.target.parentElement.children) btn.classList.toggle('on', btn === ev.target); },
        })));

      let logsEl = null;
      if (editing) {
        logsEl = el('div', { class: 'muted small', style: { maxHeight: '110px', overflowY: 'auto' } }, 'loading log…');
        get(`/planner/reminders/${r.id}/logs`).then(logs => {
          logsEl.innerHTML = '';
          logsEl.append(...(logs.length ? logs.map(l => el('div', {}, `✓ ${l.date}${l.text ? ` — ${l.text}` : ''}`)) : ['no log entries yet']));
        }).catch(() => { logsEl.textContent = ''; });
      }

      const buildRecur = () => {
        if (f.recur.value !== 'weekly') return f.recur.value;
        const days = dayBoxes.map((lbl, i) => lbl.querySelector('input').checked ? i : -1).filter(i => i >= 0);
        return days.length ? `weekly:${days.join(',')}` : 'weekly';
      };
      const actions = [];
      if (editing) actions.push({
        label: 'Delete', kind: 'ghost danger',
        onpick: async (close) => {
          if (!await confirmBox('Delete this reminder?', `${r.title} — its log entries go with it.`)) return false;
          try { await del('/planner/reminders/' + r.id); close(); refresh(); } catch (e) { toast(e.message, 'err'); }
          return false;
        },
      });
      actions.push({ label: 'Cancel', value: null }, {
        label: editing ? 'Save' : 'Add', kind: 'primary',
        onpick: async (close) => {
          const payload = { title: f.title.value.trim(), recur: buildRecur(), anchor: f.anchor.value, color, notes: f.notes.value };
          if (!payload.title) { toast('title is required', 'err'); return false; }
          try {
            editing ? await patch('/planner/reminders/' + r.id, payload) : await post('/planner/reminders', payload);
            close(); refresh();
          } catch (e) { toast(e.message, 'err'); }
          return false;
        },
      });
      await modal({
        title: editing ? 'Edit reminder' : 'New reminder',
        body: el('div', { class: 'col', style: { gap: '9px', marginTop: '8px', minWidth: '360px' } },
          f.title, formRow('Repeat', f.recur), recExtra, formRow('Starts', f.anchor), formRow('Color', swatches), f.notes,
          ...(logsEl ? [el('div', { class: 'muted small', style: { fontWeight: '600', marginTop: '4px' } }, 'Recent log'), logsEl] : [])),
        actions,
      });
    }
  },

  unmount() { },
};
