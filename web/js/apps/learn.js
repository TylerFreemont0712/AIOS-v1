// Learning Corner v2 — a course, not a lesson generator.
//
// Left rail: the subject TREE (Programming → Python → Graphs). Any node can hold its
// own roadmap, lessons and exams, so a leaf is a full course in its own right.
// Middle: the roadmap as blocks — module number, capability, topics, state.
// Right: a three-view workspace (Lessons · Assessments · Report) so quizzes, exams and
// the honest progress report have somewhere to live that isn't bolted onto the reader.
//
// The Corner is adaptive: every graded answer moves per-topic mastery, and mastery
// decides what gets taught and asked next. The "Up next" card is the server's opinion
// (learn.suggestNext) rather than a dumb "next unfinished module" — it schedules a
// midterm the moment 3+ modules go untested, and a review when accuracy sags.

import { el, icon, toast, confirmBox, modal, menu, modelPicker, timeAgo, throttle, thinkingPanel } from '../ui.js';
import { get, post, patch, del, wsSend, sub } from '../api.js';
import { renderMd } from '../markdown.js';

const LEVELS = [['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']];

const KIND_META = {
  diagnostic: { label: 'Diagnostic', blurb: 'Finds what you already know — spans the whole roadmap, climbing until you break.' },
  quiz: { label: 'Quiz', blurb: 'A fast check on one module.' },
  midterm: { label: 'Midterm', blurb: 'Checkpoint over the modules you finished but never proved.' },
  final: { label: 'Final', blurb: 'The whole subject. Synthesis and judgment, not trivia.' },
  drill: { label: 'Drill', blurb: 'Rapid practice reps aimed at your measured weak spots. No pass bar — it just moves mastery.' },
};

const pct = (score, max) => (max ? Math.round((score / max) * 100) : 0);

// Lesson health, mirrored from the server's checker. 'error' means the artifact is
// damaged (the model narrated a search instead of writing, output got truncated) —
// that's a Regenerate. 'warn' means it's a real lesson missing some house style.
const healthLevel = (h = []) => h.some(i => i.level === 'error') ? 'error' : h.length ? 'warn' : '';
const healthText = (h = []) => h.map(i => i.text).join(' · ');

export default {
  id: 'learn', title: 'Learning', icon: 'learn', width: 1320, height: 820,

  mount(body, opts, win) {
    const S = win.learnState = {
      id: null, subject: null, subjects: [], unsub: null, running: false,
      buf: '', liveEl: null, think: null, reasonEl: null,
      lessonSel: null, lessonBody: null,
      view: 'lessons',                    // lessons | assess | report
      collapsed: new Set(),               // subject ids collapsed in the tree
      quiz: null,                         // { assessment, attemptId, answers, result }
      report: null,
    };
    const ui = {};

    // ---------- chrome ----------

    const side = el('div', { class: 'side' },
      el('div', { class: 'side-head' },
        el('span', { class: 'ttl' }, 'Subjects'),
        el('button', { class: 'btn sm ghost', title: 'New top-level subject', onclick: () => newSubject(null) }, icon('plus'))),
      ui.list = el('div', { class: 'side-list learn-tree' }));

    ui.model = modelPicker({ storageKey: 'learn' });
    ui.next = el('button', { class: 'btn sm primary', onclick: () => genLesson() }, icon('sparkle'), 'Next lesson');
    ui.assessBtn = el('button', {
      class: 'btn sm', title: 'Create an assessment',
      onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const mods = S.subject?.roadmap?.modules || [];
        const cur = mods.find(m => !m.done) || mods[0];
        menu(r.left, r.bottom + 4, [
          { label: 'Diagnostic — find my level', icon: 'search', onclick: () => genAssessment('diagnostic') },
          { label: cur ? `Quiz — ${cur.title.slice(0, 34)}` : 'Quiz — current module', icon: 'learn', onclick: () => genAssessment('quiz', { moduleId: cur?.id }) },
          { label: 'Drill — rapid reps on weak spots', icon: 'refresh', onclick: () => genAssessment('drill') },
          '-',
          { label: 'Midterm — untested modules', icon: 'research', onclick: () => genAssessment('midterm') },
          { label: 'Final — whole subject', icon: 'star', onclick: () => genAssessment('final') },
        ]);
      },
    }, icon('learn'), 'Assess ', icon('chevD'));
    ui.feedback = el('button', { class: 'btn sm', title: 'A brutally honest read on where you stand', onclick: () => genFeedback() }, icon('research'), 'Feedback');
    ui.stop = el('button', { class: 'btn sm danger', style: { display: 'none' }, onclick: () => wsSend({ t: 'learn.cancel', id: S.id }) }, icon('stop'), 'Stop');

    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl row', style: { gap: '7px' } }, icon('learn'), 'Learning corner'),
      ui.model, ui.next, ui.assessBtn, ui.feedback, ui.stop,
      el('span', { class: 'grow' }),
      el('button', { class: 'btn sm ghost', title: 'Add a sub-subject under this one', onclick: () => newSubject(S.id) }, icon('plus')),
      el('button', { class: 'btn sm ghost', title: 'Edit subject', onclick: () => editSubject() }, icon('edit')),
      el('button', { class: 'btn sm ghost danger', title: 'Delete subject', onclick: () => deleteSubject() }, icon('trash')));

    ui.road = el('div', { class: 'learn-road' });
    ui.main = el('div', { class: 'learn-main' });
    body.append(el('div', { class: 'app-cols' }, side,
      el('div', { class: 'main-pane' }, ui.head, el('div', { class: 'learn-cols' }, ui.road, ui.main))));

    // ---------- subject tree ----------

    async function refreshList() {
      try { S.subjects = await get('/learn'); } catch (e) { toast(e.message, 'err'); S.subjects = []; }
      ui.list.innerHTML = '';
      const kids = (parentId) => S.subjects.filter(s => (s.parentId || null) === parentId);
      const paint = (parentId, depth) => {
        for (const s of kids(parentId)) {
          const children = kids(s.id);
          const isCollapsed = S.collapsed.has(s.id);
          const twisty = el('button', {
            class: 'learn-twisty' + (children.length ? '' : ' hidden'),
            title: isCollapsed ? 'Expand' : 'Collapse',
            onclick: (e) => {
              e.stopPropagation();
              S.collapsed.has(s.id) ? S.collapsed.delete(s.id) : S.collapsed.add(s.id);
              refreshList();
            },
          });
          twisty.append(icon(isCollapsed ? 'chevR' : 'chevD'));
          ui.list.append(el('div', {
            class: 'side-item learn-tree-item' + (s.id === S.id ? ' sel' : ''),
            style: { paddingLeft: (8 + depth * 14) + 'px' },
            onclick: () => load(s.id),
            oncontextmenu: (e) => {
              e.preventDefault();
              menu(e.clientX, e.clientY, [
                { label: 'Add sub-subject', icon: 'plus', onclick: () => newSubject(s.id) },
                { label: 'Edit', icon: 'edit', onclick: () => { S.id = s.id; editSubject(); } },
                '-',
                { label: 'Delete', icon: 'trash', danger: true, onclick: () => { S.id = s.id; deleteSubject(); } },
              ]);
            },
          },
            el('div', { class: 'row', style: { gap: '2px', alignItems: 'center' } },
              twisty,
              el('span', { class: 'grow learn-tree-name' }, s.name),
              s.mastery !== null && s.mastery !== undefined
                ? el('span', { class: 'learn-mini-pct ' + (s.mastery >= 80 ? 'good' : s.mastery >= 60 ? 'mid' : 'bad'), title: 'measured mastery' }, s.mastery + '%')
                : null),
            el('div', { class: 'sub' }, `${s.modulesDone}/${s.modules} modules · ${s.lessons} lessons${s.assessments ? ` · ${s.assessments} exams` : ''}`)));
          if (!isCollapsed) paint(s.id, depth + 1);
        }
      };
      paint(null, 0);
      if (!S.subjects.length) ui.list.append(el('div', { class: 'empty', style: { minHeight: '70px' } }, 'no subjects yet'));
      return S.subjects;
    }

    function subjectForm(init = {}, parentName = '') {
      const name = el('input', { class: 'input', placeholder: 'Subject — e.g. Python, Dijkstra\'s, Music theory', value: init.name || '' });
      const goal = el('textarea', { class: 'input', rows: 3, placeholder: 'Goal — what should you be able to DO? (steers the roadmap)' }, init.goal || '');
      const level = el('select', { class: 'input select' }, ...LEVELS.map(([v, l]) => el('option', { value: v, selected: (init.level || 'beginner') === v ? '' : undefined }, l)));
      const bodyEl = el('div', { class: 'col', style: { gap: '8px' } },
        parentName ? el('div', { class: 'muted small' }, 'Nested under ', el('b', {}, parentName)) : null,
        name, goal, el('label', { class: 'row small muted', style: { gap: '8px' } }, 'Level', level));
      return { bodyEl, values: () => ({ name: name.value.trim(), goal: goal.value.trim(), level: level.value }) };
    }

    async function newSubject(parentId) {
      const parent = parentId ? S.subjects.find(s => s.id === parentId) : null;
      const f = subjectForm({}, parent?.name || '');
      const ok = await modal({
        title: parent ? `New sub-subject in ${parent.name}` : 'New subject',
        sub: 'The tutor designs a roadmap for it — modules in prerequisite order, projects included. Sub-subjects get their own roadmap, lessons and exams, scoped so the parent is not re-taught.',
        body: f.bodyEl,
        actions: [{ label: 'Cancel', value: null }, { label: 'Create', kind: 'primary', value: true }],
      });
      if (!ok) return;
      const v = f.values();
      if (!v.name) { toast('subject needs a name', 'err'); return; }
      try {
        const s = await post('/learn', { ...v, parentId: parentId || null });
        if (parentId) S.collapsed.delete(parentId);
        await load(s.id);
      } catch (e) { toast(e.message, 'err'); }
    }

    async function editSubject() {
      if (!S.subject) return;
      const f = subjectForm(S.subject);
      const ok = await modal({ title: 'Edit subject', body: f.bodyEl, actions: [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', value: true }] });
      if (!ok) return;
      try { await patch('/learn/' + S.id, f.values()); await load(S.id); }
      catch (e) { toast(e.message, 'err'); }
    }

    async function deleteSubject() {
      if (!S.id) return;
      const s = S.subjects.find(x => x.id === S.id);
      const kids = S.subjects.filter(x => x.parentId === S.id).length;
      if (!await confirmBox(`Delete "${s?.name || 'this subject'}"?`,
        `Its roadmap, lessons, quizzes and scores go too${kids ? `, along with ${kids} sub-subject${kids > 1 ? 's' : ''} beneath it` : ''}. Vault exports stay.`)) return;
      try { await del('/learn/' + S.id); } catch (e) { toast(e.message, 'err'); return; }
      S.id = null; S.subject = null;
      const subjects = await refreshList();
      if (subjects[0]) load(subjects[0].id); else { ui.road.innerHTML = ''; ui.main.innerHTML = ''; }
    }

    // ---------- load & paint ----------

    async function load(id, { keepLesson = false, keepView = true } = {}) {
      S.unsub?.(); S.unsub = null;
      let s;
      try { s = await get('/learn/' + id); } catch (e) { toast(e.message, 'err'); return; }
      const switched = S.id !== id;
      S.id = id; S.subject = s;
      if (switched) { S.quiz = null; S.report = null; if (!keepView) S.view = 'lessons'; }
      if (!keepLesson || switched) S.lessonSel = s.lessons?.length ? s.lessons[s.lessons.length - 1].id : null;
      setRunning(s.running);
      paintRoad();
      await paintMain();
      refreshList();
      if (s.running) S.unsub = sub('learn:' + id, onEvent);
    }

    const doneCount = () => (S.subject?.roadmap?.modules || []).filter(m => m.done).length;

    // ---------- the roadmap rail (blocky) ----------

    function paintRoad() {
      const s = S.subject;
      ui.road.innerHTML = '';
      if (!s) return;
      const mods = s.roadmap?.modules || [];

      if (s.path.length > 1) {
        ui.road.append(el('div', { class: 'learn-crumbs' },
          ...s.path.flatMap((p, i) => [
            i ? el('span', { class: 'learn-crumb-sep' }, '›') : null,
            el('button', { class: 'learn-crumb' + (p.id === s.id ? ' on' : ''), onclick: () => p.id !== s.id && load(p.id) }, p.name),
          ].filter(Boolean))));
      }
      ui.road.append(el('div', { class: 'learn-sub-name' }, s.name));
      ui.road.append(el('div', { class: 'muted small', style: { lineHeight: '1.5' } }, s.goal || 'no goal set — edit the subject to steer the roadmap'));

      ui.road.append(el('div', { class: 'row small', style: { gap: '6px', margin: '8px 0 2px', flexWrap: 'wrap' } },
        el('span', { class: 'learn-tag' }, s.level),
        el('span', { class: 'learn-tag' }, mods.length ? `${doneCount()}/${mods.length} modules` : 'no roadmap'),
        el('span', { class: 'learn-tag' }, `${s.lessons.length} lessons`),
        s.mastery.pct !== null
          ? el('span', { class: 'learn-tag ' + (s.mastery.pct >= 80 ? 'good' : s.mastery.pct >= 60 ? 'mid' : 'bad'), title: `${s.mastery.correct}/${s.mastery.seen} graded answers correct across ${s.mastery.topics} topics` }, `${s.mastery.pct}% mastery`)
          : el('span', { class: 'learn-tag', title: 'Take a quiz or diagnostic to start measuring' }, 'unmeasured')));

      if (mods.length) {
        ui.road.append(el('div', { class: 'learn-progress' },
          el('div', { class: 'learn-progress-fill', style: { width: Math.round(doneCount() / mods.length * 100) + '%' } })));
      }

      // "Up next" — the server's scheduling opinion, one click from acting on it.
      if (s.nextUp && !S.running) {
        const n = s.nextUp;
        const act = {
          roadmap: ['Generate roadmap', () => genRoadmap()],
          lesson: ['Teach it', () => genLesson(n.moduleId, n.topic)],
          review: ['Review lesson', () => genLesson(null, null, true)],
          quiz: ['Quiz me', () => genAssessment('quiz', { moduleId: n.moduleId })],
          midterm: ['Sit the midterm', () => genAssessment('midterm')],
          final: ['Sit the final', () => genAssessment('final')],
          done: [null, null],
        }[n.kind] || [null, null];
        ui.road.append(el('div', { class: 'learn-next-card kind-' + n.kind },
          el('div', { class: 'learn-lbl' }, 'UP NEXT'),
          el('div', { class: 'learn-next-why' }, n.why),
          act[0] ? el('button', { class: 'btn sm primary', style: { marginTop: '8px' }, onclick: act[1] }, icon('sparkle'), act[0]) : null));
      }

      ui.road.append(el('button', {
        class: 'btn sm' + (mods.length ? ' ghost' : ' primary'), style: { margin: '4px 0' },
        onclick: () => genRoadmap(),
      }, icon('sparkle'), mods.length ? 'Regenerate roadmap' : 'Generate roadmap'));

      // Modules as BLOCKS: a numbered tile, capability line, topic chips, actions.
      mods.forEach((m, i) => {
        const lessonsHere = s.lessons.filter(l => l.moduleId === m.id).length;
        const block = el('div', { class: 'learn-mod' + (m.done ? ' done' : '') + (m.kind !== 'standard' ? ' ' + m.kind : '') },
          el('div', { class: 'learn-mod-top' },
            el('div', { class: 'learn-mod-num' }, m.done ? icon('check') : String(i + 1)),
            el('div', { class: 'grow' },
              el('div', { class: 'learn-mod-title' }, m.title),
              m.summary ? el('div', { class: 'muted small learn-mod-sum' }, m.summary) : null),
            el('button', {
              class: 'btn sm ghost learn-mod-menu', title: 'Module actions',
              onclick: (e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                menu(r.left, r.bottom + 4, [
                  { label: 'Teach next lesson', icon: 'play', onclick: () => genLesson(m.id) },
                  { label: 'Quiz this module', icon: 'learn', onclick: () => genAssessment('quiz', { moduleId: m.id }) },
                  '-',
                  { label: m.done ? 'Mark incomplete' : 'Mark complete', icon: 'check', onclick: () => toggleModule(m) },
                ]);
              },
            }, icon('chevD'))),
          m.kind !== 'standard' ? el('span', { class: 'learn-kind-flag' }, m.kind) : null,
          m.topics?.length ? el('div', { class: 'learn-topics' }, ...m.topics.map(t => {
            const taught = s.lessons.some(l => (l.topic || '').toLowerCase() === t.toLowerCase());
            return el('button', {
              class: 'learn-topic' + (taught ? ' taught' : ''),
              title: taught ? 'Taught — click to teach again' : 'Not taught yet — click to teach this now',
              onclick: () => genLesson(m.id, t),
            }, taught ? '✓ ' + t : t);
          })) : null,
          el('div', { class: 'learn-mod-foot' },
            el('span', { class: 'muted' }, lessonsHere ? `${lessonsHere} lesson${lessonsHere > 1 ? 's' : ''}` : 'no lessons yet')));
        ui.road.append(block);
      });

      if (s.weak?.length) {
        ui.road.append(el('div', { class: 'learn-weak' },
          el('div', { class: 'learn-lbl' }, 'WEAK SPOTS (MEASURED)'),
          ...s.weak.map(w => el('button', {
            class: 'learn-weak-row', title: `${w.correct}/${w.seen} correct — click to teach a review lesson on this`,
            onclick: () => genLesson(null, w.topic),
          },
            el('span', { class: 'grow learn-weak-topic' }, w.topic),
            el('span', { class: 'learn-weak-bar' }, el('span', { class: 'learn-weak-fill ' + (w.ratio >= 0.8 ? 'good' : w.ratio >= 0.6 ? 'mid' : 'bad'), style: { width: Math.round(w.ratio * 100) + '%' } })),
            el('span', { class: 'learn-weak-pct' }, Math.round(w.ratio * 100) + '%')))));
      }
    }

    async function toggleModule(m) {
      try {
        await post(`/learn/${S.id}/modules/${m.id}`, { done: !m.done });
        m.done = !m.done;
        paintRoad(); refreshList();
      } catch (e) { toast(e.message, 'err'); }
    }

    // ---------- the workspace (Lessons · Assessments · Report) ----------

    function viewSwitch() {
      const s = S.subject;
      const tab = (id, label, count) => el('button', {
        class: 'learn-tab' + (S.view === id ? ' on' : ''),
        onclick: () => { S.view = id; paintMain(); },
      }, label, count ? el('span', { class: 'learn-tab-count' }, String(count)) : null);
      return el('div', { class: 'learn-tabs' },
        tab('lessons', 'Lessons', s.lessons.length),
        tab('assess', 'Assessments', s.assessments.length),
        tab('paths', 'Paths', (s.advice?.certs?.length || 0) + (s.advice?.paths?.length || 0) || null),
        tab('report', 'Report'));
    }

    async function paintMain() {
      const s = S.subject;
      ui.main.innerHTML = '';
      S.liveEl = null; S.think = null; S.reasonEl = null; S.buf = '';
      if (!s) return;

      if (!s.roadmap?.modules?.length && !s.running) {
        ui.main.append(el('div', { class: 'res-hero' },
          el('h1', {}, s.name),
          el('div', { class: 'sub' }, 'No roadmap yet. The tutor checks what current curricula emphasize (web search), then designs capability modules in prerequisite order — projects included. Generate it, then take lessons, quizzes and exams one at a time.'),
          el('div', { class: 'row', style: { gap: '8px', marginTop: '14px', justifyContent: 'center' } },
            el('button', { class: 'btn primary', onclick: () => genRoadmap() }, icon('sparkle'), 'Generate roadmap'),
            el('button', { class: 'btn', title: 'Do not know where to start? Let the tutor find your level first.', onclick: () => genAssessment('diagnostic') }, icon('search'), 'Assess my level first'))));
        return;
      }

      ui.main.append(viewSwitch());
      ui.reader = el('div', { class: 'learn-reader' });
      ui.main.append(ui.reader);

      if (S.view === 'lessons') await paintLessons();
      else if (S.view === 'assess') await paintAssessments();
      else if (S.view === 'paths') paintPaths();
      else paintReport();

      if (s.error && !s.running) ui.reader.append(el('div', { class: 'res-line error' }, icon('x'), el('span', {}, s.error)));
    }

    // ---- lessons view ----

    async function paintLessons() {
      const s = S.subject;
      if (s.lessons.length) {
        const strip = el('div', { class: 'learn-lessons' });
        for (const l of s.lessons) {
          const lvl = healthLevel(l.health);
          strip.append(el('button', {
            class: 'learn-lesson-block' + (l.id === S.lessonSel ? ' on' : '') + (l.done ? ' done' : '') + (lvl ? ' h-' + lvl : ''),
            title: lvl ? `${lvl === 'error' ? 'DAMAGED' : 'minor gaps'}: ${healthText(l.health)}` : `${l.module || ''} · ${timeAgo(l.createdAt)}`,
            onclick: async () => { S.lessonSel = l.id; S.lessonBody = null; await paintMain(); },
          },
            el('span', { class: 'learn-lesson-n' }, String(l.n)),
            el('span', { class: 'learn-lesson-t' }, l.title),
            lvl ? el('span', { class: 'learn-lesson-warn ' + lvl }, lvl === 'error' ? '!' : '·') : null,
            el('span', { class: 'learn-lesson-type' }, l.type)));
        }
        ui.reader.append(strip);
      }

      const cur = s.lessons.find(l => l.id === S.lessonSel);
      if (!cur) {
        if (!s.running) ui.reader.append(el('div', { class: 'empty', style: { minHeight: '120px' } },
          'no lessons yet — hit "Next lesson" and the tutor searches current sources, then writes lesson 1'));
        return;
      }
      // content is fetched per lesson (the subject payload carries metadata only)
      let full = S.lessonBody?.id === cur.id ? S.lessonBody : null;
      if (!full) {
        try { full = await get(`/learn/${S.id}/lessons/${cur.id}`); S.lessonBody = full; }
        catch (e) { ui.reader.append(el('div', { class: 'res-line error' }, icon('x'), el('span', {}, e.message))); return; }
      }
      ui.reader.append(el('div', { class: 'row small muted', style: { gap: '10px', flexWrap: 'wrap' } },
        el('span', { class: 'learn-tag' }, full.type || 'lesson'),
        el('span', {}, cur.module || ''),
        el('span', {}, full.revisedAt ? `revised ${timeAgo(full.revisedAt)}` : timeAgo(full.createdAt)),
        full.exportedTo ? el('span', { title: full.exportedTo }, '✓ in vault') : null,
        el('span', { class: 'grow' }),
        el('button', { class: 'btn sm ghost', title: 'Rewrite this lesson in place — the current version is saved first', onclick: () => regenLesson(cur, full) }, icon('refresh'), 'Regenerate'),
        el('button', { class: 'btn sm ghost', title: 'Previous versions of this lesson', onclick: () => showRevisions(cur) }, icon('daily')),
        el('button', { class: 'btn sm', title: 'Quiz me on this lesson', onclick: () => genAssessment('quiz', { lessonId: cur.id, moduleId: cur.moduleId }) }, icon('learn'), 'Quiz this lesson'),
        doneToggle(cur)));

      // If the lesson came out damaged, say so where it's being read — and make the fix
      // one click. This is the case the model can't self-report: it thinks it succeeded.
      const lvl = healthLevel(full.health);
      if (lvl) {
        const errs = full.health.filter(i => i.level === 'error');
        const warns = full.health.filter(i => i.level === 'warn');
        ui.reader.append(el('div', { class: 'learn-health ' + lvl },
          el('div', { class: 'row', style: { gap: '7px', alignItems: 'flex-start' } },
            icon(lvl === 'error' ? 'x' : 'shield'),
            el('div', { class: 'grow' },
              el('div', { class: 'learn-health-title' },
                lvl === 'error' ? 'This lesson looks damaged' : 'This lesson has minor gaps'),
              el('ul', { class: 'learn-health-list' },
                ...[...errs, ...warns].map(i => el('li', { class: i.level }, i.text)))),
            lvl === 'error'
              ? el('button', { class: 'btn sm primary', title: 'Rewrite it, telling the model exactly what went wrong', onclick: () => regenLesson(cur, full, { auto: true }) }, icon('sparkle'), 'Fix it')
              : null)));
      }
      ui.reader.append(el('div', { class: 'ev-text res-report' }, renderMd(full.content)));

      if (full.next?.length) {
        ui.reader.append(el('div', { class: 'learn-next' },
          el('div', { class: 'learn-lbl' }, 'NEXT LESSON IDEAS'),
          ...full.next.map(idea => el('button', { class: 'btn sm ghost', style: { justifyContent: 'flex-start', textAlign: 'left' }, onclick: () => genLesson(null, idea) }, '→ ', idea))));
      }
    }

    /** Rewrite a lesson in place. `auto` skips the dialog and sends the detected health
     *  problems as the brief — that's the "Fix it" button on the damage banner. */
    async function regenLesson(lesson, full, { auto = false } = {}) {
      if (S.running || !needModel()) return;
      const issues = full?.health || lesson.health || [];
      let instructions = '', useWeb = true;

      if (auto) {
        instructions = '';        // server turns the recorded issues into the brief
        // If generation derailed into narrating a web search, retrying WITH search is
        // asking for the same failure. Default that case to offline.
        useWeb = !issues.some(i => /narrat|derail/i.test(i.text));
      } else {
        const what = el('textarea', {
          class: 'input', rows: 3,
          placeholder: issues.length
            ? 'What should change? Leave blank to use the detected problems as the brief.'
            : 'What should change? e.g. "too shallow on closures", "the code does not run", "it was cut off".',
        });
        const web = el('input', { type: 'checkbox', checked: true });
        const body = el('div', { class: 'col', style: { gap: '9px' } },
          issues.length
            ? el('div', { class: 'learn-health ' + healthLevel(issues), style: { margin: 0 } },
              el('div', { class: 'learn-health-title' }, 'Detected problems'),
              el('ul', { class: 'learn-health-list' }, ...issues.map(i => el('li', { class: i.level }, i.text))))
            : null,
          what,
          el('label', { class: 'row small muted', style: { gap: '7px' } }, web,
            'Search the web for current sources (uncheck if generation keeps hanging or derailing — writes from fundamentals instead)'),
          el('div', { class: 'muted small' }, 'Lesson ', el('b', {}, String(lesson.n)), ' keeps its slot and id. The current version is saved to history first, so you can restore it.'));
        const ok = await modal({
          title: `Regenerate lesson ${lesson.n}`,
          sub: lesson.title,
          body,
          actions: [{ label: 'Cancel', value: null }, { label: 'Regenerate', kind: 'primary', value: true }],
        });
        if (!ok) return;
        instructions = what.value.trim();
        useWeb = web.checked;
      }
      S.view = 'lessons'; S.lessonSel = lesson.id; S.lessonBody = null;
      try {
        await post(`/learn/${S.id}/lessons/${lesson.id}/regenerate`, {
          instructions: instructions || undefined, useWeb, modelRef: ui.model.getValue(),
        });
        startStream(`Rewriting lesson ${lesson.n}`);
      } catch (e) { toast(e.message, 'err'); }
    }

    async function showRevisions(lesson) {
      let revs = [];
      try { revs = await get(`/learn/${S.id}/lessons/${lesson.id}/revisions`); }
      catch (e) { toast(e.message, 'err'); return; }
      if (!revs.length) { toast('no previous versions — this lesson has never been regenerated', 'ok'); return; }

      const list = el('div', { class: 'col', style: { gap: '7px' } });
      let picked = revs[0].id;
      for (const r of revs) {
        const lvl = healthLevel(r.health);
        const radio = el('input', { type: 'radio', name: 'rev', checked: r.id === picked, onchange: () => { picked = r.id; } });
        list.append(el('label', { class: 'learn-rev' },
          el('div', { class: 'row', style: { gap: '8px', alignItems: 'flex-start' } },
            radio,
            el('div', { class: 'grow' },
              el('div', { class: 'learn-rev-title' }, r.title || '(untitled)'),
              el('div', { class: 'muted small' }, `${timeAgo(r.createdAt)} · ${r.chars.toLocaleString()} chars · ${r.sources} source${r.sources === 1 ? '' : 's'}${lvl ? ` · ${lvl === 'error' ? 'was damaged' : 'had gaps'}` : ' · clean'}`),
              r.reason ? el('div', { class: 'muted small', style: { marginTop: '3px', fontStyle: 'italic' } }, '“', r.reason, '”') : null),
            el('button', {
              class: 'btn sm ghost', title: 'Preview this version',
              onclick: async (e) => {
                e.preventDefault(); e.stopPropagation();
                try {
                  const full = await get(`/learn/${S.id}/lessons/${lesson.id}/revisions/${r.id}`);
                  await modal({
                    title: full.title || 'Previous version', sub: timeAgo(full.createdAt), xl: true,
                    body: el('div', { class: 'ev-text res-report', style: { maxHeight: '60vh', overflowY: 'auto' } }, renderMd(full.content)),
                    actions: [{ label: 'Close', value: null }],
                  });
                } catch (err) { toast(err.message, 'err'); }
              },
            }, icon('eye')))));
      }
      const ok = await modal({
        title: `Lesson ${lesson.n} — previous versions`,
        sub: 'Every regenerate snapshots the version it replaced. Restoring snapshots the current one first, so nothing is ever lost.',
        wide: true, body: list,
        actions: [{ label: 'Cancel', value: null }, { label: 'Restore selected', kind: 'primary', value: true }],
      });
      if (!ok || !picked) return;
      try {
        await post(`/learn/${S.id}/lessons/${lesson.id}/revisions/${picked}/restore`, {});
        toast('previous version restored', 'ok');
        S.lessonBody = null;
        await load(S.id, { keepLesson: true });
      } catch (e) { toast(e.message, 'err'); }
    }

    function doneToggle(lesson) {
      const b = el('button', { class: 'btn sm ' + (lesson.done ? '' : 'ghost') }, lesson.done ? '✓ completed' : 'mark complete');
      b.onclick = async () => {
        try {
          await post(`/learn/${S.id}/lessons/${lesson.id}`, { done: !lesson.done });
          lesson.done = !lesson.done;
          await paintMain(); refreshList();
        } catch (e) { toast(e.message, 'err'); }
      };
      return b;
    }

    // ---- assessments view ----

    async function paintAssessments() {
      const s = S.subject;
      if (S.quiz) { paintQuiz(); return; }

      ui.reader.append(el('div', { class: 'learn-assess-head' },
        el('div', { class: 'learn-lbl' }, 'ASSESSMENTS'),
        el('div', { class: 'muted small' }, 'Quizzes check a module. Midterms fire every 3-4 finished modules and cover what you never proved. Passing an exam marks its modules complete.')));

      if (!s.assessments.length) {
        ui.reader.append(el('div', { class: 'empty', style: { minHeight: '110px' } },
          'no assessments yet — use the Assess menu, or take a diagnostic to find your level'));
      }

      for (const a of s.assessments) {
        const meta = KIND_META[a.kind] || { label: a.kind };
        const best = a.best;
        ui.reader.append(el('div', { class: 'learn-assess-card kind-' + a.kind },
          el('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-start' } },
            el('span', { class: 'learn-kind-badge kind-' + a.kind }, meta.label),
            el('div', { class: 'grow' },
              el('div', { class: 'learn-assess-title' }, a.title),
              el('div', { class: 'muted small' }, a.blurb || meta.blurb || ''),
              el('div', { class: 'muted small', style: { marginTop: '4px' } },
                `${a.questions} questions · pass ${a.passPct}% · ${a.attempts} attempt${a.attempts === 1 ? '' : 's'} · ${timeAgo(a.createdAt)}`)),
            best
              ? el('span', { class: 'learn-score ' + (best.passed ? 'good' : 'bad'), title: `best: ${best.score}/${best.maxScore}` },
                pct(best.score, best.maxScore) + '%')
              : el('span', { class: 'learn-score none' }, '—')),
          el('div', { class: 'row', style: { gap: '6px', marginTop: '9px' } },
            el('button', { class: 'btn sm primary', onclick: () => startQuiz(a) }, icon('play'), a.attempts ? 'Retake' : 'Take it'),
            best ? el('button', { class: 'btn sm ghost', onclick: () => reviewLast(a) }, 'Review answers') : null,
            el('span', { class: 'grow' }),
            el('button', { class: 'btn sm ghost danger', title: 'Delete this assessment', onclick: () => removeAssessment(a) }, icon('trash')))));
      }
    }

    async function removeAssessment(a) {
      if (!await confirmBox(`Delete "${a.title}"?`, 'Its questions and every attempt/score go with it. Mastery already recorded stays.')) return;
      try { await del(`/learn/${S.id}/assessment/${a.id}`); toast('assessment deleted', 'ok'); await load(S.id); }
      catch (e) { toast(e.message, 'err'); }
    }

    async function startQuiz(a) {
      try {
        const paper = await get(`/learn/${S.id}/assessment/${a.id}`);
        if (!paper.questions.length) { toast('this assessment has no questions', 'err'); return; }
        const at = await post(`/learn/${S.id}/assessment/${a.id}/start`, {});
        S.quiz = { assessment: paper, attemptId: at.id, answers: {}, result: null, grading: false };
        await paintMain();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function reviewLast(a) {
      try {
        const paper = await get(`/learn/${S.id}/assessment/${a.id}`);
        const last = paper.attempts[0];
        if (!last) { toast('no submitted attempts yet', 'err'); return; }
        const t = await get(`/learn/${S.id}/attempt/${last.id}`);
        S.quiz = { assessment: paper, attemptId: last.id, answers: {}, result: t };
        await paintMain();
      } catch (e) { toast(e.message, 'err'); }
    }

    // ---- the quiz runner ----

    function paintQuiz() {
      const { assessment: a, result } = S.quiz;
      const meta = KIND_META[a.kind] || { label: a.kind };

      ui.reader.append(el('div', { class: 'learn-quiz-head' },
        el('button', { class: 'btn sm ghost', onclick: async () => { S.quiz = null; await paintMain(); } }, '← Back'),
        el('span', { class: 'learn-kind-badge kind-' + a.kind }, meta.label),
        el('span', { class: 'grow learn-quiz-title' }, a.title),
        result
          ? el('span', { class: 'learn-score ' + (result.passed ? 'good' : 'bad') }, `${result.score}/${result.maxScore} · ${pct(result.score, result.maxScore)}%`)
          : el('span', { class: 'muted small' }, `${a.questions.length} questions · pass ${a.passPct}%`)));

      if (result) {
        ui.reader.append(el('div', { class: 'learn-verdict ' + (result.passed ? 'pass' : 'fail') },
          el('div', { class: 'learn-verdict-big' }, result.passed ? 'PASS' : 'NOT YET'),
          el('div', { class: 'muted small' },
            result.passed
              ? `${pct(result.score, result.maxScore)}% — above the ${a.passPct}% bar.${a.kind === 'midterm' || a.kind === 'final' ? ' The modules it covered are now marked complete.' : ''}`
              : `${pct(result.score, result.maxScore)}% — the bar is ${a.passPct}%. Every miss below moved your weak spots; the tutor will aim the next lesson there.`)));
      }

      const byId = new Map((result?.responses || []).map(r => [r.questionId, r]));

      a.questions.forEach((q, i) => {
        const r = byId.get(q.id);
        const card = el('div', { class: 'learn-q' + (r ? (r.correct ? ' correct' : ' wrong') : '') });
        card.append(el('div', { class: 'learn-q-head' },
          el('span', { class: 'learn-q-n' }, String(i + 1)),
          el('span', { class: 'grow learn-q-prompt' }, q.prompt),
          el('span', { class: 'learn-q-meta' },
            q.topic ? el('span', { class: 'learn-tag sm' }, q.topic) : null,
            el('span', { class: 'learn-tag sm diff-' + q.difficulty }, q.difficulty),
            el('span', { class: 'learn-tag sm' }, q.points + (q.points > 1 ? ' pts' : ' pt')),
            r ? el('span', { class: 'learn-q-mark' }, r.correct ? '✓' : '✗') : null)));

        if (q.kind === 'open') {
          const ta = el('textarea', {
            class: 'input learn-q-open', rows: 5,
            placeholder: 'Write your answer — the tutor grades it against a rubric, so reasoning counts.',
            disabled: !!result,
            oninput: (e) => { S.quiz.answers[q.id] = e.target.value; },
          }, r ? r.given : (S.quiz.answers[q.id] || ''));
          card.append(ta);
        } else {
          const group = el('div', { class: 'learn-choices' });
          q.choices.forEach((c, ci) => {
            const picked = r
              ? pickedIn(r, ci)
              : (q.kind === 'multi'
                ? (S.quiz.answers[q.id] || []).includes(String(ci))
                : S.quiz.answers[q.id] === String(ci));
            const isRight = r ? rightIn(r, ci) : false;
            const opt = el('label', {
              class: 'learn-choice' + (picked ? ' picked' : '') + (r && isRight ? ' right' : '') + (r && picked && !isRight ? ' wrongpick' : ''),
            },
              el('input', {
                type: q.kind === 'multi' ? 'checkbox' : 'radio',
                name: 'q_' + q.id, checked: picked, disabled: !!result,
                onchange: (e) => {
                  if (q.kind === 'multi') {
                    const set = new Set(S.quiz.answers[q.id] || []);
                    e.target.checked ? set.add(String(ci)) : set.delete(String(ci));
                    S.quiz.answers[q.id] = [...set];
                  } else {
                    S.quiz.answers[q.id] = String(ci);
                  }
                  paintProgress();
                },
              }),
              el('span', { class: 'learn-choice-key' }, String.fromCharCode(65 + ci)),
              el('span', { class: 'grow' }, c));
            group.append(opt);
          });
          if (q.kind === 'multi') card.append(el('div', { class: 'muted small', style: { marginBottom: '4px' } }, 'Select all that apply — partial credit, but a wrong pick zeroes it.'));
          card.append(group);
        }

        if (r) {
          card.append(el('div', { class: 'learn-q-why' },
            el('div', { class: 'learn-lbl' }, r.correct ? 'WHY THIS IS RIGHT' : 'WHAT WENT WRONG'),
            r.kind === 'open' && r.feedback ? el('div', { class: 'learn-q-grader' }, r.feedback) : null,
            r.explanation ? el('div', {}, r.explanation) : null,
            el('div', { class: 'muted small', style: { marginTop: '5px' } }, `scored ${r.points}/${r.worth}`)));
        }
        ui.reader.append(card);
      });

      if (!result) {
        ui.quizProgress = el('span', { class: 'muted small' });
        ui.submit = el('button', { class: 'btn primary', onclick: () => submitQuiz() }, icon('check'), 'Submit for grading');
        ui.reader.append(el('div', { class: 'learn-quiz-foot' }, ui.quizProgress, el('span', { class: 'grow' }), ui.submit));
        paintProgress();
      } else {
        ui.reader.append(el('div', { class: 'learn-quiz-foot' },
          el('button', { class: 'btn ghost', onclick: async () => { S.quiz = null; await paintMain(); } }, 'Back to assessments'),
          el('span', { class: 'grow' }),
          el('button', { class: 'btn', onclick: () => genFeedback() }, icon('research'), 'What should I do about it?')));
      }
    }

    const pickedIn = (r, ci) => r.kind === 'multi'
      ? (safeArr(r.given)).map(String).includes(String(ci))
      : String(safeVal(r.given)) === String(ci);
    const rightIn = (r, ci) => r.kind === 'multi'
      ? (safeArr(r.answer)).map(String).includes(String(ci))
      : String(r.answer) === String(ci);
    const safeArr = (v) => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } };
    const safeVal = (v) => { try { return JSON.parse(v); } catch { return v; } };

    function paintProgress() {
      if (!ui.quizProgress || !S.quiz) return;
      const qs = S.quiz.assessment.questions;
      const done = qs.filter(q => {
        const a = S.quiz.answers[q.id];
        return q.kind === 'multi' ? (a || []).length : (a !== undefined && String(a).trim() !== '');
      }).length;
      ui.quizProgress.textContent = `${done}/${qs.length} answered`;
      if (ui.submit) ui.submit.disabled = done === 0;
    }

    async function submitQuiz() {
      const { assessment: a, attemptId, answers } = S.quiz;
      const qs = a.questions;
      const unanswered = qs.length - qs.filter(q => {
        const v = answers[q.id];
        return q.kind === 'multi' ? (v || []).length : (v !== undefined && String(v).trim() !== '');
      }).length;
      if (unanswered && !await confirmBox(`Submit with ${unanswered} unanswered?`, 'Blank answers score zero — and they still count against the topics they test.', 'Submit anyway')) return;

      const hasOpen = qs.some(q => q.kind === 'open');
      if (hasOpen && !ui.model.getValue()) { toast('written answers need a model — pick one', 'err'); return; }
      ui.submit.disabled = true;
      ui.submit.innerHTML = '';
      ui.submit.append(el('span', { class: 'spinner' }), ' grading…');
      try {
        await post(`/learn/${S.id}/assessment/${a.id}/submit`, { attemptId, answers, modelRef: ui.model.getValue() });
        S.quiz.grading = true;
        setRunning(true);
        S.unsub?.();
        S.unsub = sub('learn:' + S.id, onEvent);
      } catch (e) {
        toast(e.message, 'err');
        ui.submit.disabled = false; ui.submit.textContent = 'Submit for grading';
      }
    }

    // ---- paths & certificates view ----

    function paintPaths() {
      const s = S.subject;
      const a = s.advice;
      if (!a) {
        ui.reader.append(el('div', { class: 'res-hero' },
          el('h1', {}, 'Where could this take you?'),
          el('div', { class: 'sub' }, 'The advisor researches what\'s actually valued right now — real certifications (issuer, cost, prep time) and career paths that fit your goal and measured progress. Anything it suggests can be adopted as a sub-subject: it gets its own roadmap, lessons and exams aimed at that target.'),
          el('button', { class: 'btn primary', style: { marginTop: '14px' }, onclick: () => genAdvice() }, icon('briefcase'), 'Suggest paths & certs')));
        return;
      }
      ui.reader.append(el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
        el('div', { class: 'learn-lbl grow' }, `SUGGESTED ${timeAgo(a.generatedAt).toUpperCase()}`),
        el('button', { class: 'btn sm ghost', onclick: () => genAdvice() }, icon('refresh'), 'Refresh suggestions')));

      if (a.certs?.length) {
        ui.reader.append(el('div', { class: 'learn-lbl', style: { marginTop: '6px' } }, 'CERTIFICATIONS'));
        for (const c of a.certs) {
          ui.reader.append(el('div', { class: 'learn-cert' },
            el('div', { class: 'row', style: { gap: '9px', alignItems: 'flex-start' } },
              el('div', { class: 'grow' },
                el('div', { class: 'learn-cert-name' }, c.name),
                el('div', { class: 'muted small' }, c.org),
                el('div', { class: 'row small', style: { gap: '6px', margin: '6px 0', flexWrap: 'wrap' } },
                  el('span', { class: 'learn-tag sm diff-' + (c.difficulty === 'advanced' ? 'stretch' : c.difficulty) }, c.difficulty),
                  c.cost ? el('span', { class: 'learn-tag sm' }, c.cost) : null,
                  el('span', { class: 'learn-tag sm' }, `~${c.prepWeeks} wk prep`)),
                el('div', { class: 'small', style: { lineHeight: '1.5' } }, c.why)),
              el('div', { class: 'col', style: { gap: '5px', flex: 'none' } },
                el('button', {
                  class: 'btn sm primary', title: 'Create a sub-subject aimed at this cert — roadmap, lessons and exams included',
                  onclick: () => adoptTarget(`${c.name}`, `Pass the ${c.name} (${c.org}) certification. ${c.why}`),
                }, icon('plus'), 'Adopt'),
                c.url ? el('a', { class: 'btn sm ghost', href: c.url, target: '_blank', rel: 'noreferrer' }, 'Official ↗') : null))));
        }
      }
      if (a.paths?.length) {
        ui.reader.append(el('div', { class: 'learn-lbl', style: { marginTop: '10px' } }, 'PATHS'));
        for (const p of a.paths) {
          ui.reader.append(el('div', { class: 'learn-path' },
            el('div', { class: 'row', style: { gap: '9px', alignItems: 'flex-start' } },
              el('div', { class: 'grow' },
                el('div', { class: 'learn-cert-name' }, p.title),
                p.horizon ? el('div', { class: 'muted small' }, p.horizon) : null,
                el('div', { class: 'small', style: { lineHeight: '1.5', margin: '5px 0' } }, p.why),
                p.steps?.length ? el('ol', { class: 'learn-path-steps' }, ...p.steps.map(st => el('li', {}, st))) : null),
              el('button', {
                class: 'btn sm primary', style: { flex: 'none' }, title: 'Create a sub-subject for this path',
                onclick: () => adoptTarget(p.title, `${p.why} Milestones: ${p.steps.join('; ')}`),
              }, icon('plus'), 'Adopt'))));
        }
      }
    }

    /** Turn a suggestion into a live course: child subject + roadmap generation. */
    async function adoptTarget(name, goal) {
      if (S.running || !needModel()) return;
      try {
        const child = await post('/learn', {
          name: name.slice(0, 80), goal: goal.slice(0, 500),
          level: S.subject?.level || 'intermediate', parentId: S.id,
        });
        toast(`"${child.name}" created — designing its roadmap`, 'ok');
        await load(child.id);
        genRoadmap();   // one click → a course aimed at the target
      } catch (e) { toast(e.message, 'err'); }
    }

    async function genAdvice() {
      if (!S.id || S.running || !needModel()) return;
      S.view = 'paths';
      try {
        await post(`/learn/${S.id}/advise`, { modelRef: ui.model.getValue() });
        startStream('Scouting certificates and paths');
      } catch (e) { toast(e.message, 'err'); }
    }

    // ---- report view ----

    function paintReport() {
      const s = S.subject;
      if (S.report) {
        ui.reader.append(el('div', { class: 'row', style: { gap: '8px' } },
          el('div', { class: 'learn-lbl grow' }, 'PROGRESS REPORT'),
          el('button', { class: 'btn sm ghost', onclick: () => genFeedback() }, icon('refresh'), 'Regenerate')));
        ui.reader.append(el('div', { class: 'ev-text res-report learn-report' }, renderMd(S.report)));
        return;
      }
      ui.reader.append(el('div', { class: 'res-hero' },
        el('h1', {}, 'How am I actually doing?'),
        el('div', { class: 'sub' }, 'The tutor reads your whole record — every lesson, every graded answer, every missed question — and tells you straight: what is solid, what is not, what is coming, and exactly how to prepare. It is written to be honest, not kind.'),
        el('div', { class: 'muted small', style: { marginTop: '10px' } },
          `${s.lessons.length} lessons · ${s.assessments.length} assessments · ${s.mastery.pct === null ? 'no graded answers yet' : `${s.mastery.correct}/${s.mastery.seen} answers correct`}`),
        el('button', { class: 'btn primary', style: { marginTop: '14px' }, onclick: () => genFeedback() }, icon('research'), 'Give it to me straight')));
    }

    // ---------- generation ----------

    const needModel = () => { if (!ui.model.getValue()) { toast('pick a model first', 'err'); return false; } return true; };

    async function genRoadmap() {
      if (!S.id || S.running || !needModel()) return;
      try { await post(`/learn/${S.id}/roadmap`, { modelRef: ui.model.getValue() }); startStream('Designing roadmap'); }
      catch (e) { toast(e.message, 'err'); }
    }

    async function genLesson(moduleId = null, focus = null, review = false) {
      if (!S.id || S.running || !needModel()) return;
      if (!S.subject?.roadmap?.modules?.length) { genRoadmap(); return; }
      S.view = 'lessons';
      try {
        await post(`/learn/${S.id}/lesson`, { modelRef: ui.model.getValue(), moduleId: moduleId || undefined, focus: focus || undefined, review });
        startStream(review ? 'Building a review lesson' : 'Preparing the lesson');
      } catch (e) { toast(e.message, 'err'); }
    }

    async function genAssessment(kind, { moduleId, lessonId } = {}) {
      if (!S.id || S.running || !needModel()) return;
      S.view = 'assess'; S.quiz = null;
      try {
        await post(`/learn/${S.id}/assessment`, { kind, moduleId, lessonId, modelRef: ui.model.getValue() });
        startStream(`Writing the ${(KIND_META[kind]?.label || kind).toLowerCase()}`);
      } catch (e) { toast(e.message, 'err'); }
    }

    async function genFeedback() {
      if (!S.id || S.running || !needModel()) return;
      S.view = 'report'; S.report = null;
      try { await post(`/learn/${S.id}/feedback`, { modelRef: ui.model.getValue() }); startStream('Reading your record'); }
      catch (e) { toast(e.message, 'err'); }
    }

    function startStream(label) {
      setRunning(true);
      S.buf = ''; S.reasonEl = null; S.liveEl = null;
      paintMain().then(() => {
        ui.log = el('div', { class: 'res-log' });
        S.think = thinkingPanel({ label, doneLabel: 'Tutor process', body: ui.log, collapsed: false });
        ui.reader.innerHTML = '';
        ui.reader.append(S.think.node);
      });
      S.unsub?.();
      S.unsub = sub('learn:' + S.id, onEvent);
    }

    function logLine(kind, text, href) {
      S.reasonEl = null;
      const line = el('div', { class: 'res-line ' + kind },
        icon(kind === 'source' ? 'file' : kind === 'search' ? 'search' : kind === 'error' ? 'x' : kind === 'plan' ? 'learn' : 'chevR'),
        href ? el('a', { href, target: '_blank', rel: 'noreferrer' }, text) : el('span', {}, text));
      ui.log?.append(line);
      if (ui.log && S.think?.node.classList.contains('open')) ui.log.scrollTop = ui.log.scrollHeight;
      return line;
    }

    function reasonStream(delta) {
      if (!ui.log) return;
      if (!S.reasonEl) {
        S.reasonEl = el('div', { class: 'res-line reason' }, icon('sparkle'), el('span', { class: 'reason-text' }));
        S.reasonEl._buf = '';
        ui.log.append(S.reasonEl);
      }
      S.reasonEl._buf += delta;
      S.reasonEl.querySelector('.reason-text').textContent = S.reasonEl._buf;
      if (S.think?.node.classList.contains('open')) ui.log.scrollTop = ui.log.scrollHeight;
    }

    const rerenderLive = throttle(() => {
      if (!S.buf || !ui.reader) return;
      if (!S.liveEl) { S.liveEl = el('div', { class: 'ev-text res-report' }); ui.reader.append(S.liveEl); }
      S.liveEl.innerHTML = '';
      S.liveEl.append(renderMd(S.buf + ' ▍'));
      ui.main.scrollTop = ui.main.scrollHeight;
    }, 90);

    function onEvent({ ev }) {
      switch (ev.type) {
        case 'status':
          ui.statusLine?.remove();
          ui.statusLine = logLine('info', `${ev.phase}${ev.detail ? ` — ${String(ev.detail).slice(0, 90)}` : ''}…`);
          break;
        case 'plan': logLine('plan', `lesson: "${ev.title}" (${ev.lessonType}) · queries: ${ev.queries.join(' · ')}`); break;
        // 'note' = something the run decided on its own (budget spent, offline mode,
        // saved-with-problems). Surfaced so a degraded run never looks like a clean one.
        case 'note': logLine('info', ev.text); break;
        case 'search': logLine('search', `"${ev.query}" → ${ev.found} results${ev.error ? ` (${ev.error})` : ''}`); break;
        case 'source': logLine('source', `[${ev.n}] ${ev.title}`, ev.url); break;
        case 'roadmap': logLine('plan', `roadmap: ${ev.count} modules`); break;
        case 'reason.delta': reasonStream(ev.delta); break;
        case 'lesson.delta': S.reasonEl = null; S.buf += ev.delta; rerenderLive(); break;
        case 'done':
          ui.statusLine?.remove();
          S.think?.done();
          setRunning(false);
          if (ev.cancelled) { logLine('info', 'cancelled'); load(S.id, { keepLesson: true }); break; }
          onDone(ev);
          break;
        case 'error':
          ui.statusLine?.remove();
          logLine('error', ev.message);
          S.think?.done();
          toast(ev.message, 'err');
          setRunning(false);
          if (S.quiz?.grading) { S.quiz.grading = false; paintMain(); }
          break;
      }
    }

    async function onDone(ev) {
      switch (ev.kind) {
        case 'lesson': {
          S.lessonSel = ev.lessonId || null; S.lessonBody = null;
          const bad = (ev.health || []).filter(i => i.level === 'error').length;
          toast(bad
            ? `${ev.replaced ? 'rewrite' : 'lesson'} saved, but it looks damaged — see the banner`
            : ev.replaced ? 'lesson rewritten' : 'lesson ready', bad ? 'err' : 'ok');
          await load(S.id, { keepLesson: true });
          break;
        }
        case 'assessment':
          toast(`${ev.count} questions ready`, 'ok');
          S.view = 'assess';
          await load(S.id);
          break;
        case 'graded': {
          const passed = ev.passed;
          toast(passed ? `passed — ${ev.score}/${ev.maxScore}` : `${ev.score}/${ev.maxScore} — not yet`, passed ? 'ok' : 'err');
          // reload so mastery/weak-spots/roadmap reflect the new evidence
          await load(S.id, { keepView: true });
          try {
            const t = await get(`/learn/${S.id}/attempt/${ev.attemptId}`);
            S.quiz = { assessment: S.quiz?.assessment || await get(`/learn/${S.id}/assessment/${t.assessmentId}`), attemptId: ev.attemptId, answers: {}, result: t };
            S.view = 'assess';
            await paintMain();
          } catch (e) { toast(e.message, 'err'); }
          break;
        }
        case 'feedback':
          S.report = ev.feedback || '';
          S.view = 'report';
          toast('report ready', 'ok');
          await load(S.id, { keepView: true });
          break;
        case 'advice':
          S.view = 'paths';
          toast(`${(ev.advice?.certs?.length || 0)} certs · ${(ev.advice?.paths?.length || 0)} paths suggested`, 'ok');
          await load(S.id, { keepView: true });
          break;
        default:
          toast('roadmap ready', 'ok');
          await load(S.id);
      }
    }

    function setRunning(v) {
      S.running = v;
      ui.stop.style.display = v ? '' : 'none';
      ui.next.disabled = v;
      ui.assessBtn.disabled = v;
      ui.feedback.disabled = v;
    }

    // ---------- boot ----------

    (async () => {
      const subjects = await refreshList();
      const want = opts?.id && subjects.find(s => s.id === opts.id) ? opts.id : subjects[0]?.id;
      if (want) load(want);
    })();
    this.reopen = (w, o) => { if (o?.id) load(o.id); };
  },

  unmount(win) { win.learnState?.unsub?.(); },
};
