// Streaming E2E: proves the WS topic-fanout fix. Every published message must
// carry `_topic` so the client routes research/comfy/gh.suggest streams (they
// were silently dropped by an incomplete per-type mapping). Uses a mock LLM +
// mock SearXNG so a real research run streams plan/search/status events live.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');

const PORT = 7941, MPORT = 7942, SXPORT = 7943;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-stream-'));

let n = 0;
const ok = (c, l) => { n++; if (!c) { console.error(`✗ ${l}`); cleanup(1); } console.log(`✓ ${l}`); };
const j = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// mock OpenAI SSE — returns plausible research output per phase (queries, notes, report)
const mock = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d);
  req.on('end', () => {
    const body = JSON.parse(raw);
    const userText = body.messages.find(m => m.role === 'user')?.content || '';
    let out = 'the answer';
    if (/web search queries/i.test(userText)) out = 'SUBQUESTIONS:\n- what is X\n- how does X compare\nQUERIES:\nx overview\nx benchmarks\nx alternatives\nx criticism';
    else if (/Extract every fact/i.test(userText)) out = '- X is a thing [fact]\n- X benchmark: 42ms\n- X released 2026';
    else if (/markdown report/i.test(userText)) out = '## Answer\n**X is good.** It does things well.\n## Details\nConcrete facts here [1][2].';
    else if (/output one line/i.test(userText)) out = 'COVERED: what is X\nCOVERED: how does X compare\nDONE';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of out.match(/.{1,30}/gs) || [out]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8 } })}\n\n`);
    res.write('data: [DONE]\n\n'); res.end();
  });
});
mock.listen(MPORT);

// mock SearXNG — returns a couple of results per query so reads have material
const sx = http.createServer((req, res) => {
  if (req.url.startsWith('/healthz')) { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ results: [
    { title: 'X Overview', url: 'https://example.org/x', content: 'X is a system that does things. Benchmarks show 42ms. Released 2026.' },
    { title: 'X Compared', url: 'https://example.com/x-vs', content: 'X versus Y: X is faster but Y is simpler.' },
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
  if (code) { console.error('--- server log ---\n' + slog.slice(-2000)); process.exit(code); }
}

let up = false;
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/status')).ok) { up = true; break; } } catch { } await new Promise(r => setTimeout(r, 250)); }
ok(up, 'server up');

await j('PUT', '/config', {
  providers: { custom: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${MPORT}/v1` }] },
  defaults: { chatModel: 'mock:m1' },
  tools: { searxng: { url: `http://127.0.0.1:${SXPORT}` } },
});

// subscribe FIRST (like the app does), then start the run
const events = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('done event never arrived — STREAM STALLED')), 90_000);
  ws.on('open', async () => {
    const r = await j('POST', '/research', { question: 'What is X and how does it compare?', modelRef: 'mock:m1', depth: 'quick' });
    ws.send(JSON.stringify({ t: 'sub', topic: 'research:' + r.data.id }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'research.event') return;
    events.push(m);
    if (m.ev?.type === 'done' || m.ev?.type === 'error') { clearTimeout(timer); resolve(); }
  });
  ws.on('error', reject);
}).catch(e => { console.error('✗ ' + e.message); cleanup(1); });
ws.close();

ok(events.length > 0, `received ${events.length} live research events`);
ok(events.every(e => typeof e._topic === 'string' && e._topic.startsWith('research:')), 'every message carries _topic (the fanout fix)');
const types = new Set(events.map(e => e.ev?.type));
ok(types.has('plan'), 'plan event streamed');
ok(types.has('status'), 'status/phase events streamed');
ok([...types].includes('report.delta'), 'report streamed incrementally (report.delta)');
const done = events.find(e => e.ev?.type === 'done');
ok(done && done.ev.report && /## Answer/.test(done.ev.report), 'final report delivered live with ## Answer');

cleanup(0);
console.log(`\nALL ${n} STREAM CHECKS PASSED`);
