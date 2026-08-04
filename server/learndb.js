// Learning Corner storage — SQLite via node:sqlite (built into Node 22+; no new
// dependency). The JSON-per-subject store this replaces couldn't express what the
// Corner now needs: a subject TREE (Programming → Python → Dijkstra's), assessments
// with per-question grading, and mastery tracked per topic across every attempt.
// Those are relational questions ("which topics has the student failed twice?"), so
// they get a relational store.
//
// Design notes:
//   * One connection, opened lazily, WAL mode — the server is single-process.
//   * Every subject row can point at a parent (parent_id), unlimited depth. Deleting
//     a parent cascades to children/modules/lessons/assessments (FK ON DELETE CASCADE),
//     so there are no orphans to sweep up.
//   * `mastery` is the adaptive spine: one row per (subject, topic) with a decaying
//     correct/seen tally. Weak topics drive review lessons and exam question mixes.
//   * Existing data/learn/*.json subjects migrate in on first open, then the files are
//     renamed .migrated so a rollback still has them and re-import can't double up.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA } from './config.js';
import { id as genId, now, readJSON } from './util.js';

const DB_FILE = path.join(DATA, 'learn.db');
const JSON_DIR = path.join(DATA, 'learn');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subjects (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES subjects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  goal        TEXT NOT NULL DEFAULT '',
  level       TEXT NOT NULL DEFAULT 'beginner',
  position    INTEGER NOT NULL DEFAULT 0,
  error       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subjects_parent ON subjects(parent_id);

CREATE TABLE IF NOT EXISTS modules (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL DEFAULT 0,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  topics      TEXT NOT NULL DEFAULT '[]',   -- JSON array of lesson-sized topics
  kind        TEXT NOT NULL DEFAULT 'standard', -- standard | project | capstone
  done        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modules_subject ON modules(subject_id, idx);

CREATE TABLE IF NOT EXISTS lessons (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  module_id   TEXT REFERENCES modules(id) ON DELETE SET NULL,
  n           INTEGER NOT NULL,
  title       TEXT NOT NULL,
  topic       TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'standard',
  content     TEXT NOT NULL DEFAULT '',
  sources     TEXT NOT NULL DEFAULT '[]',
  next        TEXT NOT NULL DEFAULT '[]',
  done        INTEGER NOT NULL DEFAULT 0,
  model       TEXT NOT NULL DEFAULT '',
  exported_to TEXT NOT NULL DEFAULT '',
  health      TEXT NOT NULL DEFAULT '[]',  -- JSON array of detected problems; [] = clean
  revised_at  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_subject ON lessons(subject_id, n);

-- Every regenerate snapshots the old body here first, so a "fix" that comes back worse
-- is never a one-way door. Cascades with its lesson.
CREATE TABLE IF NOT EXISTS lesson_revisions (
  id          TEXT PRIMARY KEY,
  lesson_id   TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  sources     TEXT NOT NULL DEFAULT '[]',
  next        TEXT NOT NULL DEFAULT '[]',
  health      TEXT NOT NULL DEFAULT '[]',
  model       TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_lesson ON lesson_revisions(lesson_id, created_at);

-- kind: diagnostic (placement, before any lesson) | quiz (one lesson/module)
--     | midterm (covers the last few modules) | final (covers everything)
CREATE TABLE IF NOT EXISTS assessments (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  module_id   TEXT REFERENCES modules(id) ON DELETE SET NULL,
  lesson_id   TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'quiz',
  title       TEXT NOT NULL,
  blurb       TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL DEFAULT '[]',   -- JSON array of module ids covered
  pass_pct    INTEGER NOT NULL DEFAULT 70,
  model       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assess_subject ON assessments(subject_id, created_at);

-- kind: mcq (choices + one answer index) | multi (several correct) | open (LLM-graded)
CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'mcq',
  prompt        TEXT NOT NULL,
  choices       TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  answer        TEXT NOT NULL DEFAULT '',    -- mcq: index; multi: JSON idx array; open: rubric/model answer
  explanation   TEXT NOT NULL DEFAULT '',
  topic         TEXT NOT NULL DEFAULT '',
  difficulty    TEXT NOT NULL DEFAULT 'core', -- warmup | core | stretch
  points        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_questions_assess ON questions(assessment_id, idx);

CREATE TABLE IF NOT EXISTS attempts (
  id            TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  subject_id    TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  submitted_at  TEXT,
  score         REAL NOT NULL DEFAULT 0,
  max_score     REAL NOT NULL DEFAULT 0,
  passed        INTEGER NOT NULL DEFAULT 0,
  feedback      TEXT NOT NULL DEFAULT ''     -- the brutally-honest report, markdown
);
CREATE INDEX IF NOT EXISTS idx_attempts_assess ON attempts(assessment_id, started_at);

CREATE TABLE IF NOT EXISTS responses (
  id          TEXT PRIMARY KEY,
  attempt_id  TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  given       TEXT NOT NULL DEFAULT '',
  correct     INTEGER NOT NULL DEFAULT 0,
  points      REAL NOT NULL DEFAULT 0,
  feedback    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_responses_attempt ON responses(attempt_id);

-- The adaptive spine. One row per (subject, topic): how often the student has been
-- asked, how often they got it right, and when. Weak = low ratio or stale.
CREATE TABLE IF NOT EXISTS mastery (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  topic       TEXT NOT NULL,
  seen        INTEGER NOT NULL DEFAULT 0,
  correct     INTEGER NOT NULL DEFAULT 0,
  streak      INTEGER NOT NULL DEFAULT 0,   -- consecutive correct; resets on a miss
  last_seen   TEXT NOT NULL,
  UNIQUE(subject_id, topic)
);
CREATE INDEX IF NOT EXISTS idx_mastery_subject ON mastery(subject_id);
`;

/** Open (once) and migrate. Safe to call on every access. */
export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS silently skips tables that already exist, so columns
  // added after a DB was first created need an explicit ALTER.
  ensureColumn('lessons', 'health', `TEXT NOT NULL DEFAULT '[]'`);
  ensureColumn('lessons', 'revised_at', `TEXT NOT NULL DEFAULT ''`);
  backupOnBoot();
  // career/cert advisor payload (JSON: { paths:[], certs:[], generatedAt }) — one per
  // subject, regenerated in place; small enough that a column beats another table
  ensureColumn('subjects', 'advice', `TEXT NOT NULL DEFAULT ''`);
  try { migrateFromJSON(); } catch (e) {
    // A migration failure must not brick the app — the JSON files stay untouched
    // and are re-tried next boot.
    console.error('[learn] JSON→SQL migration skipped:', e.message);
  }
  return db;
}

/** One dated backup per boot-day, keeping the last 7. Cheap insurance: this DB holds
 *  months of study history, and a wipe (bug, stray click, anything) once went unnoticed
 *  until the empty table auto-reseeded over it. wal_checkpoint first so the copy
 *  includes everything committed, not just the last-checkpointed state. */
const KEEP_BACKUPS = 7;
function backupOnBoot() {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = `${DB_FILE}.bak-${stamp}`;
    if (!fs.existsSync(dest)) {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(DB_FILE, dest);
      const old = fs.readdirSync(path.dirname(DB_FILE))
        .filter(f => f.startsWith(path.basename(DB_FILE) + '.bak-')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) {
        fs.unlinkSync(path.join(path.dirname(DB_FILE), f));
      }
      console.log(`[learn] backup written: ${path.basename(dest)}`);
    }
  } catch (e) { console.error('[learn] backup failed:', e.message); }
}

/** Add a column if it isn't there yet. node:sqlite has no migration framework and this
 *  app has exactly one writer, so a pragma check + ALTER is the whole story. */
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  stmts.clear();                         // ALTER TABLE can invalidate prepared statements
  console.log(`[learn] schema: added ${table}.${col}`);
}

// ---------- tiny query helpers ----------

// Prepared once, reused after. The SQL strings are literals in this codebase, so the
// cache is bounded by the code rather than by traffic; a review session that grades
// twenty lessons no longer recompiles the same UPDATE twenty times.
const stmts = new Map();
function stmt(sql) {
  let s = stmts.get(sql);
  if (!s) { s = getDb().prepare(sql); stmts.set(sql, s); }
  return s;
}

// `undefined` → `null`. node:sqlite refuses to bind undefined and throws "Provided value
// cannot be bound to SQLite parameter 1", which is what a caller saw when an id was
// simply missing — an opaque driver message where the lookup should have missed and
// raised the real one ("lesson not found"). A tool called with an argument left out is
// an everyday event when a model is doing the calling, and it must produce an answer the
// model can act on. NULL matches nothing, so every `WHERE id = ?` behaves as intended.
const bind = (args) => args.map(a => (a === undefined ? null : a));

export const all = (sql, ...args) => stmt(sql).all(...bind(args));
export const one = (sql, ...args) => stmt(sql).get(...bind(args)) ?? null;
export const run = (sql, ...args) => stmt(sql).run(...bind(args));

/** node:sqlite has no transaction sugar; this keeps multi-write ops atomic. */
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; }
  catch (e) { try { d.exec('ROLLBACK'); } catch { } throw e; }
}

export const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ---------- one-time import of the old JSON subjects ----------

function migrateFromJSON() {
  if (!fs.existsSync(JSON_DIR)) return;
  const files = fs.readdirSync(JSON_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) return;

  for (const f of files) {
    const s = readJSON(path.join(JSON_DIR, f));
    if (!s?.id || !s?.name) continue;
    // Idempotent: if this subject id already landed, just retire the file.
    const exists = one('SELECT id FROM subjects WHERE id = ?', s.id);
    if (!exists) {
      tx(() => {
        run(`INSERT INTO subjects (id, parent_id, name, goal, level, position, error, created_at, updated_at)
             VALUES (?, NULL, ?, ?, ?, 0, '', ?, ?)`,
          s.id, String(s.name).slice(0, 80), String(s.goal || '').slice(0, 500),
          s.level || 'beginner', s.createdAt || now(), s.updatedAt || now());

        const mods = s.roadmap?.modules || [];
        mods.forEach((m, i) => {
          run(`INSERT INTO modules (id, subject_id, idx, title, summary, topics, kind, done, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            m.id || genId(6), s.id, i, String(m.title).slice(0, 120), String(m.summary || '').slice(0, 300),
            JSON.stringify(m.topics || []), /project|capstone/i.test(m.title) ? 'project' : 'standard',
            m.done ? 1 : 0, s.createdAt || now());
        });

        for (const l of (s.lessons || [])) {
          run(`INSERT INTO lessons (id, subject_id, module_id, n, title, topic, type, content, sources, next, done, model, exported_to, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            l.id || genId(6), s.id, l.moduleId || null, l.n || 1, String(l.title || '').slice(0, 160),
            l.topic || '', l.type || 'standard', l.content || '',
            JSON.stringify(l.sources || []), JSON.stringify(l.next || []),
            l.done ? 1 : 0, l.model || '', l.exportedTo || '', l.createdAt || now());
        }
      });
      console.log(`[learn] migrated "${s.name}" (${(s.roadmap?.modules || []).length} modules, ${(s.lessons || []).length} lessons) into SQLite`);
    }
    // Retire the file so the import can't run twice, but keep the bytes for rollback.
    try { fs.renameSync(path.join(JSON_DIR, f), path.join(JSON_DIR, f + '.migrated')); } catch { }
  }
}

// ---------- mastery: the adaptive spine ----------

/** Record one graded answer against a topic. Streak resets on a miss — that's what
 *  makes a topic "recently failed" rather than "failed once six weeks ago". */
export function recordMastery(subjectId, topic, correct) {
  topic = String(topic || '').trim().toLowerCase().slice(0, 120);
  if (!topic) return;
  const row = one('SELECT * FROM mastery WHERE subject_id = ? AND topic = ?', subjectId, topic);
  if (!row) {
    run(`INSERT INTO mastery (id, subject_id, topic, seen, correct, streak, last_seen) VALUES (?, ?, ?, 1, ?, ?, ?)`,
      genId(6), subjectId, topic, correct ? 1 : 0, correct ? 1 : 0, now());
    return;
  }
  run(`UPDATE mastery SET seen = seen + 1, correct = correct + ?, streak = ?, last_seen = ? WHERE id = ?`,
    correct ? 1 : 0, correct ? row.streak + 1 : 0, now(), row.id);
}

/** Topics the student is worst at — the input to review lessons and exam mixes.
 *  Ordered by accuracy, then by how often they've been seen (a topic missed twice
 *  outranks one missed once). Only topics actually assessed appear. */
export function weakTopics(subjectId, limit = 8) {
  return all(
    `SELECT topic, seen, correct, streak,
            CAST(correct AS REAL) / seen AS ratio
       FROM mastery
      WHERE subject_id = ? AND seen > 0
      ORDER BY ratio ASC, seen DESC
      LIMIT ?`, subjectId, limit)
    .map(r => ({ ...r, ratio: Math.round(r.ratio * 100) / 100 }));
}

/** Mastery summary for the subject header / feedback report. */
export function masteryStats(subjectId) {
  const r = one(
    `SELECT COUNT(*) AS topics, COALESCE(SUM(seen),0) AS seen, COALESCE(SUM(correct),0) AS correct
       FROM mastery WHERE subject_id = ?`, subjectId) || {};
  const pct = r.seen ? Math.round((r.correct / r.seen) * 100) : null;
  return { topics: r.topics || 0, seen: r.seen || 0, correct: r.correct || 0, pct };
}

export { DB_FILE };
