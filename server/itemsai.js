// Turning printed receipt lines into catalogue entries.
//
// Called only for strings that items.js could not resolve locally, and always
// shown the existing catalogue so it reuses "Milk" rather than minting "Fresh
// Milk", "Whole Milk 1L" and "牛乳" as three separate things. Every mapping it
// produces is written unconfirmed; the user confirming it in the review queue is
// what promotes it to the point of truth.
//
// The whole receipt is resolved in one call. Batching matters here: a 20-line
// supermarket receipt would otherwise be 20 round trips at several seconds each
// on local hardware.

import { streamChat } from './llm.js';
import { loadConfig } from './config.js';
import { jsonBlocks } from './util.js';
import * as items from './items.js';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const SYSTEM = `You classify supermarket and convenience-store receipt lines into a catalogue of generic products.

Rules, in order of importance:
1. BRAND IS NOISE. "明治おいしい牛乳", "ヤマダ牛乳", "TANAKA MILK" are all just "Milk". Strip manufacturer, store and marketing words. Keep the product and only the distinctions a shopper actually chooses between (whole vs skimmed milk; chicken vs pork mince).
2. REUSE THE CATALOGUE. If an existing entry fits, return its id. Only create a new entry when nothing fits. Near-duplicates are the failure mode to avoid.
3. Size does NOT belong in the name. "Milk", never "Milk 1L" — sizes are recorded separately.
4. name_en is natural English. name_ja is the generic Japanese term (牛乳), not the printed brand string.
5. Return STRICT JSON only. No prose, no markdown fences.`;

/**
 * The result shape, enforced by the decoder.
 *
 * Note what this removes: the prompt below carefully describes three mutually-exclusive
 * entry forms and warns against echoing the template, and pickResults() then SCORES the
 * candidate blocks to find the real answer among the model's restatements. A grammar
 * makes the template-echo failure impossible, because a restatement is not a valid parse.
 * Both defences stay for providers that ignore response_format.
 */
const RESULTS_SCHEMA = {
  name: 'item_results',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'item_id', 'create', 'skip'],
          properties: {
            index: { type: 'number' },
            // Exactly one of these carries the answer; the other two are null. Modelling
            // it as a union would be cleaner, but strict mode needs every key present and
            // llama.cpp's converter handles nullable unions far more predictably.
            item_id: { type: ['string', 'null'] },
            skip: { type: ['boolean', 'null'] },
            create: {
              type: ['object', 'null'],
              additionalProperties: false,
              required: ['name_en', 'name_ja', 'category', 'subcategory', 'unit', 'typical_size'],
              properties: {
                name_en: { type: 'string' },
                name_ja: { type: 'string' },
                category: { type: 'string' },
                subcategory: { type: 'string' },
                unit: { type: 'string', enum: ['ml', 'g', 'each'] },
                typical_size: { type: 'number' },
              },
            },
          },
        },
      },
    },
  },
};

function buildPrompt(lines, cat) {
  const catalogue = cat.length
    ? cat.map(c => `  ${c.id}  ${c.nameEn}${c.nameJa ? ` / ${c.nameJa}` : ''}  [${c.category}${c.subcategory ? '/' + c.subcategory : ''}, per ${c.unit}]`).join('\n')
    : '  (empty — everything will be a new entry)';

  const todo = lines.map((l, i) => {
    const sug = l.suggestions?.length
      ? `\n     closest existing: ${l.suggestions.map(s => `${s.id} ${s.nameEn} (${Math.round(s.score * 100)}%)`).join(', ')}`
      : '';
    return `  ${i}. ${JSON.stringify(l.rawName)}${sug}`;
  }).join('\n');

  // The shape is described with placeholders that could never be a real answer
  // (angle brackets, ALL-CAPS). Reasoning models routinely restate the template
  // before answering, and a template full of plausible values — "Milk", 1000 —
  // gets adopted verbatim as the result. pickResults() rejects any block still
  // carrying these markers.
  return `EXISTING CATALOGUE (reuse these ids wherever one fits):
${catalogue}

RECEIPT LINES TO CLASSIFY (${lines.length} lines, indices 0-${lines.length - 1}):
${todo}

Reply with exactly one JSON object and nothing else. It must contain a "results"
array holding one entry per line above, in index order. Each entry is one of:

  {"index": N, "item_id": "<ID COPIED FROM THE CATALOGUE ABOVE>"}
  {"index": N, "create": {"name_en": "<GENERIC ENGLISH NAME>", "name_ja": "<GENERIC JAPANESE NAME>",
                          "category": "<CATEGORY>", "subcategory": "<SUBCATEGORY>",
                          "unit": "ml|g|each", "typical_size": <NUMBER>}}
  {"index": N, "skip": true}

Rules for "create":
- "unit" is ml for liquids, g for things sold by weight, each for countable items.
- "typical_size" is the usual pack size in that unit; use 1 with "each" when unsure.
- Never put a size or a brand in the name.
Use "item_id" OR "create", never both. Use "skip" only for non-products: discounts,
subtotals, tax lines, bag charges, points.
Replace every <PLACEHOLDER> with a real value — do not echo this template back.`;
}

/** Choose the model's real answer from among every JSON object in the reply.
 *  Scored rather than positional, because the answer can appear before or after
 *  an echoed copy of the template depending on how the model reasons. */
function pickResults(text, expected) {
  const blocks = jsonBlocks(text).filter(b => Array.isArray(b.results));
  let best = null, bestScore = -Infinity;
  blocks.forEach((b, pos) => {
    const rows = b.results;
    let score = 0;
    // Template echoes keep the <PLACEHOLDER> markers; that is disqualifying.
    const looksTemplated = rows.some(r =>
      /^</.test(String(r.item_id ?? '')) || /[<>]/.test(JSON.stringify(r.create ?? '')));
    if (looksTemplated) score -= 100;
    const inRange = rows.filter(r => Number.isInteger(Number(r.index))
      && Number(r.index) >= 0 && Number(r.index) < expected).length;
    score += inRange * 2;
    if (rows.length === expected) score += 5;
    score += pos * 0.1;                       // later blocks edge it, all else equal
    if (score > bestScore) { bestScore = score; best = b; }
  });
  return bestScore > 0 ? best : null;
}

/** Resolve printed names to catalogue items, creating entries where needed.
 *  `lines`: [{ rawName }]. Returns a Map keyed by rawName → { itemId, how }. */
export async function resolveNames(rawNames, { model, signal } = {}) {
  const out = new Map();
  const needsModel = [];

  for (const rawName of rawNames) {
    if (!rawName || out.has(rawName)) continue;
    const local = items.resolveLocal(rawName);
    if (local) out.set(rawName, local);
    else needsModel.push({ rawName, suggestions: items.candidates(rawName, { limit: 3 }) });
  }
  if (!needsModel.length) return out;

  const cfg = loadConfig();
  const modelRef = String(model || cfg.finance?.itemModel || cfg.finance?.ocrModel || cfg.defaults?.chatModel || '').trim();
  if (!modelRef) throw bad('no model configured — set a default chat model in Settings');

  const res = await streamChat({
    modelRef,
    system: SYSTEM,
    messages: [{ role: 'user', text: buildPrompt(needsModel, items.catalogue({ limit: 250 })) }],
    // Grammar-constrained, same reasoning as receipts.js: the decoder guarantees the
    // shape, so a reply that is 90% deliberation still ends in a parseable object.
    // pickResults() below stays as the fallback for providers that ignore the schema.
    schema: RESULTS_SCHEMA,
    maxTokens: 4096,
    sampling: { temperature: 0 },
    signal,
  });

  const parsed = pickResults(res.text || res.reasoning || '', needsModel.length);
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  if (!results.length) console.error('[items] model returned no usable results for', needsModel.length, 'line(s)');
  const byIndex = new Map(results.map(r => [Number(r.index), r]));
  // One catalogue read for the whole receipt. Verifying ids line-by-line re-read the
  // entire table per line, so a 20-line supermarket receipt did 20 full scans of it.
  const knownIds = new Set(items.catalogue({ limit: 2000 }).map(c => c.id));

  needsModel.forEach((line, i) => {
    const r = byIndex.get(i);
    if (!r || r.skip) { out.set(line.rawName, null); return; }
    try {
      if (r.item_id) {
        // Trust but verify: a hallucinated id must not silently drop the line.
        if (knownIds.has(r.item_id)) {
          items.learnAlias(line.rawName, r.item_id, { source: 'ai', confirmed: false });
          out.set(line.rawName, { itemId: r.item_id, how: 'ai:matched' });
          return;
        }
      }
      const newName = String(r.create?.name_en || '');
      if (r.create && /[<>]|^\.{3}$/.test(newName)) {
        console.error('[items] refusing placeholder item name:', newName);
      } else if (newName) {
        const created = items.createItem({
          nameEn: r.create.name_en, nameJa: r.create.name_ja,
          category: r.create.category || 'Groceries', subcategory: r.create.subcategory,
          unit: r.create.unit, typicalSize: r.create.typical_size,
        });
        items.learnAlias(line.rawName, created.id, { source: 'ai', confirmed: false });
        out.set(line.rawName, { itemId: created.id, how: 'ai:created' });
        return;
      }
    } catch (e) {
      console.error('[items] could not apply model result for', line.rawName, '-', e.message);
    }
    out.set(line.rawName, null);
  });

  return out;
}
