// Item price tracking: what does a thing actually cost, and where is it cheapest.
//
// The hard part is not the arithmetic, it is deciding that "明治おいしい牛乳1L",
// "ヤマダ牛乳 1000ml" and "TANAKA MILK 1L" are all the same thing — Milk — so their
// prices can sit on one chart. Brand is noise for groceries; size is not, because a
// 1L carton at ¥240 beats a 500ml one at ¥140 and you cannot see that without
// normalising to a price per millilitre.
//
// Resolution runs cheapest-first and only reaches the model for genuinely new
// strings:
//
//   1. exact alias hit        — free, and authoritative once confirmed
//   2. fuzzy match on aliases — trigram similarity, catches OCR noise and spacing
//   3. canonical-name containment — "…牛乳…" contains a known canonical name
//   4. the model               — shown the existing catalogue so it reuses it
//
// A user-confirmed alias is never overwritten by steps 2-4. That is the whole
// point-of-truth guarantee: once you have said what something is, it stays said.

import { all, one, run, tx } from './financedb.js';
import { id as genId, now } from './util.js';
import { settings } from './finance.js';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const missing = (msg) => Object.assign(new Error(msg), { status: 404 });

export const UNITS = ['each', 'ml', 'g'];

// ---------- normalisation ----------

/** Fold a printed name to a matching key.
 *  NFKC is doing the heavy lifting for Japanese receipts: it converts full-width
 *  ＡＢＣ／１２３ and half-width ｶﾀｶﾅ to their canonical forms, so the same product
 *  printed by two different registers collapses to one key. */
export function normalize(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[”“"'`´’]/g, '')
    .replace(/[･・()（）[\]【】{}<>《》,、。.:;：；!！?？*#＊]/g, ' ')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

/** Tokens worth matching on: drop pure punctuation and 1-char latin noise. */
const tokens = (s) => normalize(s).split(' ').filter(t => t && !/^[a-z]$/.test(t));

const HAS_CJK = /[぀-ヿ㐀-䶿一-鿿]/;

/** Is the canonical name `nk` present in the printed name in a way that means
 *  "this is that product"? CJK: any substring. Latin: a whole token only. */
function containedIn(key, toks, nk) {
  if (toks.has(nk)) return true;
  if (HAS_CJK.test(nk)) return key.includes(nk);
  // Multi-word latin names ("olive oil") still count as contained when they
  // appear intact, which token-set membership alone would miss.
  return nk.includes(' ') && key.includes(nk);
}

/** Dice coefficient over character trigrams — tolerant of OCR noise, insertions
 *  and the spacing differences between registers. Works on Japanese because it is
 *  character-based rather than word-based. */
function trigramScore(a, b) {
  const gram = (s) => {
    const p = `  ${s} `;
    const out = new Set();
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
    return out;
  };
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = gram(a), B = gram(b);
  let hits = 0;
  for (const g of A) if (B.has(g)) hits++;
  return (2 * hits) / (A.size + B.size);
}

// ---------- pack size parsing ----------

// Ordered: the more specific units must win before the bare "g"/"l" patterns.
const SIZE_PATTERNS = [
  [/(\d+(?:\.\d+)?)\s*(?:ml|ミリリットル|ミリ|cc)\b/i, (v) => ({ size: v, unit: 'ml' })],
  [/(\d+(?:\.\d+)?)\s*(?:l|ℓ|リットル)\b/i, (v) => ({ size: v * 1000, unit: 'ml' })],
  [/(\d+(?:\.\d+)?)\s*(?:kg|㎏|キログラム|キロ)\b/i, (v) => ({ size: v * 1000, unit: 'g' })],
  [/(\d+(?:\.\d+)?)\s*(?:mg)\b/i, (v) => ({ size: v / 1000, unit: 'g' })],
  [/(\d+(?:\.\d+)?)\s*(?:g|グラム|ｇ)\b/i, (v) => ({ size: v, unit: 'g' })],
  // No \b after the Japanese counters: \b is defined against [A-Za-z0-9_], so
  // "6個" at end of string has no boundary to match and the pattern never fires.
  [/(\d+)\s*(?:個|入り|入|袋|本|枚|玉|パック|セット)/, (v) => ({ size: v, unit: 'each' })],
  [/(\d+)\s*(?:pcs?|pack|p)\b/i, (v) => ({ size: v, unit: 'each' })],
];

/** Pull a pack size out of a printed name. Returns null when there is none —
 *  callers then fall back to the item's typical size so a bare "牛乳" still
 *  compares sensibly against sized entries. */
export function parseSize(rawName) {
  const s = normalize(rawName);
  for (const [rx, make] of SIZE_PATTERNS) {
    const m = rx.exec(s);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > 0) return make(v);
    }
  }
  return null;
}

// ---------- catalogue ----------

const outItem = (r) => r && ({
  id: r.id, nameEn: r.name_en, nameJa: r.name_ja, category: r.category,
  subcategory: r.subcategory, unit: r.unit, typicalSize: r.typical_size,
  note: r.note, pinned: !!r.pinned, updatedAt: r.updated_at,
});

function sanitizeItem(input, prev = {}) {
  const e = input || {};
  const nameEn = String(e.nameEn ?? prev.name_en ?? '').trim().slice(0, 80);
  if (!nameEn) throw bad('nameEn is required');
  const unit = UNITS.includes(e.unit) ? e.unit : (prev.unit || 'each');
  return {
    id: prev.id || genId(8),
    name_en: nameEn,
    name_ja: String(e.nameJa ?? prev.name_ja ?? '').trim().slice(0, 80),
    category: String(e.category ?? prev.category ?? 'Groceries').trim().slice(0, 60),
    subcategory: String(e.subcategory ?? prev.subcategory ?? '').trim().slice(0, 60),
    unit,
    typical_size: Math.max(0, Number(e.typicalSize ?? prev.typical_size ?? 0) || 0),
    note: String(e.note ?? prev.note ?? '').slice(0, 500),
    pinned: (e.pinned ?? prev.pinned ?? 0) ? 1 : 0,
    created_at: prev.created_at || now(),
    updated_at: now(),
  };
}

function writeItem(it) {
  run(`INSERT INTO finance_item (id, name_en, name_ja, category, subcategory, unit,
        typical_size, note, pinned, created_at, updated_at, deleted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0)
       ON CONFLICT(id) DO UPDATE SET name_en=excluded.name_en, name_ja=excluded.name_ja,
        category=excluded.category, subcategory=excluded.subcategory, unit=excluded.unit,
        typical_size=excluded.typical_size, note=excluded.note, pinned=excluded.pinned,
        updated_at=excluded.updated_at, deleted=0`,
    it.id, it.name_en, it.name_ja, it.category, it.subcategory, it.unit,
    it.typical_size, it.note, it.pinned, it.created_at, it.updated_at);
  return outItem(it);
}

export function createItem(input) { return writeItem(sanitizeItem(input)); }

export function updateItem(id, patch) {
  const prev = one('SELECT * FROM finance_item WHERE id = ? AND deleted = 0', String(id || ''));
  if (!prev) throw missing('item not found');
  return writeItem(sanitizeItem(patch || {}, prev));
}

export function getItem(id) {
  const r = one('SELECT * FROM finance_item WHERE id = ? AND deleted = 0', String(id || ''));
  if (!r) throw missing('item not found');
  return outItem(r);
}

/** Soft-delete the catalogue entry and release its purchases back to the review
 *  queue. The aliases must go too: an alias outliving its item resolves future
 *  receipts to a row that no longer exists, and every read path then 404s.
 *  To fold a duplicate into its twin without losing history, use mergeItems. */
export function deleteItem(id) {
  const key = String(id || '');
  const r = run('UPDATE finance_item SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0', now(), key);
  if (!r.changes) throw missing('item not found');
  run('DELETE FROM finance_item_alias WHERE item_id = ?', key);
  run(`UPDATE finance_purchase SET item_id = '' WHERE item_id = ?`, key);
}

/** The whole catalogue, compact — this is what gets shown to the model so it
 *  reuses existing entries instead of inventing near-duplicates. */
export function catalogue({ limit = 400 } = {}) {
  return all(`SELECT id, name_en, name_ja, category, subcategory, unit, typical_size
              FROM finance_item WHERE deleted = 0
              ORDER BY name_en COLLATE NOCASE LIMIT ?`, Math.min(limit, 2000))
    .map(r => ({
      id: r.id, nameEn: r.name_en, nameJa: r.name_ja,
      category: r.category, subcategory: r.subcategory, unit: r.unit, typicalSize: r.typical_size,
    }));
}

// ---------- aliases ----------

export function aliasesFor(itemId) {
  return all(`SELECT * FROM finance_item_alias WHERE item_id = ? ORDER BY confirmed DESC, hits DESC, raw`,
    String(itemId || ''))
    .map(a => ({ id: a.id, raw: a.raw, norm: a.norm, source: a.source, confirmed: !!a.confirmed, hits: a.hits }));
}

/** Record raw → item. `confirmed` rows win over anything already there; an
 *  unconfirmed guess never clobbers a confirmed mapping. */
export function learnAlias(raw, itemId, { source = 'manual', confirmed = false } = {}) {
  const key = normalize(raw);
  if (!key) throw bad('empty name');
  if (!one('SELECT id FROM finance_item WHERE id = ? AND deleted = 0', String(itemId))) {
    throw missing('item not found');
  }
  const existing = one('SELECT * FROM finance_item_alias WHERE norm = ?', key);
  if (existing) {
    if (existing.confirmed && !confirmed) return { ...existing, skipped: true };
    run(`UPDATE finance_item_alias SET item_id=?, source=?, confirmed=?, updated_at=? WHERE norm=?`,
      itemId, source, confirmed ? 1 : 0, now(), key);
    return one('SELECT * FROM finance_item_alias WHERE norm = ?', key);
  }
  const stamp = now();
  run(`INSERT INTO finance_item_alias (id, item_id, raw, norm, source, confirmed, hits, created_at, updated_at)
       VALUES (?,?,?,?,?,?,0,?,?)`,
    genId(8), itemId, String(raw).slice(0, 200), key, source, confirmed ? 1 : 0, stamp, stamp);
  return one('SELECT * FROM finance_item_alias WHERE norm = ?', key);
}

export function deleteAlias(id) {
  const r = run('DELETE FROM finance_item_alias WHERE id = ?', String(id || ''));
  if (!r.changes) throw missing('alias not found');
}

const bumpAlias = (key) => run('UPDATE finance_item_alias SET hits = hits + 1 WHERE norm = ?', key);

// ---------- matching ----------

/** Rank catalogue entries against a raw printed name, without the model.
 *  Combines three signals: similarity to any known alias, similarity to the
 *  canonical names, and whole-token containment (the "…牛乳…" case, which is what
 *  makes brand prefixes harmless). */
export function candidates(rawName, { limit = 6 } = {}) {
  const key = normalize(rawName);
  if (!key) return [];
  const toks = new Set(tokens(rawName));

  const rows = all(`
    SELECT i.id, i.name_en, i.name_ja, i.category, i.unit, i.typical_size,
           a.norm AS alias_norm, a.confirmed
    FROM finance_item i LEFT JOIN finance_item_alias a ON a.item_id = i.id
    WHERE i.deleted = 0`);

  const best = new Map();
  for (const r of rows) {
    const nameKeys = [normalize(r.name_en), normalize(r.name_ja)].filter(Boolean);
    let score = 0;
    let why = '';

    if (r.alias_norm) {
      const s = trigramScore(key, r.alias_norm) * (r.confirmed ? 1 : 0.94);
      if (s > score) { score = s; why = 'alias'; }
    }
    for (const nk of nameKeys) {
      const s = trigramScore(key, nk) * 0.95;
      if (s > score) { score = s; why = 'name'; }
      // Containment is the signal that makes brands harmless: "牛乳" sits inside
      // "ヤマダ牛乳1000ml" and "明治おいしい牛乳1l" alike, while trigram similarity
      // between them is low because brand and size dominate the string.
      //
      // Applied differently per script, because the risk differs. Japanese is
      // unspaced so substring is the only option — and it is safe, since a
      // 2+ character CJK product word inside a longer product name really does
      // mean that product. Latin has to match a whole token: "tea" is a
      // substring of "steak".
      if (nk.length >= 2 && containedIn(key, toks, nk)) {
        const s2 = 0.92;
        if (s2 > score) { score = s2; why = 'contains'; }
      }
    }
    const prev = best.get(r.id);
    if (!prev || score > prev.score) {
      best.set(r.id, {
        id: r.id, nameEn: r.name_en, nameJa: r.name_ja, category: r.category,
        unit: r.unit, typicalSize: r.typical_size, score: Math.round(score * 1000) / 1000, why,
      });
    }
  }
  return [...best.values()].filter(c => c.score > 0.28)
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

const AUTO_ACCEPT = 0.9;

/** Resolve a printed name to a catalogue item WITHOUT the model.
 *  Returns { itemId, how, score } or null when the model is needed. */
export function resolveLocal(rawName) {
  const key = normalize(rawName);
  if (!key) return null;

  const exact = one('SELECT * FROM finance_item_alias WHERE norm = ?', key);
  if (exact) {
    // Belt and braces: deleteItem clears aliases, but a database edited by hand
    // (or restored from a backup mid-change) must not resolve to a dead row.
    if (one('SELECT id FROM finance_item WHERE id = ? AND deleted = 0', exact.item_id)) {
      bumpAlias(key);
      return { itemId: exact.item_id, how: exact.confirmed ? 'confirmed-alias' : 'alias', score: 1 };
    }
    run('DELETE FROM finance_item_alias WHERE norm = ?', key);
  }
  const [top] = candidates(rawName, { limit: 1 });
  if (top && top.score >= AUTO_ACCEPT) {
    learnAlias(rawName, top.id, { source: 'auto', confirmed: false });
    bumpAlias(key);
    return { itemId: top.id, how: 'fuzzy:' + top.why, score: top.score };
  }
  return null;
}

/**
 * What has this printed line cost before? The prior a receipt scan is judged against.
 *
 * Deliberately read-only, which is why it does not call `resolveLocal()`: that *writes*
 * (it auto-learns a fuzzy alias and bumps hit counts). A plausibility probe runs while
 * the user is still reviewing a scan, so it must not teach the catalogue anything yet —
 * and it must not turn a hallucinated line into a real alias.
 *
 * Returns null when there isn't enough history to have an opinion. Silence beats a
 * confident warning drawn from two data points.
 */
export function priceProbe(rawName, { minObs = 3 } = {}) {
  const key = normalize(rawName);
  if (!key) return null;

  let itemId = one('SELECT item_id FROM finance_item_alias WHERE norm = ?', key)?.item_id || '';
  if (!itemId) {
    const [top] = candidates(rawName, { limit: 1 });
    if (!top || top.score < AUTO_ACCEPT) return null;   // only a near-certain match earns a prior
    itemId = top.id;
  }

  const xs = all(`SELECT each_price_base FROM finance_purchase
                  WHERE item_id = ? AND each_price_base > 0
                  ORDER BY date DESC LIMIT 40`, itemId).map(r => Number(r.each_price_base));
  if (xs.length < minObs) return null;
  xs.sort((a, b) => a - b);
  const at = (q) => xs[Math.min(xs.length - 1, Math.max(0, Math.round((xs.length - 1) * q)))];
  return { itemId, n: xs.length, median: at(0.5), low: at(0.1), high: at(0.9) };
}

// ---------- purchases ----------

const outPurchase = (r) => r && ({
  id: r.id, itemId: r.item_id || null, txnId: r.txn_id, receiptId: r.receipt_id,
  date: r.date, merchant: r.merchant, rawName: r.raw_name, qty: r.qty,
  lineTotal: r.line_total, currency: r.currency, lineTotalBase: r.line_total_base,
  size: r.size, unit: r.unit, unitPriceBase: r.unit_price_base, eachPriceBase: r.each_price_base,
  source: r.source,
});

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Record one price observation. Size comes from the printed name when it is
 *  there, else from the item's typical size, so a bare "牛乳" still lands on the
 *  per-millilitre chart instead of dropping out of the comparison. */
export function recordPurchase(input) {
  const cfg = settings();
  const e = input || {};
  const rawName = String(e.rawName || '').trim().slice(0, 200);
  if (!rawName) throw bad('rawName is required');
  const date = String(e.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('date must be YYYY-MM-DD');

  const currency = String(e.currency || cfg.baseCurrency).toUpperCase().slice(0, 3);
  const rate = Number(cfg.rates[currency]);
  if (!Number.isFinite(rate) || rate <= 0) throw bad(`no exchange rate configured for ${currency}`);

  const qty = Math.max(1, Number(e.qty) || 1);
  const lineTotal = Math.abs(Number(e.lineTotal) || 0);
  const lineTotalBase = round2(lineTotal * rate);

  const itemId = String(e.itemId || '');
  const item = itemId ? one('SELECT * FROM finance_item WHERE id = ?', itemId) : null;

  const parsed = parseSize(rawName);
  let unit = parsed?.unit || item?.unit || '';
  let size = parsed?.size || 0;
  if (!size && item?.typical_size) { size = item.typical_size; unit = item.unit; }
  if (unit === 'each' && !size) size = 1;

  // qty multiplies the pack: 2 x 1L is 2000 ml for the same line total.
  const totalUnits = size * qty;
  const unitPriceBase = totalUnits > 0 ? round4(lineTotalBase / totalUnits) : 0;

  const row = {
    id: genId(10), item_id: itemId, txn_id: String(e.txnId || ''), receipt_id: String(e.receiptId || ''),
    date, merchant: String(e.merchant || '').trim().slice(0, 120), raw_name: rawName,
    qty, line_total: lineTotal, currency, line_total_base: lineTotalBase,
    size, unit, unit_price_base: unitPriceBase,
    each_price_base: round2(lineTotalBase / qty),
    source: String(e.source || 'ocr'), created_at: now(),
  };
  run(`INSERT INTO finance_purchase (id, item_id, txn_id, receipt_id, date, merchant, raw_name,
        qty, line_total, currency, line_total_base, size, unit, unit_price_base, each_price_base, source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.id, row.item_id, row.txn_id, row.receipt_id, row.date, row.merchant, row.raw_name,
    row.qty, row.line_total, row.currency, row.line_total_base, row.size, row.unit,
    row.unit_price_base, row.each_price_base, row.source, row.created_at);
  return outPurchase(row);
}

/** Point an already-recorded purchase at an item (used by the review queue), and
 *  recompute its unit price now that the item's unit is known. */
export function assignPurchase(purchaseId, itemId, { confirm = true } = {}) {
  const p = one('SELECT * FROM finance_purchase WHERE id = ?', String(purchaseId || ''));
  if (!p) throw missing('purchase not found');
  const item = one('SELECT * FROM finance_item WHERE id = ? AND deleted = 0', String(itemId || ''));
  if (!item) throw missing('item not found');

  return tx(() => {
    learnAlias(p.raw_name, item.id, { source: 'manual', confirmed: confirm });
    const parsed = parseSize(p.raw_name);
    let unit = parsed?.unit || item.unit;
    let size = parsed?.size || item.typical_size || (unit === 'each' ? 1 : 0);
    const totalUnits = size * (p.qty || 1);
    const unitPrice = totalUnits > 0 ? round4(p.line_total_base / totalUnits) : 0;
    run(`UPDATE finance_purchase SET item_id=?, size=?, unit=?, unit_price_base=? WHERE id=?`,
      item.id, size, unit, unitPrice, p.id);
    // Everything else that shares this exact printed name is the same thing.
    const key = normalize(p.raw_name);
    const siblings = all(`SELECT * FROM finance_purchase WHERE item_id = '' AND raw_name <> ''`)
      .filter(s => normalize(s.raw_name) === key);
    for (const s of siblings) {
      const sSize = parseSize(s.raw_name)?.size || item.typical_size || (unit === 'each' ? 1 : 0);
      const sUnits = sSize * (s.qty || 1);
      run(`UPDATE finance_purchase SET item_id=?, size=?, unit=?, unit_price_base=? WHERE id=?`,
        item.id, sSize, unit, sUnits > 0 ? round4(s.line_total_base / sUnits) : 0, s.id);
    }
    return { assigned: 1 + siblings.length, item: outItem(item) };
  });
}

/**
 * Forget price observations belonging to a deleted transaction or receipt.
 *
 * Without this, deleting a bad ledger row leaves its price behind forever: a phantom
 * "お茶 ¥400" that doubled a receipt keeps counting toward what tea "usually" costs, and
 * `priceProbe()` then uses the hallucination as the prior it judges future scans against.
 * A price observation is only meaningful while the purchase it came from exists.
 */
export function deletePurchasesForTxn(txnId) {
  const id = String(txnId || '');
  if (!id) return 0;
  return run('DELETE FROM finance_purchase WHERE txn_id = ?', id).changes;
}

export function deletePurchasesForReceipt(receiptId) {
  const id = String(receiptId || '');
  if (!id) return 0;
  return run('DELETE FROM finance_purchase WHERE receipt_id = ?', id).changes;
}

/**
 * Sweep observations whose transaction no longer exists.
 *
 * `deleteTxn` forgets prices as of 2026-07-27, but databases written before that still
 * carry orphans — and they are the worst kind of wrong data, because they are invisible:
 * the ledger looks right while an item's price history quietly includes a row the user
 * deleted precisely *because* it was a hallucination. Found exactly one on this machine
 * (a phantom お茶 at ¥1650 whose ledger row had been deleted by hand).
 *
 * Only rows that name a transaction are candidates — a purchase with `txn_id = ''` was
 * recorded without one on purpose and is still valid.
 */
export function purgeOrphanedPurchases() {
  return run(`DELETE FROM finance_purchase
              WHERE txn_id <> ''
                AND NOT EXISTS (SELECT 1 FROM finance_txn t WHERE t.id = finance_purchase.txn_id AND t.deleted = 0)`).changes;
}

/** Discard observations outright — the review queue's "this was never a product". */
export function dropPurchases(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) throw bad('ids must be a non-empty array');
  return tx(() => {
    let n = 0;
    for (const id of list) n += run('DELETE FROM finance_purchase WHERE id = ?', id).changes;
    return { dropped: n };
  });
}

/** Assign a whole group of observations in one call — the bulk review path. A grocery
 *  receipt produces twenty lines, and twenty round trips to file them is the reason
 *  nobody files them. */
export function assignPurchases(pairs) {
  const list = (Array.isArray(pairs) ? pairs : []).filter(p => p?.purchaseId && p?.itemId);
  if (!list.length) throw bad('pairs must be a non-empty array of { purchaseId, itemId }');
  const out = { assigned: 0, failed: [] };
  for (const p of list) {
    try { out.assigned += assignPurchase(p.purchaseId, p.itemId, { confirm: true }).assigned; }
    catch (e) { out.failed.push({ purchaseId: p.purchaseId, error: e.message }); }
  }
  return out;
}

/** Line items nobody has classified yet, newest first, grouped by printed name so
 *  the review queue asks once per name rather than once per purchase. */
export function unresolved({ limit = 40 } = {}) {
  const rows = all(`SELECT * FROM finance_purchase WHERE item_id = '' ORDER BY date DESC, created_at DESC LIMIT 400`);
  const groups = new Map();
  for (const r of rows) {
    const key = normalize(r.raw_name);
    if (!groups.has(key)) {
      groups.set(key, {
        norm: key, rawName: r.raw_name, purchaseIds: [], count: 0,
        lastDate: r.date, merchants: new Set(), lastPrice: r.line_total_base,
      });
    }
    const g = groups.get(key);
    g.purchaseIds.push(r.id);
    g.count++;
    if (r.merchant) g.merchants.add(r.merchant);
  }
  return [...groups.values()].slice(0, Math.min(limit, 200)).map(g => ({
    norm: g.norm, rawName: g.rawName, purchaseIds: g.purchaseIds, count: g.count,
    lastDate: g.lastDate, lastPrice: g.lastPrice, merchants: [...g.merchants],
    suggestions: candidates(g.rawName, { limit: 4 }),
  }));
}

// ---------- price analytics ----------

const median = (arr) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Per-merchant price picture for one item — the "where should I buy this" table.
 *  Ranked on the MEDIAN unit price, not the best-ever: one loss-leader week should
 *  not crown a shop you would otherwise pay more at. */
export function itemMerchants(itemId) {
  const rows = all(`SELECT * FROM finance_purchase WHERE item_id = ? AND unit_price_base > 0
                    ORDER BY date`, String(itemId || ''));
  const by = new Map();
  for (const r of rows) {
    const key = r.merchant || '(unknown)';
    if (!by.has(key)) by.set(key, { merchant: key, prices: [], last: null, lastDate: '', count: 0 });
    const g = by.get(key);
    g.prices.push(r.unit_price_base);
    g.count++;
    if (!g.lastDate || r.date >= g.lastDate) { g.lastDate = r.date; g.last = r.unit_price_base; }
  }
  const out = [...by.values()].map(g => ({
    merchant: g.merchant, count: g.count,
    best: round4(Math.min(...g.prices)),
    median: round4(median(g.prices)),
    latest: round4(g.last), lastDate: g.lastDate,
  })).sort((a, b) => a.median - b.median);

  const cheapest = out.find(m => m.count >= 2) || out[0] || null;
  const dearest = out.length > 1 ? out[out.length - 1] : null;
  return {
    merchants: out,
    cheapest,
    // Only claim a saving when two shops have both been sampled more than once,
    // otherwise it is noise dressed up as advice.
    saving: cheapest && dearest && cheapest !== dearest && cheapest.count >= 2 && dearest.count >= 2
      ? { pct: Math.round((1 - cheapest.median / dearest.median) * 100), vs: dearest.merchant }
      : null,
  };
}

export function itemPurchases(itemId, { limit = 200 } = {}) {
  return all(`SELECT * FROM finance_purchase WHERE item_id = ? ORDER BY date DESC, created_at DESC LIMIT ?`,
    String(itemId || ''), Math.min(limit, 1000)).map(outPurchase);
}

/** Everything the item detail view needs. */
export function itemDetail(itemId) {
  const item = getItem(itemId);
  const purchases = itemPurchases(itemId);
  const priced = purchases.filter(p => p.unitPriceBase > 0);
  const merchants = itemMerchants(itemId);
  const byDate = priced.slice().reverse();

  // Trend: median of the oldest third vs the newest third, so a single outlier
  // does not read as a price rise.
  let trendPct = null;
  if (byDate.length >= 4) {
    const n = Math.max(2, Math.floor(byDate.length / 3));
    const first = median(byDate.slice(0, n).map(p => p.unitPriceBase));
    const last = median(byDate.slice(-n).map(p => p.unitPriceBase));
    if (first > 0) trendPct = Math.round((last / first - 1) * 100);
  }
  const prices = priced.map(p => p.unitPriceBase);
  return {
    item, currency: settings().baseCurrency,
    stats: {
      timesBought: purchases.length,
      totalSpent: round2(purchases.reduce((s, p) => s + p.lineTotalBase, 0)),
      best: prices.length ? round4(Math.min(...prices)) : 0,
      worst: prices.length ? round4(Math.max(...prices)) : 0,
      median: round4(median(prices)),
      latest: byDate.length ? round4(byDate[byDate.length - 1].unitPriceBase) : 0,
      firstSeen: byDate[0]?.date || '',
      lastSeen: byDate.length ? byDate[byDate.length - 1].date : '',
      trendPct,
    },
    merchants: merchants.merchants,
    cheapest: merchants.cheapest,
    saving: merchants.saving,
    series: byDate.map(p => ({ date: p.date, unitPrice: p.unitPriceBase, merchant: p.merchant })),
    purchases,
    aliases: aliasesFor(itemId),
  };
}

/** The catalogue with prices attached — the Items list. */
export function listItems({ search = '', category = '', sort = 'recent', limit = 200 } = {}) {
  const where = ['i.deleted = 0'];
  const args = [];
  if (category) { where.push('i.category = ?'); args.push(String(category)); }
  if (search) {
    const like = `%${String(search).slice(0, 60)}%`;
    where.push(`(i.name_en LIKE ? COLLATE NOCASE OR i.name_ja LIKE ?
       OR EXISTS (SELECT 1 FROM finance_item_alias a WHERE a.item_id = i.id AND a.raw LIKE ?))`);
    args.push(like, like, like);
  }
  const items = all(`SELECT * FROM finance_item i WHERE ${where.join(' AND ')}`, ...args);
  if (!items.length) return { currency: settings().baseCurrency, items: [], categories: itemCategories() };

  // One pass over purchases beats N queries; the catalogue is small enough that
  // holding it in memory is cheaper than the round trips.
  const buys = all(`SELECT item_id, date, merchant, unit_price_base, line_total_base
                    FROM finance_purchase WHERE item_id <> '' ORDER BY date`);
  const byItem = new Map();
  for (const b of buys) {
    if (!byItem.has(b.item_id)) byItem.set(b.item_id, []);
    byItem.get(b.item_id).push(b);
  }

  const out = items.map(r => {
    const list = byItem.get(r.id) || [];
    const priced = list.filter(b => b.unit_price_base > 0);
    const prices = priced.map(b => b.unit_price_base);
    const last = list[list.length - 1] || null;
    const bestRow = priced.length
      ? priced.reduce((a, b) => (b.unit_price_base < a.unit_price_base ? b : a)) : null;
    return {
      ...outItem(r),
      timesBought: list.length,
      totalSpent: round2(list.reduce((s, b) => s + b.line_total_base, 0)),
      lastDate: last?.date || '',
      lastMerchant: last?.merchant || '',
      lastUnitPrice: last ? round4(last.unit_price_base) : 0,
      bestUnitPrice: bestRow ? round4(bestRow.unit_price_base) : 0,
      bestMerchant: bestRow?.merchant || '',
      medianUnitPrice: round4(median(prices)),
      spark: priced.slice(-12).map(b => b.unit_price_base),
    };
  });

  const sorters = {
    recent: (a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''),
    most: (a, b) => b.timesBought - a.timesBought,
    spend: (a, b) => b.totalSpent - a.totalSpent,
    name: (a, b) => a.nameEn.localeCompare(b.nameEn),
    // Biggest gap between what you have paid and the best you have found.
    saving: (a, b) => (b.medianUnitPrice - b.bestUnitPrice) * b.timesBought
      - (a.medianUnitPrice - a.bestUnitPrice) * a.timesBought,
  };
  out.sort(sorters[sort] || sorters.recent);
  return {
    currency: settings().baseCurrency,
    items: out.slice(0, Math.min(limit, 1000)),
    categories: itemCategories(),
    unresolvedCount: one(`SELECT COUNT(*) AS n FROM finance_purchase WHERE item_id = ''`)?.n || 0,
  };
}

export const itemCategories = () =>
  all(`SELECT DISTINCT category FROM finance_item WHERE deleted = 0 ORDER BY category`).map(r => r.category);

/** Fold one item into another: aliases and purchases move, the loser is retired.
 *  This is the repair path for when the model created a near-duplicate. */
export function mergeItems(fromId, intoId) {
  if (fromId === intoId) throw bad('cannot merge an item into itself');
  const from = one('SELECT * FROM finance_item WHERE id = ?', String(fromId || ''));
  const into = one('SELECT * FROM finance_item WHERE id = ? AND deleted = 0', String(intoId || ''));
  if (!from || !into) throw missing('item not found');
  return tx(() => {
    run(`UPDATE finance_item_alias SET item_id = ?, updated_at = ? WHERE item_id = ?`, into.id, now(), from.id);
    run(`UPDATE finance_purchase SET item_id = ? WHERE item_id = ?`, into.id, from.id);
    run(`UPDATE finance_item SET deleted = 1, updated_at = ? WHERE id = ?`, now(), from.id);
    return { merged: from.name_en, into: into.name_en };
  });
}
