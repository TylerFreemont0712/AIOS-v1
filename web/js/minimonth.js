// Shared mini month-calendar — the Planner rail and the Home dashboard render
// the exact same widget. Pure renderer: callers own month/selection state and
// re-render on change. Styling lives under .mini-* in apps.css.

import { el } from './ui.js';

const DAY_MS = 86400_000;
const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);

/** The 6-week window a month grid shows — callers fetch events for this range. */
export function miniRange(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  return { start, end: addDays(start, 41) };
}

/**
 * Render a mini month into `node`.
 *   month:   Date anywhere inside the month to show
 *   selected: 'YYYY-MM-DD' to highlight (optional)
 *   events:  [{date, color}] → up to 3 dots per day
 *   onPick(dateStr), onMonth(newMonthDate)
 */
export function renderMiniMonth(node, { month, selected, events = [], onPick, onMonth }) {
  node.innerHTML = '';
  node.classList.add('mini-month');
  const y = month.getFullYear(), m = month.getMonth();
  const today = dayStr(new Date());

  const nav = (fn, label, title) => el('button', { class: 'mini-nav', title, onclick: () => onMonth?.(fn()) }, label);
  node.append(el('div', { class: 'mini-head' },
    nav(() => new Date(y - 1, m, 1), '«', 'Previous year'),
    nav(() => new Date(y, m - 1, 1), '‹', 'Previous month'),
    el('span', {
      class: 'mini-title', title: 'Back to this month',
      onclick: () => onMonth?.(new Date()),
    }, `${MONTHS[m].slice(0, 3)} ${y}`),
    nav(() => new Date(y, m + 1, 1), '›', 'Next month'),
    nav(() => new Date(y + 1, m, 1), '»', 'Next year')));

  const byDate = new Map();
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    const arr = byDate.get(e.date);
    if (arr.length < 3) arr.push(e.color || 'accent');
  }

  const grid = el('div', { class: 'mini-grid' }, ...WDAYS.map(w => el('div', { class: 'mini-wday' }, w[0])));
  const { start } = miniRange(month);
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const key = dayStr(d);
    const dots = byDate.get(key) || [];
    grid.append(el('div', {
      class: 'mini-cell' + (d.getMonth() !== m ? ' dim' : '') + (key === today ? ' today' : '') + (key === selected ? ' sel' : ''),
      onclick: () => onPick?.(key),
    },
      el('span', { class: 'mini-num' }, String(d.getDate())),
      dots.length ? el('span', { class: 'mini-dots' }, ...dots.map(c => el('i', { class: 'dot c-' + c }))) : null));
  }
  node.append(grid);
  return node;
}
