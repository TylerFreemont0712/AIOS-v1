// Home: greeting, quick stats, quick capture, launch cards — plus live rails:
// LEFT a mini calendar (the Planner's own widget), weather, the next 3 days of
// events, and today's tasks; RIGHT the AI-triaged inbox (Mail).

import { el, icon, toast } from '../ui.js';
import { get, post, patch } from '../api.js';
import { state, on } from '../state.js';
import { openApp } from '../wm.js';
import { renderMiniMonth, miniRange, dayStr, addDays } from '../minimonth.js';

const CAT_EMOJI = { birthday: '🎂 ', trip: '✈️ ', holiday: '🎉 ', major: '⭐ ', health: '🏥 ', social: '🎭 ' };

export default {
  id: 'home', title: 'Home', icon: 'home', width: 860, height: 620,

  mount(body, opts, win) {
    const root = el('div', { class: 'dash' });
    body.append(root);
    win._offs = [on('projects', () => render()), on('status', () => render())];
    const W = { mini: new Date() };   // mini-calendar month survives re-renders

    function weatherPanel(w) {
      const toSettings = () => openApp('settings', { tab: 'profile' });
      const head = el('div', { class: 'dash-panel-head' },
        el('span', { class: 'dash-panel-title', onclick: toSettings }, 'Weather'),
        el('span', { class: 'grow' }),
        w?.configured && w.current ? el('span', { class: 'muted small' }, `feels ${w.current.feels}°`) : null);
      if (!w || !w.configured) return el('div', { class: 'dash-panel' }, head,
        el('div', { class: 'muted small link', style: { padding: '2px 4px' }, onclick: toSettings },
          'set your location in Settings → Profile'));
      if (w.error) return el('div', { class: 'dash-panel' }, head,
        el('div', { class: 'muted small', style: { padding: '2px 4px' } }, w.error));
      const c = w.current;
      const d0 = w.days?.[0];
      const sub = [w.place, d0 ? `H ${d0.hi}° L ${d0.lo}°` : '', d0?.precip > 0 ? `☔ ${d0.precip}%` : ''].filter(Boolean).join(' · ');
      const wd = (s) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
      return el('div', { class: 'dash-panel' }, head,
        el('div', { class: 'weather-now', title: `humidity ${c.humidity}% · wind ${c.wind}${w.units === 'f' ? ' mph' : ' km/h'}` },
          el('span', { class: 'w-emoji' }, c.emoji),
          el('span', { class: 'w-temp' }, `${c.temp}°`),
          el('div', { class: 'w-meta' }, el('div', { class: 'w-label' }, c.label), el('div', { class: 'w-sub' }, sub))),
        (w.days || []).length > 1 ? el('div', { class: 'weather-days' },
          ...w.days.slice(1, 4).map(d => el('div', { class: 'w-day', title: d.label + (d.precip > 0 ? ` · ${d.precip}% precip` : '') },
            el('div', { class: 'w-day-name' }, wd(d.date)),
            el('div', { class: 'w-day-emoji' }, d.emoji),
            el('div', { class: 'w-day-temp' }, `${d.hi}° ${d.lo}°`)))) : null);
    }

    async function render() {
      const cfg = state.config || {};
      const name = cfg.user?.name || 'friend';
      const h = new Date().getHours();
      const greet = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';

      let vaultNotes = '—', chats = '—', maps = '—', services = [], agenda = null, inbox = null;
      try { vaultNotes = cfg.vault?.path ? String((await get('/vault/status')).notes) : '—'; } catch { }
      try { chats = String((await get('/chats')).length); } catch { }
      try { maps = String((await get('/mindmaps')).length); } catch { }
      try { services = await get('/services'); } catch { }
      try { agenda = await get('/planner/agenda'); } catch { }
      let mailStat = null;
      try { mailStat = await get('/mail/status'); if (mailStat.configured) inbox = await get('/mail/notifications'); } catch { }

      const todayKey = dayStr(new Date());
      let events3 = [], weatherData = null, miniEvents = [];
      try { events3 = await get(`/planner/events?from=${todayKey}&to=${dayStr(addDays(new Date(), 2))}`); } catch { }
      try { weatherData = await get('/weather'); } catch { }
      const mr = miniRange(W.mini);
      try { miniEvents = await get(`/planner/events?from=${dayStr(mr.start)}&to=${dayStr(mr.end)}`); } catch { }

      const s = state.status;
      const provLine = s
        ? [s.providers.anthropic.configured ? 'Anthropic ready' : null,
           s.providers.ollama.up ? `Ollama up (${s.providers.ollama.models} models)` : null]
          .filter(Boolean).join(' · ') || 'no providers configured yet — open Settings'
        : '';

      const capture = el('input', { class: 'input', placeholder: 'Quick capture to today\'s daily note…' });
      capture.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' || !capture.value.trim()) return;
        try { await post('/vault/daily', { text: capture.value.trim() }); capture.value = ''; toast('captured', 'ok'); }
        catch (err) { toast(err.message, 'err'); }
      });

      const card = (ic, title, sub, app, opts2) => {
        const c = el('div', { class: 'dash-card', onclick: () => openApp(app, opts2) },
          el('div', { class: 'd-ico' }, icon(ic)),
          el('div', { class: 'd-title' }, title),
          el('div', { class: 'd-sub' }, sub));
        return c;
      };

      // Modular services status — driven entirely by /api/services, so new services
      // (a probe registered in server/services.js) appear here automatically.
      const svcChip = (sv) => el('button', {
        class: 'svc-chip', title: `${sv.name} — ${sv.detail}`,
        onclick: () => openApp('settings', { tab: sv.settingsTab || 'providers' }),
      }, el('span', { class: 'svc-dot ' + (sv.status || 'unknown') }), el('span', { class: 'svc-name' }, sv.name),
        sv.detail ? el('span', { class: 'svc-detail' }, sv.detail) : null);
      const servicesEl = services.length ? el('div', { class: 'dash-services' },
        el('div', { class: 'svc-head' }, 'Services'),
        el('div', { class: 'svc-row' }, ...services.map(svcChip))) : null;

      // ---- rails: calendar/weather/events/tasks (left) + AI-triaged inbox (right) ----

      const sideCard = (title, appOrTab, headExtra, ...content) => el('div', { class: 'dash-panel' },
        el('div', { class: 'dash-panel-head' },
          el('span', { class: 'dash-panel-title', onclick: () => typeof appOrTab === 'function' ? appOrTab() : openApp(appOrTab) }, title),
          el('span', { class: 'grow' }), headExtra),
        ...content);

      // mini calendar — the Planner's own widget; any day click deep-links there
      const miniPanel = el('div', { class: 'dash-panel' });
      renderMiniMonth(miniPanel, {
        month: W.mini, events: miniEvents,
        onPick: (d) => openApp('planner', { date: d }),
        onMonth: (d) => { W.mini = d; render(); },
      });

      // next 3 days of events, grouped by day — 'work' category stays out of sight
      const evItems = [];
      const byDay = new Map();
      for (const e of events3.filter(e => e.category !== 'work')) {
        if (!byDay.has(e.date)) byDay.set(e.date, []);
        byDay.get(e.date).push(e);
      }
      const dayLabel = (key) => {
        if (key === todayKey) return 'Today';
        const d = new Date(key + 'T00:00:00');
        const rel = Math.round((d - new Date(todayKey + 'T00:00:00')) / 86400_000);
        return `${rel === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'long' })} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      };
      for (const [key, evs] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        evItems.push(el('div', { class: 'ag-day' }, dayLabel(key)));
        for (const e of evs.slice(0, 5)) evItems.push(el('div', { class: 'ag-item', onclick: () => openApp('planner', { date: key }) },
          el('span', { class: 'ag-time' }, e.allDay || !e.start ? 'all-day' : e.start),
          el('span', { class: 'ag-title' }, `${CAT_EMOJI[e.category] || ''}${e.title}${e.kind === 'birthday' && e.age ? ` (${e.age})` : ''}`)));
      }
      if (!evItems.length) evItems.push(el('div', { class: 'muted small', style: { padding: '2px 4px' } }, 'nothing coming up — click to plan'));

      // today's tasks (checkboxes) + overdue link
      const taskItems = [];
      if (agenda) {
        for (const t of agenda.tasks.slice(0, 8)) {
          const box = el('input', {
            type: 'checkbox', onclick: async (ev) => {
              ev.stopPropagation();
              try { await patch('/planner/tasks/' + t.id, { done: true }); toast('done ✓', 'ok'); render(); } catch (e2) { toast(e2.message, 'err'); }
            },
          });
          taskItems.push(el('div', { class: 'ag-item task' }, box, el('span', { class: 'ag-title' }, t.title)));
        }
        if (agenda.overdue.length) taskItems.push(el('div', {
          class: 'ag-overdue', onclick: () => openApp('planner'),
        }, `⚠ ${agenda.overdue.length} overdue task${agenda.overdue.length > 1 ? 's' : ''}`));
      }
      if (!taskItems.length) taskItems.push(el('div', { class: 'muted small', style: { padding: '2px 4px' } }, 'nothing due today — click to plan'));

      const scanBtn = el('button', {
        class: 'btn sm ghost', title: 'Scan inbox now',
        onclick: async (e) => {
          e.stopPropagation();
          scanBtn.disabled = true; scanBtn.innerHTML = ''; scanBtn.append(el('span', { class: 'spinner' }));
          try { const r = await post('/mail/scan', {}); toast(`scanned ${r.scanned} — ${r.important} important`, 'ok'); }
          catch (err) { toast(err.message, 'err'); }
          render();
        },
      }, icon('refresh'));

      const mailItems = [];
      if (inbox) {
        for (const m of inbox.items) {
          mailItems.push(el('div', { class: 'mail-notif' + (m.urgency === 'high' ? ' hot' : '') },
            el('div', { class: 'mail-line' },
              el('span', { class: 'mail-from' }, m.from.replace(/<[^>]*>/g, '').replace(/"/g, '').trim() || m.from),
              el('button', {
                class: 'mail-x', title: 'Dismiss',
                onclick: async () => { try { await post('/mail/dismiss', { id: m.id }); render(); } catch (e2) { toast(e2.message, 'err'); } },
              }, '×')),
            el('div', { class: 'mail-subj' }, m.subject),
            m.reason ? el('div', { class: 'mail-reason' }, m.reason) : null));
        }
        if (!inbox.items.length) mailItems.push(el('div', { class: 'muted small', style: { padding: '2px 4px' } },
          inbox.scannedAt ? 'nothing important right now' : 'not scanned yet — hit refresh'));
        if (inbox.error) mailItems.push(el('div', { class: 'mail-err' }, inbox.error));
      } else {
        mailItems.push(el('div', { class: 'muted small link', style: { padding: '2px 4px' }, onclick: () => openApp('settings', { tab: 'mail' }) },
          'connect your inbox in Settings → Mail & Alerts'));
      }

      // life rail on the LEFT (calendar → weather → events → tasks), inbox on the RIGHT
      const leftRail = el('div', { class: 'dash-side' },
        miniPanel,
        weatherPanel(weatherData),
        sideCard('Next 3 Days', 'planner', null, ...evItems),
        sideCard('Today\'s Tasks', 'planner', el('span', { class: 'muted small' }, new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })), ...taskItems));
      const rightRail = el('div', { class: 'dash-side' },
        sideCard('Inbox', () => openApp('settings', { tab: 'mail' }), mailStat?.configured ? scanBtn : null, ...mailItems));

      root.innerHTML = '';
      root.append(el('div', { class: 'dash-inner wide' },
        leftRail,
        el('div', { class: 'dash-main' },
          el('div', { class: 'dash-hero' },
            el('h1', {}, `${greet}, ${name}.`),
            el('div', { class: 'sub' }, provLine)),
          el('div', { class: 'dash-stats' },
            stat(state.projects.length, 'projects'),
            stat(chats, 'chats'),
            stat(vaultNotes, 'vault notes'),
            stat(maps, 'mindmaps')),
          servicesEl,
          el('div', { class: 'quick-capture' }, capture),
          el('div', { class: 'dash-grid' },
            card('agent', 'Agent', state.project ? `Point the coding agent at ${state.project.name}` : 'Agentic coding on your projects', 'agent'),
            card('chat', 'Chat', 'Talk to any local or cloud model', 'chat'),
            card('research', 'Research', 'Deep, cited web research on any question', 'research'),
            card('daily', 'Planner', 'Calendar, tasks, and your day at a glance', 'planner'),
            card('briefcase', 'Job Search', 'Find jobs and track your applications', 'jobsearch'),
            card('vault', 'Second Brain', cfg.vault?.path ? 'Browse, ask, and grow your Obsidian vault' : 'Connect your Obsidian vault', 'vault'),
            card('mindmap', 'Mindmaps', 'Sketch ideas, expand branches with AI', 'mindmap'),
            card('files', 'Files', 'Explore and edit project files', 'files'),
            card('terminal', 'Terminal', 'A real shell, right in your hub', 'terminal'),
            card('projects', 'Projects', 'Register, create, and manage workspaces', 'projects'),
            card('github', 'GitHub', 'Repos, PRs, and publishing — no browser needed', 'github'),
            card('settings', 'Settings', 'Providers, appearance, network, security', 'settings'),
          )),
        rightRail,
      ));
    }
    const stat = (num, lbl) => el('div', { class: 'dash-stat' }, el('div', { class: 'num' }, String(num)), el('div', { class: 'lbl2' }, lbl));
    render();
  },

  unmount(win) { win._offs?.forEach(off => off()); },
};
