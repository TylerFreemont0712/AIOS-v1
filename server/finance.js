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
// What a transaction's `units` counts. '' when the money has no work attached to it.
export const UNIT_KINDS = ['hour', 'minute', 'item', 'day', 'word'];
export const CADENCES = ['monthly', 'weekly', 'yearly'];
// 'settle' marks an income row created by settling expected income — the one
// transaction that stands for a batch of estimates. See settlePending.
export const SOURCES = ['manual', 'preset', 'recurring', 'ocr', 'import', 'ai', 'settle'];

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

// ---------- which model does the finance work ----------

/** Finance has three model-backed jobs with different needs:
 *    ocrModel   reads receipt photographs   — MUST be vision-capable
 *    itemModel  names products from Japanese — wants strict JSON and JA/EN
 *    recapModel writes the monthly summary   — wants readable prose
 *
 *  They are separate settings because the requirements genuinely differ, but the
 *  recommendation deliberately pushes one model for all three: every distinct
 *  local model means another llama-server swap, and a receipt that OCRs with one
 *  model then names its items with another pays that cost twice per scan.
 *
 *  Nothing here hardcodes a filename. Vision capability comes from whether a
 *  model's preset names an mmproj that actually exists on disk, and quality comes
 *  from the user's own Bench results, so the advice tracks their machine.
 */
export async function modelOptions() {
  const cfg = loadConfig();
  const f = cfg.finance || {};
  const out = {
    current: {
      ocrModel: f.ocrModel || '', itemModel: f.itemModel || '', recapModel: f.recapModel || '',
    },
    chatDefault: cfg.defaults?.chatModel || '',
    vision: [], local: [], recommended: null, note: '',
  };

  let llmctl, bench;
  try {
    llmctl = await import('./llmctl.js');
    bench = await import('./bench.js');
  } catch (e) {
    out.note = `could not inspect local models: ${e.message}`;
    return out;
  }

  const mmprojFiles = new Set(llmctl.listMmproj().map(m => m.file));
  for (const m of llmctl.listLocalModels()) {
    const preset = llmctl.presetFor(m.file, m.sizeGB);
    const canSee = !!preset.mmproj && mmprojFiles.has(preset.mmproj);
    const entry = {
      ref: `local:${llmctl.modelAlias(m.file)}`,
      file: m.file, sizeGB: m.sizeGB, vision: canSee, mmproj: canSee ? preset.mmproj : '',
    };
    out.local.push(entry);
    if (canSee) out.vision.push(entry);
  }

  // Bench scores are keyed by the same local: refs.
  let board = { models: [], best: {} };
  try { board = bench.leaderboard(); } catch { /* no bench data yet */ }
  const scoreOf = (ref) => board.models.find(b => b.model === ref) || null;

  if (!out.vision.length) {
    out.note = 'No local model is set up for vision. Pair a model with an mmproj in '
      + 'Settings → Models to read receipts locally, or point receipt reading at a cloud model.';
    return out;
  }

  // Reading the paper and talking about it are different jobs, and this used to
  // recommend one model for both.
  //
  // The old advice was "use the best vision model for all three, so a scan never has to
  // swap mid-job" — swap cost, which is real. But a general VLM asked to transcribe does
  // not transcribe: it writes about the receipt. Measured over 23 archive scans, Gemma 4
  // returned "### 🇯🇵 日本語原文 … **[Item List - Partial Transcription]**" — every total
  // right, every product name gone. Saving one model swap is not worth losing the lines,
  // so the reader is now picked from the DEDICATED transcribers (preset tag `ocr`) and the
  // text jobs from everything else.
  const isReader = (e) => (llmctl.presetFor(e.file, e.sizeGB).tags || []).includes('ocr');
  const byScore = (a, b) => {
    const sa = scoreOf(a.ref)?.overall ?? -1, sb = scoreOf(b.ref)?.overall ?? -1;
    return sb - sa || a.sizeGB - b.sizeGB;         // ties go to the smaller model
  };

  const readers = out.vision.filter(isReader).sort(byScore);
  // Structuring, naming and write-ups are text jobs. Smallest-that-scores-well wins:
  // the reader and the text model cannot both be resident on one card, so every scan
  // pays a load for each — and a 2GB model loads in seconds where a 5GB one does not.
  const texts = out.local.filter(e => !isReader(e)).sort(byScore);

  if (!readers.length) {
    out.note = 'No dedicated OCR model is installed. Receipt reading works best with a '
      + 'transcriber (tagged `ocr` in its preset) rather than a general vision model, which '
      + 'tends to summarise the receipt instead of transcribing it.';
    return out;
  }

  const reader = readers[0];
  const text = texts[0] || reader;
  const rs = scoreOf(reader.ref);
  out.recommended = {
    ocrModel: reader.ref,
    ocrTextModel: text.ref, itemModel: text.ref, recapModel: text.ref,
    why: `${reader.file} transcribes the paper`
      + (rs ? ` (bench ${rs.overall}, ${rs.tokS} tok/s)` : '')
      + `, and ${text.file} turns that into fields. Two jobs, two models: a reader that `
      + 'answers questions transcribes badly, and a transcriber cannot tell you what it read.',
  };
  return out;
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
    // How much WORK the money represents, when that is knowable: 3.5 hours, 12 pieces.
    // Freelance income is meaningless without it — "¥40,000 this week" only becomes a
    // decision once you know whether it took four hours or forty.
    units: Math.max(0, Number(e.units ?? prev.units ?? 0) || 0),
    unit: UNIT_KINDS.includes(e.unit) ? e.unit : (prev.unit || ''),
    created_at: prev.created_at || now(),
    updated_at: now(),
  };
}

const outTxn = (r) => r && ({
  id: r.id, date: r.date, kind: r.kind, amount: r.amount, currency: r.currency,
  amountBase: r.amount_base, fxRate: r.fx_rate, category: r.category,
  merchant: r.merchant, note: r.note, isMainJob: !!r.is_main_job, source: r.source,
  presetId: r.preset_id, recurringId: r.recurring_id, receiptId: r.receipt_id,
  units: r.units || 0, unit: r.unit || '',
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const INSERT_TXN = `
INSERT INTO finance_txn (id, date, kind, amount, currency, amount_base, fx_rate, category,
  merchant, note, is_main_job, source, preset_id, recurring_id, receipt_id, units, unit,
  created_at, updated_at, deleted)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
ON CONFLICT(id) DO UPDATE SET
  date=excluded.date, kind=excluded.kind, amount=excluded.amount, currency=excluded.currency,
  amount_base=excluded.amount_base, fx_rate=excluded.fx_rate, category=excluded.category,
  merchant=excluded.merchant, note=excluded.note, is_main_job=excluded.is_main_job,
  source=excluded.source, preset_id=excluded.preset_id, recurring_id=excluded.recurring_id,
  receipt_id=excluded.receipt_id, units=excluded.units, unit=excluded.unit,
  updated_at=excluded.updated_at, deleted=0`;

function writeTxn(t) {
  run(INSERT_TXN, t.id, t.date, t.kind, t.amount, t.currency, t.amount_base, t.fx_rate,
    t.category, t.merchant, t.note, t.is_main_job, t.source, t.preset_id,
    t.recurring_id, t.receipt_id, t.units, t.unit, t.created_at, t.updated_at);
  return outTxn(t);
}

export function addTxn(input) { return writeTxn(sanitizeTxn(input)); }

export function updateTxn(id, patch) {
  const prev = one('SELECT * FROM finance_txn WHERE id = ? AND deleted = 0', String(id || ''));
  if (!prev) throw missing('transaction not found');
  return writeTxn(sanitizeTxn(patch || {}, prev));
}

// Deleting a row must also forget the price observations it produced. items.js owns
// finance_purchase, but a dynamic import here would have to make deleteTxn async and
// ripple through deleteTxns' transaction, so the one DELETE lives here — see
// items.deletePurchasesForTxn for the reasoning and keep the two in step.
const forgetPurchases = (txnId) => run('DELETE FROM finance_purchase WHERE txn_id = ?', String(txnId || '')).changes;

export function deleteTxn(id) {
  const r = run('UPDATE finance_txn SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0', now(), String(id || ''));
  if (!r.changes) throw missing('transaction not found');
  forgetPurchases(id);
}

/** Bulk delete — one statement, one transaction. Returns how many rows changed. */
export function deleteTxns(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!list.length) throw bad('ids must be a non-empty array');
  return tx(() => {
    const stamp = now();
    let n = 0;
    for (const id of list) {
      const hit = run('UPDATE finance_txn SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0', stamp, id).changes;
      if (hit) forgetPurchases(id);
      n += hit;
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
export function suggest({ field = 'merchant', q = '', limit = 8, kind = '' } = {}) {
  const col = field === 'category' ? 'category' : 'merchant';
  const like = `%${String(q || '').slice(0, 60)}%`;
  const n = Math.min(Math.max(Number(limit) || 8, 1), 50);
  // Without the kind filter, "who has paid me?" answers with the corner shop.
  const kindSql = KINDS.includes(kind) ? ` AND kind = '${kind}'` : '';
  const rows = all(`
    SELECT ${col} AS value, COUNT(*) AS seen, MAX(date) AS last_seen,
           AVG(amount) AS avg_amount, MAX(currency) AS currency,
           MAX(category) AS category
    FROM finance_txn
    WHERE deleted = 0 AND ${col} <> '' AND ${col} LIKE ? COLLATE NOCASE${kindSql}
    GROUP BY ${col} COLLATE NOCASE
    ORDER BY seen DESC, last_seen DESC LIMIT ?`, like, n);
  return rows.map(r => ({
    value: r.value, seen: r.seen, lastSeen: r.last_seen,
    avgAmount: round2(r.avg_amount), currency: r.currency, category: r.category,
  }));
}

// ---------- presets ----------

/**
 * A preset is both a one-tap entry and a template, and the amount is what says which.
 *
 * A zero amount used to be rejected. It is now the marker for "ask me": everything
 * about the stream that never changes — payer, category, currency, main-job flag, the
 * standing note — is stored, and the one thing that differs each time is typed. That is
 * the whole point for a stream like a micro-task platform, where the categorisation is
 * always identical and only the figure moves.
 */
function sanitizePreset(input, prev = {}) {
  const cfg = settings();
  const e = input || {};
  const name = str(e.name, prev.name, 80);
  if (!name) throw bad('preset name is required');
  // '' and null both mean "leave the amount open"; only a non-numeric string is an error.
  const rawAmount = e.amount === undefined ? prev.amount : e.amount;
  const amount = rawAmount === '' || rawAmount === null || rawAmount === undefined
    ? 0 : Math.abs(num(rawAmount, 'amount'));
  if (amount > 1e12) throw bad('amount is implausibly large');
  const currency = str(e.currency, prev.currency || cfg.baseCurrency, 3).toUpperCase();
  rateFor(currency, cfg);                                  // validate early
  const kind = KINDS.includes(e.kind) ? e.kind : (prev.kind || 'income');
  const category = str(e.category, prev.category || (kind === 'income' ? 'Side Job' : 'Uncategorized'), 60);
  return {
    id: prev.id || genId(8), name, amount, currency, kind, category,
    pay_unit: PAY_UNITS.includes(e.payUnit) ? e.payUnit : (prev.pay_unit || 'flat'),
    is_main_job: (e.isMainJob ?? prev.is_main_job ?? (category === 'Main Job' ? 1 : 0)) ? 1 : 0,
    // Blank falls back to the preset's own name at log time, so the common case
    // ("the chip is called Micro1 and Micro1 is who pays") needs nothing typed.
    merchant: str(e.merchant, prev.merchant, 120),
    note: str(e.note, prev.note, 500),
    // Expense presets can never be estimates: only income is guessed before it arrives.
    is_estimate: kind === 'income' && ((e.isEstimate ?? prev.is_estimate ?? 0) ? 1 : 0) ? 1 : 0,
    uses: prev.uses || 0,
    last_used: prev.last_used || '',
    created_at: prev.created_at || now(),
    updated_at: now(),
  };
}

const outPreset = (r) => r && ({
  id: r.id, name: r.name, amount: r.amount, currency: r.currency, kind: r.kind,
  category: r.category, payUnit: r.pay_unit, isMainJob: !!r.is_main_job,
  merchant: r.merchant || '', note: r.note || '', isEstimate: !!r.is_estimate,
  // What the UI branches on: a template opens a one-field prompt, a fixed preset logs
  // on the tap. Derived here so the rule lives in one place.
  asksAmount: !(r.amount > 0),
  uses: r.uses, lastUsed: r.last_used, updatedAt: r.updated_at,
});

/** Most-used first, then most-recent — not the old case-sensitive name sort. */
export function listPresets() {
  return all(`SELECT * FROM finance_preset WHERE deleted = 0
              ORDER BY uses DESC, last_used DESC, name COLLATE NOCASE`).map(outPreset);
}

function writePreset(p) {
  run(`INSERT INTO finance_preset (id, name, amount, currency, kind, category, pay_unit,
        is_main_job, merchant, note, is_estimate, uses, last_used, created_at, updated_at, deleted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, amount=excluded.amount,
        currency=excluded.currency, kind=excluded.kind, category=excluded.category,
        pay_unit=excluded.pay_unit, is_main_job=excluded.is_main_job,
        merchant=excluded.merchant, note=excluded.note, is_estimate=excluded.is_estimate,
        updated_at=excluded.updated_at, deleted=0`,
    p.id, p.name, p.amount, p.currency, p.kind, p.category, p.pay_unit,
    p.is_main_job, p.merchant, p.note, p.is_estimate, p.uses, p.last_used, p.created_at, p.updated_at);
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

/**
 * Log a preset.
 *
 * Three shapes, chosen by what the preset already knows:
 *   fixed flat        → `count` separate rows of the preset amount (so three coffees
 *                       read as three rows, matching the old behaviour)
 *   fixed hour/minute → a single row of rate x units
 *   template (amount 0) → the caller supplies `amount`; everything else comes from
 *                       the preset. This is the fast path for a stream whose
 *                       categorisation never changes and whose figure always does.
 *
 * `estimate` routes the row to the expected ledger instead of the real one — defaulted
 * from the preset so a stream that is always guessed first stays a one-click log.
 * Estimates are income-only and never split into `count` rows: a guess at a day's work
 * is one number, not N copies of it.
 */
export function logPreset(id, { count = 1, units = 1, amount, date, note, estimate, merchant } = {}) {
  const p = one('SELECT * FROM finance_preset WHERE id = ? AND deleted = 0', String(id || ''));
  if (!p) throw missing('preset not found');
  const on = date ? reqDate(date) : today();
  const unit = p.pay_unit;
  const given = amount === undefined || amount === null || amount === '' ? null : Math.abs(num(amount, 'amount'));
  if (!(p.amount > 0) && !(given > 0)) throw bad(`"${p.name}" has no fixed amount — pass the amount to log`);
  const asEstimate = p.kind === 'income'
    && (estimate === undefined ? !!p.is_estimate : !!estimate);
  // The payer is the preset's merchant, its name as a fallback (a chip called "Micro1"
  // is logged against Micro1 without anyone having typed it twice), or a per-log override.
  const payer = str(merchant, p.merchant || p.name, 120);
  const common = {
    date: on, currency: p.currency, category: p.category, merchant: payer,
    isMainJob: !!p.is_main_job, presetId: p.id,
  };
  const rows = [], pending = [];
  return tx(() => {
    if (unit === 'hour' || unit === 'minute') {
      const u = num(units, 'units');
      if (u <= 0) throw bad('units must be greater than zero');
      // With a rate on the preset the amount is derived; with an open amount the typed
      // figure is the truth and the units are only there to make it comparable later.
      const total = given !== null ? given : p.amount * u;
      const label = p.amount > 0
        ? (unit === 'hour' ? `${u}h @ ${p.amount}/hr` : `${u}m @ ${p.amount}/min`)
        : `${u}${unit === 'hour' ? 'h' : 'm'}`;
      const body = { ...common, amount: total, note: note || p.note || label, units: u, unit };
      if (asEstimate) pending.push(addPending(body));
      else rows.push(addTxn({ ...body, kind: p.kind, source: 'preset' }));
    } else if (asEstimate) {
      pending.push(addPending({ ...common, amount: given ?? p.amount, note: note || p.note || '', units: 1, unit: 'item' }));
    } else {
      const n = Math.min(Math.max(Math.trunc(Number(count) || 1), 1), 100);
      for (let i = 0; i < n; i++) {
        rows.push(addTxn({
          ...common, kind: p.kind, amount: given ?? p.amount,
          note: note || p.note || '', source: 'preset', units: 1, unit: 'item',
        }));
      }
    }
    const n = rows.length + pending.length;
    run('UPDATE finance_preset SET uses = uses + ?, last_used = ?, updated_at = ? WHERE id = ?',
      n, on, now(), p.id);
    return { preset: outPreset(p), created: rows, pending, estimate: asEstimate };
  });
}

// ---------- expected income (想定) ----------
//
// Freelance work is worth a guess on the day and a fact on payday, and the gap between
// them is information: if a month of estimates lands 8% under what actually arrived,
// the next month's intuition can be trusted 8% higher. The estimates therefore have to
// be recorded, and just as firmly they must never be counted as money — nothing here
// touches finance_txn until a payout is entered, so every total elsewhere in this file
// stays a total of money that exists.
//
// Settling is deliberately many-to-one: paid twice a month against a fortnight of daily
// guesses, the honest record is one income row for the amount received, with the
// estimates it covers marked off against it.

export const PENDING_STATUS = ['open', 'settled', 'void'];

function sanitizePending(input, prev = {}) {
  const cfg = settings();
  const e = input || {};
  const rawAmount = e.amount ?? prev.amount;
  if (rawAmount === undefined || rawAmount === null || rawAmount === '') throw bad('amount is required');
  const amount = Math.abs(num(rawAmount, 'amount'));
  if (amount === 0) throw bad('amount must not be zero');
  if (amount > 1e12) throw bad('amount is implausibly large');
  const currency = str(e.currency, prev.currency || cfg.baseCurrency, 3).toUpperCase();
  const fx = rateFor(currency, cfg);
  const category = str(e.category, prev.category || 'Freelance', 60) || 'Freelance';
  const status = PENDING_STATUS.includes(e.status) ? e.status : (prev.status || 'open');
  return {
    id: prev.id || genId(8),
    date: e.date === undefined && prev.date ? prev.date : reqDate(e.date || prev.date || today()),
    // Optional: some platforms tell you the payout date up front, most do not.
    due_date: e.dueDate === undefined
      ? (prev.due_date || '')
      : (e.dueDate ? reqDate(e.dueDate, 'dueDate') : ''),
    amount, currency,
    amount_base: Math.round(amount * fx * 100) / 100,
    fx_rate: fx,
    category,
    merchant: str(e.merchant, prev.merchant, 120),
    note: str(e.note, prev.note, 500),
    is_main_job: (e.isMainJob ?? prev.is_main_job ?? (category === 'Main Job' ? 1 : 0)) ? 1 : 0,
    units: Math.max(0, Number(e.units ?? prev.units ?? 0) || 0),
    unit: UNIT_KINDS.includes(e.unit) ? e.unit : (prev.unit || ''),
    preset_id: str(e.presetId, prev.preset_id, 32),
    status,
    // Settlement figures are written by settlePending alone — an edit must never be
    // able to claim money arrived.
    actual_base: prev.actual_base || 0,
    settled_txn_id: prev.settled_txn_id || '',
    settled_at: prev.settled_at || '',
    created_at: prev.created_at || now(),
    updated_at: now(),
  };
}

const outPending = (r) => r && ({
  id: r.id, date: r.date, dueDate: r.due_date || '', amount: r.amount, currency: r.currency,
  amountBase: r.amount_base, fxRate: r.fx_rate, category: r.category,
  merchant: r.merchant, note: r.note, isMainJob: !!r.is_main_job,
  units: r.units || 0, unit: r.unit || '', presetId: r.preset_id, status: r.status,
  actualBase: r.actual_base || 0,
  // Only meaningful once the money has landed; null keeps "no answer yet" out of the
  // averages instead of it reading as a perfect guess.
  variance: r.status === 'settled' ? round2(r.actual_base - r.amount_base) : null,
  settledTxnId: r.settled_txn_id || '', settledAt: r.settled_at || '',
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const INSERT_PENDING = `
INSERT INTO finance_pending (id, date, due_date, amount, currency, amount_base, fx_rate,
  category, merchant, note, is_main_job, units, unit, preset_id, status, actual_base,
  settled_txn_id, settled_at, created_at, updated_at, deleted)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
ON CONFLICT(id) DO UPDATE SET
  date=excluded.date, due_date=excluded.due_date, amount=excluded.amount,
  currency=excluded.currency, amount_base=excluded.amount_base, fx_rate=excluded.fx_rate,
  category=excluded.category, merchant=excluded.merchant, note=excluded.note,
  is_main_job=excluded.is_main_job, units=excluded.units, unit=excluded.unit,
  preset_id=excluded.preset_id, status=excluded.status,
  updated_at=excluded.updated_at, deleted=0`;

function writePending(p) {
  run(INSERT_PENDING, p.id, p.date, p.due_date, p.amount, p.currency, p.amount_base,
    p.fx_rate, p.category, p.merchant, p.note, p.is_main_job, p.units, p.unit,
    p.preset_id, p.status, p.actual_base, p.settled_txn_id, p.settled_at,
    p.created_at, p.updated_at);
  return outPending(p);
}

export function addPending(input) { return writePending(sanitizePending(input)); }

export function getPending(id) {
  const r = one('SELECT * FROM finance_pending WHERE id = ? AND deleted = 0', String(id || ''));
  if (!r) throw missing('expected entry not found');
  return outPending(r);
}

export function updatePending(id, patch) {
  const prev = one('SELECT * FROM finance_pending WHERE id = ? AND deleted = 0', String(id || ''));
  if (!prev) throw missing('expected entry not found');
  // Editing a settled estimate would rewrite the expected side of a comparison whose
  // actual side is already fixed, quietly changing a variance that was reported months
  // ago. Reopen it (which unwinds the payout) if the guess really needs correcting.
  if (prev.status === 'settled') throw bad('this estimate is already settled — reopen it first');
  return writePending(sanitizePending(patch || {}, prev));
}

export function deletePending(id) {
  const r = run('UPDATE finance_pending SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0',
    now(), String(id || ''));
  if (!r.changes) throw missing('expected entry not found');
}

/** Give up on an estimate that is never going to be paid, without deleting the record
 *  of having expected it. Void rows are excluded from every total and from calibration. */
export function voidPending(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) throw bad('ids must be a non-empty array');
  return tx(() => {
    let n = 0;
    for (const id of list) {
      n += run(`UPDATE finance_pending SET status = 'void', updated_at = ?
                WHERE id = ? AND deleted = 0 AND status = 'open'`, now(), id).changes;
    }
    return { voided: n };
  });
}

/** Filtered list of estimates. Defaults to everything still open, at any age —
 *  an unpaid estimate from two months ago is exactly the one worth seeing. */
export function listPending(q = {}) {
  const status = String(q.status || 'open');
  const where = ['deleted = 0'];
  const args = [];
  if (status !== 'all') {
    if (!PENDING_STATUS.includes(status)) throw bad(`status must be one of ${PENDING_STATUS.join(', ')} or 'all'`);
    where.push('status = ?'); args.push(status);
  }
  if (q.merchant) { where.push('merchant = ?'); args.push(String(q.merchant)); }
  if (q.presetId) { where.push('preset_id = ?'); args.push(String(q.presetId)); }
  // A range is applied only when one is actually asked for, and to different clocks:
  // open estimates are scoped by the day the work was done, settled ones by the day
  // the money landed. "Still owed for August" and "paid in August" are two questions.
  let range = null;
  if (q.month || q.from || q.to || q.start || q.end || q.range) {
    range = resolveRange(q);
    const col = status === 'settled' ? 'settled_at' : 'date';
    where.push(`${col} >= ? AND ${col} <= ?`);
    args.push(range.start, range.end);
  }
  const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 2000);
  const rows = all(`SELECT * FROM finance_pending WHERE ${where.join(' AND ')}
                    ORDER BY date DESC, created_at DESC LIMIT ?`, ...args, limit);
  return {
    range, currency: settings().baseCurrency,
    total: round2(rows.reduce((n, r) => n + r.amount_base, 0)),
    items: rows.map(outPending),
  };
}

/**
 * Record the money that actually arrived for a batch of estimates.
 *
 * Writes ONE real income transaction for the amount received and marks every estimate
 * it covers as settled. The received amount is then allocated back across those
 * estimates in proportion to what each one claimed — rounded per row with the remainder
 * on the last, so the parts always add back to exactly the whole. That allocation is
 * what lets calibration be answered per client ("Micro1 guesses run 6% low") rather
 * than only per payout.
 */
export function settlePending({ ids, amount, currency, date, note, merchant, category, isMainJob } = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (!list.length) throw bad('ids must be a non-empty array');
  if (amount === undefined || amount === null || amount === '') throw bad('amount is required');
  const paid = Math.abs(num(amount, 'amount'));
  if (paid === 0) throw bad('amount must not be zero — write the estimates off instead');
  const cfg = settings();

  return tx(() => {
    const rows = list.map(id => {
      const r = one('SELECT * FROM finance_pending WHERE id = ? AND deleted = 0', id);
      if (!r) throw missing(`expected entry ${id} not found`);
      if (r.status !== 'open') throw bad(`the estimate for ${r.date} is already ${r.status}`);
      return r;
    }).sort((a, b) => a.date.localeCompare(b.date));

    const expectedBase = round2(rows.reduce((n, r) => n + r.amount_base, 0));
    const cur = str(currency, rows[0].currency || cfg.baseCurrency, 3).toUpperCase();
    const fx = rateFor(cur, cfg);
    const paidBase = round2(paid * fx);
    const on = date ? reqDate(date) : today();
    const span = rows[0].date === rows[rows.length - 1].date
      ? rows[0].date : `${rows[0].date} → ${rows[rows.length - 1].date}`;

    // Work carries over onto the payout only when every estimate measured it the same
    // way; summing hours and articles into one number would be worse than no number.
    const sameUnit = rows[0].unit && rows.every(r => r.unit === rows[0].unit);

    const txn = addTxn({
      date: on, kind: 'income', amount: paid, currency: cur,
      category: str(category, rows[0].category, 60),
      merchant: str(merchant, rows[0].merchant, 120),
      note: str(note, '', 500) || `Payout for ${rows.length} estimate${rows.length === 1 ? '' : 's'} · ${span}`,
      isMainJob: isMainJob ?? !!rows[0].is_main_job,
      source: 'settle',
      units: sameUnit ? round2(rows.reduce((n, r) => n + (r.units || 0), 0)) : 0,
      unit: sameUnit ? rows[0].unit : '',
    });

    let left = paidBase;
    const stamp = now();
    rows.forEach((r, i) => {
      const share = i === rows.length - 1
        ? round2(left)
        : round2(expectedBase > 0 ? paidBase * (r.amount_base / expectedBase) : paidBase / rows.length);
      left = round2(left - share);
      run(`UPDATE finance_pending SET status = 'settled', actual_base = ?, settled_txn_id = ?,
             settled_at = ?, updated_at = ? WHERE id = ?`, share, txn.id, on, stamp, r.id);
    });

    return {
      txn, count: rows.length, currency: cfg.baseCurrency,
      expected: expectedBase, actual: paidBase,
      variance: round2(paidBase - expectedBase),
      biasPct: expectedBase > 0 ? Math.round((paidBase - expectedBase) / expectedBase * 100) : null,
    };
  });
}

/** Undo a settlement: delete the income row it created and put its estimates back
 *  in the open pile. The way to correct a payout entered wrong. */
export function unsettlePending(txnId) {
  const id = String(txnId || '');
  const rows = all(`SELECT id FROM finance_pending WHERE deleted = 0 AND settled_txn_id = ?`, id);
  if (!rows.length) throw missing('no settled estimates found for that transaction');
  return tx(() => {
    const stamp = now();
    for (const r of rows) {
      run(`UPDATE finance_pending SET status = 'open', actual_base = 0, settled_txn_id = '',
             settled_at = '', updated_at = ? WHERE id = ?`, stamp, r.id);
    }
    // The payout row may already be gone if it was deleted from the Ledger; reopening
    // the estimates is the part that matters, so a missing transaction is not an error.
    try { deleteTxn(id); } catch { /* already deleted */ }
    return { reopened: rows.length, txnId: id };
  });
}

const shiftDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * The whole expected-income picture for a period: what is still owed, how the last
 * lot of guesses compared with what arrived, and — per client — which way the
 * intuition leans.
 *
 * Open estimates are NOT scoped to the period. A guess from six weeks ago that is
 * still unpaid is the single most important row on this screen, and scoping it away
 * because the month selector moved would hide exactly the money at risk.
 */
export function pendingOverview(q = {}) {
  const { start, end } = resolveRange(q);
  const cfg = settings();

  const open = all(`SELECT * FROM finance_pending
                    WHERE deleted = 0 AND status = 'open'
                    ORDER BY date ASC, created_at ASC LIMIT 400`);
  const openTotal = round2(open.reduce((n, r) => n + r.amount_base, 0));
  const inPeriod = open.filter(r => r.date >= start && r.date <= end);

  // Grouped by who owes it, because that is the unit a payout arrives in: one client
  // pays for a fortnight of days at once, and settling is a per-client action.
  const groups = [];
  for (const r of open) {
    const payer = r.merchant || r.category;
    let g = groups.find(x => x.payer === payer);
    if (!g) {
      g = { payer, category: r.category, currency: r.currency, count: 0, total: 0, ids: [], from: r.date, to: r.date, oldestDays: 0 };
      groups.push(g);
    }
    g.count++;
    g.total = round2(g.total + r.amount_base);
    g.ids.push(r.id);
    if (r.date < g.from) g.from = r.date;
    if (r.date > g.to) g.to = r.date;
  }
  const t = today();
  for (const g of groups) g.oldestDays = Math.max(0, Math.round((Date.parse(t) - Date.parse(g.from)) / 86400000));
  groups.sort((a, b) => b.total - a.total);

  const settled = all(`SELECT * FROM finance_pending
                       WHERE deleted = 0 AND status = 'settled' AND settled_at >= ? AND settled_at <= ?
                       ORDER BY settled_at DESC LIMIT 400`, start, end);
  const expected = round2(settled.reduce((n, r) => n + r.amount_base, 0));
  const actual = round2(settled.reduce((n, r) => n + r.actual_base, 0));

  // One line per payout rather than per estimate: "the 15th paid ¥42,000 against
  // ¥39,500 guessed" is the sentence, and it needs the batch, not its parts.
  const payouts = [];
  for (const r of settled) {
    let p = payouts.find(x => x.txnId === r.settled_txn_id);
    if (!p) {
      p = { txnId: r.settled_txn_id, date: r.settled_at, payer: r.merchant || r.category, count: 0, expected: 0, actual: 0 };
      payouts.push(p);
    }
    p.count++;
    p.expected = round2(p.expected + r.amount_base);
    p.actual = round2(p.actual + r.actual_base);
  }
  for (const p of payouts) {
    p.variance = round2(p.actual - p.expected);
    p.biasPct = p.expected > 0 ? Math.round(p.variance / p.expected * 100) : null;
  }
  payouts.sort((a, b) => b.date.localeCompare(a.date));

  // Calibration needs more evidence than one month holds, so it looks back six months
  // from the end of the period regardless of what the period is.
  const since = shiftDays(end, -180);
  const byPayer = all(`
    SELECT COALESCE(NULLIF(merchant,''), category) AS payer,
           COUNT(*) AS count,
           COUNT(DISTINCT settled_txn_id) AS payouts,
           SUM(amount_base) AS expected,
           SUM(actual_base) AS actual,
           MAX(settled_at) AS last_settled
    FROM finance_pending
    WHERE deleted = 0 AND status = 'settled' AND settled_at >= ? AND settled_at <= ?
    GROUP BY COALESCE(NULLIF(merchant,''), category)
    ORDER BY actual DESC`, since, end).map(r => ({
      payer: r.payer, count: r.count, payouts: r.payouts,
      expected: round2(r.expected), actual: round2(r.actual),
      variance: round2(r.actual - r.expected),
      biasPct: r.expected > 0 ? Math.round((r.actual - r.expected) / r.expected * 100) : null,
      lastSettled: r.last_settled,
    }));

  return {
    range: { start, end }, currency: cfg.baseCurrency, since,
    open: {
      total: openTotal, count: open.length,
      inPeriodTotal: round2(inPeriod.reduce((n, r) => n + r.amount_base, 0)),
      inPeriodCount: inPeriod.length,
      oldest: open.length ? open[0].date : null,
      items: open.map(outPending),
      groups,
    },
    settled: {
      count: settled.length, payouts: payouts.length,
      expected, actual, variance: round2(actual - expected),
      biasPct: expected > 0 ? Math.round((actual - expected) / expected * 100) : null,
      items: payouts,
    },
    byPayer,
  };
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
    // kind/currency travel with the preview because monthStatus uses this to answer
    // "what is still coming out before the month ends" — which needs the expense
    // rows only, in the base currency.
    return {
      dryRun: true,
      pending: planned.map(p => ({
        id: p.rule.id, name: p.rule.name, date: p.date, amount: p.rule.amount,
        kind: p.rule.kind, currency: p.rule.currency, category: p.rule.category,
      })),
    };
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
  // maxNet is the largest ABSOLUTE swing either way, so a heat scale built on it treats a
  // +8,000 day and a -8,000 day as equally intense — which is what "daily net" means.
  const maxNet = rows.reduce((m, r) => Math.max(m, Math.abs(r.earned - r.spent)), 0);
  return {
    range: { start, end }, currency: settings().baseCurrency,
    max: round2(max), maxNet: round2(maxNet),
    days: rows.map(r => ({
      date: r.date, spent: round2(r.spent), earned: round2(r.earned),
      net: round2(r.earned - r.spent), count: r.count,
    })),
  };
}

// ---------- income ----------
//
// Freelance income is a different question from spending, and it was only ever visible
// here as a number in the hero. What it actually needs: what came in today, from which
// client, doing what kind of work — and whether the year so far is ahead or behind.

/**
 * Year to date, Jan 1 → today (or → the end of a past year, so old years stay whole).
 * The number a freelancer needs before a tax return exists, and the one that makes a
 * good month legible as either "ahead" or "just less bad".
 */
export function yearToDate(year) {
  const now_ = new Date();
  const y = String(year || now_.getFullYear()).slice(0, 4);
  if (!/^\d{4}$/.test(y)) throw bad('year must be YYYY');
  const start = `${y}-01-01`;
  const isCurrent = Number(y) === now_.getFullYear();
  const end = isCurrent ? today() : `${y}-12-31`;

  const r = one(`
    SELECT
      COALESCE(SUM(CASE WHEN kind='income'  THEN amount_base END),0) AS earned,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount_base END),0) AS spent,
      COALESCE(SUM(CASE WHEN kind='income' AND is_main_job=0 THEN amount_base END),0) AS side_earned,
      COALESCE(SUM(CASE WHEN kind='income' AND unit='hour' THEN units END),0) AS hours,
      COUNT(*) AS count
    FROM finance_txn WHERE deleted = 0 AND date >= ? AND date <= ?`, start, end);

  const earned = round2(r.earned), spent = round2(r.spent);
  // Elapsed days, not calendar days: a run-rate that assumes December has happened
  // in March is worse than no run-rate.
  const days = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1);
  const daysInYear = (Number(y) % 4 === 0 && Number(y) % 100 !== 0) || Number(y) % 400 === 0 ? 366 : 365;

  return {
    year: y, range: { start, end }, currency: settings().baseCurrency, isCurrent,
    earned, spent, net: round2(earned - spent), sideEarned: round2(r.side_earned),
    hours: round2(r.hours), count: r.count, days,
    perDay: round2((earned - spent) / days),
    // What the year lands at if the rest of it looks like the part that has happened.
    projectedEarned: isCurrent ? round2(earned / days * daysInYear) : earned,
    projectedNet: isCurrent ? round2((earned - spent) / days * daysInYear) : round2(earned - spent),
    effectiveRate: r.hours > 0 ? round2(earned / r.hours) : null,
  };
}

/** Income grouped by who paid it — the client list, effectively. */
export function incomeBySource(q = {}) {
  const { start, end } = resolveRange(q);
  // `payer`, not `source` — finance_txn already HAS a `source` column (manual/preset/ocr),
  // so an alias by that name silently groups by the wrong thing: every client collapsed
  // into one row labelled 'manual'. Group by the expression, not the alias, either way.
  const rows = all(`
    SELECT COALESCE(NULLIF(merchant,''), category) AS payer,
           SUM(amount_base) AS total, COUNT(*) AS count,
           COALESCE(SUM(CASE WHEN unit='hour' THEN units END),0) AS hours,
           MAX(date) AS last_date
    FROM finance_txn
    WHERE deleted = 0 AND kind = 'income' AND date >= ? AND date <= ?
    GROUP BY COALESCE(NULLIF(merchant,''), category)
    ORDER BY total DESC`, start, end);
  const total = round2(rows.reduce((s, r) => s + r.total, 0));
  return {
    range: { start, end }, currency: settings().baseCurrency, total,
    items: rows.map(r => ({
      source: r.payer, total: round2(r.total), count: r.count,
      hours: round2(r.hours), lastDate: r.last_date,
      share: total > 0 ? Math.round(r.total / total * 100) : 0,
      rate: r.hours > 0 ? round2(r.total / r.hours) : null,
    })),
  };
}

/** The daily log: what came in each day, and the entries behind it. */
export function incomeLog(q = {}) {
  const { start, end } = resolveRange(q);
  const rows = all(`
    SELECT * FROM finance_txn
    WHERE deleted = 0 AND kind = 'income' AND date >= ? AND date <= ?
    ORDER BY date DESC, created_at DESC LIMIT 500`, start, end);

  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.date)) byDay.set(r.date, { date: r.date, total: 0, hours: 0, entries: [] });
    const d = byDay.get(r.date);
    d.total = round2(d.total + r.amount_base);
    if (r.unit === 'hour') d.hours = round2(d.hours + (r.units || 0));
    d.entries.push(outTxn(r));
  }
  return {
    range: { start, end }, currency: settings().baseCurrency,
    days: [...byDay.values()],
  };
}

/** Everything the Income tab needs in one round trip. */
export function incomeOverview(q = {}) {
  const { start, end } = resolveRange(q);
  const month = monthOf(start);
  const s = summary({ from: start, to: end });
  const hours = one(`
    SELECT COALESCE(SUM(CASE WHEN unit='hour' THEN units END),0) AS hours
    FROM finance_txn WHERE deleted = 0 AND kind='income' AND date >= ? AND date <= ?`, start, end);

  return {
    settings: currencies(),
    summary: { ...s, hours: round2(hours.hours), effectiveRate: hours.hours > 0 ? round2(s.earned / hours.hours) : null },
    ytd: yearToDate(month.slice(0, 4)),
    bySource: incomeBySource({ from: start, to: end }),
    byCategory: byCategory({ from: start, to: end, kind: 'income' }),
    log: incomeLog({ from: start, to: end }),
    monthly: monthlySeries({ months: 12, end: month }),
    goal: getGoal(month),
    // Money guessed but not yet received, and how the last guesses turned out.
    pending: pendingOverview({ from: start, to: end }),
    // Income presets and recurring income only — the Plan tab owns the expense side.
    presets: listPresets().filter(p => p.kind === 'income'),
    recurring: listRecurring().filter(r => r.kind === 'income'),
    categories: settings().incomeCategories,
    // Past payers, so logging the same client again is a pick rather than a retype.
    sources: suggest({ field: 'merchant', q: '', limit: 12, kind: 'income' }),
  };
}

/**
 * "Where do I stand this month" — the two questions the dashboard leads with.
 *
 * 1. Is the income goal met, and if not, by how much?
 * 2. How much is left to spend, and does the pace get me to the end of the month?
 *
 * The second one needs a ceiling, and there are three honest answers depending on
 * what has been set up, reported as `basis` so the UI can say which one it used:
 *
 *   'budget'  the category budgets, summed. The user's own plan — always preferred.
 *   'income'  no budgets: what came in this month. "Of the money that arrived,
 *             this much is unspent" is still a real answer, just a different one.
 *   'none'    neither, so there is nothing to be left OF. Says so rather than
 *             inventing a number.
 *
 * `committed` is separate on purpose. Rent that has not posted yet is not spare
 * money, and a "left to spend" figure that quietly includes it is the single most
 * misleading thing this screen could show. It is subtracted into `available`, and
 * both are returned so the card can show the difference.
 */
export function monthStatus(q = {}) {
  const { start } = resolveRange(q);
  const month = monthOf(start);
  const { start: mStart, end: mEnd } = monthBounds(month);
  const cfg = settings();
  const s = summary({ from: mStart, to: mEnd });
  const goal = getGoal(month);
  const budgets = listBudgets(month);

  const t = today(), thisMonth = monthOf(t);
  const daysTotal = Number(mEnd.slice(8, 10));
  const isCurrent = month === thisMonth;
  const daysElapsed = isCurrent ? Number(t.slice(8, 10)) : (month < thisMonth ? daysTotal : 0);
  const daysLeft = Math.max(0, daysTotal - daysElapsed);

  // Recurring expenses that have not posted yet but will before the month is out.
  const upcoming = [];
  if (daysLeft > 0) {
    try {
      for (const p of runRecurring({ upTo: mEnd, dryRun: true }).pending) {
        if (p.kind !== 'expense' || p.date < t) continue;
        let base = p.amount;
        try { base = p.amount * rateFor(p.currency, cfg); } catch { /* unrated: count it at face value */ }
        upcoming.push({ name: p.name, date: p.date, category: p.category, amount: round2(base) });
      }
    } catch { /* a broken recurring rule must not take the dashboard down */ }
  }

  const budgetTotal = round2(budgets.items.reduce((n, b) => n + b.amount, 0));
  const basis = budgetTotal > 0 ? 'budget' : (s.earned > 0 ? 'income' : 'none');
  const limit = basis === 'budget' ? budgetTotal : basis === 'income' ? s.earned : 0;

  // Budgets only cover the categories they name, so measure spend against the same
  // scope — comparing all spending to a partial budget reads as "over" every month.
  const budgeted = new Set(budgets.items.map(b => b.category));
  const inScope = (cat) => basis !== 'budget' || budgeted.has(cat);
  const spentInScope = basis === 'budget'
    ? round2(budgets.items.reduce((n, b) => n + b.spent, 0))
    : s.spent;

  // Same scope rule for what is still coming: subtracting rent from a grocery
  // budget is not a smaller number, it is a wrong one.
  const committedItems = upcoming.filter(u => inScope(u.category));
  const committed = round2(committedItems.reduce((n, u) => n + u.amount, 0));

  // With no ceiling there is nothing to be left OF, so these stay null rather than
  // becoming "minus everything you spent", which reads as a catastrophic overrun.
  const capped = basis !== 'none';
  const remaining = capped ? round2(limit - spentInScope) : null;
  const available = capped ? round2(remaining - committed) : null;
  const perDaySoFar = daysElapsed > 0 ? round2(spentInScope / daysElapsed) : 0;
  const projected = daysElapsed > 0 ? round2(perDaySoFar * daysTotal) : spentInScope;
  // Where the spend "should" be by today if the month were spread evenly. The
  // comparison against it is what turns a number into "you are fine" or "slow down".
  const pace = limit > 0 && daysTotal > 0 ? round2(limit * (daysElapsed / daysTotal)) : null;

  const target = goal.minGoal || goal.majorGoal || 0;
  const goalMet = target > 0 && goal.progress >= target;

  return {
    month, currency: cfg.baseCurrency, isCurrent,
    days: { total: daysTotal, elapsed: daysElapsed, left: daysLeft },
    goal: {
      ...goal, target, met: goalMet,
      toGo: target > 0 ? round2(Math.max(0, target - goal.progress)) : null,
      pct: target > 0 ? Math.min(999, Math.round(goal.progress / target * 100)) : null,
      // With a stretch target set, "met" is only half the story.
      stretchMet: goal.majorGoal > 0 && goal.progress >= goal.majorGoal,
      perDayNeeded: target > 0 && daysLeft > 0 ? round2(Math.max(0, target - goal.progress) / daysLeft) : null,
    },
    spend: {
      basis, limit, spent: spentInScope, remaining, committed, available,
      committedItems: committedItems.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6),
      categoriesCovered: budgeted.size,
      pct: capped && limit > 0 ? Math.round(spentInScope / limit * 100) : null,
      pace, perDaySoFar, projected,
      // Non-null only while the month is live: an allowance for zero days left is
      // a division by zero dressed up as advice.
      perDayLeft: capped && limit > 0 && daysLeft > 0 ? round2(Math.max(0, available) / daysLeft) : null,
      over: capped && limit > 0 && spentInScope > limit,
      onTrack: capped && limit > 0 ? projected <= limit : null,
    },
    summary: s,
  };
}

/** Everything the Finances dashboard needs in one round trip. */
export function overview(q = {}) {
  const { start, end } = resolveRange(q);
  const month = monthOf(start);
  return {
    settings: currencies(),
    summary: summary({ from: start, to: end }),
    // Year to date travels with the dashboard: a month on its own cannot say whether the
    // year is working, and this is the figure a tax return starts from.
    ytd: yearToDate(month.slice(0, 4)),
    categories: byCategory({ from: start, to: end, kind: 'expense' }),
    income: byCategory({ from: start, to: end, kind: 'income' }),
    monthly: monthlySeries({ months: 12, end: month }),
    daily: dailySeries({ from: start, to: end }),
    budgets: listBudgets(month),
    goal: getGoal(month),
    // The headline band: goal met vs what is left to spend. Only when the period IS
    // one calendar month — goals and budgets are monthly, so "left to spend" against
    // a year-to-date or 30-day window would be an answer to a question nobody asked.
    // Never fatal either: the rest of the dashboard is still worth drawing if a
    // recurring rule is malformed.
    status: (() => {
      const b = monthBounds(month);
      if (start !== b.start || end !== b.end) return null;
      try { return monthStatus({ month }); } catch { return null; }
    })(),
    presets: listPresets(),
    // The dashboard only needs the headline of the expected ledger — how much work is
    // done but unpaid, and whether the guesses behind it have been landing. The full
    // list, with the settle action, lives on the Income tab. Never fatal.
    pending: (() => {
      try {
        const p = pendingOverview({ from: start, to: end });
        if (!p.open.count && !p.settled.count) return null;
        return {
          currency: p.currency,
          open: { total: p.open.total, count: p.open.count, oldest: p.open.oldest },
          settled: p.settled.count ? {
            expected: p.settled.expected, actual: p.settled.actual,
            variance: p.settled.variance, biasPct: p.settled.biasPct, payouts: p.settled.payouts,
          } : null,
          groups: p.open.groups.slice(0, 3).map(g => ({ payer: g.payer, total: g.total, count: g.count, oldestDays: g.oldestDays })),
        };
      } catch { return null; }
    })(),
    recent: listTxns({ from: start, to: end, limit: 12 }).items,
  };
}
