// GitHub: your profile, repos, pull requests, issues, and notifications — plus
// publish-current-project and clone-to-projects — without leaving the hub.
// Auth is server-side (Settings PAT or the gh CLI login); this app never sees a token.

import { el, icon, toast, modal, confirmBox, timeAgo } from '../ui.js';
import { get, post, wsSend, sub } from '../api.js';
import { state, on } from '../state.js';
import { openApp } from '../wm.js';

const TABS = [['overview', 'Overview'], ['repos', 'Repositories'], ['prs', 'Pull Requests'], ['issues', 'Issues']];
const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Rust: '#dea584', Go: '#00ADD8',
  C: '#555555', 'C++': '#f34b7d', 'C#': '#178600', Java: '#b07219', HTML: '#e34c26', CSS: '#663399',
  Shell: '#89e051', Ruby: '#701516', PHP: '#4F5D95', Swift: '#F05138', Kotlin: '#A97BFF', Lua: '#000080',
};

export default {
  id: 'github', title: 'GitHub', icon: 'github', width: 1080, height: 700,

  mount(body, opts, win) {
    const S = win.ghState = { tab: 'overview', status: undefined, cache: {}, filter: '', offs: [] };
    const ui = {};
    body.classList.add('col');

    ui.seg = el('div', { class: 'seg' }, ...TABS.map(([v, label]) => el('button', {
      class: 'seg-btn' + (S.tab === v ? ' on' : ''), dataset: { tab: v },
      onclick: () => { S.tab = v; for (const b of ui.seg.children) b.classList.toggle('on', b.dataset.tab === v); render(); },
    }, label)));

    const refreshBtn = el('button', {
      class: 'btn sm ghost', title: 'Refresh',
      onclick: () => { S.cache = {}; S.status = undefined; render(); },
    }, icon('refresh'));

    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl row', style: { gap: '7px' } }, icon('github'), 'GitHub', ui.who = el('span', { class: 'muted small' })),
      el('span', { class: 'grow' }), ui.seg, refreshBtn,
      el('a', { class: 'btn sm ghost', href: 'https://github.com', target: '_blank', rel: 'noreferrer', title: 'Open github.com' }, icon('external')));

    ui.content = el('div', { class: 'gh-content' });
    body.append(ui.head, ui.content);
    S.offs.push(on('project', () => { if (S.tab === 'overview') render(); }));

    const cached = async (key, path) => {
      if (S.cache[key] === undefined) S.cache[key] = await get(path);
      return S.cache[key];
    };
    const ghDate = (s) => timeAgo(s);
    const extLink = (url, ...kids) => el('a', { class: 'gh-link', href: url, target: '_blank', rel: 'noreferrer' }, ...kids);

    async function ensureStatus() {
      if (S.status === undefined) {
        try { S.status = await get('/github/status'); }
        catch (e) { S.status = { configured: false, hint: e.message }; }
      }
      ui.who.textContent = S.status?.configured ? `@${S.status.user.login}` : '';
      return S.status;
    }

    function connectCard(hint) {
      return el('div', { class: 'empty', style: { margin: '40px auto', maxWidth: '460px' } },
        icon('github'),
        el('div', { style: { fontWeight: '600' } }, 'Connect GitHub'),
        el('div', { class: 'muted small', style: { lineHeight: '1.6', textAlign: 'center' } },
          hint || 'Run `gh auth login` in a terminal on this machine (AIOS borrows that login automatically), or paste a personal access token in Settings.'),
        el('div', { class: 'row' },
          el('button', { class: 'btn sm', onclick: () => openApp('terminal') }, icon('terminal'), 'Open Terminal'),
          el('button', { class: 'btn sm primary', onclick: () => openApp('settings', { tab: 'github' }) }, 'Settings → GitHub')));
    }

    const spin = () => el('div', { class: 'empty', style: { minHeight: '120px' } }, el('span', { class: 'spinner' }));

    async function render() {
      ui.content.innerHTML = '';
      ui.content.append(spin());
      const st = await ensureStatus();
      if (!st.configured) { ui.content.innerHTML = ''; ui.content.append(connectCard(st.hint)); return; }
      try {
        if (S.tab === 'overview') await renderOverview();
        else if (S.tab === 'repos') await renderRepos();
        else if (S.tab === 'prs') await renderPRs();
        else await renderIssues();
      } catch (e) {
        ui.content.innerHTML = '';
        ui.content.append(el('div', { class: 'empty' }, '⚠ ' + e.message,
          el('button', { class: 'btn sm', onclick: () => { S.cache = {}; render(); } }, 'Retry')));
      }
    }

    // ---------- overview ----------

    async function renderOverview() {
      const [ov, notifs, gitState, heat] = await Promise.all([
        cached('overview', '/github/overview'),
        cached('notifications', '/github/notifications').catch(() => null),
        state.project ? get(`/projects/${state.project.id}/git`).catch(() => null) : null,
        cached('heatmap', '/github/heatmap').catch(() => null),
      ]);
      ui.content.innerHTML = '';
      const u = ov.user;

      const profile = el('div', { class: 'gh-profile' },
        el('img', { class: 'gh-avatar', src: u.avatar, alt: u.login }),
        el('div', { class: 'gh-profile-main' },
          el('div', { class: 'gh-name' }, u.name, ' ', extLink(u.url, el('span', { class: 'muted' }, `@${u.login}`))),
          u.bio ? el('div', { class: 'muted small' }, u.bio) : null,
          el('div', { class: 'row', style: { gap: '14px', marginTop: '7px', flexWrap: 'wrap' } },
            stat(u.publicRepos + (u.privateRepos || 0), 'repos'),
            stat(u.followers, 'followers'),
            stat(u.following, 'following'),
            u.location ? el('span', { class: 'muted small' }, '📍 ' + u.location) : null)));

      // publish the active project
      const pub = el('div', { class: 'gh-card' },
        el('div', { class: 'gh-card-head' }, icon('projects'), 'Active project'),
        !state.project
          ? el('div', { class: 'muted small' }, 'no active project — open Projects to pick one')
          : el('div', { class: 'col', style: { gap: '6px' } },
            el('div', { class: 'row', style: { gap: '8px' } },
              el('span', { class: 'mono' }, state.project.name),
              gitState?.repo ? el('span', { class: 'chip' }, `⎇ ${gitState.branch}${gitState.dirty ? ` · ${gitState.dirty}±` : ''}`) : el('span', { class: 'chip' }, 'no git repo')),
            gitState?.remote
              ? el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
                extLink(gitState.remote.replace(/\.git$/, ''), 'view on GitHub ↗'),
                el('button', {
                  class: 'btn sm' + (gitState.ahead ? ' primary' : ''),
                  title: gitState.ahead ? `${gitState.ahead} local commit(s) the remote doesn't have` : 'push the current branch',
                  onclick: () => syncFlow('push'),
                }, `Push${gitState.ahead ? ` (${gitState.ahead})` : ''}`),
                el('button', {
                  class: 'btn sm' + (gitState.behind ? ' primary' : ''),
                  title: gitState.behind ? `${gitState.behind} remote commit(s) you don't have — rebase + autostash` : 'pull with rebase + autostash',
                  onclick: () => syncFlow('pull'),
                }, `Pull${gitState.behind ? ` (${gitState.behind})` : ''}`))
              : el('div', { class: 'row' },
                el('button', { class: 'btn sm primary', onclick: () => publishFlow(false) }, icon('github'), 'Publish to GitHub'),
                el('span', { class: 'muted small' }, gitState?.repo ? 'creates the repo and pushes this branch' : 'init → commit → create repo → push'))));

      // notifications
      const notifCard = el('div', { class: 'gh-card' },
        el('div', { class: 'gh-card-head' }, icon('network'), 'Notifications',
          el('span', { class: 'grow' }),
          notifs?.notifications?.length ? el('span', { class: 'chip' }, String(notifs.notifications.filter(n => n.unread).length) + ' unread') : null));
      if (!notifs) notifCard.append(el('div', { class: 'muted small' }, 'notifications unavailable for this token'));
      else if (!notifs.notifications.length) notifCard.append(el('div', { class: 'muted small' }, 'inbox zero 🎉'));
      else for (const n of notifs.notifications.slice(0, 10)) {
        notifCard.append(el('div', { class: 'gh-row' + (n.unread ? ' unread' : '') },
          el('span', { class: 'gh-row-type' }, n.type === 'PullRequest' ? 'PR' : n.type === 'Issue' ? 'IS' : n.type.slice(0, 2).toUpperCase()),
          el('div', { class: 'gh-row-main' },
            extLink(n.url, el('span', { class: 'gh-row-title' }, n.title)),
            el('div', { class: 'muted small' }, `${n.repo} · ${n.reason.replace(/_/g, ' ')} · ${ghDate(n.updatedAt)}`)),
          n.unread ? el('button', {
            class: 'mail-x', title: 'Mark read',
            onclick: async (ev) => { ev.stopPropagation(); try { await post(`/github/notifications/${n.id}/read`, {}); delete S.cache.notifications; render(); } catch (e) { toast(e.message, 'err'); } },
          }, '×') : null));
      }

      // recent activity
      const act = el('div', { class: 'gh-card' },
        el('div', { class: 'gh-card-head' }, icon('refresh'), 'Recent activity'));
      if (!ov.activity.length) act.append(el('div', { class: 'muted small' }, 'no recent public activity'));
      for (const a of ov.activity.slice(0, 12)) act.append(el('div', { class: 'gh-act' },
        el('span', { class: 'muted small', style: { flex: 'none' } }, ghDate(a.at)),
        el('span', { class: 'small' }, a.text)));

      ui.content.append(
        el('div', { class: 'gh-top' }, profile, suggestCard()),
        heat ? heatmapCard(heat) : null,
        el('div', { class: 'gh-grid' }, pub, notifCard),
        act);
    }

    // ---- AI "suggested next" — streams in like a chat answer ----

    function suggestCard() {
      const node = el('div', { class: 'gh-card gh-suggest' },
        el('div', { class: 'gh-card-head' }, icon('sparkle'), 'Suggested next'));
      const bodyEl = el('div', { class: 'gh-suggest-text' }, el('span', { class: 'spinner' }));
      node.append(bodyEl);

      const reqId = Math.random().toString(36).slice(2, 10);
      let buf = '';
      S.sugUnsub?.();
      S.sugUnsub = sub('gh:suggest:' + reqId, ({ ev }) => {
        if (ev.type === 'delta') {
          buf += ev.delta;
          bodyEl.innerHTML = '';
          bodyEl.append(document.createTextNode(buf), el('span', { class: 'cursor' }));
        } else if (ev.type === 'done') {
          bodyEl.textContent = ev.text;
          S.sugUnsub?.(); S.sugUnsub = null;
        } else if (ev.type === 'error') {
          // no model / API hiccup — the card quietly steps aside
          node.remove();
          S.sugUnsub?.(); S.sugUnsub = null;
        }
      });
      wsSend({ t: 'github.suggest', reqId, projectId: state.project?.id });
      return node;
    }

    // ---- contributions heatmap ----

    function heatmapCard(hm) {
      const grid = el('div', { class: 'gh-heat' });
      const months = el('div', { class: 'gh-heat-months' });
      let lastMonth = -1;
      for (const w of hm.weeks) {
        const first = w.days[0];
        const m = first ? new Date(first.date + 'T00:00:00').getMonth() : -1;
        const lbl = el('span', { class: 'gh-heat-month' });
        if (m !== lastMonth && first) { lbl.textContent = new Date(first.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short' }); lastMonth = m; }
        months.append(lbl);
        const col = el('div', { class: 'gh-heat-col' });
        for (const d of w.days) col.append(el('i', {
          class: 'gh-heat-cell l' + d.level,
          title: `${d.date} — ${d.count} contribution${d.count === 1 ? '' : 's'}`,
        }));
        grid.append(col);
      }
      return el('div', { class: 'gh-card gh-heat-card' },
        el('div', { class: 'gh-card-head' }, icon('graph'), `Contributions · ${hm.total.toLocaleString()} in the last year`,
          el('span', { class: 'grow' }),
          el('span', { class: 'gh-heat-legend muted' }, 'less ', ...[0, 1, 2, 3, 4].map(l => el('i', { class: 'gh-heat-cell l' + l })), ' more')),
        el('div', { class: 'gh-heat-scroll' }, months, grid));
    }

    const stat = (num, lbl) => el('span', { class: 'small' }, el('b', {}, String(num ?? 0)), ' ', el('span', { class: 'muted' }, lbl));

    /** Plain push/pull for an already-published repo — the publish flow (repo creation,
     *  auto-commit) stays separate so a stray click can never create repos or commits. */
    async function syncFlow(kind) {
      if (!state.project) return;
      try {
        const r = await post(`/projects/${state.project.id}/git/${kind}`, {});
        toast(kind === 'push' ? `pushed ${r.branch} ↗` : `pulled origin into ${r.branch} ↙`, 'ok');
        delete S.cache.overview; render();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function publishFlow(pushOnly) {
      if (!state.project) return;
      if (pushOnly) { return syncFlow('push'); }
      const f = {
        name: el('input', { class: 'input', value: state.project.name.replace(/[^A-Za-z0-9._-]+/g, '-') }),
        desc: el('input', { class: 'input', placeholder: 'description (optional)' }),
        priv: el('input', { type: 'checkbox' }),
      };
      f.priv.checked = true;
      await modal({
        title: 'Publish to GitHub',
        sub: 'Creates the repository under your account and pushes the current branch.',
        body: el('div', { class: 'col', style: { gap: '9px', marginTop: '8px', minWidth: '380px' } },
          f.name, f.desc,
          el('label', { class: 'row small', style: { gap: '6px' } }, f.priv, 'private repository')),
        actions: [
          { label: 'Cancel', value: null },
          {
            label: 'Create & push', kind: 'primary',
            onpick: async (close) => {
              try {
                const r = await post(`/projects/${state.project.id}/git/publish`, {
                  name: f.name.value.trim(), description: f.desc.value.trim(), isPrivate: f.priv.checked,
                });
                toast(`published → ${r.url}`, 'ok');
                close('done');
                S.cache = {}; render();
              } catch (e) { toast(e.message, 'err'); }
              return false;
            },
          },
        ],
      });
    }

    // ---------- repos ----------

    async function renderRepos() {
      const { repos } = await cached('repos', '/github/repos');
      ui.content.innerHTML = '';
      const search = el('input', { class: 'input', placeholder: 'filter repositories…', value: S.filter, style: { maxWidth: '240px' } });
      search.addEventListener('input', () => { S.filter = search.value; paint(); });
      const list = el('div', { class: 'gh-repo-grid' });
      ui.content.append(el('div', { class: 'row', style: { gap: '8px' } },
        search, el('span', { class: 'muted small' }, `${repos.length} repos`), el('span', { class: 'grow' }),
        el('button', { class: 'btn sm primary', onclick: newRepoModal }, icon('plus'), 'New repo')), list);

      function paint() {
        const q = S.filter.trim().toLowerCase();
        list.innerHTML = '';
        for (const r of repos.filter(r => !q || r.fullName.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q))) {
          list.append(el('div', { class: 'gh-repo' },
            el('div', { class: 'gh-row-main' },
              el('div', { class: 'row', style: { gap: '7px' } },
                extLink(r.url, el('span', { class: 'gh-repo-name' }, r.name)),
                r.private ? el('span', { class: 'chip' }, 'private') : null,
                r.fork ? el('span', { class: 'chip' }, 'fork') : null),
              r.description ? el('div', { class: 'muted small gh-ellipsis' }, r.description) : null,
              el('div', { class: 'row muted small', style: { gap: '12px', marginTop: '2px' } },
                r.language ? el('span', { class: 'row', style: { gap: '4px' } }, el('i', { class: 'gh-lang', style: { background: LANG_COLORS[r.language] || 'var(--faint)' } }), r.language) : null,
                r.stars ? el('span', {}, `★ ${r.stars}`) : null,
                r.openIssues ? el('span', {}, `◎ ${r.openIssues}`) : null,
                el('span', {}, 'pushed ' + ghDate(r.pushedAt)))),
            el('button', {
              class: 'btn sm ghost', title: 'Clone into your projects folder and register it',
              onclick: async () => {
                if (!await confirmBox(`Clone ${r.fullName}?`, 'Clones into your projects root and registers it as an AIOS project.', 'Clone', 'primary')) return;
                try { const res = await post('/github/clone', { fullName: r.fullName, cloneUrl: r.cloneUrl }); toast(`cloned to ${res.path}`, 'ok'); }
                catch (e) { toast(e.message, 'err'); }
              },
            }, icon('download'), 'Clone')));
        }
        if (!list.children.length) list.append(el('div', { class: 'empty' }, 'no repositories match'));
      }
      paint();
    }

    async function newRepoModal() {
      const f = {
        name: el('input', { class: 'input', placeholder: 'repo-name' }),
        desc: el('input', { class: 'input', placeholder: 'description (optional)' }),
        priv: el('input', { type: 'checkbox' }),
        init: el('input', { type: 'checkbox' }),
      };
      f.priv.checked = true; f.init.checked = true;
      await modal({
        title: 'New GitHub repository',
        body: el('div', { class: 'col', style: { gap: '9px', marginTop: '8px', minWidth: '360px' } },
          f.name, f.desc,
          el('label', { class: 'row small', style: { gap: '6px' } }, f.priv, 'private repository'),
          el('label', { class: 'row small', style: { gap: '6px' } }, f.init, 'initialize with a README')),
        actions: [
          { label: 'Cancel', value: null },
          {
            label: 'Create repository', kind: 'primary',
            onpick: async (close) => {
              if (!f.name.value.trim()) { toast('name is required', 'err'); return false; }
              try {
                const r = await post('/github/repos', { name: f.name.value.trim(), description: f.desc.value.trim(), isPrivate: f.priv.checked, autoInit: f.init.checked });
                toast(`created ${r.fullName} ↗`, 'ok');
                close('done');
                delete S.cache.repos; render();
              } catch (e) { toast(e.message, 'err'); }
              return false;
            },
          },
        ],
      });
    }

    // ---------- PRs / issues ----------

    const itemRow = (it, extra = '') => el('div', { class: 'gh-repo' },
      el('div', { class: 'gh-row-main' },
        el('div', { class: 'row', style: { gap: '7px' } },
          extLink(it.url, el('span', { class: 'gh-repo-name' }, it.title)),
          it.draft ? el('span', { class: 'chip' }, 'draft') : null),
        el('div', { class: 'muted small' }, `${it.repo} #${it.number}${extra ? ` · ${extra}` : ''} · by ${it.author} · ${ghDate(it.updatedAt)}${it.comments ? ` · 💬 ${it.comments}` : ''}`)));

    async function renderPRs() {
      const prs = await cached('prs', '/github/prs');
      ui.content.innerHTML = '';
      const section = (label, items, hint) => {
        ui.content.append(el('div', { class: 'lbl', style: { marginTop: '14px' } }, `${label} (${items.length})`));
        if (!items.length) ui.content.append(el('div', { class: 'muted small', style: { padding: '2px 4px' } }, hint));
        for (const it of items) ui.content.append(itemRow(it));
      };
      section('Review requested', prs.reviewRequested, 'nobody is waiting on your review');
      section('Your open PRs', prs.authored, 'no open pull requests of yours');
      section('Involved', prs.involved, 'nothing else involves you');
    }

    async function renderIssues() {
      const { issues } = await cached('issues', '/github/issues');
      ui.content.innerHTML = '';
      ui.content.append(el('div', { class: 'lbl', style: { marginTop: '4px' } }, `Open issues involving you (${issues.length})`));
      if (!issues.length) ui.content.append(el('div', { class: 'empty' }, 'no open issues involve you'));
      for (const it of issues) ui.content.append(itemRow(it));
    }

    render();
    this.reopen = (w, o) => { if (o?.tab) { S.tab = o.tab; for (const b of ui.seg.children) b.classList.toggle('on', b.dataset.tab === o.tab); render(); } };
  },

  unmount(win) {
    win.ghState?.sugUnsub?.();
    win.ghState?.offs?.forEach(off => off());
  },
};
