#!/usr/bin/env node
// Receipt OCR bench — score a reader against receipts you have already checked by hand.
//
//   npm run receipt-bench                          the configured OCR model
//   npm run receipt-bench -- --models a,b,c        several, one table
//   npm run receipt-bench -- --all-ocr             every model tagged `ocr`
//   npm run receipt-bench -- --limit 5             a quick pass
//   npm run receipt-bench -- --with-fixes          measure the pipeline, not the model
//   npm run receipt-bench -- --json out.json       machine-readable, for diffing runs
//   npm run receipt-bench -- --stored              score the readings already in the archive (no GPU)
//   npm run receipt-bench -- --text-model <ref>    which model turns the transcription into fields
//   npm run receipt-bench -- --no-deskew           measure what straightening is worth
//
// WHY THIS EXISTS
//
// Every published OCR benchmark scores page parsing on public corpora. None of them has
// seen a Japanese convenience-store receipt photographed by hand on this phone, which is
// the only document this pipeline will ever be asked to read. Swapping readers on the
// strength of someone else's leaderboard is a guess.
//
// The ground truth was collected without anyone meaning to. Every receipt the user pressed
// Log on is one they read against the paper and vouched for, and `finance_receipt.parsed`
// holds that settled version — corrected where the model was wrong. So the archive is a
// labelled test set: an image on disk, and the answer beside it.
//
// WHAT IS AND IS NOT MEASURED
//
// By default the learned per-shop corrections are turned OFF (see readReceipt's useFixes).
// They were learned from corrections made to these exact receipts, so replaying them is
// handing over the answer sheet — every reader would look good and the ranking would mean
// nothing. `--with-fixes` measures the other thing, which is a fair question in its own
// right: how well does the whole pipeline do, corrections and all.
//
// Vocabulary priming (learnedPromptBlock) stays on in both modes. It is drawn from the
// confirmed item catalogue rather than from these receipts' answers, and it is a standing
// production feature that will help on receipts this bench has never seen.
//
// Nothing here writes to the receipt archive. Each photo is copied to a throwaway upload
// first, because reading one rotates it — benching in place would both corrupt the archive
// and mean the second run measured different pixels than the first.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = (m) => import(path.join(ROOT, 'server', m));

// ---------- args ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const OPTS = {
  models: opt('models').split(',').map(s => s.trim()).filter(Boolean),
  allOcr: flag('all-ocr'),
  limit: Number(opt('limit', '0')) || 0,
  withFixes: flag('with-fixes'),
  json: opt('json'),
  stored: flag('stored'),
  textModel: opt('text-model'),
  noDeskew: flag('no-deskew'),
  verbose: flag('verbose') || flag('v'),
};

// ---------- scoring primitives ----------

/** NFKC-folded, case-flattened, whitespace-free. Two strings that a person would read as
 *  the same product name have to compare equal, or the item score measures typography. */
const norm = (s) => String(s ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s　]+/g, '')
  .replace(/[.,·・:：;；()（）\[\]【】"'`*]/g, '')
  .trim();

/** Levenshtein, iterative with a rolling row — the names here are short, but a 100-item
 *  receipt against 5 models is 500 comparisons per field and the quadratic version showed
 *  up in the run time. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur.slice();
  }
  return prev[b.length];
}

/** Character error rate against the TRUTH's length — the conventional denominator, and the
 *  one that makes a model which invents ten extra characters score worse than 100%. */
const cer = (truth, pred) => {
  const t = norm(truth), p = norm(pred);
  if (!t.length) return p.length ? 1 : 0;
  return editDistance(t, p) / t.length;
};

const sim = (a, b) => 1 - Math.min(1, cer(a, b));

const money = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const moneyEq = (a, b) => {
  const x = money(a), y = money(b);
  if (x === null && y === null) return true;
  if (x === null || y === null) return false;
  return Math.abs(x - y) < 0.005;
};

// ---------- item matching ----------

/**
 * Line up the read items against the true ones, then say how well.
 *
 * Greedy on best name similarity rather than by position: a reader that misses one line
 * shifts every line after it, and a positional comparison would score that as everything
 * wrong instead of one thing missing.
 *
 * A pair only counts as matched at similarity >= 0.6. Below that they are different
 * products, and calling them a match would quietly convert a hallucinated line into a
 * "slightly misspelt" one — which is the exact failure this pipeline exists to catch.
 */
const MATCH_FLOOR = 0.6;

/**
 * What the paper says, not what the user called it.
 *
 * A receipt item carries two names: `printed`, the raw string transcribed off the paper,
 * and `name`, the tidy label the user keeps for the catalogue. They differ on 85 of the
 * 108 items in this archive — 「A&成分無調整牛乳」 is filed as 「牛乳」, and a FamilyMart
 * line printed 「アイスコーヒーM ¥250」 is filed as "Ice Coffee M". Scoring a reader
 * against `name` therefore marks a perfect transcription wrong for not having guessed the
 * user's shorthand, which is not an OCR question at all. `printed` is the ground truth.
 */
const itemText = (i) => String(i.printed || i.name || '');

function matchItems(truth, pred) {
  const T = (truth || []).map(i => ({ name: itemText(i), amount: money(i.amount) }));
  const P = (pred || []).map(i => ({ name: itemText(i), amount: money(i.amount) }));
  const takenP = new Set();
  const pairs = [];

  for (let ti = 0; ti < T.length; ti++) {
    let best = -1, bestScore = 0;
    for (let pi = 0; pi < P.length; pi++) {
      if (takenP.has(pi)) continue;
      let sc = sim(T[ti].name, P[pi].name);
      // A name that reads the same and an amount that agrees is a stronger match than a
      // name alone — this is what keeps two identical "コーヒー" lines from swapping.
      if (moneyEq(T[ti].amount, P[pi].amount)) sc += 0.25;
      if (sc > bestScore) { bestScore = sc; best = pi; }
    }
    if (best >= 0 && bestScore >= MATCH_FLOOR) {
      takenP.add(best);
      pairs.push({ t: T[ti], p: P[best] });
    } else {
      pairs.push({ t: T[ti], p: null });                       // missed
    }
  }
  const spurious = P.length - takenP.size;                     // invented
  const matched = pairs.filter(x => x.p).length;
  const amountsRight = pairs.filter(x => x.p && moneyEq(x.t.amount, x.p.amount)).length;
  const nameCers = pairs.filter(x => x.p).map(x => cer(x.t.name, x.p.name));

  // Amount coverage is reported separately from name matching, and it is the number to
  // trust when the two disagree.
  //
  // `printed` in the archive is what a MODEL transcribed; the user corrects `name` and
  // rarely touches it, so name matching partly measures "does this reader agree with the
  // reader that came before it". Amounts do not have that problem — every one of them
  // feeds the total, the total is reconciled, and a wrong one is what makes a user open
  // the receipt in the first place. So the amounts are checked against the whole reading
  // rather than only against matched pairs.
  const predAmounts = new Set(P.map(x => x.amount).filter(v => v !== null));
  const amountsFound = T.filter(t => t.amount !== null && predAmounts.has(t.amount)).length;
  const amountable = T.filter(t => t.amount !== null).length;

  const precision = P.length ? matched / P.length : (T.length ? 0 : 1);
  const recall = T.length ? matched / T.length : 1;
  return {
    truthCount: T.length, predCount: P.length, matched, spurious,
    missed: T.length - matched, amountsRight,
    amountsFound, amountable,
    precision, recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    nameCer: nameCers.length ? nameCers.reduce((a, b) => a + b, 0) / nameCers.length : (T.length ? 1 : 0),
    pairs,
  };
}

// ---------- one receipt ----------

function scoreOne(truth, pred, receipts, judgeable = true) {
  if (!pred) {
    return {
      read: false, merchant: false, date: false, total: false, subtotal: false,
      tax: false, currency: false, items: matchItems(truth.items, []), reconciled: false, score: 0,
    };
  }
  const merchant = receipts.merchantKey(truth.merchant || '') === receipts.merchantKey(pred.merchant || '')
    && !!(truth.merchant || pred.merchant);
  const items = matchItems(truth.items, pred.items);

  // Does the reading survive the pipeline's own arithmetic check? A reader can get every
  // field wrong and still balance, or get everything right on a receipt whose printed
  // subtotal genuinely does not add up — so this is reported beside accuracy, never as it.
  let reconciled = false;
  try {
    const r = receipts.normalizeParsed(JSON.parse(JSON.stringify(pred)));
    reconciled = !(r?.confidence?.reasons || []).some(x => x.delta < 0);
  } catch { /* unscoreable reading */ }

  const s = {
    read: true,
    merchant,
    date: !!truth.date && truth.date === pred.date,
    total: moneyEq(truth.total, pred.total),
    subtotal: moneyEq(truth.subtotal, pred.subtotal),
    tax: moneyEq(truth.tax, pred.tax),
    currency: (truth.currency || '') === (pred.currency || ''),
    items, reconciled,
  };

  // One number to sort a table by. Weighted by what actually costs the user time when it
  // is wrong: a wrong total is money in the ledger, a wrong item name is a catalogue entry
  // to fix later. Deliberately not a benchmark metric anyone else would recognise — it is
  // the ranking for THIS job, and every component is printed beside it.
  // On a receipt with no printed ground truth the item terms are unanswerable, so the
  // remaining weights are renormalised rather than scored as zero — otherwise a reader
  // that got everything knowable right would still cap at 60.
  const w = judgeable
    ? { total: 0.34, merchant: 0.16, date: 0.10, f1: 0.30, cer: 0.10 }
    : { total: 0.567, merchant: 0.267, date: 0.166, f1: 0, cer: 0 };
  s.score = Math.round(100 * (
    w.total * (s.total ? 1 : 0) +
    w.merchant * (s.merchant ? 1 : 0) +
    w.date * (s.date ? 1 : 0) +
    w.f1 * items.f1 +
    w.cer * Math.max(0, 1 - items.nameCer)
  ));
  return s;
}

// ---------- run ----------

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

async function main() {
  const receipts = await S('receipts.js');
  const uploads = await S('uploads.js');
  const { all } = await S('financedb.js');
  const { listLocalModels, modelAlias, presetFor, refIsTranscriber } = await S('llmctl.js');
  const { loadConfig } = await S('config.js');

  // ----- the truth set -----
  //
  // 'applied' is the vouching signal: the user read it against the paper and pressed Log.
  // An edited-but-never-applied scan was abandoned mid-review and its `parsed` is a
  // half-finished correction, which would be worse than no answer.
  const rows = all(`SELECT id, upload_id, parsed, parsed_ai, model, confidence, created_at
                    FROM finance_receipt
                    WHERE status = 'applied' AND upload_id <> '' AND parsed <> ''
                    ORDER BY created_at`);

  const cases = [];
  for (const r of rows) {
    let truth = null;
    try { truth = JSON.parse(r.parsed); } catch { continue; }
    if (!truth || !truth.items) continue;
    const meta = uploads.getMeta(r.upload_id);
    if (!meta) { console.warn(`  skip ${r.id}: photo no longer on disk`); continue; }
    if (meta.kind !== 'image') continue;
    // Some early receipts were typed rather than corrected — a single item called
    // "Main Purchase" with no `printed` at all. Merchant, date and total are still real
    // ground truth there; the item score is not, and averaging it in would drag every
    // reader down by the same meaningless amount.
    const judgeable = (truth.items || []).some(i => i.printed);
    cases.push({ id: r.id, uploadId: r.upload_id, truth, judgeable, edited: !!r.parsed_ai, wasModel: r.model });
  }
  if (!cases.length) {
    console.error('No benchable receipts. This needs receipts that have been scanned AND applied to the ledger.');
    process.exit(1);
  }
  // Evenly spaced, not the first N. The archive is in date order and the oldest entries
  // are the least representative — they are from before the pipeline settled, and their
  // truth was typed rather than corrected. Taking every k-th receipt keeps a --limit run
  // a fair miniature of the whole set instead of a tour of its worst corner.
  const use = OPTS.limit && OPTS.limit < cases.length
    ? Array.from({ length: OPTS.limit }, (_, i) => cases[Math.floor(i * cases.length / OPTS.limit)])
    : cases;

  // ----- the models -----
  let models = OPTS.models;
  if (OPTS.allOcr) {
    models = listLocalModels()
      .filter(m => presetFor(m.file, m.sizeGB).tags.includes('ocr'))
      .map(m => `local:${modelAlias(m.file)}`);
  }
  if (!models.length) {
    const configured = loadConfig().finance?.ocrModel;
    if (!configured) { console.error('No model given and finance.ocrModel is not set.'); process.exit(1); }
    models = [configured];
  }
  // Accept a bare alias as well as a full ref, so `--models hunyuanocr-q8_0` works.
  models = models.map(m => (m.includes(':') ? m : `local:${m}`));

  console.log(`\nReceipt OCR bench`);
  console.log(`  receipts   ${use.length} applied${OPTS.limit ? ` (of ${cases.length}, --limit)` : ''}, ${use.filter(c => c.edited).length} of them hand-corrected`);
  console.log(`  models     ${models.join(', ')}`);
  if (OPTS.noDeskew) receipts.setDeskew(false);
  console.log(`  deskew     ${OPTS.noDeskew ? 'OFF' : 'on'}${OPTS.textModel ? `\n  structure  ${OPTS.textModel}` : ''}`);
  console.log(`  fixes      ${OPTS.withFixes ? 'ON — measuring the pipeline (learned corrections replayed)' : 'off — measuring the model (the corrections came from these receipts)'}`);
  console.log('');

  // ----- stored mode: no inference at all -----
  //
  // Score what the reader ACTUALLY produced on these receipts at the time, which the
  // archive already holds: `parsed_ai` is the model's untouched reading and `parsed` is
  // what the user settled on. It is the truest possible baseline — a real photo, a real
  // reading, a real correction — and it costs nothing, needs no GPU, and cannot be
  // affected by which model happens to be serving today.
  //
  // Only edited receipts appear. An unedited one has no `parsed_ai`, because there was
  // nothing to preserve: the reading and the truth are the same object, and scoring it
  // would be scoring 100% against itself.
  if (OPTS.stored) {
    const per = [];
    for (const c of use) {
      if (!c.edited) continue;
      const row = all('SELECT parsed_ai FROM finance_receipt WHERE id = ?', c.id)[0];
      let pred = null;
      try { pred = JSON.parse(row.parsed_ai); } catch { /* unparseable */ }
      const s = scoreOne(c.truth, pred, receipts, c.judgeable);
      s.secs = 0; s.error = ''; s.reads = 0;
      per.push({ case: c, s });
      const mark = s.score >= 90 ? '✓' : s.score >= 60 ? '~' : '✗';
      console.log(`   ${mark} ${pad(c.truth.merchant || '(no merchant)', 22).slice(0, 22)} ` +
        `${lpad(s.score, 3)}  total ${s.total ? 'ok ' : 'NO '} items ${lpad(s.items.matched, 2)}/${lpad(s.items.truthCount, 2)}` +
        `${s.items.spurious ? ` +${s.items.spurious} invented` : ''}   ${c.wasModel.replace(/local:/g, '').slice(0, 40)}`);
      if (OPTS.verbose) showDiffs(s);
    }
    if (!per.length) {
      console.error('No hand-corrected receipts to replay. --stored needs receipts you edited before logging.');
      process.exit(1);
    }
    report([{ modelRef: 'stored readings (what the model gave you at the time)', per, agg: aggregate(per) }], per.length);
    console.log(`\nThese are the ${per.length} receipts you CHANGED before logging. The ${use.length - per.length} you accepted as read are not scoreable this way — they had no error to preserve.`);
    process.exit(0);
  }

  const results = [];
  for (const modelRef of models) {
    const two = refIsTranscriber(modelRef);
    console.log(`── ${modelRef} ${two ? '(transcribe → structure)' : '(single pass)'}`);
    const per = [];
    for (const c of use) {
      // Copy the photo. Reading rotates it, and the archive must come out of a bench run
      // byte-identical to how it went in.
      let tmp = null;
      const t0 = Date.now();
      let read = null, err = '';
      try {
        const { buffer } = uploads.readUpload(c.uploadId);
        const src = uploads.getMeta(c.uploadId);
        tmp = uploads.saveUploadSync({ name: 'bench.jpg', mime: src.mime || 'image/jpeg', buffer });
        read = await receipts.readReceipt({
          meta: uploads.getMeta(tmp.id), modelRef, useFixes: OPTS.withFixes,
          textModelRef: OPTS.textModel ? (OPTS.textModel.includes(':') ? OPTS.textModel : `local:${OPTS.textModel}`) : '',
        });
      } catch (e) {
        err = e.message;
      } finally {
        if (tmp) { try { uploads.deleteUpload(tmp.id); } catch { /* gone */ } }
      }
      const secs = Math.round((Date.now() - t0) / 100) / 10;
      const s = scoreOne(c.truth, read?.parsed || null, receipts, c.judgeable);
      s.secs = secs;
      s.error = err || read?.error || '';
      s.reads = read?.reads || 0;
      per.push({ case: c, s });

      const mark = s.score >= 90 ? '✓' : s.score >= 60 ? '~' : '✗';
      console.log(`   ${mark} ${pad(c.truth.merchant || '(no merchant)', 22).slice(0, 22)} ` +
        `${lpad(s.score, 3)}  total ${s.total ? 'ok ' : 'NO '} items ${lpad(s.items.matched, 2)}/${lpad(s.items.truthCount, 2)}` +
        `${s.items.spurious ? ` +${s.items.spurious} invented` : ''}  ${lpad(secs, 5)}s` +
        `${s.error ? `  ${s.error.slice(0, 48)}` : ''}`);
      if (OPTS.verbose) showDiffs(s);
    }
    results.push({ modelRef, per, agg: aggregate(per) });
    console.log('');
  }

  report(results, use.length);
  if (OPTS.json) {
    fs.writeFileSync(OPTS.json, JSON.stringify({ at: new Date().toISOString(), opts: OPTS, results }, null, 2));
    console.log(`\nwrote ${OPTS.json}`);
  }
  process.exit(0);
}

/** Every place the reading differed from the truth, in the words a reviewer would use. */
function showDiffs(s) {
  for (const pr of s.items.pairs) {
    if (!pr.p) console.log(`       missed   ${pr.t.name}  ${pr.t.amount}`);
    else if (!moneyEq(pr.t.amount, pr.p.amount)) console.log(`       amount   ${pr.t.name}: ${pr.t.amount} → ${pr.p.amount}`);
    else if (cer(pr.t.name, pr.p.name) > 0.01) console.log(`       name     ${pr.t.name} → ${pr.p.name}`);
  }
  if (s.items.spurious) console.log(`       invented ${s.items.spurious} line(s) not on the paper`);
}

function aggregate(per) {
  const n = per.length || 1;
  const mean = (f) => per.reduce((a, x) => a + f(x.s), 0) / n;
  const rate = (f) => per.filter(x => f(x.s)).length / n;
  // Item metrics average only over receipts whose truth kept the printed text.
  const j = per.filter(x => x.case.judgeable);
  const jn = j.length || 1;
  const jmean = (f) => j.reduce((a, x) => a + f(x.s), 0) / jn;
  return {
    n: per.length,
    judgeable: j.length,
    score: mean(s => s.score),
    read: rate(s => s.read),
    merchant: rate(s => s.merchant),
    date: rate(s => s.date),
    total: rate(s => s.total),
    tax: rate(s => s.tax),
    itemF1: jmean(s => s.items.f1),
    nameCer: jmean(s => s.items.nameCer),
    amountCov: (() => {
      const found = j.reduce((a, x) => a + x.s.items.amountsFound, 0);
      const of = j.reduce((a, x) => a + x.s.items.amountable, 0);
      return of ? found / of : 0;
    })(),
    invented: j.reduce((a, x) => a + x.s.items.spurious, 0),
    missed: j.reduce((a, x) => a + x.s.items.missed, 0),
    reconciled: rate(s => s.reconciled),
    secs: mean(s => s.secs),
  };
}

function report(results, n) {
  const W = [30, 6, 7, 7, 7, 7, 7, 8, 9, 8, 7];
  const head = ['model', 'score', 'total', 'shop', 'date', '¥found', 'itemF1', 'nameCER', 'invented', 'missed', 'secs'];
  console.log('═'.repeat(W.reduce((a, b) => a + b, 0)));
  console.log(head.map((h, i) => (i ? lpad(h, W[i]) : pad(h, W[i]))).join(''));
  console.log('─'.repeat(W.reduce((a, b) => a + b, 0)));
  for (const r of [...results].sort((a, b) => b.agg.score - a.agg.score)) {
    const a = r.agg;
    console.log([
      pad(r.modelRef.replace(/^local:/, '').slice(0, 33), W[0]),
      lpad(a.score.toFixed(0), W[1]),
      lpad(pct(a.total), W[2]),
      lpad(pct(a.merchant), W[3]),
      lpad(pct(a.date), W[4]),
      lpad(pct(a.amountCov), W[5]),
      lpad(a.itemF1.toFixed(2), W[6]),
      lpad(a.nameCer.toFixed(2), W[7]),
      lpad(a.invented, W[8]),
      lpad(a.missed, W[9]),
      lpad(a.secs.toFixed(1), W[10]),
    ].join(''));
  }
  console.log('═'.repeat(W.reduce((a, b) => a + b, 0)));
  const jn = results[0]?.agg.judgeable ?? n;
  console.log(`over ${n} receipt${n === 1 ? '' : 's'}${jn < n ? ` (${jn} with printed line text — item columns average over those only)` : ''}.  score = .34 total + .16 shop + .10 date + .30 itemF1 + .10 (1-nameCER)`);
  console.log(`invented / missed are TOTAL line items across the set, not per receipt — an invented line is money the ledger never spent.`);
  console.log(`¥found is the share of true line AMOUNTS the reading contains. Trust it over nameCER: the archive's printed`);
  console.log(`text is what an earlier model transcribed, so name matching partly scores agreement with that model.`);
}

main().catch(e => { console.error('\nbench failed:', e.stack || e.message); process.exit(1); });
