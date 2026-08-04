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

-- ---------------------------------------------------------------- items
-- Three tables implement "what does a thing cost, and where is it cheapest":
--
--   finance_item          the canonical catalogue — one row per real-world thing,
--                         deliberately BRAND-FREE ("Milk", not "Yamada Milk")
--   finance_item_alias    every raw string ever printed on a receipt, pointing at
--                         a canonical item. This is the point of truth: a row with
--                         confirmed=1 was settled by the user and the model is
--                         never allowed to overrule it.
--   finance_purchase      one line item bought = one price observation
--
-- Splitting alias from item is what makes the learning loop work. The model only
-- ever proposes a mapping for a string nobody has classified yet; once that
-- mapping is confirmed it becomes a lookup, costs nothing, and never drifts.

CREATE TABLE IF NOT EXISTS finance_item (
  id           TEXT PRIMARY KEY,
  name_en      TEXT NOT NULL,                     -- "Milk" — generic, no brand
  name_ja      TEXT NOT NULL DEFAULT '',          -- "牛乳"
  category     TEXT NOT NULL DEFAULT 'Groceries',
  subcategory  TEXT NOT NULL DEFAULT '',          -- "Dairy", "Produce", …
  unit         TEXT NOT NULL DEFAULT 'each',      -- ml | g | each — comparison base
  typical_size REAL NOT NULL DEFAULT 0,           -- e.g. 1000 when unit='ml'
  note         TEXT NOT NULL DEFAULT '',
  pinned       INTEGER NOT NULL DEFAULT 0,        -- on the watchlist
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_item_cat ON finance_item(deleted, category);

CREATE TABLE IF NOT EXISTS finance_item_alias (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  raw        TEXT NOT NULL,                       -- exactly as printed
  norm       TEXT NOT NULL,                       -- NFKC-folded matching key
  source     TEXT NOT NULL DEFAULT 'ai',          -- ai | auto | manual | ocr
  confirmed  INTEGER NOT NULL DEFAULT 0,          -- 1 = user-settled, authoritative
  hits       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(norm)
);
CREATE INDEX IF NOT EXISTS idx_alias_item ON finance_item_alias(item_id);

CREATE TABLE IF NOT EXISTS finance_purchase (
  id              TEXT PRIMARY KEY,
  item_id         TEXT NOT NULL DEFAULT '',       -- '' while unresolved
  txn_id          TEXT NOT NULL DEFAULT '',
  receipt_id      TEXT NOT NULL DEFAULT '',
  date            TEXT NOT NULL,
  merchant        TEXT NOT NULL DEFAULT '',
  raw_name        TEXT NOT NULL,
  qty             REAL NOT NULL DEFAULT 1,
  line_total      REAL NOT NULL DEFAULT 0,        -- as printed, in the currency column
  currency        TEXT NOT NULL DEFAULT 'JPY',
  line_total_base REAL NOT NULL DEFAULT 0,
  size            REAL NOT NULL DEFAULT 0,        -- parsed pack size, in the unit column
  unit            TEXT NOT NULL DEFAULT '',       -- ml | g | each
  unit_price_base REAL NOT NULL DEFAULT 0,        -- base currency per 1 unit
  each_price_base REAL NOT NULL DEFAULT 0,        -- base currency per item bought
  source          TEXT NOT NULL DEFAULT 'ocr',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_item ON finance_purchase(item_id, date);
CREATE INDEX IF NOT EXISTS idx_purchase_merchant ON finance_purchase(merchant);
CREATE INDEX IF NOT EXISTS idx_purchase_date ON finance_purchase(date);

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

-- What the user corrected after a scan, so the next scan does better.
--
-- A vision model reading a crumpled thermal receipt hallucinates: it invents a line
-- that isn't printed, or prices one absurdly. No prompt fixes that reliably, but the
-- SAME mistake at the SAME shop is very fixable — the user's correction is the point of
-- truth, and applying it again is deterministic, no model involved. The hits column is
-- what separates "a one-off misread" from "this shop always does this": a fix is only
-- trusted enough to auto-apply once the user has made it more than once.
CREATE TABLE IF NOT EXISTS finance_receipt_fix (
  id          TEXT PRIMARY KEY,
  merchant    TEXT NOT NULL DEFAULT '',           -- normalized merchant key ('' = everywhere)
  kind        TEXT NOT NULL,                      -- drop | rename | amount
  raw         TEXT NOT NULL DEFAULT '',           -- normalized printed line the fix keys on
  raw_display TEXT NOT NULL DEFAULT '',           -- as printed, for showing the user
  ai_value    TEXT NOT NULL DEFAULT '',           -- what the model said
  user_value  TEXT NOT NULL DEFAULT '',           -- what the user settled on
  hits        INTEGER NOT NULL DEFAULT 1,         -- times the user has made this same correction
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(merchant, kind, raw)
);
CREATE INDEX IF NOT EXISTS idx_fix_merchant ON finance_receipt_fix(merchant, hits DESC);
`;

/** Open (once) and migrate. Safe to call on every access. */
export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // `db` is already assigned, so ensureColumn's getDb() call returns immediately.
  // parsed_ai keeps the model's ORIGINAL extraction after the user edits a receipt —
  // the diff between the two is what the correction loop learns from.
  ensureColumn('finance_receipt', 'parsed_ai', `TEXT NOT NULL DEFAULT ''`);
  // What the same receipt looks like from the outside: date + total + line items, hashed
  // to one string. Photographing a receipt twice (once on the phone, once at the desk)
  // produces two scans of one purchase, and posting both silently doubles a day's spend.
  // A column rather than a computed check because the lookup happens on every apply.
  ensureColumn('finance_receipt', 'fingerprint', `TEXT NOT NULL DEFAULT ''`);
  // The scan's own opinion of how well it read the paper, 0-100 (-1 = never scored).
  // Denormalised out of `parsed` so "is this getting better over time?" is one query
  // rather than a JSON parse per row.
  ensureColumn('finance_receipt', 'confidence', 'REAL NOT NULL DEFAULT -1');
  // Which correction this scan has already taught the fix table, as a hash of
  // (model's reading → user's reading). `hits` on finance_receipt_fix is the trust gate that
  // decides when a fix starts replaying with no model involved, and it is documented as
  // "times the USER has made this correction" — but apply() ran the diff every time, and
  // revertReceipt() deliberately keeps parsed_ai so the next apply can still learn. So
  // Undo & edit → Log re-learned a byte-identical diff and incremented every fix again:
  // one correction plus one undo promoted a one-off misread to a standing rule. Storing
  // what was learned is the only thing that cycle cannot change.
  ensureColumn('finance_receipt', 'learned_sig', `TEXT NOT NULL DEFAULT ''`);
  // Which kind of document this scan holds — 'receipt' for everything written before the
  // pipeline learned to read anything else. See docTypes in receipts.js.
  ensureColumn('finance_receipt', 'doc_type', `TEXT NOT NULL DEFAULT 'receipt'`);
  // What auto-orientation did, so the review UI can say so and offer the other way round.
  // Was written onto the in-memory record and read back off the SQL row, which has no such
  // column — so the banner and its one-click undo could never render after a reload.
  ensureColumn('finance_receipt', 'oriented', `TEXT NOT NULL DEFAULT ''`);
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_receipt_fp ON finance_receipt(fingerprint, status)`);
  } catch (e) { console.error('[finance] receipt fingerprint index:', e.message); }
  // Work behind the money: 3.5 hours, 12 pieces. Lets the Income tab answer "what am I
  // actually earning per hour", which is the question freelance income exists to answer.
  ensureColumn('finance_txn', 'units', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('finance_txn', 'unit', `TEXT NOT NULL DEFAULT ''`);
  backupOnBoot();
  // One-time data repair for databases written before deleteTxn learned to forget
  // prices: a purchase whose transaction is gone is an invisible lie in the price
  // history. Cheap (one indexed DELETE) and a no-op once clean.
  try {
    const orphans = db.prepare(`DELETE FROM finance_purchase
      WHERE txn_id <> '' AND NOT EXISTS (
        SELECT 1 FROM finance_txn t WHERE t.id = finance_purchase.txn_id AND t.deleted = 0)`).run().changes;
    if (orphans) console.log(`[finance] cleared ${orphans} price observation(s) left behind by deleted transactions`);
  } catch (e) { console.error('[finance] orphan sweep failed:', e.message); }
  return db;
}

/** Add a column if it isn't there yet — node:sqlite has no migration framework
 *  and CREATE TABLE IF NOT EXISTS silently skips an existing table. */
export function ensureColumn(table, col, decl) {
  const cols = getDb().prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  resetStatements();                     // ALTER TABLE can invalidate prepared statements
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

// Statements are prepared once and reused. The queries here are a fixed set of string
// literals, so the cache is bounded by the code — and applying one receipt runs a
// handful of them per line item, each of which used to recompile its SQL from scratch.
const stmts = new Map();
function stmt(sql) {
  let s = stmts.get(sql);
  if (!s) { s = getDb().prepare(sql); stmts.set(sql, s); }
  return s;
}
/** Drop cached statements — required after any DDL, which can invalidate them. */
export const resetStatements = () => stmts.clear();

// `undefined` → `null`, for the same reason as learndb: node:sqlite refuses to bind
// undefined and raises "Provided value cannot be bound to SQLite parameter 1", so a tool
// called without an optional id answered with a driver message instead of "not found".
const bind = (args) => args.map(a => (a === undefined ? null : a));

export const all = (sql, ...args) => stmt(sql).all(...bind(args));
export const one = (sql, ...args) => stmt(sql).get(...bind(args)) ?? null;
export const run = (sql, ...args) => stmt(sql).run(...bind(args));

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; }
  catch (e) { try { d.exec('ROLLBACK'); } catch { } throw e; }
}

export const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
