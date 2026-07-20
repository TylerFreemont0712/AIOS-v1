// Live app context: a compact, always-fresh brief of the user's life inside
// AIOS — planner (events, birthdays, tasks), important mail, and weather —
// injected into chat (and the agent prompt) so "what's going on tomorrow?"
// answers from the calendar without any tool calling. Fully sync: every source
// is a local read (weather comes from its cache and self-refreshes).

import { loadConfig } from './config.js';
import * as planner from './planner.js';
import { notifications } from './mail.js';
import { cachedWeather } from './weather.js';

const CAT_EMOJI = { work: '💼', birthday: '🎂', trip: '✈️', holiday: '🎉', major: '⭐', health: '🏥', social: '🎭' };
const dstr = (off) => planner.todayStr(new Date(Date.now() + off * 86400_000));
const wday = (off) => new Date(Date.now() + off * 86400_000).toLocaleDateString('en-US', { weekday: 'short' });

const evLine = (e) => `${CAT_EMOJI[e.category] || ''}${e.allDay || !e.start ? '' : e.start + ' '}${e.title}${e.kind === 'birthday' && e.age ? ` (turns ${e.age})` : ''}`.trim();

/** The brief as plain text, clipped to `chars`. days = how far ahead to detail.
 *  Always fresh (a few small local JSON reads) — deliberately not memoized so
 *  "add an event, ask again" never returns stale data. */
export function appContext({ chars = 1900, days = 3 } = {}) {
  const lines = [];
  const today = dstr(0);

  try {
    const events = planner.eventsInRange(today, dstr(days - 1));
    const tasks = planner.listTasks().filter(t => !t.done);
    for (let i = 0; i < days; i++) {
      const key = dstr(i);
      const dayEvents = events.filter(e => e.date === key).slice(0, 5).map(evLine);
      const dayTasks = tasks.filter(t => t.due === key).slice(0, 5).map(t => t.title);
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : wday(i);
      const parts = [];
      if (dayEvents.length) parts.push(dayEvents.join(' · '));
      if (dayTasks.length) parts.push(`tasks due: ${dayTasks.join('; ')}`);
      lines.push(`${label} (${key}): ${parts.join(' | ') || 'nothing scheduled'}`);
    }
    const overdue = tasks.filter(t => t.due && t.due < today);
    if (overdue.length) lines.push(`Overdue tasks (${overdue.length}): ${overdue.slice(0, 4).map(t => t.title).join('; ')}`);
    const horizon = dstr(days - 1);
    const upcoming = planner.upcoming(4).filter(u => u.date > horizon);
    if (upcoming.length) lines.push('Upcoming: ' + upcoming.map(u => `${CAT_EMOJI[u.category] || ''}${u.title}${u.kind === 'birthday' && u.age ? ` (turns ${u.age})` : ''} on ${u.date}`).join(' · '));
  } catch { /* planner empty/broken — the rest still helps */ }

  try {
    const inbox = notifications();
    if (inbox.items?.length) {
      lines.push(`Unread important mail (${inbox.items.length}): ` + inbox.items.slice(0, 3)
        .map(m => `${(m.from.replace(/<[^>]*>/g, '').replace(/"/g, '').trim() || m.from).slice(0, 28)} — ${m.subject.slice(0, 48)}`).join(' · '));
    }
  } catch { }

  try {
    const w = cachedWeather();
    if (w?.current) {
      const d0 = w.days?.[0], d1 = w.days?.[1];
      lines.push(`Weather${w.place ? ` (${w.place})` : ''}: ${w.current.emoji} ${w.current.temp}° ${w.current.label}${d0 ? ` · H ${d0.hi}° L ${d0.lo}°` : ''}${d1 ? ` · tomorrow ${d1.emoji} ${d1.hi}°/${d1.lo}°` : ''}`);
    }
  } catch { }

  if (!lines.length) return '';
  const nowStr = new Date().toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const block = `[Live app context — auto-generated from ${loadConfig().user?.name || 'the user'}'s AIOS planner/mail/weather. Trust it for day-to-day questions ("what's tomorrow?"); it refreshes every message. Don't recite it unprompted.]
Now: ${nowStr}
${lines.join('\n')}`;
  return block.length > chars ? block.slice(0, chars - 1) + '…' : block;
}
