// Plan-mode E2E: drives the real agent loop with a scripted mock model to prove the
// plan → approve/reject → execute flow end to end:
//   - a planMode session first does a NO-TOOLS planning turn (tools: [] on the wire)
//     and emits plan.proposed instead of running anything
//   - approving (with an edited plan) commits the edited plan to the transcript, adds
//     the go-ahead, and the agent then executes tools for real
//   - rejecting stops the turn: no tool runs, nothing is written
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7919, MPORT = 7920;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-e2e-plan-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-proj-plan-'));

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const PLAN_TEXT = '1. Read the request.\n2. Write out.txt with the result.\n3. Confirm.\nRisks: none.';
const planBodies = [];   // request bodies for planning turns (system carries [PLAN MODE])
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    const body = JSON.parse(raw);
    const system = body.messages.find(m => m.role === 'system')?.content || '';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (/\[PLAN MODE\]/.test(system)) {
      planBodies.push(body);                                    // planning turn: emit a plan, no tools
      send({ choices: [{ delta: { content: PLAN_TEXT }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8 } });
    } else if (body.messages.some(m => m.role === 'tool')) {
      send({ choices: [{ delta: { content: 'Done — wrote out.txt.' }, finish_reason: null }] });   // after tool result: finish
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    } else {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'executed after approval' }) } }] }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
mock.listen(MPORT);

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, AIOS_DATA: tmpData, AIOS_PORT: String(PORT), AIOS_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let slog = '';
server.stdout.on('data', d => slog += d);
server.stderr.on('data', d => slog += d);
function cleanup(code) {
  try { server.kill('SIGKILL'); } catch { }
  try { mock.close(); } catch { }
  fs.rmSync(tmpData, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
  if (code) { console.error('--- server log ---\n' + slog.slice(-3000)); process.exit(code); }
}

// Drive one user turn; when a plan is proposed, respond with `plan` (a {decision,text}) if given.
function runTurn(sessId, text, plan) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const evs = [];
    const timer = setTimeout(() => reject(new Error('timeout waiting for turn.done')), 60_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'sub', topic: 'agent:' + sessId }));
      ws.send(JSON.stringify({ t: 'agent.user', sessionId: sessId, text }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t !== 'agent.event') return;
      evs.push(m.ev);
      if (m.ev.type === 'plan.proposed' && plan) ws.send(JSON.stringify({ t: 'agent.plan', sessionId: sessId, decision: plan.decision, text: plan.text }));
      if (m.ev.type === 'turn.done') { clearTimeout(timer); ws.close(); resolve(evs); }
    });
    ws.on('error', reject);
  });
}

let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE + '/status')).ok) { up = true; break; } } catch { }
  await new Promise(r => setTimeout(r, 250));
}
ok(up, 'server up');

await j('PUT', '/config', {
  providers: { custom: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${MPORT}/v1` }] },
  defaults: { agentModel: 'mock:m1' },
  agent: { memory: false, selfCheck: 'off', runTests: 'off' },
});
const reg = await j('POST', '/projects/register', { path: projDir });

// ---- scenario 1: plan → APPROVE (with an edit) → execute ----
const s1 = await j('POST', '/agent/sessions', { projectId: reg.data.id, modelRef: 'mock:m1', mode: 'auto', planMode: true });
ok(s1.status === 200 && s1.data.planMode === true, 'planMode session created');

const EDITED = '1. Edited by the user.\n2. Write out.txt.\n3. Stop.';
const ev1 = await runTurn(s1.data.id, 'Do the thing.', { decision: 'approve', text: EDITED })
  .catch(e => { console.error('✗ ' + e.message); cleanup(1); });

const proposed = ev1.find(e => e.type === 'plan.proposed');
ok(proposed && /Write out\.txt/.test(proposed.text), 'plan.proposed emitted before any tool ran');
ok(ev1.findIndex(e => e.type === 'plan.proposed') < ev1.findIndex(e => e.type === 'tool.start' || e.type === 'tool.request'), 'plan proposed BEFORE the first tool');
ok(planBodies.length >= 1 && (planBodies[0].tools || []).length === 0, 'planning turn shipped NO tools (tools: [])');
const resolved1 = ev1.find(e => e.type === 'plan.resolved');
ok(resolved1 && resolved1.decision === 'approve', 'plan.resolved approve emitted');
ok(ev1.some(e => e.type === 'tool.end' && e.name === 'write_file' && e.ok), 'tool executed after approval');
ok(fs.readFileSync(path.join(projDir, 'out.txt'), 'utf8') === 'executed after approval', 'file written by the executed plan');

const t1 = (await j('GET', '/agent/sessions/' + s1.data.id)).data.transcript;
ok(t1.some(m => m.role === 'assistant' && m.kind === 'plan' && m.text === EDITED), 'EDITED plan committed to transcript (user edit honored)');
ok(t1.some(m => m.role === 'user' && m.kind === 'plan' && /Approved/.test(m.text)), 'go-ahead message added after approval');

// ---- scenario 2: plan → REJECT → nothing runs ----
const s2 = await j('POST', '/agent/sessions', { projectId: reg.data.id, modelRef: 'mock:m1', mode: 'auto', planMode: true });
const ev2 = await runTurn(s2.data.id, 'Do the other thing.', { decision: 'reject' })
  .catch(e => { console.error('✗ ' + e.message); cleanup(1); });
ok(ev2.some(e => e.type === 'plan.proposed'), 'plan.proposed emitted (reject scenario)');
const resolved2 = ev2.find(e => e.type === 'plan.resolved');
ok(resolved2 && resolved2.decision === 'reject', 'plan.resolved reject emitted');
ok(!ev2.some(e => e.type === 'tool.start' || e.type === 'tool.end'), 'no tool ran after reject');
ok(ev2.some(e => e.type === 'turn.done'), 'turn ended cleanly on reject');
const t2 = (await j('GET', '/agent/sessions/' + s2.data.id)).data.transcript;
ok(t2.some(m => m.role === 'assistant' && m.kind === 'plan'), 'rejected plan still recorded in transcript');
ok(!t2.some(m => m.role === 'user' && m.kind === 'plan'), 'NO go-ahead message after reject');

// ---- plan mode is per-session and toggleable ----
const s3 = await j('POST', '/agent/sessions', { projectId: reg.data.id, modelRef: 'mock:m1', mode: 'auto' });
ok(s3.data.planMode === false, 'sessions default to plan mode OFF');
const upd = await j('PATCH', '/agent/sessions/' + s3.data.id, { planMode: true });
ok(upd.data.planMode === true, 'planMode toggles via PATCH');

cleanup(0);
console.log(`\nALL ${n} PLAN-MODE CHECKS PASSED`);
