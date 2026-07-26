// Receipt capture for the Finances app: photograph a receipt, get structured
// rows in the ledger.
//
// There is deliberately no new OCR dependency here. The managed llama.cpp
// server already runs a vision-capable Gemma 4 (see scripts/gguf/ for how the
// single-file "omni" GGUF is split into a text model + an mmproj projector),
// and llm.js already knows how to hand an upload to an OpenAI-compatible
// endpoint as an `image_url` part. Measured on the RTX 3070 Ti: a clean
// convenience-store receipt is transcribed with no errors in ~9 s at 3.8 GB
// VRAM, including the merchant, every line item, tax and total — and it infers
// the currency from context. A dedicated OCR stack (PaddleOCR, tesseract,
// dots.ocr) would add install weight and a second VRAM tenant to beat that only
// marginally on clean input.
//
// The one thing to design around: Gemma 4 is a thinking model, so it emits a
// reasoning channel before the JSON. We ask for JSON only, give it generous
// headroom, and pull the object out with extractJSON() rather than trusting the
// reply to be bare JSON.

import { streamChat } from './llm.js';
import { getMeta } from './uploads.js';
import { loadConfig } from './config.js';
import { extractJSON, id as genId, now } from './util.js';
import { all, one, run, parseJSON } from './financedb.js';
import * as finance from './finance.js';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const missing = (msg) => Object.assign(new Error(msg), { status: 404 });

const SYSTEM = `You read receipts and invoices and return STRICT JSON. Never wrap the JSON in markdown fences. Never add commentary after it. If a field is genuinely not visible on the receipt, use null — never invent a value.`;

const SCHEMA_PROMPT = `Read this receipt image and return ONLY this JSON object:

{
  "merchant": string|null,
  "date": "YYYY-MM-DD"|null,
  "time": "HH:MM"|null,
  "currency": string|null,          // ISO code, inferred from the language/symbols/locale
  "category": string|null,          // best guess from: {CATEGORIES}
  "items": [ { "name": string, "qty": number, "amount": number } ],
  "subtotal": number|null,
  "tax": number|null,
  "total": number|null,
  "payment_method": string|null
}

Rules:
- Amounts are plain numbers: no currency symbols, no thousands separators.
- "amount" on an item is the LINE total for that item, not the unit price.
- If the receipt shows no explicit year, use {YEAR}.
- "total" is the amount actually charged. If only a subtotal is printed, put it in "total" too.`;

/** The model to OCR with: the finance-specific override, else the chat default. */
function ocrModel() {
  const cfg = loadConfig();
  return String(cfg.finance?.ocrModel || cfg.defaults?.chatModel || '').trim();
}

const outReceipt = (r) => r && ({
  id: r.id, uploadId: r.upload_id, status: r.status, model: r.model,
  parsed: parseJSON(r.parsed, null), error: r.error,
  txnIds: parseJSON(r.txn_ids, []), createdAt: r.created_at, updatedAt: r.updated_at,
});

export function listReceipts({ limit = 30 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
  return all('SELECT * FROM finance_receipt ORDER BY created_at DESC LIMIT ?', n).map(outReceipt);
}

export function getReceipt(id) {
  const r = one('SELECT * FROM finance_receipt WHERE id = ?', String(id || ''));
  if (!r) throw missing('receipt not found');
  return outReceipt(r);
}

export function deleteReceipt(id) {
  const r = run('DELETE FROM finance_receipt WHERE id = ?', String(id || ''));
  if (!r.changes) throw missing('receipt not found');
}

function save(rec) {
  run(`INSERT INTO finance_receipt (id, upload_id, status, model, raw, parsed, error, txn_ids, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, model=excluded.model,
         raw=excluded.raw, parsed=excluded.parsed, error=excluded.error,
         txn_ids=excluded.txn_ids, updated_at=excluded.updated_at`,
    rec.id, rec.upload_id, rec.status, rec.model, rec.raw, rec.parsed,
    rec.error, rec.txn_ids, rec.created_at, rec.updated_at);
  return outReceipt(rec);
}

/** Run OCR over an uploaded image and store the structured result.
 *  Does NOT write to the ledger — the user reviews first, then calls apply(). */
export async function scan({ uploadId, model, signal } = {}) {
  const meta = getMeta(String(uploadId || ''));
  if (!meta) throw missing('upload not found — attach the image first');
  if (meta.kind !== 'image') throw bad(`receipt scanning needs an image, got ${meta.kind || meta.mime}`);

  const modelRef = String(model || ocrModel());
  if (!modelRef) throw bad('no model configured — set finance.ocrModel or a default chat model in Settings');

  const cfg = finance.settings();
  const prompt = SCHEMA_PROMPT
    .replace('{CATEGORIES}', cfg.expenseCategories.join(', '))
    .replace('{YEAR}', new Date().getFullYear());

  const rec = {
    id: genId(8), upload_id: meta.id, status: 'pending', model: modelRef,
    raw: '', parsed: '', error: '', txn_ids: '[]',
    created_at: now(), updated_at: now(),
  };
  save(rec);

  let res;
  try {
    res = await streamChat({
      modelRef,
      system: SYSTEM,
      messages: [{ role: 'user', text: prompt, attachments: [meta] }],
      // Thinking models spend a few hundred tokens reasoning before the JSON;
      // a tight cap truncates the object mid-way and looks like a parse failure.
      maxTokens: 2400,
      sampling: { temperature: 0 },
      signal,
    });
  } catch (e) {
    rec.status = 'failed'; rec.error = e.message; rec.updated_at = now();
    return save(rec);
  }

  // Some local builds route the whole reply through the reasoning channel when a
  // thinking template is active, so fall back to it rather than reporting an
  // empty answer.
  const text = res.text || res.reasoning || '';
  rec.raw = String(text).slice(0, 20000);
  const parsed = normalize(extractJSON(text), cfg);
  if (!parsed) {
    rec.status = 'failed';
    rec.error = 'the model did not return usable JSON — try a vision-capable model';
    rec.updated_at = now();
    return save(rec);
  }
  rec.status = 'parsed';
  rec.parsed = JSON.stringify(parsed);
  rec.updated_at = now();
  return save(rec);
}

/** Coerce the model's object into the shape the ledger expects, dropping
 *  anything implausible rather than letting it reach the database. */
function normalize(obj, cfg) {
  if (!obj || typeof obj !== 'object') return null;
  const numOrNull = (v) => {
    const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) && n !== 0 ? Math.abs(n) : null;
  };
  const items = (Array.isArray(obj.items) ? obj.items : []).slice(0, 100).map(it => ({
    name: String(it?.name ?? '').trim().slice(0, 120),
    qty: Math.max(1, Math.trunc(Number(it?.qty) || 1)),
    amount: numOrNull(it?.amount),
  })).filter(it => it.name && it.amount !== null);

  const total = numOrNull(obj.total) ?? numOrNull(obj.subtotal)
    ?? (items.length ? Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100 : null);
  if (total === null) return null;                     // nothing usable to log

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(obj.date || '')) ? obj.date : new Date().toISOString().slice(0, 10);
  const currency = /^[A-Za-z]{3}$/.test(String(obj.currency || ''))
    ? String(obj.currency).toUpperCase() : cfg.baseCurrency;
  const category = cfg.expenseCategories.includes(obj.category) ? obj.category : 'Uncategorized';

  return {
    merchant: String(obj.merchant ?? '').trim().slice(0, 120),
    date, time: String(obj.time ?? '').slice(0, 5),
    currency, category, items,
    subtotal: numOrNull(obj.subtotal), tax: numOrNull(obj.tax), total,
    paymentMethod: String(obj.payment_method ?? '').trim().slice(0, 60),
  };
}

/** Write a scanned receipt into the ledger.
 *  mode 'total'  → one transaction for the whole receipt (the default)
 *  mode 'items'  → one transaction per line item, so category analysis is finer
 *  `overrides` lets the review UI correct the model before anything is saved. */
export function apply(id, { mode = 'total', overrides = {} } = {}) {
  const row = one('SELECT * FROM finance_receipt WHERE id = ?', String(id || ''));
  if (!row) throw missing('receipt not found');
  if (row.status === 'applied') throw bad('this receipt has already been added to the ledger');
  const p = { ...parseJSON(row.parsed, null), ...(overrides || {}) };
  if (!p || !p.total) throw bad('receipt has not been scanned successfully yet');

  const base = {
    date: p.date, kind: 'expense', currency: p.currency, category: p.category,
    merchant: p.merchant, source: 'ocr', receiptId: row.id,
  };
  const created = mode === 'items' && p.items?.length
    ? p.items.map(it => finance.addTxn({ ...base, amount: it.amount, note: it.name }))
    : [finance.addTxn({ ...base, amount: p.total, note: p.paymentMethod ? `paid ${p.paymentMethod}` : '' })];

  row.status = 'applied';
  row.txn_ids = JSON.stringify(created.map(t => t.id));
  row.updated_at = now();
  save(row);
  return { receipt: outReceipt(row), created };
}
