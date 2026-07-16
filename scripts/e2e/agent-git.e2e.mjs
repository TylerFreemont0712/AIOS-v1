// Agent-loop E2E: a scripted mock OpenAI provider drives the real agent through
// the intended git workflow — init → branch → edit → commit — in auto mode.
// Asserts the system prompt carries the git section and the repo ends up right.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7913, MPORT = 7914;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-e2e2-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-proj2-'));

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// ---- scripted mock model (OpenAI SSE) ----
const script = [
  { tool: { name: 'git_init', args: {} } },
  { tool: { name: 'git_branch', args: { name: 'aios/greet-feature' } } },
  { tool: { name: 'write_file', args: { path: 'greet.js', content: 'export const greet = (n) => `hello ${n}`;\n' } } },
  { tool: { name: 'git_commit', args: { message: 'feat: add greet module\n\n- new greet() helper' } } },
  { text: 'Created greet.js on a work branch and committed it.' },
];
const seenSystems = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    const body = JSON.parse(raw);
    seenSystems.push(body.messages.find(m => m.role === 'system')?.content || '');
    const step = script[Math.min(seenSystems.length - 1, script.length - 1)];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (step.tool) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + seenSystems.length, function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    } else {
      send({ choices: [{ delta: { content: step.text }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
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

await j('PUT', '/config', { providers: { custom: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${MPORT}/v1` }] }, defaults: { agentModel: 'mock:m1' } });
const reg = await j('POST', '/projects/register', { path: projDir });
const sess = await j('POST', '/agent/sessions', { projectId: reg.data.id, modelRef: 'mock:m1', mode: 'auto' });
ok(sess.status === 200 && sess.data.id, 'agent session created (auto mode)');

// drive over WS and collect events until the turn finishes
const events = [];
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const timer = setTimeout(() => reject(new Error('timeout waiting for turn.done')), 60_000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'sub', topic: 'agent:' + sess.data.id }));
    ws.send(JSON.stringify({ t: 'agent.user', sessionId: sess.data.id, text: 'Add a greet module.' }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'agent.event') return;
    events.push(m.ev);
    if (m.ev.type === 'turn.done') { clearTimeout(timer); ws.close(); resolve(); }
  });
  ws.on('error', reject);
}).catch(e => { console.error('✗ ' + e.message); cleanup(1); });

ok(seenSystems[0].includes('Version control (git'), 'system prompt: git section present');
ok(seenSystems[0].includes('NOT a git repository'), 'system prompt: reports repo-less state');
ok(seenSystems[0].includes('git_branch {name:"aios/'), 'system prompt: branch-before-changes rule');
ok(seenSystems[3]?.includes('is a git repo on branch "aios/greet-feature"'), 'system prompt: refreshes to live branch state per turn');

const ends = events.filter(e => e.type === 'tool.end');
for (const name of ['git_init', 'git_branch', 'write_file', 'git_commit']) {
  const e = ends.find(x => x.name === name);
  ok(e && e.ok, `agent loop: ${name} ran ok${e && name === 'git_commit' ? ` → "${e.content.split('\n')[0]}"` : ''}`);
}

const g = (args) => spawnSync('git', args, { cwd: projDir, encoding: 'utf8' }).stdout.trim();
ok(g(['rev-parse', '--abbrev-ref', 'HEAD']) === 'aios/greet-feature', 'repo: on the work branch');
ok(g(['log', '--format=%s']) === 'feat: add greet module', 'repo: commit subject correct');
ok(g(['status', '--porcelain']) === '', 'repo: clean tree');
ok(fs.readFileSync(path.join(projDir, 'greet.js'), 'utf8').includes('hello'), 'repo: file content written');

cleanup(0);
console.log(`\nALL ${n} AGENT-LOOP CHECKS PASSED`);
