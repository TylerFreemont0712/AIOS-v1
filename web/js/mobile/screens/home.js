// Home — what you'd want to know in the four seconds after unlocking the phone.
//
// Ordered by how often it's the reason you opened the app at all: what's on today,
// what you've spent, then quick actions, then the state of the box itself. Every
// panel degrades to a quiet line rather than an error, because a hub with the local
// model switched off is a normal Tuesday, not a fault.

import { get } from '../../api.js';
import { el, fill, icon, money, compactMoney, dayLabel, relTime, loading, errorBox, empty, pullToRefresh, toast } from '../ui.js';

export default async function home({ host, ui, go }) {
  ui.setTitle('AIOS');
  ui.setActions(ui.action('refresh', 'Refresh', () => load(true)));

  const scroll = el('div', { class: 'm-scroll' });
  host.append(scroll);

  const greet = el('section', { class: 'm-hero' });
  const agendaBox = el('section', { class: 'm-section' });
  const moneyBox = el('section', { class: 'm-section' });
  const quickBox = el('section', { class: 'm-section' });
  const boxBox = el('section', { class: 'm-section' });
  fill(scroll, greet, agendaBox, moneyBox, quickBox, boxBox);

  pullToRefresh(scroll, () => load(true));

  // ---------- greeting + weather ----------

  function renderHero(weather, cfg) {
    const h = new Date().getHours();
    const part = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const name = cfg?.user?.name || '';
    const w = weather?.current;
    fill(greet,
      el('div', { class: 'm-hero-row' },
        el('div', { class: 'm-grow' },
          el('div', { class: 'm-hero-greet' }, name ? `${part}, ${name}` : part),
          el('div', { class: 'm-hero-date' }, new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))),
        w ? el('div', { class: 'm-hero-w' },
          el('div', { class: 'm-hero-w-emoji' }, w.emoji || ''),
          el('div', { class: 'm-hero-w-t' }, `${Math.round(w.temp)}°`),
          el('div', { class: 'm-hero-w-l' }, weather.place || '')) : null),
    );
  }

  // ---------- today ----------

  function renderAgenda(agenda, upcoming) {
    const rows = [];
    const add = (kind, title, meta, cls = '') => rows.push(
      el('div', { class: 'm-row ' + cls },
        el('span', { class: 'm-row-kind' }, kind),
        el('div', { class: 'm-grow' },
          el('div', { class: 'm-row-t' }, title),
          meta ? el('div', { class: 'm-row-m' }, meta) : null)));

    for (const e of agenda?.overdue || []) add('late', e.title || e.name || 'Untitled', e.date ? dayLabel(e.date) : 'overdue', 'is-late');
    for (const e of agenda?.events || []) add('event', e.title || 'Untitled', e.time || e.at || '');
    for (const r of agenda?.reminders || []) add('remind', r.title || r.name || 'Untitled', r.time || '');
    for (const t of agenda?.tasks || []) add('task', t.title || t.name || 'Untitled', t.due ? dayLabel(t.due) : '');

    // Nothing today is a normal, good state — show what's next instead of an empty box.
    if (!rows.length) {
      const next = (upcoming || []).slice(0, 3);
      fill(agendaBox,
        el('h2', { class: 'm-section-title' }, 'Today'),
        el('div', { class: 'm-clear' },
          el('div', { class: 'm-clear-t' }, agenda?.doneToday ? `Clear — ${agenda.doneToday} done today` : 'Nothing scheduled'),
          next.length ? el('div', { class: 'm-clear-s' }, `Next: ${next[0].title} · ${dayLabel(next[0].date)}`) : null),
      );
      return;
    }

    fill(agendaBox,
      el('div', { class: 'm-section-head' },
        el('h2', { class: 'm-section-title' }, 'Today'),
        el('button', { class: 'm-link', onclick: () => go('tasks') }, 'All')),
      el('div', { class: 'm-rows' }, ...rows.slice(0, 6)),
    );
  }

  // ---------- money ----------

  function renderMoney(ov) {
    if (!ov) return fill(moneyBox);
    const cur = ov.summary?.currency || ov.settings?.base || 'JPY';
    const spent = ov.summary?.spent || 0;
    const earned = ov.summary?.earned || 0;
    const net = ov.summary?.net || 0;
    const perDay = ov.summary?.avgSpendPerDay || 0;

    fill(moneyBox,
      el('div', { class: 'm-section-head' },
        el('h2', { class: 'm-section-title' }, 'This month'),
        el('button', { class: 'm-link', onclick: () => go('money') }, 'Open')),
      el('div', { class: 'm-stats' },
        stat('Spent', compactMoney(spent, cur), spent > 0 ? 'is-out' : ''),
        stat('Earned', compactMoney(earned, cur), earned > 0 ? 'is-in' : ''),
        stat('Net', compactMoney(net, cur), net < 0 ? 'is-out' : 'is-in')),
      perDay > 0 ? el('div', { class: 'm-note' }, `${money(Math.round(perDay), cur)} a day so far`) : null,
      (ov.pending?.length ? el('button', { class: 'm-inline-cta', onclick: () => go('money', { view: 'pending' }) },
        `${ov.pending.length} unsettled — review`) : null),
    );
  }

  const stat = (label, value, cls = '') => el('div', { class: 'm-stat ' + cls },
    el('div', { class: 'm-stat-v' }, value),
    el('div', { class: 'm-stat-l' }, label));

  // ---------- quick actions ----------

  function renderQuick() {
    const act = (iconName, label, onclick) => el('button', { class: 'm-quick', onclick },
      icon(iconName, 'm-quick-i'), el('span', {}, label));
    fill(quickBox,
      el('h2', { class: 'm-section-title' }, 'Quick'),
      el('div', { class: 'm-quick-grid' },
        act('camera', 'Snap receipt', () => go('money', { capture: '1' })),
        act('mic', 'Talk', () => go('chat', { voice: '1' })),
        act('chat', 'New chat', () => go('chat', { fresh: '1' })),
        act('note', 'Notes', () => go('notes'))),
    );
  }

  // ---------- the box ----------

  function renderBox(status, services, remote) {
    const chips = (services || []).filter(s => s.status === 'up' || s.status === 'down')
      .slice(0, 8)
      .map(s => el('span', { class: 'm-svc is-' + s.status, title: s.detail || '' }, s.name));

    const up = status?.uptime ? humanUptime(status.uptime) : '';
    fill(boxBox,
      el('div', { class: 'm-section-head' },
        el('h2', { class: 'm-section-title' }, 'The box'),
        el('button', { class: 'm-link', onclick: () => go('settings') }, 'Settings')),
      el('div', { class: 'm-boxcard' },
        el('div', { class: 'm-boxrow' },
          el('span', { class: 'm-boxrow-l' }, status?.host || 'AIOS'),
          el('span', { class: 'm-boxrow-v' }, up ? `up ${up}` : '—')),
        remote ? el('div', { class: 'm-boxrow' },
          el('span', { class: 'm-boxrow-l' }, 'Away access'),
          el('span', { class: 'm-boxrow-v ' + (remote.serve?.on ? 'is-ok' : remote.loggedIn ? 'is-warn' : '') },
            remote.serve?.on ? 'HTTPS on' : remote.loggedIn ? 'tailnet only' : 'not set up')) : null,
        chips.length ? el('div', { class: 'm-svcs' }, ...chips) : null),
    );
  }

  const humanUptime = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };

  // ---------- load ----------

  let loaded = false;
  async function load(isRefresh = false) {
    if (!loaded && !isRefresh) fill(scroll, loading());

    // Everything in parallel, and one slow/broken endpoint must not blank the page —
    // allSettled, then render whatever came back.
    const [cfg, weather, agenda, upcoming, ov, status, services, remote] = await Promise.allSettled([
      get('/config'), get('/weather'), get('/planner/agenda'), get('/planner/upcoming'),
      get('/finance/overview'), get('/status'), get('/services'), get('/remote/status'),
    ]);
    const v = (r) => r.status === 'fulfilled' ? r.value : null;

    if (!loaded) {
      loaded = true;
      fill(scroll, greet, agendaBox, moneyBox, quickBox, boxBox);
      pullToRefresh(scroll, () => load(true));
    }

    renderHero(v(weather), v(cfg));
    renderAgenda(v(agenda), v(upcoming));
    renderMoney(v(ov));
    renderQuick();
    renderBox(v(status), v(services), v(remote));

    if (isRefresh) toast('Refreshed');
  }

  await load();

  return { unmount() { } };
}
