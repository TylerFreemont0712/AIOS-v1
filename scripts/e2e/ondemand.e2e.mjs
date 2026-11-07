// On-demand model lifecycle: nothing loads llama-server by itself, the first request that
// needs a model does, and it is unloaded after a quiet spell — never mid-generation.
// Runs in one process against a fake llama-server (a script that answers /health, /slots
// and streams chat), with a throwaway AIOS_DATA so the real hub is untouched.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-ondemand-'));
const PORT = 18_000 + Math.floor(Math.random() * 1000);
const FAKE = path.join(DATA, 'llama-server');
process.env.AIOS_DATA = DATA;
process.env.AIOS_IDLE_TICK_MS = '250';

fs.mkdirSync(path.join(DATA, 'llm', 'models'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'llm', 'models', 'fake-a.gguf'), '');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
import http from 'node:http';
const a = process.argv, port = Number(a[a.indexOf('--port') + 1]);
let inflight = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
http.createServer((req, res) => {
  if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
  if (req.url === '/slots') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([{ id: 0, is_processing: inflight > 0 }])); return; }
  let raw = ''; req.on('data', d => raw += d);
  req.on('end', async () => {
    inflight++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\\n\\n');
    const slow = raw.includes('SLOWREPLY');
    for (let i = 0; i < (slow ? 10 : 2); i++) { send({ choices: [{ delta: { content: 'ok ' }, finish_reason: null }] }); if (slow) await sleep(500); }
    send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    res.write('data: [DONE]\\n\\n'); res.end(); inflight--;
  });
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);
fs.chmodSync(FAKE, 0o755);
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  llm: { managed: true, binary: FAKE, port: PORT, profiles: {}, idleUnloadMin: 0.05 },   // 3 seconds
  providers: { custom: [{ id: 'loc', name: 'Local', baseUrl: `http://127.0.0.1:${PORT}/v1`, kind: 'openai', apiKey: '', models: [] }] },
}));

let n = 0;
const cleanup = (code) => {
  try { spawnSync('pkill', ['-f', FAKE]); } catch { }
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(code);
};
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'server', f)).href);

const llmctl = await imp('llmctl.js');
const router = await imp('router.js');
const { streamChat } = await imp('llm.js');
const ask = (ref, text = 'hi') => streamChat({ modelRef: ref, system: 's', messages: [{ role: 'user', text }], maxTokens: 50 });

// 1. nothing starts by itself
llmctl.startIdleWatch();
await sleep(1200);
ok(!llmctl.llmStatus().running, 'boot: llama-server is NOT started on its own');
ok(router.needsBoot('local:fake-a') === true, 'needsBoot: a local model that is not loaded would have to boot');
ok(router.needsBoot('anthropic:claude') === false && router.needsBoot('') === false, 'needsBoot: cloud / empty refs never boot anything');

// 2. first request loads it
const r1 = await ask('local:fake-a');
ok(/ok/.test(r1.text) && llmctl.llmStatus().running, 'first request loads the model on demand and gets an answer');
ok(router.needsBoot('local:fake-a') === false, 'needsBoot: false once it is the model being served');
const st = llmctl.llmStatus();
ok(st.idleUnloadMin === 0.05 && st.idleLeftSec != null && st.idleLeftSec <= 3, `status exposes the idle clock (${st.idleLeftSec}s left)`);

// 3. a request keeps it alive; quiet unloads it
await sleep(2000);
await ask('local:fake-a');               // touches the clock at ~2s
await sleep(2000);                       // 2s since the touch — still inside the 3s window
ok(llmctl.llmStatus().running, 'activity inside the window keeps the model loaded');
ok(await until(() => !llmctl.llmStatus().running, 6000), 'quiet for longer than the window unloads it');

// 4. a generation longer than the window is never unloaded under
const slow = ask('local:fake-a', 'SLOWREPLY please');     // streams for ~5s, window is 3s
await sleep(4200);
ok(llmctl.llmStatus().running, 'mid-generation: still loaded 4s in, past the 3s window');
const rs = await slow;
ok(/ok ok ok/.test(rs.text), 'mid-generation: the long reply completed intact');
ok(await until(() => !llmctl.llmStatus().running, 7000), 'after the long reply finishes, it unloads once idle');

// 5. a ref naming the managed provider directly also loads on demand (not a dead connection)
const r2 = await ask('custom_loc:fake-a');
ok(/ok/.test(r2.text) && llmctl.llmStatus().running, 'direct custom_loc ref after an unload is routed through the on-demand path');

// 6. idleUnloadMin = 0 keeps it loaded
const cfgMod = await imp('config.js');
cfgMod.updateConfig({ llm: { idleUnloadMin: 0 } });
await sleep(4500);
ok(llmctl.llmStatus().running && llmctl.llmStatus().idleLeftSec === null, 'idleUnloadMin 0: stays loaded and reports no countdown');
cfgMod.updateConfig({ llm: { idleUnloadMin: 0.05 } });
ok(await until(() => !llmctl.llmStatus().running, 7000), 'turning it back on resumes unloading');

// 7. finishing a Studio render only releases the GPU claim — it does not reload the model
await ask('local:fake-a');
await llmctl.suspendForGpu();
ok(!llmctl.llmStatus().running && llmctl.llmStatus().suspended !== undefined, 'suspendForGpu stops the server');
const back = await llmctl.resumeAfterGpu({ fallback: 'big', lazy: true });
ok(back.lazy && !llmctl.llmStatus().running && !llmctl.gpuSuspended(), 'lazy resume clears the marker without reloading the model');
const r3 = await ask('local:fake-a');
ok(/ok/.test(r3.text) && llmctl.llmStatus().running, 'and the next request loads it again');

console.log(`\n${n} checks passed`);
await llmctl.stopLlama();
cleanup(0);
