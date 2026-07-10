// Job Search: discover jobs, prep applications with AI, track the pipeline, and
// watch annotation platforms for available tasks. Four views:
//   Discover  — pluggable-source search feed with AI fit-scoring + apply-kit prep
//   Board     — kanban pipeline with cover letters, questionnaire answers, timeline
//   Platforms — annotation/gig platform directory + availability checks
//   Profile   — the structured resume/answers "memory" everything draws from

import { el, icon, icons, toast, confirmBox, askText, modal, modelPicker, timeAgo } from '../ui.js';
import { get, post, patch, del, put } from '../api.js';
import { renderMd } from '../markdown.js';
import { state } from '../state.js';

const STAGES = ['saved', 'applied', 'screening', 'interview', 'offer', 'accepted'];
const CLOSED = ['rejected', 'ghosted', 'withdrawn'];
const STATUSES = [...STAGES, ...CLOSED];
const STATUS_LABEL = {
  saved: 'Saved', applied: 'Applied', screening: 'Screening', interview: 'Interview',
  offer: 'Offer', accepted: 'Accepted', rejected: 'Rejected', ghosted: 'Ghosted', withdrawn: 'Withdrawn',
};
const PSTATUS = [['none', 'Not signed up'], ['applied', 'Applied'], ['assessment', 'Assessment'], ['active', 'Active'], ['paused', 'Paused'], ['rejected', 'Rejected']];
const AVAIL_LABEL = {
  tasks_available: ['tasks available', 'ok'], no_tasks: ['no tasks', 'warn'], assessment_pending: ['assessment pending', 'warn'],
  logged_out: ['logged out', 'err'], signup_open: ['signup open', 'ok'], waitlist: ['waitlist', 'warn'], unknown: ['unknown', ''],
};

const copyText = (t) => { navigator.clipboard.writeText(t); toast('copied', 'ok'); };

export default {
  id: 'jobsearch', title: 'Job Search', icon: 'briefcase',

  mount(body, opts, win) {
    const S = win.jobState = { view: 'search', results: [], note: '', scores: new Map(), profile: null };
    const ui = {};

    ui.seg = el('div', { class: 'seg' }, ...[['search', 'Discover'], ['board', 'Board'], ['platforms', 'Platforms'], ['profile', 'Profile']].map(([v, label]) =>
      el('button', { class: 'seg-btn', dataset: { view: v }, onclick: () => setView(v) }, label)));
    ui.source = el('button', { class: 'chip small', title: 'Active job source — click to cycle (searxng → firecrawl → jobapi)', onclick: cycleSource }, '—');
    ui.model = modelPicker({ storageKey: 'jobsearch' });
    ui.stats = el('span', { class: 'muted small' });
    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl' }, 'Job Search'), ui.seg, ui.source, el('span', { class: 'grow' }), ui.stats, ui.model);

    ui.main = el('div', { class: 'job-main' });
    body.append(el('div', { class: 'main-pane' }, ui.head, ui.main));

    const mref = () => ui.model.getValue();

    // ================= Discover =================

    function searchView() {
      const q = el('input', { class: 'input', placeholder: 'Role or keywords — e.g. "software engineer", "data annotation"' });
      const loc = el('input', { class: 'input', style: { maxWidth: '180px' }, placeholder: 'Location / "remote"' });
      const typ = el('select', { class: 'input select', style: { maxWidth: '140px' } },
        el('option', { value: '' }, 'Any type'),
        ...['fulltime', 'parttime', 'contract', 'internship', 'temporary'].map(t => el('option', { value: t }, t)));
      const go = el('button', { class: 'btn primary', onclick: run }, icon('search'), 'Search');
      q.value = S.lastQuery || ''; loc.value = S.lastLoc || '';
      for (const inp of [q, loc]) inp.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

      const scoreAllBtn = el('button', { class: 'btn sm', title: 'AI fit-score every result against your profile', onclick: scoreAll }, icon('sparkle'), 'Score results');
      const remoteOnly = el('label', { class: 'row small muted', style: { gap: '5px' } }, el('input', { type: 'checkbox', onchange: renderFeed }), 'remote only');

      const form = el('div', { class: 'job-search-form' }, q, loc, typ, go,
        el('button', { class: 'btn sm ghost', title: 'Save this search', onclick: saveSearch }, icon('star'), 'Save'));
      const toolsRow = el('div', { class: 'job-tools-row' }, scoreAllBtn, remoteOnly);
      const saved = el('div', { class: 'saved-row' });
      const feed = el('div', { class: 'job-feed' });

      renderSaved(saved, s => { q.value = s.query; loc.value = s.location || ''; run(); });

      async function run() {
        S.lastQuery = q.value.trim(); S.lastLoc = loc.value.trim();
        if (!S.lastQuery) { toast('enter a search', 'err'); return; }
        feed.innerHTML = ''; feed.append(el('div', { class: 'job-note' }, el('span', { class: 'spinner' }), 'searching… (board result pages are opened and positions extracted with AI — can take a minute)'));
        go.disabled = true;
        try {
          const r = await post('/jobs/search', { query: S.lastQuery, location: S.lastLoc, type: typ.value, modelRef: mref() });
          S.results = r.jobs || []; S.note = r.note || ''; S.scores.clear();
          renderFeed();
        } catch (e) { feed.innerHTML = ''; feed.append(el('div', { class: 'job-note err' }, e.message)); }
        go.disabled = false;
      }

      async function scoreAll() {
        if (!S.results.length) { toast('search first', 'err'); return; }
        if (!mref()) { toast('pick a model first', 'err'); return; }
        scoreAllBtn.disabled = true;
        let done = 0;
        for (const job of S.results.slice(0, 12)) {
          const key = job.url || job.title;
          if (S.scores.has(key)) { done++; continue; }
          scoreAllBtn.innerHTML = ''; scoreAllBtn.append(el('span', { class: 'spinner' }), ` scoring ${++done}/${Math.min(S.results.length, 12)}`);
          try { S.scores.set(key, await post('/jobsearch/score', { job, modelRef: mref() })); renderFeed(); }
          catch (e) { toast('scoring failed: ' + e.message, 'err'); break; }
        }
        scoreAllBtn.disabled = false;
        scoreAllBtn.innerHTML = ''; scoreAllBtn.append(icon('sparkle'), 'Score results');
        renderFeed();
      }

      async function saveSearch() {
        if (!q.value.trim()) return;
        const list = [...(state.config?.jobsearch?.savedSearches || [])];
        list.unshift({ id: Math.random().toString(36).slice(2, 8), label: q.value.trim(), query: q.value.trim(), location: loc.value.trim() });
        await saveSaved(list.slice(0, 12));
        renderSaved(saved, s => { q.value = s.query; loc.value = s.location || ''; run(); });
        toast('search saved', 'ok');
      }

      function renderFeed() {
        feed.innerHTML = '';
        if (S.note) feed.append(el('div', { class: 'job-note' }, S.note));
        let items = S.results;
        if (remoteOnly.querySelector('input').checked) items = items.filter(j => j.remote);
        // scored jobs float to the top, best first
        items = [...items].sort((a, b) => (S.scores.get(b.url || b.title)?.score ?? -1) - (S.scores.get(a.url || a.title)?.score ?? -1));
        if (!items.length) { feed.append(el('div', { class: 'empty', style: { minHeight: '120px' } }, 'no jobs — try a search above')); return; }
        for (const job of items) feed.append(pill(job, false));
      }
      S.render = renderFeed;

      ui.main.innerHTML = '';
      ui.main.append(el('div', { class: 'job-search-wrap' }, form, toolsRow, saved, feed));
      if (S.results.length || S.note) renderFeed();
      setTimeout(() => q.focus(), 40);
    }

    async function renderSaved(container, onPick) {
      container.innerHTML = '';
      const list = state.config?.jobsearch?.savedSearches || [];
      if (!list.length) return;
      container.append(el('span', { class: 'saved-lbl' }, 'Saved:'));
      for (const s of list) {
        container.append(el('button', { class: 'saved-chip', onclick: () => onPick(s) }, s.label,
          el('span', { class: 'x', title: 'remove', onclick: async (e) => { e.stopPropagation(); await saveSaved(list.filter(x => x.id !== s.id)); renderSaved(container, onPick); } }, '×')));
      }
    }
    async function saveSaved(list) {
      try { state.config = await put('/config', { jobsearch: { savedSearches: list } }); } catch (e) { toast(e.message, 'err'); }
    }

    // ================= Board =================

    async function boardView() {
      ui.main.innerHTML = '';
      const board = el('div', { class: 'job-board' });
      ui.main.append(board);
      let jobs = [];
      try { jobs = await get('/jobs'); } catch { }
      const byStatus = Object.fromEntries(STATUSES.map(s => [s, []]));
      for (const j of jobs) (byStatus[j.status] || (byStatus[j.status] = [])).push(j);
      for (const col of [...STAGES, 'closed']) {
        const items = col === 'closed' ? CLOSED.flatMap(s => byStatus[s]) : byStatus[col];
        board.append(el('div', { class: 'job-col', dataset: { col } },
          el('div', { class: 'job-col-head' }, el('span', {}, col === 'closed' ? 'Closed' : STATUS_LABEL[col]), el('span', { class: 'job-col-count' }, String(items.length))),
          el('div', { class: 'job-col-list' }, ...items.map(j => pill(j, true)))));
      }
      if (!jobs.length) { board.innerHTML = ''; board.append(el('div', { class: 'empty', style: { minHeight: '160px' } }, 'no tracked jobs yet — search and hit “Track” to add them here')); }
      refreshStats();
    }

    // ================= pill (Discover + Board) =================

    function pill(job, tracked) {
      const key = job.url || job.title;
      const bodyEl = el('div', { class: 'job-pill-body', style: { display: 'none' } });
      const meta = [job.company, job.location, job.salary, job.remote ? 'remote' : '', job.postedAt].filter(Boolean).join(' · ');
      const fit = tracked ? job.fit : S.scores.get(key);
      const scoreChip = fit ? el('span', { class: 'job-score ' + (fit.score >= 70 ? 'hi' : fit.score >= 45 ? 'mid' : 'lo'), title: fit.verdict || '' }, `${fit.score}`) : null;
      const badge = el('span', { class: 'job-src' }, job.source || 'web');
      const openBtn = job.url ? el('button', { class: 'btn sm', title: 'Open the posting', onclick: (e) => { e.stopPropagation(); window.open(job.url, '_blank', 'noopener'); markOpened(job, tracked); } }, icon('external'), 'Open') : null;
      const daysApplied = tracked && job.appliedAt && !CLOSED.includes(job.status) && job.status !== 'saved'
        ? Math.floor((Date.now() - new Date(job.appliedAt)) / 86400000) : null;

      const actions = el('div', { class: 'job-actions' });
      if (tracked) {
        actions.append(
          el('select', { class: 'input select sm status-sel', onclick: e => e.stopPropagation(), onchange: async (e) => { await patch('/jobs/' + job.id, { status: e.target.value }); boardView(); } },
            ...STATUSES.map(s => el('option', { value: s, selected: s === job.status }, STATUS_LABEL[s]))),
          openBtn,
          el('button', { class: 'btn sm ghost danger', title: 'Remove', onclick: async (e) => { e.stopPropagation(); if (await confirmBox('Remove this job?', 'It will be deleted from the board.')) { await del('/jobs/' + job.id); boardView(); } } }, icon('trash')));
      } else {
        actions.append(openBtn, el('button', { class: 'btn sm primary', title: 'Track on the board', onclick: async (e) => { e.stopPropagation(); await track(job, fit); } }, icon('plus'), 'Track'));
      }

      const head = el('div', { class: 'job-head', onclick: () => toggle() },
        el('div', { class: 'job-headmain' },
          el('div', { class: 'job-title' }, scoreChip, job.title || '(untitled)',
            job.flags?.needsReply ? el('span', { class: 'flag-reply' }, 'needs reply') : null,
            daysApplied != null && daysApplied >= 7 ? el('span', { class: 'flag-age', title: 'time since applied — consider a follow-up' }, `${daysApplied}d`) : null),
          el('div', { class: 'job-meta' }, meta || '—')),
        badge, actions);
      const node = el('div', { class: 'job-pill' + (tracked ? ' tracked s-' + job.status : '') }, head, bodyEl);

      let built = false;
      function toggle() { if (!built) { buildBody(); built = true; } bodyEl.style.display = bodyEl.style.display === 'none' ? '' : 'none'; }

      async function buildBody() {
        const full = tracked ? await get('/jobs/' + job.id).catch(() => job) : job;
        bodyEl.append(el('div', { class: 'job-snippet' }, full.snippet || 'No preview — open the posting for details.'));
        const f = tracked ? full.fit : S.scores.get(key);
        if (f) bodyEl.append(el('div', { class: 'job-fit' },
          el('div', { class: 'job-sub' }, `fit ${f.score}/100 — ${f.verdict || ''}`),
          ...(f.reasons || []).map(r => el('div', { class: 'fit-line ok' }, '+ ' + r)),
          ...(f.gaps || []).map(g => el('div', { class: 'fit-line gap' }, '− ' + g))));

        // AI actions — work for feed pills and tracked jobs alike
        const aiRow = el('div', { class: 'job-ai-row' },
          el('button', { class: 'btn sm', onclick: () => prepKit(job, tracked, bodyEl) }, icon('sparkle'), 'Cover letter'),
          el('button', { class: 'btn sm', onclick: () => answerModal(job) }, icon('edit'), 'Answer questions'),
          !f ? el('button', { class: 'btn sm ghost', onclick: async (e) => { e.target.disabled = true; try { const sc = await post('/jobsearch/score', { job, modelRef: mref() }); if (tracked) await patch('/jobs/' + job.id, { fit: sc }); else S.scores.set(key, sc); toast(`fit: ${sc.score}/100`, 'ok'); S.render?.(); if (tracked) boardView(); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; } } }, 'Score fit') : null);
        bodyEl.append(aiRow);

        if (tracked && full.coverLetter) {
          bodyEl.append(el('div', { class: 'job-sub' }, 'Cover letter'),
            el('div', { class: 'job-letter' }, renderMd(full.coverLetter)),
            el('button', { class: 'btn sm ghost', onclick: () => copyText(full.coverLetter) }, 'Copy letter'));
        }
        if (tracked) {
          const notes = el('textarea', { class: 'input', rows: 2, placeholder: 'Notes…' }); notes.value = full.notes || '';
          notes.addEventListener('change', () => patch('/jobs/' + job.id, { notes: notes.value }));
          bodyEl.append(el('div', { class: 'job-sub' }, 'Notes'), notes);
          if (full.timeline?.length) bodyEl.append(el('div', { class: 'job-sub' }, 'Timeline'),
            el('div', { class: 'job-timeline' }, ...full.timeline.slice(-8).map(t => el('div', { class: 'job-tl' }, `${timeAgo(t.at)} · ${t.text}`))));
        }
      }
      return node;
    }

    // cover-letter drafting (streams into a modal-free inline block)
    async function prepKit(job, tracked, bodyEl) {
      if (!mref()) { toast('pick a model first', 'err'); return; }
      const holder = el('div', { class: 'job-letter' }, el('span', { class: 'spinner' }), ' drafting…');
      bodyEl.append(el('div', { class: 'job-sub' }, 'Cover letter (draft)'), holder);
      try {
        const r = await post('/jobsearch/coverletter', { job, modelRef: mref(), lang: 'auto' });
        holder.innerHTML = '';
        holder.append(renderMd(r.text));
        const rowEl = el('div', { class: 'row', style: { marginTop: '6px' } },
          el('button', { class: 'btn sm', onclick: () => copyText(r.text) }, 'Copy'),
        );
        if (tracked) rowEl.append(el('button', { class: 'btn sm ghost', onclick: async () => { await patch('/jobs/' + job.id, { coverLetter: r.text, timelineAdd: { kind: 'ai', text: 'cover letter drafted' } }); toast('saved to job', 'ok'); } }, 'Save to job'));
        holder.after(rowEl);
      } catch (e) { holder.textContent = '⚠ ' + e.message; }
    }

    // paste application questions → grounded answers from the profile
    async function answerModal(job) {
      if (!mref()) { toast('pick a model first', 'err'); return; }
      const qs = el('textarea', { class: 'input', rows: 6, placeholder: 'Paste the application questions here (any language)…' });
      const out = el('div', { class: 'answer-out' });
      const goBtn = { label: 'Answer', kind: 'primary', onpick: async (close) => {
        if (!qs.value.trim()) return false;
        out.innerHTML = ''; out.append(el('span', { class: 'spinner' }), ' answering from your profile…');
        try {
          const r = await post('/jobsearch/answer', { questions: qs.value, job, modelRef: mref() });
          out.innerHTML = ''; out.append(renderMd(r.text), el('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: () => copyText(r.text) }, 'Copy all'));
        } catch (e) { out.innerHTML = ''; out.append(el('div', { class: 'job-note err' }, e.message)); }
        return false;   // keep the modal open
      } };
      modal({ title: 'Answer application questions', sub: job ? `for ${job.title} @ ${job.company || '?'} — answers come only from your Profile` : 'answers come only from your Profile', wide: true,
        body: el('div', {}, qs, out), actions: [{ label: 'Close', value: null }, goBtn] });
    }

    async function track(job, fit) {
      try {
        const j = await post('/jobs', { ...job, status: 'saved' });
        if (fit) await patch('/jobs/' + j.id, { fit });
        toast('tracked → Board', 'ok'); refreshStats();
      } catch (e) { toast(e.message, 'err'); }
    }
    async function markOpened(job, tracked) {
      if (tracked) return;
      setTimeout(async () => {
        if (await confirmBox('Applied to this job?', 'Add it to your board as “Applied” so you can track the status.', 'Mark applied')) {
          try { await post('/jobs', { ...job, status: 'applied' }); toast('added to board (applied)', 'ok'); refreshStats(); } catch (e) { toast(e.message, 'err'); }
        }
      }, 400);
    }

    // ================= Platforms =================

    async function platformsView() {
      ui.main.innerHTML = '';
      const wrap = el('div', { class: 'job-search-wrap' });
      ui.main.append(wrap);
      let list = [];
      try { list = await get('/platforms'); } catch (e) { wrap.append(el('div', { class: 'job-note err' }, e.message)); return; }

      const checkAllBtn = el('button', {
        class: 'btn sm primary', onclick: async () => {
          checkAllBtn.disabled = true; checkAllBtn.textContent = 'checking… (a while on many platforms)';
          try { await post('/platforms/check-all', { modelRef: mref() }); platformsView(); }
          catch (e) { toast(e.message, 'err'); checkAllBtn.disabled = false; }
        },
      }, 'Check all now');
      wrap.append(el('div', { class: 'job-tools-row' },
        checkAllBtn,
        el('button', { class: 'btn sm ghost', onclick: addCustom }, icon('plus'), 'Add platform'),
        el('span', { class: 'muted small' }, 'Availability checks fetch each dashboard (with your login cookie when set, via Firecrawl) and classify what they see — treat results as best-effort signals.')));

      const grid = el('div', { class: 'plat-grid' });
      wrap.append(grid);
      for (const p of list) grid.append(platCard(p));

      function platCard(p) {
        const lc = p.lastCheck;
        const [availText, availKind] = lc ? (AVAIL_LABEL[lc.state] || [lc.state, '']) : ['not checked', ''];
        const checkBtn = el('button', {
          class: 'btn sm', onclick: async () => {
            checkBtn.disabled = true; checkBtn.innerHTML = ''; checkBtn.append(el('span', { class: 'spinner' }));
            try { await post(`/platforms/${p.id}/check`, { modelRef: mref() }); platformsView(); }
            catch (e) { toast(e.message, 'err'); checkBtn.disabled = false; checkBtn.textContent = 'Check'; }
          },
        }, 'Check');
        const cookieBtn = el('button', {
          class: 'btn sm ghost', title: 'Paste the Cookie header from your browser (devtools → Network → any dashboard request → Request Headers → cookie). Lets checks see your logged-in dashboard.',
          onclick: async () => {
            const v = await askText({ title: `${p.name} login cookie`, sub: 'Paste the full Cookie header value. Stored locally, never shown again. Leave empty and OK to clear.', multiline: true, ok: 'Save' });
            if (v === null) return;
            await patch('/platforms/' + p.id, { cookie: v || null });
            toast(v ? 'cookie saved' : 'cookie cleared', 'ok'); platformsView();
          },
        }, icon('key'), p.hasCookie ? 'Cookie ✓' : 'Set cookie');

        return el('div', { class: 'plat-card' },
          el('div', { class: 'plat-head' },
            el('a', { class: 'plat-name', href: p.url, target: '_blank', rel: 'noreferrer' }, p.name),
            el('span', { class: 'svc-dot ' + (availKind === 'ok' ? 'up' : availKind === 'err' ? 'down' : availKind === 'warn' ? 'warn' : 'off') }),
            el('span', { class: 'plat-avail' }, availText)),
          el('div', { class: 'plat-desc' }, p.desc),
          lc ? el('div', { class: 'plat-evidence', title: lc.evidence || '' }, `${timeAgo(lc.at)} · ${lc.confidence || ''} confidence${lc.via ? ' · via ' + lc.via : ''}${lc.evidence ? ' — ' + lc.evidence.slice(0, 90) : ''}`) : null,
          el('div', { class: 'plat-actions' },
            el('select', { class: 'input select sm', onchange: e => patch('/platforms/' + p.id, { status: e.target.value }) },
              ...PSTATUS.map(([v, label]) => el('option', { value: v, selected: v === p.status }, label))),
            checkBtn, cookieBtn,
            el('a', { class: 'btn sm ghost', href: p.dash, target: '_blank', rel: 'noreferrer', title: 'Open the dashboard' }, icon('external')),
            p.custom ? el('button', { class: 'btn sm ghost danger', onclick: async () => { if (await confirmBox(`Remove ${p.name}?`, '')) { await del('/platforms/' + p.id); platformsView(); } } }, icon('trash')) : null));
      }

      async function addCustom() {
        const name = await askText({ title: 'Platform name', placeholder: 'e.g. Welocalize', ok: 'Next' });
        if (!name) return;
        const url = await askText({ title: 'Site URL', placeholder: 'https://…', ok: 'Next' });
        if (!url) return;
        const dash = await askText({ title: 'Dashboard URL (where tasks are listed)', placeholder: url, ok: 'Add' });
        await post('/platforms', { name, url, dash: dash || url });
        platformsView();
      }
    }

    // ================= Profile =================

    async function profileView() {
      ui.main.innerHTML = '';
      const wrap = el('div', { class: 'job-search-wrap profile-wrap' });
      ui.main.append(wrap);
      let data;
      try { data = await get('/jobsearch/profile'); } catch (e) { wrap.append(el('div', { class: 'job-note err' }, e.message)); return; }
      const p = data.profile;
      S.profile = p;

      const meter = el('div', { class: 'prof-meter' },
        el('div', { class: 'prof-bar' }, el('div', { class: 'prof-fill', style: { width: data.completeness.pct + '%' } })),
        el('span', { class: 'small muted' }, `${data.completeness.pct}% complete${data.completeness.missing.length ? ' — missing: ' + data.completeness.missing.join(', ') : ''}`));
      wrap.append(el('h2', { class: 'prof-h' }, 'Your profile'), el('div', { class: 'muted small', style: { marginBottom: '6px' } },
        'This is the single source of truth the AI uses for fit-scoring, cover letters, and questionnaire answers. Import your resume once, then fine-tune.'), meter);

      // --- resume import ---
      const resumeBox = el('textarea', { class: 'input', rows: 5, placeholder: 'Paste your full resume text here (any format/language) and hit Import — the AI fills the profile below.' });
      const importBtn = el('button', {
        class: 'btn primary sm', onclick: async () => {
          if (!mref()) { toast('pick a model first', 'err'); return; }
          if (resumeBox.value.trim().length < 60) { toast('paste your resume text first', 'err'); return; }
          importBtn.disabled = true; importBtn.innerHTML = ''; importBtn.append(el('span', { class: 'spinner' }), ' parsing…');
          try { await post('/jobsearch/profile/import', { text: resumeBox.value, modelRef: mref() }); toast('resume imported', 'ok'); profileView(); }
          catch (e) { toast(e.message, 'err'); importBtn.disabled = false; importBtn.textContent = 'Import resume'; }
        },
      }, 'Import resume');
      wrap.append(sect('Import', el('div', {}, resumeBox, el('div', { class: 'row', style: { marginTop: '6px' } }, importBtn,
        el('span', { class: 'muted small' }, 'PDF? Open it and copy-paste the text.')))));

      // --- basics ---
      const c = p.contact;
      const fields = [];
      const field = (label, value, onsave, ph = '', wide = false) => {
        const inp = wide ? el('textarea', { class: 'input', rows: 3, placeholder: ph }) : el('input', { class: 'input', placeholder: ph });
        inp.value = value || '';
        inp.addEventListener('change', () => onsave(inp.value.trim()));
        fields.push(inp);
        return el('label', { class: 'prof-field' + (wide ? ' wide' : '') }, el('span', { class: 'pf-lbl' }, label), inp);
      };
      const saveP = async (patchObj) => { try { await put('/jobsearch/profile', patchObj); refreshStats(); } catch (e) { toast(e.message, 'err'); } };

      wrap.append(sect('Basics', el('div', { class: 'prof-grid' },
        field('Name', c.name, v => saveP({ contact: { name: v } })),
        field('Email', c.email, v => saveP({ contact: { email: v } })),
        field('Phone', c.phone, v => saveP({ contact: { phone: v } })),
        field('Location', c.location, v => saveP({ contact: { location: v } }), 'e.g. Tokyo, Japan'),
        field('LinkedIn', c.links.linkedin, v => saveP({ contact: { links: { ...c.links, linkedin: v } } })),
        field('GitHub / Portfolio', c.links.github || c.links.portfolio, v => saveP({ contact: { links: { ...c.links, github: v } } })),
        field('Work authorization', p.workAuth, v => saveP({ workAuth: v }), 'e.g. JP work visa (Engineer/Specialist), valid to 2027', true),
        field('Summary', p.summary, v => saveP({ summary: v }), 'a short professional summary in your voice', true),
      )));

      // --- standing answers ---
      const a = p.answers;
      wrap.append(sect('Standing answers (used to fill application forms)', el('div', { class: 'prof-grid' },
        field('Salary expectation', a.salaryExpectation, v => saveP({ answers: { salaryExpectation: v } }), 'e.g. ¥6-8M / negotiable'),
        field('Notice period', a.noticePeriod, v => saveP({ answers: { noticePeriod: v } }), 'e.g. immediately / 1 month'),
        field('Earliest start', a.earliestStart, v => saveP({ answers: { earliestStart: v } })),
        field('Relocation', a.relocation, v => saveP({ answers: { relocation: v } }), 'e.g. open within Japan'),
        field('Remote preference', a.remotePreference, v => saveP({ answers: { remotePreference: v } }), 'e.g. remote-first, hybrid OK'),
        field('Reason for leaving', a.reasonForLeaving, v => saveP({ answers: { reasonForLeaving: v } })),
      )));

      // --- custom Q&A the user teaches it ---
      const qaList = el('div', { class: 'qa-list' });
      const renderQA = () => {
        qaList.innerHTML = '';
        for (const [i, qa] of (a.custom || []).entries()) {
          qaList.append(el('div', { class: 'qa-item' },
            el('div', { class: 'qa-q' }, qa.q),
            el('div', { class: 'qa-a' }, qa.a),
            el('button', { class: 'btn sm ghost danger', onclick: async () => { a.custom.splice(i, 1); await saveP({ answers: { custom: a.custom } }); renderQA(); } }, icon('trash'))));
        }
      };
      renderQA();
      wrap.append(sect('Taught answers (add the questions forms keep asking)', el('div', {}, qaList,
        el('button', { class: 'btn sm', onclick: async () => {
          const qq = await askText({ title: 'Question', placeholder: 'e.g. Do you have experience with RLHF labeling?', ok: 'Next' });
          if (!qq) return;
          const aa = await askText({ title: 'Your answer', multiline: true, ok: 'Save' });
          if (aa === null) return;
          a.custom = [...(a.custom || []), { q: qq, a: aa }];
          await saveP({ answers: { custom: a.custom } });
          renderQA();
        } }, icon('plus'), 'Add Q&A'))));

      // --- imported structured data (read-only summary + JSON edit) ---
      const summ = [
        `skills: ${p.skills.length}`, `experience: ${p.experience.length}`, `education: ${p.education.length}`,
        `projects: ${p.projects.length}`, `languages: ${p.languages.map(l => l.lang).join(', ') || 0}`,
      ].join(' · ');
      wrap.append(sect('Imported data', el('div', {},
        el('div', { class: 'muted small' }, summ),
        el('button', { class: 'btn sm ghost', style: { marginTop: '6px' }, onclick: () => {
          const ta = el('textarea', { class: 'input mono', rows: 16 });
          ta.value = JSON.stringify({ skills: p.skills, experience: p.experience, education: p.education, projects: p.projects, certifications: p.certifications, languages: p.languages }, null, 2);
          modal({ title: 'Edit structured data (JSON)', wide: true, body: ta, actions: [
            { label: 'Cancel', value: null },
            { label: 'Save', kind: 'primary', onpick: async (close) => {
              try { await saveP(JSON.parse(ta.value)); toast('saved', 'ok'); close(true); profileView(); }
              catch (e) { toast('invalid JSON: ' + e.message, 'err'); }
              return false;
            } },
          ] });
        } }, 'Edit as JSON'))));

      // --- questionnaire tester ---
      wrap.append(sect('Try it — answer any questionnaire from this profile', el('div', {},
        el('button', { class: 'btn sm primary', onclick: () => answerModal(null) }, icon('sparkle'), 'Open questionnaire helper'))));

      function sect(title, bodyNode) { return el('div', { class: 'prof-sect' }, el('div', { class: 'job-sub' }, title), bodyNode); }
    }

    // ================= shared =================

    async function cycleSource() {
      const cur = state.config?.jobsearch?.source || 'searxng';
      const order = ['searxng', 'firecrawl', 'jobapi'];
      const next = order[(order.indexOf(cur) + 1) % order.length];
      try {
        state.config = await put('/config', { jobsearch: { source: next } });
        toast('source → ' + next, 'ok');
        refreshSource();
      } catch (e) { toast(e.message, 'err'); }
    }

    function setView(v) {
      S.view = v;
      for (const b of ui.seg.children) b.classList.toggle('on', b.dataset.view === v);
      ({ search: searchView, board: boardView, platforms: platformsView, profile: profileView }[v] || searchView)();
    }
    async function refreshStats() {
      try {
        const [s, prof] = await Promise.all([get('/jobs/stats'), get('/jobsearch/profile')]);
        ui.stats.textContent = `${s.total} tracked · ${s.applied} applied${s.needsReply ? ` · ${s.needsReply} need reply` : ''} · profile ${prof.completeness.pct}%`;
      } catch { ui.stats.textContent = ''; }
    }
    async function refreshSource() {
      try {
        const s = await get('/jobs/source');
        const ok = s.active === 'searxng' ? s.searxng : s.active === 'firecrawl' ? s.firecrawl : s.jobapi;
        ui.source.textContent = `source: ${s.active}${ok ? '' : ' (offline)'}`;
        ui.source.classList.toggle('warn', !ok);
      } catch { }
    }

    refreshSource(); refreshStats();
    setView(['board', 'platforms', 'profile'].includes(opts.view) ? opts.view : 'search');
    this.reopen = (w, o) => { if (o?.view) setView(o.view); };
  },
};
