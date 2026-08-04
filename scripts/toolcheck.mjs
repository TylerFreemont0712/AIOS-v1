#!/usr/bin/env node
// Tool audit: run EVERY tool on the agent's belt against a throwaway project, data dir
// and vault, and report what actually works.
//
//   npm run toolcheck            all tools
//   npm run toolcheck -- files   only groups matching "files"
//
// The point is coverage, not cleverness: a tool that has quietly rotted — a renamed
// helper, a changed signature, an API that started 404ing — looks identical to a working
// one until something calls it. This calls all of them.
//
// Results are classified rather than pass/fail, because a lot of the belt legitimately
// depends on the outside world:
//   pass    ran and returned something sensible
//   ENV     needs the internet, a model, or credentials this machine does not have
//   FAIL    broke in a way that is our problem
// Only FAIL exits non-zero.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-toolcheck-'));
const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-toolproj-'));
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-toolvault-'));
process.env.AIOS_DATA = tmpData;

const only = process.argv.slice(2).filter(a => !a.startsWith('-'));

// ---------- fixtures ----------

fs.mkdirSync(path.join(tmpProj, 'src'), { recursive: true });
fs.writeFileSync(path.join(tmpProj, 'README.md'), '# Fixture\n\nhello world, this is the audit fixture.\n');
fs.writeFileSync(path.join(tmpProj, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2));
fs.writeFileSync(path.join(tmpProj, 'src', 'app.js'), 'export const greet = (n) => `hello ${n}`;\n// TODO: audit marker\n');
const git = (...a) => spawnSync('git', a, { cwd: tmpProj, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'audit@example.com');
git('config', 'user.name', 'Audit');
git('add', '-A');
git('commit', '-qm', 'fixture');
fs.writeFileSync(path.join(tmpProj, 'src', 'app.js'), 'export const greet = (n) => `hi ${n}`;\n// TODO: audit marker\n');

fs.mkdirSync(path.join(tmpVault, 'Notes'), { recursive: true });
fs.writeFileSync(path.join(tmpVault, 'Notes', 'Seed.md'), '# Seed\n\nA note about pottery and kilns.\n');

const { loadConfig, saveConfig } = await import(path.join(ROOT, 'server/config.js'));
const cfg = loadConfig();
cfg.vault.path = tmpVault;                 // enables the vault group

// Borrow the real box's providers so the model-backed tools are actually exercised
// instead of all reporting "no model". Nothing is written back — this config lives in
// the throwaway data dir. Pass --no-model to audit the offline surface alone.
const realConfig = path.join(ROOT, 'data', 'config.json');
const useModel = !process.argv.includes('--no-model');
let modelRef = '';
if (useModel && fs.existsSync(realConfig)) {
  try {
    const real = JSON.parse(fs.readFileSync(realConfig, 'utf8'));
    if (real.providers) cfg.providers = real.providers;
    if (real.llm) cfg.llm = real.llm;
    if (real.defaults) {
      cfg.defaults = { ...cfg.defaults, ...real.defaults };
      modelRef = real.defaults.chatModel || real.defaults.agentModel || '';
    }
  } catch { /* audit the offline surface only */ }
}
saveConfig();

const tools = await import(path.join(ROOT, 'server/tools.js'));
const { runTool, TOOL_DEFS } = tools;
const ctx = { root: tmpProj, modelRef };

// ---------- the plan ----------
//
// needs: '' = must work offline · 'net' = internet/SearXNG · 'model' = an LLM provider
//        'creds' = credentials this box may not have · 'skip' = would touch the outside world
// ok(out): what a working call looks like. Default: no error and some output.

const has = (rx) => (o) => rx.test(o);
const nonEmpty = (o) => o.trim().length > 0;

const PLAN = {
  // ---- system ----
  bash: { args: { command: 'echo audit-ok' }, ok: has(/audit-ok/) },
  skill: { args: { name: 'core' }, ok: nonEmpty },
  system_status: { args: {}, ok: nonEmpty },
  bench_best: { args: {}, ok: nonEmpty },
  sql_query: { args: { db: 'finance', sql: 'SELECT 1 AS one' }, ok: has(/one|does not exist yet/) },
  create_tool: {
    args: {
      name: 'audit_probe', description: 'Returns a fixed string so the audit can verify the forge.',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
      access: 'read', code: 'return "forged-ok:" + (args.x || "none");',
    },
    ok: nonEmpty,
  },
  list_custom_tools: { args: {}, ok: has(/audit_probe/), after: 'create_tool' },
  delete_tool: { args: { name: 'audit_probe' }, ok: nonEmpty, last: true },

  // ---- files ----
  read_file: { args: { path: 'README.md' }, ok: has(/hello world/) },
  write_file: { args: { path: 'tmp/probe.txt', content: 'written by the audit' }, ok: nonEmpty },
  read_back: { tool: 'read_file', args: { path: 'tmp/probe.txt' }, ok: has(/written by the audit/), after: 'write_file' },
  edit_file: { args: { path: 'tmp/probe.txt', old_string: 'written', new_string: 'edited' }, ok: nonEmpty, after: 'write_file' },
  list_dir: { args: {}, ok: has(/README\.md/) },
  glob: { args: { pattern: '**/*.js' }, ok: has(/app\.js/) },
  grep: { args: { pattern: 'audit marker' }, ok: has(/app\.js/) },
  move_path: { args: { from: 'tmp/probe.txt', to: 'tmp/moved.txt' }, ok: nonEmpty, after: 'edit_file' },
  delete_path: { args: { path: 'tmp/moved.txt' }, ok: nonEmpty, after: 'move_path' },

  // ---- git ----
  git_status: { args: {}, ok: has(/branch|modified|app\.js/i) },
  git_diff: { args: {}, ok: has(/app\.js|hi \$\{n\}/) },
  git_log: { args: {}, ok: has(/fixture/) },
  git_init: { args: {}, ok: nonEmpty },
  git_branch: { args: { name: 'audit-branch' }, ok: nonEmpty },
  git_commit: { args: { message: 'audit commit' }, ok: nonEmpty, after: 'git_branch' },
  git_switch: { args: { name: 'audit-branch' }, ok: nonEmpty, after: 'git_commit' },
  git_push: { needs: 'skip', why: 'no remote on a fixture repo' },
  git_pull: { needs: 'skip', why: 'no remote on a fixture repo' },
  github_work: { args: {}, needs: 'creds', ok: nonEmpty },

  // ---- web ----
  web_search: { args: { query: 'model context protocol', max_results: 3 }, needs: 'net', ok: nonEmpty },
  fetch_url: { args: { url: 'https://example.com' }, needs: 'net', ok: has(/example/i) },
  crawl_site: { args: { url: 'https://example.com', max_pages: 1, depth: 0 }, needs: 'net', ok: nonEmpty },
  wikipedia: { args: { query: 'Kiln' }, needs: 'net', ok: nonEmpty },

  // ---- maps ----
  directions: { args: { from: 'Tokyo Station', to: 'Shibuya Station' }, needs: 'net', ok: nonEmpty },
  find_places: { args: { query: 'convenience store', near: 'Tokyo Station' }, needs: 'net', ok: nonEmpty },
  weather: { args: { place: 'Tokyo' }, needs: 'net', ok: nonEmpty },

  // ---- utility ----
  translate: { args: { text: 'good morning', to: 'ja' }, needs: 'net', ok: nonEmpty },
  calculate: { args: { expression: '(17 * 3) + 1.5' }, ok: has(/52\.5/) },
  convert: { args: { value: 2, from: 'km', to: 'mi' }, ok: has(/1\.242|1\.24/) },
  convert_currency: { tool: 'convert', args: { value: 10, from: 'usd', to: 'jpy' }, needs: 'net', ok: has(/JPY|jpy/i) },
  datetime: { args: {}, ok: nonEmpty },
  datetime_until: { tool: 'datetime', args: { until: '2030-01-01' }, ok: nonEmpty },

  // ---- vault ----
  vault_write: { args: { path: 'Notes/Audit.md', content: '# Audit\n\nprobe content about glazing.' }, ok: nonEmpty },
  vault_read: { args: { path: 'Notes/Audit.md' }, ok: has(/glazing/), after: 'vault_write' },
  vault_append: { args: { path: 'Notes/Audit.md', content: 'appended line' }, ok: nonEmpty, after: 'vault_write' },
  vault_list: { args: {}, ok: has(/Seed|Audit/) },
  vault_search: { args: { query: 'pottery' }, ok: nonEmpty },
  wiki_recall: { args: { query: 'pottery' }, ok: nonEmpty },
  wiki_learn: { args: { title: 'Audit Topic', content: '# Audit Topic\n\nWhat the audit learned.' }, ok: nonEmpty },
  note_template: { args: {}, ok: nonEmpty },
  wiki_index: { args: {}, ok: nonEmpty },
  wiki_generate: { args: { topic: 'kilns', count: 1 }, needs: 'model', ok: nonEmpty },
  daily_log: { args: { text: 'audit ran today' }, ok: nonEmpty },
  quick_note: { args: { title: 'Audit Quick Note', content: 'jotted by the audit' }, ok: nonEmpty },

  // ---- apps ----
  agenda_view: { args: {}, ok: nonEmpty },
  task_add: { args: { title: 'audit task', priority: 'normal' }, ok: nonEmpty },
  task_list: { args: {}, ok: has(/audit task/), after: 'task_add' },
  task_done: { args: {}, ok: nonEmpty, after: 'task_list', argsFrom: 'firstTaskId' },
  event_add: { args: { title: 'audit event', date: new Date().toISOString().slice(0, 10) }, ok: nonEmpty },
  finance_log: { args: { amount: 1234, kind: 'expense', category: 'Food & Drink', merchant: 'Audit Mart' }, ok: nonEmpty },
  finance_summary: { args: {}, ok: nonEmpty, after: 'finance_log' },
  finance_search: { args: { search: 'Audit Mart' }, ok: nonEmpty, after: 'finance_log' },
  finance_insights: { args: {}, ok: nonEmpty, after: 'finance_log' },
  price_check: { args: {}, ok: nonEmpty },
  research_status: { args: { id: 'no-such-run' }, ok: nonEmpty, expectError: true },
  research_start: { needs: 'skip', why: 'kicks off a long multi-model run' },
  notify: { args: { message: 'audit probe' }, needs: 'creds', ok: nonEmpty },
  comfy_status: { args: {}, needs: 'creds', ok: nonEmpty },
  comfy_generate: { needs: 'skip', why: 'would occupy the GPU for minutes' },
  model_auto_setup: { needs: 'skip', why: 'rewrites real model presets' },

  // ---- mail ----
  mail_recent: { args: { limit: 3 }, needs: 'creds', ok: nonEmpty },
  mail_search: { args: { query: 'receipt' }, needs: 'creds', ok: nonEmpty },
  mail_read: { args: { uid: '1' }, needs: 'creds', ok: nonEmpty },

  // ---- learning ----
  learn_create_subject: { args: { name: 'Audit Subject', goal: 'verify the learning tools', level: 'beginner' }, ok: nonEmpty },
  learn_subjects: { args: {}, ok: has(/Audit Subject/), after: 'learn_create_subject' },
  learn_subject: { args: {}, ok: nonEmpty, after: 'learn_subjects', argsFrom: 'subject' },
  learn_check_lessons: { args: {}, ok: nonEmpty, after: 'learn_subjects', argsFrom: 'subject' },
  learn_weak_topics: { args: {}, ok: nonEmpty, after: 'learn_subjects', argsFrom: 'subject' },
  learn_record_result: { args: { topic: 'glazing', correct: true }, ok: nonEmpty, after: 'learn_subjects', argsFrom: 'subject' },
  learn_create_quiz: { args: { title: 'Audit Quiz', kind: 'quiz' }, ok: nonEmpty, after: 'learn_subjects', argsFrom: 'subject' },
  learn_add_question: {
    args: { prompt: 'What is 2+2?', kind: 'mcq', choices: ['3', '4', '5'], answer: '4', topic: 'arithmetic' },
    ok: nonEmpty, after: 'learn_create_quiz', argsFrom: 'assessment',
  },
  learn_restore_revision: { needs: 'skip', why: 'needs a lesson revision, which needs a regenerate' },
  learn_attempt_review: { needs: 'skip', why: 'needs a completed quiz attempt' },
  // The generators run in dependency order — roadmap, then a lesson in it, then the
  // reads that only exist once a lesson does. On a local model each is a real
  // generation, so this is the slow half of the audit and the half most worth having.
  // Generation is fire-and-forget — the tool returns "started" and a background job does
  // the work — so the reads that depend on it have to wait for the job, not for the call.
  learn_generate_roadmap: {
    needs: 'model', args: {}, ok: nonEmpty, after: 'learn_subjects', argsFrom: 'subject',
    settle: { want: 1, timeoutMs: 300_000 },        // a module exists
  },
  learn_generate_lesson: {
    needs: 'model', args: {}, ok: nonEmpty, after: 'learn_generate_roadmap', argsFrom: 'subject',
    settle: { want: 2, timeoutMs: 300_000 },      // ...and now a lesson in it
  },
  learn_generate_assessment: { needs: 'model', args: {}, ok: nonEmpty, after: 'learn_generate_lesson', argsFrom: 'subject' },
  learn_suggest_paths: { needs: 'model', args: {}, ok: nonEmpty, after: 'learn_generate_roadmap', argsFrom: 'subject' },
  learn_lesson_read: { needs: 'model', args: {}, ok: nonEmpty, after: 'learn_generate_lesson', argsFrom: 'lesson' },
  learn_lesson_revisions: { needs: 'model', args: {}, ok: nonEmpty, after: 'learn_generate_lesson', argsFrom: 'lesson' },
  learn_module_done: { needs: 'model', args: { done: true }, ok: nonEmpty, after: 'learn_generate_roadmap', argsFrom: 'module' },
  learn_regenerate_lesson: { needs: 'skip', why: 'needs a generated lesson' },
};

// ---------- run ----------

const state = {};                     // ids discovered along the way
const results = [];
const groupOf = Object.fromEntries(TOOL_DEFS.map(t => [t.name, t.group]));

// Read ids from the learn module rather than regexing prose out of tool output: the
// wording of a result is not an API, and a harness that parses it breaks every time
// someone improves a sentence. Returns how far generation has got, so the settle loop
// has something to wait on.
const learnApi = await import(path.join(ROOT, 'server/learn.js'));
async function snapshotIds() {
  if (!state.subjectId) return 0;
  try {
    const s = learnApi.getSubject(state.subjectId);
    const modules = s.roadmap?.modules || [];       // getSubject nests them under roadmap
    const lessons = s.lessons || [];
    state.moduleId = modules[0]?.id || state.moduleId;
    state.lessonId = lessons[0]?.id || state.lessonId;
    // Rows appear while the job is still running, so "a module exists" is not "the
    // roadmap is done" — the lock is. Wait for the job, not for its first write.
    if (learnApi.isGenerating(state.subjectId)) return 0;
    return (state.moduleId ? 1 : 0) + (state.lessonId ? 1 : 0);
  } catch { return 0; }
}

/** Fill in ids that only exist once an earlier tool has run. */
function resolveArgs(entry, name) {
  const a = { ...(entry.args || {}) };
  if (entry.argsFrom === 'subject') a.subject_id = state.subjectId;
  if (entry.argsFrom === 'assessment') a.assessment_id = state.assessmentId;
  if (entry.argsFrom === 'firstTaskId') a.id = state.taskId;
  if (entry.argsFrom === 'lesson') { a.subject_id = state.subjectId; a.lesson_id = state.lessonId; }
  if (entry.argsFrom === 'module') { a.subject_id = state.subjectId; a.module_id = state.moduleId; }
  if (name.startsWith('learn_') && state.subjectId && !a.subject_id) a.subject_id = state.subjectId;
  return a;
}

/** Scrape ids out of a result so later tools have something real to work on.
 *  Anchored on `id=`, not "the first longish word" — that matched "Created". */
function learnIds(name, out) {
  const idAfterEquals = (out.match(/\bid=([A-Za-z0-9_-]+)/) || [])[1];
  if (name === 'learn_create_subject' && idAfterEquals) state.subjectId = idAfterEquals;
  if (name === 'learn_subjects') state.subjectId = (out.match(/^\s*([A-Za-z0-9_-]{6,})\s+Audit Subject/m) || [])[1] || state.subjectId;
  if (name === 'learn_create_quiz' && idAfterEquals) state.assessmentId = idAfterEquals;
  if (name === 'task_list') state.taskId = (out.match(/\[[ x]\]\s+([A-Za-z0-9_-]{6,})/) || [])[1] || state.taskId;
  // ids the generators mint, so the reads that depend on them get a real target
  if (name === 'learn_generate_roadmap') state.moduleId = (out.match(/\bmodule[_ ]?id[=: ]+([A-Za-z0-9_-]+)/i) || out.match(/\b([A-Za-z0-9_-]{8,})\b/) || [])[1] || state.moduleId;
  if (name === 'learn_generate_lesson') state.lessonId = (out.match(/\blesson[_ ]?id[=: ]+([A-Za-z0-9_-]+)/i) || out.match(/\bid=([A-Za-z0-9_-]+)/) || [])[1] || state.lessonId;
}

const ORDER = Object.keys(PLAN);
const pending = new Set(ORDER);
const done = new Set();
const queue = [];
// honour `after` without demanding the object be written in dependency order
while (pending.size) {
  let moved = false;
  for (const k of ORDER) {
    if (!pending.has(k)) continue;
    const dep = PLAN[k].after;
    if (dep && !done.has(dep)) continue;
    queue.push(k); done.add(k); pending.delete(k); moved = true;
  }
  if (!moved) { for (const k of pending) queue.push(k); break; }   // cycle guard
}

for (const key of queue) {
  const entry = PLAN[key];
  const name = entry.tool || key;
  const group = groupOf[name] || '?';
  if (only.length && !only.some(o => group.includes(o) || name.includes(o))) continue;

  if (entry.needs === 'skip') {
    results.push({ key, name, group, state: 'skip', detail: entry.why || 'not safe to run here' });
    continue;
  }
  const started = Date.now();
  let r;
  try { r = await runTool(name, resolveArgs(entry, name), ctx); }
  catch (e) { r = { content: 'threw: ' + e.message, isError: true }; }
  let ms = Date.now() - started;
  const out = String(r.content || '');
  learnIds(name, out);

  // Wait for a background job the call only kicked off, so the tools that need its
  // output are tested against a finished subject rather than an empty one.
  if (entry.settle && !r.isError && state.subjectId) {
    const deadline = Date.now() + entry.settle.timeoutMs;
    process.stdout.write(`  …waiting for ${name} (up to ${Math.round(entry.settle.timeoutMs / 1000)}s)`);
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 4000));
      if (await snapshotIds() >= entry.settle.want) break;
      process.stdout.write('.');
    }
    process.stdout.write('\n');
    ms = Date.now() - started;
  }

  const wanted = entry.expectError ? r.isError : !r.isError && (entry.ok ? entry.ok(out) : nonEmpty(out));
  if (wanted) {
    results.push({ key, name, group, state: 'pass', ms, detail: out.replace(/\s+/g, ' ').slice(0, 74) });
  } else if (entry.needs) {
    results.push({ key, name, group, state: 'env', ms, detail: `${entry.needs}: ${out.replace(/\s+/g, ' ').slice(0, 66)}` });
  } else {
    results.push({ key, name, group, state: 'FAIL', ms, detail: out.replace(/\s+/g, ' ').slice(0, 150) });
  }
}

// ---------- coverage ----------

const planned = new Set(Object.values(PLAN).map((e, i) => e.tool || Object.keys(PLAN)[i]));
const uncovered = TOOL_DEFS.map(t => t.name).filter(n => !planned.has(n));

// ---------- report ----------

const MARK = { pass: '✓ pass', env: '– env ', skip: '– skip', FAIL: '✗ FAIL' };
let lastGroup = '';
for (const r of results) {
  if (r.group !== lastGroup) { console.log(`\n${r.group.toUpperCase()}`); lastGroup = r.group; }
  const label = r.key === r.name ? r.name : `${r.name} (${r.key.replace(r.name + '_', '')})`;
  console.log(`  ${label.padEnd(26)} ${MARK[r.state]}  ${r.ms !== undefined ? String(r.ms + 'ms').padStart(7) : '       '}  ${r.detail}`);
}

const n = (s) => results.filter(r => r.state === s).length;
console.log('\n' + '-'.repeat(110));
console.log(`${n('pass')} pass · ${n('env')} environment-dependent · ${n('skip')} skipped · ${n('FAIL')} FAILED`);
if (uncovered.length) console.log(`not exercised by this plan: ${uncovered.join(', ')}`);

fs.rmSync(tmpData, { recursive: true, force: true });
fs.rmSync(tmpProj, { recursive: true, force: true });
fs.rmSync(tmpVault, { recursive: true, force: true });
process.exit(n('FAIL') ? 1 : 0);
