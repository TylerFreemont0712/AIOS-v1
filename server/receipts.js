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

import { createHash } from 'node:crypto';
import { streamChat } from './llm.js';
import * as uploads from './uploads.js';
const { getMeta } = uploads;
import { loadConfig, saveConfig } from './config.js';
import { visionModels, refSeesImages, refIsTranscriber } from './llmctl.js';
import { extractJSON, id as genId, now } from './util.js';
import { all, one, run, tx, parseJSON } from './financedb.js';
import * as finance from './finance.js';
import * as items from './items.js';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const missing = (msg) => Object.assign(new Error(msg), { status: 404 });

const SYSTEM = `You transcribe receipts. You are a careful transcriber, not an assistant: you report only what is legibly printed on the image, and you return STRICT JSON. Never wrap the JSON in markdown fences. Never add commentary after it.

Inventing a line that is not printed is the single worst thing you can do — it puts money into someone's accounts that they never spent. When you cannot read something, omit it or use null. An incomplete honest reading is useful; a complete invented one is not.`;

/**
 * The shape, enforced by the decoder rather than requested in prose.
 *
 * llama.cpp compiles this to a GBNF grammar and masks any token that would break it, so
 * "the model did not return usable JSON" stops being a possible outcome. That failure was
 * real and common here: the model would spend its whole budget narrating ("Here's a
 * thinking process to arrive at the desired JSON output: 1. Analyze the Request…") and
 * get truncated before the object started.
 *
 * Nullable fields are `["string","null"]` unions because strict mode requires every
 * property in `required` — a field the receipt genuinely lacks has to be expressible as
 * null rather than omitted.
 */
const RECEIPT_SCHEMA = {
  name: 'receipt',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['merchant', 'date', 'time', 'currency', 'category', 'items', 'subtotal', 'tax', 'total', 'payment_method'],
    properties: {
      merchant: { type: ['string', 'null'] },
      date: { type: ['string', 'null'] },
      time: { type: ['string', 'null'] },
      currency: { type: ['string', 'null'] },
      category: { type: ['string', 'null'] },
      items: {
        type: 'array',
        // Bounded on purpose. A grammar guarantees the shape but not termination: the
        // 12B, given an unbounded array, decoded 6,876 tokens of line items on a
        // one-item receipt and never stopped. normalize() slices to 100 anyway, so
        // saying so in the grammar costs nothing and turns a hang into a result.
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['printed', 'name', 'qty', 'amount'],
          properties: {
            // No `code` field here, though Japanese receipts print a JAN barcode above
            // every line and digits ought to OCR better than katakana. Tried it and
            // measured the result: 0 of 4 codes captured, and asking degraded everything
            // else — the total came back 3302 against a real 2302 with amounts shuffled
            // between lines. This model gets worse the more you ask of it per pass.
            printed: { type: 'string' },
            name: { type: 'string' },
            qty: { type: 'number' },
            amount: { type: 'number' },
          },
        },
      },
      subtotal: { type: ['number', 'null'] },
      tax: { type: ['number', 'null'] },
      total: { type: ['number', 'null'] },
      payment_method: { type: ['string', 'null'] },
    },
  },
};

// The prompt now carries only POLICY, not shape — the grammar owns the shape, and the
// schema is deliberately not injected into the prompt by llama.cpp, so the fields still
// need naming but not illustrating. Keeping this short matters for more than tokens: the
// long rule-list version measurably lengthened the model's deliberation, and reasoning
// tokens are what push a scan past its budget.
const SCHEMA_PROMPT = `Transcribe this receipt.

Fields: merchant, date (YYYY-MM-DD, use {YEAR} if no year is printed), time (HH:MM),
currency (ISO code), category (best fit from: {CATEGORIES}), items, subtotal, tax, total,
payment_method. Use null for anything not legibly printed.

Each item needs "printed" (the line exactly as it appears, characters unchanged) and
"name" (the same thing tidied into a readable product name), plus qty and amount. Amount
is that line's total, never the unit price.

- Only lines actually printed on the receipt. Never invent one; never pad the list.
- Skip non-products: subtotal, tax, total, change, points, bag charges, headers, footers.
- Many receipts print an item code before the product — a barcode number, or a short
  numeric or alphanumeric SKU. That code is not the product's name. Put the words in
  "name"; if the line has no words at all, repeat the code there rather than inventing a
  product it might be.
- The amounts must add up to the subtotal, or to total minus tax.
- If a line is illegible, leave it out rather than guessing.{LEARNED}`;

/**
 * What the model has been taught, folded back into the prompt.
 *
 * Two kinds of steering, both drawn from what the user has already settled:
 *
 *  1. **Phantom lines** it keeps inventing, which it is told are never products.
 *  2. **A vocabulary of real products** seen on past receipts. This is the cheapest fix
 *     available for character-level misreads: a vision model deciding between 牛乳 (milk)
 *     and 牛丼 (beef bowl) on smudged thermal paper is choosing between two plausible
 *     readings, and priming it with the words that actually occur in this kitchen tilts
 *     that coin. Confirmed aliases come first — those are strings the user personally
 *     settled, so they are the highest-quality signal available.
 */
function learnedPromptBlock() {
  const out = [];

  // MAX(hits), not SUM(hits), and gated on it. Without the gate a line the user deleted
  // ONCE became a standing "this is never a product" instruction on the very next scan of
  // any shop — the exact opposite of the contract this module states below, and worse than
  // the replay path it bypasses, because a line the model never transcribes cannot appear
  // in `dropped` and so can never be offered back. SUM would have re-opened the same hole
  // from the other side: two unrelated shops each dropping a line once would sum to 2.
  const drops = all(`SELECT raw_display, MAX(hits) AS hits FROM finance_receipt_fix
                     WHERE kind = 'drop' AND raw_display <> ''
                     GROUP BY raw HAVING MAX(hits) >= ? ORDER BY hits DESC LIMIT 12`, AUTO_FIX_AFTER);
  if (drops.length) {
    out.push(`\n- Never output these as items — they are not products: `
      + drops.map(r => JSON.stringify(r.raw_display)).join(', ') + '.');
  }

  try {
    // CONFIRMED aliases only. Unconfirmed ones are the model's own guesses, and priming a
    // model with its own past output is a feedback loop that entrenches misreads — this
    // catalogue already contains "*A&炭無限朝牛丼 100", an unconfirmed alias carrying the
    // exact 牛丼/牛乳 confusion the priming is meant to prevent.
    const vocab = all(`SELECT a.raw FROM finance_item_alias a
                       JOIN finance_item i ON i.id = a.item_id AND i.deleted = 0
                       WHERE a.raw <> '' AND a.confirmed = 1
                       ORDER BY a.hits DESC, a.updated_at DESC
                       LIMIT 40`).map(r => r.raw).filter(Boolean);
    if (vocab.length >= 3) {
      out.push(`\n- Products bought before, as printed. If a line closely resembles one of`
        + ` these, it almost certainly IS that one — prefer it over a similar-looking word:`
        + ` ${vocab.map(v => JSON.stringify(v)).join(', ')}.`);
    }
  } catch { /* catalogue unavailable — the drop list still applies */ }

  return out.join('');
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
  // What auto-orientation did, so the UI can say so and offer the other way round.
  // Stored as JSON text; tolerate the in-memory object too, since save() hands its own
  // record straight back rather than re-reading the row.
  oriented: typeof r.oriented === 'string' ? parseJSON(r.oriented, null) : (r.oriented || null),
  docType: r.doc_type || 'receipt',
  // How well it read the paper, and whether this purchase is already in the ledger.
  // The duplicate lookup is one indexed hit; surfacing it here means the review screen
  // can say so BEFORE the user presses Log, rather than only failing at the last step.
  confidence: parseJSON(r.parsed, null)?.confidence || null,
  duplicate: r.status === 'applied' ? null : duplicateOf(r.fingerprint, r.id),
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

/**
 * Throw a scan away.
 *
 * Refuses while it is in the ledger, and that refusal is the whole point. A bare DELETE
 * here did three things at once: it left the receipt's transactions alive (finance.deleteTxn
 * is a tombstone and was never called, so they kept counting toward spend), it stranded
 * every price observation filed under the receipt id where nothing can ever reach them
 * again, and it destroyed the only copy of the duplicate fingerprint — so re-photographing
 * that same paper posted a second full copy with no warning.
 *
 * revertReceipt() next door already does the cleanup properly, so the fix is to make the
 * user go through it rather than to duplicate it here.
 */
export function deleteReceipt(id) {
  const row = one('SELECT status FROM finance_receipt WHERE id = ?', String(id || ''));
  if (!row) throw missing('receipt not found');
  if (row.status === 'applied') {
    throw bad('this receipt is in the ledger — undo it first (that removes its transactions '
      + 'and price history), then delete the scan.');
  }
  run('DELETE FROM finance_receipt WHERE id = ?', String(id || ''));
}

// ---------- the duplicate guard ----------
//
// One purchase, two photographs. It happens when a receipt is shot on the phone and then
// again from the desktop attach point, when a batch upload is retried after a timeout, or
// when the same paper resurfaces in a pile a week later. Posting both is not a small
// error: it silently doubles a day's spend, and nothing downstream can tell the copy from
// the original.
//
// The key is what the USER would compare: the date, and the products and prices. Not the
// merchant — that is the field a re-read is most likely to word differently ("7-ELEVEN"
// vs "セブン-イレブン"), and letting a copy through because the shop name wobbled defeats
// the point. The exception is a receipt with no line items, where date+total alone is a
// genuinely plausible coincidence (two ¥500 lunches on one day), so the shop joins the key
// there and the two prefixes keep the two kinds of key from ever colliding.
export function receiptFingerprint(p) {
  if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) || !(Number(p.total) > 0)) return '';
  const head = `${p.date}|${String(p.currency || '').toUpperCase()}|${round2(p.total)}`;
  const lines = (p.items || [])
    .filter(it => it?.name && Number(it.amount) > 0)
    .map(it => `${fixKey(it.printed || it.name)}*${Math.max(1, Number(it.qty) || 1)}@${round2(it.amount)}`)
    .sort();
  return lines.length ? `l:${head}|${lines.join(';')}` : `t:${head}|${fixKey(p.merchant)}`;
}

/**
 * Give scans stored before the guard existed a fingerprint, once.
 *
 * Without this the guard has a hole exactly where it is least expected: every receipt
 * already in the ledger carries an empty key, so re-photographing one from last month
 * would post it a second time and nothing would object. Cheap (a few dozen rows, parsed
 * once) and a no-op on every boot after the first.
 */
export function backfillFingerprints() {
  const rows = all(`SELECT id, parsed FROM finance_receipt WHERE fingerprint = '' AND parsed <> ''`);
  let n = 0;
  for (const r of rows) {
    const fp = receiptFingerprint(parseJSON(r.parsed, null));
    if (!fp) continue;                       // an unreadable scan has nothing to key on
    run('UPDATE finance_receipt SET fingerprint = ? WHERE id = ?', fp, r.id);
    n++;
  }
  if (n) console.log(`[receipts] indexed ${n} existing scan${n === 1 ? '' : 's'} for duplicate detection`);
  return { indexed: n, skipped: rows.length - n };
}

/** The already-applied receipt this one is a copy of, or null. */
function duplicateOf(fingerprint, exceptId = '') {
  const fp = String(fingerprint || '');
  if (!fp) return null;
  const hit = one(`SELECT id, parsed, updated_at FROM finance_receipt
                   WHERE fingerprint = ? AND status = 'applied' AND id <> ? LIMIT 1`, fp, String(exceptId || ''));
  if (!hit) return null;
  const p = parseJSON(hit.parsed, null) || {};
  return { id: hit.id, merchant: p.merchant || '', date: p.date || '', total: p.total ?? null, appliedAt: hit.updated_at };
}

function save(rec) {
  const parsed = parseJSON(rec.parsed, null);
  const fingerprint = parsed ? receiptFingerprint(parsed) : '';
  const confidence = Number(parsed?.confidence?.score);
  // `oriented` used to be set on the in-memory record only and then read back off the SQL
  // row, which had no such column — so the "we turned this photo 270°, turn it back?" banner
  // and its one-click undo were invisible the moment the list reloaded. It is a column now.
  const oriented = rec.oriented && typeof rec.oriented === 'object'
    ? JSON.stringify(rec.oriented) : String(rec.oriented || '');
  run(`INSERT INTO finance_receipt (id, upload_id, status, model, raw, parsed, parsed_ai, error, txn_ids, fingerprint, confidence, doc_type, oriented, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, model=excluded.model,
         raw=excluded.raw, parsed=excluded.parsed, parsed_ai=excluded.parsed_ai,
         error=excluded.error, txn_ids=excluded.txn_ids, fingerprint=excluded.fingerprint,
         confidence=excluded.confidence, doc_type=excluded.doc_type, oriented=excluded.oriented,
         updated_at=excluded.updated_at`,
    rec.id, rec.upload_id, rec.status, rec.model, rec.raw, rec.parsed, rec.parsed_ai || '',
    rec.error, rec.txn_ids, fingerprint, Number.isFinite(confidence) ? confidence : -1,
    rec.doc_type || 'receipt', oriented,
    rec.created_at, rec.updated_at);
  return outReceipt({ ...rec, fingerprint, oriented });
}

/**
 * Which way is the receipt lying, and put it right before the model sees it.
 *
 * Angle turned out to be a leading cause of bad reads: three of the photos on this
 * machine were taken with the receipt lying across a landscape frame, so the model was
 * asked to read Japanese rotated 90° — the case the OCR literature says these models are
 * weakest at. Correcting it costs one ffmpeg pass.
 *
 * The signal is deliberately dumb and was validated against every real receipt here
 * (5/5): a till receipt is a long narrow strip, so a LANDSCAPE photo of one means it is
 * lying sideways. Only near-square photos need the more delicate test — where the
 * brightness steps are, since they happen across the strip's short axis. A projection
 * measure alone scored 4/5 and was unsure exactly where it was wrong, so aspect leads.
 *
 * Direction: counter-clockwise. On all three real examples the header sat on the right,
 * which is where it lands when a right-handed person puts a receipt down and photographs
 * it. A wrong guess is one button away from fixed — the review editor rotates and re-reads.
 */
function detectSideways(buffer) {
  const dim = uploads.imageSize(buffer);
  if (dim?.width && dim?.height) {
    if (dim.width > dim.height * 1.15) return { sideways: true, why: `landscape photo (${dim.width}×${dim.height})` };
    if (dim.height > dim.width * 1.15) return { sideways: false, why: `portrait photo (${dim.width}×${dim.height})` };
  }
  const g = uploads.greyRaster(buffer, 256);
  if (!g) return { sideways: false, why: 'could not inspect the image' };

  const n = g.n, rows = new Array(n).fill(0), cols = new Array(n).fill(0);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const v = g.data[y * n + x]; rows[y] += v; cols[x] += v; }
  const varOf = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length; };
  const steps = (a) => varOf(a.slice(1).map((v, i) => Math.abs(v - a[i])));
  const rv = steps(rows), cv = steps(cols);
  return {
    sideways: rv > cv,
    why: `near-square, edge steps ${(Math.max(rv, cv) / (Math.min(rv, cv) || 1)).toFixed(1)}× toward the ${rv > cv ? 'horizontal' : 'vertical'}`,
  };
}

/** Apply an explicit rotation, or auto-correct a sideways one. Returns what it did. */
function orientForOcr(meta, explicit) {
  const deg = Number(explicit);
  if (Number.isFinite(deg) && deg % 90 === 0 && deg % 360 !== 0) {
    uploads.rotateStored(meta.id, deg);
    return { rotated: ((deg % 360) + 360) % 360, why: 'you asked for it' };
  }
  if (explicit !== undefined) return { rotated: 0, why: 'left as it is' };   // explicit 0 = don't touch
  try {
    // A photo whose rotation tag could not be applied (no ffmpeg on this box) has stored
    // dimensions that mean nothing — guessing from them is how an upright receipt got
    // turned on its side. Decline instead.
    if (meta.exifRotated) return { rotated: 0, why: 'the photo carries a rotation tag this machine could not apply' };
    const { buffer } = uploads.readUpload(meta.id);
    const d = detectSideways(buffer);
    if (!d.sideways) return { rotated: 0, why: d.why };
    uploads.rotateStored(meta.id, 270);            // 270° clockwise = 90° counter-clockwise
    return { rotated: 270, why: d.why };
  } catch (e) {
    console.error('[receipts] could not auto-orient:', e.message);
    return { rotated: 0, why: 'auto-orient failed' };
  }
}

// ---------- two-stage reading ----------
//
// A dedicated OCR model and a general vision model are good at different halves of this
// job, and trying to make either do both is what produced most of the bad scans.
//
// Measured on this machine over 8 real receipts (see the bench in Roadmap "Shipped"):
// the general VLM driven end-to-end got 63% of totals right; the OCR model driven the
// same way got 25% and hit the token cap on five of eight. But asked to do only its own
// job, the OCR model transcribed a receipt the VLM had read as ¥3,138 and returned every
// number exactly right (¥118/356/128/138, subtotal 740, tax 59, total 799) — and a text
// model turned that transcription into the correct object in 14s.
//
// So: transcribe with the reader, structure with the thinker. Each stage is the task its
// model was trained for.

/** The prompt a transcriber expects. These models are prompt-sensitive: dots.ocr returns
 *  two tokens for "OCR" and a full layout parse for the string below. */
const TRANSCRIBE_PROMPTS = {
  'dots.ocr': `Please output the layout information from the PDF image, including each layout element's bbox, its category, and the corresponding text content within the bbox.

1. Bbox format: [x1, y1, x2, y2]

2. Layout Categories: The possible categories are ['Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer', 'Page-header', 'Picture', 'Section-header', 'Table', 'Text', 'Title'].

3. Text Extraction & Formatting Rules:
    - Picture: For the 'Picture' category, the text field should be omitted.
    - Formula: Format its text as LaTeX.
    - Table: Format its text as HTML.
    - All Others (Text, Title, etc.): Format their text as Markdown.

4. Constraints:
    - The output text must be the original text from the image, with no translation.
    - All layout elements must be sorted according to human reading order.

5. Final Output: The entire output must be a single JSON object.`,
  default: 'OCR',
};

const transcribePrompt = (ref) => {
  const s = String(ref || '').toLowerCase();
  for (const [k, v] of Object.entries(TRANSCRIBE_PROMPTS)) if (k !== 'default' && s.includes(k)) return v;
  return TRANSCRIBE_PROMPTS.default;
};

/** What shape stage 1 comes back in. Only line-oriented text can be stitched back
 *  together from bands — a reader that answers with one JSON layout object per image has
 *  to see the whole page at once, so it reads the photo whole. */
export const transcribeStyle = (ref) => (String(ref || '').toLowerCase().includes('dots.ocr') ? 'layout-json' : 'lines');

/**
 * Hand the model the receipt, not the table it is lying on.
 *
 * Cropped to a TEMPORARY upload rather than in place: unlike rotation, a crop discards
 * pixels, and the reviewer's photo should stay whole. Everything the model saw is still
 * visible in the original, so the "check it against the paper" loop is unaffected.
 */
function cropForOcr(meta) {
  try {
    const { buffer } = uploads.readUpload(meta.id);
    const cropped = uploads.cropToContent(buffer);
    if (!cropped) return null;
    return { meta: uploads.saveUploadSync({ name: 'crop.jpg', mime: 'image/jpeg', buffer: cropped.buffer }), area: cropped.area };
  } catch (e) {
    console.error('[receipts] crop failed, using the whole photo:', e.message);
    return null;
  }
}

/** Stage 1 — read the paper. No grammar: transcription is this model's native output,
 *  and constraining it to our schema is exactly what breaks it. */
async function transcribe(meta, modelRef, signal) {
  const res = await streamChat({
    modelRef,
    messages: [{ role: 'user', text: transcribePrompt(modelRef), attachments: [meta] }],
    maxTokens: 4096,
    sampling: { temperature: 0 },
    signal,
  });
  return String(res.text || res.reasoning || '').trim();
}

const normLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Join transcriptions of overlapping bands back into one page.
 *
 * The bands share their edges on purpose, so the same few lines are transcribed twice and
 * have to be removed exactly once. Getting this wrong is not cosmetic: a product line left
 * in twice inflates the basket by its own amount, and one deleted takes a real purchase out
 * of the ledger. So the seam is found by AGREEMENT rather than by arithmetic on pixel
 * offsets — the model does not transcribe a band edge to the pixel, and it does not have
 * to for this to work.
 *
 * Longest run wins: the tail of one band is matched against the head of the next, longest
 * candidate first, and the first run of at least two identical lines is the seam. Two,
 * because single lines repeat innocently all over a receipt — a lone "¥180", or a blank —
 * and cutting on one of those would silently delete a real line. When nothing agrees the
 * halves are simply concatenated: a duplicated line makes the total overshoot, which the
 * reconciliation check already puts in front of the reviewer in as many words, while a
 * quietly dropped one looks like a receipt that balances and is wrong.
 */
export function stitchTranscripts(parts, { minRun = 2, window = 40 } = {}) {
  const texts = parts.map(p => String(p || '').replace(/\r/g, '')).filter(t => t.trim());
  if (texts.length <= 1) return texts[0] || '';

  let out = texts[0].split('\n');
  for (let i = 1; i < texts.length; i++) {
    const next = texts[i].split('\n');
    // Compare on non-empty lines only — blank lines are formatting, not content, and
    // letting them count would make almost any two bands "agree".
    const tailIdx = [], headIdx = [];
    for (let k = out.length - 1; k >= 0 && tailIdx.length < window; k--) if (normLine(out[k])) tailIdx.unshift(k);
    for (let k = 0; k < next.length && headIdx.length < window; k++) if (normLine(next[k])) headIdx.push(k);

    let cut = 0;
    for (let run = Math.min(tailIdx.length, headIdx.length); run >= minRun; run--) {
      const a = tailIdx.slice(tailIdx.length - run).map(k => normLine(out[k]));
      const b = headIdx.slice(0, run).map(k => normLine(next[k]));
      if (a.every((v, j) => v === b[j])) { cut = headIdx[run - 1] + 1; break; }
    }
    out = out.concat(next.slice(cut));
  }
  return out.join('\n').trim();
}

/**
 * Read a long receipt in bands, at the resolution the small print is actually printed in.
 *
 * Falls back to one whole-image read whenever slicing would not help or does not work —
 * the tiled path is an optimisation for a shape of photo, never a requirement.
 */
async function transcribeTall(meta, modelRef, signal, { max }) {
  if (!(max >= 2) || transcribeStyle(modelRef) !== 'lines') return transcribe(meta, modelRef, signal);

  let sliced = null;
  try { sliced = uploads.sliceTall(uploads.readUpload(meta.id).buffer, { max }); }
  catch (e) { console.error('[receipts] could not slice the photo:', e.message); }
  if (!sliced) return transcribe(meta, modelRef, signal);

  console.log(`[receipts] reading it in ${sliced.n} overlapping bands (${sliced.width}×${sliced.height})`);
  const tmp = [];
  try {
    const parts = [];
    for (const buffer of sliced.bands) {
      const band = uploads.saveUploadSync({ name: 'band.jpg', mime: 'image/jpeg', buffer });
      tmp.push(band.id);
      parts.push(await transcribe(getMeta(band.id), modelRef, signal));
    }
    const joined = stitchTranscripts(parts);
    // A band that reads nothing drags the whole page down with it — one blank in three
    // means a third of the receipt is simply missing, and a short whole-image reading is
    // more use to the reviewer than a confidently incomplete one.
    const blank = parts.filter(p => !p.trim()).length;
    if (blank || joined.length < 20) {
      console.warn(`[receipts] ${blank || 'all'} band(s) read nothing — falling back to the whole photo`);
      return transcribe(meta, modelRef, signal);
    }
    return joined;
  } finally {
    for (const id of tmp) { try { uploads.deleteUpload(id); } catch { /* already gone */ } }
  }
}

const STRUCTURE_SYSTEM = `You convert an OCR transcription of a receipt into structured JSON. Work only from the text you are given — never invent a line, a price or a total that is not in it. If something is missing, use null.`;

/** Stage 2 — turn the transcription into the ledger's shape. A text task, which is why
 *  a plain instruct model does it reliably where a VLM juggling both did not. */
async function structure(text, cfg, modelRef, signal) {
  const prompt = `Below is an OCR transcription of a receipt. Extract it.

Product lines only: skip 小計 / 合計 / 消費税 / お預り / お釣り / クレジット / ポイント / レジ袋, the shop's address and phone, and any footer.
"printed" is the line as the transcription has it; "name" is the same thing tidied.
An item code — a barcode number, or a short numeric or alphanumeric SKU printed before
the product — is not the product's name. "name" is the words on the line; if a line has
no words at all, repeat the code rather than guessing what it was.
A product printed across two lines is one item: the price belongs to the words above it.
"amount" is that line's total. Category, from: ${cfg.expenseCategories.join(', ')}.
If no year is shown, use ${new Date().getFullYear()}.${learnedPromptBlock()}

--- transcription ---
${text.slice(0, 12000)}`;

  const res = await streamChat({
    modelRef, system: STRUCTURE_SYSTEM,
    messages: [{ role: 'user', text: prompt }],
    schema: RECEIPT_SCHEMA, maxTokens: 4096,
    sampling: { temperature: 0 }, signal,
  });
  return { text: String(res.text || res.reasoning || ''), stopReason: res.stopReason };
}

/** Which model turns the transcription into JSON. Any decent instruct model will do —
 *  it never sees the image, only text. */
function structureModel() {
  const cfg = loadConfig();
  const explicit = String(cfg.finance?.ocrTextModel || '').trim();
  if (explicit) return explicit;
  const chat = String(cfg.defaults?.chatModel || '').trim();
  if (chat) return chat;
  const pick = visionModels()[0];
  if (pick) return pick.ref;
  throw bad('no model configured to structure the transcription — set finance.ocrTextModel');
}

/**
 * One complete reading of the photo exactly as it currently sits.
 *
 * Both model paths live here — the single-stage VLM and the transcribe-then-structure
 * split — so the retry loop above can treat a reading as one opaque unit. Model-side
 * failures come back as `{ error }` rather than thrown, because a failed attempt is a
 * result the loop has to compare against the others, not an emergency.
 */
async function readOnce({ meta, modelRef, cfg, prompt, signal }) {
  // A dedicated OCR model reads the paper far better than it answers questions about it,
  // so when one is selected the work is split: it transcribes, then a text model turns
  // that into the receipt object.
  if (refIsTranscriber(modelRef)) {
    const textModel = structureModel();
    let crop = null;
    // Held outside the try so a failure while STRUCTURING still hands back what was read
    // off the paper. That transcription is the expensive half and the only thing that can
    // tell the user whether the photo or the text model was at fault.
    let raw = '';
    try {
      // Crop first: on every real receipt here the paper is under half the frame, and the
      // model downsamples whatever it is handed. Uncropped, one of these transcribed to
      // 86 characters; cropped, 698 and a perfect reading.
      crop = cropForOcr(meta);
      if (crop) console.log(`[receipts] cropped to the receipt (${crop.area}% of the frame) before reading`);
      // …then, if what is left is a long strip, read it in bands rather than downscaling
      // the small print out of existence. Cropping first is what makes the shape test
      // meaningful: the aspect that matters is the paper's, not the table's.
      raw = await transcribeTall(crop?.meta || meta, modelRef, signal, { max: tilePolicy() });
      if (!raw) return { error: 'the OCR model returned nothing to work from' };
      let out = await structure(raw, cfg, textModel, signal);
      let parsed = normalize(extractJSON(out.text, { require: ['total', 'merchant', 'items'] }), cfg);
      // Stage 2 is cheap to repeat — no image, and usually no model swap — so a failure
      // here gets one more go before the whole reading is thrown away. Measured: this is
      // the only failure mode left in the two-stage path, and it is not deterministic.
      if (!parsed) {
        console.warn('[receipts] structuring failed on the first pass — retrying');
        out = await structure(raw, cfg, textModel, signal);
        parsed = normalize(extractJSON(out.text, { require: ['total', 'merchant', 'items'] }), cfg);
      }
      return {
        parsed, raw, model: `${modelRef} → ${textModel}`,
        error: parsed ? '' : out.stopReason === 'length'
          ? 'the transcription was read, but structuring it ran out of room — try a different text model in Settings → Finances.'
          : 'the receipt was transcribed but could not be structured. The raw reading is kept for reference.',
      };
    } catch (e) {
      return { raw, error: e.message };
    } finally {
      if (crop?.meta) uploads.deleteUpload(crop.meta.id);
    }
  }

  // Budget for reasoning + JSON, not just JSON.
  //
  // Measured on this box: Gemma 4 emits 180-250 reasoning tokens for a trivial prompt and
  // well over 700 for a receipt, and NONE of the usual switches suppress it —
  // enable_thinking, reasoning_effort and thinking.type were each tested and are no-ops
  // for its template. So the only reliable lever is headroom. The old 2400 cap is exactly
  // what produced "the model did not return usable JSON": 3130 characters of narration,
  // truncated before the object began.
  const attempt = (maxTokens) => streamChat({
    modelRef,
    system: SYSTEM,
    messages: [{ role: 'user', text: prompt, attachments: [meta] }],
    schema: RECEIPT_SCHEMA,
    maxTokens,
    sampling: { temperature: 0 },
    signal,
  });

  let res;
  try {
    res = await attempt(4096);
    // Truncated anyway (a very long receipt): one retry with real headroom. Bounded, and
    // only on the readings that actually failed, so the common path stays fast.
    if (res.stopReason === 'length' && !extractJSON(res.text || '')) {
      console.warn('[receipts] first pass hit the token cap — retrying with more headroom');
      res = await attempt(8192);
    }
  } catch (e) {
    return { error: e.message };
  }

  // With the grammar on, `text` is the JSON. The reasoning fallback stays for providers
  // that ignore response_format and route everything through the thinking channel.
  const text = String(res.text || res.reasoning || '');
  const parsed = normalize(extractJSON(text, { require: ['total', 'merchant', 'items'] }), cfg);
  return {
    parsed, raw: text, model: modelRef,
    error: parsed ? '' : res.stopReason === 'length'
      ? 'the model ran out of room before finishing the receipt — it may be unusually long, or the model is spending too long deliberating. Try a shorter photo or a different OCR model in Settings → Finances.'
      : 'the model did not return usable JSON. Check that Settings → Finances points at a vision-capable model.',
  };
}

/** How sure a reading has to look before we stop re-reading it, and how many goes it gets.
 *  Capped at three passes: each one costs ~15 s of GPU, and past the third the model is
 *  not going to surprise you. */
function retryPolicy() {
  const f = loadConfig().finance || {};
  const floor = Number(f.ocrMinConfidence);
  const max = Number(f.ocrMaxAttempts);
  return {
    floor: Number.isFinite(floor) ? Math.max(0, Math.min(100, floor)) : 75,
    max: Number.isFinite(max) ? Math.max(1, Math.min(3, Math.trunc(max))) : 3,
  };
}

/** How many bands a long receipt may be read in. 0 or 1 turns tiling off and reads every
 *  photo whole; the cap is 4 because each band is another pass over the GPU and past four
 *  the bands are shorter than the overlap between them is deep. */
function tilePolicy() {
  const n = Number((loadConfig().finance || {}).ocrTiles);
  return Number.isFinite(n) ? Math.max(0, Math.min(4, Math.trunc(n))) : 3;
}

/**
 * What to change for the next go, or null when another go cannot help.
 *
 * The two ways a reading goes wrong want opposite responses, and telling them apart is
 * most of the value here:
 *
 *  * **Nothing legible** — no shop name, no lines. That is what a receipt photographed at
 *    the wrong angle looks like to a model that was never trained to read sideways
 *    Japanese, so turn the paper. detectSideways() already guessed a direction from the
 *    aspect ratio, and on a near-square photo that guess is close to a coin flip, so 180°
 *    (undoing a wrong guess) is tried before 90°.
 *  * **Legible but wrong** — every field came back, the arithmetic just does not close.
 *    The paper was read, so the angle is right and turning it would only make things worse.
 *
 * The second case used to re-read the same photo, twice, on the theory that the model
 * varies run to run. It does not: every call in readOnce() is temperature 0 under a fixed
 * grammar, so a second look at byte-identical input reproduces the reading that just failed
 * the confidence floor — 25-40s of GPU on this card for an outcome that cannot change (and
 * on the rescan path, where an explicit angle pins the loop, that was every remaining pass).
 * Returning null instead hands the reviewer the reading now, with the "the lines come to X
 * less than the receipt says" note that tells them what to look for. That is worth more
 * than another quarter-minute of the same answer.
 */
function planAngle(last, used) {
  const p = last?.parsed;
  const illegible = !p || !p.merchant || !p.items?.length;
  if (!illegible) return null;                       // read fine; the angle is not the problem
  return [180, 90, 270].find(a => !used.includes(a)) ?? null;
}

/** A throwaway copy of the photo turned by `deg`, so a retry can look at another angle
 *  without re-encoding the picture the user reviews against. */
function rotatedCopy(meta, deg) {
  const { buffer } = uploads.readUpload(meta.id);
  const tmp = uploads.saveUploadSync({ name: 'turn.jpg', mime: meta.mime || 'image/jpeg', buffer });
  try {
    uploads.rotateStored(tmp.id, deg);
    return getMeta(tmp.id);
  } catch (e) {
    try { uploads.deleteUpload(tmp.id); } catch { /* nothing to clean up */ }
    throw e;
  }
}

/**
 * Run OCR over an uploaded image and store the structured result.
 *
 * Reads it more than once when the first reading does not look convincing. This is the
 * cheapest accuracy win available: nothing about a local scan is expensive except the
 * user's attention, and a second pass either agrees with the first (in which case the
 * confidence was misplaced and the reviewer has one fewer thing to check) or is visibly
 * better. The best-scoring pass wins and the rest are discarded — the loop never merges
 * two readings, because a receipt stitched from two disagreeing sources is a receipt
 * nobody can check against the paper.
 *
 * Does NOT write to the ledger — the user reviews first, then calls apply().
 */
export async function scan({ uploadId, model, rotate, signal } = {}) {
  let meta = getMeta(String(uploadId || ''));
  if (!meta) throw missing('upload not found — attach the image first');
  if (meta.kind !== 'image') throw bad(`receipt scanning needs a photo, but that upload is ${meta.kind === 'pdf' ? 'a PDF' : meta.kind === 'text' ? 'a text file' : `a ${meta.mime}`}.`);
  if (meta.unreadable) throw bad(`that photo is a ${meta.convertedFrom || meta.mime} and could not be converted to JPEG on this machine `
    + '— install ffmpeg (or set uploads.ffmpeg to its path) and try again.');

  // Straighten the photo BEFORE the model sees it. A receipt read at 90° is the single
  // most avoidable cause of a bad scan.
  const oriented = orientForOcr(meta, rotate);
  if (oriented.rotated) {
    meta = getMeta(meta.id) || meta;
    console.log(`[receipts] rotated the photo ${oriented.rotated}° — ${oriented.why}`);
  }

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
  rec.oriented = oriented;
  save(rec);

  const { floor, max } = retryPolicy();
  // An explicit `rotate` is an instruction, not a suggestion: the user turned the preview
  // until it read right and asked for THAT. Retries then only re-read, never re-turn.
  const mayTurn = rotate === undefined;
  const used = [];
  let best = null, bestAngle = 0, angle = 0, last = null;

  for (let pass = 1; pass <= max; pass++) {
    if (pass > 1) {
      // Only ever look AGAIN at something genuinely different. With an explicit angle the
      // user has already told us which way is right, so there is nothing left to vary and
      // every further pass would be a byte-identical re-read.
      const next = mayTurn ? planAngle(last, used) : null;
      if (next === null) break;
      angle = next;
    }

    let view = meta, tmp = null;
    try {
      if (angle) { tmp = rotatedCopy(meta, angle); view = tmp; }
    } catch (e) {
      console.error('[receipts] could not turn the photo for another look:', e.message);
      break;                                   // no ffmpeg — the first reading is what we have
    }
    used.push(angle);                           // counted once the pass is actually happening
    try {
      last = await readOnce({ meta: view, modelRef, cfg, prompt, signal });
    } finally {
      if (tmp) { try { uploads.deleteUpload(tmp.id); } catch { /* already gone */ } }
    }

    if (last.parsed) {
      // Replay what the user has already taught us about this shop BEFORE scoring: a
      // phantom line the correction loop already knows to drop should not count against
      // the reading that (correctly) no longer contains it.
      last.parsed = replayFixes(last.parsed);
      last.parsed.confidence = scoreConfidence(last.parsed, { raw: last.raw });
      const score = last.parsed.confidence.score;
      // `best?.parsed`, not `best`: a first pass that failed outright is held as `best` so
      // its error can be reported, and it has no score to compare against.
      if (!best?.parsed || score > best.parsed.confidence.score) { best = last; bestAngle = angle; }
      if (score >= floor) break;
      if (pass < max) console.log(`[receipts] pass ${pass} scored ${score}/100 (floor ${floor}) — reading it again`);
    } else if (!best) {
      best = last; bestAngle = angle;           // keep the error to report if nothing parses
    }
  }

  // Leave the stored photo at the angle that won, so the picture the reviewer checks
  // against is the one the reading actually came from. One extra encode at most.
  if (bestAngle) {
    try {
      uploads.rotateStored(meta.id, bestAngle);
      oriented.rotated = (oriented.rotated + bestAngle) % 360;
      oriented.why = `${oriented.why}, then turned ${bestAngle}° more because that read better`;
    } catch (e) { console.error('[receipts] could not save the winning angle:', e.message); }
  }

  const reads = used.length;
  if (!best?.parsed) {
    rec.status = 'failed';
    rec.raw = String(best?.raw || '').slice(0, 20000);
    rec.error = best?.error || 'the receipt could not be read';
    rec.updated_at = now();
    const failed = save(rec);
    failed.oriented = oriented;
    return failed;
  }

  // How it got here, so the reviewer can see that a low number is a considered one and
  // not a first impression.
  best.parsed.confidence.reads = reads;
  best.parsed.confidence.angle = bestAngle;

  rec.status = 'parsed';
  rec.model = best.model || modelRef;
  rec.raw = String(best.raw || '').slice(0, 20000);
  rec.parsed = JSON.stringify(best.parsed);
  rec.updated_at = now();
  const saved = save(rec);
  saved.oriented = oriented;
  return saved;
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
  // `!= null` throughout, not `!== null`: normalize() always hands over null-or-number,
  // but this is exported (reconcileItems) and an undefined tax would slip past a strict
  // check and make `total - tax` NaN — which reads downstream as a receipt that is
  // "short" by an unknowable amount rather than one that simply printed no tax line.
  const expected = subtotal != null ? subtotal
    : (total != null && tax != null ? round2(total - tax) : total);
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
/**
 * Is this "name" actually the item code the product was printed next to?
 *
 * Deliberately narrow, because the cost of the two mistakes is not symmetric: a missed
 * code is a line the reviewer reads anyway, while a false positive puts a warning on a
 * legitimately numeric product ("500ml", "2%") and teaches them to ignore warnings. So it
 * fires only on strings carrying no letters and no CJK at all — a bare run of digits and
 * separators, of the length a JAN barcode or a shelf SKU actually has.
 */
export function looksLikeCode(name) {
  const s = String(name || '').trim();
  if (s.length < 3 || s.length > 20) return false;
  if (/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)) return false;
  return /^[#*]?\d[\d\s#*\-./]*\d$/.test(s) && (s.match(/\d/g) || []).length >= 3;
}

function annotate(lines, total) {
  return lines.map((it) => {
    const warn = [];
    if (total !== null && it.amount > total + 1) {
      warn.push(`${it.amount} is more than the receipt total (${total}) — this line is probably not real`);
    }
    // A name that is really the item code. The line is usually real — something WAS
    // bought — so this is a naming failure, not a phantom, and dropping it would lose a
    // purchase. Flagged instead: the reviewer can read the word off the photo beside it,
    // and that correction is exactly what the catalogue learns from.
    if (looksLikeCode(it.name)) {
      warn.push(`“${it.name}” looks like an item code rather than a product — check the photo for the name`);
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

// ---------- how well did it read the paper? ----------
//
// A scan is not pass/fail, and the reviewer's real question is "how hard do I need to look
// at this one?". That question has a deterministic answer here — no second model call, no
// self-reported "confidence" from a model that has no idea when it is wrong. Every signal
// below is something checkable about the reading itself:
//
//   * the arithmetic, which is a closed system and by far the strongest evidence
//   * whether the fields that are always printed (merchant, date, total) came back
//   * whether the strings look like language or like OCR noise
//   * whether the products are ones this kitchen has bought before
//
// That last one is where the learning loop pays off twice. A catalogue full of confirmed
// aliases does not only make future reads better, it makes them *checkable*: a line that
// matches a string the user has personally settled is near-certainly read correctly, and a
// receipt of nothing but unrecognised strings deserves a closer look.
//
// The score is only ever a prompt to look, never a gate: nothing is blocked by a low
// number, it just gets re-read and flagged.

const LEVELS = [[85, 'high'], [70, 'good'], [50, 'fair']];
const levelFor = (score) => LEVELS.find(([min]) => score >= min)?.[1] || 'low';

/** Does this string carry characters that mean the decoder gave up on the glyph? A
 *  codepoint walk rather than a regex, because the ranges are exactly the ones that make
 *  a source file unreadable when written literally. */
const isGarbled = (s) => {
  for (const ch of String(s || '')) {
    const c = ch.codePointAt(0);
    if (c === 0xFFFD) return true;                                       // the decoder gave up
    if (c < 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) return true; // control junk
    if (c >= 0xE000 && c <= 0xF8FF) return true;                         // private-use area
  }
  return false;
};

export function scoreConfidence(parsed, { raw = '' } = {}) {
  if (!parsed) return { score: 0, level: 'low', reasons: [{ text: 'nothing could be read from the photo', delta: -100 }] };

  let score = 100;
  const reasons = [];
  const hit = (delta, text) => { score += delta; reasons.push({ text, delta }); };

  const lines = parsed.items || [];
  const chk = parsed.check || {};

  // 1. Arithmetic. A receipt that balances has independently confirmed every line and its
  //    own total against each other, which no other signal here can match.
  if (chk.verdict === 'balanced') {
    hit(0, `the lines add up to the printed total`);
  } else if (chk.verdict === 'overshoot' || chk.verdict === 'short') {
    // Scaled by how wrong: a rounding-sized gap is a different animal from a doubled bill.
    const rel = Math.min(1, Math.abs(chk.delta || 0) / Math.max(1, Math.abs(chk.expected || parsed.total || 1)));
    hit(-Math.round(28 + rel * 32),
      chk.delta > 0
        ? `the lines come to ${chk.delta} more than the receipt says`
        : `the lines come to ${Math.abs(chk.delta)} less than the receipt says`);
  } else if (chk.verdict === 'no-items') {
    hit(-32, 'no line items were read — only a total');
  } else {
    hit(-16, 'no subtotal was printed, so the lines could not be cross-checked');
  }

  // 2. Fields that are printed on every receipt ever issued. A missing one means the model
  //    did not see part of the paper, which says something about the rest of the reading.
  if (!parsed.merchant) hit(-14, 'the shop name could not be read');
  if (parsed.dateGuessed) hit(-12, 'no date was legible — today’s was used');
  if (parsed.totalDerived) hit(-10, 'no total was printed — it was added up from the lines');

  // 3. Noise in the strings. Whole-line garble usually means the angle or the focus was
  //    wrong, which is precisely the case a re-read at another angle can fix.
  const garbled = lines.filter(it => isGarbled(it.printed) || isGarbled(it.name)).length;
  if (garbled) hit(-Math.min(20, garbled * 7), `${garbled} line${garbled === 1 ? '' : 's'} came back with unreadable characters`);

  // 4. Lines the plausibility checks already objected to (annotate() writes these).
  const warned = lines.filter(it => it.warn?.length).length;
  if (warned) hit(-Math.min(18, warned * 7), `${warned} line${warned === 1 ? ' looks' : 's look'} wrong against past prices`);

  // 5. Summary lines the model handed over as products. The prompt tells it not to, so
  //    doing it anyway is evidence it was not reading carefully.
  const dropped = (parsed.dropped || []).length;
  if (dropped) hit(-Math.min(12, dropped * 6), `${dropped} non-product line${dropped === 1 ? ' was' : 's were'} removed automatically`);

  // 6. Recognition. Bonus, not penalty — an unfamiliar shop should not look like a bad
  //    scan, but a familiar basket is real reassurance. Capped well below the arithmetic
  //    penalties so it can never paper over a receipt that does not add up.
  if (lines.length) {
    let known = 0, confirmed = 0;
    for (const it of lines) {
      try {
        const a = items.aliasLookup(it.printed || it.name);
        if (a) { known++; if (a.confirmed) confirmed++; }
      } catch { /* catalogue unavailable — recognition simply contributes nothing */ }
    }
    const share = known / lines.length;
    if (confirmed && share >= 0.5) {
      hit(Math.min(10, 4 + confirmed * 2), `${confirmed} of ${lines.length} lines match products you have confirmed before`);
    } else if (share >= 0.5) {
      hit(4, `${known} of ${lines.length} lines match products bought before`);
    } else if (known === 0 && lines.length >= 3) {
      hit(-6, 'none of these lines match anything bought before');
    }
  }

  // 7. Did the reader produce anything at all to work from? Only meaningful on the
  //    two-stage path, where `raw` is a real transcription rather than the JSON.
  if (raw && raw.length < 40) hit(-10, 'the reader returned very little text from the photo');

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    level: levelFor(score),
    reasons: reasons.filter(r => r.delta !== 0 || reasons.length === 1),
  };
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
    const line = { printed, name, qty: Math.max(1, Math.trunc(Number(it?.qty) || 1)), amount: numOrNull(it?.amount) };
    // Sticky: the editor sets this when a human touches the name or the printed text, and
    // apply() uses it to file the line under THEIR name instead of the model's guess. It
    // has to survive re-normalisation, and it must never be inferrable by comparing keys —
    // correcting the printed text changes the very key a diff would match on.
    if (it?.edited) line.edited = true;
    return line;
  }).filter(it => it.name && it.amount !== null);

  const subtotal = numOrNull(obj.subtotal);
  const tax = numOrNull(obj.tax);
  const printedTotal = numOrNull(obj.total);
  // Provisional while the drops below run: the "worth more than the whole receipt" rule
  // needs something to compare against, and before the drops the raw sum is all there is.
  let total = printedTotal ?? subtotal
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

  // Re-derive the total now the summary lines are gone.
  //
  // This is a money bug, not a tidiness one. A receipt that prints no total and hands back
  // its own `合計 300` line as a product had that 300 counted twice — once as the product,
  // once as the summary — and the doubled figure is exactly what apply() posts to the
  // ledger. Only the DERIVED case is recomputed: a printed total is what the paper says and
  // must survive the drops untouched. If every line was dropped the provisional figure is
  // kept, because there the summary line WAS the total and 0 would be worse than 300.
  if (printedTotal === null && subtotal === null && items.length) {
    total = round2(items.reduce((s, i) => s + i.amount, 0));
  }

  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(String(obj.date || ''));
  const date = dateOk ? obj.date : new Date().toISOString().slice(0, 10);
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
  // Two silent substitutions this function makes, recorded rather than hidden. Today's
  // date standing in for one that could not be read, and a total added up from the lines
  // rather than read off the paper, are both reasonable defaults AND both mean the reading
  // is weaker than it looks — scoreConfidence needs to know which happened. Recomputed per
  // pass rather than carried over, so a date the user types in the review editor stops
  // counting as a guess the moment they confirm it.
  if (!dateOk) out.dateGuessed = true;
  if (printedTotal === null) out.totalDerived = true;
  if (dropped.length) out.dropped = dropped;
  out.check = reconcile(out.items, out);
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
const FIX_KINDS = ['drop', 'rename', 'amount', 'merchant'];
const fixKey = (s) => items.normalize(String(s || ''));

/**
 * One physical shop, one key — the thing every per-shop correction is filed under.
 *
 * fixKey() alone was not enough, and the live database shows exactly how badly. A single
 * shop (クスリのアオキ) is spread across seven keys, because the model writes the name a
 * different way every time and each way normalises to something different:
 *
 *   クスリのアオキ · kusuri no aoki · アオキ · usuri no aoki (a misread K) ·
 *   アズリのアオキ (a misread ク) · "クスリのアオキ kusuri no aoki" · "aoki アオキ"
 *
 * Eighteen learned corrections sit under three of those and are invisible to the other
 * four, so on 8 of 25 real receipts the shop's own corrections simply never fired. The
 * learning loop looked like it was not working; it was working and then being asked the
 * wrong question.
 *
 * The fix is to resolve a freshly-read name to a shop we have seen before, cheapest test
 * first and no model involved:
 *
 *   1. exact key — the common case, free
 *   2. bilingual forms: the model routinely prints "クスリのアオキ (Kusuri no Aoki)", so
 *      each parenthesised or slash-separated half is tried as a key of its own
 *   3. containment either way — "アオキ" inside "クスリのアオキ"
 *   4. trigram similarity, which is what catches a one-character misread (usuri/kusuri)
 *
 * Deliberately conservative: it only ever maps onto a merchant that ALREADY has history,
 * and never invents a grouping. The floor was measured against every shop in this database
 * rather than guessed. Same-shop pairs score 0.50 (アズリ/クスリのアオキ, a one-character
 * misread), 0.81 (aoki ⊂ kusuri no aoki), 0.84 (アオキ ⊂ クスリのアオキ) and 0.94
 * (usuri/kusuri no aoki); the highest-scoring pair of genuinely DIFFERENT shops is 0.22
 * (baby & kids torimatsuya ~ matsuzakaya), with most at 0.00. 0.45 sits at 2× the noise
 * floor and below every true match.
 *
 * A wrong merge is cheap by design, which is what licenses being this eager: the per-shop
 * fixes are keyed on the printed LINE text, so a line from one shop simply never matches
 * anything at another, and the merchant-rename fix is stored globally and unaffected.
 */
const MERCHANT_MATCH_FLOOR = 0.45;

/** Every distinct shop key that already carries corrections or receipts. */
function knownMerchantKeys() {
  const out = new Set();
  try {
    for (const r of all(`SELECT DISTINCT merchant AS m FROM finance_receipt_fix WHERE merchant <> ''`)) out.add(r.m);
  } catch { /* no fix table yet */ }
  return out;
}

/** Split "クスリのアオキ (Kusuri no Aoki)" into the keys a later read might match on. */
function merchantVariants(name) {
  const raw = String(name || '');
  const parts = [raw, ...raw.split(/[()（）\/／|｜]+/)];
  const seen = new Set();
  for (const p of parts) {
    const k = fixKey(p);
    if (k && k.length >= 2) seen.add(k);
  }
  return [...seen];
}

/**
 * Every stored key that means this shop, best match first.
 *
 * Plural because healing new readings onto old keys is only half the job: the keys already
 * in the table are themselves fragmented, and no amount of care with future writes merges
 * them. This shop's 18 corrections really are filed 13/3/2 under three spellings. Reading
 * from all of them costs one `IN (…)` and recovers the history that already exists.
 */
export function merchantMatches(name) {
  const mine = merchantVariants(name);
  if (!mine.length) return [];
  const known = knownMerchantKeys();
  if (!known.size) return [];

  const scored = [];
  for (const k of known) {
    let best = 0;
    for (const v of mine) {
      if (k === v) { best = 1; break; }                          // 1. exact
      best = Math.max(best, similarity(k, v));
    }
    if (best >= MERCHANT_MATCH_FLOOR) scored.push({ key: k, score: best });
  }
  return scored.sort((a, b) => b.score - a.score).map(s => s.key);
}

/**
 * The single key to FILE a new correction under: the shop we already know, or this
 * reading's own key when nothing known is close enough.
 */
export function merchantKey(name) {
  const mine = merchantVariants(name);
  if (!mine.length) return '';
  return merchantMatches(name)[0] ?? mine[0];
}

/** Best of the containment and trigram tests for two normalised shop keys. */
function similarity(k, v) {
  // Containment — a bare "アオキ" is the same shop as "クスリのアオキ", but only when the
  // shorter side is substantial enough not to match everything. One name sitting whole
  // inside another is strong evidence on its own, so the length ratio modulates an
  // already-high score rather than scaling it up from zero.
  const contained = v.length >= 3 && k.length >= 3 && (k.includes(v) || v.includes(k))
    ? 0.75 + 0.2 * (Math.min(k.length, v.length) / Math.max(k.length, v.length))
    : 0;
  // Trigram — the misread-character case (usuri/kusuri, アズリ/クスリ).
  return Math.max(contained, merchantSimilarity(k, v));
}

/** Dice coefficient over character trigrams. Mirrors items.js's matcher, which is
 *  character-based and so works on Japanese as well as latin text. */
function merchantSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const gram = (s) => {
    const p = `  ${s} `;
    const out = new Set();
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
    return out;
  };
  const A = gram(a), B = gram(b);
  let hits = 0;
  for (const g of A) if (B.has(g)) hits++;
  return (2 * hits) / (A.size + B.size);
}

/** Record (or reinforce) one correction. */
export function learnFix({ merchant, kind, raw, aiValue = '', userValue = '' }) {
  const key = fixKey(raw);
  if (!key || !FIX_KINDS.includes(kind)) return null;
  // merchantKey, not fixKey: file this under the shop we already know rather than under
  // whatever spelling the model produced today. See merchantKey() for why.
  const m = merchantKey(merchant) || '';
  run(`INSERT INTO finance_receipt_fix (id, merchant, kind, raw, raw_display, ai_value, user_value, hits, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,1,?,?)
       ON CONFLICT(merchant, kind, raw) DO UPDATE SET
         hits = hits + 1, ai_value = excluded.ai_value,
         user_value = excluded.user_value, updated_at = excluded.updated_at`,
    genId(10), m, kind, key, String(raw || '').slice(0, 200),
    String(aiValue).slice(0, 200), String(userValue).slice(0, 200), now(), now());
  return { merchant: m, kind, raw: key };
}

/** Corrections trusted enough to replay, for one merchant (plus the global ones).
 *
 *  Reads from EVERY key that means this shop, not just the best one. New readings are
 *  healed onto old keys by merchantKey(), but the keys already in the table stay
 *  fragmented — this shop's 18 corrections are genuinely filed 13/3/2 across three
 *  spellings the model produced on different days, and only the union recovers them.
 *  `all()` caches prepared statements by SQL text, so the placeholder list is built from
 *  the key COUNT rather than interpolating the keys themselves: bounded cache, no
 *  injection surface, values still bound. */
export function fixesFor(merchant, { limit = 40 } = {}) {
  const keys = merchantMatches(merchant);
  if (!keys.length) {
    return all(`SELECT * FROM finance_receipt_fix
                WHERE merchant = '' AND hits >= ? ORDER BY hits DESC LIMIT ?`, AUTO_FIX_AFTER, limit);
  }
  const slots = keys.map(() => '?').join(',');
  return all(`SELECT * FROM finance_receipt_fix
              WHERE (merchant IN (${slots}) OR merchant = '') AND hits >= ?
              ORDER BY hits DESC LIMIT ?`, ...keys, AUTO_FIX_AFTER, limit);
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

/**
 * The shop's name, as the user has settled it.
 *
 * Kept separate from the line-item replay and run first, because every other fix is keyed
 * on the merchant: with the name still misread, the per-shop drops and renames for that
 * shop are looked up under the wrong key and none of them fire. Stored globally
 * (merchant='') for the same reason — there is no shop to file it under yet.
 *
 * Gated on the same AUTO_FIX_AFTER as everything else even though one correction would
 * usually be right, because merchant names are where a user is most likely to type
 * something branch-specific ("Seven Eleven Shibuya") that must not be stamped onto the
 * next receipt from a different branch until they have shown they mean it.
 */
function applyMerchantFix(parsed) {
  const key = fixKey(parsed.merchant);
  if (!key) return { parsed, fix: null };
  const f = one(`SELECT * FROM finance_receipt_fix
                 WHERE merchant = '' AND kind = 'merchant' AND raw = ? AND hits >= ?`, key, AUTO_FIX_AFTER);
  if (!f?.user_value || f.user_value === parsed.merchant) return { parsed, fix: null };
  return {
    parsed: { ...parsed, merchant: f.user_value },
    fix: { kind: 'merchant', line: parsed.merchant, to: f.user_value, hits: f.hits },
  };
}

/** Replay learned corrections over a fresh scan. Deterministic — no model call. */
export function replayFixes(input) {
  const { parsed, fix: merchantFix } = applyMerchantFix(input);
  const fixes = fixesFor(parsed.merchant);
  if (!fixes.length && !merchantFix) return input;
  const drops = new Map(fixes.filter(f => f.kind === 'drop').map(f => [f.raw, f]));
  const renames = new Map(fixes.filter(f => f.kind === 'rename').map(f => [f.raw, f]));
  const amounts = new Map(fixes.filter(f => f.kind === 'amount').map(f => [f.raw, f]));

  const applied = merchantFix ? [merchantFix] : [];
  const kept = [];
  for (const it of parsed.items) {
    const key = fixKey(it.printed || it.name);
    if (drops.has(key)) {
      applied.push({ kind: 'drop', line: it.printed || it.name, hits: drops.get(key).hits });
      continue;
    }
    let line = it;
    const ren = renames.get(key);
    if (ren && ren.user_value && ren.user_value !== line.name) {
      applied.push({ kind: 'rename', line: it.printed || it.name, to: ren.user_value, hits: ren.hits });
      line = { ...line, name: ren.user_value };
    }
    // Amounts are replayed ONLY when the model made the identical mistake again — the
    // reading has to match the exact value the user corrected away from. Prices change,
    // and a fix that overwrote a genuinely new price with last month's would be a
    // hallucination the app invented itself, which is worse than the misread it fixed.
    const amt = amounts.get(key);
    const to = Number(amt?.user_value);
    if (amt && Number(amt.ai_value) === Number(line.amount) && Number.isFinite(to) && to > 0 && to !== Number(line.amount)) {
      applied.push({ kind: 'amount', line: it.printed || it.name, from: line.amount, to, hits: amt.hits });
      line = { ...line, amount: to };
    }
    kept.push(line);
  }
  if (!applied.length) return input;
  const out = { ...parsed };
  // A replayed `drop` removes a line the derived total was built from, so the total has to
  // come down with it. Without this the learned fix inflates the ledger by the amount of the
  // line it just removed — deterministically, on every future scan at this shop, which makes
  // it strictly worse than the same slip in normalize(). A PRINTED total is left alone.
  if (out.totalDerived && kept.length) {
    out.total = round2(kept.reduce((s, i) => s + (Number(i.amount) || 0), 0));
  }
  out.items = annotate(kept, out.total);
  out.check = reconcile(out.items, out);
  out.learned = applied;
  return out;
}

/** Identifies one correction: the model's reading paired with the reading the user
 *  committed. Stable across reverts and re-logs, which is exactly the point — those replay
 *  the same pair and must not be counted as the user correcting the same thing twice. */
function editSignature(aiJSON, userParsed) {
  return createHash('sha1')
    .update(String(aiJSON || '')).update(' ').update(JSON.stringify(userParsed ?? null))
    .digest('hex');
}

/** Diff the model's original extraction against what the user settled on, and learn. */
function learnFromEdit(aiParsed, userParsed) {
  if (!aiParsed?.items) return { learned: 0 };
  const merchant = userParsed.merchant || aiParsed.merchant;
  let n = 0;

  // The shop name first — it is the key everything else is filed under, so learning it is
  // what makes the per-shop corrections below findable on the next receipt from this shop.
  if (aiParsed.merchant && userParsed.merchant && fixKey(aiParsed.merchant) !== fixKey(userParsed.merchant)) {
    learnFix({ merchant: '', kind: 'merchant', raw: aiParsed.merchant, aiValue: aiParsed.merchant, userValue: userParsed.merchant });
    n++;
  }

  // Pair the model's lines with the user's. The printed text is the join key, and matching
  // on it is right for the common cases — but NOT for the one this editor exists to
  // support: correcting the printed text itself (牛丼 → 牛乳) changes the very key the
  // match is made on, so the line looks deleted and the model looks like it invented it.
  // Filing that as a `drop` teaches the scanner to silently bin a real product every time
  // it is printed, which is the most damaging thing this loop could learn. So an unmatched
  // model line gets a second chance against the user's unclaimed lines, paired on the
  // money — a line carrying the same amount at the same shop is the same purchase under a
  // corrected name, not a phantom.
  const byKey = new Map(userParsed.items.map(it => [fixKey(it.printed || it.name), it]));
  const claimed = new Set();
  const pairs = aiParsed.items.map((ai) => {
    const mine = byKey.get(fixKey(ai.printed || ai.name));
    if (mine && !claimed.has(mine)) { claimed.add(mine); return [ai, mine]; }
    return [ai, null];
  });
  const spare = userParsed.items.filter(it => !claimed.has(it));
  for (const pair of pairs) {
    if (pair[1]) continue;
    const i = spare.findIndex(s => Number(s.amount) === Number(pair[0].amount));
    if (i >= 0) pair[1] = spare.splice(i, 1)[0];
  }

  for (const [ai, mine] of pairs) {
    const raw = ai.printed || ai.name;
    if (!mine) {                                        // genuinely gone: the user deleted it
      learnFix({ merchant, kind: 'drop', raw, aiValue: String(ai.amount) });
      n++;
      continue;
    }
    if (mine.name && ai.name && mine.name !== ai.name) {
      learnFix({ merchant, kind: 'rename', raw, aiValue: ai.name, userValue: mine.name });
      n++;
    }
    if (Number(mine.amount) !== Number(ai.amount)) {
      learnFix({ merchant, kind: 'amount', raw, aiValue: String(ai.amount), userValue: String(mine.amount) });
      n++;
    }
  }
  return { learned: n };
}

/**
 * Is it actually getting better? The question any learning loop has to be able to answer,
 * and the reason the confidence score is stored on its own column rather than only inside
 * the parsed JSON.
 *
 * The comparison is deliberately last-10 against the 10 before: a running average over all
 * time flattens out exactly the improvement this is supposed to show, and a receipt from
 * six months ago says nothing about how well the scanner reads today's shopping.
 */
export function learningStats() {
  const fixes = all(`SELECT kind, COUNT(*) AS n, SUM(CASE WHEN hits >= ? THEN 1 ELSE 0 END) AS active
                     FROM finance_receipt_fix GROUP BY kind`, AUTO_FIX_AFTER);
  const scored = all(`SELECT confidence FROM finance_receipt
                      WHERE confidence >= 0 ORDER BY created_at DESC LIMIT 20`).map(r => Number(r.confidence));
  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const recent = mean(scored.slice(0, 10));
  const before = mean(scored.slice(10));

  let vocab = { items: 0, aliases: 0, confirmed: 0 };
  try {
    vocab = {
      items: one('SELECT COUNT(*) AS n FROM finance_item WHERE deleted = 0')?.n || 0,
      aliases: one('SELECT COUNT(*) AS n FROM finance_item_alias')?.n || 0,
      confirmed: one('SELECT COUNT(*) AS n FROM finance_item_alias WHERE confirmed = 1')?.n || 0,
    };
  } catch { /* catalogue unavailable */ }

  const scans = one(`SELECT COUNT(*) AS n,
                            SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) AS applied,
                            SUM(CASE WHEN parsed_ai <> '' THEN 1 ELSE 0 END) AS edited
                     FROM finance_receipt`) || {};

  return {
    corrections: {
      total: fixes.reduce((s, f) => s + f.n, 0),
      active: fixes.reduce((s, f) => s + (f.active || 0), 0),
      byKind: Object.fromEntries(fixes.map(f => [f.kind, { total: f.n, active: f.active || 0 }])),
      activeAfter: AUTO_FIX_AFTER,
    },
    vocab,
    scans: { total: scans.n || 0, applied: scans.applied || 0, edited: scans.edited || 0 },
    confidence: { recent, before, trend: recent !== null && before !== null ? recent - before : null, n: scored.length },
  };
}

/**
 * Read the same photo again — the "it misread that, have another go" button.
 *
 * Worth having because this model's output genuinely varies run to run: the same receipt
 * read `虫ゴム交換` twice and `虫刀交換` once across three scans. A second attempt is often
 * simply right, and it costs ~15s. `model` lets the retry try a different reader without
 * changing the default for everything.
 *
 * Refuses once the receipt is in the ledger (revert first) and clears the edit baseline,
 * because a fresh reading is a fresh baseline — diffing the user's old corrections against
 * a different reading would learn nonsense.
 */
export async function rescan(id, { model, rotate, signal } = {}) {
  const row = one('SELECT * FROM finance_receipt WHERE id = ?', String(id || ''));
  if (!row) throw missing('receipt not found');
  if (row.status === 'applied') throw bad('this receipt is in the ledger — undo it first, then re-read the photo');
  if (!row.upload_id) throw bad('this receipt has no stored photo to re-read');

  const fresh = await scan({ uploadId: row.upload_id, model, rotate, signal });
  // scan() creates its own row; move the result onto this one and drop the duplicate so
  // the receipt keeps its identity (and its place in the list).
  row.status = fresh.status;
  row.model = fresh.model;
  row.raw = '';
  row.parsed = fresh.parsed ? JSON.stringify(fresh.parsed) : '';
  row.parsed_ai = '';
  row.error = fresh.error || '';
  row.updated_at = now();
  // Carry the orientation note across — it lives on the in-memory record, not a column,
  // and the UI needs it to say what happened and offer the other direction.
  row.oriented = fresh.oriented || null;
  const saved = save(row);
  try { deleteReceipt(fresh.id); } catch { /* already gone */ }
  return saved;
}

// ---------- reading an earnings screen ----------
//
// A payout screen is NOT a receipt, and running it through the machinery above would be a
// mistake in three separate places: the duplicate guard fingerprints a shop and a basket
// (a payout has neither), the per-shop correction loop would file platform wording under
// merchant keys, and `apply()` posts expenses. It also does not need any of that — there
// is nothing to reconcile, because a payout screen states its own arithmetic.
//
// So this shares only the part worth sharing — the reader, the crop, the band-stitching —
// and returns a SUGGESTION. Nothing is stored, nothing reaches the ledger, and the income
// form opens with the numbers filled in for the user to confirm. That is the whole point:
// the slow part of logging a delivery shift is typing four numbers off a phone screen,
// not deciding whether they are right.

const EARNINGS_SCHEMA = {
  name: 'earnings',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['payer', 'date', 'currency', 'gross', 'fee', 'net', 'jobs', 'hours'],
    properties: {
      payer: { type: ['string', 'null'] },
      date: { type: ['string', 'null'] },
      currency: { type: ['string', 'null'] },
      gross: { type: ['number', 'null'] },
      fee: { type: ['number', 'null'] },
      net: { type: ['number', 'null'] },
      jobs: { type: ['number', 'null'] },
      hours: { type: ['number', 'null'] },
    },
  },
};

const EARNINGS_PROMPT = `This is a screenshot of an earnings or payout summary from a work app (a delivery platform, a rideshare app, a freelance marketplace).

Report only what is printed:
- payer: the app or client paying (e.g. "Uber Eats", "Upwork").
- date: YYYY-MM-DD. If it shows a range or a week, use the LAST day of it. Use {YEAR} if no year is printed.
- currency: ISO code.
- gross: the total before the platform's cut, if shown separately.
- fee: the platform's cut / service fee / commission, as a positive number.
- net: what the worker actually receives — the figure headlined as earnings or payout.
- jobs: number of trips, deliveries or tasks.
- hours: time online or worked, in hours (convert "1h 30m" to 1.5).

Use null for anything not on the screen. Never calculate a figure that is not printed, and never guess a payer from the visual style.`;

/** A figure off a payout screen, or null. Zero counts as "not printed": these screens show
 *  a dash or nothing at all for a cut that was not taken, and a model asked for a number
 *  hands back 0 — which would otherwise read as a fee that was genuinely zero. */
const earnNum = (v) => (Number.isFinite(Number(v)) && Number(v) !== 0 ? Math.abs(round2(Number(v))) : null);

/**
 * Reconcile the three money figures against each other, the way a receipt reconciles.
 *
 * A payout screen almost never prints all three, and the missing one is derivable — but
 * only ever from two that were actually READ. Deriving net from a gross the model invented
 * would produce a confident wrong number with nothing to check it against, so anything
 * filled in here is marked `derived` and the UI says so.
 */
export function reconcileEarnings(o) {
  const out = { ...o, derived: [] };
  if (out.net === null && out.gross !== null && out.fee !== null) { out.net = round2(out.gross - out.fee); out.derived.push('net'); }
  else if (out.fee === null && out.gross !== null && out.net !== null && out.gross > out.net) { out.fee = round2(out.gross - out.net); out.derived.push('fee'); }
  else if (out.gross === null && out.net !== null && out.fee !== null) { out.gross = round2(out.net + out.fee); out.derived.push('gross'); }
  // A fee bigger than the payout means two figures were read off unrelated parts of the
  // screen. Better to hand over just the payout than a subtraction nobody can check.
  if (out.net !== null && out.fee !== null && out.fee >= out.net + out.gross) { out.fee = null; out.gross = null; }
  return out;
}

/**
 * Which shape the income form should open in.
 *
 * Ordered by how much the reading actually tells us, not by preference: a screen showing
 * gross AND the platform's cut supports the fee mode, which is the only one that records
 * what was skimmed. Falling back to a flat amount always works, because `net` is the one
 * figure these screens are built to show.
 */
export function earningsMode(o) {
  if (o.gross !== null && o.fee) return 'fee';
  if (o.hours) return 'hourly';
  if (o.jobs) return 'unit';
  return 'amount';
}

/**
 * OCR an earnings screenshot into a prefill for the income form. Read-only.
 */
export async function readEarnings({ uploadId, model, signal } = {}) {
  const meta = getMeta(String(uploadId || ''));
  if (!meta) throw missing('upload not found — attach the screenshot first');
  if (meta.kind !== 'image') throw bad('reading earnings needs a screenshot, not a ' + meta.kind);

  const modelRef = String(model || ocrModel());
  if (!modelRef) throw bad('no model configured — set finance.ocrModel or a default chat model in Settings');
  const prompt = EARNINGS_PROMPT.replace('{YEAR}', new Date().getFullYear());

  let text = '', raw = '', used = modelRef;
  if (refIsTranscriber(modelRef)) {
    const textModel = structureModel();
    used = `${modelRef} → ${textModel}`;
    raw = await transcribeTall(meta, modelRef, signal, { max: tilePolicy() });
    if (!raw) throw bad('the OCR model could not read anything on that screenshot');
    const res = await streamChat({
      modelRef: textModel, system: STRUCTURE_SYSTEM,
      messages: [{ role: 'user', text: `${prompt}\n\n--- transcription ---\n${raw.slice(0, 12000)}` }],
      schema: EARNINGS_SCHEMA, maxTokens: 2048, sampling: { temperature: 0 }, signal,
    });
    text = String(res.text || res.reasoning || '');
  } else {
    const res = await streamChat({
      modelRef, messages: [{ role: 'user', text: prompt, attachments: [meta] }],
      schema: EARNINGS_SCHEMA, maxTokens: 4096, sampling: { temperature: 0 }, signal,
    });
    text = String(res.text || res.reasoning || '');
    raw = text;
  }

  const obj = extractJSON(text, { require: ['net', 'gross', 'payer'] });
  if (!obj) return { parsed: null, raw, model: used, error: 'could not make out any earnings on that screenshot' };

  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(String(obj.date || ''));
  const parsed = reconcileEarnings({
    payer: String(obj.payer ?? '').trim().slice(0, 80),
    date: dateOk ? obj.date : new Date().toISOString().slice(0, 10),
    dateGuessed: !dateOk,
    currency: /^[A-Za-z]{3}$/.test(String(obj.currency || '')) ? String(obj.currency).toUpperCase() : finance.settings().baseCurrency,
    gross: earnNum(obj.gross), fee: earnNum(obj.fee), net: earnNum(obj.net),
    jobs: earnNum(obj.jobs), hours: earnNum(obj.hours),
  });
  parsed.mode = earningsMode(parsed);
  if (parsed.net === null && parsed.gross === null) {
    return { parsed: null, raw, model: used, error: 'no payout figure was legible on that screenshot' };
  }
  return { parsed, raw: String(raw).slice(0, 20000), model: used, error: '' };
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

  // Re-score after the edit. The number the user sees has to answer "is this right *now*",
  // not "was the model's first guess any good" — fixing the line that did not add up should
  // visibly move it. `reads`/`angle` carry over: they describe how the photo was read, and
  // typing in the editor does not change that.
  clean.confidence = { ...scoreConfidence(clean), reads: current.confidence?.reads, angle: current.confidence?.angle };

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

  // The same shopping trip cannot be logged twice. Checked here rather than at scan time
  // because this is the only moment money actually moves, and refused outright rather than
  // confirmed: a genuine second purchase of an identical basket at an identical price on
  // the same day does not really happen, and an "add it anyway" button would get clicked
  // past exactly when it mattered.
  const fp = receiptFingerprint(p);
  const dupe = duplicateOf(fp, row.id);
  if (dupe) {
    throw Object.assign(
      new Error(`this receipt is already in the ledger — ${dupe.merchant || 'a receipt'} on ${dupe.date} for `
        + `${p.currency || ''} ${dupe.total} was logged from scan ${dupe.id}. Delete this copy, or undo that one and re-log it.`),
      { status: 409, duplicateOf: dupe.id },
    );
  }

  // Learn before writing: the user is committing to this reading, which is the strongest
  // signal available that the differences from the model's version were real corrections.
  //
  // Once per CORRECTION, never once per apply. See financedb.js on learned_sig — reverting
  // and re-logging replays a byte-identical diff, and counting it again is what let a single
  // user action cross the trust gate that is supposed to need two.
  let learned = { learned: 0 };
  const aiParsed = row.parsed_ai ? parseJSON(row.parsed_ai, null) : null;
  const sig = aiParsed ? editSignature(row.parsed_ai, p) : '';
  if (aiParsed && sig === row.learned_sig) {
    learned = { learned: 0, alreadyLearned: true };
  } else if (aiParsed) {
    try {
      learned = learnFromEdit(aiParsed, p);
      run('UPDATE finance_receipt SET learned_sig = ? WHERE id = ?', sig, row.id);
      row.learned_sig = sig;
    } catch (e) { console.error('[receipts] could not learn from the edit:', e.message); }
  }

  const base = {
    date: p.date, kind: 'expense', currency: p.currency, category: p.category,
    merchant: p.merchant, source: 'ocr', receiptId: row.id,
  };
  // The money and the bookkeeping that makes it undoable commit together.
  //
  // They used to be separated by an unbounded model round-trip (recordLineItems reaches
  // itemsai, which is seconds to a minute on this box), with the ledger written first and
  // `status`/`txn_ids` only after. A restart in that window left real expenses attached to a
  // receipt that still read "not applied yet": invisible to the duplicate guard, unreachable
  // by revert (it sources its ids from txn_ids), and re-posted in full on the next attempt.
  // tx() is synchronous and cannot span an await, so the model work moves below the commit.
  let applied;
  const created = tx(() => {
    const rows = mode === 'items' && p.items?.length
      ? p.items.map(it => finance.addTxn({ ...base, amount: it.amount, note: it.name }))
      : [finance.addTxn({ ...base, amount: p.total, note: p.paymentMethod ? `paid ${p.paymentMethod}` : '' })];
    row.status = 'applied';
    // Store the reading that was actually logged, overrides and all. Two reasons: the scan
    // should agree with the ledger rows it produced, and save() derives the duplicate
    // fingerprint from this field — a fingerprint taken from a reading that was overridden
    // on the way in would not match the next copy of the same receipt.
    row.parsed = JSON.stringify(p);
    row.txn_ids = JSON.stringify(rows.map(t => t.id));
    row.updated_at = now();
    applied = save(row);
    return rows;
  });

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
  // After the commit, and never allowed to undo it. Price history is a nice-to-have; the
  // ledger row is the point, and losing money because the classifier was busy would be the
  // worst possible trade.
  let priced = { recorded: 0, resolved: 0 };
  try { priced = await recordLineItems(p, row, created, { signal, editedKeys }); }
  catch (e) { console.error('[receipts] prices not recorded (the ledger write already stands):', e.message); }

  return { receipt: applied, created, items: priced, learned };
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
  const wasEdited = (l) => !!l.edited || editedKeys.has(fixKey(rawOf(l)));

  // A line the user renamed does NOT go to the model. Their typed name is the intent, and
  // asking a classifier to re-derive it from the misread printed text is how "牛乳 read as
  // 牛丼, corrected to Milk" still ended up filed as Beef Bowl.
  const mine = lines.filter(wasEdited);
  const theirs = lines.filter(l => !wasEdited(l));

  const resolved = new Map();
  if (theirs.length) {
    try {
      const { resolveNames } = await import('./itemsai.js');
      const m = await resolveNames(theirs.map(rawOf), { signal });
      for (const [k, v] of m) resolved.set(k, v);
    } catch (e) {
      console.error('[receipts] item resolution unavailable:', e.message);
    }
  }
  for (const line of mine) {
    try {
      const item = items.itemForName(line.name, { category: p.category });
      if (item) resolved.set(rawOf(line), { itemId: item.id, how: 'user' });
    } catch (e) {
      console.error('[receipts] could not file', line.name, '-', e.message);
    }
  }

  // When the ledger got one row per item, tie each price point to its own row so
  // deleting a transaction can be traced back to the purchase it came from.
  const txnFor = (i) => (created.length === lines.length ? created[i]?.id : created[0]?.id) || '';

  let ok = 0;
  lines.forEach((line, i) => {
    const raw = rawOf(line);
    const itemId = resolved.get(raw)?.itemId || '';
    const edited = wasEdited(line);
    try {
      items.recordPurchase({
        itemId,
        txnId: txnFor(i), receiptId: row.id,
        date: p.date, merchant: p.merchant, rawName: raw,
        qty: line.qty, lineTotal: line.amount, currency: p.currency,
        source: edited ? 'manual' : 'ocr',
      });
      if (itemId) ok++;
      // A line the user personally named and then committed is settled: bind its key to
      // THEIR item, confirmed, so the next receipt resolves the same way with no model.
      if (itemId && edited) items.learnAlias(raw, itemId, { source: 'manual', confirmed: true });
    } catch (e) {
      console.error('[receipts] could not record', raw, '-', e.message);
    }
  });
  return { recorded: lines.length, resolved: ok, userNamed: mine.length };
}
