// Lean-agent E2E: drives the real agent loop with a scripted mock model and a tiny
// context window to prove the context-economy machinery end to end:
//   - lean loadout: only core groups' schemas ship; the directory + load_tools appear
//   - load_tools activates a group whose tool is then actually callable
//   - remember pins survive into every later system prompt — including post-checkpoint
//   - automatic checkpoint: transcript overflow compacts into TASK/DONE/FACTS/NEXT,
//     originals land in the archive, and the run CONTINUES correctly afterwards
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7917, MPORT = 7918;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-e2e-lean-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-proj-lean-'));

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// ---- scripted mock model ----
const FAT = 'x'.repeat(1700);   // each write blows up the transcript toward the tiny budget
const script = [
  { tool: { name: 'remember', args: { note: 'The magic port is 1234 — never lose this.' } } },
  { tool: { name: 'write_file', args: { path: 'a.txt', content: FAT } } },
  { tool: { name: 'write_file', args: { path: 'b.txt', content: FAT } } },
  { tool: { name: 'write_file', args: { path: 'c.txt', content: FAT } } },
  { tool: { name: 'load_tools', args: { groups: ['learning'] } } },
  { tool: { name: 'learn_subjects', args: {} } },
  { text: 'All files written; port stays 1234.' },
];
const bodies = [];        // every scripted (non-checkpoint) request body, in order
let checkpointCalls = 0;
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    const body = JSON.parse(raw);
    const system = body.messages.find(m => m.role === 'system')?.content || '';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (/You compress an AI agent/.test(system)) {
      // the checkpoint summarizer — routed by content, not by script position
      checkpointCalls++;
      send({ choices: [{ delta: { content: 'TASK: write the fat files and keep port 1234.\nDONE: wrote a.txt and b.txt (1700 chars each) to the project root.\nFACTS: the magic port is 1234; files contain only x characters.\nNEXT: write c.txt, then finish.' }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8 } });
    } else {
      const step = script[Math.min(bodies.length, script.length - 1)];
      bodies.push(body);
      if (step.tool) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + bodies.length, function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }, finish_reason: null }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      } else {
        send({ choices: [{ delta: { content: step.text }, finish_reason: null }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      }
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

let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE + '/status')).ok) { up = true; break; } } catch { }
  await new Promise(r => setTimeout(r, 250));
}
ok(up, 'server up');

// tiny window (6k tokens) so the checkpoint machinery actually fires; memory/self-check
// rounds off so the script stays deterministic
await j('PUT', '/config', {
  providers: { custom: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${MPORT}/v1` }] },
  defaults: { agentModel: 'mock:m1', contextTokens: 6000 },
  agent: { memory: false, selfCheck: 'off', runTests: 'off' },
});
const reg = await j('POST', '/projects/register', { path: projDir });
const sess = await j('POST', '/agent/sessions', { projectId: reg.data.id, modelRef: 'mock:m1', mode: 'auto' });
ok(sess.status === 200 && sess.data.id, 'agent session created');

const events = [];
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const timer = setTimeout(() => reject(new Error('timeout waiting for turn.done')), 60_000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'sub', topic: 'agent:' + sess.data.id }));
    ws.send(JSON.stringify({ t: 'agent.user', sessionId: sess.data.id, text: 'Write three fat files. The magic port is 1234.' }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'agent.event') return;
    events.push(m.ev);
    if (m.ev.type === 'turn.done') { clearTimeout(timer); ws.close(); resolve(); }
  });
  ws.on('error', reject);
}).catch(e => { console.error('✗ ' + e.message); cleanup(1); });

// ---- lean loadout ----
const names0 = (bodies[0].tools || []).map(t => t.function?.name || t.name);
ok(names0.includes('write_file') && names0.includes('bash'), 'core tools shipped');
ok(names0.includes('load_tools') && names0.includes('remember'), 'meta tools shipped');
ok(!names0.includes('learn_subjects') && !names0.includes('web_search'), 'non-core schemas NOT shipped (lean)');
const sys0 = bodies[0].messages.find(m => m.role === 'system').content;
ok(/context-lean mode/.test(sys0) && /learning \[\d+\]/.test(sys0), 'system prompt carries the compact directory');
ok(JSON.stringify(bodies[0].tools).length < 15000, `lean tools payload is small (${JSON.stringify(bodies[0].tools).length} chars)`);

// ---- load_tools actually activates the group ----
const loadIdx = script.findIndex(s => s.tool?.name === 'load_tools');
const afterLoad = bodies[loadIdx + 1];
ok((afterLoad.tools || []).some(t => (t.function?.name || t.name) === 'learn_subjects'), 'learning schemas appear after load_tools');
const learnEnd = events.find(e => e.type === 'tool.end' && e.name === 'learn_subjects');
ok(learnEnd && learnEnd.ok && /Programming/.test(learnEnd.content), 'activated tool executes for real');

// ---- pins survive, including past the checkpoint ----
const lastSys = bodies[bodies.length - 1].messages.find(m => m.role === 'system').content;
ok(/Pinned notes/.test(lastSys) && /port is 1234/.test(lastSys), 'remember pin present in the final system prompt');

// ---- checkpoint fired and the run continued ----
ok(checkpointCalls >= 1, `checkpoint summarizer was called (${checkpointCalls}×)`);
const cpEv = events.find(e => e.type === 'checkpoint');
ok(cpEv && cpEv.tokensAfter < cpEv.tokensBefore, `checkpoint event: ${cpEv?.tokensBefore} → ${cpEv?.tokensAfter} tokens`);
const after = (await j('GET', '/agent/sessions/' + sess.data.id)).data;
ok(after.transcript.some(m => m.kind === 'checkpoint' && /TASK:/.test(m.text)), 'transcript holds the checkpoint message');
ok((after.archive || []).length >= 4, `compacted messages archived, not destroyed (${(after.archive || []).length})`);
ok(after.pins?.length === 1, 'pin persisted on the session');
for (const f of ['a.txt', 'b.txt', 'c.txt']) ok(fs.existsSync(path.join(projDir, f)), `work completed across the checkpoint: ${f}`);

cleanup(0);
console.log(`\nALL ${n} LEAN-AGENT CHECKS PASSED`);
