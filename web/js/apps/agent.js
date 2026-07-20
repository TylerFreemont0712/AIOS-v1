// Agent: Claude-Code-style coding sessions on the active project.
// Streams text + tool calls, renders diffs, and handles approval requests.

import { el, icon, icons, toast, confirmBox, modal, modelPicker, timeAgo, throttle, thinkingPanel, attachTray, attachmentView, perfBadge } from '../ui.js';
import { get, post, patch, del, wsSend, sub, uploadFile } from '../api.js';
import { renderMd } from '../markdown.js';
import { state, on } from '../state.js';
import { openApp } from '../wm.js';

const MODES = [['read', 'Read-only'], ['edits', 'Approve edits'], ['auto', 'Full auto']];

export default {
  id: 'agent', title: 'Agent', icon: 'agent', width: 1060, height: 700,

  mount(body, opts, win) {
    const S = win.agentState = { sessionId: null, projectId: null, unsub: null, running: false, planMode: false, livePlan: null, liveText: null, liveThink: null, buf: '', cards: new Map(), offs: [] };
    const ui = {};

    const side = el('div', { class: 'side' },
      el('div', { class: 'side-head' },
        el('span', { class: 'ttl' }, 'Sessions'),
        el('button', { class: 'btn sm ghost', title: 'New session', onclick: () => newSession() }, icon('plus'))),
      ui.list = el('div', { class: 'side-list' }));

    ui.modeSeg = el('div', { class: 'seg' }, ...MODES.map(([v, label]) =>
      el('button', { class: 'seg-btn', dataset: { mode: v }, onclick: () => setMode(v) }, label)));
    ui.planToggle = el('button', { class: 'seg-btn plan-toggle', title: 'Plan mode — the agent proposes a numbered step plan and waits for your approval (you can edit it) before running anything', onclick: () => setPlanMode(!S.planMode) }, icon('check'), 'Plan');
    ui.model = modelPicker({ storageKey: 'agent', onchange: (ref) => S.sessionId && patch('/agent/sessions/' + S.sessionId, { modelRef: ref }) });
    ui.usage = el('span', { class: 'chip usage-chip', title: 'tokens in / out' }, '—');
    ui.stop = el('button', { class: 'btn sm danger', style: { display: 'none' }, onclick: () => wsSend({ t: 'agent.cancel', sessionId: S.sessionId }) }, icon('stop'), 'Stop');

    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl' }, projectLabel()),
      ui.modeSeg, el('div', { class: 'seg' }, ui.planToggle), ui.model, ui.usage, ui.stop,
      el('button', { class: 'btn sm ghost danger', title: 'Delete session', onclick: deleteSession }, icon('trash')));

    ui.events = el('div', { class: 'agent-events' });
    ui.status = el('div', { class: 'agent-status', style: { display: 'none' } }, el('span', { class: 'spinner' }), ui.statusText = el('span', {}, 'thinking…'));

    ui.input = el('textarea', { class: 'composer-input', placeholder: 'Tell the agent what to build, fix, or explain… (Enter to send)', rows: 1 });
    ui.send = el('button', { class: 'send-btn' }); ui.send.innerHTML = icons.send;
    ui.tray = attachTray();
    ui.file = el('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: () => { ui.tray.add([...ui.file.files]); ui.file.value = ''; } });
    ui.attach = el('button', { class: 'btn sm ghost attach-btn', title: 'Attach image, PDF, or file', onclick: () => ui.file.click() }, icon('paperclip'));

    ui.git = el('button', { class: 'btn sm ghost git-chip', style: { display: 'none' }, onclick: () => gitClick() });
    ui.diffBtn = el('button', {
      class: 'btn sm ghost git-chip', style: { display: 'none' }, title: 'Show working diff (per-file)',
      onclick: () => toggleDiffRail(),
    }, '±');
    ui.push = el('button', { class: 'btn sm ghost git-chip', style: { display: 'none' }, onclick: () => pushBranch() });
    ui.pr = el('button', { class: 'btn sm ghost git-chip', style: { display: 'none' }, title: 'Open a pull request for this branch', onclick: () => prModal() }, '⇄ PR');

    const box = el('div', { class: 'composer-box' }, ui.tray.node, ui.input,
      el('div', { class: 'composer-row' },
        ui.attach, ui.git, ui.diffBtn, ui.push, ui.pr,
        el('span', { class: 'muted small' }, 'working in ', ui.cwd = el('span', { class: 'mono' }, state.project?.name || '—')),
        el('span', { class: 'grow' }), ui.send));
    const composer = el('div', { class: 'composer' }, box, ui.file);

    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
    box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drag'); });
    box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drag'); if (e.dataTransfer?.files?.length) ui.tray.add([...e.dataTransfer.files]); });
    ui.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); ui.tray.add(files); }
    });

    ui.diffRail = el('div', { class: 'diff-rail', style: { display: 'none' } });
    body.append(el('div', { class: 'app-cols' },
      side,
      el('div', { class: 'main-pane' }, ui.head, ui.events, el('div', { style: { padding: '0 18px' } }, ui.status), composer),
      ui.diffRail));

    S.offs.push(on('project', () => {
      ui.head.querySelector('.ttl').textContent = projectLabel();
      ui.cwd.textContent = state.project?.name || '—';
      // re-scope to the active project: drop any session that belongs to another project
      // so the agent always reads/writes the project you're actually looking at.
      if (S.sessionId && S.projectId && S.projectId !== state.project?.id) {
        S.unsub?.(); S.unsub = null; S.sessionId = null; S.projectId = null;
        ui.events.innerHTML = '';
      }
      refreshList();
      refreshGit();
    }));

    function projectLabel() { return state.project ? `Agent · ${state.project.name}` : 'Agent · no project'; }

    // ---------- git chip + one-click commit ----------

    let gitInfo = null;
    async function refreshGit() {
      gitInfo = null;
      if (!state.project) { ui.git.style.display = 'none'; ui.diffBtn.style.display = 'none'; toggleDiffRail(false); return; }
      try { gitInfo = await get(`/projects/${state.project.id}/git`); } catch { }
      if (!gitInfo?.git) { ui.git.style.display = 'none'; ui.diffBtn.style.display = 'none'; return; }
      ui.diffBtn.style.display = gitInfo.repo ? '' : 'none';
      if (!gitInfo.repo) toggleDiffRail(false);
      // push: remote exists and there's something the remote doesn't have
      const onWorkBranch = gitInfo.repo && !['main', 'master', '?'].includes(gitInfo.branch);
      const needsPush = !!gitInfo.remote && gitInfo.hasCommits && (!gitInfo.hasUpstream || gitInfo.ahead > 0);
      ui.push.style.display = needsPush ? '' : 'none';
      ui.push.innerHTML = '';
      ui.push.append(`↑${gitInfo.ahead || ''}`.trim());
      ui.push.title = gitInfo.hasUpstream ? `Push ${gitInfo.ahead} commit(s) to origin/${gitInfo.branch}` : `Push ${gitInfo.branch} to origin (sets upstream)`;
      ui.pr.style.display = onWorkBranch && gitInfo.remote && /github\.com/.test(gitInfo.remote) ? '' : 'none';
      ui.git.style.display = '';
      ui.git.innerHTML = '';
      ui.git.classList.toggle('dirty', !!(gitInfo.repo && gitInfo.dirty));
      if (!gitInfo.repo) {
        ui.git.append(icon('git'), 'no repo');
        ui.git.title = 'No git repository yet — click to initialize one';
      } else {
        ui.git.append(icon('git'), el('span', { class: 'mono' }, gitInfo.branch + (gitInfo.dirty ? ` · ${gitInfo.dirty}±` : '')));
        ui.git.title = gitInfo.dirty
          ? `${gitInfo.dirty} uncommitted change(s) on ${gitInfo.branch} — click to commit`
          : `On ${gitInfo.branch} — working tree clean`;
      }
    }

    // ---------- diff rail: the working tree's per-file diffs, one glance away ----------

    function toggleDiffRail(force) {
      S.diffOpen = force !== undefined ? force : !S.diffOpen;
      ui.diffRail.style.display = S.diffOpen ? '' : 'none';
      ui.diffBtn.classList.toggle('on', S.diffOpen);
      if (S.diffOpen) refreshDiffRail();
    }

    async function refreshDiffRail() {
      if (!S.diffOpen || !state.project) return;
      ui.diffRail.innerHTML = '';
      ui.diffRail.append(el('div', { class: 'empty', style: { minHeight: '80px' } }, el('span', { class: 'spinner' })));
      let d = null;
      try { d = await get(`/projects/${state.project.id}/git/diff`); }
      catch (e) {
        ui.diffRail.innerHTML = '';
        ui.diffRail.append(el('div', { class: 'rail-head', style: { padding: '10px 12px' } },
          el('span', { class: 'rail-title' }, 'Working diff'), el('span', { class: 'grow' }),
          el('button', { class: 'btn sm ghost', onclick: () => toggleDiffRail(false) }, '×')),
          el('div', { class: 'muted small', style: { padding: '4px 12px' } }, e.message));
        return;
      }
      ui.diffRail.innerHTML = '';
      ui.diffRail.append(el('div', { class: 'rail-head', style: { padding: '10px 12px 6px' } },
        el('span', { class: 'rail-title' }, `Working diff · ${d.dirty} file${d.dirty === 1 ? '' : 's'}`),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn sm ghost', title: 'Refresh', onclick: refreshDiffRail }, icon('refresh')),
        el('button', { class: 'btn sm ghost', title: 'Close', onclick: () => toggleDiffRail(false) }, '×')));
      if (!d.files.length) {
        ui.diffRail.append(el('div', { class: 'muted small', style: { padding: '4px 12px' } }, `working tree clean on ${d.branch}`));
        return;
      }
      for (const f of d.files) {
        const lines = (f.diff || '').split('\n');
        const adds = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
        const dels = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
        const bodyEl = el('div', { class: 'diff-file-body', style: { display: 'none' } },
          f.binary ? el('div', { class: 'muted small', style: { padding: '4px 8px' } }, 'binary file') : diffEl(f.diff || '(no diff)'));
        const head = el('div', {
          class: 'diff-file-head',
          onclick: () => { bodyEl.style.display = bodyEl.style.display === 'none' ? '' : 'none'; head.classList.toggle('open'); },
        },
          el('span', { class: 'diff-file-status s-' + (f.s === '??' ? 'new' : f.s[0] === 'D' ? 'del' : 'mod') }, f.s === '??' ? 'A' : f.s[0]),
          el('span', { class: 'diff-file-path mono' }, f.path),
          el('span', { class: 'grow' }),
          el('span', { class: 'diff-counts' },
            adds ? el('span', { class: 'd-add' }, `+${adds}`) : null, ' ',
            dels ? el('span', { class: 'd-del' }, `−${dels}`) : null));
        ui.diffRail.append(el('div', { class: 'diff-file' }, head, bodyEl));
      }
      // a single changed file might as well open itself
      if (d.files.length === 1) ui.diffRail.querySelector('.diff-file-head')?.click();
    }

    async function pushBranch() {
      if (!state.project) return;
      ui.push.disabled = true;
      try {
        const r = await post(`/projects/${state.project.id}/git/publish`, {});
        toast(`pushed ${r.branch} ↗`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
      ui.push.disabled = false;
      refreshGit();
    }

    async function prModal() {
      if (!state.project) return;
      ui.pr.disabled = true;
      let d = null;
      try { d = await post(`/projects/${state.project.id}/git/pr/draft`, { modelRef: ui.model.getValue() }); }
      catch (e) { toast(e.message, 'err'); ui.pr.disabled = false; return; }
      ui.pr.disabled = false;
      const title = el('input', { class: 'input', value: d.title, style: { width: '100%' } });
      const bodyTa = el('textarea', { class: 'input mono', rows: 9, style: { width: '100%', fontSize: '12px' } });
      bodyTa.value = d.body || '';
      const draftCb = el('input', { type: 'checkbox' });
      await modal({
        title: `Pull request · ${d.branch} → ${d.base}`, wide: true,
        sub: d.generated ? 'AI-drafted from the branch commits — edit freely' : 'drafted from commit subjects — edit freely',
        body: el('div', { class: 'col', style: { gap: '8px', marginTop: '8px' } },
          title, bodyTa,
          el('label', { class: 'row small muted', style: { gap: '6px' } }, draftCb, 'open as draft PR')),
        actions: [
          { label: 'Cancel', value: null },
          {
            label: 'Push & create PR', kind: 'primary',
            onpick: async (close) => {
              if (!title.value.trim()) { toast('title is required', 'err'); return false; }
              try {
                const r = await post(`/projects/${state.project.id}/git/pr`, { title: title.value.trim(), body: bodyTa.value, draft: draftCb.checked });
                toast(r.existing ? `PR #${r.number} already open ↗` : `PR #${r.number} created ↗`, 'ok');
                window.open(r.url, '_blank', 'noreferrer');
                close('done');
                refreshGit();
              } catch (e) { toast(e.message, 'err'); }
              return false;
            },
          },
        ],
      });
    }

    async function gitClick() {
      if (!state.project || !gitInfo) return;
      if (!gitInfo.repo) {
        if (!await confirmBox('Initialize a git repository?', `Creates .git in ${state.project.name} so the agent can branch and commit its work.`, 'Initialize', 'primary')) return;
        try { await post(`/projects/${state.project.id}/git/init`, {}); toast('repository initialized', 'ok'); refreshGit(); }
        catch (e) { toast(e.message, 'err'); }
        return;
      }
      if (!gitInfo.dirty) { toast('working tree clean — nothing to commit', 'ok'); return; }
      commitModal();
    }

    async function commitModal() {
      ui.git.disabled = true;
      let gen = null;
      try { gen = await post(`/projects/${state.project.id}/git/message`, { modelRef: ui.model.getValue() }); }
      catch (e) { toast(e.message, 'err'); }
      ui.git.disabled = false;
      const msg = el('textarea', { class: 'input mono', rows: 4, style: { width: '100%', fontSize: '12px' } });
      msg.value = gen?.message || '';
      const files = (gitInfo.files || []).slice(0, 14);
      await modal({
        title: `Commit to ${gitInfo.branch}`,
        sub: gen?.generated ? 'AI-drafted message — edit freely, then commit' : 'templated message (no model reply) — edit freely, then commit',
        body: el('div', { class: 'col', style: { gap: '8px', marginTop: '8px', minWidth: '440px' } },
          msg,
          el('div', { class: 'muted small mono', style: { maxHeight: '130px', overflowY: 'auto', lineHeight: '1.6' } },
            ...files.map(f => el('div', {}, `${f.s}  ${f.path}`)),
            gitInfo.dirty > files.length ? el('div', {}, `… ${gitInfo.dirty - files.length} more`) : null)),
        actions: [
          { label: 'Cancel', value: null },
          {
            label: 'Commit all', kind: 'primary',
            onpick: async (close) => {
              const message = msg.value.trim();
              if (!message) { toast('commit message is empty', 'err'); return false; }
              try {
                const r = await post(`/projects/${state.project.id}/git/commit`, { message });
                toast(`committed ${r.hash}`, 'ok'); close('done'); refreshGit();
                if (S.diffOpen) refreshDiffRail();
              } catch (e) { toast(e.message, 'err'); }
              return false;
            },
          },
        ],
      });
    }

    // ---------- sessions ----------

    async function refreshList() {
      if (!state.project) { ui.list.innerHTML = ''; ui.list.append(el('div', { class: 'empty' }, 'no active project', el('button', { class: 'btn sm', onclick: () => openApp('projects') }, 'open Projects'))); return; }
      let sessions = [];
      try { sessions = await get('/agent/sessions?projectId=' + state.project.id); } catch { }
      ui.list.innerHTML = '';
      for (const s of sessions) {
        ui.list.append(el('div', { class: 'side-item' + (s.id === S.sessionId ? ' sel' : ''), onclick: () => load(s.id) },
          (s.running ? '● ' : '') + (s.title || 'untitled'),
          el('div', { class: 'sub' }, `${timeAgo(s.updatedAt)} · ${s.messages} msgs`)));
      }
      if (!sessions.length) ui.list.append(el('div', { class: 'empty', style: { minHeight: '70px' } }, 'no sessions yet'));
    }

    async function newSession() {
      if (!state.project) { toast('register a project first', 'err'); openApp('projects'); return; }
      if (!ui.model.getValue()) { toast('pick a model first', 'err'); return; }
      const s = await post('/agent/sessions', { projectId: state.project.id, modelRef: ui.model.getValue() });
      await load(s.id);
      refreshList();
    }

    async function load(id) {
      S.unsub?.();
      const s = await get('/agent/sessions/' + id);
      S.sessionId = id;
      S.projectId = s.projectId;
      S.cards.clear(); S.liveText = null; S.liveThink = null; S.buf = ''; S.justSent = false;
      if (s.modelRef) ui.model.setValue(s.modelRef);
      paintMode(s.mode);
      paintPlan(s.planMode);
      paintUsage(s.usage);
      setRunning(s.running);
      ui.events.innerHTML = '';
      // archived messages = what checkpoints moved out of the model's window. Still the
      // user's history, so still rendered — with a divider marking the live boundary.
      if (s.archive?.length) {
        renderTranscript(s.archive);
        ui.events.append(el('div', { class: 'check-line' }, icon('save'), 'everything above was compacted out of the model\'s context — it works from the checkpoint below'));
      }
      renderTranscript(s.transcript);
      scrollDown(true);
      S.unsub = sub('agent:' + id, onEvent);
      refreshList();
    }

    async function deleteSession() {
      if (!S.sessionId) return;
      if (!await confirmBox('Delete this session?', 'Transcript and approvals will be removed.')) return;
      await del('/agent/sessions/' + S.sessionId);
      S.sessionId = null; ui.events.innerHTML = ''; refreshList();
    }

    async function setMode(mode) {
      paintMode(mode);
      if (S.sessionId) await patch('/agent/sessions/' + S.sessionId, { mode });
    }
    function paintMode(mode) {
      for (const b of ui.modeSeg.children) b.classList.toggle('on', b.dataset.mode === mode);
    }
    async function setPlanMode(on) {
      paintPlan(on);
      if (S.sessionId) await patch('/agent/sessions/' + S.sessionId, { planMode: on });
    }
    function paintPlan(on) {
      S.planMode = !!on;
      ui.planToggle.classList.toggle('on', S.planMode);
    }
    function paintUsage(u) { ui.usage.textContent = u ? `${fmtK(u.input)} in · ${fmtK(u.output)} out` : '—'; }
    const fmtK = (n) => n > 9999 ? (n / 1000).toFixed(1) + 'k' : String(n || 0);

    // ---------- transcript rendering ----------

    // A user turn: attachment thumbnails (if any) above the typed text.
    function userEvent(text, attachments) {
      if (!attachments?.length) return el('div', { class: 'ev-user' }, text);
      const node = el('div', { class: 'ev-user' }, attachmentView(attachments));
      if (text) node.append(el('div', { class: 'ev-user-text' }, text));
      return node;
    }

    function renderTranscript(transcript) {
      const resultsById = new Map();
      for (const m of transcript) if (m.role === 'tools') for (const r of m.results) resultsById.set(r.id, r);
      for (const m of transcript) {
        if (m.role === 'user') ui.events.append(m.auto ? checkCard(m.text, m.kind) : userEvent(m.text, m.attachments));
        else if (m.role === 'assistant') {
          if (m.reasoning) { const t = thinkingPanel({ collapsed: true, doneLabel: 'Thought process' }); t.setText(m.reasoning); ui.events.append(t.node); }
          if (m.text) ui.events.append(el('div', { class: 'ev-text' }, renderMd(m.text)));
          { const b = perfBadge(m.perf, { compact: true }); if (b) ui.events.append(el('div', { class: 'msg-perf' }, b)); }
          for (const tc of m.toolCalls || []) {
            const card = toolCard(tc.id, tc.name, tc.args);
            const r = resultsById.get(tc.id);
            if (r) finishCard(card, !r.isError, r.content);
          }
        }
      }
    }

    function toolCard(callId, name, args) {
      let card = S.cards.get(callId);
      if (card) return card;
      const argPreview = summarizeArgs(name, args);
      const bodyEl = el('div', { class: 'tool-body', style: { display: 'none' } }, el('pre', {}, JSON.stringify(args, null, 2)));
      const stateEl = el('span', { class: 't-state' }, 'pending');
      const headEl = el('div', { class: 'tool-head', onclick: () => { bodyEl.style.display = bodyEl.style.display === 'none' ? '' : 'none'; } },
        icon(iconFor(name)), el('span', { class: 't-name' }, name), el('span', { class: 't-arg' }, argPreview), stateEl);
      const node = el('div', { class: 'tool-card' }, headEl, bodyEl);
      ui.events.append(node);
      card = { node, bodyEl, stateEl, name, args };
      S.cards.set(callId, card);
      return card;
    }

    function finishCard(card, ok, content) {
      card.stateEl.textContent = ok ? 'done' : 'error';
      card.stateEl.className = 't-state ' + (ok ? 'ok' : 'err');
      card.bodyEl.innerHTML = '';
      card.bodyEl.append(el('pre', {}, content || '(no output)'));
    }

    const iconFor = (name) => name.startsWith('git_') ? 'git' : name.startsWith('comfy_') ? 'image'
      : name.startsWith('mail_') ? 'send' : name.startsWith('wiki_') ? 'vault'
        : ({ bash: 'terminal', read_file: 'file', write_file: 'save', edit_file: 'edit', list_dir: 'folder', glob: 'search', grep: 'search', delete_path: 'trash', move_path: 'files', fetch_url: 'network', web_search: 'globe', skill: 'star', vault_search: 'vault', vault_list: 'vault', vault_read: 'vault', vault_write: 'vault', vault_append: 'vault', agenda_view: 'daily', task_add: 'daily', event_add: 'daily', research_start: 'research', research_status: 'research' }[name] || 'code');

    function summarizeArgs(name, args = {}) {
      if (name === 'bash') return args.command || '';
      if (name === 'git_commit') return (args.message || '').split('\n')[0];
      if (name === 'git_branch' || name === 'git_switch') return args.name || '';
      if (args.query) return args.query;
      if (args.path) return args.path + (args.old_string ? '  (edit)' : '');
      if (args.pattern) return args.pattern;
      if (args.url) return args.url;
      if (args.from) return `${args.from} → ${args.to}`;
      return Object.values(args)[0] ? String(Object.values(args)[0]).slice(0, 80) : '';
    }

    // ---------- live events ----------

    const rerenderLive = throttle(() => {
      if (!S.liveText) return;
      S.liveText.innerHTML = '';
      S.liveText.append(renderMd(S.buf), el('span', { class: 'cursor' }));
      scrollDown();
    }, 60);

    function onEvent({ ev }) {
      switch (ev.type) {
        case 'user':
          if (ev.auto) { ui.events.append(checkCard(ev.text, ev.kind)); scrollDown(true); break; }
          if (!S.justSent) ui.events.append(userEvent(ev.text, ev.attachments));
          S.justSent = false;
          scrollDown(true);
          break;
        case 'check.report':
          if (!ev.checked) break;
          ui.events.append(el('div', { class: 'check-line' + (ev.failed ? ' bad' : '') }, icon('shield'),
            ev.failed
              ? `self-check: ${ev.failed} of ${ev.checked} changed file${ev.checked > 1 ? 's' : ''} still failing — sending back (round ${ev.round})`
              : `self-check: all ${ev.checked} changed file${ev.checked > 1 ? 's' : ''} parse clean`));
          scrollDown();
          break;
        case 'test.report':
          ui.events.append(el('div', { class: 'check-line' + (ev.ok ? '' : ' bad') }, icon('play'),
            ev.ok
              ? `tests: PASS — ${ev.cmd} (${(ev.ms / 1000).toFixed(1)}s)`
              : `tests: FAIL — ${ev.cmd} (${(ev.ms / 1000).toFixed(1)}s) — sending back (round ${ev.round})`));
          scrollDown();
          break;
        case 'status':
          ui.status.style.display = ev.state === 'idle' ? 'none' : '';
          ui.statusText.textContent = ev.state === 'waiting-approval' ? 'waiting for your approval…'
            : ev.state === 'waiting-plan' ? 'waiting for you to approve the plan…'
            : ev.state === 'planning' ? 'drafting a plan…'
            : ev.state === 'thinking' ? 'thinking…'
            : ev.state === 'compacting' ? 'compacting context into a checkpoint…' : 'working…';
          setRunning(ev.state !== 'idle');
          break;
        case 'plan.delta':
          if (S.liveThink?.live) S.liveThink.done();
          S.liveThink = null;
          if (!S.livePlan) S.livePlan = planCard();
          S.livePlan.appendDelta(ev.delta);
          scrollDown();
          break;
        case 'plan.proposed':
          if (!S.livePlan) S.livePlan = planCard();
          S.livePlan.propose(ev.text);
          scrollDown(true);
          break;
        case 'plan.resolved':
          if (S.livePlan) { S.livePlan.resolve(ev.decision, ev.text); S.livePlan = null; }
          break;
        case 'checkpoint':
          ui.events.append(el('div', { class: 'check-line' }, icon('save'),
            `checkpoint ${ev.n}: context compacted ${(ev.tokensBefore / 1000).toFixed(1)}k → ${(ev.tokensAfter / 1000).toFixed(1)}k tokens — earlier work is archived, the run continues`));
          scrollDown();
          break;
        case 'reasoning.delta':
          if (!S.liveThink) { S.liveThink = thinkingPanel({ label: 'Thinking' }); ui.events.append(S.liveThink.node); }
          S.liveThink.append(ev.delta);
          scrollDown();
          break;
        case 'text.delta':
          if (S.liveThink?.live) S.liveThink.done();       // reasoning ends when the answer begins
          S.liveThink = null;
          if (!S.liveText) { S.liveText = el('div', { class: 'ev-text' }); ui.events.append(S.liveText); S.buf = ''; }
          S.buf += ev.delta;
          rerenderLive();
          break;
        case 'text.done': {
          if (S.liveThink?.live) S.liveThink.done();
          S.liveThink = null;
          if (S.liveText) { S.liveText.innerHTML = ''; if (ev.text) S.liveText.append(renderMd(ev.text)); else S.liveText.remove(); }
          S.liveText = null; S.buf = '';
          const badge = perfBadge(ev.perf, { compact: true });
          if (badge) ui.events.append(el('div', { class: 'msg-perf' }, badge));
          scrollDown();
          break;
        }
        case 'tool.request':
          if (S.liveThink?.live) S.liveThink.done();
          S.liveThink = null;
          toolCard(ev.call.id, ev.call.name, ev.call.args); scrollDown(); break;
        case 'tool.start': {
          const c = toolCard(ev.callId, ev.name, ev.args);
          c.stateEl.innerHTML = ''; c.stateEl.append(el('span', { class: 'spinner', style: { width: '11px', height: '11px' } }));
          break;
        }
        case 'tool.end': {
          const c = toolCard(ev.callId, ev.name, {});
          finishCard(c, ev.ok, ev.content);
          scrollDown();
          break;
        }
        case 'approval.request': approvalCard(ev); scrollDown(true); break;
        case 'approval.resolved': document.querySelector(`[data-approval="${ev.callId}"]`)?.remove(); break;
        case 'turn.done': paintUsage(ev.usage); setRunning(false); refreshList(); refreshGit(); if (S.diffOpen) refreshDiffRail(); break;
        case 'error': toast(ev.message, 'err'); ui.events.append(el('div', { class: 'muted small', style: { marginBottom: '10px' } }, '⚠ ' + ev.message)); setRunning(false); break;
      }
    }

    function approvalCard(ev) {
      const decide = (decision) => {
        wsSend({ t: 'agent.approve', sessionId: S.sessionId, callId: ev.callId, decision });
        node.remove();
      };
      const bodyContent = ev.diff ? diffEl(ev.diff) : el('pre', { class: 'mono', style: { fontSize: '11.5px', whiteSpace: 'pre-wrap' } }, JSON.stringify(ev.args, null, 2));
      const node = el('div', { class: 'approval-card', dataset: { approval: ev.callId } },
        el('div', { class: 'approval-head' }, icon('key'), el('span', {}, 'Agent wants to run '), el('span', { class: 't-name' }, ev.name)),
        el('div', { class: 'approval-body' }, ev.name === 'bash' ? el('pre', { class: 'mono', style: { fontSize: '12px', whiteSpace: 'pre-wrap' } }, ev.args.command || '') : bodyContent),
        el('div', { class: 'approval-actions' },
          el('button', { class: 'btn primary sm', onclick: () => decide('allow') }, icon('check'), 'Allow'),
          el('button', { class: 'btn sm', onclick: () => decide('always') }, `Always allow ${ev.name}`),
          el('span', { class: 'grow' }),
          el('button', { class: 'btn sm danger', onclick: () => decide('deny') }, icon('x'), 'Deny')));
      ui.events.append(node);
    }

    // Plan-mode card: streams the proposed plan, then turns editable with approve/reject.
    function planCard() {
      const pre = el('pre', { class: 'plan-stream mono' });
      const body = el('div', { class: 'plan-body' }, pre);
      const actions = el('div', { class: 'plan-actions', style: { display: 'none' } });
      const statusPill = el('span', { class: 't-state' });
      const node = el('div', { class: 'plan-card' },
        el('div', { class: 'plan-head' }, icon('check'), el('span', { class: 't-name' }, 'Plan'),
          el('span', { class: 't-arg' }, 'review — the agent runs this only after you approve'), statusPill),
        body, actions);
      ui.events.append(node);
      let buf = '', textarea = null, decided = false;
      const lock = (label, ok) => {
        if (textarea) textarea.disabled = true;
        actions.querySelectorAll('button').forEach(b => b.disabled = true);
        statusPill.textContent = label; statusPill.classList.add(ok ? 'ok' : 'warn');
      };
      const send = (decision) => {
        if (decided) return; decided = true;
        wsSend({ t: 'agent.plan', sessionId: S.sessionId, decision, text: textarea ? textarea.value : buf });
        lock(decision === 'approve' ? 'approved — running…' : 'rejected', decision === 'approve');
      };
      return {
        node,
        appendDelta(d) { buf += d; if (!textarea) pre.textContent = buf; },
        propose(text) {
          buf = text || buf;
          textarea = el('textarea', { class: 'plan-edit mono', rows: Math.min(18, Math.max(4, buf.split('\n').length + 1)) });
          textarea.value = buf;
          body.innerHTML = ''; body.append(textarea);
          actions.innerHTML = '';
          actions.append(
            el('button', { class: 'btn primary sm', onclick: () => send('approve') }, icon('check'), 'Approve & run'),
            el('span', { class: 'muted small' }, 'edit above before approving if you like'),
            el('span', { class: 'grow' }),
            el('button', { class: 'btn sm danger', onclick: () => send('reject') }, icon('x'), 'Reject'));
          actions.style.display = '';
        },
        resolve(decision, text) {
          if (textarea && typeof text === 'string' && !decided) textarea.value = text;
          lock(decision === 'approve' ? 'approved — running…' : 'rejected', decision === 'approve');
        },
      };
    }

    function checkCard(text, kind) {
      const isMem = kind === 'memory' || /^\[automatic memory\]/.test(text);
      const isCp = kind === 'checkpoint' || /^\[checkpoint/.test(text);
      const isPlan = kind === 'plan';
      const bodyEl = el('div', { class: 'tool-body', style: { display: 'none' } }, el('pre', {}, text));
      const head = el('div', { class: 'tool-head', onclick: () => { bodyEl.style.display = bodyEl.style.display === 'none' ? '' : 'none'; } },
        icon(isCp ? 'save' : isMem ? 'vault' : isPlan ? 'check' : 'shield'),
        el('span', { class: 't-name' }, isCp ? 'checkpoint' : isMem ? 'memory' : isPlan ? 'plan' : 'self-check'),
        el('span', { class: 't-arg' }, isCp ? 'older context compacted into a handoff — click to read it' : isMem ? 'asked the agent to record what it learned in .aios/memory/' : isPlan ? 'plan approved — the agent executed these steps' : 'syntax problems found — asked the agent to fix them'),
        el('span', { class: 't-state warn' }, 'auto'));
      return el('div', { class: 'tool-card ' + (isCp ? 'checkpoint-card' : isMem ? 'memory-card' : 'check-card') }, head, bodyEl);
    }

    function diffEl(diff) {
      const box = el('div', { class: 'diff' });
      for (const line of diff.split('\n')) {
        const cls = line.startsWith('+') ? 'd-add' : line.startsWith('-') ? 'd-del' : line.startsWith('@@') ? 'd-hunk' : 'd-file';
        box.append(el('span', { class: cls }, line || ' '));
      }
      return box;
    }

    function setRunning(v) {
      S.running = v;
      ui.stop.style.display = v ? '' : 'none';
      ui.send.disabled = v;
      if (!v) ui.status.style.display = 'none';
    }

    function scrollDown(force) {
      const nearBottom = ui.events.scrollHeight - ui.events.scrollTop - ui.events.clientHeight < 200;
      if (force || nearBottom) ui.events.scrollTop = ui.events.scrollHeight;
    }

    // ---------- send ----------

    async function sendNow() {
      const text = ui.input.value.trim();
      const files = ui.tray.items();
      if ((!text && !files.length) || S.running) return;
      if (!S.sessionId) {
        if (!state.project) { toast('register a project first', 'err'); openApp('projects'); return; }
        if (!ui.model.getValue()) { toast('pick a model first', 'err'); return; }
        const s = await post('/agent/sessions', { projectId: state.project.id, modelRef: ui.model.getValue(), planMode: S.planMode });
        S.sessionId = s.id;
        S.projectId = s.projectId;
        paintMode(s.mode);
        paintPlan(s.planMode);
        S.unsub = sub('agent:' + s.id, onEvent);
      }
      setRunning(true);
      let attachments = [];
      try { if (files.length) attachments = await Promise.all(files.map(uploadFile)); }
      catch (e) { toast('upload failed: ' + e.message, 'err'); setRunning(false); return; }
      ui.events.append(userEvent(text, attachments));
      S.justSent = true;
      scrollDown(true);
      ui.input.value = ''; autoGrow(); ui.tray.clear();
      wsSend({ t: 'agent.user', sessionId: S.sessionId, text, attachments });
    }

    ui.send.addEventListener('click', sendNow);
    ui.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNow(); } });
    const autoGrow = () => { ui.input.style.height = 'auto'; ui.input.style.height = Math.min(ui.input.scrollHeight, 200) + 'px'; };
    ui.input.addEventListener('input', autoGrow);

    refreshList();
    refreshGit();
    if (opts.fresh) newSession();
    else if (opts.session) load(opts.session);
    this.reopen = (w, o) => { if (o?.fresh) newSession(); else if (o?.session) load(o.session); };
    setTimeout(() => ui.input.focus(), 50);
  },

  unmount(win) {
    win.agentState?.unsub?.();
    win.agentState?.offs?.forEach(off => off());
  },
};
