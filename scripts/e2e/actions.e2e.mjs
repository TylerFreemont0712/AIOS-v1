// Confirmable actions: the assistant proposes a write, the user approves, THEN it
// happens.
//
// A scripted mock model plays the part of "I made 50000 through Uber Eats today" and
// the assertions are about the thing that must not happen: the ledger stays empty
// until somebody says yes. Then the ways yes can arrive — the button, an edited
// button, a typed "yes", a spoken one — and the ways it must not fire twice.
//
//   node scripts/e2e/actions.e2e.mjs

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7963, MPORT = 7964;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-actions-'));
const MONTH = new Date().toISOString().slice(0, 7);
const TODAY = new Date().toISOString().slice(0, 10);

let n = 0, failed = 0;
const ok = (c, label) => { n++; if (!c) { failed++; console.error(`✗ ${label}`); } else console.log(`✓ ${label}`); };
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// ---- offline: the decision parser ----
const { readDecision, propose, ACTIONS } = await import(path.join(ROOT, 'server', 'actions.js'));
for (const yes of ['yes', 'Yes.', 'yeah', 'yep', 'sure', 'ok', 'do it', 'go ahead', 'confirm', 'はい', 'お願いします']) {
  if (readDecision(yes) !== 'yes') { failed++; console.error(`✗ decision: "${yes}" should be yes`); }
}
ok(true, 'decision: the ways people say yes (incl. 日本語)');
for (const no of ['no', 'nope', 'cancel', "don't", 'never mind', 'いいえ', 'やめて']) {
  if (readDecision(no) !== 'no') { failed++; console.error(`✗ decision: "${no}" should be no`); }
}
ok(true, 'decision: the ways people say no');
// Ambiguity has to mean "not an answer" — reading a correction as a refusal loses it,
// and reading a fresh question as a yes writes a row nobody asked for.
ok(readDecision('no, wait, make it Tuesday') === '', 'decision: a correction is not a refusal');
ok(readDecision('yes I also spent 300 on coffee') === '', 'decision: a new statement is not a bare yes');
ok(readDecision('') === '' && readDecision('what about tomorrow?') === '', 'decision: anything else is just a message');

// ---- offline: how a proposal reads ----
{
  const p = propose('finance_log', { amount: 50000, kind: 'income', merchant: 'Uber Eats' });
  ok(p.status === 'pending', 'propose: starts pending');
  ok(p.args.date === TODAY, 'propose: fills in today when the model omits the date');
  ok(p.args.currency === 'JPY', 'propose: fills in the base currency');
  ok(/50,000/.test(p.summary) && /Uber Eats/.test(p.summary), `propose: summary reads "${p.summary}"`);
  ok(/50,000 yen/.test(p.spoken) && /Shall I/.test(p.spoken), `propose: spoken reads "${p.spoken}"`);
  ok(p.fields.some(f => f.key === 'amount' && f.type === 'number'), 'propose: amount is an editable number field');
  ok(p.fields.some(f => f.key === 'category' && f.options?.length), 'propose: category offers the real categories');
  const ev = propose('event_add', { title: 'Dentist', date: '2099-03-04', start: '15:00' });
  ok(/3pm/.test(ev.spoken), `propose: 15:00 is spoken as 3pm — "${ev.spoken}"`);
  ok(Object.keys(ACTIONS).length >= 8, `propose: ${Object.keys(ACTIONS).length} confirmable actions registered`);
}

// ---- a scripted model that wants to write things ----
// Chat runs a LEAN LOADOUT: only the core tools are in the schema and everything else
// is behind load_tools. A real model therefore opens with load_tools({groups:['apps']}),
// and a mock that skips that step gets told the tool is not loaded — so every script
// here starts the same way the model actually would.
const LOAD_APPS = { tool: 'load_tools', args: { groups: ['apps'] } };
let script = [];
let turn = 0;
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    // Only a completion advances the script. The shell probes /models on boot (and
    // the model picker re-probes), and a mock that counts those silently eats the
    // scripted tool calls — the turn then answers with the LAST step and the test
    // fails somewhere far away from the cause.
    if (!/completions/.test(req.url || '')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    const step = script[Math.min(turn++, script.length - 1)];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (step?.tool) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + turn, function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
    } else {
      send({ choices: [{ delta: { content: step?.text || 'Done.' }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
mock.listen(MPORT);

// A leftover server from a killed run answers on this port perfectly happily, with
// its own data dir — the assertions then fail in ways that have nothing to do with
// the code. Refuse to start rather than test the wrong process.
try {
  const r = await fetch(BASE + '/status', { signal: AbortSignal.timeout(1500) });
  if (r.ok) {
    console.error(`✗ something is already serving :${PORT} — kill it first (a leftover from an interrupted run)`);
    process.exit(1);
  }
} catch { /* nothing there: good */ }

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, AIOS_DATA: tmpData, AIOS_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let slog = ''; server.stdout.on('data', d => slog += d); server.stderr.on('data', d => slog += d);
function cleanup(code) {
  try { server.kill('SIGKILL'); } catch { }
  try { mock.close(); } catch { }
  fs.rmSync(tmpData, { recursive: true, force: true });
  if (code) console.error('--- server log ---\n' + slog.slice(-3000));
  process.exit(code);
}
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/status')).ok) break; } catch { } await new Promise(r => setTimeout(r, 250)); }

await j('PUT', '/config', {
  providers: { custom: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${MPORT}/v1`, models: ['m1'] }] },
  defaults: { chatModel: 'mock:m1' },
});

/** Send a message over the WS and collect the turn's events. */
async function say(chatId, text) {
  const events = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const t = setTimeout(() => reject(new Error('turn timed out')), 30_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'sub', topic: 'chat:' + chatId }));
      setTimeout(() => ws.send(JSON.stringify({ t: 'chat.send', chatId, text, modelRef: 'mock:m1' })), 120);
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t !== 'chat.event') return;
      events.push(m.ev);
      if (m.ev.type === 'done' || m.ev.type === 'error') { clearTimeout(t); ws.close(); resolve(); }
    });
    ws.on('error', reject);
  });
  return events;
}

const ledger = async () => (await j('GET', '/finance/txns?range=all&limit=100')).data;

// ---- 1. proposed, not written ----
script = [LOAD_APPS, { tool: 'finance_log', args: { amount: 50000, kind: 'income', merchant: 'Uber Eats', category: 'Freelance' } },
{ text: 'I can log 50,000 yen from Uber Eats — confirm below.' }];
turn = 0;
const chat1 = (await j('POST', '/chats', { modelRef: 'mock:m1', tools: true })).data;
const ev1 = await say(chat1.id, 'I made 50000 through Uber Eats today');
const proposed = ev1.find(e => e.type === 'proposal')?.proposal;
ok(!!proposed, 'chat: the write came back as a proposal');
ok(proposed?.tool === 'finance_log' && proposed.args.amount === 50000, 'chat: the proposal carries what the model asked for');
ok((await ledger()).total === 0, 'chat: NOTHING was written to the ledger');
ok(!ev1.some(e => e.type === 'tool.end' && e.name === 'finance_log'), 'chat: the tool never ran');

// ---- 2. confirming does it, once ----
const conf = await j('POST', `/chats/${chat1.id}/actions/${proposed.id}`, { decision: 'confirm' });
ok(conf.data.status === 'confirmed', 'confirm: settles as confirmed');
let led = await ledger();
ok(led.total === 1 && led.items[0].amount === 50000 && led.items[0].kind === 'income', 'confirm: the row is in the ledger');
ok(led.items[0].merchant === 'Uber Eats', 'confirm: with the payer the model heard');
const again = await j('POST', `/chats/${chat1.id}/actions/${proposed.id}`, { decision: 'confirm' });
ok(again.data.status === 'confirmed' && (await ledger()).total === 1, 'confirm: pressing it twice does NOT log it twice');

// ---- 3. it survives a reload ----
const reloaded = (await j('GET', '/chats/' + chat1.id)).data;
const stored = reloaded.messages.flatMap(m => m.proposals || []);
ok(stored.length === 1 && stored[0].status === 'confirmed', 'reload: the card comes back settled, not pending');

// ---- 4. editing before confirming ----
script = [LOAD_APPS, { tool: 'finance_log', args: { amount: 5000, kind: 'expense', merchant: 'Lawson', category: 'Groceries' } }, { text: 'Confirm below.' }];
turn = 0;
const chat2 = (await j('POST', '/chats', { modelRef: 'mock:m1', tools: true })).data;
const p2 = (await say(chat2.id, 'I spent 5000 at Lawson')).find(e => e.type === 'proposal').proposal;
const edited = await j('PATCH', `/chats/${chat2.id}/actions/${p2.id}`, { amount: 5800, merchant: 'Lawson Store 100' });
ok(edited.data.args.amount === 5800, 'edit: the staged amount changed');
ok(/5,800/.test(edited.data.summary), `edit: the summary re-reads "${edited.data.summary}"`);
await j('POST', `/chats/${chat2.id}/actions/${p2.id}`, { decision: 'confirm' });
led = await ledger();
ok(led.items.some(t => t.amount === 5800 && t.merchant === 'Lawson Store 100'), 'edit: the CORRECTED figure is what got written');
ok(!led.items.some(t => t.amount === 5000), 'edit: the original guess never reached the ledger');

// ---- 5. discarding ----
script = [LOAD_APPS, { tool: 'finance_log', args: { amount: 999999, kind: 'expense' } }, { text: 'Confirm below.' }];
turn = 0;
const chat3 = (await j('POST', '/chats', { modelRef: 'mock:m1', tools: true })).data;
const p3 = (await say(chat3.id, 'log a mistake')).find(e => e.type === 'proposal').proposal;
const dis = await j('POST', `/chats/${chat3.id}/actions/${p3.id}`, { decision: 'discard' });
ok(dis.data.status === 'discarded', 'discard: settles as discarded');
ok(!(await ledger()).items.some(t => t.amount === 999999), 'discard: nothing was written');

// ---- 6. saying yes, in words ----
// This is the path a spoken "yes" takes: the transcription is sent as an ordinary
// message and the SERVER recognises it as an answer, so voice needs no parser of its own.
script = [LOAD_APPS, { tool: 'event_add', args: { title: 'Dentist', date: '2099-03-04', start: '15:00' } }, { text: 'Shall I add it?' }];
turn = 0;
const chat4 = (await j('POST', '/chats', { modelRef: 'mock:m1', tools: true })).data;
const p4 = (await say(chat4.id, 'I have a dentist appointment on the 4th of March 2099 at 3pm')).find(e => e.type === 'proposal').proposal;
ok(/Dentist/.test(p4.summary) && /15:00/.test(p4.summary), `voice: the event reads "${p4.summary}"`);
const modelCallsBefore = turn;
const yesEvents = await say(chat4.id, 'yes');
ok(turn === modelCallsBefore, 'voice: a bare "yes" never reaches the model');
const doneText = yesEvents.find(e => e.type === 'done')?.text || '';
ok(/^Done —/.test(doneText), `voice: it answers with what it did — "${doneText}"`);
const cal = (await j('GET', '/planner/events?from=2099-03-01&to=2099-03-31')).data;
ok(Array.isArray(cal) && cal.some(e => e.title === 'Dentist' && e.date === '2099-03-04'), 'voice: the event is in the calendar');

// A second "yes" must not do it again. The staged status lives in the chat file, and
// settleByReply held a copy of that file loaded BEFORE the decision was written —
// saving the assistant reply from the stale copy put the card back to pending.
const yesAgain = await say(chat4.id, 'yes');
const cal2 = (await j('GET', '/planner/events?from=2099-03-01&to=2099-03-31')).data;
ok(cal2.filter(e => e.title === 'Dentist').length === 1, `voice: saying yes twice adds ONE event (${cal2.filter(e => e.title === 'Dentist').length})`);
ok(!/^Done —/.test(yesAgain.find(e => e.type === 'done')?.text || ''), 'voice: the second yes is just a message, not a second confirmation');
const stored4 = (await j('GET', '/chats/' + chat4.id)).data.messages.flatMap(m => m.proposals || []);
ok(stored4[0]?.status === 'confirmed', `voice: the card stays confirmed (${stored4[0]?.status})`);

// ---- 7. saying no ----
script = [LOAD_APPS, { tool: 'task_add', args: { title: 'Something wrong' } }, { text: 'Shall I?' }];
turn = 0;
const chat5 = (await j('POST', '/chats', { modelRef: 'mock:m1', tools: true })).data;
await say(chat5.id, 'remind me to do something');
const noEvents = await say(chat5.id, 'no');
ok(/Discarded/.test(noEvents.find(e => e.type === 'done')?.text || ''), 'voice: "no" discards it');
ok(!(await j('GET', '/planner/tasks')).data.some(t => t.title === 'Something wrong'), 'voice: the task was not added');

// ---- 7b. settling a card while another turn is streaming ----
// The running turn is holding the chat file as it looked when it started; saving that
// copy at the end must not resurrect a card confirmed in the meantime.
script = [LOAD_APPS, { tool: 'finance_log', args: { amount: 777, kind: 'expense', merchant: 'Race' } }, { text: 'Confirm below.' }];
turn = 0;
const chatR = (await j('POST', '/chats', { modelRef: 'mock:m1', tools: true })).data;
const pR = (await say(chatR.id, 'log 777')).find(e => e.type === 'proposal').proposal;
script = [{ text: 'Some other answer entirely.' }];
turn = 0;
// start a second turn, settle the card mid-flight, then let the turn finish
const inFlight = say(chatR.id, 'what is the weather');
await new Promise(r => setTimeout(r, 60));
await j('POST', `/chats/${chatR.id}/actions/${pR.id}`, { decision: 'confirm' });
await inFlight;
const afterRace = (await j('GET', '/chats/' + chatR.id)).data.messages.flatMap(m => m.proposals || []);
ok(afterRace.find(p => p.id === pR.id)?.status === 'confirmed',
  `race: a card settled mid-turn stays settled (${afterRace.find(p => p.id === pR.id)?.status})`);

// ---- 8. the same machinery for the rest of the app ----
script = [LOAD_APPS, { tool: 'finance_budget_set', args: { category: 'Groceries', amount: 45000 } }, { text: 'Confirm below.' }];
turn = 0;
const chat6 = (await j('POST', '/chats', { modelRef: 'mock:m1', tools: true })).data;
const p6 = (await say(chat6.id, 'cap groceries at 45000 a month')).find(e => e.type === 'proposal').proposal;
ok(/Groceries/.test(p6.summary) && /45,000/.test(p6.summary), `budget: reads "${p6.summary}"`);
ok((await j('GET', '/finance/budgets')).data.items.length === 0, 'budget: not set until confirmed');
await j('POST', `/chats/${chat6.id}/actions/${p6.id}`, { decision: 'confirm' });
ok((await j('GET', '/finance/budgets')).data.items.some(b => b.category === 'Groceries' && b.amount === 45000), 'budget: set after confirming');

script = [LOAD_APPS, { tool: 'finance_goal_set', args: { minGoal: 100000, majorGoal: 180000 } }, { text: 'Confirm below.' }];
turn = 0;
const chat7 = (await j('POST', '/chats', { modelRef: 'mock:m1', tools: true })).data;
const p7 = (await say(chat7.id, 'my goal this month is 100000, stretch 180000')).find(e => e.type === 'proposal').proposal;
await j('POST', `/chats/${chat7.id}/actions/${p7.id}`, { decision: 'confirm' });
const goal = (await j('GET', '/finance/goal?month=' + MONTH)).data;
ok(goal.minGoal === 100000 && goal.majorGoal === 180000, 'goal: set through the same confirm step');

// ---- 9. the escape hatch ----
await j('PUT', '/config', { defaults: { confirmActions: false } });
script = [LOAD_APPS, { tool: 'finance_log', args: { amount: 1200, kind: 'expense', merchant: 'Lunch' } }, { text: 'Logged.' }];
turn = 0;
const chat8 = (await j('POST', '/chats', { modelRef: 'mock:m1', tools: true })).data;
const ev8 = await say(chat8.id, 'log 1200 for lunch');
ok(!ev8.some(e => e.type === 'proposal'), 'off: no card when confirmation is turned off');
ok((await ledger()).items.some(t => t.amount === 1200), 'off: the write happens directly, as before');

console.log(failed ? `\n${failed} of ${n} CHECKS FAILED` : `\nALL ${n} ACTION-CONFIRMATION CHECKS PASSED`);
cleanup(failed ? 1 : 0);
