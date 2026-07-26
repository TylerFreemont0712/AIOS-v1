// Chat-tools E2E: proves plain Chat can now call read-only tools end to end —
//   - the read-only tool belt (incl. web_search/fetch_url — the "news" fix) is OFFERED
//     to the model, and the anti-refusal nudge is in the system prompt
//   - a tool call runs for real, its result is fed back, and the model answers
//   - the assistant turn persists which tools it used
//   - a tools-disabled chat is offered NO tools and makes no tool calls
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7947, MPORT = 7948;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-e2e-chattools-'));

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const bodies = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    const body = JSON.parse(raw);
    bodies.push(body);
    const hasTools = (body.tools || []).length > 0;
    const hasToolResult = body.messages.some(m => m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (hasTools && !hasToolResult) {
      // offered tools + no result yet → call one (agenda_view is hermetic: no network)
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'agenda_view', arguments: '{}' } }] }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
    } else {
      send({ choices: [{ delta: { content: 'Based on what I found, here you go.' }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 6 } });
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
    const timer = setTimeout(() => reject(new Error('timeout waiting for done')), 60_000);
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
});

// ---- scenario 1: tools ON → offered, called, fed back, answered, persisted ----
const c1 = await j('POST', '/chats', { modelRef: 'mock:m1', tools: true });
ok(c1.data.tools === true, 'chat created with tools on');
const ev1 = await runChat(c1.data.id, "What's the news today?").catch(e => { console.error('✗ ' + e.message); cleanup(1); });

const offered = (bodies[0].tools || []).map(t => t.function?.name || t.name);
ok(offered.includes('web_search') && offered.includes('fetch_url'), 'web_search + fetch_url OFFERED to the model (the news fix)');
ok(!offered.includes('bash') && !offered.includes('write_file'), 'no write/filesystem tools offered to chat');
const sys0 = bodies[0].messages.find(m => m.role === 'system')?.content || '';
ok(/web_search/.test(sys0) && /cannot access the internet/i.test(sys0), 'anti-refusal tool nudge in system prompt');

ok(ev1.some(e => e.type === 'tool.start' && e.name === 'agenda_view'), 'tool.start fired for the called tool');
const te = ev1.find(e => e.type === 'tool.end' && e.name === 'agenda_view');
ok(te && te.ok, 'tool.end fired, ran read-only tool successfully');
ok(bodies[1] && bodies[1].messages.some(m => m.role === 'tool' && /Agenda for/.test(m.content || '')), 'tool result fed back to the model');
const done1 = ev1.find(e => e.type === 'done');
ok(done1 && /here you go/i.test(done1.text), 'final answer produced after the tool round');
ok(Array.isArray(done1.tools) && done1.tools.includes('agenda_view'), 'done event reports tools used');
const saved = (await j('GET', '/chats/' + c1.data.id)).data;
ok(saved.messages.at(-1).tools?.includes('agenda_view'), 'assistant turn persisted with tools used');

// ---- scenario 2: tools OFF → none offered, no tool calls ----
bodies.length = 0;
const c2 = await j('POST', '/chats', { modelRef: 'mock:m1', tools: false });
ok(c2.data.tools === false, 'chat created with tools off');
const ev2 = await runChat(c2.data.id, 'Just chatting.').catch(e => { console.error('✗ ' + e.message); cleanup(1); });
ok((bodies[0].tools || []).length === 0, 'tools-off chat offers NO tools to the model');
ok(!ev2.some(e => e.type === 'tool.start'), 'no tool calls when tools are off');
ok(ev2.some(e => e.type === 'done'), 'tools-off chat still answers');

// ---- toggle persists via PATCH ----
const upd = await j('PATCH', '/chats/' + c2.data.id, { tools: true });
ok(upd.data.tools === true, 'tools toggle persists via PATCH');

cleanup(0);
console.log(`\nALL ${n} CHAT-TOOLS CHECKS PASSED`);
