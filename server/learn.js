// Learning Corner: a long-term course engine for ONE student.
//
// Shape (unchanged from v1): the server orchestrates, the model gets one focused job
// per call so every provider works, and progress streams over WS topic learn:<id>.
//
// What v2 adds:
//   * Subjects are a TREE (Programming → Python → Dijkstra's). Roadmaps/lessons hang
//     off any node, so a leaf can be a full course in its own right.
//   * Assessments: diagnostic (placement), quiz (one lesson/module), midterm (the last
//     few modules), final (everything). MCQ + multi-select are auto-scored; open-ended
//     answers are graded by the model against a rubric — the reason an LLM tutor can
//     ask questions a Scantron can't.
//   * Mastery per topic (learndb.recordMastery). Every graded answer moves it, and it
//     drives what gets taught/asked next: weak topics are re-asked and re-taught.
//   * Feedback: a brutally honest report — what landed, what didn't, what's next.
//
// Storage is SQLite (see learndb.js). Lesson CONTENT is deliberately not included in
// the subject payload — it's fetched per lesson, so a 40-lesson subject still loads fast.

import path from 'node:path';
import { loadConfig, contextBudget } from './config.js';
import { streamChat } from './llm.js';
import { webSearch, fetchReadable } from './tools.js';
import { getSkill } from './skills.js';
import { id as genId, now, truncate } from './util.js';
import {
  getDb, all, one, run, tx, parseJSON,
  recordMastery, weakTopics, masteryStats,
} from './learndb.js';

const live = new Map(); // subjectId -> AbortController

/** Is a generation job running for this subject? The lock is what makes every generator
 *  answer "already generating — wait or cancel"; without a way to ask, a caller can only
 *  discover the state by being refused. */
export const isGenerating = (subjectId) => live.has(String(subjectId || ''));
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

let publish = () => { };
export const setPublisher = (fn) => { publish = fn; };
const emit = (id, ev) => publish(`learn:${id}`, { t: 'learn.event', id, ev });

const touch = (id) => run('UPDATE subjects SET updated_at = ? WHERE id = ?', now(), id);

// ---------- subjects (tree) ----------

const rowToModule = (m) => ({
  id: m.id, idx: m.idx, title: m.title, summary: m.summary,
  topics: parseJSON(m.topics, []), kind: m.kind, done: !!m.done,
});

const rowToLessonMeta = (l) => ({
  id: l.id, n: l.n, moduleId: l.module_id, topic: l.topic, title: l.title, type: l.type,
  done: !!l.done, createdAt: l.created_at, exportedTo: l.exported_to,
  sources: parseJSON(l.sources, []), next: parseJSON(l.next, []),
  health: parseJSON(l.health, []), revisedAt: l.revised_at || '',
});

// ---------- lesson health ----------
//
// Generation can go wrong in ways that still "succeed": the model gets cut off
// mid-code-fence, the research phase burns its budget and the lesson comes back
// ungrounded, or a provider hiccup returns three paragraphs where a lesson belongs.
// None of that throws — it just quietly produces a bad lesson. So we inspect the
// artifact and record what's wrong, which is what makes "Fix this lesson" possible:
// the issues become the regenerate instructions.

// Two severities, because they mean different things to the reader:
//   error — the artifact is damaged (truncated, narrated, empty). Regenerate it.
//   warn  — it's a real lesson that misses some of the house style. Usually fine.
// Section matching is deliberately loose: models legitimately write "## Exercises" for
// Practice and "## Why this lesson" for Objectives. Demanding exact headings flagged
// every real lesson, which makes the badge noise and trains you to ignore it.
const E = (text) => ({ level: 'error', text });
const W = (text) => ({ level: 'warn', text });

const HAS_OBJECTIVES = /^#{2,3}\s*.*(objectiv|you will|what you|why this|goal|prerequisit)/im;
const HAS_PRACTICE = /^#{2,3}\s*.*(practice|exercise|try it|your turn|drill|challenge|project)/im;
// The signature of a model narrating tool use instead of producing the artifact.
const NARRATION = /^\s*(?:i['’]ll|i will|let me|i'm going to|i am going to|first,?\s*(?:i['’]ll|let me)|i need to)\s+(?:search|look|check|find|research|browse|start by)/i;

export function lessonHealth(content, sources = []) {
  const issues = [];
  const c = String(content || '').trim();
  if (!c.length) return [E('the lesson is empty — generation produced nothing')];
  if (c.length < 400) return [E('the body is nearly empty — generation failed')];

  // The failure that started all this: the model announces a search and never writes
  // the lesson. It "succeeds" (plenty of characters) but there is no lesson in there.
  if (NARRATION.test(c)) issues.push(E('the model narrated searching instead of writing the lesson — generation derailed'));
  else if (!/^#\s+/m.test(c.split('\n').slice(0, 4).join('\n'))) issues.push(E('does not open with a "# Lesson N: …" title — the output is not a lesson'));

  if ((c.match(/```/g) || []).length % 2) issues.push(E('unclosed code fence — cut off mid-example'));
  const open = (c.match(/<details>/gi) || []).length, close = (c.match(/<\/details>/gi) || []).length;
  if (open !== close) issues.push(E('unbalanced <details> block — solutions are truncated'));

  // Truncation check. Punctuation alone is not the signal: markdown legitimately ends on
  // a bullet ("- Review: scoping drills"), a table row, or a fence. Only a PROSE line
  // that stops without terminal punctuation looks cut off — which is what a token limit
  // actually produces. Getting this wrong flags every healthy lesson, so it stays narrow.
  const lines = c.split('\n').map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const isList = /^([-*+]|\d+[.)])\s/.test(last);
  const isHeading = /^#{1,6}\s/.test(last);
  const isTable = last.startsWith('|');
  const isFence = last.startsWith('```') || last.startsWith('</');
  const endsClean = /[.!?:;`)\]}>*_"'—]$/.test(last);
  if (isHeading) issues.push(E('ends on a heading with nothing under it — cut off'));
  else if (!isList && !isTable && !isFence && !endsClean) issues.push(E('ends mid-sentence — cut off by a token limit'));

  if (c.length < 1500) issues.push(W('unusually short for a full lesson'));
  if (!HAS_OBJECTIVES.test(c)) issues.push(W('no objectives/why-this-lesson section'));
  if (!HAS_PRACTICE.test(c)) issues.push(W('no practice or exercises — reading without doing'));
  if (!/^#{2,3}\s*.*next lesson/im.test(c)) issues.push(W('no "Next lesson ideas" section'));
  if (!sources?.length) issues.push(W('no sources cited — the lesson is ungrounded'));
  return issues;
}

/** Worst severity present, or '' when clean. */
export const healthLevel = (issues = []) =>
  issues.some(i => i.level === 'error') ? 'error' : issues.length ? 'warn' : '';

const rowToAssessment = (a) => ({
  id: a.id, kind: a.kind, title: a.title, blurb: a.blurb, moduleId: a.module_id,
  lessonId: a.lesson_id, scope: parseJSON(a.scope, []), passPct: a.pass_pct,
  createdAt: a.created_at,
  questions: a.questions ?? undefined,
  best: a.best ?? undefined,
  attempts: a.attempts ?? undefined,
});

/** Flat list with counts — the sidebar builds the tree from parentId. */
export function listSubjects() {
  getDb();
  const rows = all(`
    SELECT s.*,
      (SELECT COUNT(*) FROM modules m WHERE m.subject_id = s.id) AS modules,
      (SELECT COUNT(*) FROM modules m WHERE m.subject_id = s.id AND m.done = 1) AS modules_done,
      (SELECT COUNT(*) FROM lessons l WHERE l.subject_id = s.id) AS lessons,
      (SELECT COUNT(*) FROM assessments a WHERE a.subject_id = s.id) AS assessments
    FROM subjects s
    ORDER BY s.position ASC, s.created_at ASC`);

  if (!rows.length) {
    // First open: the standing subject the Corner starts with.
    const seed = createSubject({
      name: 'Programming',
      goal: 'Become a well-rounded software developer: design, build, debug, test, and ship real projects — comfortable across languages rather than tied to one.',
      level: 'intermediate',
    });
    return [{
      id: seed.id, parentId: null, name: seed.name, level: seed.level, goal: seed.goal,
      updatedAt: seed.updatedAt, modules: 0, modulesDone: 0, lessons: 0, assessments: 0, mastery: null,
    }];
  }
  return rows.map(s => ({
    id: s.id, parentId: s.parent_id, name: s.name, goal: s.goal, level: s.level,
    updatedAt: s.updated_at, modules: s.modules, modulesDone: s.modules_done,
    lessons: s.lessons, assessments: s.assessments,
    mastery: masteryStats(s.id).pct,
  }));
}

export function createSubject({ name, goal = '', level = 'beginner', parentId = null } = {}) {
  getDb();
  name = String(name || '').trim();
  if (!name) throw err('subject name is required');
  if (parentId) {
    if (!one('SELECT id FROM subjects WHERE id = ?', parentId)) throw err('parent subject not found', 404);
    if (depthOf(parentId) >= 4) throw err('subjects can nest 5 levels deep at most');
  }
  const pos = (one('SELECT COALESCE(MAX(position), -1) AS p FROM subjects WHERE parent_id IS ?', parentId)?.p ?? -1) + 1;
  const s = {
    id: genId(8), parentId, name: name.slice(0, 80), goal: String(goal || '').slice(0, 500),
    level: ['beginner', 'intermediate', 'advanced'].includes(level) ? level : 'beginner',
    createdAt: now(), updatedAt: now(),
  };
  run(`INSERT INTO subjects (id, parent_id, name, goal, level, position, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`,
    s.id, s.parentId, s.name, s.goal, s.level, pos, s.createdAt, s.updatedAt);
  return s;
}

function depthOf(id) {
  let d = 0, cur = one('SELECT parent_id FROM subjects WHERE id = ?', id);
  while (cur?.parent_id && d < 12) { d++; cur = one('SELECT parent_id FROM subjects WHERE id = ?', cur.parent_id); }
  return d;
}

/** Breadcrumb from root → this subject. */
function pathOf(id) {
  const out = [];
  let cur = one('SELECT id, name, parent_id FROM subjects WHERE id = ?', id);
  while (cur && out.length < 12) {
    out.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? one('SELECT id, name, parent_id FROM subjects WHERE id = ?', cur.parent_id) : null;
  }
  return out;
}

export function getSubject(id) {
  getDb();
  const s = one('SELECT * FROM subjects WHERE id = ?', id);
  if (!s) throw err('subject not found', 404);
  const modules = all('SELECT * FROM modules WHERE subject_id = ? ORDER BY idx ASC', id).map(rowToModule);
  const lessons = all('SELECT * FROM lessons WHERE subject_id = ? ORDER BY n ASC', id).map(rowToLessonMeta);
  const assessments = all('SELECT * FROM assessments WHERE subject_id = ? ORDER BY created_at ASC', id).map(a => {
    const best = one(
      `SELECT score, max_score, passed, submitted_at FROM attempts
        WHERE assessment_id = ? AND submitted_at IS NOT NULL
        ORDER BY score DESC LIMIT 1`, a.id);
    const n = one('SELECT COUNT(*) AS c FROM attempts WHERE assessment_id = ? AND submitted_at IS NOT NULL', a.id)?.c || 0;
    return rowToAssessment({
      ...a,
      questions: one('SELECT COUNT(*) AS c FROM questions WHERE assessment_id = ?', a.id)?.c || 0,
      attempts: n,
      best: best ? { score: best.score, maxScore: best.max_score, passed: !!best.passed, at: best.submitted_at } : null,
    });
  });
  return {
    id: s.id, parentId: s.parent_id, name: s.name, goal: s.goal, level: s.level,
    createdAt: s.created_at, updatedAt: s.updated_at, error: s.error,
    running: live.has(id),
    path: pathOf(id),
    children: all('SELECT id, name, level FROM subjects WHERE parent_id = ? ORDER BY position ASC', id),
    roadmap: modules.length ? { modules } : null,
    lessons, assessments,
    mastery: masteryStats(id),
    weak: weakTopics(id, 6),
    nextUp: suggestNext(id, modules, lessons),
    advice: parseJSON(s.advice, null),
  };
}

/** Full lesson incl. content — separate so the subject payload stays small. */
export function getLesson(subjectId, lessonId) {
  const l = one('SELECT * FROM lessons WHERE id = ? AND subject_id = ?', lessonId, subjectId);
  if (!l) throw err('lesson not found', 404);
  return { ...rowToLessonMeta(l), content: l.content, model: l.model };
}

export function updateSubject(id, { name, goal, level, parentId } = {}) {
  const s = one('SELECT * FROM subjects WHERE id = ?', id);
  if (!s) throw err('subject not found', 404);
  if (name !== undefined && String(name).trim()) run('UPDATE subjects SET name = ? WHERE id = ?', String(name).trim().slice(0, 80), id);
  if (goal !== undefined) run('UPDATE subjects SET goal = ? WHERE id = ?', String(goal).slice(0, 500), id);
  if (level !== undefined && ['beginner', 'intermediate', 'advanced'].includes(level)) run('UPDATE subjects SET level = ? WHERE id = ?', level, id);
  if (parentId !== undefined) {
    const p = parentId || null;
    if (p === id) throw err('a subject cannot be its own parent');
    if (p && isDescendant(p, id)) throw err('cannot move a subject inside its own child');
    if (p && !one('SELECT id FROM subjects WHERE id = ?', p)) throw err('parent subject not found', 404);
    run('UPDATE subjects SET parent_id = ? WHERE id = ?', p, id);
  }
  touch(id);
  return getSubject(id);
}

const isDescendant = (maybeChild, ancestor) => pathOf(maybeChild).some(p => p.id === ancestor);

/** Deleting a subject cascades to everything under it — lessons, questions, attempts,
 *  mastery, sub-subjects. That's months of study history in one keypress, so a subject
 *  with real content demands its exact name as confirmation. An empty shell doesn't. */
export function deleteSubject(id, { confirm } = {}) {
  cancel(id);
  getDb();
  const s = one('SELECT name FROM subjects WHERE id = ?', id);
  if (!s) return;
  const contents = one(
    `SELECT (SELECT COUNT(*) FROM lessons  WHERE subject_id = ?)
          + (SELECT COUNT(*) FROM attempts WHERE subject_id = ?)
          + (SELECT COUNT(*) FROM subjects WHERE parent_id  = ?) AS c`, id, id, id)?.c || 0;
  if (contents > 0 && String(confirm || '') !== s.name) {
    throw err(`"${s.name}" has lessons, graded attempts or sub-subjects — deleting is permanent (a daily backup exists, but still). Pass the subject's exact name as confirmation.`, 409);
  }
  run('DELETE FROM subjects WHERE id = ?', id); // FK cascade clears the rest
}

export function cancel(id) {
  live.get(id)?.abort();
  live.delete(id);
  return true;
}

export function setModuleDone(id, moduleId, done) {
  const m = one('SELECT id FROM modules WHERE id = ? AND subject_id = ?', moduleId, id);
  if (!m) throw err('module not found', 404);
  run('UPDATE modules SET done = ? WHERE id = ?', done ? 1 : 0, moduleId);
  touch(id);
  return { ok: true, done: !!done };
}

export function setLessonDone(id, lessonId, done) {
  const l = one('SELECT id FROM lessons WHERE id = ? AND subject_id = ?', lessonId, id);
  if (!l) throw err('lesson not found', 404);
  run('UPDATE lessons SET done = ? WHERE id = ?', done ? 1 : 0, lessonId);
  touch(id);
  return { ok: true, done: !!done };
}

/** What the Corner thinks you should do next — drives the "Up next" card.
 *  Exam beats lesson: finishing 3-4 modules without testing them is how knowledge
 *  quietly rots, so the checkpoint is scheduled the moment it comes due. */
function suggestNext(subjectId, modules, lessons) {
  if (!modules.length) return { kind: 'roadmap', why: 'No roadmap yet — design one first.' };
  const doneMods = modules.filter(m => m.done);
  const exams = all(
    `SELECT a.*, (SELECT COUNT(*) FROM attempts t WHERE t.assessment_id = a.id AND t.passed = 1) AS passes
       FROM assessments a WHERE a.subject_id = ? AND a.kind IN ('midterm','final')`, subjectId);
  const examinedIds = new Set(exams.flatMap(e => parseJSON(e.scope, [])));

  // A checkpoint comes due every 3-4 completed modules that no exam has covered yet.
  const untested = doneMods.filter(m => !examinedIds.has(m.id));
  if (untested.length >= 3) {
    const isFinal = doneMods.length === modules.length;
    return {
      kind: isFinal ? 'final' : 'midterm',
      why: isFinal
        ? 'Every module is complete — sit the final to prove the whole subject.'
        : `${untested.length} finished modules have never been examined — time for a midterm.`,
      moduleIds: untested.map(m => m.id),
    };
  }
  const weak = weakTopics(subjectId, 3).filter(w => w.ratio < 0.7);
  if (weak.length && lessons.length) {
    return { kind: 'review', why: `Weak on ${weak.map(w => w.topic).join(', ')} — a review lesson targets those.`, topics: weak.map(w => w.topic) };
  }
  const nextMod = modules.find(m => !m.done);
  if (nextMod) {
    const covered = new Set(lessons.filter(l => l.moduleId === nextMod.id).map(l => (l.topic || '').toLowerCase()));
    const topic = nextMod.topics.find(t => !covered.has(t.toLowerCase()));
    if (!topic) return { kind: 'quiz', why: `Every topic in "${nextMod.title}" is taught — quiz it, then mark the module done.`, moduleId: nextMod.id };
    return { kind: 'lesson', why: `Next up in "${nextMod.title}": ${topic}`, moduleId: nextMod.id, topic };
  }
  return { kind: 'done', why: 'Roadmap complete. Add a sub-subject to go deeper, or regenerate for the next tier.' };
}

// ---------- shared LLM plumbing ----------

const tutorRules = (cap = 3800) => {
  const t = getSkill('tutor') || '';
  return t ? truncate(t, cap) : '';
};

function makeLlm(subjectId, ctl, modelRef, usage) {
  const today = new Date().toDateString();
  return async (prompt, { stream = false, maxTokens = 2048, onReason, system, schema } = {}) => {
    const res = await streamChat({
      modelRef, maxTokens, signal: ctl.signal, schema,
      system: system || `You are a rigorous, warm personal tutor. Today is ${today}. Follow the output format EXACTLY — no preamble, no commentary.`,
      messages: [{ role: 'user', text: prompt }],
      onEvent: (ev) => {
        if (stream && ev.type === 'text') emit(subjectId, { type: 'lesson.delta', delta: ev.delta });
        else if (ev.type === 'reasoning' && onReason) onReason(ev.delta);
      },
    });
    usage.input += res.usage.input; usage.output += res.usage.output;
    return res.text || '';
  };
}

/**
 * The roadmap's shape, handed to the provider as a grammar rather than described in the
 * prompt and hoped for.
 *
 * Asking a 9B for "STRICT JSON only (no fences, no commentary)" and then fishing the
 * object back out of prose is the difference between the Learning app working on a local
 * model and not: measured on this box, the unconstrained prompt returned something
 * unparseable and the subject died with "the model did not return a usable roadmap".
 * llm.js has carried constrained decoding for a while — json_schema for OpenAI-compatible
 * servers, `format` for Ollama — and receipts.js has been relying on it to read paper
 * reliably. The tutor had simply never been wired to it.
 */
const ROADMAP_SCHEMA = {
  name: 'roadmap',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['modules'],
    properties: {
      modules: {
        type: 'array', minItems: 6, maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'summary', 'kind', 'topics'],
          properties: {
            title: { type: 'string', description: 'the capability milestone' },
            summary: { type: 'string', description: 'one sentence: what the student can DO after' },
            kind: { type: 'string', enum: ['standard', 'project', 'capstone'] },
            topics: { type: 'array', minItems: 3, maxItems: 6, items: { type: 'string' } },
          },
        },
      },
    },
  },
};

/** String-aware first-JSON-object extractor (same approach as util.extractJSON). */
function extractJSON(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) {
        const raw = t.slice(start, i + 1);
        try { return JSON.parse(raw); } catch { }
        try { return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
      }
    }
  }
  return null;
}

const resolveModel = (modelRef) => modelRef || loadConfig().defaults.chatModel || loadConfig().defaults.agentModel || '';

/** Guard + spawn one background job per subject. */
function begin(id, modelRef, kind, task) {
  const s = one('SELECT * FROM subjects WHERE id = ?', id);
  if (!s) throw err('subject not found', 404);
  modelRef = resolveModel(modelRef);
  if (!modelRef) throw err('no model selected');
  if (live.has(id)) throw err('this subject is already generating — wait or cancel', 409);
  const ctl = new AbortController();
  live.set(id, ctl);
  // defer so the client's subscribe lands before the first events (research.js pattern)
  setTimeout(() => task(s, ctl, modelRef).catch(() => { }), 250);
  return { id, status: kind };
}

function fail(id, ctl, e) {
  if (!ctl.signal.aborted) run('UPDATE subjects SET error = ? WHERE id = ?', e.message, id);
  emit(id, ctl.signal.aborted ? { type: 'done', cancelled: true } : { type: 'error', message: e.message });
}

// ---------- roadmap ----------

export function generateRoadmap({ id, modelRef }) {
  return begin(id, modelRef, 'roadmap', runRoadmap);
}

async function runRoadmap(s, ctl, modelRef) {
  const usage = { input: 0, output: 0 };
  const llm = makeLlm(s.id, ctl, modelRef, usage);
  const think = (delta) => emit(s.id, { type: 'reason.delta', delta });
  const phase = (p, detail = '') => emit(s.id, { type: 'status', phase: p, detail });
  try {
    phase('searching', 'current curricula and practice');
    const year = new Date().getFullYear();
    const snippets = [];
    for (const q of [`${s.name} learning roadmap ${year}`, `${s.name} ${s.level} curriculum what to learn`]) {
      if (ctl.signal.aborted) throw new Error('cancelled');
      try {
        const { results } = await webSearch(q, { n: 6, time_range: 'year' });
        emit(s.id, { type: 'search', query: q, found: results.length });
        for (const r of results.slice(0, 5)) snippets.push(`- ${r.title}: ${(r.snippet || '').slice(0, 180)}`);
      } catch (e) { emit(s.id, { type: 'search', query: q, found: 0, error: e.message }); }
    }

    // A child subject inherits its parents' context — "Python" under "Programming"
    // is a different course than "Python" standing alone.
    const crumbs = pathOf(s.id);
    const parentCtx = crumbs.length > 1
      ? `\nThis subject sits inside a larger course: ${crumbs.map(c => c.name).join(' → ')}. Scope the roadmap to "${s.name}" specifically — do not re-teach the parent subject.\n`
      : '';

    phase('planning', 'designing the roadmap');
    const out = await llm(
      `${tutorRules(2600)}

Design a learning roadmap.
Subject: ${s.name}
Student goal: ${s.goal || '(not stated)'}
Student level: ${s.level}${parentCtx}
${snippets.length ? `\nWhat current curricula/practitioners emphasize (web search, ${year}):\n${snippets.slice(0, 10).join('\n')}\n` : ''}
Follow the "Roadmap design" rules above: 6-12 capability modules in strict prerequisite order, a PROJECT module every 3-4 modules, a capstone last. Respect the student's level — do not re-teach what a ${s.level} already has.

Output STRICT JSON only (no fences, no commentary):
{"modules":[{"title":"<capability milestone>","summary":"<one sentence: what the student can DO after>","kind":"standard|project|capstone","topics":["<lesson-sized topic>","..."]}]}
Each module: 3-6 topics, each topic sized to one lesson.`,
      { maxTokens: 6000, onReason: think, schema: ROADMAP_SCHEMA });

    // extractJSON stays: the schema is a request, not a guarantee — a provider that
    // ignores response_format still lands here, and it costs nothing when it was obeyed.
    const j = extractJSON(out);
    const mods = Array.isArray(j?.modules) ? j.modules.filter(m => m && m.title) : [];
    if (mods.length < 3) {
      throw new Error('the model did not return a usable roadmap — try again (or a different model). '
        + `It replied with ${out.trim().length} characters${out.trim() ? `, starting "${out.trim().slice(0, 80).replace(/\s+/g, ' ')}…"` : ''}.`);
    }

    // Preserve done-ness across a regenerate, matched by title.
    const prevDone = new Map(all('SELECT title, done FROM modules WHERE subject_id = ?', s.id).map(m => [m.title.toLowerCase(), m.done]));
    tx(() => {
      run('DELETE FROM modules WHERE subject_id = ?', s.id);
      mods.slice(0, 14).forEach((m, i) => {
        const title = String(m.title).slice(0, 120);
        run(`INSERT INTO modules (id, subject_id, idx, title, summary, topics, kind, done, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          genId(6), s.id, i, title, String(m.summary || '').slice(0, 300),
          JSON.stringify((Array.isArray(m.topics) ? m.topics : []).map(t => String(t).slice(0, 120)).slice(0, 8)),
          ['standard', 'project', 'capstone'].includes(m.kind) ? m.kind : 'standard',
          prevDone.get(title.toLowerCase()) || 0, now());
      });
      run('UPDATE subjects SET error = ?, updated_at = ? WHERE id = ?', '', now(), s.id);
    });
    emit(s.id, { type: 'roadmap', count: mods.length, usage });
    emit(s.id, { type: 'done', kind: 'roadmap' });
  } catch (e) { fail(s.id, ctl, e); }
  finally { live.delete(s.id); }
}

// ---------- lessons ----------

export function generateLesson({ id, moduleId, focus, review = false, useWeb = true, modelRef }) {
  const mods = all('SELECT * FROM modules WHERE subject_id = ? ORDER BY idx', id);
  if (!mods.length) throw err('generate a roadmap first');
  const module = moduleId ? mods.find(m => m.id === moduleId) : (mods.find(m => !m.done) || mods[mods.length - 1]);
  if (!module) throw err('module not found', 404);
  return begin(id, modelRef, 'lesson', (s, ctl, mr) =>
    runLesson(s, ctl, {
      module: rowToModule(module), focus: String(focus || '').slice(0, 300),
      review: !!review, useWeb: useWeb !== false, modelRef: mr,
    }));
}

/** Rewrite an existing lesson IN PLACE — same slot (n), same module, same topic, same id,
 *  so links, vault exports and quizzes that point at it stay pointing at it. The old body
 *  is snapshotted to lesson_revisions first, so a worse rewrite is always undoable.
 *
 *  `instructions` is free text ("too shallow", "the code doesn't run"). When omitted, the
 *  detected health issues are used as the instructions — that's the "Fix it" button.
 *  `useWeb: false` skips research entirely: the escape hatch when search/fetch is what
 *  wedged the previous attempt. */
export function regenerateLesson({ id, lessonId, instructions = '', focus, useWeb = true, modelRef }) {
  const l = one('SELECT * FROM lessons WHERE id = ? AND subject_id = ?', lessonId, id);
  if (!l) throw err('lesson not found', 404);
  const mod = l.module_id ? one('SELECT * FROM modules WHERE id = ?', l.module_id) : null;
  if (!mod) throw err('this lesson\'s module is gone — regenerate the roadmap first', 409);

  let why = String(instructions || '').slice(0, 600).trim();
  if (!why) {
    // No instructions given → the detected problems ARE the instructions. This is what
    // the "Fix it" button sends: the checker's findings become the rewrite brief.
    const issues = parseJSON(l.health, []).map(i => (typeof i === 'string' ? i : i.text));
    why = issues.length
      ? `The previous attempt had these problems — fix every one: ${issues.join('; ')}.`
      : 'The previous attempt was unsatisfactory. Write a materially better lesson: deeper mechanism, sharper examples, no filler.';
  }
  return begin(id, modelRef, 'lesson', (s, ctl, mr) =>
    runLesson(s, ctl, {
      module: rowToModule(mod), focus: String(focus || l.topic || '').slice(0, 300),
      review: l.type === 'review', useWeb: useWeb !== false, modelRef: mr,
      replace: l, instructions: why,
    }));
}

// How long the search+read phase may run before we stop and write with what we have.
// Individual fetches already time out, but 3 queries x 6 results x 20s is ~6 minutes of
// churn before a single word gets written — which is what makes generation feel wedged.
const RESEARCH_BUDGET_MS = 75_000;

async function runLesson(s, ctl, { module, focus, review, modelRef, replace = null, instructions = '', useWeb = true }) {
  const usage = { input: 0, output: 0 };
  const llm = makeLlm(s.id, ctl, modelRef, usage);
  const think = (delta) => emit(s.id, { type: 'reason.delta', delta });
  const phase = (p, detail = '') => emit(s.id, { type: 'status', phase: p, detail });
  const note = (text) => emit(s.id, { type: 'note', text });
  const provider = modelRef.split(':')[0];
  const fast = provider === 'anthropic';
  const { inputChars } = contextBudget({ modelRef, wantOutput: 4096 });
  // Prompt budget. A local model on a small GPU pays twice for a fat prompt: minutes of
  // prompt processing, and a KV cache big enough to evict layers to CPU. Measured on this
  // box (ornith-9b, 8GB): an ~11k-token prompt generated at ~8 tok/s where a lean one runs
  // ~50 — a 6k-token lesson goes from ~2 minutes to ~12. Worse, a 9B model buried in 30KB
  // of scraped page noise is exactly what starts narrating "I'll search for…" instead of
  // writing the lesson. Cloud models don't have either problem, hence the split.
  // Three sources of readable prose beat a wall of HTML either way.
  const pageCap = Math.min(fast ? 22_000 : 5_000, Math.floor(inputChars * 0.35));
  const materialCap = Math.min(fast ? 40_000 : 12_000, Math.floor(inputChars * 0.5));
  try {
    const lessons = all('SELECT * FROM lessons WHERE subject_id = ? ORDER BY n', s.id).map(rowToLessonMeta);
    // A rewrite keeps its slot; a new lesson takes the next one.
    const n = replace ? replace.n : lessons.length + 1;
    const history = lessons.filter(l => !replace || l.id !== replace.id).slice(-6)
      .map(l => `- Lesson ${l.n}: ${l.title}${l.done ? ' ✓done' : ''}`).join('\n') || '(none yet — this is the first lesson)';
    const fixNote = replace
      ? `\nYOU ARE REWRITING lesson ${n} ("${replace.title}") from scratch. ${instructions}\nDo not apologise or mention the previous attempt — produce the lesson as it should have been.\n`
      : '';
    const covered = new Set(lessons.filter(l => l.moduleId === module.id).map(l => (l.topic || '').toLowerCase()));
    const nextTopic = module.topics.find(t => !covered.has(t.toLowerCase())) || module.topics[0] || module.title;

    // The adaptive hook: a review lesson is aimed at measured failures, not vibes.
    const weak = weakTopics(s.id, 5).filter(w => w.ratio < 0.75);
    const target = focus || (review && weak.length ? weak.map(w => w.topic).join(', ') : nextTopic);
    const weakNote = weak.length
      ? `\nMEASURED WEAK SPOTS (from graded answers — accuracy in parens): ${weak.map(w => `${w.topic} (${Math.round(w.ratio * 100)}%)`).join(', ')}.\nWeave the ones relevant to this lesson back in as worked examples or practice — do not just re-explain, re-USE them.\n`
      : '';

    phase('planning', target);
    const planOut = await llm(
      `You are planning lesson ${n} for the subject "${s.name}" (student level: ${s.level}).
Module: ${module.title} — ${module.summary}
Module topics: ${module.topics.join(' · ')}
Lessons so far:\n${history}${weakNote}
Target for this lesson: ${target}${review ? '\nThis is a REVIEW lesson: resurface the weak spots above as fresh exercises with new surface details.' : ''}

Step 1 — one line: LESSON TITLE: <specific, capability-flavored title>
Step 2 — one line: TYPE: standard|project|review|deep-dive  (project when the module's topics are all covered; review roughly every 5th lesson)
Step 3 — 2-3 web search queries to ground the lesson in CURRENT (this year) versions, idioms, and practice — one per line after a QUERIES: line.

Output exactly:
LESSON TITLE: ...
TYPE: ...
QUERIES:
<query>
<query>`,
      { maxTokens: 1500, onReason: think });
    const title = (planOut.match(/LESSON TITLE:\s*(.+)/i)?.[1] || target).trim().slice(0, 120);
    const type = review ? 'review' : (planOut.match(/TYPE:\s*(standard|project|review|deep-dive)/i)?.[1] || 'standard').toLowerCase();
    const qm = planOut.match(/QUERIES\s*:?/i);
    const queries = (qm ? planOut.slice(qm.index + qm[0].length) : '').split('\n')
      .map(l => l.trim().replace(/^(?:\d+[.)]|[-*•>]+)\s*/, '').replace(/^["'`]+|["'`]+$/g, ''))
      .filter(l => l.length > 3 && l.length < 120).slice(0, 3);
    if (!queries.length) queries.push(`${target} ${s.name} tutorial ${new Date().getFullYear()}`);
    emit(s.id, { type: 'plan', title, lessonType: type, queries });

    const sources = [];
    let material = '';
    const seen = new Set();
    const want = fast ? 4 : 3;
    // Hard wall-clock stop for the whole research phase. Without it a run of slow or
    // dead hosts can burn minutes before writing starts, which reads as a hung lesson.
    // Blowing the budget is not an error: we write with whatever we gathered and say so.
    const deadline = Date.now() + RESEARCH_BUDGET_MS;
    const outOfTime = () => Date.now() > deadline;

    if (!useWeb) {
      note('research skipped — writing from fundamentals (offline mode)');
    } else {
      for (const q of queries) {
        if (ctl.signal.aborted) throw new Error('cancelled');
        if (sources.length >= want) break;
        if (outOfTime()) { note(`research budget (${RESEARCH_BUDGET_MS / 1000}s) spent — writing with ${sources.length} source${sources.length === 1 ? '' : 's'}`); break; }
        phase('searching', q);
        let results = [];
        try { ({ results } = await webSearch(q, { n: 6, time_range: 'year' })); } catch (e) { emit(s.id, { type: 'search', query: q, found: 0, error: e.message }); continue; }
        emit(s.id, { type: 'search', query: q, found: results.length });
        for (const r of results) {
          if (sources.length >= want) break;
          if (ctl.signal.aborted) throw new Error('cancelled');
          if (outOfTime()) { note(`research budget spent while reading — writing with ${sources.length} source${sources.length === 1 ? '' : 's'}`); break; }
          const url = r.url || '';
          let dom = ''; try { dom = new URL(url).hostname; } catch { continue; }
          if (seen.has(dom) || !/^https?:/.test(url) || /\.(pdf|zip|png|jpg|mp4)($|\?)/i.test(url)) continue;
          seen.add(dom);
          phase('reading', url);
          let text = '';
          try { text = (await fetchReadable(url, 400_000)).text.slice(0, pageCap); } catch { }
          if (text.length < 300 && r.snippet) text = `${r.title}\n${r.snippet}`;
          if (text.trim().length < 80) continue;
          const num = sources.length + 1;
          sources.push({ n: num, url, title: r.title || dom });
          material += `\n\n[${num}] ${r.title} (${url})\n${text}`;
          emit(s.id, { type: 'source', n: num, url, title: r.title || dom });
        }
      }
      if (!sources.length) note('no sources were reachable — writing from fundamentals instead');
    }

    phase('writing', title);
    const lessonMd = await llm(
      `${tutorRules(3200)}

Write lesson ${n} in full.
Subject: ${s.name} · Student level: ${s.level} · Student goal: ${s.goal || '(not stated)'}
Module: ${module.title} — ${module.summary}
Lesson title: ${title}
Lesson type: ${type}
Lessons so far (connect to them in ## Review):\n${history}${weakNote}${fixNote}
${sources.length ? `\nCurrent source material (cite by number like [1]):${truncate(material, materialCap)}\n` : '\n(no web sources reachable — teach from fundamentals, flag anything version-dependent as "verify against current docs")\n'}
Follow the "Lesson structure" sections EXACTLY (# Lesson ${n}: ... through ## Next lesson ideas). Markdown only, no preamble. Code examples minimal-complete-runnable. Exercises produce artifacts; solutions and quiz answers inside <details> blocks.
Finish the lesson — never stop mid-example. If you are running out of room, shorten the middle sections rather than truncating the end.`,
      // 6000 was too tight for local models: they write long and got cut mid-sentence,
      // which the health checker then (correctly) flags as damaged. Now that the prompt
      // is lean there's context to spare, so give the body room to actually finish.
      { stream: true, maxTokens: 8000, onReason: think });

    // A near-empty body is the one failure we refuse to persist: it would occupy the slot
    // and teach nothing. Everything else is saved WITH its problems recorded, because a
    // flawed lesson you can regenerate beats a lost lesson you have to rebuild by hand.
    if (lessonMd.trim().length < 400) {
      throw new Error(replace
        ? 'the model returned a near-empty rewrite — the previous version is untouched, try again (or a different model)'
        : 'the model returned a near-empty lesson — try again (or a different model)');
    }
    const nextSec = (lessonMd.split(/^##\s*Next lesson ideas\s*$/im)[1] || '').split(/^#/m)[0];
    const next = nextSec.split('\n').map(l => l.trim().replace(/^[-*•]\s*/, '')).filter(l => l.length > 4).slice(0, 4);
    const body = lessonMd.trim();
    const health = lessonHealth(body, sources);
    const bad = health.filter(i => i.level === 'error');
    if (bad.length) note(`saved, but it looks damaged: ${bad.map(i => i.text).join('; ')} — hit Regenerate to fix it`);
    else if (health.length) note(`saved with minor gaps: ${health.map(i => i.text).join('; ')}`);

    const lessonId = replace ? replace.id : genId(6);
    tx(() => {
      if (replace) {
        // snapshot first — a rewrite must never be a one-way door
        run(`INSERT INTO lesson_revisions (id, lesson_id, title, content, sources, next, health, model, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          genId(6), replace.id, replace.title, replace.content, replace.sources, replace.next,
          replace.health || '[]', replace.model, truncate(instructions, 300), now());
        run(`UPDATE lessons SET title = ?, topic = ?, type = ?, content = ?, sources = ?, next = ?,
                                model = ?, health = ?, revised_at = ? WHERE id = ?`,
          title, target, type, body, JSON.stringify(sources), JSON.stringify(next),
          modelRef, JSON.stringify(health), now(), replace.id);
      } else {
        run(`INSERT INTO lessons (id, subject_id, module_id, n, title, topic, type, content, sources, next, done, model, exported_to, health, revised_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '', ?, '', ?)`,
          lessonId, s.id, module.id, n, title, target, type, body,
          JSON.stringify(sources), JSON.stringify(next), modelRef, JSON.stringify(health), now());
      }
      run('UPDATE subjects SET error = ?, updated_at = ? WHERE id = ?', '', now(), s.id);
    });

    // best-effort vault export — lessons live in their own Learning/ shelf. A rewrite
    // reuses the note it already wrote, so regenerating updates that file in place
    // instead of leaving a stale duplicate behind when the title shifts.
    const vcfg = loadConfig().vault;
    if (vcfg?.path && vcfg.autoExport !== false) {
      try {
        const { writeNote } = await import('./vault.js');
        const safe = (t) => String(t).replace(/[/\\:*?"<>|#^[\]]/g, '-').trim();
        const rel = (replace && replace.exported_to)
          ? replace.exported_to
          : path.posix.join('Learning', safe(s.name), `Lesson ${String(n).padStart(2, '0')} — ${safe(title)}.md`);
        writeNote(rel, `---\ntype: lesson\nsubject: ${s.name}\nmodule: "${module.title.replace(/"/g, '\'')}"\ndate: ${now().slice(0, 10)}${replace ? `\nrevised: ${now().slice(0, 10)}` : ''}\n---\n\n${body}\n`);
        run('UPDATE lessons SET exported_to = ? WHERE id = ?', rel, lessonId);
      } catch { /* the lesson itself is safe in SQLite */ }
    }
    // carry the lesson METADATA on the event (no content — that's fetched on demand)
    // so clients can select/label it without a round-trip.
    emit(s.id, {
      type: 'done', kind: 'lesson', lessonId, replaced: !!replace, health,
      lesson: rowToLessonMeta(one('SELECT * FROM lessons WHERE id = ?', lessonId)),
      usage,
    });
  } catch (e) { fail(s.id, ctl, e); }
  finally { live.delete(s.id); }
}

// ---------- revisions ----------

export function listRevisions(subjectId, lessonId) {
  const l = one('SELECT id FROM lessons WHERE id = ? AND subject_id = ?', lessonId, subjectId);
  if (!l) throw err('lesson not found', 404);
  return all('SELECT * FROM lesson_revisions WHERE lesson_id = ? ORDER BY created_at DESC', lessonId)
    .map(r => ({
      id: r.id, title: r.title, model: r.model, reason: r.reason, createdAt: r.created_at,
      health: parseJSON(r.health, []), chars: (r.content || '').length,
      sources: parseJSON(r.sources, []).length,
    }));
}

export function getRevision(subjectId, lessonId, revisionId) {
  const l = one('SELECT id FROM lessons WHERE id = ? AND subject_id = ?', lessonId, subjectId);
  if (!l) throw err('lesson not found', 404);
  const r = one('SELECT * FROM lesson_revisions WHERE id = ? AND lesson_id = ?', revisionId, lessonId);
  if (!r) throw err('revision not found', 404);
  return {
    id: r.id, title: r.title, content: r.content, model: r.model, reason: r.reason,
    createdAt: r.created_at, health: parseJSON(r.health, []), sources: parseJSON(r.sources, []),
  };
}

/** Put an old version back. The version being replaced is itself snapshotted first, so
 *  restore is undoable too — you can bounce between two drafts without losing either. */
export function restoreRevision(subjectId, lessonId, revisionId) {
  const l = one('SELECT * FROM lessons WHERE id = ? AND subject_id = ?', lessonId, subjectId);
  if (!l) throw err('lesson not found', 404);
  const r = one('SELECT * FROM lesson_revisions WHERE id = ? AND lesson_id = ?', revisionId, lessonId);
  if (!r) throw err('revision not found', 404);
  tx(() => {
    run(`INSERT INTO lesson_revisions (id, lesson_id, title, content, sources, next, health, model, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      genId(6), lessonId, l.title, l.content, l.sources, l.next, l.health || '[]', l.model,
      `superseded by restoring the ${r.created_at.slice(0, 10)} version`, now());
    run(`UPDATE lessons SET title = ?, content = ?, sources = ?, next = ?, health = ?, model = ?, revised_at = ? WHERE id = ?`,
      r.title, r.content, r.sources, r.next, r.health || '[]', r.model, now(), lessonId);
  });
  touch(subjectId);
  return { ok: true, restored: r.id };
}

/** Re-run the health check against what's stored — useful after the checks themselves
 *  change, or to confirm a fix actually landed. */
export function recheckLesson(subjectId, lessonId) {
  const l = one('SELECT * FROM lessons WHERE id = ? AND subject_id = ?', lessonId, subjectId);
  if (!l) throw err('lesson not found', 404);
  const health = lessonHealth(l.content, parseJSON(l.sources, []));
  run('UPDATE lessons SET health = ? WHERE id = ?', JSON.stringify(health), lessonId);
  // `ok` means "not damaged", not "flawless" — a lesson with only warnings is still a
  // usable lesson, and calling it broken would push people to regenerate good work.
  return { id: lessonId, health, level: healthLevel(health), ok: healthLevel(health) !== 'error' };
}

/** Health sweep across a subject — "which of my lessons are broken?" in one call. */
export function checkSubjectLessons(subjectId) {
  if (!one('SELECT id FROM subjects WHERE id = ?', subjectId)) throw err('subject not found', 404);
  const rows = all('SELECT * FROM lessons WHERE subject_id = ? ORDER BY n', subjectId);
  const out = rows.map(l => {
    const health = lessonHealth(l.content, parseJSON(l.sources, []));
    run('UPDATE lessons SET health = ? WHERE id = ?', JSON.stringify(health), l.id);
    const level = healthLevel(health);
    return { id: l.id, n: l.n, title: l.title, health, level, ok: level !== 'error' };
  });
  return {
    checked: out.length,
    broken: out.filter(x => x.level === 'error').length,
    warned: out.filter(x => x.level === 'warn').length,
    lessons: out,
  };
}

// ---------- assessments ----------

const KINDS = ['diagnostic', 'quiz', 'midterm', 'final', 'drill'];

const KIND_SPEC = {
  diagnostic: {
    label: 'Diagnostic', pass: 0, n: 12,
    // The point of a placement test is to find the ceiling, so it must span the
    // whole roadmap and climb — a flat "easy" test tells you nothing.
    brief: `A PLACEMENT test. The student may already know some, none, or all of this.
Span the WHOLE roadmap from its easiest module to its hardest, climbing in difficulty.
Roughly: 3 warmup, 6 core, 3 stretch. The goal is to locate the exact boundary between
what they know and what they don't — so every module should be probed at least once.`,
  },
  quiz: {
    label: 'Quiz', pass: 70, n: 6,
    brief: `A short check on ONE lesson/module — recall + one applied question.
Mostly core difficulty, one stretch. Fast: the student should finish in 5 minutes.`,
  },
  midterm: {
    label: 'Midterm', pass: 70, n: 12,
    brief: `A CHECKPOINT exam over the modules in scope (the last few completed).
Weight toward integration: questions that need two modules at once beat isolated recall.
Roughly: 2 warmup, 7 core, 3 stretch.`,
  },
  final: {
    label: 'Final', pass: 75, n: 18,
    brief: `A FINAL exam over the entire subject. Prove the goal is met.
Weight heavily toward synthesis and judgment ("which approach and why"), not trivia.
Roughly: 2 warmup, 9 core, 7 stretch. Include at least 3 open-ended questions.`,
  },
  drill: {
    label: 'Drill', pass: 0, n: 8,
    // pass 0: a drill is PRACTICE, not judgment — reps against weak spots. It still
    // moves mastery (that's the point), it just never gates anything.
    brief: `A rapid-fire PRACTICE drill — reps, not an exam. Use mcq, multi, shortanswer
and order only — no open-ended (speed matters). Aim at least two thirds of the questions
at the student's measured weak topics, each phrased differently from how they were asked
before. The rest: quick recall of recently taught material. Keep every question
answerable in under 30 seconds.`,
  },
};

export function generateAssessment({ id, kind = 'quiz', moduleId, lessonId, modelRef }) {
  if (!KINDS.includes(kind)) throw err(`unknown assessment kind: ${kind}`);
  const mods = all('SELECT * FROM modules WHERE subject_id = ? ORDER BY idx', id);
  if (!mods.length && kind !== 'diagnostic') throw err('generate a roadmap first');
  return begin(id, modelRef, 'assessment', (s, ctl, mr) =>
    runAssessment(s, ctl, { kind, moduleId, lessonId, modelRef: mr }));
}

/** Which modules an assessment covers. Midterms cover completed-but-never-examined
 *  modules; finals cover everything; quizzes cover their one module. */
function scopeFor(subjectId, kind, moduleId, mods) {
  if (kind === 'final' || kind === 'diagnostic' || kind === 'drill') return mods.map(m => m.id);
  if (kind === 'quiz') return moduleId ? [moduleId] : [(mods.find(m => !m.done) || mods[0])?.id].filter(Boolean);
  // midterm
  const exams = all(`SELECT scope FROM assessments WHERE subject_id = ? AND kind IN ('midterm','final')`, subjectId);
  const examined = new Set(exams.flatMap(e => parseJSON(e.scope, [])));
  const untested = mods.filter(m => m.done && !examined.has(m.id));
  return (untested.length ? untested : mods.filter(m => m.done)).map(m => m.id);
}

async function runAssessment(s, ctl, { kind, moduleId, lessonId, modelRef }) {
  const usage = { input: 0, output: 0 };
  const llm = makeLlm(s.id, ctl, modelRef, usage);
  const think = (delta) => emit(s.id, { type: 'reason.delta', delta });
  const phase = (p, detail = '') => emit(s.id, { type: 'status', phase: p, detail });
  const spec = KIND_SPEC[kind];
  try {
    phase('planning', `${spec.label.toLowerCase()} — selecting scope`);
    const mods = all('SELECT * FROM modules WHERE subject_id = ? ORDER BY idx', s.id).map(rowToModule);
    const scope = scopeFor(s.id, kind, moduleId, mods);
    const inScope = mods.filter(m => scope.includes(m.id));
    const lesson = lessonId ? one('SELECT * FROM lessons WHERE id = ? AND subject_id = ?', lessonId, s.id) : null;

    const outline = (inScope.length ? inScope : mods)
      .map((m, i) => `${i + 1}. ${m.title} — ${m.summary}\n   topics: ${m.topics.join(' · ')}`).join('\n') || '(no roadmap — probe the subject broadly)';

    const taught = all('SELECT n, title, topic FROM lessons WHERE subject_id = ? ORDER BY n', s.id)
      .map(l => `- L${l.n}: ${l.title}${l.topic ? ` (${l.topic})` : ''}`).join('\n') || '(no lessons taught yet)';

    // Weak topics get extra weight — an exam that avoids your weak spots is a lie.
    const weak = weakTopics(s.id, 6).filter(w => w.ratio < 0.8);
    const weakNote = weak.length
      ? `\nThe student has MEASURABLY struggled with: ${weak.map(w => `${w.topic} (${Math.round(w.ratio * 100)}% correct)`).join(', ')}.\nDeliberately re-test these — at least a third of the questions should touch them, phrased differently from before.\n`
      : '';

    phase('writing', `${spec.label.toLowerCase()} questions`);
    const out = await llm(
      `${tutorRules(2400)}

Write a ${spec.label.toUpperCase()} for this student.
Subject: ${s.name} · Level: ${s.level} · Goal: ${s.goal || '(not stated)'}
${lesson ? `This quiz covers ONE lesson: "${lesson.title}" (${lesson.topic}).\n` : ''}
Modules in scope:
${outline}

Lessons actually taught so far (do not test what was never taught, EXCEPT in a diagnostic):
${taught}${weakNote}

${spec.brief}

Write about ${spec.n} questions. Rules:
- "mcq": exactly 4 choices, ONE correct. Distractors must be plausible — each should be
  the answer a student holding a specific misconception would pick. No joke options,
  no "all of the above", no giveaway length tells.
- "multi": 4-6 choices, 2+ correct. Use when the skill really is "pick all that apply".
- "shortanswer": no choices. The student TYPES the answer — a term, a command, a value,
  a predicted output. "answer" is a JSON array of every acceptable spelling/alias
  (e.g. "[\\"O(log n)\\",\\"log n\\",\\"logarithmic\\"]"). Grading is exact-match after
  lowercasing and space-collapsing, so list all reasonable variants. Great for recall
  that mcq would give away.
- "order": 3-6 items in "choices" listed in SCRAMBLED order; "answer" is the JSON array
  of choice indices in the CORRECT sequence (e.g. "[2,0,1,3]"). Use for processes,
  pipelines, precedence, chronology — anything where sequence IS the skill.
- "open": no choices. The student writes prose/code. Give a rubric in "answer" describing
  what a full-credit response must contain (3-5 concrete checkpoints).
- Every question needs "topic" (2-4 words, matching a roadmap topic where possible) and
  "explanation" (why the answer is right AND why the tempting wrong one is wrong).
- "difficulty": warmup | core | stretch.

Output STRICT JSON only (no fences, no commentary):
{"title":"<short exam title>","blurb":"<one line: what this covers and how it's scored>",
 "questions":[{"kind":"mcq|multi|open","prompt":"<question>","choices":["a","b","c","d"],
 "answer":"<mcq: 0-based index as a string | multi: JSON array of indices like [0,2] | open: the rubric>",
 "explanation":"<why>","topic":"<topic>","difficulty":"warmup|core|stretch","points":1}]}`,
      { maxTokens: 8000, onReason: think });

    const j = extractJSON(out);
    const qs = Array.isArray(j?.questions) ? j.questions.filter(q => q && q.prompt) : [];
    if (qs.length < 3) throw new Error('the model did not return a usable assessment — try again (or a different model)');

    const aid = genId(8);
    tx(() => {
      run(`INSERT INTO assessments (id, subject_id, module_id, lesson_id, kind, title, blurb, scope, pass_pct, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        aid, s.id, moduleId || null, lessonId || null, kind,
        String(j.title || `${spec.label}: ${s.name}`).slice(0, 140),
        String(j.blurb || '').slice(0, 300), JSON.stringify(scope), spec.pass, modelRef, now());

      qs.slice(0, 30).forEach((q, i) => {
        const kindQ = ['mcq', 'multi', 'open', 'shortanswer', 'order'].includes(q.kind) ? q.kind : 'mcq';
        const choices = (kindQ === 'open' || kindQ === 'shortanswer') ? [] : (Array.isArray(q.choices) ? q.choices.map(c => String(c).slice(0, 400)) : []);
        // Malformed structured questions would be unanswerable — demote to open (the
        // answer text becomes the rubric) rather than shipping a broken widget:
        // mcq/multi with <2 choices, or an order whose answer isn't a real permutation.
        let finalKind = kindQ;
        if (['mcq', 'multi'].includes(kindQ) && choices.length < 2) finalKind = 'open';
        if (kindQ === 'order' && (choices.length < 3 || !validOrderAnswer(q.answer, choices.length))) finalKind = 'open';
        if (kindQ === 'shortanswer' && !String(q.answer ?? '').trim()) finalKind = 'open';
        run(`INSERT INTO questions (id, assessment_id, idx, kind, prompt, choices, answer, explanation, topic, difficulty, points)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          genId(6), aid, i, finalKind, String(q.prompt).slice(0, 2000),
          JSON.stringify(finalKind === 'open' ? [] : choices),
          String(q.answer ?? '').slice(0, 2000), String(q.explanation || '').slice(0, 1200),
          String(q.topic || '').slice(0, 120),
          ['warmup', 'core', 'stretch'].includes(q.difficulty) ? q.difficulty : 'core',
          Math.max(1, Math.min(5, Number(q.points) || 1)));
      });
      run('UPDATE subjects SET error = ?, updated_at = ? WHERE id = ?', '', now(), s.id);
    });
    emit(s.id, { type: 'done', kind: 'assessment', assessmentId: aid, count: qs.length, usage });
  } catch (e) { fail(s.id, ctl, e); }
  finally { live.delete(s.id); }
}

/** The student-facing paper — answers/explanations stripped so the page can't be cheated. */
export function getAssessment(subjectId, assessmentId, { withAnswers = false } = {}) {
  const a = one('SELECT * FROM assessments WHERE id = ? AND subject_id = ?', assessmentId, subjectId);
  if (!a) throw err('assessment not found', 404);
  const questions = all('SELECT * FROM questions WHERE assessment_id = ? ORDER BY idx', assessmentId).map(q => ({
    id: q.id, idx: q.idx, kind: q.kind, prompt: q.prompt, choices: parseJSON(q.choices, []),
    topic: q.topic, difficulty: q.difficulty, points: q.points,
    ...(withAnswers ? { answer: q.answer, explanation: q.explanation } : {}),
  }));
  const attempts = all(
    `SELECT id, started_at, submitted_at, score, max_score, passed FROM attempts
      WHERE assessment_id = ? AND submitted_at IS NOT NULL ORDER BY submitted_at DESC`, assessmentId)
    .map(t => ({ id: t.id, at: t.submitted_at, score: t.score, maxScore: t.max_score, passed: !!t.passed }));
  return { ...rowToAssessment(a), questions, attempts };
}

export function startAttempt(subjectId, assessmentId) {
  const a = one('SELECT id FROM assessments WHERE id = ? AND subject_id = ?', assessmentId, subjectId);
  if (!a) throw err('assessment not found', 404);
  const id = genId(8);
  run('INSERT INTO attempts (id, assessment_id, subject_id, started_at) VALUES (?, ?, ?, ?)', id, assessmentId, subjectId, now());
  return { id, startedAt: now() };
}

/** Normalization for typed answers: case, surrounding space and internal runs of
 *  whitespace never decide correctness — spelling does. */
const normAnswer = (s) => String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

/** Longest common subsequence length — partial credit for a nearly-right ordering. */
function lcsLen(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Auto-grade every objective kind (everything but 'open'). Returns {correct, points}. */
function gradeObjective(q, given) {
  if (q.kind === 'mcq') {
    const want = String(q.answer).trim();
    const got = String(given ?? '').trim();
    const ok = got !== '' && got === want;
    return { correct: ok, points: ok ? q.points : 0 };
  }
  if (q.kind === 'shortanswer') {
    // answer = JSON array of accepted spellings/aliases (or a bare string)
    const accepted = (parseJSON(q.answer, null) ?? [q.answer]).map(normAnswer).filter(Boolean);
    const got = normAnswer(given);
    const ok = got !== '' && accepted.includes(got);
    return { correct: ok, points: ok ? q.points : 0 };
  }
  if (q.kind === 'order') {
    // answer = the correct sequence of choice indices; given = the student's arrangement
    const want = (parseJSON(q.answer, []) || []).map(Number);
    const got = (Array.isArray(given) ? given : parseJSON(given, []) || []).map(Number);
    if (!want.length || got.length !== want.length) return { correct: false, points: 0 };
    if (want.every((v, i) => got[i] === v)) return { correct: true, points: q.points };
    // partial credit by longest common subsequence: mostly-right order earns most of the
    // points; (lcs-1)/(n-1) so a random single coincidence doesn't score
    const frac = Math.max(0, lcsLen(got, want) - 1) / Math.max(1, want.length - 1);
    return { correct: false, points: Math.round(frac * q.points * 100) / 100 };
  }
  // multi: set equality, partial credit for a subset with no wrong picks
  const want = new Set((parseJSON(q.answer, []) || []).map(String));
  const got = new Set((Array.isArray(given) ? given : parseJSON(given, []) || []).map(String));
  if (!want.size) return { correct: false, points: 0 };
  const wrong = [...got].filter(x => !want.has(x)).length;
  const hit = [...got].filter(x => want.has(x)).length;
  if (wrong === 0 && hit === want.size) return { correct: true, points: q.points };
  if (wrong === 0 && hit > 0) return { correct: false, points: Math.round((hit / want.size) * q.points * 100) / 100 }; // partial
  return { correct: false, points: 0 };
}

/** Submit answers: objective questions score instantly; open ones go to the model with
 *  the rubric. Every graded answer moves mastery for its topic. */
export function submitAttempt({ subjectId, assessmentId, attemptId, answers = {}, modelRef }) {
  const a = one('SELECT * FROM assessments WHERE id = ? AND subject_id = ?', assessmentId, subjectId);
  if (!a) throw err('assessment not found', 404);
  const t = one('SELECT * FROM attempts WHERE id = ? AND assessment_id = ?', attemptId, assessmentId);
  if (!t) throw err('attempt not found', 404);
  if (t.submitted_at) throw err('this attempt was already submitted', 409);
  if (live.has(subjectId)) throw err('this subject is already generating — wait or cancel', 409);

  modelRef = resolveModel(modelRef);
  const qs = all('SELECT * FROM questions WHERE assessment_id = ? ORDER BY idx', assessmentId);
  const open = qs.filter(q => q.kind === 'open');

  const ctl = new AbortController();
  live.set(subjectId, ctl);
  setTimeout(() => gradeAttempt({ a, t, qs, open, answers, subjectId, modelRef, ctl }).catch(() => { }), 100);
  return { attemptId, status: 'grading', open: open.length };
}

async function gradeAttempt({ a, t, qs, open, answers, subjectId, modelRef, ctl }) {
  const usage = { input: 0, output: 0 };
  const phase = (p, detail = '') => emit(subjectId, { type: 'status', phase: p, detail });
  try {
    const graded = [];
    // 1. objective questions — instant, no model needed
    for (const q of qs.filter(x => x.kind !== 'open')) {
      const { correct, points } = gradeObjective(q, answers[q.id]);
      graded.push({ q, given: JSON.stringify(answers[q.id] ?? ''), correct, points, feedback: '' });
    }
    // 2. open questions — the model grades against the rubric it wrote
    if (open.length) {
      if (!modelRef) throw new Error('open-ended questions need a model — pick one and resubmit');
      const llm = makeLlm(subjectId, ctl, modelRef, usage);
      phase('grading', `${open.length} written answer${open.length > 1 ? 's' : ''}`);
      const payload = open.map((q, i) => `### Q${i + 1} (worth ${q.points})
QUESTION: ${q.prompt}
RUBRIC (full credit requires): ${q.answer}
STUDENT ANSWER: ${String(answers[q.id] ?? '').slice(0, 4000) || '(left blank)'}`).join('\n\n');

      const out = await llm(
        `You are grading ${open.length} written answers. Be a fair but exacting grader:
award credit for correct reasoning even if the wording differs from the rubric, and
withhold it for confident-sounding answers that miss the rubric's checkpoints. A blank
answer scores 0. Do not be generous to spare feelings — a wrong grade teaches nothing.

${payload}

Output STRICT JSON only:
{"grades":[{"n":1,"points":<number, 0..worth, halves allowed>,"correct":<true only if essentially full credit>,"feedback":"<2-3 sentences: what they got, what they missed, the one thing to fix>"}]}`,
        { maxTokens: 3000, system: 'You are a rigorous grader. Output STRICT JSON only.' });

      const gj = extractJSON(out);
      const grades = Array.isArray(gj?.grades) ? gj.grades : [];
      open.forEach((q, i) => {
        const g = grades.find(x => Number(x.n) === i + 1) || {};
        // || not ?? — Number(garbage) is NaN, which ?? happily passes through and
        // NaN-poisons the whole attempt score
        const pts = Math.max(0, Math.min(q.points, Number(g.points) || 0));
        graded.push({
          q, given: String(answers[q.id] ?? ''),
          correct: !!g.correct, points: pts,
          feedback: String(g.feedback || '').slice(0, 800),
        });
      });
    }

    const score = Math.round(graded.reduce((n, g) => n + g.points, 0) * 100) / 100;
    const maxScore = qs.reduce((n, q) => n + q.points, 0);
    const pct = maxScore ? (score / maxScore) * 100 : 0;
    const passed = pct >= a.pass_pct;

    tx(() => {
      for (const g of graded) {
        run(`INSERT INTO responses (id, attempt_id, question_id, given, correct, points, feedback)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          genId(6), t.id, g.q.id, g.given, g.correct ? 1 : 0, g.points, g.feedback);
        // mastery moves on every graded answer — this is what makes the Corner adaptive
        if (g.q.topic) recordMastery(subjectId, g.q.topic, g.correct);
      }
      run('UPDATE attempts SET submitted_at = ?, score = ?, max_score = ?, passed = ? WHERE id = ?',
        now(), score, maxScore, passed ? 1 : 0, t.id);
      run('UPDATE subjects SET updated_at = ? WHERE id = ?', now(), subjectId);
    });

    // Passing a midterm/final marks its scope complete — the exam IS the proof.
    if (passed && (a.kind === 'midterm' || a.kind === 'final')) {
      for (const mid of parseJSON(a.scope, [])) run('UPDATE modules SET done = 1 WHERE id = ?', mid);
    }
    emit(subjectId, { type: 'done', kind: 'graded', attemptId: t.id, score, maxScore, passed, usage });
  } catch (e) { fail(subjectId, ctl, e); }
  finally { live.delete(subjectId); }
}

export function getAttempt(subjectId, attemptId) {
  const t = one('SELECT * FROM attempts WHERE id = ? AND subject_id = ?', attemptId, subjectId);
  if (!t) throw err('attempt not found', 404);
  const rows = all(
    `SELECT r.*, q.prompt, q.kind, q.choices, q.answer, q.explanation, q.topic, q.difficulty, q.points AS worth, q.idx
       FROM responses r JOIN questions q ON q.id = r.question_id
      WHERE r.attempt_id = ? ORDER BY q.idx`, attemptId);
  return {
    id: t.id, assessmentId: t.assessment_id, startedAt: t.started_at, submittedAt: t.submitted_at,
    score: t.score, maxScore: t.max_score, passed: !!t.passed, feedback: t.feedback,
    responses: rows.map(r => ({
      questionId: r.question_id, idx: r.idx, kind: r.kind, prompt: r.prompt,
      choices: parseJSON(r.choices, []), given: r.given, correct: !!r.correct,
      points: r.points, worth: r.worth, answer: r.answer, explanation: r.explanation,
      topic: r.topic, difficulty: r.difficulty, feedback: r.feedback,
    })),
  };
}

// ---------- the feedback button ----------

/** A brutally honest standing report on the student: what's solid, what's rotten,
 *  what's coming, how to prepare. Cached onto the latest attempt when there is one. */
export function generateFeedback({ id, modelRef }) {
  return begin(id, modelRef, 'feedback', runFeedback);
}

async function runFeedback(s, ctl, modelRef) {
  const usage = { input: 0, output: 0 };
  const llm = makeLlm(s.id, ctl, modelRef, usage);
  const phase = (p, detail = '') => emit(s.id, { type: 'status', phase: p, detail });
  try {
    phase('planning', 'reading your record');
    const mods = all('SELECT * FROM modules WHERE subject_id = ? ORDER BY idx', s.id).map(rowToModule);
    const lessons = all('SELECT n, title, type, topic, done FROM lessons WHERE subject_id = ? ORDER BY n', s.id);
    const attempts = all(
      `SELECT t.score, t.max_score, t.passed, t.submitted_at, a.kind, a.title
         FROM attempts t JOIN assessments a ON a.id = t.assessment_id
        WHERE t.subject_id = ? AND t.submitted_at IS NOT NULL
        ORDER BY t.submitted_at ASC`, s.id);
    const mastery = all('SELECT topic, seen, correct, streak FROM mastery WHERE subject_id = ? ORDER BY (CAST(correct AS REAL)/seen) ASC', s.id);
    const stats = masteryStats(s.id);

    if (!lessons.length && !attempts.length) {
      throw new Error('nothing to report on yet — take a lesson or an assessment first');
    }

    // Missed questions are the highest-signal evidence there is: quote them back.
    const misses = all(
      `SELECT q.prompt, q.topic, q.explanation, r.given, r.feedback, a.title AS exam
         FROM responses r
         JOIN questions q ON q.id = r.question_id
         JOIN attempts t ON t.id = r.attempt_id
         JOIN assessments a ON a.id = t.assessment_id
        WHERE t.subject_id = ? AND r.correct = 0
        ORDER BY t.submitted_at DESC LIMIT 12`, s.id);

    phase('writing', 'the honest version');
    const md = await llm(
      `${tutorRules(1800)}

Write a STANDING PROGRESS REPORT for this student. They asked for brutal honesty —
give it. No participation trophies, no hedging, no "great job!" padding. If they are
coasting, say so. If a score is bad, name it. Praise ONLY what the evidence supports.

Subject: ${s.name} · Level: ${s.level} · Goal: ${s.goal || '(not stated)'}
Roadmap: ${mods.length} modules, ${mods.filter(m => m.done).length} complete.
${mods.map((m, i) => `  ${i + 1}. ${m.title}${m.done ? ' ✓' : ''}`).join('\n')}

Lessons taken (${lessons.length}):
${lessons.map(l => `  L${l.n} ${l.title} [${l.type}]${l.done ? ' ✓' : ' (not marked complete)'}`).join('\n') || '  (none)'}

Assessments (${attempts.length}):
${attempts.map(t => `  ${t.kind}: "${t.title}" → ${t.score}/${t.max_score} (${Math.round(t.score / (t.max_score || 1) * 100)}%) ${t.passed ? 'PASS' : 'FAIL'}`).join('\n') || '  (none taken — that itself is worth calling out)'}

Per-topic accuracy (${stats.correct}/${stats.seen} overall${stats.pct !== null ? `, ${stats.pct}%` : ''}):
${mastery.map(m => `  ${m.topic}: ${m.correct}/${m.seen}${m.streak >= 3 ? ` (streak ${m.streak})` : ''}`).join('\n') || '  (nothing assessed yet)'}

${misses.length ? `Recently missed questions — the actual evidence:\n${misses.map(m => `  Q: ${m.prompt.slice(0, 180)}\n    topic: ${m.topic} · they answered: ${String(m.given).slice(0, 120)}\n    why it's wrong: ${(m.explanation || m.feedback || '').slice(0, 200)}`).join('\n')}` : ''}

Write markdown with EXACTLY these sections:
## Verdict
One paragraph. The honest headline. If the record is thin, say the record is thin — do
not invent progress. Name a number where a number exists.
## What's actually solid
Only what the evidence supports (streaks, passed exams, high-accuracy topics). If nothing
qualifies yet, say so plainly instead of inventing something.
## What's not
The weak topics, by name, with their accuracy. Say what the pattern suggests about the
underlying misunderstanding — not just "you got X wrong" but "you're treating X as if Y".
## What's coming
What the roadmap holds next and why it will be harder than what came before.
## How to prepare
3-5 specific, concrete actions. Each names a topic and an artifact to produce. No "review
your notes" — say exactly what to build, run, or re-derive.`,
      { stream: true, maxTokens: 3000 });

    if (md.trim().length < 200) throw new Error('the model returned an empty report — try again');
    const last = one(`SELECT id FROM attempts WHERE subject_id = ? AND submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 1`, s.id);
    if (last) run('UPDATE attempts SET feedback = ? WHERE id = ?', md.trim(), last.id);
    emit(s.id, { type: 'done', kind: 'feedback', feedback: md.trim(), usage });
  } catch (e) { fail(s.id, ctl, e); }
  finally { live.delete(s.id); }
}

// ---------- career / certification advisor ----------
//
// "What should I aim at?" is a different question from "what's the next lesson" — it's
// about the world, not the roadmap. So the advisor is web-grounded (real certs, current
// costs and expectations) and its output is ACTIONABLE: every suggestion can be adopted
// as a sub-subject with one click, which drops it into the same roadmap → lessons →
// exams machinery as everything else.

export function generateAdvice({ id, modelRef }) {
  return begin(id, modelRef, 'advice', runAdvice);
}

async function runAdvice(s, ctl, modelRef) {
  const usage = { input: 0, output: 0 };
  const llm = makeLlm(s.id, ctl, modelRef, usage);
  const think = (delta) => emit(s.id, { type: 'reason.delta', delta });
  const phase = (p, detail = '') => emit(s.id, { type: 'status', phase: p, detail });
  try {
    const year = new Date().getFullYear();
    phase('searching', 'certifications and career paths');
    const snippets = [];
    for (const q of [
      `${s.name} certifications worth it ${year}`,
      `${s.name} career path what to learn ${year}`,
      `best ${s.name} certificate ${s.level} cost`,
    ]) {
      if (ctl.signal.aborted) throw new Error('cancelled');
      try {
        const { results } = await webSearch(q, { n: 6, time_range: 'year' });
        emit(s.id, { type: 'search', query: q, found: results.length });
        for (const r of results.slice(0, 5)) snippets.push(`- ${r.title}: ${(r.snippet || '').slice(0, 200)} (${r.url})`);
      } catch (e) { emit(s.id, { type: 'search', query: q, found: 0, error: e.message }); }
    }

    const mods = all('SELECT title, done FROM modules WHERE subject_id = ? ORDER BY idx', s.id);
    const stats = masteryStats(s.id);
    phase('writing', 'paths and certificates');
    const out = await llm(
      `${tutorRules(1600)}

Recommend concrete next TARGETS for this student — certifications worth sitting, and
career/learning paths worth committing to.

Subject: ${s.name} · Level: ${s.level} · Goal: ${s.goal || '(not stated)'}
Progress: ${mods.filter(m => m.done).length}/${mods.length} roadmap modules done${stats.pct !== null ? ` · measured mastery ${stats.pct}%` : ''}
${mods.length ? `Modules: ${mods.map(m => m.title).join(' · ')}` : ''}

Current market signal (web search, ${year}):
${snippets.slice(0, 14).join('\n') || '(no web results reachable — recommend only widely-established certifications and say costs are approximate)'}

Rules:
- Only REAL certifications from real organizations. Name the issuing org. Never invent
  a cert, a price, or an exam code. Approximate costs are fine when marked (~).
- Match the student's level: no architect-tier certs for a beginner, no intro certs for
  someone measurably past them.
- "why" must reference THIS student's goal/progress, not generic marketing.
- 2-4 certs, 2-3 paths. A path is a 3-6 step sequence of capabilities, not a slogan.

Output STRICT JSON only (no fences):
{"certs":[{"name":"<official cert name>","org":"<issuer>","cost":"<e.g. ~$300 USD>",
 "difficulty":"entry|intermediate|advanced","prep_weeks":<number>,
 "why":"<2 sentences, specific to this student>","url":"<official page if known, else ''>"}],
 "paths":[{"title":"<path name>","horizon":"<e.g. 6 months>",
 "why":"<2 sentences, specific>","steps":["<capability step>","..."]}]}`,
      { maxTokens: 3500, onReason: think });

    const j = extractJSON(out);
    const certs = (Array.isArray(j?.certs) ? j.certs : []).filter(c => c && c.name && c.org).slice(0, 5).map(c => ({
      name: String(c.name).slice(0, 120), org: String(c.org).slice(0, 80),
      cost: String(c.cost || '').slice(0, 40),
      difficulty: ['entry', 'intermediate', 'advanced'].includes(c.difficulty) ? c.difficulty : 'intermediate',
      prepWeeks: Math.max(1, Math.min(52, Number(c.prep_weeks) || 6)),
      why: String(c.why || '').slice(0, 400),
      url: /^https?:\/\//.test(c.url || '') ? String(c.url).slice(0, 300) : '',
    }));
    const paths = (Array.isArray(j?.paths) ? j.paths : []).filter(p => p && p.title).slice(0, 4).map(p => ({
      title: String(p.title).slice(0, 120), horizon: String(p.horizon || '').slice(0, 40),
      why: String(p.why || '').slice(0, 400),
      steps: (Array.isArray(p.steps) ? p.steps : []).map(x => String(x).slice(0, 160)).slice(0, 8),
    }));
    if (!certs.length && !paths.length) throw new Error('the model did not return usable suggestions — try again (or a different model)');

    const advice = { certs, paths, generatedAt: now(), model: modelRef };
    run('UPDATE subjects SET advice = ?, error = ?, updated_at = ? WHERE id = ?', JSON.stringify(advice), '', now(), s.id);
    emit(s.id, { type: 'done', kind: 'advice', advice, usage });
  } catch (e) { fail(s.id, ctl, e); }
  finally { live.delete(s.id); }
}

// ---------- programmatic surface for the agent's tools ----------

/** Does `answer` describe a valid ordering of n choices (a permutation of 0..n-1)? */
function validOrderAnswer(answer, n) {
  const seq = parseJSON(answer, null);
  return Array.isArray(seq) && seq.length === n && [...seq].map(Number).sort((a, b) => a - b).every((v, i) => v === i);
}

export function addQuestion(assessmentId, q = {}) {
  const a = one('SELECT id FROM assessments WHERE id = ?', assessmentId);
  if (!a) throw err('assessment not found', 404);
  const kind = ['mcq', 'multi', 'open', 'shortanswer', 'order'].includes(q.kind) ? q.kind : 'mcq';
  const choices = (kind === 'open' || kind === 'shortanswer') ? [] : (Array.isArray(q.choices) ? q.choices : []);
  if (['mcq', 'multi'].includes(kind) && choices.length < 2) throw err('mcq/multi questions need at least 2 choices');
  if (kind === 'order') {
    if (choices.length < 3 || choices.length > 8) throw err('order questions need 3-8 items in choices');
    if (!validOrderAnswer(q.answer, choices.length)) throw err(`order answer must be a JSON permutation of 0..${choices.length - 1}, e.g. "[2,0,1]"`);
  }
  if (kind === 'shortanswer' && !String(q.answer || '').trim()) throw err('shortanswer needs an answer (string or JSON array of accepted aliases)');
  const idx = (one('SELECT COALESCE(MAX(idx), -1) AS i FROM questions WHERE assessment_id = ?', assessmentId)?.i ?? -1) + 1;
  const id = genId(6);
  run(`INSERT INTO questions (id, assessment_id, idx, kind, prompt, choices, answer, explanation, topic, difficulty, points)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, assessmentId, idx, kind, String(q.prompt || '').slice(0, 2000), JSON.stringify(choices),
    String(q.answer ?? '').slice(0, 2000), String(q.explanation || '').slice(0, 1200),
    String(q.topic || '').slice(0, 120),
    ['warmup', 'core', 'stretch'].includes(q.difficulty) ? q.difficulty : 'core',
    Math.max(1, Math.min(5, Number(q.points) || 1)));
  return { id, idx };
}

export function createAssessment({ subjectId, kind = 'quiz', title, blurb = '', moduleId = null, lessonId = null, scope = [], passPct }) {
  if (!one('SELECT id FROM subjects WHERE id = ?', subjectId)) throw err('subject not found', 404);
  if (!KINDS.includes(kind)) throw err(`unknown assessment kind: ${kind}`);
  const id = genId(8);
  run(`INSERT INTO assessments (id, subject_id, module_id, lesson_id, kind, title, blurb, scope, pass_pct, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
    id, subjectId, moduleId, lessonId, kind, String(title || `${KIND_SPEC[kind].label}`).slice(0, 140),
    String(blurb).slice(0, 300), JSON.stringify(scope || []),
    Number.isFinite(passPct) ? passPct : KIND_SPEC[kind].pass, now());
  return { id, kind };
}

export function deleteAssessment(subjectId, assessmentId) {
  const a = one('SELECT id FROM assessments WHERE id = ? AND subject_id = ?', assessmentId, subjectId);
  if (!a) throw err('assessment not found', 404);
  run('DELETE FROM assessments WHERE id = ?', assessmentId);
  return { ok: true };
}

export function deleteLesson(subjectId, lessonId) {
  const l = one('SELECT id FROM lessons WHERE id = ? AND subject_id = ?', lessonId, subjectId);
  if (!l) throw err('lesson not found', 404);
  run('DELETE FROM lessons WHERE id = ?', lessonId);
  touch(subjectId);
  return { ok: true };
}

/** Move mastery from outside the quiz UI — the agent judging an answer in chat should
 *  teach the Corner just as much as a graded exam does. */
export function recordTopicResult(subjectId, topic, correct) {
  if (!one('SELECT id FROM subjects WHERE id = ?', subjectId)) throw err('subject not found', 404);
  if (!String(topic || '').trim()) throw err('topic is required');
  recordMastery(subjectId, topic, !!correct);
  touch(subjectId);
  return { ok: true };
}

export const getWeakTopics = (subjectId, limit = 8) => weakTopics(subjectId, limit);
export const getMastery = (subjectId) => masteryStats(subjectId);
export { extractJSON, KIND_SPEC };
