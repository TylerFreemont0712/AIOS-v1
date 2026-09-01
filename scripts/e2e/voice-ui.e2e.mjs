// Every voice control, clicked, in a real browser.
//
// This suite exists because of a bug that shipped: a rename left one identifier
// behind in a branch that only runs at click time ("v is not defined"), and NOTHING
// caught it — esbuild bundles undefined references perfectly happily, `node --check`
// only parses, and the other voice suites drive the API rather than the UI. The only
// thing that finds a mistake like that is pressing the button.
//
// So: open Settings → Voice and Voice mode, operate every control there is, and fail
// on any uncaught exception or console error. It is deliberately exhaustive rather
// than clever — the point is coverage of click paths, not assertions about pixels.
//
//   node scripts/e2e/voice-ui.e2e.mjs
//
// Skips (exit 0) without Chromium or without the speech models installed.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7995, CDP = 9391;
const BASE = `http://127.0.0.1:${PORT}/api`;

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

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-vui-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-vui-'));

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
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/status')).ok) break; } catch { } await new Promise(r => setTimeout(r, 250)); }

const st = await (await fetch(BASE + '/voice/status')).json();
if (!st.installed) { console.log(`skipped: speech models not installed at ${st.home}`); cleanup(0); }

chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-sandbox', '--disable-gpu', '--window-size=1440,960',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
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
// Every uncaught error and console error, with the label of whatever we were doing
// at the time — a stack trace on its own does not say which button caused it.
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
/**
 * Run one interaction under a label, so a failure names the control that caused it.
 * `allowError` is for the handful of steps whose error toast is the correct outcome
 * (saving a transcript with no vault connected, on a throwaway data dir).
 */
async function step(label, expression, settle = 500, { allowError = false } = {}) {
  doing = label;
  const before = problems.length;
  await evalJs('window.__toastErrors = []');
  await evalJs(expression);
  await wait(settle);
  const toasts = (await evalJs('window.__toastErrors') || []);
  if (!allowError) for (const t of toasts) problems.push(`[${label}] error toast: ${t}`);
  ok(problems.length === before, `${label}${problems.length > before ? ' — ' + problems[before] : ''}`);
}

await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await wait(3500);
ok(await evalJs('!!window.aios'), 'shell booted');

// ERROR TOASTS COUNT AS FAILURES, and this is the whole point of the suite.
// The bug that prompted it was a ReferenceError thrown inside an async handler's own
// try/catch — so it never reached window.onerror or the console, it just became a red
// toast saying "v is not defined". Watching only for exceptions missed it completely.
await evalJs(`(() => {
  window.__toastErrors = [];
  // Toasts are appended to #toasts, not to body — watching body without subtree sees
  // nothing at all, which is how the first version of this guard passed a run that
  // was throwing on every click.
  const host = document.getElementById('toasts') || document.body;
  new MutationObserver((muts) => {
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.nodeType === 1 && node.classList?.contains('toast') && node.classList.contains('err')) {
        window.__toastErrors.push(node.textContent);
      }
    }
  }).observe(host, { childList: true, subtree: true });
  return !!document.getElementById('toasts');
})()`);

// ---------------------------------------------------------------- Settings → Voice
await step('open Settings → Voice', `window.aios.open('settings', { tab: 'voice' })`, 1200);
await step('select the Voice tab',
  `[...document.querySelectorAll('.set-nav .side-item')].find(x => x.textContent.includes('Voice'))?.click()`, 2500);

const panel = await evalJs(`(() => {
  const p = document.querySelector('.set-panel');
  return { h2: p.querySelector('h2')?.textContent, rows: p.querySelectorAll('.set-row').length,
    chips: p.querySelectorAll('.voice-chip').length, selects: p.querySelectorAll('select').length,
    ranges: p.querySelectorAll('input[type=range]').length, switches: p.querySelectorAll('.switch').length };
})()`);
ok(panel?.h2 === 'Voice', 'the Voice panel rendered');
ok(panel?.chips >= 8, `voice shortlist rendered (${panel?.chips} chips)`);
ok(panel?.ranges >= 3, `rate / blend / pitch sliders present (${panel?.ranges})`);

// THE BUG THIS SUITE EXISTS FOR: previewing a voice only fails at click time.
await step('preview the current voice',
  `document.querySelector('.set-row .btn') && [...document.querySelectorAll('.set-panel button')].find(b => b.textContent.includes('Preview')).click()`, 3000);

// Every shortlist chip — each one selects, saves and previews.
const chipCount = Math.min(panel?.chips || 0, 13);
for (let i = 0; i < chipCount; i++) {
  const name = await evalJs(`document.querySelectorAll('.voice-chip')[${i}]?.querySelector('.voice-chip-name')?.textContent`);
  await step(`pick voice: ${name}`, `document.querySelectorAll('.voice-chip')[${i}].click()`, 2200);
}

await step('change the full-voice dropdown', `(() => {
  const sels = [...document.querySelectorAll('.set-panel select')];
  const s = sels.find(x => x.options.length > 20);
  s.value = s.options[3].value; s.dispatchEvent(new Event('change', { bubbles: true }));
})()`, 2500);

await step('set a blend partner', `(() => {
  const sels = [...document.querySelectorAll('.set-panel select')];
  const s = sels.find(x => [...x.options].some(o => o.textContent.includes('None — single voice')));
  s.value = [...s.options].filter(o => o.value)[2].value; s.dispatchEvent(new Event('change', { bubbles: true }));
})()`, 2800);
await step('move the blend slider', `(() => {
  const r = [...document.querySelectorAll('.set-panel input[type=range]')];
  const b = r[1]; b.value = '0.3';
  b.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new Event('change', { bubbles: true }));
})()`, 2800);
await step('move the pitch slider', `(() => {
  const r = [...document.querySelectorAll('.set-panel input[type=range]')];
  const p = r[r.length - 1]; p.value = '0.88';
  p.dispatchEvent(new Event('input', { bubbles: true })); p.dispatchEvent(new Event('change', { bubbles: true }));
})()`, 2800);
await step('move the speaking-rate slider', `(() => {
  const r = [...document.querySelectorAll('.set-panel input[type=range]')][0];
  r.value = '1.1'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true }));
})()`, 1200);
await step('clear the blend back to a single voice', `(() => {
  const sels = [...document.querySelectorAll('.set-panel select')];
  const s = sels.find(x => [...x.options].some(o => o.textContent.includes('None — single voice')));
  s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true }));
})()`, 2500);

await step('change the speech model', `(() => {
  const s = [...document.querySelectorAll('.set-panel select')].find(x => [...x.options].some(o => o.value === 'base'));
  s.value = 'base'; s.dispatchEvent(new Event('change', { bubbles: true }));
})()`, 900);
await step('pin the spoken language', `(() => {
  const s = [...document.querySelectorAll('.set-panel select')].find(x => [...x.options].some(o => o.value === 'ja'));
  s.value = 'ja'; s.dispatchEvent(new Event('change', { bubbles: true }));
})()`, 900);
await step('edit + save the vocabulary', `(() => {
  const ta = document.querySelector('.set-panel textarea'); ta.value = 'Micro1, Outlier, Kusuri no Aoki';
  [...document.querySelectorAll('.set-panel .btn')].find(b => b.textContent.trim() === 'Save').click();
})()`, 1500);

for (const mode of ['Always', 'Never', 'When I ask']) {
  await step(`spoken replies: ${mode}`,
    `[...document.querySelectorAll('.set-panel .seg-btn')].find(b => b.textContent.includes(${JSON.stringify(mode)}))?.click()`, 900);
}
await step('toggle every device switch', `(() => {
  document.querySelectorAll('.set-panel .switch').forEach((s, i) => { if (i > 0) s.click(); });
})()`, 1200);
await step('set the idle-unload minutes', `(() => {
  const i = document.querySelector('.set-panel input[type=number]'); i.value = '5';
  i.dispatchEvent(new Event('change', { bubbles: true }));
})()`, 900);
await step('load the models now',
  `[...document.querySelectorAll('.set-panel .btn')].find(b => b.textContent.includes('Load now'))?.click()`, 4000);
await step('unload the models',
  `[...document.querySelectorAll('.set-panel .btn')].find(b => b.textContent.includes('Unload'))?.click()`, 1500);
await step('toggle voice off and on again', `(() => {
  const s = document.querySelector('.set-panel .switch'); s.click(); setTimeout(() => document.querySelector('.set-panel .switch')?.click(), 300);
})()`, 2000);

// ------------------------------------------------------------------------ the Chat
await step('open Chat', `window.aios.open('chat')`, 1500);
await step('open the header voice menu', `document.querySelector('.pane-head .speak-toggle').click()`, 700);
const menuItems = await evalJs(`[...document.querySelectorAll('.ctx-menu .ctx-item')].map(b => b.querySelector('.ctx-label')?.textContent)`);
ok((menuItems || []).length >= 5, `voice menu has its entries (${(menuItems || []).join(', ')})`);
for (const label of ['Always on', 'Muted', 'On click']) {
  await step(`chat voice menu: ${label}`, `(() => {
    document.querySelector('.pane-head .speak-toggle').click();
    setTimeout(() => [...document.querySelectorAll('.ctx-menu .ctx-item')].find(b => b.textContent.includes(${JSON.stringify(label)}))?.click(), 120);
  })()`, 900);
}
await step('chat voice menu → Voice settings', `(() => {
  document.querySelector('.pane-head .speak-toggle').click();
  setTimeout(() => [...document.querySelectorAll('.ctx-menu .ctx-item')].find(b => b.textContent.includes('Voice settings'))?.click(), 120);
})()`, 1500);
await step('back to Chat', `window.aios.open('chat')`, 1200);
await step('composer mic: start dictating', `document.querySelector('.composer-row .mic-btn').click()`, 1500);
await step('composer mic: stop dictating', `document.querySelector('.composer-row .mic-btn').click()`, 3500);

// ------------------------------------------------------------------- Voice mode
await evalJs(`localStorage.setItem('aios.voice.prefs', JSON.stringify({ handsFree: false, speech: 'auto', cues: true }))`);
await step('open Voice mode', `import('/js/voicemode.js').then(m => m.openVoiceMode())`, 2500);
ok(await evalJs(`!!document.querySelector('.vm-overlay .vm-canvas')`), 'voice mode: the HUD canvas is there');

for (const [label, expr, opts] of [
  ['orb tap (start listening)', `document.querySelector('.vm-orb').click()`],
  ['orb tap (stop listening)', `document.querySelector('.vm-orb').click()`],
  ['Pause', `[...document.querySelectorAll('.vm-actions button')].find(b => /Pause/.test(b.textContent)).click()`],
  ['Resume', `[...document.querySelectorAll('.vm-actions button')].find(b => /Resume/.test(b.textContent)).click()`],
  ['Repeat (nothing to repeat yet)', `[...document.querySelectorAll('.vm-actions button')].find(b => /Repeat/.test(b.textContent)).click()`],
  ['Save (nothing said yet)', `[...document.querySelectorAll('.vm-actions button')].find(b => /Save/.test(b.textContent)).click()`, { allowError: true }],
  ['hands-free toggle', `[...document.querySelectorAll('.vm-head .btn')].find(b => /Hands-free/.test(b.textContent)).click()`],
  // By text, not by index: the header grew a Mode button, and an index-based selector
  // quietly started clicking hands-free twice instead of failing.
  ['mute toggle', `[...document.querySelectorAll('.vm-head .btn')].find(b => /Voice|Muted/.test(b.textContent)).click()`],
  ['jump-to-latest', `document.querySelector('.vm-jump').click()`],
]) await step('voice mode: ' + label, expr, 1400, opts);

for (const key of ['m', 'h', 'r', 'p', 'p']) {
  await step(`voice mode: key "${key}"`,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`, 900);
}
await step('voice mode: Space', `document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))`, 1500);

// ------------------------------------------------------------------ interview mode
//
// The setup dialog is the one screen in the overlay that is a FORM, so every control
// on it is a click path that only exists at click time. The AI is put on the answering
// side deliberately: an interviewer opens by asking a question, which needs a model,
// and this suite runs on a throwaway data dir with no provider configured.
await step('voice mode: key "i" opens the setup', `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }))`, 1200);
ok(await evalJs(`!!document.querySelector('.iv-setup')`), 'interview: the setup dialog rendered');

await step('interview: choose Interview mode',
  `[...document.querySelectorAll('.iv-setup .seg-btn')].find(b => b.textContent.trim() === 'Interview').click()`, 500);
ok(await evalJs(`[...document.querySelectorAll('.iv-setup .set-name')].some(n => n.textContent === 'Which side')`),
  'interview: the role row appeared with the mode');

await step('interview: the AI answers me',
  `[...document.querySelectorAll('.iv-setup .seg-btn')].find(b => /AI answers me/.test(b.textContent)).click()`, 500);
await step('interview: pick a suggested role',
  `document.querySelector('.iv-picks .chip').click()`, 400);
await step('interview: set the level and focus', `(() => {
  const sels = [...document.querySelectorAll('.iv-setup select')];
  const lv = sels.find(s => [...s.options].some(o => o.value === 'senior'));
  lv.value = 'senior'; lv.dispatchEvent(new Event('change', { bubbles: true }));
  const fs = [...document.querySelectorAll('.iv-setup select')].find(s => [...s.options].some(o => o.value === 'systems'));
  fs.value = 'systems'; fs.dispatchEvent(new Event('change', { bubbles: true }));
})()`, 600);
await step('interview: set the answer style', `(() => {
  const s = [...document.querySelectorAll('.iv-setup select')].find(x => [...x.options].some(o => o.value === 'socratic'));
  s.value = 'socratic'; s.dispatchEvent(new Event('change', { bubbles: true }));
})()`, 600);
await step('interview: type extra instructions',
  `(() => { const t = document.querySelector('.iv-setup textarea'); t.value = 'push me on complexity'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`, 400);
await step('interview: toggle the lookup switch',
  `document.querySelector('.iv-setup .switch').click()`, 500);
await step('interview: start the session',
  `[...document.querySelectorAll('.modal-actions .btn')].find(b => /Start|Apply/.test(b.textContent)).click()`, 2000);

ok(await evalJs(`document.querySelector('.vm-overlay')?.dataset.mode === 'interview'`), 'interview: the overlay is in interview mode');
ok(await evalJs(`/AI answers/.test([...document.querySelectorAll('.vm-head .btn')].map(b => b.textContent).join(' '))`),
  'interview: the header says which side the AI is on');

await step('interview: reopen the setup and cancel with Esc', `(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
  setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 600);
})()`, 1600);
ok(await evalJs(`!document.querySelector('.iv-setup') && !!document.querySelector('.vm-overlay')`),
  'interview: Esc closed the dialog and left the session open');

await step('interview: Keep with nothing said',
  `document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }))`, 800);

// A kept answer, straight through the same module the overlay uses — the transcript
// cannot produce one here without a model, and the app below has to have something
// to render.
const kept = await evalJs(`import('/js/interview.js').then(m => m.saveAnswer({
  question: 'What breaks first at ten times the load?',
  answer: 'The write path. **Specifically** the single primary — reads fan out to replicas, writes do not.',
  topic: 'Backend engineer — Node, Postgres', focus: 'systems', level: 'senior',
})).then(a => !!a.id, e => 'ERR ' + e.message)`);
ok(kept === true, `interview: an answer can be kept (${kept})`);

await step('voice mode: Esc closes', `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`, 900);
ok(await evalJs(`!document.querySelector('.vm-overlay')`), 'voice mode: closed cleanly');
ok(await evalJs(`(async () => { const v = await import('/js/voice.js'); return !v.isSpeaking(); })()`), 'voice mode: nothing left talking');

// ------------------------------------------------------------------ the answer bank
await step('open the Interview app', `window.aios.open('interview')`, 1800);
ok(await evalJs(`document.querySelectorAll('.iv-card').length === 1`), 'bank: the kept answer is listed');
ok(await evalJs(`!!document.querySelector('.side-list .side-item')`), 'bank: the topic rail rendered');

await step('bank: reveal the answer',
  `[...document.querySelectorAll('.iv-actions .btn')].find(b => /Show answer/.test(b.textContent)).click()`, 700);
ok(await evalJs(`!!document.querySelector('.iv-card .iv-a .md')`), 'bank: the answer renders as markdown');
await step('bank: write a note',
  `(() => { const t = document.querySelector('.iv-note'); t.value = 'say the replica lag number'; t.dispatchEvent(new Event('change', { bubbles: true })); })()`, 900);
await step('bank: listen to it',
  `[...document.querySelectorAll('.iv-actions .btn')].find(b => /Listen/.test(b.textContent)).click()`, 2500);
await step('bank: filter by topic', `document.querySelectorAll('.side-list .side-item')[1].click()`, 900);
await step('bank: search', `(() => {
  const s = document.querySelector('.pane-head input[type=search]');
  s.value = 'nothing matches this'; s.dispatchEvent(new Event('input', { bubbles: true }));
})()`, 900);
ok(await evalJs(`!!document.querySelector('.iv-list .empty')`), 'bank: an empty search says so');
await step('bank: clear the search', `(() => {
  const s = document.querySelector('.pane-head input[type=search]');
  s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
})()`, 900);
await step('bank: open the new-session dialog',
  `[...document.querySelectorAll('.pane-head .btn')].find(b => /New session/.test(b.textContent)).click()`, 1500);
ok(await evalJs(`!!document.querySelector('.iv-setup')`), 'bank: the same setup dialog opens from the app');
await step('bank: dismiss the dialog', `document.querySelector('.modal-actions .btn').click()`, 800);
await step('bank: hide the answer again',
  `[...document.querySelectorAll('.iv-actions .btn')].find(b => /Hide/.test(b.textContent))?.click()`, 700);
await step('bank: delete the answer', `(() => {
  [...document.querySelectorAll('.iv-actions .btn')].pop().click();
  setTimeout(() => [...document.querySelectorAll('.modal-actions .btn')].find(b => /Delete/.test(b.textContent)).click(), 400);
})()`, 1600);
ok(await evalJs(`!document.querySelectorAll('.iv-card').length`), 'bank: the answer is gone');
ok(await evalJs(`(async () => { const v = await import('/js/voice.js'); v.stopSpeaking(); return true; })()`), 'bank: playback stopped');

if (problems.length) {
  console.error(`\n${problems.length} runtime problem(s):`);
  for (const p of [...new Set(problems)]) console.error('  ' + p);
  failed++;
}
console.log(failed ? `\n${failed} of ${n} CHECKS FAILED` : `\nALL ${n} VOICE-UI CHECKS PASSED`);
cleanup(failed ? 1 : 0);
