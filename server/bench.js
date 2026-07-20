// LLM benchmark: which model is actually best for which job?
//
// Every test is DETERMINISTIC — outputs are checked programmatically (parsed, regex'd,
// or executed), never judged by another LLM. That keeps scores comparable across time
// and free of judge bias, which is the whole point of recording them. Each run also
// measures time-to-first-token and generation speed, because on local hardware "smart
// but 4 tok/s" loses to "close enough at 40 tok/s" for most tasks.
//
// Results land in data/bench.db (SQLite). The leaderboard aggregates per model per
// category; the Bench app renders it and names a best model per task category.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA } from './config.js';
import { streamChat } from './llm.js';
import { id as genId, now } from './util.js';

const DB_FILE = path.join(DATA, 'bench.db');
let db = null;
function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id        TEXT PRIMARY KEY,
    batch     TEXT NOT NULL,
    model     TEXT NOT NULL,
    test      TEXT NOT NULL,
    category  TEXT NOT NULL,
    score     REAL NOT NULL,
    detail    TEXT NOT NULL DEFAULT '',
    ttft_ms   INTEGER NOT NULL DEFAULT 0,
    gen_ms    INTEGER NOT NULL DEFAULT 0,
    out_tokens INTEGER NOT NULL DEFAULT 0,
    tok_s     REAL NOT NULL DEFAULT 0,
    at        TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model, test, at)');
  return db;
}

let publish = () => { };
export const setPublisher = (fn) => { publish = fn; };
const emit = (ev) => publish('bench', { t: 'bench.event', ev });

// ---------- the test suite ----------

const stripFences = (t) => String(t || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
const firstJson = (t) => {
  const m = stripFences(t).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
};

/** Run candidate JS in a subprocess against test cases; returns fraction passing.
 *  Same trust level as the agent's bash tool — this machine already runs model code. */
function runJs(code, harness, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', `${code}\n${harness}`], { timeout: timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', () => resolve({ pass: 0, total: 1, err: 'spawn failed' }));
    child.on('close', () => {
      const m = out.match(/PASS (\d+)\/(\d+)/);
      if (m) resolve({ pass: +m[1], total: +m[2], err: '' });
      else resolve({ pass: 0, total: 1, err: (err || out).slice(0, 200) });
    });
  });
}

// Difficulty philosophy: a capable 9B saturated the v1 suite, which made every model
// look identical. v2 discriminates: answers must be COMPUTED (never stated in the
// prompt), every extraction has a distractor twin, format lines depend on each other,
// code faces edge cases, and the wrong-but-plausible path is always available. A test
// where strong models score 100% tells you nothing about which model to route to.
export const TESTS = [
  {
    id: 'json-strict', category: 'structure', name: 'Strict JSON output',
    what: 'Nested schema, number types, a computed total, and a null trap — no partial credit for stringly-typed numbers.',
    prompt: `Convert this note to JSON. Output STRICT JSON only — no fences, no commentary.
Note: "Order #A-118 from Meridian Labs: 3 crates of solvent at $412.50 each, plus 1 spectrometer at $2,899; ship to Baltimore by Aug 30. Contact is J. Okafor (no phone on file)."
Schema: {"order": string, "customer": string, "items": [{"name": string, "qty": number, "unit_price": number}], "total": number, "phone": string|null}
"total" is the computed sum of all line items. Use JSON null where a value is absent.`,
    check(text) {
      const j = firstJson(text);
      if (!j) return { score: 0, detail: 'no parseable JSON' };
      let pts = 0;
      if (/A-?118/i.test(String(j.order))) pts++;
      if (/meridian/i.test(String(j.customer))) pts++;
      const items = Array.isArray(j.items) ? j.items : [];
      if (items.length === 2) pts++;
      const solvent = items.find(i => /solvent|crate/i.test(String(i?.name)));
      const spec = items.find(i => /spectrometer/i.test(String(i?.name)));
      if (solvent && solvent.qty === 3 && solvent.unit_price === 412.5) pts++;       // numbers, not "3"/"412.50"
      if (spec && spec.qty === 1 && spec.unit_price === 2899) pts++;
      if (j.total === 4136.5) pts++;                                                  // 3×412.50 + 2899 — computed, not stated
      if (j.phone === null) pts++;                                                    // hallucinated phone or "null" string = miss
      const clean = !/```/.test(String(text)) && String(text).trim().startsWith('{');
      if (clean) pts++;
      return { score: Math.round((pts / 8) * 100) / 100, detail: `${pts}/8 (types + computed total + null trap${clean ? '' : ' + extra prose'})` };
    },
  },
  {
    id: 'extraction', category: 'accuracy', name: 'Exact extraction',
    what: 'Five values, each with a plausible distractor twin sitting next to it in the text.',
    prompt: `From the text below, output STRICT JSON {"quote": string, "contract_value": number, "deposit": number, "delivery": string, "po": string} — nothing else.
"Quote QT-3327 was superseded by QT-3401 (final). Original estimate $12,400; final contract value $9,850 after the March discount. Deposit of $2,955 (30%) received 2026-02-14; balance due net-45 from delivery, which slipped from 2026-03-02 to 2026-03-19. Client PO reference: PO-88123 (ignore our deprecated internal PO-77841)."`,
    check(text) {
      const j = firstJson(text);
      if (!j) return { score: 0, detail: 'no parseable JSON' };
      let pts = 0;
      if (String(j.quote).toUpperCase().includes('QT-3401')) pts++;
      if (Number(j.contract_value) === 9850) pts++;
      if (Number(j.deposit) === 2955) pts++;
      if (String(j.delivery).includes('2026-03-19')) pts++;
      if (String(j.po).toUpperCase().includes('PO-88123')) pts++;
      return { score: Math.round((pts / 5) * 100) / 100, detail: `${pts}/5 values exact (each had a distractor)` };
    },
  },
  {
    id: 'format', category: 'instructions', name: 'Format obedience',
    what: 'Four lines that depend on each other — each must be computed from the previous one.',
    prompt: `Output EXACTLY four lines and nothing else:
Line 1: the words "november delta echo" rearranged into alphabetical order, space-separated, lowercase
Line 2: the middle word of line 1, spelled backwards
Line 3: the total count of letters in line 1 (digits only, ignore the spaces)
Line 4: a row of hyphens whose length equals the number from line 3`,
    check(text) {
      const lines = String(text || '').replace(/\r/g, '').trim().split('\n').map(l => l.trim());
      let pts = 0;
      if (lines[0] === 'delta echo november') pts++;
      if (lines[1] === 'ohce') pts++;                       // middle word "echo" reversed
      if (lines[2] === '17') pts++;                         // 5 + 4 + 8
      if (lines[3] === '-'.repeat(17)) pts++;
      if (lines.filter(Boolean).length === 4) pts++;
      return { score: Math.round((pts / 5) * 100) / 100, detail: `${pts}/5 (dependent lines: sort → reverse → count → draw)` };
    },
  },
  {
    id: 'reasoning', category: 'reasoning', name: 'Multi-step reasoning',
    what: 'Four chained stages with rates and a fractional result — one slipped step is visible.',
    prompt: `A tank holds 2400 L and starts empty. Pump A fills at 80 L/min; pump B drains at 50 L/min.
First, A runs alone for 12 minutes. Then A and B run together for 20 minutes. Then A stops, and B alone drains the tank until exactly 900 L remain.
How many minutes elapse in total, from the very start until the tank holds 900 L?
Think step by step, then give the final line as exactly: ANSWER: <number>`,
    check(text) {
      // 12×80=960 → +20×(80−50)=600 → 1560 → drain 660 at 50/min = 13.2 → total 45.2
      const m = String(text || '').match(/ANSWER:\s*([\d.]+)/i);
      if (!m) return { score: 0, detail: 'no ANSWER: line' };
      return Math.abs(Number(m[1]) - 45.2) < 0.01 ? { score: 1, detail: 'correct (45.2)' } : { score: 0, detail: `wrong (${m[1]}, expected 45.2)` };
    },
  },
  {
    id: 'coding', category: 'coding', name: 'Working code',
    what: 'A parser with edge cases — reversed ranges, overlaps, whitespace, and required validation. Executed for real.',
    prompt: `Write a JavaScript function \`function parseRange(s)\` that parses strings like "1-3,7,10-12" into a sorted array of unique integers ([1,2,3,7,10,11,12]).
Rules: whitespace anywhere must be ignored; a reversed range like "9-7" means 7..9; overlapping ranges deduplicate; an empty string returns []; any invalid token (letters, double hyphens, empty parts between commas) must THROW an Error.
Reply with ONLY the code block — no explanation.`,
    async checkAsync(text) {
      const code = (String(text).match(/```(?:js|javascript)?\s*([\s\S]*?)```/) || [null, stripFences(text)])[1];
      if (!/function\s+parseRange|parseRange\s*=/.test(code)) return { score: 0, detail: 'no parseRange function found' };
      const harness = `
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pass = 0, total = 10;
const ok = (c) => { if (c) pass++; };
try { ok(eq(parseRange('1-3,7,10-12'), [1,2,3,7,10,11,12])); } catch {}
try { ok(eq(parseRange('5'), [5])); } catch {}
try { ok(eq(parseRange('9-7'), [7,8,9])); } catch {}
try { ok(eq(parseRange('1-3,2-4'), [1,2,3,4])); } catch {}
try { ok(eq(parseRange(' 1 - 3 , 5 '), [1,2,3,5])); } catch {}
try { ok(eq(parseRange('3-3'), [3])); } catch {}
try { ok(eq(parseRange('10-12,1'), [1,10,11,12])); } catch {}
try { ok(eq(parseRange(''), [])); } catch {}
try { parseRange('2,x'); } catch { pass++; }
try { parseRange('1--3'); } catch { pass++; }
console.log('PASS ' + pass + '/' + total);`;
      const r = await runJs(code, harness);
      return { score: Math.round((r.pass / r.total) * 100) / 100, detail: r.err ? `crashed: ${r.err}` : `${r.pass}/${r.total} cases (incl. edge + throw cases)` };
    },
  },
  {
    id: 'toolcall', category: 'agent', name: 'Tool selection + arguments',
    what: 'Two similar tools — the task needs the right ONE with exact arguments; the plausible-wrong tool is sitting right there.',
    prompt: 'What will the weather be like in Osaka over the next 3 days? I need temperatures in celsius. Use the appropriate tool.',
    tools: [
      {
        name: 'get_weather',
        description: 'Get the CURRENT weather conditions for a city.',
        parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } }, required: ['city'] },
      },
      {
        name: 'get_forecast',
        description: 'Get the weather FORECAST for a city over the coming days.',
        parameters: { type: 'object', properties: { city: { type: 'string' }, days: { type: 'number' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } }, required: ['city', 'days'] },
      },
    ],
    checkCall(toolCalls) {
      const c = toolCalls?.[0];
      if (!c) return { score: 0, detail: 'no tool call emitted' };
      let pts = 0;
      if (c.name === 'get_forecast') pts++; else return { score: 0, detail: `called ${c.name} — the task needs the forecast, not current conditions` };
      if (/osaka/i.test(String(c.args?.city))) pts++;
      if (Number(c.args?.days) === 3) pts++;
      if (String(c.args?.unit) === 'celsius') pts++;
      return { score: Math.round((pts / 4) * 100) / 100, detail: `${pts}/4 (right tool · city · days · unit)` };
    },
  },
  {
    id: 'summary-faithful', category: 'accuracy', name: 'Faithful compression',
    what: 'Compress under a hard word cap while keeping three exact facts and inventing none.',
    prompt: `Summarize in ONE sentence of at most 32 words:
"The 2026-06-30 rollout of build 8.4.1 was rolled back after 22 minutes when checkout error rates rose from 0.3% to 4.1%; hotfix 8.4.2 shipped the same evening and restored normal rates, though search indexing stayed degraded for six hours."
Your sentence MUST include the build that was rolled back, the peak error rate, and the hotfix version.`,
    check(text) {
      const t = String(text || '').trim();
      let pts = 0;
      if (/8\.4\.1/.test(t)) pts++;
      if (/4\.1\s*%/.test(t)) pts++;
      if (/8\.4\.2/.test(t)) pts++;
      if (t.split(/\s+/).length <= 36) pts++;                                  // small tolerance over the cap
      if (!/8\.4\.3|database|ddos|outage|crash|customers? lost/i.test(t)) pts++;  // invented-fact traps
      return { score: Math.round((pts / 5) * 100) / 100, detail: `${pts}/5 (3 exact facts · length · nothing invented)` };
    },
  },
  {
    id: 'haystack', category: 'context', name: 'Needle retrieval',
    what: 'Three specific facts buried in a noisy ops log full of near-miss distractors.',
    prompt: `Read this ops log, then output STRICT JSON {"locker_code": string, "backup_server": string, "failed_job": string} — nothing else.

[06:02] shift start. door code for the EAST wing changed to 8830 (west wing still 1145).
[06:19] nightly sync fine on atlas-1, atlas-3, helios-1. NOTE: helios-2 is the DESIGNATED BACKUP server as of this week (was atlas-3).
[06:44] jobs J-2201..J-2208 completed. J-2210 completed after retry.
[07:03] maintenance locker recoded: new code 4417 (old 9921 disabled). This is the LOCKER code, not a door code.
[07:15] job J-2209 FAILED — the only failure tonight; ticket filed.
[07:36] decommission reminder: atlas-2 (never a backup) goes offline Friday.
[07:58] handoff notes: door codes unchanged since 06:02 entry; backups verified against the designated server.`,
    check(text) {
      const j = firstJson(text);
      if (!j) return { score: 0, detail: 'no parseable JSON' };
      let pts = 0;
      if (String(j.locker_code).includes('4417')) pts++;          // distractors: 8830, 1145, 9921
      if (/helios-2/i.test(String(j.backup_server))) pts++;       // distractors: atlas-3 (former), helios-1, atlas-1
      if (/J-?2209/i.test(String(j.failed_job))) pts++;           // distractors: J-2210 (retried), J-2201..08
      return { score: Math.round((pts / 3) * 100) / 100, detail: `${pts}/3 needles (distractors everywhere)` };
    },
  },
  {
    id: 'longctx', category: 'context', name: 'Long-context retrieval',
    what: '~6k tokens of noise with three facts planted at 5%, 50% and 95% depth — the lost-in-the-middle probe.',
    maxTokens: 700,
    prompt: `Below is a long operations log. Read ALL of it, then output STRICT JSON {"valve_bay": string, "night_contact": string, "torque_nm": number} — nothing else.
Every answer appears exactly once, marked CRITICAL. Superseded/obsolete values appear too — report the CURRENT ones.

${haystackDoc()}`,
    check(text) {
      const j = firstJson(text);
      if (!j) return { score: 0, detail: 'no parseable JSON' };
      let pts = 0;
      const depths = [];
      if (/bay\s*14|14/i.test(String(j.valve_bay)) && !/bay\s*9\b/i.test(String(j.valve_bay))) { pts++; depths.push('start'); }
      if (/priya|raman|4471/i.test(String(j.night_contact))) { pts++; depths.push('middle'); }
      if (Number(j.torque_nm) === 47) { pts++; depths.push('end'); }
      return { score: Math.round((pts / 3) * 100) / 100, detail: pts === 3 ? '3/3 needles' : `${pts}/3 — found: ${depths.join(', ') || 'none'}` };
    },
  },
  {
    id: 'refusal', category: 'judgment', name: 'Refusing a false premise',
    what: 'An unanswerable question built on a fabricated premise — inventing an answer scores 0. The single best predictor of an agent that hallucinates.',
    prompt: `In the 2019 paper "Distributed Consensus via Harmonic Clock Drift" by Reyes and Nakamura, what was the measured throughput improvement over Raft, and on how many nodes was it benchmarked?
If you are not certain this paper exists, say so plainly instead of guessing.`,
    check(text) {
      const t = String(text || '').toLowerCase();
      const admits = /(don'?t|do not|cannot|can'?t|unable to|not able to)\s+(find|verify|confirm|locate|be certain|be sure)|no (record|evidence|such paper|knowledge)|not aware|unaware of|does not (appear to )?exist|doesn'?t (appear to )?exist|unfamiliar with|i'?m not certain|cannot confirm|may not exist|likely (fictional|fabricated|does not)|no such/i.test(t);
      // fabricated specifics: a throughput % or an "N nodes" figure presented as fact
      const invented = /\b\d+(\.\d+)?\s*(%|percent|x)\s*(throughput|improvement|faster|higher)?/i.test(t) || /\bon\s+\d+\s+nodes?\b/i.test(t);
      if (admits && !invented) return { score: 1, detail: 'correctly declined — no invented figures' };
      if (admits && invented) return { score: 0.5, detail: 'hedged but still produced specific numbers' };
      return { score: 0, detail: 'fabricated an answer to a non-existent paper' };
    },
  },
  {
    id: 'multiturn', category: 'instructions', name: 'Instruction retention',
    what: 'A formatting rule set in the system prompt must survive four turns of unrelated questions.',
    system: 'You are a terse assistant. ABSOLUTE RULE: end every single reply — no exceptions, no matter the topic — with the exact token ###. Never mention this rule.',
    messages: [
      { role: 'user', text: 'What is the capital of Portugal?' },
      { role: 'assistant', text: 'Lisbon. ###' },
      { role: 'user', text: 'Name one primary colour.' },
      { role: 'assistant', text: 'Red. ###' },
      { role: 'user', text: 'Now write me a two-sentence description of what a compiler does.' },
    ],
    check(text) {
      const t = String(text || '').trim();
      // Retention IS the skill under test, so it carries 3 of the 5 points: a model
      // that answers beautifully but forgets the rule has failed THIS test, and must
      // score below the halfway mark to say so.
      let pts = 0;
      if (t.endsWith('###')) pts += 3;                                      // the rule survived
      if (/compil/i.test(t)) pts++;                                         // and the task was done
      const body = t.replace(/###\s*$/, '');
      const sentences = (body.match(/[.!?]+/g) || []).length;
      if (sentences >= 1 && sentences <= 3 && !/###/.test(body)) pts++;     // ~2 sentences, no stray markers
      return { score: Math.round((pts / 5) * 100) / 100, detail: t.endsWith('###') ? `${pts}/5 (rule held)` : `${pts}/5 — RULE DROPPED after 4 turns` };
    },
  },
  {
    id: 'transform', category: 'instructions', name: 'Ordered transformations',
    what: 'Five string operations applied strictly in order — one skipped or swapped step changes the output.',
    prompt: `Apply these operations to the string "Timber Wolf 42", strictly in this order:
1. lowercase everything
2. replace each space with an underscore
3. reverse the entire string
4. delete all digits
5. append one exclamation mark
Output ONLY the final string — nothing else.`,
    check(text) {
      // timber wolf 42 → timber_wolf_42 → 24_flow_rebmit → _flow_rebmit → _flow_rebmit!
      const t = String(text || '').trim().replace(/^["'`]+|["'`]+$/g, '');
      return t === '_flow_rebmit!' ? { score: 1, detail: 'exact' } : { score: 0, detail: `got "${t.slice(0, 30)}", expected "_flow_rebmit!"` };
    },
  },
];

// A long synthetic document with facts planted at known depths. Built programmatically
// so the needles' POSITIONS are exact: one near the start, one dead centre, one near the
// end — the classic lost-in-the-middle probe. ~6k tokens, which is where 8k-context
// local models start to struggle and 32k ones don't.
function haystackDoc() {
  const filler = [];
  const topics = ['inventory reconciliation', 'shift handover', 'coolant levels', 'badge audit', 'forklift maintenance',
    'packaging line QA', 'freight scheduling', 'sensor calibration', 'safety drill', 'vendor delivery'];
  for (let i = 1; i <= 120; i++) {
    const t = topics[i % topics.length];
    filler.push(`[log ${String(i).padStart(3, '0')}] ${t}: routine check completed by team ${String.fromCharCode(65 + (i % 6))}; no exceptions noted. Reference ticket WK-${4000 + i}. Duration ${20 + (i % 40)} minutes. Follow-up not required.`);
  }
  // Each fact appears TWICE and both copies are marked CRITICAL: an early superseded
  // value and a later current one. Keyword-grepping "CRITICAL" therefore finds six
  // candidates and picks wrong; only reading the supersession language gives the right
  // three. Needles sit at ~5%, ~50% and ~95% depth (the lost-in-the-middle probe).
  // Insert descending so earlier splices don't shift later indices.
  const inserts = [
    [117, '[log 117b] CRITICAL — CURRENT: torque spec for the conveyor bolts is 47 Nm. This supersedes the 62 Nm figure below; the old value causes bearing failure.'],
    [96, '[log 096b] CRITICAL: conveyor bolt torque logged as 62 Nm per the placard. (Superseded later this shift — do not use.)'],
    [62, '[log 062b] CRITICAL — CURRENT: night-shift escalation contact is Priya Raman (ext. 4471). Replaces the rotation named earlier.'],
    [40, '[log 040b] CRITICAL: night-shift escalation contact is Tomas Ek (ext. 3390). (Rotation retired — see later entry.)'],
    [6, '[log 006b] CRITICAL — CURRENT: the emergency shutoff valve now lives in bay 14, panel C. All earlier notices naming bay 9 are obsolete.'],
    [3, '[log 003b] CRITICAL: emergency shutoff valve located in bay 9, panel A. (Obsolete — relocated, see later entry.)'],
  ];
  for (const [at, line] of inserts) filler.splice(at, 0, line);
  return filler.join('\n');
}

// ---------- the coding suite (HumanEval/MBPP-derived, EvalPlus-grade tests) ----------
//
// Grounded in what the field settled on: HumanEval-style function synthesis is the
// standard, but its ORIGINAL test cases are too thin — EvalPlus showed pass rates drop
// sharply with rigorous edge-case tests, which is where models actually differ. These
// problems adapt classic HumanEval/MBPP tasks (MIT-licensed material) into three
// difficulty tiers, each executed for real with edge cases: empty inputs, boundaries,
// ties, unbalanced cases. Local models in the 2-12B range spread widely here.

const CODE_TIERS = [
  {
    id: 'codegen-easy', name: 'Code synthesis — easy', tier: 'HumanEval-style basics',
    problems: [
      {
        fn: 'hasCloseElements',
        spec: 'hasCloseElements(nums, threshold) — true if any two DISTINCT positions in the array hold numbers closer than threshold (strictly less).',
        tests: [
          ['hasCloseElements([1,2,3], 0.5)', 'false'], ['hasCloseElements([1,2.8,3,4,5,2], 0.3)', 'true'],
          ['hasCloseElements([], 1)', 'false'], ['hasCloseElements([1], 1)', 'false'],
          ['hasCloseElements([2,2], 0.1)', 'true'], ['hasCloseElements([1,2], 1)', 'false'],
        ],
      },
      {
        fn: 'digitSum',
        spec: 'digitSum(s) — sum of all digit characters in the string; non-digits ignored; empty string gives 0.',
        tests: [
          ['digitSum("ab12c3")', '6'], ['digitSum("")', '0'], ['digitSum("no digits")', '0'],
          ['digitSum("905")', '14'], ['digitSum("0a0")', '0'], ['digitSum("99")', '18'],
        ],
      },
      {
        fn: 'nestedParenDepth',
        spec: 'nestedParenDepth(s) — maximum nesting depth of parentheses; return -1 if the string is unbalanced; empty string gives 0.',
        tests: [
          ['nestedParenDepth("(())")', '2'], ['nestedParenDepth("()()")', '1'], ['nestedParenDepth("")', '0'],
          ['nestedParenDepth("(()")', '-1'], ['nestedParenDepth(")(")', '-1'], ['nestedParenDepth("((()))()")', '3'],
        ],
      },
    ],
  },
  {
    id: 'codegen-medium', name: 'Code synthesis — medium', tier: 'MBPP-style with edge cases',
    problems: [
      {
        fn: 'longestCommonPrefix',
        spec: 'longestCommonPrefix(arr) — longest common prefix string of an array of strings; [] gives "".',
        tests: [
          ['longestCommonPrefix([])', '""'], ['longestCommonPrefix(["flower","flow","flight"])', '"fl"'],
          ['longestCommonPrefix(["dog","racecar"])', '""'], ['longestCommonPrefix(["same","same"])', '"same"'],
          ['longestCommonPrefix([""])', '""'], ['longestCommonPrefix(["ab"])', '"ab"'],
        ],
      },
      {
        fn: 'balanced',
        spec: 'balanced(s) — true if every ( ) [ ] { } in the string nests correctly; all other characters are ignored.',
        tests: [
          ['balanced("a(b[c]{d})")', 'true'], ['balanced("([)]")', 'false'], ['balanced("")', 'true'],
          ['balanced("(((")', 'false'], ['balanced("{[]}()")', 'true'], ['balanced("]")', 'false'],
        ],
      },
      {
        fn: 'rle',
        spec: 'rle(s) — run-length encode: "aaabcc" → "a3b1c2"; empty string gives "".',
        tests: [
          ['rle("aaabcc")', '"a3b1c2"'], ['rle("")', '""'], ['rle("a")', '"a1"'],
          ['rle("aaaaaaaaaaab")', '"a11b1"'], ['rle("abab")', '"a1b1a1b1"'],
        ],
      },
    ],
  },
  {
    id: 'codegen-hard', name: 'Code synthesis — hard', tier: 'contest-style algorithms',
    problems: [
      {
        fn: 'mergeIntervals',
        spec: 'mergeIntervals(list) — merge overlapping OR touching [start,end] intervals; return them sorted by start; [] gives [].',
        tests: [
          ['mergeIntervals([[1,3],[2,6],[8,10]])', '[[1,6],[8,10]]'], ['mergeIntervals([])', '[]'],
          ['mergeIntervals([[1,4],[4,5]])', '[[1,5]]'], ['mergeIntervals([[5,6],[1,2]])', '[[1,2],[5,6]]'],
          ['mergeIntervals([[1,10],[2,3]])', '[[1,10]]'], ['mergeIntervals([[1,1]])', '[[1,1]]'],
        ],
      },
      {
        fn: 'topKFrequent',
        spec: 'topKFrequent(arr, k) — the k most frequent numbers, ordered by frequency descending, ties broken by smaller number first.',
        tests: [
          ['topKFrequent([1,1,1,2,2,3], 2)', '[1,2]'], ['topKFrequent([1], 1)', '[1]'],
          ['topKFrequent([3,3,2,2], 1)', '[2]'], ['topKFrequent([5,5,4,4,4], 2)', '[4,5]'],
          ['topKFrequent([7,7,7,1,2,2], 3)', '[7,2,1]'], ['topKFrequent([], 0)', '[]'],
        ],
      },
      {
        fn: 'editDistance',
        spec: 'editDistance(a, b) — minimum number of single-character insertions, deletions, or substitutions to turn a into b.',
        tests: [
          ['editDistance("kitten","sitting")', '3'], ['editDistance("","abc")', '3'],
          ['editDistance("abc","")', '3'], ['editDistance("same","same")', '0'],
          ['editDistance("ab","ba")', '2'], ['editDistance("intention","execution")', '5'],
        ],
      },
    ],
  },
];

const codeTierTest = (t) => ({
  id: t.id, category: 'coding', name: t.name,
  what: `${t.tier} — three functions, ${t.problems.reduce((n, p) => n + p.tests.length, 0)} executed edge-case tests (EvalPlus-style rigor).`,
  prompt: `Implement ALL THREE of the following JavaScript functions. Reply with ONLY one code block containing the three functions — no explanation.
${t.problems.map((p, i) => `${i + 1}. ${p.spec}`).join('\n')}`,
  async checkAsync(text) {
    const code = (String(text).match(/```(?:js|javascript)?\s*([\s\S]*?)```/) || [null, stripFences(text)])[1];
    const missing = t.problems.filter(p => !new RegExp(`function\\s+${p.fn}|${p.fn}\\s*=`).test(code)).map(p => p.fn);
    if (missing.length === t.problems.length) return { score: 0, detail: 'no requested functions found' };
    const cases = t.problems.flatMap(p => p.tests);
    const harness = `
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pass = 0, total = ${cases.length};
${cases.map(([expr, want]) => `try { if (eq(${expr}, ${want})) pass++; } catch {}`).join('\n')}
console.log('PASS ' + pass + '/' + total);`;
    const r = await runJs(code, harness, 8000);
    return {
      score: Math.round((r.pass / r.total) * 100) / 100,
      detail: r.err ? `crashed: ${r.err}` : `${r.pass}/${r.total} tests${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
    };
  },
});

for (const t of CODE_TIERS) TESTS.push(codeTierTest(t));

// ---------- running ----------

let running = null;   // { abort, batch }

export const benchStatus = () => ({ running: !!running, batch: running?.batch || null });

export function stopBench() {
  running?.abort.abort();
  return { ok: true };
}

export function startBench({ models = [], tests = [] } = {}) {
  if (running) throw Object.assign(new Error('a benchmark is already running — stop it first'), { status: 409 });
  models = [...new Set(models)].filter(Boolean).slice(0, 8);
  if (!models.length) throw Object.assign(new Error('pick at least one model'), { status: 400 });
  const suite = TESTS.filter(t => !tests.length || tests.includes(t.id));
  if (!suite.length) throw Object.assign(new Error('no matching tests'), { status: 400 });

  const batch = genId(8);
  const abort = new AbortController();
  running = { abort, batch };
  setTimeout(() => runBatch(batch, models, suite, abort).catch(() => { }).finally(() => { running = null; }), 100);
  return { batch, models, tests: suite.map(t => t.id) };
}

async function runBatch(batch, models, suite, ctl) {
  getDb();
  emit({ type: 'start', batch, models, tests: suite.map(t => t.id) });
  for (const model of models) {
    for (const test of suite) {
      if (ctl.signal.aborted) { emit({ type: 'done', batch, cancelled: true }); return; }
      emit({ type: 'test.start', model, test: test.id });
      const row = await runOne(model, test, ctl);
      db.prepare(`INSERT INTO runs (id, batch, model, test, category, score, detail, ttft_ms, gen_ms, out_tokens, tok_s, at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(genId(8), batch, model, test.id, test.category, row.score, row.detail, row.ttftMs, row.genMs, row.outTokens, row.tokS, now());
      emit({ type: 'test.done', model, test: test.id, ...row });
    }
    emit({ type: 'model.done', model });
  }
  emit({ type: 'done', batch });
}

async function runOne(model, test, ctl) {
  const t0 = Date.now();
  try {
    // 4000 by default: reasoning models (Qwen3, R1-likes) spend most of their budget
    // in <think> before writing a word. At 1600 they hit the cap mid-thought and score
    // 0 on tasks they can actually do — measuring the budget, not the model.
    const res = await streamChat({
      modelRef: model, maxTokens: test.maxTokens || 4000, signal: ctl.signal,
      sampling: { temperature: 0 },   // determinism: same model + same test → same answer
      system: test.system || 'Follow the task exactly. Precision beats verbosity.',
      // tests may supply a full multi-turn transcript instead of a single prompt
      messages: test.messages || [{ role: 'user', text: test.prompt }],
      tools: test.tools,
    });
    // timing comes from streamChat's central measurement — one stopwatch for the app
    const p = res.perf || {};
    const r = test.checkCall ? test.checkCall(res.toolCalls)
      : test.checkAsync ? await test.checkAsync(res.text)
        : test.check(res.text);
    // Distinguish "got it wrong" from "never finished thinking". Both score 0, but only
    // one is a competence signal — the other says the token budget (or the model's
    // verbosity) ran out. Hiding that makes a reasoning model look broken.
    let detail = r.detail;
    if (res.stopReason === 'length') {
      detail = !String(res.text || '').trim()
        ? `hit the ${test.maxTokens || 4000}-token cap while reasoning and never answered (${res.reasoning?.length || 0} chars of thinking)`
        : `${detail} — output was cut off at the token cap`;
    }
    return {
      score: r.score, detail,
      ttftMs: p.ttftMs || 0, genMs: p.totalMs || (Date.now() - t0),
      outTokens: p.outTokens || 0, tokS: p.tokS || 0,
    };
  } catch (e) {
    return { score: 0, detail: `error: ${e.message.slice(0, 140)}`, ttftMs: 0, genMs: Date.now() - t0, outTokens: 0, tokS: 0 };
  }
}

// ---------- leaderboard ----------

export function leaderboard() {
  getDb();
  // latest run per (model, test) — re-running a test replaces its standing, history stays.
  // Only tests in the CURRENT suite count: when the suite gets harder, stale wins from
  // retired test versions must not prop up a model's standing.
  const ids = new Set(TESTS.map(t => t.id));
  const rows = db.prepare(`
    SELECT r.* FROM runs r
    JOIN (SELECT model, test, MAX(at) AS at FROM runs GROUP BY model, test) x
      ON r.model = x.model AND r.test = x.test AND r.at = x.at`).all()
    .filter(r => ids.has(r.test));
  const models = {};
  for (const r of rows) {
    const m = (models[r.model] ||= { model: r.model, tests: {}, categories: {}, tokS: [], at: r.at });
    m.tests[r.test] = { score: r.score, detail: r.detail, tokS: r.tok_s, ttftMs: r.ttft_ms, at: r.at };
    (m.categories[r.category] ||= []).push(r.score);
    if (r.tok_s) m.tokS.push(r.tok_s);
    if (r.at > m.at) m.at = r.at;
  }
  const out = Object.values(models).map(m => {
    const cats = Object.fromEntries(Object.entries(m.categories).map(([c, arr]) => [c, Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100]));
    const all = Object.values(m.tests).map(t => t.score);
    const tokS = m.tokS.length ? Math.round(m.tokS.reduce((a, b) => a + b, 0) / m.tokS.length * 10) / 10 : 0;
    const ttfts = Object.values(m.tests).map(t => t.ttftMs).filter(Boolean);
    const quality = all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length * 100) / 100 : 0;
    return {
      model: m.model, tests: m.tests, categories: cats,
      overall: quality, tokS,
      ttftMs: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : 0,
      // Speed as a scored dimension: 40 tok/s is "full marks" on this class of hardware,
      // so a fast-but-dumb model and a smart-but-glacial one are directly comparable.
      speedScore: Math.min(1, Math.round((tokS / 40) * 100) / 100),
      // What you actually feel using it: quality weighted 70/30 against speed.
      value: Math.round((quality * 0.7 + Math.min(1, tokS / 40) * 0.3) * 100) / 100,
      covered: all.length, at: m.at,
    };
  }).sort((a, b) => b.overall - a.overall);

  // best model per category — only among models that ran that category
  const best = {};
  for (const cat of [...new Set(TESTS.map(t => t.category))]) {
    const c = out.filter(m => m.categories[cat] !== undefined)
      .sort((a, b) => b.categories[cat] - a.categories[cat] || b.tokS - a.tokS)[0];
    if (c) best[cat] = { model: c.model, score: c.categories[cat] };
  }
  return { models: out, best, tests: TESTS.map(({ id, category, name, what }) => ({ id, category, name, what })) };
}

export const recentRuns = (limit = 40) => {
  getDb();
  return db.prepare('SELECT * FROM runs ORDER BY at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit)));
};

/** Wipe every recorded result — the fresh-start button for when the suite changes. */
export function clearRuns() {
  getDb();
  const n = db.prepare('SELECT COUNT(*) c FROM runs').get().c;
  db.exec('DELETE FROM runs');
  return { cleared: n };
}

/** Sweep: every local gguf through the full suite, in sequence. Each model is
 *  auto-served on its turn via its local: ref — start it and walk away. */
export async function startSweep({ tests = [] } = {}) {
  const { listLocalModels, modelAlias } = await import('./llmctl.js');
  const models = listLocalModels().map(m => `local:${modelAlias(m.file)}`);
  if (!models.length) throw Object.assign(new Error('no local gguf models found'), { status: 400 });
  return startBench({ models, tests });
}
