// Every screen of the phone shell at /m, opened and operated in a real browser.
//
// Same reasoning as voice-ui.e2e.mjs, which was written after a rename left a dead
// identifier in a branch that only runs at click time: `npm run check` bundles an
// undefined reference perfectly happily and `node --check` only parses. The phone
// shell is worse in this respect than the desktop, because every screen is a LAZY
// import — a screen with a bad import or a typo'd export does not fail at boot, it
// fails the first time a thumb lands on that tab, which is the one place nobody is
// watching.
//
// So: boot /m at a phone viewport, visit every tab and every More entry, operate the
// controls that do not need a model, and fail on any uncaught exception, console
// error, or red toast.
//
//   node scripts/e2e/mobile-ui.e2e.mjs
//   node scripts/e2e/mobile-ui.e2e.mjs --shots <dir>    also write PNGs of each screen
//
// Skips (exit 0) without Chromium.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7994, CDP = 9390;
const BASE = `http://127.0.0.1:${PORT}/api`;

const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const chromeCandidates = [
  process.env.AIOS_CHROME,
  ...fs.existsSync(path.join(os.homedir(), '.cache/ms-playwright'))
    ? fs.readdirSync(path.join(os.homedir(), '.cache/ms-playwright'))
      .filter(d => d.startsWith('chromium-'))
      .map(d => path.join(os.homedir(), '.cache/ms-playwright', d, 'chrome-linux64', 'chrome'))
    : [],
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
const CHROME = chromeCandidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!CHROME) { console.log('skipped: no Chromium found (set AIOS_CHROME)'); process.exit(0); }

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-mui-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mui-'));

let n = 0, failed = 0;
const ok = (c, label) => { n++; if (!c) { failed++; console.error(`✗ ${label}`); } else console.log(`✓ ${label}`); };

try {
  const r = await fetch(BASE + '/status', { signal: AbortSignal.timeout(1500) });
  if (r.ok) { console.error(`✗ something is already serving :${PORT} — kill it first`); process.exit(1); }
} catch { /* free: good */ }

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, AIOS_DATA: tmpData, AIOS_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let slog = ''; server.stdout.on('data', d => slog += d); server.stderr.on('data', d => slog += d);
let chrome = null;
function cleanup(code) {
  try { chrome?.kill('SIGKILL'); } catch { }
  try { server.kill('SIGKILL'); } catch { }
  fs.rmSync(tmpData, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  if (code) console.error('--- server log ---\n' + slog.slice(-2500));
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => cleanup(1));
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/status')).ok) break; } catch { } await new Promise(r => setTimeout(r, 250)); }

chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-sandbox', '--disable-gpu', '--window-size=390,844',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', () => { });

let targets = null;
for (let i = 0; i < 60; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); if (targets.length) break; } catch { }
  await new Promise(r => setTimeout(r, 250));
}
if (!targets?.length) { console.error('✗ chromium did not start'); cleanup(1); }

const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 1 << 28 });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let id = 0; const waiters = new Map();
const problems = [];
let doing = 'boot';
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    problems.push(`[${doing}] ${d?.exception?.description || d?.text || 'exception'}`.split('\n')[0]);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
    if (!/favicon|manifest|sw\.js|Failed to load resource/i.test(text)) problems.push(`[${doing}] ${text}`.split('\n')[0]);
  }
});
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; waiters.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => {
  const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    const msg = String(r.result.exceptionDetails.exception?.description || 'eval failed').split('\n')[0];
    problems.push(`[${doing}] ${msg}`);
    return null;
  }
  return r.result?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

async function shot(name) {
  if (!SHOTS) return;
  const r = await cmd('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
}

/** Run one interaction under a label, so a failure names the control that caused it. */
async function step(label, expression, settle = 700) {
  doing = label;
  const before = problems.length;
  await evalJs('window.__toastErrors = []');
  await evalJs(expression);
  await wait(settle);
  for (const t of (await evalJs('window.__toastErrors') || [])) problems.push(`[${label}] error toast: ${t}`);
  ok(problems.length === before, `${label}${problems.length > before ? ' — ' + problems[before] : ''}`);
}

await cmd('Page.enable'); await cmd('Runtime.enable');
// A real phone viewport, so the media queries, safe-area insets and dvh units are
// exercised rather than a desktop window pretending.
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await cmd('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});

// ---------------------------------------------------------------- boot

await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/m` });
await wait(3000);

ok(await evalJs(`!!document.querySelector('.m-tabs')`), 'tab bar rendered');
ok((await evalJs(`document.querySelectorAll('.m-tab').length`)) === 5, 'five tabs (4 + More)');
ok(await evalJs(`!!document.querySelector('.m-screen[data-screen=home]')`), 'home screen mounted');

// The redirect a phone actually hits: / must send a mobile UA to /m.
const redirected = await evalJs(`fetch('/', { redirect: 'manual' }).then(r => r.type === 'opaqueredirect' || r.status === 302).catch(() => false)`);
ok(redirected !== false, 'a phone UA at / is redirected to /m');

// Red toasts count as failures — the bug class that prompted voice-ui.e2e.mjs was a
// ReferenceError inside an async handler's own try/catch, which never reaches
// window.onerror. On this shell toasts go to <body>, not a container.
await evalJs(`(() => {
  window.__toastErrors = [];
  new MutationObserver((muts) => {
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.nodeType === 1 && node.classList?.contains('m-toast') && node.classList.contains('is-err')) {
        window.__toastErrors.push(node.textContent);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  return true;
})()`);

const tapTab = (name) => `[...document.querySelectorAll('.m-tab')].find(b => b.getAttribute('aria-label') === '${name}')?.click()`;
const screenIs = (id) => evalJs(`!!document.querySelector('.m-screen[data-screen=${id}]')`);

await shot('01-home');
ok(await evalJs(`!!document.querySelector('.m-hero-greet')`), 'home greets by time of day');
ok(await evalJs(`!!document.querySelector('.m-quick-grid')`), 'home shows quick actions');

// ---------------------------------------------------------------- tabs

await step('open Chat', tapTab('Chat'), 1800);
ok(await screenIs('chat'), 'chat screen mounted');
ok(await evalJs(`!!document.querySelector('.m-compose-input')`), 'chat has a composer');
// 16px minimum is the thing that stops iOS zooming the page on focus; a regression
// here is invisible on a desktop and miserable on a phone.
const composeSize = await evalJs(`parseFloat(getComputedStyle(document.querySelector('.m-compose-input')).fontSize)`);
ok(composeSize >= 16, `composer font is ${composeSize}px (>= 16 so iOS will not zoom)`);
// The mic button must be visible EXACTLY when a microphone can actually be opened.
// Asserting "hidden on http" would be wrong here: browsers treat 127.0.0.1 as a
// secure context, so getUserMedia does exist in this run. The invariant is what
// matters — the button is never shown when pressing it could only throw.
const mic = await evalJs(`(() => {
  const btn = document.querySelector('.m-compose-btn[aria-label=Dictate]');
  return {
    visible: getComputedStyle(btn).display !== 'none',
    available: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder),
    secure: window.isSecureContext,
  };
})()`);
ok(mic && mic.visible === mic.available,
  `mic button shown iff usable (secure=${mic?.secure}, available=${mic?.available}, visible=${mic?.visible})`);
await shot('02-chat');

await step('type into the composer', `(() => {
  const i = document.querySelector('.m-compose-input');
  i.value = 'hello'; i.dispatchEvent(new Event('input', { bubbles: true }));
})()`, 300);

await step('open the chats sheet', `document.querySelector('.m-head-btn[aria-label=Chats]')?.click()`, 900);
ok(await evalJs(`!!document.querySelector('.m-sheet')`), 'chats sheet opened');
await step('close the sheet', `document.querySelector('.m-sheet-wrap')?.click()`, 500);

await step('open the model picker', `document.querySelector('.m-head-btn[aria-label=Model]')?.click()`, 800);
await step('close the model picker', `document.querySelector('.m-sheet-wrap')?.click()`, 500);

await step('open Money', tapTab('Money'), 1800);
ok(await screenIs('money'), 'money screen mounted');
ok(await evalJs(`!!document.querySelector('.m-capture')`), 'capture view mounted inside Money');
await shot('03-money-capture');

await step('Money → Recent', `[...document.querySelectorAll('.m-seg-b')].find(b => b.textContent === 'Recent')?.click()`, 1600);
ok(await evalJs(`!!document.querySelector('.m-stats')`), 'recent shows the month summary');
await shot('04-money-recent');

await step('Money → Log', `[...document.querySelectorAll('.m-seg-b')].find(b => b.textContent === 'Log')?.click()`, 1600);
ok(await evalJs(`!!document.querySelector('.m-amount')`), 'log view has an amount field');
await step('toggle Log to Income', `[...document.querySelectorAll('.m-seg-sm .m-seg-b')].find(b => b.textContent === 'Income')?.click()`, 400);
// The label has to follow the toggle — a frozen "Merchant" over a payer field is a
// small lie that makes the form untrustworthy.
const payerLabel = await evalJs(`[...document.querySelectorAll('.m-field-l')].some(l => l.textContent === 'Payer')`);
ok(payerLabel === true, 'Merchant relabels to Payer for income');
await shot('05-money-log');

await step('log a transaction', `(() => {
  document.querySelector('.m-amount').value = '1234';
  [...document.querySelectorAll('.m-btn-big')].find(b => b.textContent === 'Log it')?.click();
})()`, 1800);
const logged = await evalJs(`fetch('/api/finance/txns?limit=5').then(r => r.json()).then(j => j.items.length)`);
ok(logged >= 1, `transaction landed in the ledger (${logged} row${logged === 1 ? '' : 's'})`);

await step('open Tasks', tapTab('Tasks'), 1600);
ok(await screenIs('tasks'), 'tasks screen mounted');
await shot('06-tasks');
await step('Tasks → All', `[...document.querySelectorAll('.m-seg-b')].find(b => b.textContent === 'All tasks')?.click()`, 700);
await step('Tasks → Today', `[...document.querySelectorAll('.m-seg-b')].find(b => b.textContent === 'Today')?.click()`, 700);

// Adding a task exercises the ask-sheet, the POST and the reload in one path.
await step('add a task', `document.querySelector('.m-head-btn[aria-label="New task"]')?.click()`, 700);
await step('type the task title', `(() => {
  const i = document.querySelector('.m-sheet .m-input');
  i.value = 'Buy milk';
  [...document.querySelectorAll('.m-sheet .m-btn')].find(b => b.textContent === 'Add')?.click();
})()`, 1600);
const tasks = await evalJs(`fetch('/api/planner/tasks').then(r => r.json()).then(t => t.length)`);
ok(tasks >= 1, `task was created (${tasks})`);
ok(await evalJs(`[...document.querySelectorAll('.m-row-t')].some(e => e.textContent === 'Buy milk')`), 'new task appears on Today');

await step('tick the task', `document.querySelector('.m-tick')?.click()`, 1400);
const done = await evalJs(`fetch('/api/planner/tasks').then(r => r.json()).then(t => t.filter(x => x.done).length)`);
ok(done >= 1, 'ticking a task persists');

// ---------------------------------------------------------------- More

await step('open More', tapTab('More'), 800);
ok(await evalJs(`!!document.querySelector('.m-menu')`), 'More sheet lists the secondary screens');
await shot('07-more');

const openMore = (title) => `[...document.querySelectorAll('.m-menu-row')].find(r => r.textContent.includes('${title}'))?.click()`;

await step('open Notes', openMore('Notes'), 1800);
ok(await screenIs('notes'), 'notes screen mounted');
ok(await evalJs(`!!document.querySelector('.m-search')`), 'notes has a search field');
await shot('08-notes');
await step('search notes', `(() => {
  const i = document.querySelector('.m-search');
  i.value = 'test'; i.dispatchEvent(new Event('input', { bubbles: true }));
})()`, 1200);

await step('back to More', tapTab('More'), 700);
// A fresh data dir has no registered projects, so Files would legitimately show its
// empty state and prove nothing. Register one first.
await evalJs(`fetch('/api/projects/register', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: ${JSON.stringify(ROOT)} }),
}).then(r => r.ok)`);
await step('open Files', openMore('Files'), 2000);
ok(await screenIs('files'), 'files screen mounted');
ok(await evalJs(`document.querySelectorAll('.m-row').length > 0`), 'files lists a directory');
await shot('09-files');
await step('open a folder', `[...document.querySelectorAll('.m-row')].find(r => r.querySelector('.m-row-chev'))?.click()`, 1200);
await step('go up', `document.querySelector('.m-head-btn[aria-label=Up]')?.click()`, 1000);

await step('back to More', tapTab('More'), 700);
await step('open Agent', openMore('Agent'), 1600);
ok(await screenIs('agent'), 'agent screen mounted');
await shot('10-agent');

await step('back to More', tapTab('More'), 700);
await step('open Terminal', openMore('Terminal'), 2200);
ok(await screenIs('terminal'), 'terminal screen mounted');
ok(await evalJs(`document.querySelectorAll('.m-key').length > 6`), 'terminal offers the keys a phone keyboard lacks');
await shot('11-terminal');
await step('run a command', `(() => {
  const i = document.querySelector('.m-term-input');
  i.value = 'echo aios-mobile-ok';
  document.querySelector('.m-send[aria-label=Run]')?.click();
})()`, 2500);
const termSaw = await evalJs(`document.querySelector('.m-term-out')?.textContent.includes('aios-mobile-ok')`);
ok(termSaw === true, 'the shell ran a command and the output came back');

await step('back to More', tapTab('More'), 700);
await step('open Settings', openMore('Settings'), 2200);
ok(await screenIs('settings'), 'settings screen mounted');
ok(await evalJs(`[...document.querySelectorAll('.m-section-title')].some(t => t.textContent === 'Away from home')`),
  'settings leads with remote access');
// The consequence of no HTTPS has to be spelled out, not just flagged.
ok(await evalJs(`document.body.textContent.includes('microphone')`), 'settings explains what HTTPS buys');
ok(await evalJs(`!!document.querySelector('.m-themes')`), 'settings offers themes');
await shot('12-settings');

await step('switch theme to dark', `document.querySelector('.m-theme[data-theme=dark]')?.click()`, 1200);
ok((await evalJs(`document.documentElement.dataset.mode`)) === 'dark', 'theme switch applied');
await step('switch theme back to system', `document.querySelector('.m-theme[data-theme=system]')?.click()`, 1200);

// ---------------------------------------------------------------- QR, in the browser
// The encoder is unit-checked by scripts/qr-check.mjs; this proves it also runs in a
// browser and produces a populated <svg> rather than throwing on some DOM assumption.
const qr = await evalJs(`import('/js/mobile/qr.js').then(m => {
  const s = m.qrSvg('https://box.tail1234.ts.net/m/?token=abc123');
  return { ok: s.startsWith('<svg '), len: s.length, paths: (s.match(/M/g) || []).length };
})`);
ok(qr?.ok && qr.len > 500 && qr.paths > 100, `QR renders in-browser (${qr?.len} bytes, ${qr?.paths} modules)`);

// ---------------------------------------------------------------- navigation

await step('back to Home', tapTab('Home'), 1400);
ok(await screenIs('home'), 'home remounts');
// Deep links are what the PWA shortcuts and the pairing link rely on.
await step('deep link to #money?view=log', `location.hash = 'money?view=log'; dispatchEvent(new PopStateEvent('popstate'))`, 1800);
ok(await screenIs('money'), 'hash routing lands on the right screen');

ok(problems.length === 0, problems.length ? `no console errors — found ${problems.length}` : 'no console errors or exceptions');
for (const p of problems.slice(0, 25)) console.error('   ' + p);

console.log(`\n${n - failed}/${n} checks passed`);
if (SHOTS) console.log(`screenshots in ${SHOTS}`);
cleanup(failed ? 1 : 0);
