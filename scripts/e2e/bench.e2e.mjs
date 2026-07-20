// Bench E2E: a mock model with KNOWN abilities proves the scoring pipeline measures
// what it claims. The mock answers the reasoning, format, and coding tests correctly,
// flubs extraction, and ignores the tool-call test — the leaderboard must say exactly
// that. The coding test really executes the returned function in a subprocess.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7921, MPORT = 7922;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-e2e-bench-'));

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    const body = JSON.parse(raw);
    const user = body.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    let out = 'I decline to answer.';
    if (/A tank holds 2400 L/.test(user)) out = '960 after A alone; +600 together = 1560; drain 660 at 50 = 13.2 min. ANSWER: 45.2';
    else if (/EXACTLY four lines/.test(user)) out = 'delta echo november\nohce\n17\n-----------------';
    else if (/parseRange/.test(user)) out = '```js\nfunction parseRange(s){if(typeof s!=="string")throw new Error("bad");const t=s.replace(/\\s+/g,"");if(t==="")return[];const out=new Set();for(const part of t.split(",")){if(!/^\\d+(-\\d+)?$/.test(part))throw new Error("invalid: "+part);const [a,b]=part.split("-").map(Number);if(b===undefined)out.add(a);else{const lo=Math.min(a,b),hi=Math.max(a,b);for(let i=lo;i<=hi;i++)out.add(i);}}return[...out].sort((x,y)=>x-y);}\n```';
    else if (/Order #A-118/.test(user)) out = '{"order":"A-118","customer":"Meridian Labs","items":[{"name":"crates of solvent","qty":3,"unit_price":412.5},{"name":"spectrometer","qty":1,"unit_price":2899}],"total":4136.5,"phone":null}';
    else if (/Quote QT-3327/.test(user)) out = '{"quote":"QT-3327","contract_value":12400,"deposit":2955,"delivery":"2026-03-02","po":"PO-77841"}';   // falls for every distractor except deposit
    else if (/rollout of build 8\.4\.1/.test(user)) out = 'Build 8.4.1 was rolled back after checkout errors peaked at 4.1%, with hotfix 8.4.2 restoring rates the same evening despite six hours of degraded search indexing.';
    else if (/Timber Wolf 42/.test(user)) out = '_flow_rebmit!';
    else if (/hasCloseElements/.test(user)) out = '```js\nfunction hasCloseElements(nums,t){for(let i=0;i<nums.length;i++)for(let j=i+1;j<nums.length;j++)if(Math.abs(nums[i]-nums[j])<t)return true;return false;}\nfunction digitSum(s){let n=0;for(const c of s)if(c>="0"&&c<="9")n+=+c;return n;}\nfunction nestedParenDepth(s){let d=0,m=0;for(const c of s){if(c==="("){d++;m=Math.max(m,d);}else if(c===")"){d--;if(d<0)return -1;}}return d===0?m:-1;}\n```';
    // haystack + weather forecast: default decline / NO tool call emitted on purpose
    send({ choices: [{ delta: { content: out }, finish_reason: null }] });
    send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 30 } });
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

let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE + '/status')).ok) { up = true; break; } } catch { }
  await new Promise(r => setTimeout(r, 250));
}
ok(up, 'server up');
await j('PUT', '/config', { providers: { custom: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${MPORT}/v1` }] } });

// run the full suite over WS and wait for completion
const events = [];
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const timer = setTimeout(() => reject(new Error('timeout waiting for bench done')), 60_000);
  ws.on('open', async () => {
    ws.send(JSON.stringify({ t: 'sub', topic: 'bench' }));
    const r = await j('POST', '/bench/run', { models: ['custom_mock:m1'] });
    if (r.status !== 200) reject(new Error('run rejected: ' + JSON.stringify(r.data)));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'bench.event') return;
    events.push(m.ev);
    if (m.ev.type === 'done') { clearTimeout(timer); ws.close(); resolve(); }
  });
  ws.on('error', reject);
}).catch(e => { console.error('✗ ' + e.message); cleanup(1); });

ok(events.some(e => e.type === 'test.start'), 'progress events streamed');
const { data: board } = await j('GET', '/bench');
const m = board.models.find(x => x.model === 'custom_mock:m1');
ok(!!m, 'model appears on the leaderboard');
ok(m.tests['reasoning']?.score === 1, 'reasoning: computed 45.2 scores 1');
ok(m.tests['format']?.score === 1, 'format: all four dependent lines exact scores 1');
ok(m.tests['coding']?.score === 1, `coding: parseRange EXECUTED incl. edge/throw cases (${m.tests['coding']?.detail})`);
ok(m.tests['json-strict']?.score === 1, 'json-strict: typed numbers + computed total + null trap all pass');
ok(m.tests['transform']?.score === 1, 'transform: five ordered ops produce the exact string');
ok(m.tests['extraction']?.score === 0.2, `extraction: distractor answers score exactly the 1/5 they earned (${m.tests['extraction']?.detail})`);
ok(m.tests['toolcall']?.score === 0, 'toolcall: no tool call emitted scores 0');
ok(m.tests['haystack']?.score === 0, 'haystack: refusing to dig scores 0');
ok(m.tests['codegen-easy']?.score === 1, `codegen-easy: three functions EXECUTED against 18 cases (${m.tests['codegen-easy']?.detail})`);
ok(m.tests['codegen-hard']?.score === 0, 'codegen-hard: declining the harder tier scores 0');
ok(m.overall > 0.4 && m.overall < 0.9, `overall blends strengths and weaknesses (${m.overall})`);
ok(board.best.reasoning?.model === 'custom_mock:m1', 'best-for-task names the winner per category');
ok(m.tokS > 0, `speed recorded (${m.tokS} tok/s)`);

// determinism: re-running replaces the standing scores, history accumulates
await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('open', async () => { ws.send(JSON.stringify({ t: 'sub', topic: 'bench' })); await j('POST', '/bench/run', { models: ['custom_mock:m1'], tests: ['reasoning'] }); });
  ws.on('message', (raw) => { const m2 = JSON.parse(raw); if (m2.t === 'bench.event' && m2.ev.type === 'done') { ws.close(); resolve(); } });
});
const { data: runs } = await j('GET', '/bench/runs');
ok(runs.runs.filter(r => r.test === 'reasoning').length === 2, 'history keeps every run');
const { data: board2 } = await j('GET', '/bench');
ok(board2.models[0].tests['reasoning'].score === 1, 'leaderboard shows the latest standing');

// ---- clear all results ----
const cleared = await j('DELETE', '/bench/runs');
ok(cleared.data.cleared >= 12, `clear wipes every recorded run (${cleared.data.cleared})`);
const { data: empty } = await j('GET', '/bench');
ok(empty.models.length === 0, 'leaderboard is empty after clear — fresh start');

cleanup(0);
console.log(`\nALL ${n} BENCH CHECKS PASSED`);
