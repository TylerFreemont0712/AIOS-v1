// LLM benchmark: which model is actually best for which job?
//
// Every test is DETERMINISTIC — outputs are checked programmatically (parsed, regex'd,
// or executed), never judged by another LLM. That keeps scores comparable across time
// and free of judge bias, which is the whole point of recording them. Each run also
// measures time-to-first-token and generation speed, because on local hardware "smart
// but 4 tok/s" loses to "close enough at 40 tok/s" for most tasks.
//
// Code is executed for real in FOUR languages — Python (the focus), JavaScript, Go, and
// C++ — so the suite measures cross-language coding, not one dialect. Every executed
// test records a per-CASE breakdown (what was called, what was expected, what the model
// actually produced, pass/fail) so you can drill into exactly HOW a model did, not just
// its aggregate score. Non-code tests record the same shape: each needle, each field,
// each rule as its own graded row.
//
// Results land in data/bench.db (SQLite). The leaderboard aggregates per model per
// category; the Bench app renders it, names a best model per task category, and lets you
// open any model to inspect every graded row and overlay models on a radar chart.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA } from './config.js';
import { streamChat, REASONING_LEVELS, normReasoning } from './llm.js';
import { id as genId, now } from './util.js';

const PYTHON = process.env.AIOS_PYTHON || 'python3';

// Token budget = room for the ANSWER + a THINKING budget scaled by reasoning level.
// The old flat 4000 cap cut reasoning models off mid-thought (they spend most of their
// budget in <think> before writing a word), scoring 0 on tasks they can actually do.
// Separating the two means a "hard" reasoning level gets ~20k of thinking room while a
// short answer still only reserves what it needs — no single arbitrary number.
const THINK_BUDGET = { off: 2048, low: 4096, medium: 8192, high: 20000 };
const ANSWER_TOKENS = { coding: 2048, context: 700, structure: 1000, accuracy: 900, instructions: 700, reasoning: 1200, agent: 500, judgment: 800 };
const budgetFor = (test, level) => (test.answerTokens || ANSWER_TOKENS[test.category] || 1024) + (THINK_BUDGET[normReasoning(level)] ?? THINK_BUDGET.medium);

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
  // migrations: the per-case breakdown and the raw model output are newer columns.
  const cols = new Set(db.prepare('PRAGMA table_info(runs)').all().map(c => c.name));
  if (!cols.has('breakdown')) db.exec("ALTER TABLE runs ADD COLUMN breakdown TEXT NOT NULL DEFAULT ''");
  if (!cols.has('output')) db.exec("ALTER TABLE runs ADD COLUMN output TEXT NOT NULL DEFAULT ''");
  if (!cols.has('reasoning')) db.exec("ALTER TABLE runs ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''");
  return db;
}

let publish = () => { };
export const setPublisher = (fn) => { publish = fn; };
const emit = (ev) => publish('bench', { t: 'bench.event', ev });

const safeParse = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

// ---------- output parsing helpers ----------

const stripFences = (t) => String(t || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
const firstJson = (t) => {
  const m = stripFences(t).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
};
// language-agnostic: grab the first fenced block, discarding any ```lang tag line.
function extractCode(text) {
  const s = String(text || '');
  const m = s.match(/```[a-zA-Z0-9+#.\-]*\r?\n([\s\S]*?)```/);
  if (m) return m[1];
  const m2 = s.match(/```([\s\S]*?)```/);
  return m2 ? m2[1] : s.trim();
}
// a graded row in a breakdown: one field, one needle, or one executed case.
const bk = (label, expected, got, pass, note) => ({ label, expected: str(expected), got: str(got), pass: !!pass, ...(note ? { note } : {}) });
const str = (v) => v === undefined ? '—' : v === null ? 'null' : typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();

// ---------- multi-language code execution ----------
//
// Same trust level as the agent's bash tool — this machine already runs model code.
// Each language builds a source file that runs the candidate against a generated harness
// and prints one `CASE\t<i>\t<0|1>\t<got>` line per case plus a final `PASS n/total`.
// A case's expected value is a native literal of the SAME language; `__THROW__` marks a
// case that passes iff the call raises.

function spawnCapture(cmd, args, opts, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { timeout: timeoutMs, ...opts }); }
    catch (e) { return resolve({ out: '', err: 'spawn: ' + e.message, code: -1 }); }
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; if (out.length > 200000) out = out.slice(-200000); });
    child.stderr.on('data', d => { err += d; if (err.length > 40000) err = err.slice(-40000); });
    child.on('error', e => resolve({ out, err: (err || '') + ' spawn:' + e.message, code: -1 }));
    child.on('close', code => resolve({ out, err, code }));
  });
}

function jsSource(code, cases) {
  const body = cases.map(([call, want], i) =>
    want === '__THROW__'
      ? `try{ (${call}); _pr(${i},0,'did not throw'); }catch(e){ _p++; _pr(${i},1,'threw'); }`
      : `try{ const _g=(${call}); const _ok=_eq(_g,(${want})); if(_ok)_p++; _pr(${i},_ok?1:0,_S(_g)); }catch(e){ _pr(${i},0,'ERR '+(e&&e.message||e)); }`
  ).join('\n');
  return `${code}
;const _eq=(a,b)=>{try{return JSON.stringify(a)===JSON.stringify(b)}catch{return a===b}};
const _S=(v)=>{try{return JSON.stringify(v)}catch{return String(v)}};
const _pr=(i,ok,got)=>console.log('CASE\\t'+i+'\\t'+ok+'\\t'+String(got).replace(/[\\r\\n\\t]/g,' ').slice(0,120));
let _p=0;const _T=${cases.length};
${body}
console.log('PASS '+_p+'/'+_T);`;
}

function pySource(code, cases) {
  const body = cases.map(([call, want], i) =>
    want === '__THROW__' ? `_run(${i}, lambda: (${call}), None, True)` : `_run(${i}, lambda: (${call}), (${want}))`
  ).join('\n');
  return `${code}
import json as _json
def _eq(a,b):
    try: return _json.dumps(a,sort_keys=True)==_json.dumps(b,sort_keys=True)
    except Exception: return a==b
def _short(v):
    try: return _json.dumps(v)
    except Exception: return str(v)
_p=0
_T=${cases.length}
def _pr(i,ok,got):
    print("CASE\\t%d\\t%d\\t%s"%(i,ok,str(got).replace("\\n"," ").replace("\\t"," ")[:120]))
def _run(i,thunk,want,expect_throw=False):
    global _p
    try:
        g=thunk()
        if expect_throw:
            _pr(i,0,"did not raise")
        else:
            ok=_eq(g,want)
            if ok:_p+=1
            _pr(i,1 if ok else 0,_short(g))
    except Exception as e:
        if expect_throw:
            _p+=1; _pr(i,1,"raised")
        else:
            _pr(i,0,"ERR "+str(e)[:80])
${body}
print("PASS %d/%d"%(_p,_T))`;
}

const goSol = (code) => (/^\s*package\s+\w+/m.test(String(code)) ? String(code).trim() : 'package main\n\n' + String(code).trim());
function goHarness(cases) {
  const body = cases.map(([call, want], i) =>
    `\t{ g := ${call}; w := ${want}; ok := reflect.DeepEqual(g, w); if ok { _p++ }; _pr(${i}, ok, g) }`
  ).join('\n');
  return `package main

import (
\t"fmt"
\t"reflect"
)

func _b2i(b bool) int { if b { return 1 }; return 0 }
func _pr(i int, ok bool, got interface{}) { fmt.Printf("CASE\\t%d\\t%d\\t%v\\n", i, _b2i(ok), got) }

func main() {
\t_p := 0
\t_T := ${cases.length}
${body}
\tfmt.Printf("PASS %d/%d\\n", _p, _T)
}`;
}

function cppSource(code, cases) {
  const body = cases.map(([call, want], i) =>
    `  { auto _g = ${call}; bool _ok = (_g == (${want})); if(_ok) _p++; printf("CASE\\t%d\\t%d\\t%s\\n", ${i}, _ok?1:0, _rep(_g).c_str()); }`
  ).join('\n');
  return `#include <bits/stdc++.h>
using namespace std;
${code}
static string _rep(int v){return to_string(v);}
static string _rep(long v){return to_string(v);}
static string _rep(long long v){return to_string(v);}
static string _rep(bool v){return v?"true":"false";}
static string _rep(const string& v){return v;}
static string _rep(const vector<int>& v){string s="[";for(size_t i=0;i<v.size();i++){if(i)s+=",";s+=to_string(v[i]);}return s+"]";}
static int _p=0;
int main(){
  int _T=${cases.length};
${body}
  printf("PASS %d/%d\\n", _p, _T);
  return 0;
}`;
}

/** Run candidate code against cases in the given language. Returns per-case results so a
 *  breakdown can be recorded — never just an aggregate. */
async function runCases(lang, code, cases, timeoutMs) {
  const total = cases.length;
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-'));
  const to = timeoutMs || (lang === 'go' || lang === 'cpp' ? 15000 : 9000);
  try {
    let runCmd, runArgs, compile = null;
    if (lang === 'python') {
      writeFileSync(path.join(dir, 'run.py'), pySource(code, cases));
      runCmd = PYTHON; runArgs = [path.join(dir, 'run.py')];
    } else if (lang === 'go') {
      writeFileSync(path.join(dir, 'go.mod'), 'module bench\n\ngo 1.21\n');
      writeFileSync(path.join(dir, 'sol.go'), goSol(code));
      writeFileSync(path.join(dir, 'harness.go'), goHarness(cases));
      runCmd = 'go'; runArgs = ['run', '.'];
    } else if (lang === 'cpp') {
      writeFileSync(path.join(dir, 'main.cpp'), cppSource(code, cases));
      compile = { cmd: 'g++', args: ['-O2', '-std=c++17', path.join(dir, 'main.cpp'), '-o', path.join(dir, 'bin')] };
      runCmd = path.join(dir, 'bin'); runArgs = [];
    } else { // js
      writeFileSync(path.join(dir, 'run.js'), jsSource(code, cases));
      runCmd = process.execPath; runArgs = [path.join(dir, 'run.js')];
    }
    if (compile) {
      const c = await spawnCapture(compile.cmd, compile.args, { cwd: dir }, to);
      if (c.code !== 0) return { pass: 0, total, cases: [], err: 'compile: ' + ((c.err || c.out).trim().slice(0, 200) || 'failed') };
    }
    const r = await spawnCapture(runCmd, runArgs, { cwd: dir, env: process.env }, to);
    const parsed = [];
    let pass = 0;
    for (const line of r.out.split('\n')) {
      const m = line.match(/^CASE\t(\d+)\t([01])\t([\s\S]*)$/);
      if (m) { const ok = m[2] === '1'; if (ok) pass++; parsed[+m[1]] = { i: +m[1], pass: ok, got: m[3].slice(0, 120) }; }
    }
    const summary = r.out.match(/PASS (\d+)\/(\d+)/);
    const ran = parsed.filter(Boolean).length > 0 || !!summary;
    const err = ran ? '' : ((r.err || r.out).trim().slice(0, 200) || `no output (exit ${r.code})`);
    const outCases = cases.map((_, i) => parsed[i] || { i, pass: false, got: err ? 'no result' : 'not reported' });
    return { pass, total, cases: outCases, err };
  } catch (e) {
    return { pass: 0, total, cases: [], err: e.message.slice(0, 200) };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
}

const defRe = (lang, fn) => {
  const f = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (lang === 'python') return new RegExp(`def\\s+${f}\\b`);
  if (lang === 'go') return new RegExp(`func\\s+${f}\\b`);
  if (lang === 'cpp') return new RegExp(`\\b${f}\\s*\\(`);
  return new RegExp(`function\\s+${f}\\b|\\b${f}\\s*=`);
};

// ---------- the non-code suite ----------
//
// Difficulty philosophy: a capable 9B saturated the v1 suite, which made every model
// look identical. The suite discriminates: answers must be COMPUTED (never stated in the
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
      if (!j) return { score: 0, detail: 'no parseable JSON', breakdown: [bk('parseable JSON', 'an object', 'nothing parseable', false)] };
      const items = Array.isArray(j.items) ? j.items : [];
      const solvent = items.find(i => /solvent|crate/i.test(String(i?.name)));
      const spec = items.find(i => /spectrometer/i.test(String(i?.name)));
      const clean = !/```/.test(String(text)) && String(text).trim().startsWith('{');
      const rows = [
        bk('order', 'A-118', j.order, /A-?118/i.test(String(j.order))),
        bk('customer', 'Meridian Labs', j.customer, /meridian/i.test(String(j.customer))),
        bk('item count', 2, items.length, items.length === 2),
        bk('solvent line (typed)', 'qty 3 @ 412.5', solvent ? `qty ${solvent.qty} @ ${solvent.unit_price}` : 'missing', solvent && solvent.qty === 3 && solvent.unit_price === 412.5),
        bk('spectrometer line (typed)', 'qty 1 @ 2899', spec ? `qty ${spec.qty} @ ${spec.unit_price}` : 'missing', spec && spec.qty === 1 && spec.unit_price === 2899),
        bk('computed total', 4136.5, j.total, j.total === 4136.5),
        bk('phone null-trap', 'null', j.phone, j.phone === null),
        bk('clean (no prose/fences)', 'starts with {', clean ? 'clean' : 'extra text', clean),
      ];
      const pts = rows.filter(r => r.pass).length;
      return { score: Math.round((pts / 8) * 100) / 100, detail: `${pts}/8 (types + computed total + null trap${clean ? '' : ' + extra prose'})`, breakdown: rows };
    },
  },
  {
    id: 'extraction', category: 'accuracy', name: 'Exact extraction',
    what: 'Five values, each with a plausible distractor twin sitting next to it in the text.',
    prompt: `From the text below, output STRICT JSON {"quote": string, "contract_value": number, "deposit": number, "delivery": string, "po": string} — nothing else.
"Quote QT-3327 was superseded by QT-3401 (final). Original estimate $12,400; final contract value $9,850 after the March discount. Deposit of $2,955 (30%) received 2026-02-14; balance due net-45 from delivery, which slipped from 2026-03-02 to 2026-03-19. Client PO reference: PO-88123 (ignore our deprecated internal PO-77841)."`,
    check(text) {
      const j = firstJson(text);
      if (!j) return { score: 0, detail: 'no parseable JSON', breakdown: [bk('parseable JSON', 'an object', 'nothing parseable', false)] };
      const rows = [
        bk('quote (vs QT-3327)', 'QT-3401', j.quote, String(j.quote).toUpperCase().includes('QT-3401')),
        bk('contract_value (vs 12400)', 9850, j.contract_value, Number(j.contract_value) === 9850),
        bk('deposit', 2955, j.deposit, Number(j.deposit) === 2955),
        bk('delivery (vs 03-02)', '2026-03-19', j.delivery, String(j.delivery).includes('2026-03-19')),
        bk('po (vs PO-77841)', 'PO-88123', j.po, String(j.po).toUpperCase().includes('PO-88123')),
      ];
      const pts = rows.filter(r => r.pass).length;
      return { score: Math.round((pts / 5) * 100) / 100, detail: `${pts}/5 values exact (each had a distractor)`, breakdown: rows };
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
      const rows = [
        bk('line 1 (sorted)', 'delta echo november', lines[0], lines[0] === 'delta echo november'),
        bk('line 2 (middle reversed)', 'ohce', lines[1], lines[1] === 'ohce'),
        bk('line 3 (letter count)', '17', lines[2], lines[2] === '17'),
        bk('line 4 (hyphens)', '-'.repeat(17), lines[3], lines[3] === '-'.repeat(17)),
        bk('exactly four lines', 4, lines.filter(Boolean).length, lines.filter(Boolean).length === 4),
      ];
      const pts = rows.filter(r => r.pass).length;
      return { score: Math.round((pts / 5) * 100) / 100, detail: `${pts}/5 (dependent lines: sort → reverse → count → draw)`, breakdown: rows };
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
      if (!m) return { score: 0, detail: 'no ANSWER: line', breakdown: [bk('final answer', 45.2, 'no ANSWER: line', false)] };
      const ok = Math.abs(Number(m[1]) - 45.2) < 0.01;
      return { score: ok ? 1 : 0, detail: ok ? 'correct (45.2)' : `wrong (${m[1]}, expected 45.2)`, breakdown: [bk('final answer', 45.2, m[1], ok)] };
    },
  },
  {
    id: 'reasoning-2', category: 'reasoning', name: 'Constraint reasoning',
    what: 'A small logic puzzle with interlocking constraints — guessing lands on a plausible-but-wrong seat.',
    prompt: `Four people — Ada, Ben, Cy, and Dot — sit in a row of seats numbered 1 to 4, left to right.
Clues: (1) Ada is not at either end. (2) Ben sits immediately to the right of Cy. (3) Dot sits in seat 1.
Give the seat number (1–4) for each, then a final line EXACTLY: ANSWER: <Ada><Ben><Cy><Dot> as four digits with no spaces (e.g. ANSWER: 1234 meaning Ada=1,Ben=2,Cy=3,Dot=4).`,
    check(text) {
      // Dot=1. Ada in {2,3}. Cy,Ben adjacent with Ben=Cy+1. Seats left {2,3,4}. Ada not end → Ada in {2,3}.
      // Try Cy=3,Ben=4 → Ada=2 ✓. So Ada=2,Ben=4,Cy=3,Dot=1 → 2431.
      const m = String(text || '').match(/ANSWER:\s*(\d{4})/i);
      if (!m) return { score: 0, detail: 'no 4-digit ANSWER line', breakdown: [bk('seating', '2431', 'no ANSWER: line', false)] };
      const ok = m[1] === '2431';
      return { score: ok ? 1 : 0, detail: ok ? 'correct (Ada2 Ben4 Cy3 Dot1)' : `wrong (${m[1]}, expected 2431)`, breakdown: [bk('Ada·Ben·Cy·Dot seats', '2431', m[1], ok)] };
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
      if (!c) return { score: 0, detail: 'no tool call emitted', breakdown: [bk('emitted a tool call', 'get_forecast(...)', 'nothing', false)] };
      if (c.name !== 'get_forecast')
        return { score: 0, detail: `called ${c.name} — the task needs the forecast, not current conditions`, breakdown: [bk('tool', 'get_forecast', c.name, false)] };
      const rows = [
        bk('right tool', 'get_forecast', c.name, true),
        bk('city', 'Osaka', c.args?.city, /osaka/i.test(String(c.args?.city))),
        bk('days', 3, c.args?.days, Number(c.args?.days) === 3),
        bk('unit', 'celsius', c.args?.unit, String(c.args?.unit) === 'celsius'),
      ];
      const pts = rows.filter(r => r.pass).length;
      return { score: Math.round((pts / 4) * 100) / 100, detail: `${pts}/4 (right tool · city · days · unit)`, breakdown: rows };
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
      const words = t.split(/\s+/).length;
      const invented = /8\.4\.3|database|ddos|outage|crash|customers? lost/i.test(t);
      const rows = [
        bk('mentions build 8.4.1', '8.4.1', /8\.4\.1/.test(t) ? '8.4.1' : 'absent', /8\.4\.1/.test(t)),
        bk('peak error rate 4.1%', '4.1%', /4\.1\s*%/.test(t) ? '4.1%' : 'absent', /4\.1\s*%/.test(t)),
        bk('hotfix 8.4.2', '8.4.2', /8\.4\.2/.test(t) ? '8.4.2' : 'absent', /8\.4\.2/.test(t)),
        bk('within word cap', '≤36 words', `${words} words`, words <= 36),
        bk('nothing invented', 'no fabricated facts', invented ? 'invented a fact' : 'clean', !invented),
      ];
      const pts = rows.filter(r => r.pass).length;
      return { score: Math.round((pts / 5) * 100) / 100, detail: `${pts}/5 (3 exact facts · length · nothing invented)`, breakdown: rows };
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
      if (!j) return { score: 0, detail: 'no parseable JSON', breakdown: [bk('parseable JSON', 'an object', 'nothing parseable', false)] };
      const rows = [
        bk('locker_code (vs 8830/1145/9921)', '4417', j.locker_code, String(j.locker_code).includes('4417')),
        bk('backup_server (vs atlas-3)', 'helios-2', j.backup_server, /helios-2/i.test(String(j.backup_server))),
        bk('failed_job (vs J-2210)', 'J-2209', j.failed_job, /J-?2209/i.test(String(j.failed_job))),
      ];
      const pts = rows.filter(r => r.pass).length;
      return { score: Math.round((pts / 3) * 100) / 100, detail: `${pts}/3 needles (distractors everywhere)`, breakdown: rows };
    },
  },
  {
    id: 'longctx', category: 'context', name: 'Long-context retrieval',
    what: '~6k tokens of noise with three facts planted at 5%, 50% and 95% depth — the lost-in-the-middle probe.',
    answerTokens: 400,
    prompt: `Below is a long operations log. Read ALL of it, then output STRICT JSON {"valve_bay": string, "night_contact": string, "torque_nm": number} — nothing else.
Every answer appears exactly once, marked CRITICAL. Superseded/obsolete values appear too — report the CURRENT ones.

${haystackDoc()}`,
    check(text) {
      const j = firstJson(text);
      if (!j) return { score: 0, detail: 'no parseable JSON', breakdown: [bk('parseable JSON', 'an object', 'nothing parseable', false)] };
      const rows = [
        bk('valve_bay @5% (vs bay 9)', 'bay 14', j.valve_bay, /bay\s*14|14/i.test(String(j.valve_bay)) && !/bay\s*9\b/i.test(String(j.valve_bay))),
        bk('night_contact @50% (vs Tomas Ek)', 'Priya Raman / 4471', j.night_contact, /priya|raman|4471/i.test(String(j.night_contact))),
        bk('torque_nm @95% (vs 62)', 47, j.torque_nm, Number(j.torque_nm) === 47),
      ];
      const pts = rows.filter(r => r.pass).length;
      return { score: Math.round((pts / 3) * 100) / 100, detail: pts === 3 ? '3/3 needles' : `${pts}/3 — found: ${rows.filter(r => r.pass).map(r => r.label.split(' ')[0]).join(', ') || 'none'}`, breakdown: rows };
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
      const invented = /\b\d+(\.\d+)?\s*(%|percent|x)\s*(throughput|improvement|faster|higher)?/i.test(t) || /\bon\s+\d+\s+nodes?\b/i.test(t);
      const rows = [
        bk('declines the false premise', 'admits the paper is unknown', admits ? 'declined' : 'answered as if real', admits),
        bk('invents no figures', 'no throughput % or node count', invented ? 'produced specific numbers' : 'none', !invented),
      ];
      if (admits && !invented) return { score: 1, detail: 'correctly declined — no invented figures', breakdown: rows };
      if (admits && invented) return { score: 0.5, detail: 'hedged but still produced specific numbers', breakdown: rows };
      return { score: 0, detail: 'fabricated an answer to a non-existent paper', breakdown: rows };
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
      const held = t.endsWith('###');
      const body = t.replace(/###\s*$/, '');
      const sentences = (body.match(/[.!?]+/g) || []).length;
      const didTask = /compil/i.test(t);
      const clean = sentences >= 1 && sentences <= 3 && !/###/.test(body);
      const rows = [
        bk('rule survived 4 turns (ends ###)', 'ends with ###', held ? 'held' : 'DROPPED', held, 'worth 3 of 5 points'),
        bk('task done', 'describes a compiler', didTask ? 'done' : 'missing', didTask),
        bk('~2 sentences, no stray markers', '1–3 sentences', `${sentences} sentences`, clean),
      ];
      let pts = 0;
      if (held) pts += 3;
      if (didTask) pts++;
      if (clean) pts++;
      return { score: Math.round((pts / 5) * 100) / 100, detail: held ? `${pts}/5 (rule held)` : `${pts}/5 — RULE DROPPED after 4 turns`, breakdown: rows };
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
      const ok = t === '_flow_rebmit!';
      return { score: ok ? 1 : 0, detail: ok ? 'exact' : `got "${t.slice(0, 30)}", expected "_flow_rebmit!"`, breakdown: [bk('final string', '_flow_rebmit!', t.slice(0, 40), ok)] };
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

// ---------- the coding suite (HumanEval/MBPP/LeetCode-derived, EvalPlus-grade tests) ----------
//
// Grounded in what the field settled on: function synthesis is the standard, but the
// ORIGINAL test cases are too thin — EvalPlus showed pass rates drop sharply with
// rigorous edge-case tests, which is where models actually differ. These problems adapt
// classic HumanEval/MBPP/LeetCode tasks (MIT-licensed material) across FOUR languages and
// FIVE difficulty tiers, each executed for real with edge cases: empty inputs, boundaries,
// ties, unbalanced cases, and a genuinely hard "expert" tier (min-window, calculator,
// regex) that almost no local model clears — that is where the gradient lives.

const CODE_TIERS = [
  // ----- Python (the focus): easy → medium → hard → expert -----
  {
    id: 'py-easy', lang: 'python', name: 'Python — easy', tier: 'HumanEval-style basics',
    problems: [
      { fn: 'has_close_elements', spec: 'has_close_elements(nums, threshold) — True if any two DISTINCT positions hold numbers closer than threshold (strictly less).',
        cases: [['has_close_elements([1,2,3], 0.5)', 'False'], ['has_close_elements([1,2.8,3,4,5,2], 0.3)', 'True'], ['has_close_elements([], 1)', 'False'], ['has_close_elements([1], 1)', 'False'], ['has_close_elements([2,2], 0.1)', 'True'], ['has_close_elements([1,2], 1)', 'False']] },
      { fn: 'digit_sum', spec: 'digit_sum(s) — sum of all digit characters in the string; non-digits ignored; empty string gives 0.',
        cases: [['digit_sum("ab12c3")', '6'], ['digit_sum("")', '0'], ['digit_sum("no digits")', '0'], ['digit_sum("905")', '14'], ['digit_sum("0a0")', '0'], ['digit_sum("99")', '18']] },
      { fn: 'flip_case', spec: 'flip_case(s) — swap the case of every letter; non-letters unchanged.',
        cases: [['flip_case("Hello")', '"hELLO"'], ['flip_case("")', '""'], ['flip_case("123abcABC")', '"123ABCabc"'], ['flip_case("Zz")', '"zZ"']] },
      { fn: 'count_vowels', spec: 'count_vowels(s) — count a e i o u case-insensitively; y is NOT a vowel.',
        cases: [['count_vowels("hello")', '2'], ['count_vowels("")', '0'], ['count_vowels("AEIOU")', '5'], ['count_vowels("rhythm")', '0'], ['count_vowels("Yellow")', '2']] },
      { fn: 'is_palindrome', spec: 'is_palindrome(s) — True if s reads the same forwards/backwards considering ONLY alphanumerics, case-insensitively; "" is a palindrome.',
        cases: [['is_palindrome("A man, a plan, a canal: Panama")', 'True'], ['is_palindrome("")', 'True'], ['is_palindrome("race a car")', 'False'], ['is_palindrome("ab_a")', 'True'], ['is_palindrome("0P")', 'False']] },
    ],
  },
  {
    id: 'py-medium', lang: 'python', name: 'Python — medium', tier: 'MBPP-style with edge cases',
    problems: [
      { fn: 'longest_common_prefix', spec: 'longest_common_prefix(strs) — longest common prefix of a list of strings; [] gives "".',
        cases: [['longest_common_prefix([])', '""'], ['longest_common_prefix(["flower","flow","flight"])', '"fl"'], ['longest_common_prefix(["dog","racecar"])', '""'], ['longest_common_prefix(["same","same"])', '"same"'], ['longest_common_prefix([""])', '""'], ['longest_common_prefix(["ab"])', '"ab"']] },
      { fn: 'is_balanced', spec: 'is_balanced(s) — True if every ( ) [ ] { } nests correctly; all other characters ignored.',
        cases: [['is_balanced("a(b[c]{d})")', 'True'], ['is_balanced("([)]")', 'False'], ['is_balanced("")', 'True'], ['is_balanced("(((")', 'False'], ['is_balanced("{[]}()")', 'True'], ['is_balanced("]")', 'False']] },
      { fn: 'rle', spec: 'rle(s) — run-length encode: "aaabcc" → "a3b1c2"; empty string gives "".',
        cases: [['rle("aaabcc")', '"a3b1c2"'], ['rle("")', '""'], ['rle("a")', '"a1"'], ['rle("aaaaaaaaaaab")', '"a11b1"'], ['rle("abab")', '"a1b1a1b1"']] },
      { fn: 'compress_ranges', spec: 'compress_ranges(nums) — given a SORTED list of unique ints, collapse consecutive runs: [1,2,3,7,8,10] → "1-3,7-8,10". [] → "".',
        cases: [['compress_ranges([1,2,3,7,8,10])', '"1-3,7-8,10"'], ['compress_ranges([])', '""'], ['compress_ranges([5])', '"5"'], ['compress_ranges([1,2,4,5,6,9])', '"1-2,4-6,9"'], ['compress_ranges([1,3,5])', '"1,3,5"']] },
      { fn: 'valid_ipv4', spec: 'valid_ipv4(s) — True iff s is a valid dotted IPv4: four 0–255 octets, no leading zeros (except "0"), nothing extra.',
        cases: [['valid_ipv4("192.168.0.1")', 'True'], ['valid_ipv4("255.255.255.255")', 'True'], ['valid_ipv4("256.1.1.1")', 'False'], ['valid_ipv4("1.1.1")', 'False'], ['valid_ipv4("01.1.1.1")', 'False'], ['valid_ipv4("1.1.1.1.")', 'False']] },
      { fn: 'single_number', spec: 'single_number(nums) — every value appears exactly twice except one; return the one that appears once (O(n) time, O(1) space is the intended trick).',
        cases: [['single_number([2,2,1])', '1'], ['single_number([4,1,2,1,2])', '4'], ['single_number([1])', '1'], ['single_number([7,3,7])', '3']] },
      { fn: 'atoi', spec: 'atoi(s) — parse a leading integer: skip leading spaces, optional +/- sign, then digits (stop at the first non-digit); return 0 if no digits; clamp to the signed 32-bit range [-2147483648, 2147483647].',
        cases: [['atoi("42")', '42'], ['atoi("   -42")', '-42'], ['atoi("4193 with words")', '4193'], ['atoi("words and 987")', '0'], ['atoi("-91283472332")', '-2147483648'], ['atoi("+1")', '1'], ['atoi("2147483648")', '2147483647'], ['atoi("-000123")', '-123']] },
    ],
  },
  {
    id: 'py-hard', lang: 'python', name: 'Python — hard', tier: 'contest-style algorithms',
    problems: [
      { fn: 'merge_intervals', spec: 'merge_intervals(intervals) — merge overlapping OR touching [start,end] pairs; return sorted by start; [] gives [].',
        cases: [['merge_intervals([[1,3],[2,6],[8,10]])', '[[1,6],[8,10]]'], ['merge_intervals([])', '[]'], ['merge_intervals([[1,4],[4,5]])', '[[1,5]]'], ['merge_intervals([[5,6],[1,2]])', '[[1,2],[5,6]]'], ['merge_intervals([[1,10],[2,3]])', '[[1,10]]'], ['merge_intervals([[1,1]])', '[[1,1]]']] },
      { fn: 'top_k_frequent', spec: 'top_k_frequent(nums, k) — the k most frequent numbers, frequency descending, ties broken by smaller number first.',
        cases: [['top_k_frequent([1,1,1,2,2,3], 2)', '[1,2]'], ['top_k_frequent([1], 1)', '[1]'], ['top_k_frequent([3,3,2,2], 1)', '[2]'], ['top_k_frequent([5,5,4,4,4], 2)', '[4,5]'], ['top_k_frequent([7,7,7,1,2,2], 3)', '[7,2,1]'], ['top_k_frequent([], 0)', '[]']] },
      { fn: 'edit_distance', spec: 'edit_distance(a, b) — minimum single-character insertions, deletions, or substitutions to turn a into b (Levenshtein).',
        cases: [['edit_distance("kitten","sitting")', '3'], ['edit_distance("","abc")', '3'], ['edit_distance("abc","")', '3'], ['edit_distance("same","same")', '0'], ['edit_distance("ab","ba")', '2'], ['edit_distance("intention","execution")', '5']] },
      { fn: 'lis_length', spec: 'lis_length(nums) — length of the longest STRICTLY increasing subsequence; [] gives 0.',
        cases: [['lis_length([10,9,2,5,3,7,101,18])', '4'], ['lis_length([])', '0'], ['lis_length([7,7,7])', '1'], ['lis_length([1,2,3,4])', '4'], ['lis_length([4,3,2,1])', '1'], ['lis_length([0,8,4,12,2])', '3']] },
      { fn: 'coin_change', spec: 'coin_change(coins, amount) — fewest coins (any denomination reusable) that sum to amount; return -1 if impossible; 0 for amount 0.',
        cases: [['coin_change([1,2,5], 11)', '3'], ['coin_change([2], 3)', '-1'], ['coin_change([1], 0)', '0'], ['coin_change([1,2,5], 0)', '0'], ['coin_change([2,5,10,1], 27)', '4'], ['coin_change([186,419,83,408], 6249)', '20']] },
    ],
  },
  {
    id: 'py-expert', lang: 'python', name: 'Python — expert', tier: 'hard LeetCode (few models clear this)',
    problems: [
      { fn: 'min_window', spec: 'min_window(s, t) — the smallest substring of s that contains every character of t INCLUDING multiplicity; "" if none exists.',
        cases: [['min_window("ADOBECODEBANC","ABC")', '"BANC"'], ['min_window("a","a")', '"a"'], ['min_window("a","aa")', '""'], ['min_window("","a")', '""'], ['min_window("aa","aa")', '"aa"'], ['min_window("cabwefgewcwaefgcf","cae")', '"cwae"']] },
      { fn: 'calculate', spec: 'calculate(expr) — evaluate an arithmetic string with + - * / parentheses and precedence over non-negative integers; division truncates toward zero. No eval().',
        cases: [['calculate("3+2*2")', '7'], ['calculate("(1+(4+5+2)-3)+(6+8)")', '23'], ['calculate("2*(5+5*2)/3+(6/2+8)")', '21'], ['calculate("14-3/2")', '13'], ['calculate("0")', '0'], ['calculate("2*3*4")', '24']] },
      { fn: 'is_match', spec: 'is_match(s, p) — regex match supporting "." (any single char) and "*" (zero or more of the preceding element), matching the ENTIRE string.',
        cases: [['is_match("aa","a")', 'False'], ['is_match("aa","a*")', 'True'], ['is_match("ab",".*")', 'True'], ['is_match("aab","c*a*b")', 'True'], ['is_match("mississippi","mis*is*p*.")', 'False'], ['is_match("","c*")', 'True']] },
      { fn: 'largest_rectangle', spec: 'largest_rectangle(heights) — area of the largest rectangle that fits under a histogram of bar heights; [] gives 0. (The O(n) monotonic-stack problem.)',
        cases: [['largest_rectangle([2,1,5,6,2,3])', '10'], ['largest_rectangle([2,4])', '4'], ['largest_rectangle([])', '0'], ['largest_rectangle([6,2,5,4,5,1,6])', '12'], ['largest_rectangle([1,1])', '2']] },
      { fn: 'n_queens', spec: 'n_queens(n) — the number of distinct solutions to placing n non-attacking queens on an n×n board.',
        cases: [['n_queens(1)', '1'], ['n_queens(4)', '2'], ['n_queens(5)', '10'], ['n_queens(6)', '4'], ['n_queens(8)', '92']] },
    ],
  },

  // ----- JavaScript: three tiers, executed in Node -----
  {
    id: 'codegen-easy', lang: 'js', name: 'JavaScript — easy', tier: 'HumanEval-style basics',
    problems: [
      { fn: 'hasCloseElements', spec: 'hasCloseElements(nums, threshold) — true if any two DISTINCT positions in the array hold numbers closer than threshold (strictly less).',
        cases: [['hasCloseElements([1,2,3], 0.5)', 'false'], ['hasCloseElements([1,2.8,3,4,5,2], 0.3)', 'true'], ['hasCloseElements([], 1)', 'false'], ['hasCloseElements([1], 1)', 'false'], ['hasCloseElements([2,2], 0.1)', 'true'], ['hasCloseElements([1,2], 1)', 'false']] },
      { fn: 'digitSum', spec: 'digitSum(s) — sum of all digit characters in the string; non-digits ignored; empty string gives 0.',
        cases: [['digitSum("ab12c3")', '6'], ['digitSum("")', '0'], ['digitSum("no digits")', '0'], ['digitSum("905")', '14'], ['digitSum("0a0")', '0'], ['digitSum("99")', '18']] },
      { fn: 'nestedParenDepth', spec: 'nestedParenDepth(s) — maximum nesting depth of parentheses; return -1 if the string is unbalanced; empty string gives 0.',
        cases: [['nestedParenDepth("(())")', '2'], ['nestedParenDepth("()()")', '1'], ['nestedParenDepth("")', '0'], ['nestedParenDepth("(()")', '-1'], ['nestedParenDepth(")(")', '-1'], ['nestedParenDepth("((()))()")', '3']] },
    ],
  },
  {
    id: 'codegen-medium', lang: 'js', name: 'JavaScript — medium', tier: 'MBPP-style with edge cases',
    problems: [
      { fn: 'longestCommonPrefix', spec: 'longestCommonPrefix(arr) — longest common prefix string of an array of strings; [] gives "".',
        cases: [['longestCommonPrefix([])', '""'], ['longestCommonPrefix(["flower","flow","flight"])', '"fl"'], ['longestCommonPrefix(["dog","racecar"])', '""'], ['longestCommonPrefix(["same","same"])', '"same"'], ['longestCommonPrefix([""])', '""'], ['longestCommonPrefix(["ab"])', '"ab"']] },
      { fn: 'balanced', spec: 'balanced(s) — true if every ( ) [ ] { } in the string nests correctly; all other characters are ignored.',
        cases: [['balanced("a(b[c]{d})")', 'true'], ['balanced("([)]")', 'false'], ['balanced("")', 'true'], ['balanced("(((")', 'false'], ['balanced("{[]}()")', 'true'], ['balanced("]")', 'false']] },
      { fn: 'rle', spec: 'rle(s) — run-length encode: "aaabcc" → "a3b1c2"; empty string gives "".',
        cases: [['rle("aaabcc")', '"a3b1c2"'], ['rle("")', '""'], ['rle("a")', '"a1"'], ['rle("aaaaaaaaaaab")', '"a11b1"'], ['rle("abab")', '"a1b1a1b1"']] },
    ],
  },
  {
    id: 'codegen-hard', lang: 'js', name: 'JavaScript — hard', tier: 'contest-style algorithms',
    problems: [
      { fn: 'mergeIntervals', spec: 'mergeIntervals(list) — merge overlapping OR touching [start,end] intervals; return them sorted by start; [] gives [].',
        cases: [['mergeIntervals([[1,3],[2,6],[8,10]])', '[[1,6],[8,10]]'], ['mergeIntervals([])', '[]'], ['mergeIntervals([[1,4],[4,5]])', '[[1,5]]'], ['mergeIntervals([[5,6],[1,2]])', '[[1,2],[5,6]]'], ['mergeIntervals([[1,10],[2,3]])', '[[1,10]]'], ['mergeIntervals([[1,1]])', '[[1,1]]']] },
      { fn: 'topKFrequent', spec: 'topKFrequent(arr, k) — the k most frequent numbers, ordered by frequency descending, ties broken by smaller number first.',
        cases: [['topKFrequent([1,1,1,2,2,3], 2)', '[1,2]'], ['topKFrequent([1], 1)', '[1]'], ['topKFrequent([3,3,2,2], 1)', '[2]'], ['topKFrequent([5,5,4,4,4], 2)', '[4,5]'], ['topKFrequent([7,7,7,1,2,2], 3)', '[7,2,1]'], ['topKFrequent([], 0)', '[]']] },
      { fn: 'editDistance', spec: 'editDistance(a, b) — minimum number of single-character insertions, deletions, or substitutions to turn a into b.',
        cases: [['editDistance("kitten","sitting")', '3'], ['editDistance("","abc")', '3'], ['editDistance("abc","")', '3'], ['editDistance("same","same")', '0'], ['editDistance("ab","ba")', '2'], ['editDistance("intention","execution")', '5']] },
    ],
  },

  // ----- Go: compiled, executed with `go run` -----
  {
    id: 'go-core', lang: 'go', name: 'Go — algorithms', tier: 'compiled & executed',
    problems: [
      { fn: 'TwoSum', spec: 'TwoSum(nums []int, target int) []int — return the two 0-based indices (earlier index first) whose values sum to target; exactly one solution when it exists, else an empty slice []int{}.',
        cases: [['TwoSum([]int{2,7,11,15}, 9)', '[]int{0,1}'], ['TwoSum([]int{3,2,4}, 6)', '[]int{1,2}'], ['TwoSum([]int{3,3}, 6)', '[]int{0,1}'], ['TwoSum([]int{1,2}, 10)', '[]int{}']] },
      { fn: 'MaxSubArray', spec: 'MaxSubArray(nums []int) int — the largest sum of any contiguous non-empty subarray (Kadane).',
        cases: [['MaxSubArray([]int{-2,1,-3,4,-1,2,1,-5,4})', '6'], ['MaxSubArray([]int{1})', '1'], ['MaxSubArray([]int{5,4,-1,7,8})', '23'], ['MaxSubArray([]int{-1,-2,-3})', '-1']] },
    ],
    note: 'Write ONLY the requested function(s) with `package main` and any imports they need. Do NOT write a main function.',
  },

  // ----- C++: compiled with g++, executed -----
  {
    id: 'cpp-core', lang: 'cpp', name: 'C++ — algorithms', tier: 'compiled & executed',
    problems: [
      { fn: 'twoSum', spec: 'vector<int> twoSum(vector<int> nums, int target) — return the two 0-based indices (earlier index first) whose values sum to target; exactly one solution when it exists, else an empty vector.',
        cases: [['twoSum(vector<int>{2,7,11,15}, 9)', 'vector<int>{0,1}'], ['twoSum(vector<int>{3,2,4}, 6)', 'vector<int>{1,2}'], ['twoSum(vector<int>{3,3}, 6)', 'vector<int>{0,1}'], ['twoSum(vector<int>{1,2}, 10)', 'vector<int>{}']] },
      { fn: 'isBalanced', spec: 'bool isBalanced(string s) — true if every ( ) [ ] { } nests correctly; other characters ignored.',
        cases: [['isBalanced(string("a(b[c]{d})"))', 'true'], ['isBalanced(string("([)]"))', 'false'], ['isBalanced(string(""))', 'true'], ['isBalanced(string("((("))', 'false'], ['isBalanced(string("{[]}()"))', 'true']] },
    ],
    note: 'Write ONLY the requested function(s). <bits/stdc++.h> and `using namespace std;` are already provided — do NOT write includes or a main function.',
  },
];

const LANG_LABEL = { python: 'Python', js: 'JavaScript', go: 'Go', cpp: 'C++' };

function codeTierTest(t) {
  const totalCases = t.problems.reduce((n, p) => n + p.cases.length, 0);
  const label = LANG_LABEL[t.lang] || t.lang;
  return {
    id: t.id, category: 'coding', name: t.name, lang: t.lang, tier: t.tier,
    what: `${label} · ${t.tier} — ${t.problems.length} functions, ${totalCases} executed edge-case tests.`,
    prompt: `Implement ALL of the following ${label} function${t.problems.length > 1 ? 's' : ''}. Reply with ONLY one code block — no explanation.
${t.problems.map((p, i) => `${i + 1}. ${p.spec}`).join('\n')}${t.note ? `\n\n${t.note}` : ''}`,
    async checkAsync(text) {
      const code = extractCode(text);
      const present = t.problems.filter(p => defRe(t.lang, p.fn).test(code));
      const flat = [];
      for (const p of t.problems) for (const [call, want] of p.cases) flat.push({ fn: p.fn, call, want });
      if (!present.length)
        return { score: 0, detail: 'no requested functions found', breakdown: flat.map(c => bk(`${c.fn}: ${c.call}`, c.want, 'not implemented', false)) };
      const r = await runCases(t.lang, code, flat.map(c => [c.call, c.want]));
      const breakdown = flat.map((c, i) => bk(`${c.fn}: ${c.call}`, c.want, r.cases[i]?.got ?? '—', !!r.cases[i]?.pass));
      const missing = t.problems.filter(p => !present.includes(p)).map(p => p.fn);
      return {
        score: Math.round((r.pass / (r.total || 1)) * 100) / 100,
        detail: r.err ? `crashed: ${r.err}` : `${r.pass}/${r.total} tests${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
        breakdown,
      };
    },
  };
}

for (const t of CODE_TIERS) TESTS.push(codeTierTest(t));

// The original single JS coding probe: a parser with reversed ranges, overlaps,
// whitespace, and REQUIRED validation (must throw). Kept for continuity of scores.
TESTS.push({
  id: 'coding', category: 'coding', name: 'JavaScript — parser w/ validation', lang: 'js', tier: 'edge cases + must-throw',
  what: 'A parser with edge cases — reversed ranges, overlaps, whitespace, and required validation. Executed for real.',
  prompt: `Write a JavaScript function \`function parseRange(s)\` that parses strings like "1-3,7,10-12" into a sorted array of unique integers ([1,2,3,7,10,11,12]).
Rules: whitespace anywhere must be ignored; a reversed range like "9-7" means 7..9; overlapping ranges deduplicate; an empty string returns []; any invalid token (letters, double hyphens, empty parts between commas) must THROW an Error.
Reply with ONLY the code block — no explanation.`,
  async checkAsync(text) {
    const code = extractCode(text);
    if (!defRe('js', 'parseRange').test(code)) return { score: 0, detail: 'no parseRange function found', breakdown: [bk('parseRange defined', 'a function', 'not found', false)] };
    const cases = [
      ["parseRange('1-3,7,10-12')", '[1,2,3,7,10,11,12]'], ["parseRange('5')", '[5]'], ["parseRange('9-7')", '[7,8,9]'],
      ["parseRange('1-3,2-4')", '[1,2,3,4]'], ["parseRange(' 1 - 3 , 5 ')", '[1,2,3,5]'], ["parseRange('3-3')", '[3]'],
      ["parseRange('10-12,1')", '[1,10,11,12]'], ["parseRange('')", '[]'], ["parseRange('2,x')", '__THROW__'], ["parseRange('1--3')", '__THROW__'],
    ];
    const r = await runCases('js', code, cases);
    const breakdown = cases.map((c, i) => bk(c[0], c[1] === '__THROW__' ? 'throws' : c[1], r.cases[i]?.got ?? '—', !!r.cases[i]?.pass));
    return { score: Math.round((r.pass / (r.total || 1)) * 100) / 100, detail: r.err ? `crashed: ${r.err}` : `${r.pass}/${r.total} cases (incl. edge + throw cases)`, breakdown };
  },
});

// ---------- running ----------

let running = null;   // { abort, batch, reasoning }

export const benchStatus = () => ({ running: !!running, batch: running?.batch || null, reasoning: running?.reasoning || null });

export function stopBench() {
  running?.abort.abort();
  return { ok: true };
}

export function startBench({ models = [], tests = [], reasoning } = {}) {
  if (running) throw Object.assign(new Error('a benchmark is already running — stop it first'), { status: 409 });
  models = [...new Set(models)].filter(Boolean).slice(0, 8);
  if (!models.length) throw Object.assign(new Error('pick at least one model'), { status: 400 });
  const suite = TESTS.filter(t => !tests.length || tests.includes(t.id));
  if (!suite.length) throw Object.assign(new Error('no matching tests'), { status: 400 });
  // Bench defaults to 'medium' thinking so reasoning models aren't cut off out of the box.
  const level = REASONING_LEVELS.includes(reasoning) ? reasoning : 'medium';

  const batch = genId(8);
  const abort = new AbortController();
  running = { abort, batch, reasoning: level };
  setTimeout(() => runBatch(batch, models, suite, abort, level).catch(() => { }).finally(() => { running = null; }), 100);
  return { batch, models, tests: suite.map(t => t.id), reasoning: level };
}

async function runBatch(batch, models, suite, ctl, level) {
  getDb();
  emit({ type: 'start', batch, models, tests: suite.map(t => t.id), reasoning: level });
  for (const model of models) {
    for (const test of suite) {
      if (ctl.signal.aborted) { emit({ type: 'done', batch, cancelled: true }); return; }
      emit({ type: 'test.start', model, test: test.id });
      const row = await runOne(model, test, ctl, level);
      db.prepare(`INSERT INTO runs (id, batch, model, test, category, score, detail, ttft_ms, gen_ms, out_tokens, tok_s, breakdown, output, reasoning, at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(genId(8), batch, model, test.id, test.category, row.score, row.detail, row.ttftMs, row.genMs, row.outTokens, row.tokS, JSON.stringify(row.breakdown || []), row.output || '', row.reasoning || '', now());
      emit({ type: 'test.done', model, test: test.id, score: row.score, detail: row.detail, tokS: row.tokS, reasoning: row.reasoning });
    }
    emit({ type: 'model.done', model });
  }
  emit({ type: 'done', batch });
}

async function runOne(model, test, ctl, level) {
  const t0 = Date.now();
  const maxTokens = budgetFor(test, level);
  try {
    const res = await streamChat({
      modelRef: model, maxTokens, signal: ctl.signal, reasoning: level,
      sampling: { temperature: 0 },   // determinism: same model + same test → same answer
      system: test.system || 'Follow the task exactly. Precision beats verbosity.',
      messages: test.messages || [{ role: 'user', text: test.prompt }],
      tools: test.tools,
    });
    const p = res.perf || {};
    const r = test.checkCall ? test.checkCall(res.toolCalls)
      : test.checkAsync ? await test.checkAsync(res.text)
        : test.check(res.text);
    let detail = r.detail;
    if (res.stopReason === 'length') {
      detail = !String(res.text || '').trim()
        ? `hit the ${maxTokens}-token cap while reasoning and never answered (${res.reasoning?.length || 0} chars of thinking) — try a lower reasoning level`
        : `${detail} — output was cut off at the ${maxTokens}-token cap`;
    }
    const output = test.tools ? JSON.stringify(res.toolCalls || []).slice(0, 4000) : String(res.text || '').slice(0, 4000);
    return {
      score: r.score, detail, breakdown: r.breakdown || [], output, reasoning: p.reasoning || level,
      ttftMs: p.ttftMs || 0, genMs: p.totalMs || (Date.now() - t0),
      outTokens: p.outTokens || 0, tokS: p.tokS || 0,
    };
  } catch (e) {
    return { score: 0, detail: `error: ${e.message.slice(0, 140)}`, breakdown: [], output: '', reasoning: level, ttftMs: 0, genMs: Date.now() - t0, outTokens: 0, tokS: 0 };
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
    m.tests[r.test] = { score: r.score, detail: r.detail, tokS: r.tok_s, ttftMs: r.ttft_ms, at: r.at, breakdown: safeParse(r.breakdown, []), output: r.output || '', reasoning: r.reasoning || '' };
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
      speedScore: Math.min(1, Math.round((tokS / 40) * 100) / 100),
      value: Math.round((quality * 0.7 + Math.min(1, tokS / 40) * 0.3) * 100) / 100,
      covered: all.length, at: m.at,
    };
  }).sort((a, b) => b.overall - a.overall);

  const best = {};
  for (const cat of [...new Set(TESTS.map(t => t.category))]) {
    const c = out.filter(m => m.categories[cat] !== undefined)
      .sort((a, b) => b.categories[cat] - a.categories[cat] || b.tokS - a.tokS)[0];
    if (c) best[cat] = { model: c.model, score: c.categories[cat] };
  }
  return { models: out, best, tests: TESTS.map(({ id, category, name, what, lang, tier }) => ({ id, category, name, what, lang, tier })) };
}

export const recentRuns = (limit = 40) => {
  getDb();
  return db.prepare('SELECT * FROM runs ORDER BY at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit)));
};

/** Every recorded run for one (model, test) — the history behind a single graded cell. */
export function testHistory(model, test, limit = 20) {
  getDb();
  return db.prepare('SELECT * FROM runs WHERE model = ? AND test = ? ORDER BY at DESC LIMIT ?')
    .all(String(model), String(test), Math.max(1, Math.min(100, limit)))
    .map(r => ({ ...r, breakdown: safeParse(r.breakdown, []) }));
}

/** Wipe every recorded result — the fresh-start button for when the suite changes. */
export function clearRuns() {
  getDb();
  const n = db.prepare('SELECT COUNT(*) c FROM runs').get().c;
  db.exec('DELETE FROM runs');
  return { cleared: n };
}

/** Sweep: every local gguf through the full suite, in sequence. Each model is
 *  auto-served on its turn via its local: ref — start it and walk away. */
export async function startSweep({ tests = [], reasoning } = {}) {
  const { listLocalModels, modelAlias } = await import('./llmctl.js');
  const models = listLocalModels().map(m => `local:${modelAlias(m.file)}`);
  if (!models.length) throw Object.assign(new Error('no local gguf models found'), { status: 400 });
  return startBench({ models, tests, reasoning });
}
