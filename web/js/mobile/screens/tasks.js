// Tasks — the planner, reduced to the two questions a phone gets asked:
// what is on today, and what is coming.
//
// Deliberately not a calendar grid. A month view on a 390px screen is legible only
// as a heat map, and the desktop already has one; what is missing away from the desk
// is ticking something off and adding the thing you just remembered.

import { get, post, patch, del } from '../../api.js';
import { el, fill, icon, toast, sheet, askSheet, confirmSheet, ICONS, loading, empty, errorBox, dayLabel, pullToRefresh, buzz } from '../ui.js';

export default async function tasksScreen({ host, params, ui }) {
  let view = params.view === 'all' ? 'all' : 'today';
  let data = { agenda: null, tasks: [], upcoming: [] };

  const seg = el('div', { class: 'm-seg' },
    ...[['today', 'Today'], ['all', 'All tasks']].map(([id, label]) => el('button', {
      class: 'm-seg-b' + (view === id ? ' is-on' : ''),
      onclick: (e) => {
        view = id;
        for (const b of seg.children) b.classList.toggle('is-on', b === e.currentTarget);
        render();
      },
    }, label)));

  const scroll = el('div', { class: 'm-scroll' });
  host.append(seg, scroll);

  ui.setTitle('Tasks');
  ui.setActions(
    ui.action('plus', 'New task', addTask),
    ui.action('refresh', 'Refresh', () => load()),
  );
  pullToRefresh(scroll, () => load());

  // ---------- rows ----------

  function taskRow(t) {
    const box = el('button', {
      class: 'm-tick' + (t.done ? ' is-on' : ''),
      'aria-label': t.done ? 'Mark not done' : 'Mark done',
      onclick: async (e) => {
        e.stopPropagation();
        box.classList.toggle('is-on');    // optimistic: the tick must feel instant
        buzz();
        try {
          await patch(`/planner/tasks/${t.id}`, { done: !t.done });
          t.done = !t.done;
          // A completed task leaves Today's list; re-render rather than leave a ghost.
          if (view === 'today') load();
        } catch (err) {
          box.classList.toggle('is-on');
          toast(err.message, 'err');
        }
      },
    }, el('span', { html: ICONS.check }));

    const overdue = t.due && !t.done && t.due < new Date().toISOString().slice(0, 10);

    return el('div', { class: 'm-row m-task' + (t.done ? ' is-done' : '') + (overdue ? ' is-late' : '') },
      box,
      el('button', {
        class: 'm-grow m-task-main',
        onclick: () => openTask(t),
      },
        el('div', { class: 'm-row-t' }, t.title),
        el('div', { class: 'm-row-m' }, [
          t.due ? dayLabel(t.due) : null,
          t.category || null,
          t.priority === 2 ? 'high' : t.priority === 1 ? 'medium' : null,
        ].filter(Boolean).join(' · '))),
    );
  }

  function eventRow(e) {
    return el('div', { class: 'm-row' },
      el('span', { class: 'm-row-kind' }, 'event'),
      el('div', { class: 'm-grow' },
        el('div', { class: 'm-row-t' }, e.title || 'Untitled'),
        el('div', { class: 'm-row-m' }, [e.time || e.start || '', e.location || ''].filter(Boolean).join(' · '))));
  }

  function reminderRow(r) {
    const done = !!r.loggedToday;
    return el('div', { class: 'm-row' },
      el('button', {
        class: 'm-tick' + (done ? ' is-on' : ''),
        'aria-label': 'Log reminder',
        onclick: async (ev) => {
          ev.currentTarget.classList.add('is-on');
          buzz();
          try { await post(`/planner/reminders/${r.id}/log`, {}); toast('Logged', 'ok'); load(); }
          catch (err) { toast(err.message, 'err'); load(); }
        },
      }, el('span', { html: ICONS.check })),
      el('div', { class: 'm-grow' },
        el('div', { class: 'm-row-t' }, r.title || 'Reminder'),
        el('div', { class: 'm-row-m' }, r.recur || r.time || '')));
  }

  function upcomingRow(u) {
    return el('div', { class: 'm-row' },
      el('span', { class: 'm-row-kind' }, u.kind === 'birthday' ? 'bday' : u.kind || ''),
      el('div', { class: 'm-grow' },
        el('div', { class: 'm-row-t' }, u.title + (u.age ? ` · ${u.age}` : '')),
        el('div', { class: 'm-row-m' }, dayLabel(u.date))));
  }

  // ---------- detail ----------

  function openTask(t) {
    sheet(t.title, (body, close) => {
      body.append(
        el('div', { class: 'm-prop-fs' },
          ...[['Due', t.due ? dayLabel(t.due) : 'no date'],
            ['Priority', ['none', 'medium', 'high'][t.priority || 0]],
            ['Category', t.category || '—'],
          ].map(([k, v]) => el('div', { class: 'm-prop-f' },
            el('span', { class: 'm-prop-fl' }, k), el('span', { class: 'm-prop-fv' }, v)))),
        t.notes ? el('p', { class: 'm-sheet-text' }, t.notes) : null,
        el('div', { class: 'm-actions' },
          el('button', { class: 'm-btn', onclick: async () => {
            const title = await askSheet('Rename task', { value: t.title });
            if (!title) return;
            try { await patch(`/planner/tasks/${t.id}`, { title }); close(); load(); }
            catch (e) { toast(e.message, 'err'); }
          } }, 'Rename'),
          el('button', { class: 'm-btn is-ghost is-danger', onclick: async () => {
            if (!await confirmSheet('Delete task?', t.title, { ok: 'Delete', danger: true })) return;
            try { await del(`/planner/tasks/${t.id}`); close(); toast('Deleted'); load(); }
            catch (e) { toast(e.message, 'err'); }
          } }, 'Delete')),
      );
    });
  }

  async function addTask() {
    const title = await askSheet('New task', { placeholder: 'What needs doing?', ok: 'Add' });
    if (!title) return;
    try {
      await post('/planner/tasks', { title, due: new Date().toISOString().slice(0, 10) });
      buzz();
      toast('Added', 'ok');
      load();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------- render ----------

  function render() {
    const { agenda, tasks, upcoming } = data;
    if (!agenda) return;

    if (view === 'all') {
      const open = tasks.filter(t => !t.done);
      const done = tasks.filter(t => t.done);
      return fill(scroll,
        open.length ? el('section', { class: 'm-section' },
          el('h2', { class: 'm-section-title' }, `Open · ${open.length}`),
          el('div', { class: 'm-rows' }, ...open.map(taskRow)))
          : empty('Nothing open', 'Everything is ticked off.'),
        done.length ? el('section', { class: 'm-section' },
          el('h2', { class: 'm-section-title' }, `Done · ${done.length}`),
          el('div', { class: 'm-rows' }, ...done.slice(0, 25).map(taskRow))) : null,
      );
    }

    const sections = [];
    if (agenda.overdue?.length) sections.push(el('section', { class: 'm-section' },
      el('h2', { class: 'm-section-title is-late' }, `Overdue · ${agenda.overdue.length}`),
      el('div', { class: 'm-rows' }, ...agenda.overdue.map(taskRow))));

    if (agenda.events?.length) sections.push(el('section', { class: 'm-section' },
      el('h2', { class: 'm-section-title' }, 'Events'),
      el('div', { class: 'm-rows' }, ...agenda.events.map(eventRow))));

    if (agenda.reminders?.length) sections.push(el('section', { class: 'm-section' },
      el('h2', { class: 'm-section-title' }, 'Reminders'),
      el('div', { class: 'm-rows' }, ...agenda.reminders.map(reminderRow))));

    if (agenda.tasks?.length) sections.push(el('section', { class: 'm-section' },
      el('h2', { class: 'm-section-title' }, 'Due today'),
      el('div', { class: 'm-rows' }, ...agenda.tasks.map(taskRow))));

    if (!sections.length) sections.push(el('div', { class: 'm-clear' },
      el('div', { class: 'm-clear-t' }, agenda.doneToday ? `Clear — ${agenda.doneToday} done today` : 'Nothing on today'),
      el('div', { class: 'm-clear-s' }, 'Pull down to refresh, or + to add something.')));

    if (upcoming?.length) sections.push(el('section', { class: 'm-section' },
      el('h2', { class: 'm-section-title' }, 'Coming up'),
      el('div', { class: 'm-rows' }, ...upcoming.slice(0, 6).map(upcomingRow))));

    fill(scroll, ...sections);
  }

  // ---------- load ----------

  async function load() {
    if (!data.agenda) fill(scroll, loading());
    try {
      const [agenda, tasks, upcoming] = await Promise.all([
        get('/planner/agenda'),
        get('/planner/tasks'),
        get('/planner/upcoming?limit=8').catch(() => []),
      ]);
      data = { agenda, tasks: Array.isArray(tasks) ? tasks : [], upcoming: Array.isArray(upcoming) ? upcoming : [] };
      render();
    } catch (e) {
      fill(scroll, errorBox(e, load));
    }
  }

  await load();
  return { unmount() { } };
}
