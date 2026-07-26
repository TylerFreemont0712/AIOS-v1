// Chat personalization E2E: base system prompt, the current-events tool nudge, the
// auto-learned user profile (+ its injection), and chat folders / bulk ops.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7949, MPORT = 7950;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-e2e-chatpers-'));

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const chatBodies = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    const body = JSON.parse(raw);
    const system = body.messages.find(m => m.role === 'system')?.content || '';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (/You maintain a concise living profile/.test(system)) {
      send({ choices: [{ delta: { content: '# About Tester\n- Direct and terse; wants concrete answers.\n- Interested in systems programming.' }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 9 } });
    } else {
      chatBodies.push(body);   // a normal chat turn
      send({ choices: [{ delta: { content: 'Sure — here is a concise answer.' }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 6 } });
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
  if (code) { console.error('--- server log ---\n' + slog.slice(-3000)); process.exit(code); }
}

function runChat(chatId, text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const evs = [];
    const timer = setTimeout(() => reject(new Error('timeout')), 60_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'sub', topic: 'chat:' + chatId }));
      ws.send(JSON.stringify({ t: 'chat.send', chatId, text, modelRef: 'mock:m1' }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t !== 'chat.event') return;
      evs.push(m.ev);
      if (m.ev.type === 'done' || m.ev.type === 'error') { clearTimeout(timer); ws.close(); resolve(evs); }
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
  defaults: { chatModel: 'mock:m1', chatTools: true },
  user: { name: 'Tester' },
});

// ---- base system prompt is applied, with {name} filled in ----
const c1 = await j('POST', '/chats', { modelRef: 'mock:m1', tools: true });
await runChat(c1.data.id, 'Hello there!').catch(e => { console.error('✗ ' + e.message); cleanup(1); });
const sys1 = chatBodies.at(-1).messages.find(m => m.role === 'system').content;
ok(/Accuracy over recall/.test(sys1), 'base system prompt applied to the chat');
ok(sys1.includes('Tester') && !sys1.includes('{name}'), '{name} token filled in');

// ---- time-sensitive message gets the "search first" nudge ----
await runChat(c1.data.id, "What's the news today?").catch(e => { console.error('✗ ' + e.message); cleanup(1); });
const sys2 = chatBodies.at(-1).messages.find(m => m.role === 'system').content;
ok(/looks time-sensitive/i.test(sys2), 'temporal query triggers the search-first nudge');

// ---- profile learning + injection ----
const learned = await j('POST', '/profile/learn', { modelRef: 'mock:m1' });
ok(/# About/.test(learned.data.text) && /systems programming/.test(learned.data.text), 'profile learned from chats');
const got = await j('GET', '/profile');
ok(got.data.text === learned.data.text, 'profile persisted + readable');
await runChat(c1.data.id, 'Another question.').catch(e => { console.error('✗ ' + e.message); cleanup(1); });
const sys3 = chatBodies.at(-1).messages.find(m => m.role === 'system').content;
ok(/About Tester — learned/.test(sys3) && /systems programming/.test(sys3), 'profile injected into later chats');

// ---- manual profile edit sticks ----
await j('PUT', '/profile', { text: '# About Tester\n- Hand-edited note.' });
ok((await j('GET', '/profile')).data.text.includes('Hand-edited'), 'manual profile edit saved');

// ---- folders + bulk ops ----
const w1 = await j('POST', '/chats', { modelRef: 'mock:m1', folder: 'Work' });
ok(w1.data.folder === 'Work', 'chat created inside a folder');
const list = await j('GET', '/chats');
ok(list.data.find(c => c.id === w1.data.id)?.folder === 'Work', 'folder surfaced in listing');
await j('POST', '/chats/move', { ids: [w1.data.id], folder: 'Personal' });
ok((await j('GET', '/chats')).data.find(c => c.id === w1.data.id)?.folder === 'Personal', 'moveChats reassigns folder');
const bd = await j('POST', '/chats/bulk-delete', { ids: [w1.data.id, c1.data.id] });
ok(bd.data.deleted === 2, 'bulk-delete removes several chats');
ok(!(await j('GET', '/chats')).data.some(c => c.id === c1.data.id), 'deleted chats are gone');

cleanup(0);
console.log(`\nALL ${n} CHAT-PERSONALIZATION CHECKS PASSED`);
