// Verify-loop E2E: a scripted mock model writes a bug that PARSES but fails the
// project's real tests — the review pass must run `npm test`, bounce the failure
// back, and the agent's fix must turn the suite green.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');

const PORT = 7931, MPORT = 7932;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-vfy-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-vfyproj-'));
fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({ name: 'vfy', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2));
fs.writeFileSync(path.join(projDir, 'test.js'),
  `const g = require('./greet.js');\nif (g !== 'hello') { console.error('greet mismatch: ' + g); process.exit(1); }\nconsole.log('greet ok');\n`);

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// scripted model: buggy write → "done" → (test bounce) → fix → "done" → (memory nudge) → nothing
const script = [
  { tool: { name: 'write_file', args: { path: 'greet.js', content: "module.exports = 'helo';\n" } } },
  { text: 'Added the greet module.' },
  { tool: { name: 'write_file', args: { path: 'greet.js', content: "module.exports = 'hello';\n" } } },
  { text: 'Fixed the greeting value.' },
  { text: 'nothing to record' },
];
let reqs = 0;
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    const step = script[Math.min(reqs++, script.length - 1)];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (step.tool) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + reqs, function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }, finish_reason: null }] });
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
  if (code) { console.error('--- server log ---\n' + slog.slice(-2500)); process.exit(code); }
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
ok(sess.status === 200, 'agent session created');

const events = [];
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const timer = setTimeout(() => reject(new Error('timeout waiting for turn.done')), 120_000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'sub', topic: 'agent:' + sess.data.id }));
    ws.send(JSON.stringify({ t: 'agent.user', sessionId: sess.data.id, text: 'Add a greet module that exports "hello".' }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'agent.event') return;
    events.push(m.ev);
    if (m.ev.type === 'turn.done') { clearTimeout(timer); ws.close(); resolve(); }
  });
  ws.on('error', reject);
}).catch(e => { console.error('✗ ' + e.message); cleanup(1); });

const testReports = events.filter(e => e.type === 'test.report');
ok(testReports.length === 2, `verify: tests ran twice (got ${testReports.length})`);
ok(testReports[0]?.ok === false && /npm test/.test(testReports[0].cmd), 'verify: first run FAILED and was reported');
ok(testReports[1]?.ok === true, 'verify: second run PASSED after the fix');
const bounce = events.find(e => e.type === 'user' && e.auto && /automatic test run/.test(e.text || ''));
ok(!!bounce && /greet mismatch: helo/.test(bounce.text), 'verify: failure output was fed back to the agent');
ok(fs.readFileSync(path.join(projDir, 'greet.js'), 'utf8').includes("'hello'"), 'verify: final file is the fixed version');

cleanup(0);
console.log(`\nALL ${n} VERIFY-LOOP CHECKS PASSED`);
