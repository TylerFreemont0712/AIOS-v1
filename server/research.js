// Deep research: a server-orchestrated loop so even small models produce solid,
// cited reports. The server does the orchestration (plan → search → read →
// reflect → repeat → synthesize); the model only ever gets one focused job per
// call. No tool-calling support required, so it works with every provider.

import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig, contextBudget } from './config.js';
import { streamChat } from './llm.js';
import { webSearch, fetchReadable } from './tools.js';
import { writeNote } from './vault.js';
import { id as genId, now, readJSON, writeJSON } from './util.js';

const DIR = path.join(DATA, 'research');
const live = new Map(); // id -> AbortController
const file = (id) => path.join(DIR, id + '.json');

let publish = () => { };
export const setPublisher = (fn) => { publish = fn; };
const emit = (id, ev) => publish(`research:${id}`, { t: 'research.event', id, ev });

const DEPTHS = {
  quick: { rounds: 1, queries: 3, reads: 3 },
  standard: { rounds: 2, queries: 3, reads: 4 },
  deep: { rounds: 3, queries: 4, reads: 5 },
};

// ---------- store ----------

export function listResearch() {
  fs.mkdirSync(DIR, { recursive: true });
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    const r = readJSON(path.join(DIR, f));
    return r && { id: r.id, question: r.question, status: r.status, depth: r.depth, modelRef: r.modelRef, updatedAt: r.updatedAt, sources: r.sources.length };
  }).filter(Boolean).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function getResearch(id) {
  const r = readJSON(file(id));
  if (!r) throw Object.assign(new Error('research not found'), { status: 404 });
  r.running = live.has(id);
  return r;
}

export function deleteResearch(id) {
  cancel(id);
  try { fs.unlinkSync(file(id)); } catch { }
}

export function cancel(id) {
  live.get(id)?.abort();
  live.delete(id);
  return true;
}

const save = (r) => { r.updatedAt = now(); writeJSON(file(r.id), r); };

// ---------- the loop ----------

export function startResearch({ question, modelRef, depth }) {
  const cfg = loadConfig();
  question = String(question || '').trim();
  if (!question) throw Object.assign(new Error('question is empty'), { status: 400 });
  modelRef = modelRef || cfg.defaults.chatModel;
  if (!modelRef) throw Object.assign(new Error('no model selected'), { status: 400 });
  depth = DEPTHS[depth] ? depth : 'standard';

  const r = {
    id: genId(8), question, modelRef, depth,
    status: 'running', phase: 'planning',
    createdAt: now(), updatedAt: now(),
    queries: [], sources: [], notes: [], report: '', error: '',
    usage: { input: 0, output: 0 },
  };
  fs.mkdirSync(DIR, { recursive: true });
  save(r);
  // Register the abort handle now (so an immediate cancel works) but defer the
  // actual start briefly, so the client's subscribe lands before the first
  // events — otherwise a fast model can emit "plan"/"search" into the void.
  const ctl = new AbortController();
  live.set(r.id, ctl);
  setTimeout(() => run(r, ctl).catch(() => { }), 250);
  return { id: r.id, question: r.question, status: r.status, depth: r.depth, modelRef: r.modelRef };
}

async function run(r, ctl) {
  if (ctl.signal.aborted) { r.status = 'cancelled'; save(r); emit(r.id, { type: 'done', cancelled: true }); live.delete(r.id); return; }
  const d = DEPTHS[r.depth];
  const provider = r.modelRef.split(':')[0];
  // fast cloud models can afford more reading inside the same wall-clock feel;
  // the tight numbers exist for slow local models where every read = an LLM call.
  const fast = provider === 'anthropic';
  const reads = d.reads + (fast ? 2 : 0);
  // soft wall-clock budget: always leave time to synthesize, however slow the model.
  const started = Date.now();
  const deadlineMs = d.rounds * (fast ? 150_000 : 100_000);
  const overBudget = () => Date.now() - started > deadlineMs;
  // questions about the current state of things should prefer fresh sources
  const wantsRecent = /\b(latest|newest|current(ly)?|today|right now|this (year|month)|recent|upcoming|best|20(2[5-9]|3\d))\b/i.test(r.question);
  // size the page-per-read and accumulated-notes inputs to the model's context window
  const { inputChars } = contextBudget({ modelRef: r.modelRef, wantOutput: 4096 });
  const pageCap = Math.min(provider === 'anthropic' ? 30_000 : 14_000, Math.floor(inputChars * 0.55));
  const notesCap = Math.min(provider === 'anthropic' ? 150_000 : 55_000, Math.floor(inputChars * 0.8));
  const today = new Date().toDateString();

  const llm = async (prompt, { stream = false, maxTokens = 2048, onReason } = {}) => {
    const res = await streamChat({
      modelRef: r.modelRef, maxTokens, signal: ctl.signal,
      system: `You are a rigorous research assistant. Today is ${today}. Follow the output format EXACTLY — no preamble, no commentary.`,
      messages: [{ role: 'user', text: prompt }],
      onEvent: (ev) => {
        if (stream && ev.type === 'text') emit(r.id, { type: 'report.delta', delta: ev.delta });
        else if (ev.type === 'reasoning' && onReason) onReason(ev.delta);
      },
    });
    r.usage.input += res.usage.input; r.usage.output += res.usage.output;
    return res.text || '';
  };
  // surface the model's live thinking during the current phase (into the timeline)
  const think = (delta) => emit(r.id, { type: 'reason.delta', delta });
  const phase = (p, detail = '') => { r.phase = p; save(r); emit(r.id, { type: 'status', phase: p, detail }); };

  try {
    // ---- 1. plan: decompose into sub-questions, then queries that cover them ----
    // The sub-questions steer everything downstream: reflection checks coverage
    // against them, and the report is organized around them — so the final answer
    // tracks what was actually asked instead of drifting into a generic article.
    phase('planning');
    const planOut = await llm(
      `Research question: ${r.question}\n\nStep 1 — list 2-4 SUB-QUESTIONS that must be answered to fully address this question (the direct answer, plus context, alternatives/comparison, caveats or recency as applicable).\nStep 2 — list ${d.queries} short web search queries (3-8 words each) that together cover those sub-questions.\n\nOutput EXACTLY this format, nothing else:\nSUBQUESTIONS:\n- <sub-question>\n- <sub-question>\nQUERIES:\n<query>\n<query>`,
      { onReason: think });
    const plan = parsePlan(planOut, d.queries);
    let queries = plan.queries;
    if (!queries.length) queries = [r.question.slice(0, 80)];
    r.subs = plan.subs;
    r.queries.push(...queries);
    save(r);
    emit(r.id, { type: 'plan', queries, subs: r.subs });

    const seen = new Set();
    for (let round = 1; round <= d.rounds; round++) {
      if (ctl.signal.aborted) throw new Error('cancelled');
      emit(r.id, { type: 'round', n: round, of: d.rounds, queries });

      // ---- 2. search ----
      phase('searching', queries.join(' · '));
      const candidates = [];
      for (const q of queries) {
        if (ctl.signal.aborted) throw new Error('cancelled');
        try {
          const { results } = await webSearch(q, { n: 8, time_range: wantsRecent ? 'year' : undefined });
          emit(r.id, { type: 'search', query: q, found: results.length });
          for (const res of results) candidates.push({ ...res, query: q });
        } catch (e) {
          emit(r.id, { type: 'search', query: q, found: 0, error: e.message });
        }
      }

      // ---- 3. select: score by relevance to the question, dedupe, order best-first ----
      // Weaker fallback engines rank spam/off-topic pages high, so don't just take
      // the top of each list — rank the whole pool against the question's keywords.
      const kw = keywords(r.question + ' ' + queries.join(' '));
      const domains = new Map();
      const roundSeen = new Set();                 // dedupe within this round's pool
      const ordered = [];
      for (const c of candidates) {
        const url = c.url || '';
        const key = url.replace(/[#?].*$/, '').replace(/\/$/, '');
        // skip only URLs already READ (in `seen`); NOT ones merely listed earlier —
        // otherwise a same-query retry round would find an empty pool and dead-end.
        if (roundSeen.has(key) || seen.has(key) || !/^https?:/.test(url) || /\.(pdf|zip|png|jpg|jpeg|gif|mp4|xml|csv)($|\?)/i.test(url)) continue;
        roundSeen.add(key);
        let dom = ''; try { dom = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
        const perDom = domains.get(dom) || 0;
        if (perDom >= 2) continue;                 // at most 2 pages from one site per round
        domains.set(dom, perDom + 1);
        ordered.push({ ...c, score: relevance(c, kw), dom, _key: key });
      }
      const scored = ordered.filter(c => c.score > 0);
      const pool = (scored.length ? scored : ordered).sort((a, b) => b.score - a.score);

      // ---- 4. read best candidates until we have enough usable notes (skip junk, dig deeper) ----
      // Each read is an LLM extraction call, so bound total attempts tightly for slow local models.
      const attemptCap = reads + 4;
      let usable = 0, attempts = 0;
      for (const c of pool) {
        if (usable >= reads || attempts >= attemptCap || (overBudget() && usable > 0)) break;
        if (ctl.signal.aborted) throw new Error('cancelled');
        attempts++;
        seen.add(c._key);                          // mark as read so later rounds don't repeat it
        const n = r.sources.length + 1;
        phase('reading', c.url);
        emit(r.id, { type: 'source', n, url: c.url, title: c.title });

        // Prefer the full page; fall back to the search snippet when a page is
        // JS-rendered/blocked/thin, so those sources still contribute instead of
        // being dropped entirely.
        let text = '';
        try { text = (await fetchReadable(c.url, 500_000)).text.slice(0, pageCap); } catch { }
        let material = text, basis = 'page';
        if (text.length < 400 && c.snippet) {
          material = `Title: ${c.title || ''}\nSearch summary: ${c.snippet}${text ? `\n\nPartial page text:\n${text}` : ''}`;
          basis = text ? 'partial page + snippet' : 'search snippet';
        }
        if (material.trim().length < 80) { emit(r.id, { type: 'note', n, url: c.url, skipped: 'no readable content' }); continue; }

        let note;
        try {
          note = await llm(
            `Research question: ${r.question}\n\nSource below. Extract every fact relevant to the research question: findings, numbers, dates, names, definitions, direct claims, pros/cons. Quote key phrases. Be generous — if it has ANY relevant information, capture it. Only output exactly IRRELEVANT if the source is truly off-topic, an error page, or spam.\nOutput format: 3-10 terse bullet points, no introduction.\n\nSOURCE (${c.url}):\n${material}`,
            { maxTokens: 1024 });
        } catch (e) { emit(r.id, { type: 'note', n, url: c.url, skipped: `model error: ${e.message}` }); continue; }
        if (!note.trim() || /^\s*IRRELEVANT\s*$/m.test(note.slice(0, 40))) {
          emit(r.id, { type: 'note', n, url: c.url, skipped: 'irrelevant' });
          continue;
        }
        r.sources.push({ n, url: c.url, title: c.title });
        r.notes.push({ n, url: c.url, title: c.title, text: note.trim().slice(0, 2000) });
        save(r);
        usable++;
        emit(r.id, { type: 'note', n, url: c.url, chars: note.length, basis });
      }

      // ---- 5. reflect: check coverage against the sub-questions, chase only the gaps ----
      if (overBudget()) { emit(r.id, { type: 'status', phase: 'reflecting', detail: 'time budget reached — writing report with what we have' }); break; }
      if (round < d.rounds) {
        if (!r.notes.length) continue; // nothing learned yet — rerun with same queries next round
        phase('reflecting');
        const subsBlock = r.subs?.length ? `Sub-questions the report must answer:\n${r.subs.map(s => `- ${s}`).join('\n')}\n\n` : '';
        const gaps = await llm(
          `Research question: ${r.question}\n\n${subsBlock}Notes so far:\n${clip(notesBlock(r), notesCap)}\n\nFor EACH sub-question output one line: "COVERED: <sub-question>" or "GAP: <sub-question> — <what is missing>".${r.subs?.length ? '' : ' (Infer 2-4 sub-questions from the research question first.)'}\nThen, if there are any GAP lines, output a line "QUERIES:" followed by ${d.queries} NEW web search queries (different from: ${r.queries.join('; ')}) targeting ONLY the gaps — one per line.\nIf everything is covered, end with the single word DONE instead.`,
          { onReason: think });
        const cov = parseReflect(gaps, d.queries);
        if (cov.gaps.length || cov.covered) emit(r.id, { type: 'coverage', covered: cov.covered, gaps: cov.gaps });
        if (cov.done || (!cov.queries.length && !cov.gaps.length)) { emit(r.id, { type: 'status', phase: 'reflecting', detail: 'coverage sufficient — stopping early' }); break; }
        if (!cov.queries.length) break;
        queries = cov.queries;
        r.queries.push(...queries);
        save(r);
      }
    }

    if (!r.notes.length) throw new Error('no usable sources found — try rephrasing the question or check that SearXNG is up');

    // ---- 6. synthesize: answer FIRST, then sections shaped by the sub-questions ----
    phase('writing');
    const subsBlock = r.subs?.length ? `\nSub-questions to answer (one section each):\n${r.subs.map(s => `- ${s}`).join('\n')}\n` : '';
    const report = await llm(
      `Research question: ${r.question}\n${subsBlock}\nNotes from ${r.sources.length} sources (each has a citation number):\n${clip(notesBlock(r), notesCap)}\n\nWrite a markdown report that DIRECTLY answers the research question for a technically literate reader.\nRules:\n- Begin with "## Answer" — 3-6 sentences that answer the question head-on, with the single most important takeaway in **bold**. No throat-clearing, no "it depends" without immediately saying on what.\n- Then one "## <short heading>" section per sub-question${r.subs?.length ? '' : ' (infer sensible sub-questions from the question)'}, answering it from the notes.\n- If the question compares options, include a compact markdown comparison table.\n- Cite sources inline with their numbers like [1] or [2][5] after each claim.\n- End with "## Open questions" ONLY if real gaps or contradictions remain — name what conflicts.\n- Use ONLY the notes above — do not invent facts or citations.\n- No preamble before the first heading.`,
      { stream: true, maxTokens: 4096, onReason: think });

    r.report = report.trim() + '\n\n## Sources\n' + r.sources.map(s => `${s.n}. [${s.title}](${s.url})`).join('\n');
    r.status = 'done';
    phase('done');
    save(r);
    // autonomous wiki wiring: finished reports land in the knowledge base by themselves
    const vcfg = loadConfig().vault;
    if (vcfg?.path && vcfg.autoExport !== false) {
      try {
        const { path: rel } = exportToVault(r.id);
        r.exportedTo = rel;
        save(r);
        try { (await import('./wiki.js')).rebuildIndex(); } catch { }
        emit(r.id, { type: 'status', phase: 'done', detail: `report saved to the wiki: ${rel}` });
      } catch { /* export is best-effort — the report itself is safe in data/research */ }
    }
    emit(r.id, { type: 'done', report: r.report, sources: r.sources, usage: r.usage, exportedTo: r.exportedTo || '' });
  } catch (e) {
    r.status = ctl.signal.aborted ? 'cancelled' : 'error';
    r.error = ctl.signal.aborted ? '' : e.message;
    save(r);
    emit(r.id, ctl.signal.aborted ? { type: 'done', cancelled: true } : { type: 'error', message: e.message });
  } finally {
    live.delete(r.id);
  }
}

// ---------- export ----------

export function exportToVault(id) {
  const r = getResearch(id);
  if (!r.report) throw Object.assign(new Error('no report to export yet'), { status: 400 });
  const cfg = loadConfig();
  const slug = r.question.slice(0, 60).replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'research';
  const rel = path.posix.join(cfg.vault.wikiFolder || 'AI Wiki', 'Research', slug + '.md');
  const content = `---\ntype: research\nquestion: "${r.question.replace(/"/g, '\'')}"\ndate: ${r.createdAt.slice(0, 10)}\nmodel: ${r.modelRef}\n---\n\n# ${r.question}\n\n${r.report}\n`;
  return writeNote(rel, content);
}

// ---------- helpers ----------

function notesBlock(r) {
  return r.notes.map(n => `[${n.n}] ${n.title} (${n.url})\n${n.text}`).join('\n\n');
}

const clip = (s, cap) => s.length > cap ? s.slice(0, cap) + '\n… (older notes trimmed)' : s;

const STOP = new Set('the a an of to in on for and or is are be was were what when why how which who whose that this these those with without you your it its as at by from into over about should would could can do does than then them they their our'.split(' '));

/** Significant lowercased words from the question — the relevance signal. */
function keywords(text) {
  const out = new Set();
  for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return [...out];
}

/** How well a candidate matches the question: keyword hits in title/snippet/url + a nudge for reference-y hosts. */
function relevance(c, kw) {
  const hay = `${c.title || ''} ${c.snippet || ''} ${c.url || ''}`.toLowerCase();
  let score = 0;
  for (const w of kw) if (hay.includes(w)) score++;
  if (/wikipedia\.org|\.gov|docs?\.|developer\.|\.org\/|readthedocs|stackoverflow\.com|github\.com/.test(c.url || '')) score += 1;
  // penalise obvious non-latin/foreign-dominated titles when nothing matched
  if (score === 0 && /[　-鿿가-힯]/.test(c.title || '')) score -= 1;
  return score;
}

/** Plan output → { subs, queries }. Tolerates missing/mangled section labels. */
export function parsePlan(text, maxQueries) {
  const t = String(text || '');
  const m = t.match(/QUERIES\s*:?/i);
  if (!m) return { subs: [], queries: parseLines(t, maxQueries) };
  const before = t.slice(0, m.index);
  const after = t.slice(m.index + m[0].length);
  const subsRaw = before.replace(/SUBQUESTIONS\s*:?/i, '');
  return {
    subs: parseLines(subsRaw, 4, 200).filter(s => /\w{3}/.test(s)),
    queries: parseLines(after, maxQueries),
  };
}

/** Reflect output → { covered, gaps[], queries[], done }. */
export function parseReflect(text, maxQueries) {
  const t = String(text || '');
  const covered = (t.match(/^\s*COVERED\s*:/gim) || []).length;
  const gaps = [];
  for (const line of t.split('\n')) {
    const g = line.match(/^\s*GAP\s*:\s*(.{4,200})/i);
    if (g) gaps.push(g[1].trim());
  }
  const done = /(^|\n)\s*DONE\s*$/i.test(t.trim()) || (/\bDONE\b/.test(t) && !gaps.length);
  const qm = t.match(/QUERIES\s*:?/i);
  let queries = qm ? parseLines(t.slice(qm.index + qm[0].length), maxQueries) : [];
  // model listed gaps but forgot the QUERIES section — fall back to any list-y tail lines
  if (!queries.length && gaps.length && !done) {
    queries = parseLines(t.split('\n').filter(l => !/^(COVERED|GAP)\s*:/i.test(l.trim())).join('\n'), maxQueries);
  }
  return { covered, gaps, queries, done };
}

/** Parse "one per line" output defensively — small models decorate anyway. */
function parseLines(text, max, maxLen = 120) {
  const lines = [];
  for (let raw of String(text || '').split('\n')) {
    let l = raw.trim()
      .replace(/^(?:\d+[.)]|[-*•>]+)\s*/, '')   // list markers
      .replace(/^["'`]+|["'`]+$/g, '')          // wrapping quotes
      .trim();
    if (!l || l.length < 4 || l.length > maxLen) continue;
    if (/^(here|sure|okay|output|queries|subquestions|format|research question)/i.test(l)) continue;
    lines.push(l);
    if (lines.length >= max) break;
  }
  return lines;
}

export { parseLines, keywords, relevance };   // exported for the feature audit
