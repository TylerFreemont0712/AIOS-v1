// Finances — earnings, expenses, budgets, goals and charts in one app.
//
// Replaces the Earnings/Expenses/Charts panels of the older PyQt LocalSync app.
// Pure functions over financedb.js; no express here (index.js owns the routes).
//
// Improvements over the app this replaces, all deliberate:
//  * Currency is normalised at write time into `amount_base`, so summaries can
//    never add yen to dollars (the old get_summary did exactly that).
//  * Category rollups keep income and expense apart instead of summing both
//    into one bucket.
//  * Listing has a stable sort (date, then created_at) — the old query ordered
//    by date alone, so same-day rows shuffled between refreshes.
//  * Recurring/monthly posting is genuinely idempotent, keyed on the recurring
//    rule + the period. The old "[Monthly]" check only printed a warning and
//    happily wrote duplicates.
//  * Presets rank by recent usage rather than case-sensitive binary name order,
//    which used to sort "Zebra" above "apple".

import { loadConfig } from './config.js';
import { id as genId, now } from './util.js';
import { all, one, run, tx, parseJSON } from './financedb.js';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const missing = (msg) => Object.assign(new Error(msg), { status: 404 });

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RX = /^\d{4}-\d{2}$/;

export const KINDS = ['income', 'expense'];
export const PAY_UNITS = ['flat', 'hour', 'minute'];
export const CADENCES = ['monthly', 'weekly', 'yearly'];
export const SOURCES = ['manual', 'preset', 'recurring', 'ocr', 'import', 'ai'];

export const INCOME_CATEGORIES = ['Main Job', 'Side Job', 'Freelance', 'Investment', 'Gift', 'Refund', 'Other Income'];
export const EXPENSE_CATEGORIES = [
  'Rent / Housing', 'Utilities', 'Groceries', 'Food & Drink', 'Transport',
  'Software / Tools', 'Hardware', 'Office Supplies', 'Health', 'Education',
  'Entertainment', 'Travel', 'Subscriptions', 'Taxes', 'Fees & Banking',
  'Gifts', 'Uncategorized',
];

// ---------- config ----------

// Approximate FX, quoted in yen per 1 unit, so the app is usable before anyone
// touches Settings. These are starting values, not a live feed: every row also
// stores the rate it was written with (`fx_rate`), so correcting the table here
// never rewrites history. Override any of them via config `finance.rates`.
const JPY_PER = {
  JPY: 1, USD: 150, EUR: 165, GBP: 192, AUD: 100,
  CAD: 110, CHF: 175, CNY: 21, KRW: 0.11, TWD: 4.7,
  SGD: 112, HKD: 19, THB: 4.3, INR: 1.8, NZD: 92,
};

/** The finance slice of data/config.json, with defaults applied. */
export function settings() {
  const f = loadConfig().finance || {};
  const base = String(f.baseCurrency || 'JPY').toUpperCase().slice(0, 3);
  // Re-denominate the built-in table into the chosen base, then let explicit
  // user rates win outright.
  const perBase = JPY_PER[base];
  const rates = {};
  if (perBase) for (const [code, jpy] of Object.entries(JPY_PER)) rates[code] = jpy / perBase;
  for (const [code, v] of Object.entries(f.rates || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) rates[String(code).toUpperCase().slice(0, 3)] = n;
  }
  rates[base] = 1;                                     // the base is always 1:1 with itself
  return {
    baseCurrency: base,
    // rate[C] = how many units of the base currency one unit of C is worth
    rates,
    incomeCategories: Array.isArray(f.incomeCategories) && f.incomeCategories.length
      ? f.incomeCategories : INCOME_CATEGORIES,
    expenseCategories: Array.isArray(f.expenseCategories) && f.expenseCategories.length
      ? f.expenseCategories : EXPENSE_CATEGORIES,
    weekStart: f.weekStart === 'sunday' ? 'sunday' : 'monday',
  };
}

/** Rate for `code` → base currency. Unknown currencies are refused rather than
 *  silently treated as 1:1, which would corrupt every downstream total. */
function rateFor(code, cfg = settings()) {
  const c = String(code || cfg.baseCurrency).toUpperCase();
  const r = Number(cfg.rates[c]);
  if (!Number.isFinite(r) || r <= 0) {
    throw bad(`no exchange rate configured for ${c} — set finance.rates.${c} in Settings (units of ${cfg.baseCurrency} per 1 ${c})`);
  }
  return r;
}

export function currencies() {
  const cfg = settings();
  return { base: cfg.baseCurrency, rates: cfg.rates, codes: Object.keys(cfg.rates).sort() };
}

// ---------- date helpers ----------

const isDate = (s) => DATE_RX.test(String(s || ''));
const today = () => new Date().toISOString().slice(0, 10);

function reqDate(s, what = 'date') {
  const v = String(s || '').slice(0, 10);
  if (!isDate(v)) throw bad(`${what} must be YYYY-MM-DD`);
  return v;
}

export function monthBounds(month) {
  if (!MONTH_RX.test(String(month || ''))) throw bad('month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}

const monthOf = (date) => String(date).slice(0, 7);

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Resolve the range shorthand the UI and the agent tools both speak.
 *  `start`/`end` are accepted as aliases of `from`/`to` so that passing a
 *  monthBounds() result straight through does the obvious thing instead of
 *  silently falling back to the current month. */
export function resolveRange(q = {}) {
  const { month, range } = q;
  const from = q.from ?? q.start;
  const to = q.to ?? q.end;
  if (month) return monthBounds(month);
  if (from || to) {
    return { start: from ? reqDate(from, 'from') : '0000-01-01', end: to ? reqDate(to, 'to') : '9999-12-31' };
  }
  const t = today();
  const preset = String(range || 'this-month');
  if (preset === 'all') return { start: '0000-01-01', end: '9999-12-31' };
  if (preset === 'this-month') return monthBounds(monthOf(t));
  if (preset === 'last-month') return monthBounds(addMonths(monthOf(t), -1));
  if (preset === 'this-year') return { start: `${t.slice(0, 4)}-01-01`, end: `${t.slice(0, 4)}-12-31` };
  const days = /^(\d+)d$/.exec(preset);
  if (days) {
    const d = new Date(`${t}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (Number(days[1]) - 1));
    return { start: d.toISOString().slice(0, 10), end: t };
  }
  return monthBounds(monthOf(t));
}

// ---------- transactions ----------

const num = (v, what) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${what} must be a number`);
  return n;
};

const str = (v, prev, max) => String(v ?? prev ?? '').trim().slice(0, max);

function sanitizeTxn(input, prev = {}) {
  const cfg = settings();
  const e = input || {};
  const kind = KINDS.includes(e.kind) ? e.kind : (prev.kind || 'expense');

  const rawAmount = e.amount ?? prev.amount;
  if (rawAmount === undefined || rawAmount === null || rawAmount === '') throw bad('amount is required');
  const amount = Math.abs(num(rawAmount, 'amount'));
  if (amount === 0) throw bad('amount must not be zero');
  if (amount > 1e12) throw bad('amount is implausibly large');

  const currency = str(e.currency, prev.currency || cfg.baseCurrency, 3).toUpperCase();
  const fx = rateFor(currency, cfg);

  const fallbackCategory = kind === 'income' ? 'Side Job' : 'Uncategorized';
  const category = str(e.category, prev.category || fallbackCategory, 60) || fallbackCategory;
  const source = SOURCES.includes(e.source) ? e.source : (prev.source || 'manual');

  return {
    id: prev.id || genId(8),
    date: e.date === undefined && prev.date ? prev.date : reqDate(e.date || prev.date || today()),
    kind,
    amount,
    currency,
    amount_base: Math.round(amount * fx * 100) / 100,
    fx_rate: fx,
    category,
    merchant: str(e.merchant, prev.merchant, 120),
    note: str(e.note, prev.note, 500),
    is_main_job: (e.isMainJob ?? prev.is_main_job ?? (category === 'Main Job' ? 1 : 0)) ? 1 : 0,
    source,
    preset_id: str(e.presetId, prev.preset_id, 32),
    recurring_id: str(e.recurringId, prev.recurring_id, 32),
    receipt_id: str(e.receiptId, prev.receipt_id, 32),
    created_at: prev.created_at || now(),
    updated_at: now(),
  };
}

const outTxn = (r) => r && ({
  id: r.id, date: r.date, kind: r.kind, amount: r.amount, currency: r.currency,
  amountBase: r.amount_base, fxRate: r.fx_rate, category: r.category,
  merchant: r.merchant, note: r.note, isMainJob: !!r.is_main_job, source: r.source,
  presetId: r.preset_id, recurringId: r.recurring_id, receiptId: r.receipt_id,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const INSERT_TXN = `
INSERT INTO finance_txn (id, date, kind, amount, currency, amount_base, fx_rate, category,
  merchant, note, is_main_job, source, preset_id, recurring_id, receipt_id, created_at, updated_at, deleted)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
ON CONFLICT(id) DO UPDATE SET
  date=excluded.date, kind=excluded.kind, amount=excluded.amount, currency=excluded.currency,
  amount_base=excluded.amount_base, fx_rate=excluded.fx_rate, category=excluded.category,
  merchant=excluded.merchant, note=excluded.note, is_main_job=excluded.is_main_job,
  source=excluded.source, preset_id=excluded.preset_id, recurring_id=excluded.recurring_id,
  receipt_id=excluded.receipt_id, updated_at=excluded.updated_at, deleted=0`;

function writeTxn(t) {
  run(INSERT_TXN, t.id, t.date, t.kind, t.amount, t.currency, t.amount_base, t.fx_rate,
    t.category, t.merchant, t.note, t.is_main_job, t.source, t.preset_id,
    t.recurring_id, t.receipt_id, t.created_at, t.updated_at);
  return outTxn(t);
}

export function addTxn(input) { return writeTxn(sanitizeTxn(input)); }

export function updateTxn(id, patch) {
  const prev = one('SELECT * FROM finance_txn WHERE id = ? AND deleted = 0', String(id || ''));
  if (!prev) throw missing('transaction not found');
  return writeTxn(sanitizeTxn(patch || {}, prev));
}

export function deleteTxn(id) {
  const r = run('UPDATE finance_txn SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0', now(), String(id || ''));
  if (!r.changes) throw missing('transaction not found');
}

/** Bulk delete — one statement, one transaction. Returns how many rows changed. */
export function deleteTxns(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!list.length) throw bad('ids must be a non-empty array');
  return tx(() => {
    const stamp = now();
    let n = 0;
    for (const id of list) {
      n += run('UPDATE finance_txn SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0', stamp, id).changes;
    }
    return { deleted: n };
  });
}

export function getTxn(id) {
  const r = one('SELECT * FROM finance_txn WHERE id = ? AND deleted = 0', String(id || ''));
  if (!r) throw missing('transaction not found');
  return outTxn(r);
}

/** Filtered ledger. Every filter is optional; the sort is stable. */
export function listTxns(q = {}) {
  const { start, end } = resolveRange(q);
  const where = ['deleted = 0', 'date >= ?', 'date <= ?'];
  const args = [start, end];
  if (q.kind && KINDS.includes(q.kind)) { where.push('kind = ?'); args.push(q.kind); }
  if (q.category) { where.push('category = ?'); args.push(String(q.category)); }
  if (q.source) { where.push('source = ?'); args.push(String(q.source)); }
  if (q.search) {
    where.push('(merchant LIKE ? COLLATE NOCASE OR note LIKE ? COLLATE NOCASE OR category LIKE ? COLLATE NOCASE)');
    const like = `%${String(q.search).slice(0, 60)}%`;
    args.push(like, like, like);
  }
  const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 5000);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const rows = all(
    `SELECT * FROM finance_txn WHERE ${where.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`,
    ...args, limit, offset);
  const total = one(`SELECT COUNT(*) AS n FROM finance_txn WHERE ${where.join(' AND ')}`, ...args)?.n || 0;
  return { range: { start, end }, total, limit, offset, items: rows.map(outTxn) };
}

// ---------- aggregation ----------

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Headline numbers for a period, all in the base currency. */
export function summary(q = {}) {
  const { start, end } = resolveRange(q);
  const r = one(`
    SELECT
      COALESCE(SUM(CASE WHEN kind='income'  THEN amount_base END), 0) AS earned,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount_base END), 0) AS spent,
      COALESCE(SUM(CASE WHEN kind='income' AND is_main_job=0 THEN amount_base END), 0) AS side_earned,
      COUNT(*) AS count
    FROM finance_txn WHERE deleted = 0 AND date >= ? AND date <= ?`, start, end);
  const earned = round2(r.earned), spent = round2(r.spent);
  const days = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1);
  return {
    range: { start, end }, currency: settings().baseCurrency,
    earned, spent, net: round2(earned - spent), sideEarned: round2(r.side_earned),
    count: r.count, days,
    avgSpendPerDay: round2(spent / days),
    savingsRate: earned > 0 ? Math.round((earned - spent) / earned * 100) : null,
  };
}

/** Category rollup. Income and expense are kept apart — the old app summed them
 *  into one bucket, which made "Main Job" look like the biggest expense. */
export function byCategory(q = {}) {
  const { start, end } = resolveRange(q);
  const kind = KINDS.includes(q.kind) ? q.kind : 'expense';
  const rows = all(`
    SELECT category, SUM(amount_base) AS total, COUNT(*) AS count
    FROM finance_txn WHERE deleted = 0 AND kind = ? AND date >= ? AND date <= ?
    GROUP BY category ORDER BY total DESC`, kind, start, end);
  const total = rows.reduce((s, r) => s + r.total, 0);
  return {
    range: { start, end }, kind, currency: settings().baseCurrency, total: round2(total),
    items: rows.map(r => ({
      category: r.category, total: round2(r.total), count: r.count,
      pct: total > 0 ? Math.round(r.total / total * 1000) / 10 : 0,
    })),
  };
}

/** Per-month income/expense/net series for the trend chart. */
export function monthlySeries({ months = 12, end } = {}) {
  const n = Math.min(Math.max(Number(months) || 12, 1), 60);
  const endMonth = MONTH_RX.test(String(end || '')) ? end : monthOf(today());
  const startMonth = addMonths(endMonth, -(n - 1));
  const { start } = monthBounds(startMonth);
  const { end: last } = monthBounds(endMonth);
  const rows = all(`
    SELECT substr(date, 1, 7) AS month,
      COALESCE(SUM(CASE WHEN kind='income'  THEN amount_base END), 0) AS earned,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount_base END), 0) AS spent
    FROM finance_txn WHERE deleted = 0 AND date >= ? AND date <= ?
    GROUP BY month`, start, last);
  const found = new Map(rows.map(r => [r.month, r]));
  const items = [];
  for (let i = 0; i < n; i++) {
    const m = addMonths(startMonth, i);
    const r = found.get(m);
    const earned = round2(r?.earned || 0), spent = round2(r?.spent || 0);
    items.push({ month: m, earned, spent, net: round2(earned - spent) });
  }
  return { currency: settings().baseCurrency, items };
}

/** Daily totals inside a period — the cashflow sparkline / calendar heat. */
export function dailySeries(q = {}) {
  const { start, end } = resolveRange(q);
  const rows = all(`
    SELECT date,
      COALESCE(SUM(CASE WHEN kind='income'  THEN amount_base END), 0) AS earned,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount_base END), 0) AS spent
    FROM finance_txn WHERE deleted = 0 AND date >= ? AND date <= ?
    GROUP BY date ORDER BY date`, start, end);
  return {
    range: { start, end }, currency: settings().baseCurrency,
    items: rows.map(r => ({ date: r.date, earned: round2(r.earned), spent: round2(r.spent), net: round2(r.earned - r.spent) })),
  };
}

export function topMerchants(q = {}) {
  const { start, end } = resolveRange(q);
  const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 100);
  const rows = all(`
    SELECT merchant, SUM(amount_base) AS total, COUNT(*) AS count
    FROM finance_txn WHERE deleted = 0 AND kind = 'expense' AND merchant <> '' AND date >= ? AND date <= ?
    GROUP BY merchant COLLATE NOCASE ORDER BY total DESC LIMIT ?`, start, end, limit);
  return {
    range: { start, end }, currency: settings().baseCurrency,
    items: rows.map(r => ({ merchant: r.merchant, total: round2(r.total), count: r.count })),
  };
}

/** Merchant/category autocomplete, ranked by how often and how recently a value
 *  has been used — the "times seen" heuristic from the old expenses panel. */
export function suggest({ field = 'merchant', q = '', limit = 8 } = {}) {
  const col = field === 'category' ? 'category' : 'merchant';
  const like = `%${String(q || '').slice(0, 60)}%`;
  const n = Math.min(Math.max(Number(limit) || 8, 1), 50);
  const rows = all(`
    SELECT ${col} AS value, COUNT(*) AS seen, MAX(date) AS last_seen,
           AVG(amount) AS avg_amount, MAX(currency) AS currency,
           MAX(category) AS category
    FROM finance_txn
    WHERE deleted = 0 AND ${col} <> '' AND ${col} LIKE ? COLLATE NOCASE
    GROUP BY ${col} COLLATE NOCASE
    ORDER BY seen DESC, last_seen DESC LIMIT ?`, like, n);
  return rows.map(r => ({
    value: r.value, seen: r.seen, lastSeen: r.last_seen,
    avgAmount: round2(r.avg_amount), currency: r.currency, category: r.category,
  }));
}

// ---------- presets ----------

function sanitizePreset(input, prev = {}) {
  const cfg = settings();
  const e = input || {};
  const name = str(e.name, prev.name, 80);
  if (!name) throw bad('preset name is required');
  const amount = Math.abs(num(e.amount ?? prev.amount, 'amount'));
  if (!amount) throw bad('preset amount must not be zero');
  const currency = str(e.currency, prev.currency || cfg.baseCurrency, 3).toUpperCase();
  rateFor(currency, cfg);                                  // validate early
  const kind = KINDS.includes(e.kind) ? e.kind : (prev.kind || 'income');
  const category = str(e.category, prev.category || (kind === 'income' ? 'Side Job' : 'Uncategorized'), 60);
  return {
    id: prev.id || genId(8), name, amount, currency, kind, category,
    pay_unit: PAY_UNITS.includes(e.payUnit) ? e.payUnit : (prev.pay_unit || 'flat'),
    is_main_job: (e.isMainJob ?? prev.is_main_job ?? (category === 'Main Job' ? 1 : 0)) ? 1 : 0,
    uses: prev.uses || 0,
    last_used: prev.last_used || '',
    created_at: prev.created_at || now(),
    updated_at: now(),
  };
}

const outPreset = (r) => r && ({
  id: r.id, name: r.name, amount: r.amount, currency: r.currency, kind: r.kind,
  category: r.category, payUnit: r.pay_unit, isMainJob: !!r.is_main_job,
  uses: r.uses, lastUsed: r.last_used, updatedAt: r.updated_at,
});

/** Most-used first, then most-recent — not the old case-sensitive name sort. */
export function listPresets() {
  return all(`SELECT * FROM finance_preset WHERE deleted = 0
              ORDER BY uses DESC, last_used DESC, name COLLATE NOCASE`).map(outPreset);
}

function writePreset(p) {
  run(`INSERT INTO finance_preset (id, name, amount, currency, kind, category, pay_unit,
        is_main_job, uses, last_used, created_at, updated_at, deleted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, amount=excluded.amount,
        currency=excluded.currency, kind=excluded.kind, category=excluded.category,
        pay_unit=excluded.pay_unit, is_main_job=excluded.is_main_job,
        updated_at=excluded.updated_at, deleted=0`,
    p.id, p.name, p.amount, p.currency, p.kind, p.category, p.pay_unit,
    p.is_main_job, p.uses, p.last_used, p.created_at, p.updated_at);
  return outPreset(p);
}

export function addPreset(input) { return writePreset(sanitizePreset(input)); }

export function updatePreset(id, patch) {
  const prev = one('SELECT * FROM finance_preset WHERE id = ? AND deleted = 0', String(id || ''));
  if (!prev) throw missing('preset not found');
  return writePreset(sanitizePreset(patch || {}, prev));
}

export function deletePreset(id) {
  const r = run('UPDATE finance_preset SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0', now(), String(id || ''));
  if (!r.changes) throw missing('preset not found');
}

/** Log a preset as one or more transactions.
 *  flat  → `count` separate rows of the preset amount (so three coffees read as
 *          three rows, matching the old behaviour the user relies on)
 *  hour/minute → a single row of amount x units */
export function logPreset(id, { count = 1, units = 1, date, note } = {}) {
  const p = one('SELECT * FROM finance_preset WHERE id = ? AND deleted = 0', String(id || ''));
  if (!p) throw missing('preset not found');
  const on = date ? reqDate(date) : today();
  const unit = p.pay_unit;
  const rows = [];
  return tx(() => {
    if (unit === 'hour' || unit === 'minute') {
      const u = num(units, 'units');
      if (u <= 0) throw bad('units must be greater than zero');
      const label = unit === 'hour' ? `${u}h @ ${p.amount}/hr` : `${u}m @ ${p.amount}/min`;
      rows.push(addTxn({
        date: on, kind: p.kind, amount: p.amount * u, currency: p.currency,
        category: p.category, merchant: p.name, isMainJob: !!p.is_main_job,
        note: note || label, source: 'preset', presetId: p.id,
      }));
    } else {
      const n = Math.min(Math.max(Math.trunc(Number(count) || 1), 1), 100);
      for (let i = 0; i < n; i++) {
        rows.push(addTxn({
          date: on, kind: p.kind, amount: p.amount, currency: p.currency,
          category: p.category, merchant: p.name, isMainJob: !!p.is_main_job,
          note: note || '', source: 'preset', presetId: p.id,
        }));
      }
    }
    run('UPDATE finance_preset SET uses = uses + ?, last_used = ?, updated_at = ? WHERE id = ?',
      rows.length, on, now(), p.id);
    return { preset: outPreset(p), created: rows };
  });
}

// ---------- goals ----------

export function getGoal(month) {
  if (!MONTH_RX.test(String(month || ''))) throw bad('month must be YYYY-MM');
  const r = one('SELECT * FROM finance_goal WHERE month = ?', month);
  const g = r || { month, min_goal: 0, major_goal: 0, include_main_job: 0 };
  const { start, end } = monthBounds(month);
  const s = summary({ from: start, to: end });
  const progress = g.include_main_job ? s.earned : s.sideEarned;
  const pct = (target) => (target > 0 ? Math.min(999, Math.round(progress / target * 100)) : null);
  return {
    month, minGoal: g.min_goal, majorGoal: g.major_goal,
    includeMainJob: !!g.include_main_job, currency: settings().baseCurrency,
    progress, minPct: pct(g.min_goal), majorPct: pct(g.major_goal),
  };
}

export function setGoal(month, { minGoal, majorGoal, includeMainJob } = {}) {
  if (!MONTH_RX.test(String(month || ''))) throw bad('month must be YYYY-MM');
  const min = Math.max(0, num(minGoal ?? 0, 'minGoal'));
  const major = Math.max(0, num(majorGoal ?? 0, 'majorGoal'));
  run(`INSERT INTO finance_goal (month, min_goal, major_goal, include_main_job, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(month) DO UPDATE SET min_goal=excluded.min_goal,
         major_goal=excluded.major_goal, include_main_job=excluded.include_main_job,
         updated_at=excluded.updated_at`,
    month, min, major, includeMainJob ? 1 : 0, now());
  return getGoal(month);
}

// ---------- budgets ----------

export function listBudgets(month) {
  const m = MONTH_RX.test(String(month || '')) ? month : monthOf(today());
  const { start, end } = monthBounds(m);
  // A month-specific budget overrides the standing default for that category.
  const rows = all(`SELECT * FROM finance_budget WHERE month = '' OR month = ?`, m);
  const spent = new Map(all(`
    SELECT category, SUM(amount_base) AS total FROM finance_txn
    WHERE deleted = 0 AND kind = 'expense' AND date >= ? AND date <= ? GROUP BY category`, start, end)
    .map(r => [r.category, r.total]));
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.category);
    if (!cur || (r.month && !cur.month)) best.set(r.category, r);
  }
  const items = [...best.values()].map(r => {
    const used = round2(spent.get(r.category) || 0);
    return {
      id: r.id, category: r.category, amount: r.amount, month: r.month || null,
      spent: used, remaining: round2(r.amount - used),
      pct: r.amount > 0 ? Math.round(used / r.amount * 100) : 0,
      over: used > r.amount,
    };
  }).sort((a, b) => b.pct - a.pct);
  return { month: m, currency: settings().baseCurrency, items };
}

export function setBudget({ category, amount, month = '' } = {}) {
  const cat = str(category, '', 60);
  if (!cat) throw bad('category is required');
  const amt = Math.max(0, num(amount, 'amount'));
  const m = month ? (MONTH_RX.test(String(month)) ? month : (() => { throw bad('month must be YYYY-MM'); })()) : '';
  run(`INSERT INTO finance_budget (id, category, amount, month, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(category, month) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`,
    genId(8), cat, amt, m, now());
  return listBudgets(m || monthOf(today()));
}

export function deleteBudget(id) {
  const r = run('DELETE FROM finance_budget WHERE id = ?', String(id || ''));
  if (!r.changes) throw missing('budget not found');
}

// ---------- recurring ----------

function sanitizeRecurring(input, prev = {}) {
  const cfg = settings();
  const e = input || {};
  const name = str(e.name, prev.name, 80);
  if (!name) throw bad('name is required');
  const amount = Math.abs(num(e.amount ?? prev.amount, 'amount'));
  if (!amount) throw bad('amount must not be zero');
  const currency = str(e.currency, prev.currency || cfg.baseCurrency, 3).toUpperCase();
  rateFor(currency, cfg);
  const cadence = CADENCES.includes(e.cadence) ? e.cadence : (prev.cadence || 'monthly');
  let day = Math.trunc(Number(e.day ?? prev.day ?? 1));
  day = cadence === 'weekly' ? Math.min(Math.max(day, 0), 6) : Math.min(Math.max(day, 1), 31);
  return {
    id: prev.id || genId(8), name, amount, currency, cadence, day,
    kind: KINDS.includes(e.kind) ? e.kind : (prev.kind || 'expense'),
    category: str(e.category, prev.category || 'Uncategorized', 60),
    merchant: str(e.merchant, prev.merchant || name, 120),
    active: (e.active ?? prev.active ?? 1) ? 1 : 0,
    last_run: prev.last_run || '',
    created_at: prev.created_at || now(),
    updated_at: now(),
  };
}

const outRecurring = (r) => r && ({
  id: r.id, name: r.name, kind: r.kind, amount: r.amount, currency: r.currency,
  category: r.category, merchant: r.merchant, cadence: r.cadence, day: r.day,
  active: !!r.active, lastRun: r.last_run, updatedAt: r.updated_at,
});

export function listRecurring() {
  return all('SELECT * FROM finance_recurring WHERE deleted = 0 ORDER BY active DESC, name COLLATE NOCASE')
    .map(outRecurring);
}

function writeRecurring(r) {
  run(`INSERT INTO finance_recurring (id, name, kind, amount, currency, category, merchant,
        cadence, day, active, last_run, created_at, updated_at, deleted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind,
        amount=excluded.amount, currency=excluded.currency, category=excluded.category,
        merchant=excluded.merchant, cadence=excluded.cadence, day=excluded.day,
        active=excluded.active, updated_at=excluded.updated_at, deleted=0`,
    r.id, r.name, r.kind, r.amount, r.currency, r.category, r.merchant,
    r.cadence, r.day, r.active, r.last_run, r.created_at, r.updated_at);
  return outRecurring(r);
}

export function addRecurring(input) { return writeRecurring(sanitizeRecurring(input)); }

export function updateRecurring(id, patch) {
  const prev = one('SELECT * FROM finance_recurring WHERE id = ? AND deleted = 0', String(id || ''));
  if (!prev) throw missing('recurring rule not found');
  return writeRecurring(sanitizeRecurring(patch || {}, prev));
}

export function deleteRecurring(id) {
  const r = run('UPDATE finance_recurring SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0', now(), String(id || ''));
  if (!r.changes) throw missing('recurring rule not found');
}

/** Post every occurrence that is due on or before `upTo`.
 *  Genuinely idempotent: a row already carrying this rule's id for the same
 *  period is left alone, so running it twice a day (or twice a second) cannot
 *  duplicate. The old app only warned about "[Monthly]" rows and wrote anyway. */
export function runRecurring({ upTo, dryRun = false } = {}) {
  const limit = upTo ? reqDate(upTo, 'upTo') : today();
  const rules = all('SELECT * FROM finance_recurring WHERE deleted = 0 AND active = 1');
  const planned = [];
  for (const rule of rules) {
    for (const date of dueDates(rule, limit)) {
      const clash = one(
        `SELECT id FROM finance_txn WHERE deleted = 0 AND recurring_id = ? AND date = ?`,
        rule.id, date);
      if (clash) continue;
      planned.push({ rule, date });
    }
  }
  if (dryRun) {
    return { dryRun: true, pending: planned.map(p => ({ id: p.rule.id, name: p.rule.name, date: p.date, amount: p.rule.amount })) };
  }
  return tx(() => {
    const created = [];
    for (const { rule, date } of planned) {
      created.push(addTxn({
        date, kind: rule.kind, amount: rule.amount, currency: rule.currency,
        category: rule.category, merchant: rule.merchant, note: rule.name,
        source: 'recurring', recurringId: rule.id,
      }));
      run('UPDATE finance_recurring SET last_run = ?, updated_at = ? WHERE id = ?', date, now(), rule.id);
    }
    return { created: created.length, items: created };
  });
}

/** Occurrence dates for a rule, from just after its last run up to `limit`.
 *  Capped so a rule that has never run cannot backfill years of history. */
function dueDates(rule, limit) {
  const out = [];
  const start = rule.last_run || limit;             // never-run rules post only the current period
  const cursor = new Date(`${start}T00:00:00Z`);
  const end = new Date(`${limit}T00:00:00Z`);
  const MAX = 60;
  if (rule.cadence === 'weekly') {
    const d = new Date(cursor);
    while (out.length < MAX) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (d > end) break;
      if (d.getUTCDay() === rule.day) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }
  const step = rule.cadence === 'yearly' ? 12 : 1;
  let m = monthOf(start);
  const endMonth = monthOf(limit);
  if (!rule.last_run) {
    const d = occurrenceIn(m, rule.day);
    return d && d <= limit ? [d] : [];
  }
  while (out.length < MAX) {
    m = addMonths(m, step);
    if (m > endMonth) break;
    const d = occurrenceIn(m, rule.day);
    if (d && d <= limit && d > rule.last_run) out.push(d);
  }
  return out;
}

/** Clamp a day-of-month to a real date — a "31st" rule still fires in February. */
function occurrenceIn(month, day) {
  const { end } = monthBounds(month);
  const last = Number(end.slice(8));
  return `${month}-${String(Math.min(Math.max(day, 1), last)).padStart(2, '0')}`;
}

// ---------- insight payload for the AI layer ----------

/** A compact, model-friendly picture of a period: totals, category split,
 *  month-over-month movement, budget pressure and outliers. Written to be
 *  cheap enough to paste into a prompt (well under 1k tokens). */
export function insights(q = {}) {
  const { start, end } = resolveRange(q);
  const cur = summary({ from: start, to: end });
  const month = monthOf(start);
  const prevMonth = addMonths(month, -1);
  // monthBounds returns {start,end}; summary/resolveRange speak {from,to}. Passing
  // the wrong keys silently fell through to "this month", so every recap compared
  // the month against itself.
  const pb = monthBounds(prevMonth);
  const prev = summary({ from: pb.start, to: pb.end });
  const cats = byCategory({ from: start, to: end, kind: 'expense' });
  const prevCats = new Map(byCategory({ month: prevMonth, kind: 'expense' })
    .items.map(c => [c.category, c.total]));

  const movers = cats.items.map(c => {
    const was = prevCats.get(c.category) || 0;
    return { category: c.category, now: c.total, was: round2(was), delta: round2(c.total - was) };
  }).filter(m => Math.abs(m.delta) > 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5);

  // Outliers: expenses more than 3x the median for their own category.
  const rows = all(`SELECT category, amount_base FROM finance_txn
                    WHERE deleted = 0 AND kind='expense' AND date >= ? AND date <= ?`, start, end);
  const byCat = new Map();
  for (const r of rows) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r.amount_base);
  }
  const outliers = all(`SELECT * FROM finance_txn
      WHERE deleted = 0 AND kind='expense' AND date >= ? AND date <= ?
      ORDER BY amount_base DESC LIMIT 5`, start, end)
    .map(r => ({ date: r.date, merchant: r.merchant || r.category, category: r.category, amount: round2(r.amount_base) }))
    .filter(o => {
      const vals = (byCat.get(o.category) || []).slice().sort((a, b) => a - b);
      if (vals.length < 4) return false;
      const median = vals[Math.floor(vals.length / 2)];
      return median > 0 && o.amount > median * 3;
    });

  const budgets = listBudgets(month).items.filter(b => b.pct >= 80)
    .map(b => ({ category: b.category, spent: b.spent, budget: b.amount, pct: b.pct, over: b.over }));

  return {
    currency: cur.currency, range: { start, end },
    totals: { earned: cur.earned, spent: cur.spent, net: cur.net, savingsRate: cur.savingsRate, avgSpendPerDay: cur.avgSpendPerDay },
    previousMonth: { month: prevMonth, earned: prev.earned, spent: prev.spent, net: prev.net },
    changeVsPrev: { earned: round2(cur.earned - prev.earned), spent: round2(cur.spent - prev.spent), net: round2(cur.net - prev.net) },
    topCategories: cats.items.slice(0, 8),
    biggestMovers: movers,
    budgetPressure: budgets,
    unusuallyLarge: outliers,
    goal: (() => { try { return getGoal(month); } catch { return null; } })(),
  };
}

// ---------- looking back ----------

/** A whole year at a glance: every month with its totals, dominant category and
 *  saved recap headline, plus year aggregates. This is the view that answers
 *  "how did the year actually go" without scrolling a ledger. */
export function yearOverview(year) {
  const y = String(year || new Date().getFullYear()).slice(0, 4);
  if (!/^\d{4}$/.test(y)) throw bad('year must be YYYY');
  const start = `${y}-01-01`, end = `${y}-12-31`;

  const rows = all(`
    SELECT substr(date,1,7) AS month,
      COALESCE(SUM(CASE WHEN kind='income'  THEN amount_base END),0) AS earned,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount_base END),0) AS spent,
      COUNT(*) AS count
    FROM finance_txn WHERE deleted = 0 AND date >= ? AND date <= ?
    GROUP BY month`, start, end);
  const found = new Map(rows.map(r => [r.month, r]));

  // Dominant expense category per month, in one pass rather than 12 queries.
  const topRows = all(`
    SELECT month, category, total FROM (
      SELECT substr(date,1,7) AS month, category, SUM(amount_base) AS total,
             ROW_NUMBER() OVER (PARTITION BY substr(date,1,7) ORDER BY SUM(amount_base) DESC) AS rn
      FROM finance_txn WHERE deleted = 0 AND kind='expense' AND date >= ? AND date <= ?
      GROUP BY month, category
    ) WHERE rn = 1`, start, end);
  const tops = new Map(topRows.map(r => [r.month, r]));

  const recaps = new Map(all(
    `SELECT month, headline, note FROM finance_recap WHERE month LIKE ?`, `${y}-%`)
    .map(r => [r.month, r]));

  const months = [];
  for (let i = 1; i <= 12; i++) {
    const m = `${y}-${String(i).padStart(2, '0')}`;
    const r = found.get(m);
    const earned = round2(r?.earned || 0), spent = round2(r?.spent || 0);
    const top = tops.get(m);
    const rec = recaps.get(m);
    months.push({
      month: m, earned, spent, net: round2(earned - spent), count: r?.count || 0,
      topCategory: top ? { category: top.category, total: round2(top.total) } : null,
      headline: rec?.headline || '', note: rec?.note || '', hasRecap: !!rec?.headline,
    });
  }
  const earned = round2(months.reduce((s, m) => s + m.earned, 0));
  const spent = round2(months.reduce((s, m) => s + m.spent, 0));
  const active = months.filter(m => m.count > 0);
  const busiest = active.slice().sort((a, b) => b.spent - a.spent)[0] || null;
  const leanest = active.slice().sort((a, b) => a.spent - b.spent)[0] || null;

  const catTotals = all(`
    SELECT category, SUM(amount_base) AS total, COUNT(*) AS count
    FROM finance_txn WHERE deleted = 0 AND kind='expense' AND date >= ? AND date <= ?
    GROUP BY category ORDER BY total DESC LIMIT 10`, start, end);

  return {
    year: y, currency: settings().baseCurrency, months,
    totals: {
      earned, spent, net: round2(earned - spent),
      count: months.reduce((s, m) => s + m.count, 0),
      avgSpendPerActiveMonth: active.length ? round2(spent / active.length) : 0,
      savingsRate: earned > 0 ? Math.round((earned - spent) / earned * 100) : null,
    },
    busiest: busiest && { month: busiest.month, spent: busiest.spent },
    leanest: leanest && { month: leanest.month, spent: leanest.spent },
    categories: catTotals.map(c => ({ category: c.category, total: round2(c.total), count: c.count })),
    years: availableYears(),
  };
}

/** Years that actually contain data, so the picker only offers real ones. */
export function availableYears() {
  const rows = all(`SELECT DISTINCT substr(date,1,4) AS y FROM finance_txn WHERE deleted = 0 ORDER BY y DESC`);
  const list = rows.map(r => r.y);
  const thisYear = String(new Date().getFullYear());
  if (!list.includes(thisYear)) list.unshift(thisYear);
  return list;
}

const outRecap = (r) => r && ({
  month: r.month, summary: r.summary, headline: r.headline, note: r.note,
  facts: parseJSON(r.facts, null), model: r.model, updatedAt: r.updated_at,
});

export function getRecap(month) {
  if (!MONTH_RX.test(String(month || ''))) throw bad('month must be YYYY-MM');
  return outRecap(one('SELECT * FROM finance_recap WHERE month = ?', month)) || { month, summary: '', headline: '', note: '', facts: null, model: '' };
}

/** The user's own annotation. Kept separate from the generated summary so
 *  regenerating the recap never destroys something they wrote. */
export function setRecapNote(month, note) {
  if (!MONTH_RX.test(String(month || ''))) throw bad('month must be YYYY-MM');
  const text = String(note ?? '').slice(0, 4000);
  const stamp = now();
  run(`INSERT INTO finance_recap (month, note, created_at, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(month) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at`,
    month, text, stamp, stamp);
  return getRecap(month);
}

/** Store a generated recap. The narrative comes from receipts-style LLM code in
 *  index.js; this module stays free of model plumbing. */
export function saveRecap(month, { summary, headline, facts, model } = {}) {
  if (!MONTH_RX.test(String(month || ''))) throw bad('month must be YYYY-MM');
  const stamp = now();
  run(`INSERT INTO finance_recap (month, summary, headline, facts, model, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(month) DO UPDATE SET summary=excluded.summary, headline=excluded.headline,
         facts=excluded.facts, model=excluded.model, updated_at=excluded.updated_at`,
    month, String(summary || '').slice(0, 6000), String(headline || '').slice(0, 200),
    JSON.stringify(facts || {}), String(model || ''), stamp, stamp);
  return getRecap(month);
}

/** Per-day spend for a calendar heat map. */
export function calendar(q = {}) {
  const { start, end } = resolveRange(q);
  const rows = all(`
    SELECT date, SUM(CASE WHEN kind='expense' THEN amount_base ELSE 0 END) AS spent,
                 SUM(CASE WHEN kind='income'  THEN amount_base ELSE 0 END) AS earned,
                 COUNT(*) AS count
    FROM finance_txn WHERE deleted = 0 AND date >= ? AND date <= ?
    GROUP BY date ORDER BY date`, start, end);
  const max = rows.reduce((m, r) => Math.max(m, r.spent), 0);
  return {
    range: { start, end }, currency: settings().baseCurrency, max: round2(max),
    days: rows.map(r => ({ date: r.date, spent: round2(r.spent), earned: round2(r.earned), count: r.count })),
  };
}

/** Everything the Finances dashboard needs in one round trip. */
export function overview(q = {}) {
  const { start, end } = resolveRange(q);
  const month = monthOf(start);
  return {
    settings: currencies(),
    summary: summary({ from: start, to: end }),
    categories: byCategory({ from: start, to: end, kind: 'expense' }),
    income: byCategory({ from: start, to: end, kind: 'income' }),
    monthly: monthlySeries({ months: 12, end: month }),
    daily: dailySeries({ from: start, to: end }),
    budgets: listBudgets(month),
    goal: getGoal(month),
    presets: listPresets(),
    recent: listTxns({ from: start, to: end, limit: 12 }).items,
  };
}
