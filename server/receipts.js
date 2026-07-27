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
import { loadConfig, saveConfig } from './config.js';
import { visionModels, refSeesImages } from './llmctl.js';
import { extractJSON, id as genId, now } from './util.js';
import { all, one, run, tx, parseJSON } from './financedb.js';
import * as finance from './finance.js';
import * as items from './items.js';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const missing = (msg) => Object.assign(new Error(msg), { status: 404 });

const SYSTEM = `You transcribe receipts. You are a careful transcriber, not an assistant: you report only what is legibly printed on the image, and you return STRICT JSON. Never wrap the JSON in markdown fences. Never add commentary after it.

Inventing a line that is not printed is the single worst thing you can do — it puts money into someone's accounts that they never spent. When you cannot read something, omit it or use null. An incomplete honest reading is useful; a complete invented one is not.`;

const SCHEMA_PROMPT = `Read this receipt image and return ONLY this JSON object:

{
  "merchant": string|null,
  "date": "YYYY-MM-DD"|null,
  "time": "HH:MM"|null,
  "currency": string|null,          // ISO code, inferred from the language/symbols/locale
  "category": string|null,          // best guess from: {CATEGORIES}
  "items": [ { "printed": string, "name": string, "qty": number, "amount": number } ],
  "subtotal": number|null,
  "tax": number|null,
  "total": number|null,
  "payment_method": string|null
}

Rules for "items" — read these twice:
- One entry per product line PRINTED on the receipt. Never add a line that is not there.
  Do not infer what a shop "probably" sold. Do not pad the list to look complete.
- "printed" is the line EXACTLY as it appears, characters unchanged, including Japanese.
  "name" is the same thing tidied into a readable product name. If you cannot make out
  the characters, omit the whole entry rather than guessing at it.
- Skip lines that are not products: subtotal, tax, total, change, rounding, points,
  loyalty balances, payment method, bag charges shown as a discount, and any header
  or footer text.
- "amount" is the LINE total for that entry, not the unit price, and never more than
  the receipt's own total.
- The line amounts must add up to the subtotal (or to total minus tax). Add them up
  yourself before answering. If your list does not reconcile, you have either invented
  a line or misread a number — fix it rather than returning it.

Other rules:
- Amounts are plain numbers: no currency symbols, no thousands separators.
- If the receipt shows no explicit year, use {YEAR}.
- "total" is the amount actually charged. If only a subtotal is printed, put it in "total" too.
{LEARNED}`;

// Lines the user has repeatedly deleted become a standing instruction. Cheap, bounded,
// and it attacks the failure directly: this model invents the same phantom lines.
function learnedPromptBlock() {
  const rows = all(`SELECT raw_display, SUM(hits) AS hits FROM finance_receipt_fix
                    WHERE kind = 'drop' AND raw_display <> ''
                    GROUP BY raw ORDER BY hits DESC LIMIT 12`);
  if (!rows.length) return '';
  const list = rows.map(r => JSON.stringify(r.raw_display)).join(', ');
  return `\n- These have been corrected before and are NOT product lines on any receipt`
    + ` — never output them as items: ${list}.`;
}

/**
 * The model to OCR with, and it has to be one that can see.
 *
 * This used to fall back to `defaults.chatModel`, which on this machine is a
 * text-only 9B: the image was dropped on the floor, the model answered from the
 * prompt alone, and the user got "the model did not return usable JSON" — a parse
 * error for what was really a configuration problem. Now an unset value auto-selects
 * the best local vision model and *persists* it, and a text-only choice is refused
 * with something the user can act on.
 */
function ocrModel() {
  const cfg = loadConfig();
  const configured = String(cfg.finance?.ocrModel || '').trim();
  if (configured) {
    if (refSeesImages(configured) === false) {
      throw bad(`the receipt-reading model (${configured}) has no vision projector, so it cannot read an image. `
        + 'Pick a vision model in Settings → Finances, or pair one with an mmproj in Settings → Models.');
    }
    return configured;
  }

  const pick = visionModels()[0];
  if (pick) {
    // Persist it: the next scan should not have to work this out again, and the user
    // should be able to see in Settings which model reads their receipts.
    const c = loadConfig();
    c.finance = { ...(c.finance || {}), ocrModel: pick.ref };
    saveConfig();
    console.log(`[receipts] no OCR model was set — selected ${pick.file} (vision via ${pick.mmproj}) and saved it to config`);
    return pick.ref;
  }

  const chat = String(cfg.defaults?.chatModel || '').trim();
  if (chat && refSeesImages(chat) !== false) return chat;   // a cloud/unknown model may well see
  throw bad('no vision-capable model is configured. Pair a model with an mmproj projector in '
    + 'Settings → Models, then choose it under Settings → Finances → receipt reading '
    + '(or point receipt reading at an Anthropic model).');
}

const outReceipt = (r) => r && ({
  id: r.id, uploadId: r.upload_id, status: r.status, model: r.model,
  parsed: parseJSON(r.parsed, null), error: r.error,
  // What the model originally said, when the user has since edited it. The review UI
  // shows "you changed this" against it, and apply() diffs it to learn.
  parsedAi: r.parsed_ai ? parseJSON(r.parsed_ai, null) : null,
  edited: !!r.parsed_ai,
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
  run(`INSERT INTO finance_receipt (id, upload_id, status, model, raw, parsed, parsed_ai, error, txn_ids, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, model=excluded.model,
         raw=excluded.raw, parsed=excluded.parsed, parsed_ai=excluded.parsed_ai,
         error=excluded.error, txn_ids=excluded.txn_ids, updated_at=excluded.updated_at`,
    rec.id, rec.upload_id, rec.status, rec.model, rec.raw, rec.parsed, rec.parsed_ai || '',
    rec.error, rec.txn_ids, rec.created_at, rec.updated_at);
  return outReceipt(rec);
}

/** Run OCR over an uploaded image and store the structured result.
 *  Does NOT write to the ledger — the user reviews first, then calls apply(). */
export async function scan({ uploadId, model, signal } = {}) {
  const meta = getMeta(String(uploadId || ''));
  if (!meta) throw missing('upload not found — attach the image first');
  if (meta.kind !== 'image') throw bad(`receipt scanning needs a photo, but that upload is ${meta.kind === 'pdf' ? 'a PDF' : meta.kind === 'text' ? 'a text file' : `a ${meta.mime}`}.`);
  if (meta.unreadable) throw bad(`that photo is a ${meta.convertedFrom || meta.mime} and could not be converted to JPEG on this machine `
    + '— install ffmpeg (or set uploads.ffmpeg to its path) and try again.');

  const modelRef = String(model || ocrModel());
  if (!modelRef) throw bad('no model configured — set finance.ocrModel or a default chat model in Settings');

  const cfg = finance.settings();
  const prompt = SCHEMA_PROMPT
    .replace('{CATEGORIES}', cfg.expenseCategories.join(', '))
    .replace('{YEAR}', new Date().getFullYear())
    .replace('{LEARNED}', learnedPromptBlock());

  const rec = {
    id: genId(8), upload_id: meta.id, status: 'pending', model: modelRef,
    raw: '', parsed: '', parsed_ai: '', error: '', txn_ids: '[]',
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
  const parsed = normalize(extractJSON(text, { require: ['total', 'merchant', 'items'] }), cfg);
  if (!parsed) {
    rec.status = 'failed';
    rec.error = 'the model did not return usable JSON — try a vision-capable model';
    rec.updated_at = now();
    return save(rec);
  }
  // Replay what the user has already taught us about this shop before showing them the
  // scan — the point of a correction loop is not having to make the same edit twice.
  rec.status = 'parsed';
  rec.parsed = JSON.stringify(replayFixes(parsed));
  rec.updated_at = now();
  return save(rec);
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Summary lines masquerading as products.
//
// The prompt tells the model to skip these and it still takes them — observed live: a
// receipt whose only line came back as `小計 1点 ￥300` ("subtotal, 1 item") renamed
// "Product", while the real product line was missed. That failure is invisible to the
// arithmetic check, because a subtotal by definition equals the sum it replaced.
//
// The vocabulary is small, closed, and printed the same way on every receipt in a
// language — but matching the keyword alone is not enough. `カード型ケース` (a card case)
// and `Card case` are real products that merely START with one, so the test is: the line
// must be the keyword and *nothing but* numbers, currency and counters after it. A real
// product line always carries more words than that.
const SUMMARY_KEYWORD = new RegExp([
  '^(?:',
  // Japanese receipts
  '小計|合計|総計|税抜|税込|外税|内税|消費税|課税|非課税|対象額|軽減税率|',
  'お預り|預り|お預かり|お釣り|釣銭|釣り|現金|クレジット|カード|電子マネー|ポイント|',
  '値引|割引|返品|レジ袋|袋代|お買上げ|点数|品数|伝票番号|伝票|領収証|レシート|',
  // Latin receipts
  'sub[- ]?total|total|tax|vat|gst|change|cash|credit|card|tender|rounding|',
  'points?|discount|balance|amount due|paid|payment|bag fee|service charge',
  ')',
].join(''), 'i');

/** Everything a summary line is allowed to carry besides its keyword. */
const stripNoise = (s) => s
  .replace(/no\.?|#|[¥￥$€£]/gi, '')                       // "No.28822", "#4", currency marks
  .replace(/[\d.,\s:：．・()（）%％*×x/\\-]/gi, '')
  .replace(/点|個|品|枚|本|items?|pcs?|qty|税|込|抜|等|円/gi, '');

function looksLikeSummary(s) {
  const t = String(s || '').trim();
  const m = SUMMARY_KEYWORD.exec(t);
  if (!m) return false;
  return stripNoise(t.slice(m[0].length)) === '';
}

/** Placeholder names a model reaches for when it cannot read the line. Useless in a
 *  catalogue, and a signal the reading is untrustworthy rather than a real product. */
const PLACEHOLDER_NAME = /^(?:product|item|unknown|n\/?a|unnamed|goods|misc(?:ellaneous)?|商品|品物|不明)$/i;

/**
 * Do the line items add up?
 *
 * This is the one hallucination check that needs no model and no history: a receipt is a
 * closed arithmetic system. The lines must sum to the subtotal, or to total minus tax
 * when no subtotal is printed. An invented line makes the sum overshoot; a missed line
 * makes it fall short. Either way the number tells you *how much* is wrong, which is far
 * more useful to a reviewer than a vague "check this".
 *
 * Tolerance is the larger of 1 currency unit and 1% — Japanese receipts round per-line
 * consumption tax, so exact equality is not a fair test.
 */
function reconcile(items, { subtotal, tax, total }) {
  const sum = round2(items.reduce((s, i) => s + (Number(i.amount) || 0), 0));
  const expected = subtotal !== null && subtotal !== undefined ? subtotal
    : (total !== null && tax !== null ? round2(total - tax) : total);
  // No lines is a legitimate reading (the model saw only a total), and no printed
  // subtotal means there is nothing to check against. Both are "fine", but the UI needs
  // to tell them apart from a receipt whose lines genuinely balance.
  if (!items.length) return { itemsSum: 0, expected: expected ?? null, delta: 0, ok: true, verdict: 'no-items' };
  if (expected === null || expected === undefined) {
    return { itemsSum: sum, expected: null, delta: 0, ok: true, verdict: 'unchecked' };
  }
  const delta = round2(sum - expected);
  const tol = Math.max(1, Math.abs(expected) * 0.01);
  if (Math.abs(delta) <= tol) return { itemsSum: sum, expected, delta, ok: true, verdict: 'balanced' };
  return {
    itemsSum: sum, expected, delta, ok: false,
    verdict: delta > 0 ? 'overshoot' : 'short',
  };
}

/** Per-line sanity, in plain language, for the reviewer to act on.
 *  `lines`, not `items` — the module import of that name is what supplies the price prior. */
function annotate(lines, total) {
  return lines.map((it) => {
    const warn = [];
    if (total !== null && it.amount > total + 1) {
      warn.push(`${it.amount} is more than the receipt total (${total}) — this line is probably not real`);
    }
    let probe = null;
    try { probe = items.priceProbe(it.printed || it.name); } catch { /* no history yet */ }
    if (probe) {
      const each = round2(it.amount / Math.max(1, it.qty));
      if (each > probe.median * 4) warn.push(`usually around ${probe.median} each (${probe.n} past buys) — this reads ${each}`);
      else if (each * 4 < probe.median) warn.push(`usually around ${probe.median} each (${probe.n} past buys) — this reads ${each}`);
    }
    return warn.length ? { ...it, warn } : it;
  });
}

/**
 * Coerce the model's object into the shape the ledger expects.
 *
 * `trust: true` means a human typed this (the review editor), so lines are kept exactly
 * as given — no auto-dropping. The user is the point of truth; second-guessing their
 * edit is how a review UI loses the user's confidence.
 */
export function normalizeParsed(obj, cfg = finance.settings(), opts = {}) { return normalize(obj, cfg, opts); }
export { reconcile as reconcileItems };

function normalize(obj, cfg, { trust = false } = {}) {
  if (!obj || typeof obj !== 'object') return null;
  const numOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) && n !== 0 ? Math.abs(n) : null;
  };
  let items = (Array.isArray(obj.items) ? obj.items : []).slice(0, 100).map(it => {
    const printed = String(it?.printed ?? it?.name ?? '').trim().slice(0, 200);
    let name = String(it?.name ?? it?.printed ?? '').trim().slice(0, 120);
    // "Product"/"商品" tells us nothing and would pollute the catalogue. The printed
    // text is always more useful than a placeholder, even untidied.
    if (PLACEHOLDER_NAME.test(name) && printed) name = printed;
    return { printed, name, qty: Math.max(1, Math.trunc(Number(it?.qty) || 1)), amount: numOrNull(it?.amount) };
  }).filter(it => it.name && it.amount !== null);

  const subtotal = numOrNull(obj.subtotal);
  const tax = numOrNull(obj.tax);
  const total = numOrNull(obj.total) ?? subtotal
    ?? (items.length ? round2(items.reduce((s, i) => s + i.amount, 0)) : null);
  if (total === null) return null;                     // nothing usable to log

  // Two deterministic drops, both surfaced in `dropped` so the reviewer can put a line
  // back. Everything else is flagged rather than removed — silently binning a real line
  // is the worse failure.
  const dropped = [];
  if (!trust) {
    const keep = [];
    for (const it of items) {
      // A receipt's own summary line is not something you bought.
      if (looksLikeSummary(it.printed) || looksLikeSummary(it.name)) {
        dropped.push({ ...it, why: 'a summary line, not a product' });
      // A single line worth more than the whole receipt cannot be right.
      } else if (items.length > 1 && it.amount > total + 1) {
        dropped.push({ ...it, why: 'more than the receipt total' });
      } else keep.push(it);
    }
    items = keep;
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(obj.date || '')) ? obj.date : new Date().toISOString().slice(0, 10);
  const currency = /^[A-Za-z]{3}$/.test(String(obj.currency || ''))
    ? String(obj.currency).toUpperCase() : cfg.baseCurrency;
  const category = cfg.expenseCategories.includes(obj.category) ? obj.category : 'Uncategorized';

  const out = {
    merchant: String(obj.merchant ?? '').trim().slice(0, 120),
    date, time: String(obj.time ?? '').slice(0, 5),
    currency, category,
    items: annotate(items, total),
    subtotal, tax, total,
    paymentMethod: String(obj.payment_method ?? obj.paymentMethod ?? '').trim().slice(0, 60),
  };
  out.check = reconcile(out.items, out);
  if (dropped.length) out.dropped = dropped;
  return out;
}

// ---------- the correction loop ----------
//
// The user's edit is the point of truth. Recording it does two jobs:
//   1. Deterministic replay — the same phantom line at the same shop gets dropped next
//      time with no model involved. `hits >= AUTO_FIX_AFTER` is the gate, so one odd
//      misread never becomes a standing rule.
//   2. A standing prompt instruction for the worst offenders (learnedPromptBlock).
// Item *naming* is not stored here: that already has a home in the catalogue's
// confirmed-alias mechanism, which is authoritative by design.

const AUTO_FIX_AFTER = 2;                     // corrections needed before we replay one
const fixKey = (s) => items.normalize(String(s || ''));

/** Record (or reinforce) one correction. */
export function learnFix({ merchant, kind, raw, aiValue = '', userValue = '' }) {
  const key = fixKey(raw);
  if (!key || !['drop', 'rename', 'amount'].includes(kind)) return null;
  const m = fixKey(merchant) || '';
  run(`INSERT INTO finance_receipt_fix (id, merchant, kind, raw, raw_display, ai_value, user_value, hits, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,1,?,?)
       ON CONFLICT(merchant, kind, raw) DO UPDATE SET
         hits = hits + 1, ai_value = excluded.ai_value,
         user_value = excluded.user_value, updated_at = excluded.updated_at`,
    genId(10), m, kind, key, String(raw || '').slice(0, 200),
    String(aiValue).slice(0, 200), String(userValue).slice(0, 200), now(), now());
  return { merchant: m, kind, raw: key };
}

/** Corrections trusted enough to replay, for one merchant (plus the global ones). */
export function fixesFor(merchant, { limit = 40 } = {}) {
  const m = fixKey(merchant) || '';
  return all(`SELECT * FROM finance_receipt_fix
              WHERE (merchant = ? OR merchant = '') AND hits >= ?
              ORDER BY hits DESC LIMIT ?`, m, AUTO_FIX_AFTER, limit);
}

/** Everything learned, for the Settings/receipts transparency view. */
export function listFixes({ limit = 200 } = {}) {
  return all('SELECT * FROM finance_receipt_fix ORDER BY hits DESC, updated_at DESC LIMIT ?', limit)
    .map(f => ({
      id: f.id, merchant: f.merchant, kind: f.kind, raw: f.raw_display,
      aiValue: f.ai_value, userValue: f.user_value, hits: f.hits,
      active: f.hits >= AUTO_FIX_AFTER, updatedAt: f.updated_at,
    }));
}

export function forgetFix(id) {
  if (!run('DELETE FROM finance_receipt_fix WHERE id = ?', String(id || '')).changes) {
    throw missing('correction not found');
  }
}

/** Replay learned corrections over a fresh scan. Deterministic — no model call. */
export function replayFixes(parsed) {
  const fixes = fixesFor(parsed.merchant);
  if (!fixes.length) return parsed;
  const drops = new Map(fixes.filter(f => f.kind === 'drop').map(f => [f.raw, f]));
  const renames = new Map(fixes.filter(f => f.kind === 'rename').map(f => [f.raw, f]));

  const applied = [];
  const kept = [];
  for (const it of parsed.items) {
    const key = fixKey(it.printed || it.name);
    if (drops.has(key)) {
      applied.push({ kind: 'drop', line: it.printed || it.name, hits: drops.get(key).hits });
      continue;
    }
    const ren = renames.get(key);
    if (ren && ren.user_value && ren.user_value !== it.name) {
      applied.push({ kind: 'rename', line: it.printed || it.name, to: ren.user_value, hits: ren.hits });
      kept.push({ ...it, name: ren.user_value });
      continue;
    }
    kept.push(it);
  }
  if (!applied.length) return parsed;
  const out = { ...parsed, items: annotate(kept, parsed.total) };
  out.check = reconcile(out.items, out);
  out.learned = applied;
  return out;
}

/** Diff the model's original extraction against what the user settled on, and learn. */
function learnFromEdit(aiParsed, userParsed) {
  if (!aiParsed?.items) return { learned: 0 };
  const merchant = userParsed.merchant || aiParsed.merchant;
  const byKey = new Map(userParsed.items.map(it => [fixKey(it.printed || it.name), it]));
  let n = 0;

  for (const ai of aiParsed.items) {
    const key = fixKey(ai.printed || ai.name);
    const mine = byKey.get(key);
    if (!mine) {                                        // the user deleted this line
      learnFix({ merchant, kind: 'drop', raw: ai.printed || ai.name, aiValue: String(ai.amount) });
      n++;
      continue;
    }
    if (mine.name && ai.name && mine.name !== ai.name) {
      learnFix({ merchant, kind: 'rename', raw: ai.printed || ai.name, aiValue: ai.name, userValue: mine.name });
      n++;
    }
    if (Number(mine.amount) !== Number(ai.amount)) {
      learnFix({ merchant, kind: 'amount', raw: ai.printed || ai.name, aiValue: String(ai.amount), userValue: String(mine.amount) });
      n++;
    }
  }
  return { learned: n };
}

/**
 * Take an applied receipt back out of the ledger so it can be corrected and re-posted.
 *
 * The case this exists for: a receipt is logged, and only later do you notice a phantom
 * line that doubled it. Editing the ledger row alone fixes the total but leaves the
 * receipt frozen with the wrong reading — and teaches the scanner nothing. Reverting
 * puts it back in the review editor, so the correction goes through the loop that
 * remembers it (learnFromEdit on the next apply).
 *
 * Deletes the transactions it created and every price observation recorded against it,
 * so a hallucinated price cannot survive as a prior. The scan itself, and the photo, stay.
 */
export function revertReceipt(id) {
  const row = one('SELECT * FROM finance_receipt WHERE id = ?', String(id || ''));
  if (!row) throw missing('receipt not found');
  if (row.status !== 'applied') throw bad('this receipt is not in the ledger yet — edit it directly');

  const txnIds = parseJSON(row.txn_ids, []);
  const undone = tx(() => {
    let n = 0;
    for (const t of txnIds) {
      try { finance.deleteTxn(t); n++; }
      catch { /* already gone by hand — reverting the rest is still correct */ }
    }
    // Purchases tied to the receipt rather than to one row (the 'total' mode case).
    const prices = items.deletePurchasesForReceipt(row.id);
    return { transactions: n, prices };
  });

  row.status = 'parsed';
  row.txn_ids = '[]';
  row.updated_at = now();
  return { receipt: save(row), undone };
}

/**
 * Save the user's edits to a scanned receipt, before anything reaches the ledger.
 *
 * The model's original extraction is preserved in `parsed_ai` the first time an edit
 * lands, so `apply()` can diff intent-vs-reading and learn from it. Re-editing does not
 * overwrite that baseline — otherwise the second edit would look like the model got the
 * first one right.
 */
export function editReceipt(id, patch = {}) {
  const row = one('SELECT * FROM finance_receipt WHERE id = ?', String(id || ''));
  if (!row) throw missing('receipt not found');
  if (row.status === 'applied') throw bad('this receipt is already in the ledger — delete its transactions first, then edit');

  const current = parseJSON(row.parsed, null) || {};
  const merged = { ...current, ...patch };
  const clean = normalize(merged, finance.settings(), { trust: true });
  if (!clean) throw bad('a receipt needs at least a total');

  if (!row.parsed_ai) row.parsed_ai = row.parsed || '';
  row.parsed = JSON.stringify(clean);
  row.status = 'parsed';
  row.error = '';
  row.updated_at = now();
  return save(row);
}

/** Write a scanned receipt into the ledger.
 *  mode 'total'  → one transaction for the whole receipt (the default)
 *  mode 'items'  → one transaction per line item, so category analysis is finer
 *  `overrides` lets a caller correct the model inline without a separate edit call. */
export async function apply(id, { mode = 'total', overrides = {}, signal } = {}) {
  const row = one('SELECT * FROM finance_receipt WHERE id = ?', String(id || ''));
  if (!row) throw missing('receipt not found');
  if (row.status === 'applied') throw bad('this receipt has already been added to the ledger');
  const p = { ...parseJSON(row.parsed, null), ...(overrides || {}) };
  if (!p || !p.total) throw bad('receipt has not been scanned successfully yet');

  // Learn before writing: the user is committing to this reading, which is the strongest
  // signal available that the differences from the model's version were real corrections.
  let learned = { learned: 0 };
  const aiParsed = row.parsed_ai ? parseJSON(row.parsed_ai, null) : null;
  if (aiParsed) {
    try { learned = learnFromEdit(aiParsed, p); }
    catch (e) { console.error('[receipts] could not learn from the edit:', e.message); }
  }

  const base = {
    date: p.date, kind: 'expense', currency: p.currency, category: p.category,
    merchant: p.merchant, source: 'ocr', receiptId: row.id,
  };
  const created = mode === 'items' && p.items?.length
    ? p.items.map(it => finance.addTxn({ ...base, amount: it.amount, note: it.name }))
    : [finance.addTxn({ ...base, amount: p.total, note: p.paymentMethod ? `paid ${p.paymentMethod}` : '' })];

  // Price observations are recorded from the line items whatever the ledger mode:
  // logging the receipt as one total is a bookkeeping choice and should not throw
  // away the per-item prices the scan already read.
  const editedKeys = new Set(
    aiParsed
      ? p.items.filter((it) => {
        const was = aiParsed.items?.find(a => fixKey(a.printed || a.name) === fixKey(it.printed || it.name));
        return !was || was.name !== it.name || Number(was.amount) !== Number(it.amount);
      }).map(it => fixKey(it.printed || it.name))
      : [],
  );
  const priced = await recordLineItems(p, row, created, { signal, editedKeys });

  row.status = 'applied';
  row.txn_ids = JSON.stringify(created.map(t => t.id));
  row.updated_at = now();
  save(row);
  return { receipt: outReceipt(row), created, items: priced, learned };
}

/** Log each line as a price point, resolving it to a catalogue item where we can.
 *  Resolution failures are never fatal — the purchase is still stored, unassigned,
 *  and shows up in the review queue. Losing a price because the model was busy
 *  would be the worst possible trade. */
async function recordLineItems(p, row, created, { signal, editedKeys = new Set() } = {}) {
  const lines = (p.items || []).filter(it => it?.name && Number(it.amount) > 0);
  if (!lines.length) return { recorded: 0, resolved: 0 };

  // Key the catalogue on the PRINTED text, not the tidied name: the printed string is
  // what the next receipt from this shop will show, so it is the only stable join key.
  const rawOf = (l) => l.printed || l.name;

  let resolved = new Map();
  try {
    const { resolveNames } = await import('./itemsai.js');
    resolved = await resolveNames(lines.map(rawOf), { signal });
  } catch (e) {
    console.error('[receipts] item resolution unavailable:', e.message);
  }

  // When the ledger got one row per item, tie each price point to its own row so
  // deleting a transaction can be traced back to the purchase it came from.
  const txnFor = (i) => (created.length === lines.length ? created[i]?.id : created[0]?.id) || '';

  let ok = 0;
  lines.forEach((line, i) => {
    const raw = rawOf(line);
    const itemId = resolved.get(raw)?.itemId || '';
    try {
      items.recordPurchase({
        itemId,
        txnId: txnFor(i), receiptId: row.id,
        date: p.date, merchant: p.merchant, rawName: raw,
        qty: line.qty, lineTotal: line.amount, currency: p.currency,
        source: editedKeys.has(fixKey(raw)) ? 'manual' : 'ocr',
      });
      if (itemId) ok++;
      // A line the user personally edited and then committed is settled: promote its
      // alias to confirmed so the catalogue stops second-guessing this string, and so
      // priceProbe() will trust it as a prior next time.
      if (itemId && editedKeys.has(fixKey(raw))) {
        items.learnAlias(raw, itemId, { source: 'manual', confirmed: true });
      }
    } catch (e) {
      console.error('[receipts] could not record', raw, '-', e.message);
    }
  });
  return { recorded: lines.length, resolved: ok };
}
