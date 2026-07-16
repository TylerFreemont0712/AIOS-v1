// Learning Corner E2E: mock LLM + mock SearXNG drive a real roadmap generation
// and a real lesson generation over the WS stream — proving the plan→search→
// read→write loop, the streamed lesson.delta events, the Next-ideas parser,
// and the module/lesson progress toggles.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');

const PORT = 7944, MPORT = 7945, SXPORT = 7946;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-learn-'));
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-learn-vault-'));

let n = 0;
const ok = (c, l) => { n++; if (!c) { console.error(`✗ ${l}`); cleanup(1); } console.log(`✓ ${l}`); };
const j = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const LESSON_MD = `# Lesson 1: Variables that actually vary
## Objectives
- declare and reassign variables
## Review
(first lesson)
## The mechanics
Variables bind names to values [1].
\`\`\`js
let x = 1;
\`\`\`
## Practice
1. warm-up: declare one.
<details><summary>Solution</summary>let a = 1;</details>
## Check yourself
1. what does let do?
<details><summary>Answer</summary>declares</details>
## Sources & further
- [1] https://example.org/js
## Next lesson ideas
- Functions as values
- Review: variable scoping drills
`;

// what the model returns when asked to REWRITE a lesson — distinct so the test can
// prove the body was actually replaced rather than regenerated into the same bytes
const LESSON_MD_V2 = LESSON_MD.replace('# Lesson 1: Variables that actually vary',
  '# Lesson 1: Variables that actually vary (rewritten)')
  .replace('## Practice', '## Practice\nThe rewritten drill.');

// mock OpenAI SSE — answers the roadmap JSON, the lesson plan, and the lesson body
const mock = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d);
  req.on('end', () => {
    const body = JSON.parse(raw);
    const userText = body.messages.find(m => m.role === 'user')?.content || '';
    let out = 'ok';
    if (/Recommend concrete next TARGETS/i.test(userText)) {
      // advisor — must be matched before the generic STRICT JSON (roadmap) branch
      out = JSON.stringify({
        certs: [{ name: 'Cert X', org: 'Org Y', cost: '~$100', difficulty: 'intermediate', prep_weeks: 4, why: 'Fits the goal.', url: 'https://example.org/cert' }],
        paths: [{ title: 'Path Z', horizon: '3 months', why: 'Because.', steps: ['a', 'b', 'c'] }],
      });
    } else if (/Write about \d+ questions/i.test(userText)) {
      // assessment/drill author — also contains "STRICT JSON", so it must match first
      out = JSON.stringify({ title: 'Mock paper', blurb: 'b', questions: [
        { kind: 'mcq', prompt: 'Q1', choices: ['a', 'b', 'c', 'd'], answer: '0', explanation: 'e', topic: 't1', difficulty: 'core', points: 1 },
        { kind: 'mcq', prompt: 'Q2', choices: ['a', 'b', 'c', 'd'], answer: '1', explanation: 'e', topic: 't2', difficulty: 'warmup', points: 1 },
        { kind: 'mcq', prompt: 'Q3', choices: ['a', 'b', 'c', 'd'], answer: '2', explanation: 'e', topic: 't1', difficulty: 'core', points: 1 },
      ] });
    } else if (/Output STRICT JSON only/i.test(userText)) {
      out = '{"modules":[{"title":"Language fundamentals","summary":"Can write small scripts.","topics":["variables","functions","control flow"]},{"title":"Tooling","summary":"Can use git and a debugger.","topics":["git basics","debugging"]},{"title":"Project: CLI tool","summary":"Ships a small CLI.","topics":["argument parsing","packaging"]}]}';
    } else if (/YOU ARE REWRITING/i.test(userText)) {
      out = LESSON_MD_V2;  // regenerate path — must be tested before the generic write branch
    } else if (/Write lesson \d+ in full/i.test(userText)) {
      out = LESSON_MD;   // must be tested BEFORE the plan branch — this prompt also contains "Lesson title:"
    } else if (/LESSON TITLE:/i.test(userText)) {
      out = 'LESSON TITLE: Variables that actually vary\nTYPE: standard\nQUERIES:\njavascript variables 2026\nlet vs const current guidance';
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of out.match(/.{1,40}/gs) || [out]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8 } })}\n\n`);
    res.write('data: [DONE]\n\n'); res.end();
  });
});
mock.listen(MPORT);

const sx = http.createServer((req, res) => {
  if (req.url.startsWith('/healthz')) { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ results: [
    { title: 'JS Variables Guide', url: 'https://example.org/js', content: 'let and const declare block-scoped variables. Current guidance prefers const.' },
    { title: 'Modern JS 2026', url: 'https://example.com/modern', content: 'What changed in JS this year: nothing about variables.' },
  ] }));
});
sx.listen(SXPORT);

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, AIOS_DATA: tmpData, AIOS_PORT: String(PORT), AIOS_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let slog = ''; server.stdout.on('data', d => slog += d); server.stderr.on('data', d => slog += d);
function cleanup(code) {
  try { server.kill('SIGKILL'); mock.close(); sx.close(); } catch { }
  fs.rmSync(tmpData, { recursive: true, force: true });
  fs.rmSync(tmpVault, { recursive: true, force: true });
  if (code) { console.error('--- server log ---\n' + slog.slice(-2000)); process.exit(code); }
}

let up = false;
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/status')).ok) { up = true; break; } } catch { } await new Promise(r => setTimeout(r, 250)); }
ok(up, 'server up');

await j('PUT', '/config', {
  providers: { custom: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${MPORT}/v1` }] },
  defaults: { chatModel: 'mock:m1' },
  tools: { searxng: { url: `http://127.0.0.1:${SXPORT}` } },
  vault: { path: tmpVault },
});

const list = await j('GET', '/learn');
ok(list.data.length === 1 && list.data[0].name === 'Programming', 'default Programming subject seeded');
const id = list.data[0].id;

// helper: subscribe first, fire the generator, collect events until done/error
async function streamRun(startFn) {
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('done event never arrived — STREAM STALLED')), 60_000);
    ws.on('open', async () => {
      ws.send(JSON.stringify({ t: 'sub', topic: 'learn:' + id }));
      const r = await startFn();
      if (r.status !== 200) { clearTimeout(timer); reject(new Error(`start failed: ${JSON.stringify(r.data)}`)); }
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t !== 'learn.event') return;
      events.push(m);
      if (m.ev?.type === 'done' || m.ev?.type === 'error') { clearTimeout(timer); resolve(); }
    });
    ws.on('error', reject);
  }).catch(e => { console.error('✗ ' + e.message); cleanup(1); });
  ws.close();
  return events;
}

// ---- roadmap ----
const rEvents = await streamRun(() => j('POST', `/learn/${id}/roadmap`, { modelRef: 'mock:m1' }));
ok(rEvents.every(e => e._topic === 'learn:' + id), 'every learn message carries _topic');
ok(rEvents.some(e => e.ev.type === 'search'), 'roadmap grounded itself with web search');
const rDone = rEvents.find(e => e.ev.type === 'done');
ok(rDone?.ev.kind === 'roadmap', 'roadmap done event');
let subj = (await j('GET', '/learn/' + id)).data;
ok(subj.roadmap?.modules?.length === 3 && subj.roadmap.modules[2].title.startsWith('Project'), 'roadmap persisted with project module');

// ---- lesson ----
const lEvents = await streamRun(() => j('POST', `/learn/${id}/lesson`, { modelRef: 'mock:m1' }));
const types = new Set(lEvents.map(e => e.ev.type));
ok(types.has('plan'), 'lesson plan event (title/type/queries)');
ok(types.has('source'), 'lesson read a web source');
ok(lEvents.filter(e => e.ev.type === 'lesson.delta').length > 3, 'lesson streamed incrementally (lesson.delta)');
const lDone = lEvents.find(e => e.ev.type === 'done');
ok(lDone?.ev.kind === 'lesson' && lDone.ev.lesson?.title === 'Variables that actually vary', 'lesson done event with parsed title');
subj = (await j('GET', '/learn/' + id)).data;
const lesson = subj.lessons?.[0];
// The subject payload carries lesson METADATA only — bodies are fetched per lesson so a
// subject with 40 lessons still loads fast. Content lives at /learn/:id/lessons/:lid.
ok(lesson && lesson.n === 1 && lesson.type === 'standard', 'lesson persisted');
ok(!('content' in lesson), 'subject payload must not carry lesson bodies');
const lessonFull = (await j('GET', `/learn/${id}/lessons/${lesson.id}`)).data;
ok(lessonFull.content.includes('## Practice'), 'lesson body fetched on demand with full content');
ok(lesson.next?.length === 2 && /Functions as values/.test(lesson.next[0]), 'Next-lesson ideas parsed');
ok(lesson.sources?.length >= 1, 'lesson carries cited sources');
ok(lesson.exportedTo && fs.existsSync(path.join(tmpVault, lesson.exportedTo)), 'lesson exported to the vault Learning/ shelf');

// ---- progress toggles ----
const mid = subj.roadmap.modules[0].id;
await j('POST', `/learn/${id}/modules/${mid}`, { done: true });
await j('POST', `/learn/${id}/lessons/${lesson.id}`, { done: true });
subj = (await j('GET', '/learn/' + id)).data;
ok(subj.roadmap.modules[0].done === true && subj.lessons[0].done === true, 'module + lesson done toggles persist');

// ---- lesson health ----
// The mock lesson is structurally sound (it just ends on a bullet, and is short because
// it's a stub). No ERROR may be raised against it: an over-strict checker that flags
// healthy lessons is worse than no checker, because you learn to ignore the badge.
ok(Array.isArray(lesson.health), 'lesson carries a health record');
ok(!lesson.health.some(i => i.level === 'error'), 'a structurally sound lesson raises no errors');
const check = (await j('POST', `/learn/${id}/check`)).data;
ok(check.checked === 1 && check.broken === 0, 'subject health sweep finds nothing damaged');
// (the checker's positive cases — narration, truncation, unclosed fences — are unit
//  tested against crafted bodies in scripts/audit.mjs)

// ---- regenerate in place ----
const before = lessonFull.content;
const regenEvents = await streamRun(() => j('POST', `/learn/${id}/lessons/${lesson.id}/regenerate`, { modelRef: 'mock:m1', instructions: 'make it better' }));
const regenDone = regenEvents.find(e => e.ev.type === 'done');
ok(regenDone?.ev.kind === 'lesson' && regenDone.ev.replaced === true, 'regenerate emits a done event flagged as a replacement');
subj = (await j('GET', '/learn/' + id)).data;
ok(subj.lessons.length === 1, 'regenerate must not create a second lesson');
const after = (await j('GET', `/learn/${id}/lessons/${lesson.id}`)).data;
ok(after.content !== before && /rewritten/.test(after.content), 'lesson body was actually replaced');
ok(subj.lessons[0].id === lesson.id && subj.lessons[0].n === 1, 'rewrite keeps the same id and slot');
ok(subj.lessons[0].done === true, 'rewrite preserves the done flag');
ok(!!after.revisedAt, 'revisedAt stamped');

// ---- revision history + restore ----
const revs = (await j('GET', `/learn/${id}/lessons/${lesson.id}/revisions`)).data;
ok(revs.length === 1 && /make it better/.test(revs[0].reason), 'the replaced version is snapshotted with its reason');
const revFull = (await j('GET', `/learn/${id}/lessons/${lesson.id}/revisions/${revs[0].id}`)).data;
ok(revFull.content === before, 'the snapshot holds the exact previous body');
await j('POST', `/learn/${id}/lessons/${lesson.id}/revisions/${revs[0].id}/restore`);
const restored = (await j('GET', `/learn/${id}/lessons/${lesson.id}`)).data;
ok(restored.content === before, 'restore puts the previous body back');
const revs2 = (await j('GET', `/learn/${id}/lessons/${lesson.id}/revisions`)).data;
ok(revs2.length === 2, 'restore snapshots the version it replaced, so it is itself undoable');

// ---- career/cert advisor ----
const adviceEvents = await streamRun(() => j('POST', `/learn/${id}/advise`, { modelRef: 'mock:m1' }));
const adviceDone = adviceEvents.find(e => e.ev.type === 'done');
ok(adviceDone?.ev.kind === 'advice' && adviceDone.ev.advice?.certs?.length === 1, 'advice done event carries the payload');
subj = (await j('GET', '/learn/' + id)).data;
ok(subj.advice?.certs?.[0]?.name === 'Cert X' && subj.advice?.certs?.[0]?.prepWeeks === 4, 'cert suggestion persisted with sanitized fields');
ok(subj.advice?.paths?.[0]?.steps?.length === 3, 'path suggestion persisted with steps');

// ---- drill kind ----
const drillEvents = await streamRun(() => j('POST', `/learn/${id}/assessment`, { kind: 'drill', modelRef: 'mock:m1' }));
const drillDone = drillEvents.find(e => e.ev.type === 'done');
ok(drillDone?.ev.kind === 'assessment' && drillDone.ev.count === 3, 'drill generated with questions');
subj = (await j('GET', '/learn/' + id)).data;
const drillA = subj.assessments.find(a => a.kind === 'drill');
ok(drillA && drillA.passPct === 0 && drillA.questions === 3, 'drill stored with no pass bar');

// ---- offline regenerate (the escape hatch when web search is what derails it) ----
const offEvents = await streamRun(() => j('POST', `/learn/${id}/lessons/${lesson.id}/regenerate`, { modelRef: 'mock:m1', useWeb: false }));
ok(offEvents.some(e => e.ev.type === 'note' && /offline/i.test(e.ev.text)), 'useWeb:false announces offline mode');
ok(!offEvents.some(e => e.ev.type === 'search'), 'useWeb:false performs no web search at all');

cleanup(0);
console.log(`\nALL ${n} LEARN CHECKS PASSED`);
