// Storage for the Finances app: one ledger for income and expenses, plus the
// small satellite tables the UI needs (quick-log presets, monthly goals,
// per-category budgets, recurring rules, OCR'd receipts).
//
// SQLite rather than the usual JSON-per-domain because every question this app
// asks is relational and range-scoped — "spend by category for a date window",
// "month-over-month net", "which budgets are over" — and the ledger grows
// without bound. learndb.js established the node:sqlite idiom in this repo;
// this file follows it exactly (lazy getDb, WAL, IF NOT EXISTS schema,
// ensureColumn migrations, dated boot backups).
//
// One deliberate departure from the PyQt app this replaces: every row stores
// `amount_base` alongside `amount`, converted at write time. The old
// finance_store.get_summary() summed raw amounts across currencies, so a
// ¥1,435 lunch and a $1,435 laptop added up to 2,870 of nothing. Aggregates
// here only ever touch amount_base.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA } from './config.js';

const DB_FILE = path.join(DATA, 'finance.db');
let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS finance_txn (
  id           TEXT PRIMARY KEY,
  date         TEXT NOT NULL,                     -- YYYY-MM-DD, local calendar day
  kind         TEXT NOT NULL,                     -- 'income' | 'expense'
  amount       REAL NOT NULL,                     -- always positive; kind carries the sign
  currency     TEXT NOT NULL DEFAULT 'JPY',
  amount_base  REAL NOT NULL,                     -- amount converted to the base currency
  fx_rate      REAL NOT NULL DEFAULT 1,           -- rate used, kept for audit
  category     TEXT NOT NULL DEFAULT 'Uncategorized',
  merchant     TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  is_main_job  INTEGER NOT NULL DEFAULT 0,        -- income only: excluded from side-income goals
  source       TEXT NOT NULL DEFAULT 'manual',    -- manual | preset | recurring | ocr | import | ai
  preset_id    TEXT NOT NULL DEFAULT '',
  recurring_id TEXT NOT NULL DEFAULT '',
  receipt_id   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0         -- tombstone, never hard-deleted
);
CREATE INDEX IF NOT EXISTS idx_txn_date     ON finance_txn(deleted, date);
CREATE INDEX IF NOT EXISTS idx_txn_kind     ON finance_txn(deleted, kind, date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON finance_txn(deleted, category, date);
CREATE INDEX IF NOT EXISTS idx_txn_merchant ON finance_txn(deleted, merchant);

CREATE TABLE IF NOT EXISTS finance_preset (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'JPY',
  kind        TEXT NOT NULL DEFAULT 'income',
  category    TEXT NOT NULL DEFAULT 'Side Job',
  pay_unit    TEXT NOT NULL DEFAULT 'flat',       -- flat | hour | minute
  is_main_job INTEGER NOT NULL DEFAULT 0,
  uses        INTEGER NOT NULL DEFAULT 0,         -- drives most-used ordering
  last_used   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS finance_goal (
  month      TEXT PRIMARY KEY,                    -- YYYY-MM
  min_goal   REAL NOT NULL DEFAULT 0,
  major_goal REAL NOT NULL DEFAULT 0,
  include_main_job INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_budget (
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL,
  amount     REAL NOT NULL,                       -- per-month cap in base currency
  month      TEXT NOT NULL DEFAULT '',            -- '' = the standing default for every month
  updated_at TEXT NOT NULL,
  UNIQUE(category, month)
);

CREATE TABLE IF NOT EXISTS finance_recurring (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'expense',
  amount     REAL NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'JPY',
  category   TEXT NOT NULL DEFAULT 'Uncategorized',
  merchant   TEXT NOT NULL DEFAULT '',
  cadence    TEXT NOT NULL DEFAULT 'monthly',     -- monthly | weekly | yearly
  day        INTEGER NOT NULL DEFAULT 1,          -- day-of-month, or 0-6 for weekly
  active     INTEGER NOT NULL DEFAULT 1,
  last_run   TEXT NOT NULL DEFAULT '',            -- YYYY-MM-DD of the last posted occurrence
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
);

-- One saved write-up per month. The point of a finance app is what you can tell
-- about a month a year later, and raw rows do not survive that trip — "why was
-- June expensive?" is unanswerable from a table of 90 line items. The recap is
-- written once (by the local model, from the same insights payload the UI shows)
-- and then frozen, so re-reading it later gives the same account.
CREATE TABLE IF NOT EXISTS finance_recap (
  month      TEXT PRIMARY KEY,                    -- YYYY-MM
  summary    TEXT NOT NULL DEFAULT '',            -- the model's narrative
  headline   TEXT NOT NULL DEFAULT '',            -- one-line gist for the month card
  facts      TEXT NOT NULL DEFAULT '',            -- JSON snapshot of the numbers it saw
  note       TEXT NOT NULL DEFAULT '',            -- the user's own annotation, never overwritten
  model      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_receipt (
  id         TEXT PRIMARY KEY,
  upload_id  TEXT NOT NULL DEFAULT '',            -- uploads.js id of the source image
  status     TEXT NOT NULL DEFAULT 'pending',     -- pending | parsed | failed | applied
  model      TEXT NOT NULL DEFAULT '',
  raw        TEXT NOT NULL DEFAULT '',            -- the model's unparsed reply, for debugging
  parsed     TEXT NOT NULL DEFAULT '',            -- JSON: merchant/date/items/total/...
  error      TEXT NOT NULL DEFAULT '',
  txn_ids    TEXT NOT NULL DEFAULT '[]',          -- JSON array of rows created from it
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Open (once) and migrate. Safe to call on every access. */
export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  backupOnBoot();
  return db;
}

/** Add a column if it isn't there yet — node:sqlite has no migration framework
 *  and CREATE TABLE IF NOT EXISTS silently skips an existing table. */
export function ensureColumn(table, col, decl) {
  const cols = getDb().prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  console.log(`[finance] schema: added ${table}.${col}`);
}

/** One dated backup per boot-day, keeping the last 7 — same insurance learndb.js
 *  carries, and this DB is even less reproducible: it is hand-entered money. */
const KEEP_BACKUPS = 7;
function backupOnBoot() {
  try {
    const dest = `${DB_FILE}.bak-${new Date().toISOString().slice(0, 10)}`;
    if (fs.existsSync(dest)) return;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(DB_FILE, dest);
    const old = fs.readdirSync(path.dirname(DB_FILE))
      .filter(f => f.startsWith(path.basename(DB_FILE) + '.bak-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) {
      fs.unlinkSync(path.join(path.dirname(DB_FILE), f));
    }
    console.log(`[finance] backup written: ${path.basename(dest)}`);
  } catch (e) { console.error('[finance] backup failed:', e.message); }
}

// ---------- tiny query helpers (mirrors learndb.js) ----------

export const all = (sql, ...args) => getDb().prepare(sql).all(...args);
export const one = (sql, ...args) => getDb().prepare(sql).get(...args) ?? null;
export const run = (sql, ...args) => getDb().prepare(sql).run(...args);

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; }
  catch (e) { try { d.exec('ROLLBACK'); } catch { } throw e; }
}

export const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
