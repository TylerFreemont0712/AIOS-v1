// AIOS server: static shell + REST API + one WebSocket for streams
// (chat, agent events, approvals, terminals, vault AI). Binds 0.0.0.0 so every
// machine on the LAN can use it; non-localhost requests need the token by default.

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, DATA, loadConfig, publicConfig, updateConfig } from './config.js';
import { listModels, probeProviders } from './llm.js';
import { toolCatalog, searxngStatus, runTool } from './tools.js';
import { probeServices, registerService } from './services.js';
import * as projects from './projects.js';
import * as files from './files.js';
import * as agent from './agent.js';
import * as chat from './chat.js';
import * as profile from './profile.js';
import * as uploads from './uploads.js';
import * as vault from './vault.js';
import * as wiki from './wiki.js';
import * as forge from './toolforge.js';
import * as mcp from './mcp.js';
import * as learn from './learn.js';
import * as term from './terminal.js';
import * as research from './research.js';
import * as mail from './mail.js';
import * as notify from './notify.js';
import * as planner from './planner.js';
import * as weather from './weather.js';
import * as git from './git.js';
import * as github from './github.js';
import * as comfy from './comfy.js';
import * as llmctl from './llmctl.js';
import * as bench from './bench.js';
import * as router from './router.js';
import * as finance from './finance.js';
import * as receipts from './receipts.js';
import * as financeai from './financeai.js';
import * as items from './items.js';
import { gpuStats } from './gpu.js';

const cfg = loadConfig();
fs.mkdirSync(DATA, { recursive: true });

const app = express();
app.disable('x-powered-by');
// Body parsing is mounted on /api only. Nothing outside it posts a body, and running a
// 60MB-capable parser in front of every stylesheet request is pure overhead.
//
// The limit is generous for one legacy reason: attachments used to arrive base64-encoded
// inside JSON, which inflates a 4MB photo into a 5MB string that then has to be parsed
// AND decoded — measured at ~50MB of heap churn per upload and 3x slower than handling
// the bytes directly. /api/uploads/raw does it directly; this path stays for any client
// still running a cached older bundle (the phone PWA caches aggressively).
app.use('/api', express.json({ limit: '60mb' }));

// ---------- auth ----------

function authorized(req) {
  const c = loadConfig();
  if (c.auth.required === 'never') return true;
  const ip = req.socket?.remoteAddress || '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (c.auth.required === 'lan' && local) return true;
  const url = new URL(req.url, 'http://x');
  const token = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  return token.length > 0 && token === c.auth.token;
}

app.use('/api', (req, res, next) => authorized(req) ? next() : res.status(401).json({ error: 'unauthorized' }));

const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
    else if (!res.headersSent) res.json({ ok: true });
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  }
};

// ---------- core ----------

app.get('/api/auth/check', h(() => ({ ok: true })));
app.get('/api/status', h(async () => ({
  name: 'AIOS', version: '0.1.0', node: process.version, platform: `${os.platform()} ${os.release()}`,
  host: os.hostname(), uptime: Math.round(process.uptime()),
  dataDir: DATA, providers: await probeProviders(), urls: lanUrls(),
})));
app.get('/api/config', h(() => publicConfig()));
app.put('/api/config', h(req => updateConfig(req.body || {})));
app.get('/api/config/token', h((req) => {
  // only reveal the pairing token to localhost callers
  const ip = req.socket?.remoteAddress || '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!local) throw Object.assign(new Error('token is only shown on localhost'), { status: 403 });
  return { token: loadConfig().auth.token, urls: lanUrls(true) };
}));
app.get('/api/models', h(() => listModels()));
app.get('/api/services', h(() => probeServices()));

// ---------- tools ----------

app.get('/api/tools', h(async () => ({ tools: toolCatalog(), searxng: await searxngStatus() })));
app.delete('/api/tools/custom/:name', h(req => { forge.deleteCustomTool(req.params.name); }));
app.post('/api/tools/test-search', h(async req => {
  const r = await runTool('web_search', { query: req.body?.query || 'searxng json api', max_results: 5 }, { root: DATA });
  return { ok: !r.isError, output: r.content };
}));

// ---------- MCP servers ----------
//
// Saving a server does NOT connect it — connecting spawns someone else's process, so it
// is always an explicit act (the Connect button, or boot for enabled servers).

app.get('/api/mcp', h(() => ({ servers: mcp.status(), presets: mcp.PRESETS })));
app.post('/api/mcp/servers', h(req => mcp.saveServer(req.body || {})));
app.delete('/api/mcp/servers/:id', h(req => { mcp.removeServer(req.params.id); }));
app.post('/api/mcp/servers/:id/connect', h(async req => {
  await mcp.connect(req.params.id, { force: true });
  return mcp.status().find(s => s.id === req.params.id);
}));
app.post('/api/mcp/servers/:id/disconnect', h(req => {
  mcp.stop(req.params.id);
  return mcp.status().find(s => s.id === req.params.id);
}));
// Call one tool by hand — the only way to tell "the server connected" from "the server
// actually works" without sending an agent at it.
app.post('/api/mcp/servers/:id/call', h(async req => {
  const out = await mcp.callTool(String(req.body?.tool || ''), req.body?.args || {});
  return { output: out };
}));

// ---------- projects ----------

app.get('/api/projects', h(() => projects.listProjects()));
app.post('/api/projects', h(req => projects.createProject(req.body || {})));
app.post('/api/projects/register', h(req => projects.registerProject(req.body || {})));
app.patch('/api/projects/:id', h(req => projects.updateProject(req.params.id, req.body || {})));
app.delete('/api/projects/:id', h(req => { projects.removeProject(req.params.id); }));

// project git: status for the composer chip, init, and one-click commits
const projRoot = (id) => {
  const p = projects.getProject(id);
  if (!p) throw Object.assign(new Error('unknown project'), { status: 404 });
  return p.path;
};
app.get('/api/projects/:id/git', h(req => git.gitInfo(projRoot(req.params.id))));
app.get('/api/projects/:id/git/diff', h(req => git.workingDiff(projRoot(req.params.id))));
app.post('/api/projects/:id/git/init', h(req => git.gitInit(projRoot(req.params.id))));
app.post('/api/projects/:id/git/message', h(req => git.commitMessage(projRoot(req.params.id), { modelRef: req.body?.modelRef })));
app.post('/api/projects/:id/git/commit', h(req => git.gitCommit(projRoot(req.params.id), { message: req.body?.message })));
app.post('/api/projects/:id/git/publish', h(req => github.publishProject(projRoot(req.params.id), req.body || {})));
app.post('/api/projects/:id/git/push', h(req => github.gitPush(projRoot(req.params.id))));
app.post('/api/projects/:id/git/pull', h(req => github.gitPull(projRoot(req.params.id))));
app.post('/api/projects/:id/git/pr/draft', h(req => github.draftPR(projRoot(req.params.id), { modelRef: req.body?.modelRef })));
app.post('/api/projects/:id/git/pr', h(req => github.openPR(projRoot(req.params.id), req.body || {})));

// ---------- github ----------

registerService({
  id: 'github', name: 'GitHub', group: 'Code', settingsTab: 'github',
  probe: async () => {
    const { token, via } = github.resolveToken();
    if (!token) return { status: 'off', detail: 'not connected' };
    try {
      const s = await github.status();
      return { status: 'up', detail: `@${s.user.login}${via === 'gh-cli' ? ' via gh' : ''}` };
    } catch (e) { return { status: 'down', detail: e.message.slice(0, 60) }; }
  },
});
app.get('/api/github/status', h(() => github.status()));
app.get('/api/github/overview', h(() => github.overview()));
app.get('/api/github/heatmap', h(() => github.heatmap()));
app.get('/api/github/repos', h(() => github.repos()));
app.post('/api/github/repos', h(req => github.createRepo(req.body || {})));
app.get('/api/github/prs', h(() => github.prs()));
app.get('/api/github/issues', h(() => github.issues()));
app.get('/api/github/notifications', h(() => github.notifications()));
app.post('/api/github/notifications/:id/read', h(req => github.markRead(req.params.id)));
app.post('/api/github/clone', h(req => github.cloneRepo(req.body || {})));

// ---------- files ----------

app.get('/api/fs/roots', h(() => [...projects.allowedRoots()].map(([id, p]) => ({ id, path: p, name: id === 'vault' ? 'Vault' : path.basename(p) }))));
app.get('/api/fs/tree', h(req => files.tree(req.query.root, req.query.path || '')));
app.get('/api/fs/file', h(req => files.readFile(req.query.root, req.query.path)));
app.put('/api/fs/file', h(req => files.writeFile(req.body.root, req.body.path, req.body.content, req.body.mtime)));
app.post('/api/fs/mkdir', h(req => { files.mkdir(req.body.root, req.body.path); }));
app.post('/api/fs/rename', h(req => { files.rename(req.body.root, req.body.from, req.body.to); }));
app.post('/api/fs/delete', h(req => { files.remove(req.body.root, req.body.path); }));
app.get('/api/fs/search', h(req => files.search(req.query.root, req.query.q || '')));
app.get('/api/fs/raw', h((req, res) => {
  const { abs, mime } = files.raw(req.query.root, req.query.path);
  res.setHeader('content-type', mime);
  res.sendFile(abs);
}));

// ---------- agent ----------

app.get('/api/agent/sessions', h(req => agent.listSessions(req.query.projectId)));
app.post('/api/agent/sessions', h(req => agent.createSession(req.body || {})));
app.get('/api/agent/sessions/:id', h(req => agent.getSession(req.params.id)));
app.patch('/api/agent/sessions/:id', h(req => agent.updateSession(req.params.id, req.body || {})));
app.delete('/api/agent/sessions/:id', h(req => { agent.deleteSession(req.params.id); }));

// ---------- uploads (chat / agent media input) ----------

app.post('/api/uploads', h(req => uploads.saveUpload(req.body || {})));

// Binary upload — the path every current client uses. The bytes arrive as the body
// instead of base64 inside JSON, which is where a photo's cost used to triple. `type:
// '*/*'` because the browser reports the real content type (image/heic from an iPhone,
// or nothing at all for a file shared in from another app) and we want the bytes
// regardless; uploads.js sniffs the header anyway rather than trusting either.
app.post('/api/uploads/raw', express.raw({ type: '*/*', limit: '32mb' }), h(req => uploads.saveUploadBuffer({
  name: req.query.name, mime: req.query.mime || '', buffer: req.body,
})));
// Plain handler (not h()): sendFile streams asynchronously, so the h() wrapper would
// race it and send a JSON fallback first. Use the sendFile callback for errors instead.
app.get('/api/uploads/:id', (req, res) => {
  let served;
  try { served = uploads.uploadFile(req.params.id); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  res.setHeader('content-type', served.mime);
  res.setHeader('content-disposition', `inline; filename="${encodeURIComponent(served.name)}"`);
  res.sendFile(served.abs, (err) => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
});

// ---------- chat ----------

// what the chat/agent currently "knows" about your day — for transparency + testing
app.get('/api/chat/context', h(async () => ({ context: (await import('./context.js')).appContext() })));
app.get('/api/chats', h(() => chat.listChats()));
app.post('/api/chats', h(req => chat.createChat(req.body || {})));
app.get('/api/chats/:id', h(req => chat.getChat(req.params.id)));
app.patch('/api/chats/:id', h(req => chat.updateChat(req.params.id, req.body || {})));
app.delete('/api/chats/:id', h(req => { chat.deleteChat(req.params.id); }));
app.post('/api/chats/bulk-delete', h(req => chat.bulkDelete(req.body?.ids || [])));
app.post('/api/chats/move', h(req => chat.moveChats(req.body?.ids || [], req.body?.folder || '')));

// ---------- user profile (AI's learned notes about the user) ----------
app.get('/api/profile', h(() => profile.getProfile()));
app.put('/api/profile', h(req => profile.setProfile(req.body?.text || '')));
app.post('/api/profile/learn', h(async req => {
  // gather a sample of the user's recent messages across their latest chats
  const msgs = [];
  for (const c of chat.listChats().slice(0, 6)) {
    try { for (const m of chat.getChat(c.id).messages) if (m.role === 'user' && m.text) msgs.push(m.text); } catch { }
  }
  return profile.learnNow({ userMessages: msgs.slice(-14), modelRef: req.body?.modelRef });
}));

// ---------- research ----------

app.get('/api/research', h(() => research.listResearch()));
app.post('/api/research', h(req => research.startResearch(req.body || {})));
app.get('/api/research/:id', h(req => research.getResearch(req.params.id)));
app.delete('/api/research/:id', h(req => { research.deleteResearch(req.params.id); }));
app.post('/api/research/:id/export', h(req => research.exportToVault(req.params.id)));

// ---------- vault ----------

app.get('/api/vault/status', h(() => vault.status()));
app.post('/api/vault/path', h(req => vault.setVaultPath(req.body.path, !!req.body.create)));
app.get('/api/vault/notes', h(() => vault.index()));
app.get('/api/vault/note', h(req => vault.readNote(req.query.path)));
app.put('/api/vault/note', h(req => vault.writeNote(req.body.path, req.body.content)));
app.post('/api/vault/delete', h(req => { vault.deleteNote(req.body.path); }));
app.post('/api/vault/rename', h(req => { vault.renameNote(req.body.from, req.body.to); }));
app.get('/api/vault/search', h(req => vault.search(req.query.q || '')));
app.get('/api/vault/graph', h(() => vault.graph()));
app.post('/api/vault/daily', h(req => vault.dailyCapture(req.body.text || '')));
app.get('/api/vault/resolve', h(req => ({ path: vault.resolveLink(req.query.name || '') })));
app.post('/api/vault/wiki/index', h(() => wiki.rebuildIndex()));

// ---------- mail triage + notifications ----------
registerService({
  id: 'mail', name: 'Mail', group: 'Life', settingsTab: 'mail',
  probe: async () => {
    const s = mail.mailStatus();
    if (!s.configured) return { status: 'off', detail: 'not configured' };
    if (s.error) return { status: 'warn', detail: s.error.slice(0, 60) };
    return { status: 'up', detail: s.scannedAt ? `${s.important} important` : 'not scanned yet' };
  },
});
app.get('/api/mail/status', h(() => mail.mailStatus()));
app.post('/api/mail/scan', h(req => mail.scanMail({ modelRef: req.body?.modelRef })));
app.get('/api/mail/notifications', h(() => mail.notifications()));
app.get('/api/mail/message/:uid', h(req => mail.readMessage(Number(req.params.uid))));
app.post('/api/mail/dismiss', h(req => mail.dismiss(String(req.body?.id || ''))));
app.get('/api/mail/senders', h(() => mail.listSenderRules()));
app.post('/api/mail/sender', h(req => mail.setSenderRule(req.body || {})));
app.post('/api/notify/test', h(() => notify.sendDiscord('🔔 AIOS test notification — Discord is wired up.')));

// ---------- finance ----------
// Query shape shared by every read route: ?month=YYYY-MM | ?from=&to= |
// ?range=this-month|last-month|this-year|all|30d
app.get('/api/finance/overview', h(req => finance.overview(req.query)));
app.get('/api/finance/summary', h(req => finance.summary(req.query)));
app.get('/api/finance/insights', h(req => finance.insights(req.query)));
// ---------- income ----------
// Freelance income needs its own surface: what came in today, from whom, for what work,
// and whether the year so far is ahead. Everything reads the same ledger as expenses.
app.get('/api/finance/income', h(req => finance.incomeOverview(req.query)));
app.get('/api/finance/income/log', h(req => finance.incomeLog(req.query)));
app.get('/api/finance/income/sources', h(req => finance.incomeBySource(req.query)));
app.get('/api/finance/ytd', h(req => finance.yearToDate(req.query?.year)));

app.get('/api/finance/settings', h(() => finance.currencies()));
app.get('/api/finance/models', h(() => finance.modelOptions()));
app.get('/api/finance/categories', h(() => {
  const s = finance.settings();
  return { income: s.incomeCategories, expense: s.expenseCategories };
}));

app.get('/api/finance/txns', h(req => finance.listTxns(req.query)));
app.post('/api/finance/txns', h(req => finance.addTxn(req.body || {})));
app.post('/api/finance/txns/bulk-delete', h(req => finance.deleteTxns(req.body?.ids || [])));
app.get('/api/finance/txns/:id', h(req => finance.getTxn(req.params.id)));
app.patch('/api/finance/txns/:id', h(req => finance.updateTxn(req.params.id, req.body || {})));
app.delete('/api/finance/txns/:id', h(req => { finance.deleteTxn(req.params.id); }));

app.get('/api/finance/chart/categories', h(req => finance.byCategory(req.query)));
app.get('/api/finance/chart/monthly', h(req => finance.monthlySeries(req.query)));
app.get('/api/finance/chart/daily', h(req => finance.dailySeries(req.query)));
app.get('/api/finance/chart/merchants', h(req => finance.topMerchants(req.query)));
app.get('/api/finance/suggest', h(req => finance.suggest(req.query)));

app.get('/api/finance/presets', h(() => finance.listPresets()));
app.post('/api/finance/presets', h(req => finance.addPreset(req.body || {})));
app.patch('/api/finance/presets/:id', h(req => finance.updatePreset(req.params.id, req.body || {})));
app.delete('/api/finance/presets/:id', h(req => { finance.deletePreset(req.params.id); }));
app.post('/api/finance/presets/:id/log', h(req => finance.logPreset(req.params.id, req.body || {})));

app.get('/api/finance/goal', h(req => finance.getGoal(req.query.month)));
app.put('/api/finance/goal', h(req => finance.setGoal(req.body?.month, req.body || {})));

app.get('/api/finance/budgets', h(req => finance.listBudgets(req.query.month)));
app.put('/api/finance/budgets', h(req => finance.setBudget(req.body || {})));
app.delete('/api/finance/budgets/:id', h(req => { finance.deleteBudget(req.params.id); }));

app.get('/api/finance/recurring', h(() => finance.listRecurring()));
app.post('/api/finance/recurring', h(req => finance.addRecurring(req.body || {})));
app.patch('/api/finance/recurring/:id', h(req => finance.updateRecurring(req.params.id, req.body || {})));
app.delete('/api/finance/recurring/:id', h(req => { finance.deleteRecurring(req.params.id); }));
app.post('/api/finance/recurring/run', h(req => finance.runRecurring(req.body || {})));

// looking back: a year at a glance, and the frozen monthly write-ups
app.get('/api/finance/year', h(req => finance.yearOverview(req.query.year)));
app.get('/api/finance/calendar', h(req => finance.calendar(req.query)));
app.get('/api/finance/recap', h(req => finance.getRecap(req.query.month)));
app.post('/api/finance/recap', h(req => financeai.generateRecap(req.body?.month, req.body || {})));
app.put('/api/finance/recap/note', h(req => finance.setRecapNote(req.body?.month, req.body?.note)));

// item price tracking — the canonical catalogue, its learned aliases, and the
// price observations that answer "where is this cheapest"
app.get('/api/finance/items', h(req => items.listItems(req.query)));
app.post('/api/finance/items', h(req => items.createItem(req.body || {})));
app.get('/api/finance/items/unresolved', h(req => items.unresolved(req.query)));
app.post('/api/finance/items/resolve', h(async req => {
  const { resolveNames } = await import('./itemsai.js');
  const names = Array.isArray(req.body?.names) ? req.body.names.map(String).slice(0, 40) : [];
  if (!names.length) throw Object.assign(new Error('names must be a non-empty array'), { status: 400 });
  const map = await resolveNames(names);
  return { resolved: Object.fromEntries([...map].map(([k, v]) => [k, v || null])) };
}));
app.get('/api/finance/items/:id', h(req => items.itemDetail(req.params.id)));
app.patch('/api/finance/items/:id', h(req => items.updateItem(req.params.id, req.body || {})));
app.delete('/api/finance/items/:id', h(req => { items.deleteItem(req.params.id); }));
app.post('/api/finance/items/:id/merge', h(req => items.mergeItems(req.params.id, String(req.body?.into || ''))));
app.post('/api/finance/items/:id/alias', h(req => items.learnAlias(String(req.body?.raw || ''), req.params.id, { source: 'manual', confirmed: true })));
app.delete('/api/finance/alias/:id', h(req => { items.deleteAlias(req.params.id); }));
app.post('/api/finance/purchases/:id/assign', h(req => items.assignPurchase(req.params.id, String(req.body?.itemId || ''))));
// Bulk paths — a grocery receipt makes twenty observations, and twenty round trips to
// file them is the reason they never get filed.
app.post('/api/finance/purchases/assign', h(req => items.assignPurchases(req.body?.pairs || [])));
app.post('/api/finance/purchases/drop', h(req => items.dropPurchases(req.body?.ids || [])));
app.get('/api/finance/suggest-items', h(req => items.candidates(String(req.query?.q || ''), { limit: Number(req.query?.limit) || 6 })));

// receipt OCR — upload the image via /api/uploads first, then scan by its id
app.get('/api/finance/receipts', h(req => receipts.listReceipts(req.query)));
app.get('/api/finance/receipts/:id', h(req => receipts.getReceipt(req.params.id)));
app.post('/api/finance/receipts/scan', h(req => receipts.scan(req.body || {})));
// Correct a scan before it reaches the ledger. The model's original reading is kept, so
// applying it afterwards can learn from the difference.
app.patch('/api/finance/receipts/:id', h(req => receipts.editReceipt(req.params.id, req.body || {})));
app.post('/api/finance/receipts/:id/apply', h(req => receipts.apply(req.params.id, req.body || {})));
// Take it back out of the ledger so it can be corrected and re-posted — the "I only
// noticed the phantom line after logging it" path. Removes its rows AND their prices.
app.post('/api/finance/receipts/:id/revert', h(req => receipts.revertReceipt(req.params.id)));
// Read the same photo again — this model's output varies run to run, so a second attempt
// is often simply better. An optional `model` tries a different reader just for this one.
app.post('/api/finance/receipts/:id/rescan', h(req => receipts.rescan(req.params.id, { model: req.body?.model, rotate: req.body?.rotate })));
app.delete('/api/finance/receipts/:id', h(req => { receipts.deleteReceipt(req.params.id); }));
// Read a payout screen (Uber, a marketplace) into a prefill for the income form. Shares
// the reader with receipt scanning and nothing else: it stores no scan, creates no
// receipt, and cannot reach the ledger — the user confirms the numbers in the form.
app.post('/api/finance/earnings/read', h(req => receipts.readEarnings(req.body || {})));
// What the corrections have taught it — visible and revocable, not a black box.
app.get('/api/finance/receipt-fixes', h(req => receipts.listFixes({ limit: Number(req.query?.limit) || 200 })));
app.delete('/api/finance/receipt-fixes/:id', h(req => { receipts.forgetFix(req.params.id); }));
// Whether the learning is working: corrections stored, vocabulary built, and how the last
// ten scans scored against the ten before them.
app.get('/api/finance/receipt-learning', h(() => receipts.learningStats()));

// ---------- planner ----------
app.get('/api/planner/events', h(req => planner.eventsInRange(req.query.from, req.query.to)));
app.post('/api/planner/events', h(req => planner.addEvent(req.body || {})));
app.patch('/api/planner/events/:id', h(req => planner.updateEvent(req.params.id, req.body || {})));
app.delete('/api/planner/events/:id', h(req => { planner.deleteEvent(req.params.id); }));
app.get('/api/planner/tasks', h(() => planner.listTasks()));
app.post('/api/planner/tasks', h(req => planner.addTask(req.body || {})));
app.patch('/api/planner/tasks/:id', h(req => planner.updateTask(req.params.id, req.body || {})));
app.delete('/api/planner/tasks/:id', h(req => { planner.deleteTask(req.params.id); }));
app.get('/api/planner/agenda', h(req => planner.agenda(req.query.date || planner.todayStr())));
app.get('/api/planner/upcoming', h(req => planner.upcoming(Math.min(+req.query.limit || 6, 20))));
app.get('/api/planner/birthdays', h(() => planner.listBirthdays()));
app.post('/api/planner/birthdays', h(req => planner.addBirthday(req.body || {})));
app.patch('/api/planner/birthdays/:id', h(req => planner.updateBirthday(req.params.id, req.body || {})));
app.delete('/api/planner/birthdays/:id', h(req => { planner.deleteBirthday(req.params.id); }));
app.get('/api/planner/reminders', h(() => planner.listReminders()));
app.post('/api/planner/reminders', h(req => planner.addReminder(req.body || {})));
app.patch('/api/planner/reminders/:id', h(req => planner.updateReminder(req.params.id, req.body || {})));
app.delete('/api/planner/reminders/:id', h(req => { planner.deleteReminder(req.params.id); }));
app.get('/api/planner/reminders/:id/logs', h(req => planner.reminderLogs(req.params.id)));
app.post('/api/planner/reminders/:id/log', h(req => {
  const { date, text, undo } = req.body || {};
  undo ? planner.unlogReminder(req.params.id, date) : planner.logReminder(req.params.id, date, text || '');
}));

// ---------- weather (Home widget) ----------

app.get('/api/weather', h(() => weather.getWeather()));
app.get('/api/weather/geocode', h(req => weather.geocode(req.query.q)));

// ---------- studio (ComfyUI) + managed llama.cpp ----------

registerService({
  id: 'comfy', name: 'ComfyUI', group: 'Studio', settingsTab: 'about',
  probe: async () => {
    const s = await comfy.comfyPing();
    if (!s.up) return { status: 'off', detail: 'not running' };
    return { status: 'up', detail: s.vramFreeMB ? `${s.vramFreeMB}MB VRAM free` : 'up' };
  },
});
registerService({
  id: 'llm-profile', name: 'llama.cpp', group: 'Models', settingsTab: 'providers',
  probe: async () => {
    const s = llmctl.llmStatus();
    if (s.running) return { status: 'up', detail: `profile: ${s.profile}` };
    if (s.foreign) return { status: 'warn', detail: 'running (not AIOS-managed yet)' };
    return { status: 'off', detail: 'stopped' };
  },
});
app.get('/api/comfy/status', h(() => comfy.comfyStatus()));
app.get('/api/comfy/checkpoints', h(() => comfy.listCheckpoints()));
app.get('/api/comfy/upscalers', h(() => comfy.listUpscalers()));
app.post('/api/comfy/generate', h(req => comfy.generate(req.body || {})));
app.get('/api/comfy/jobs', h(() => comfy.listJobs()));
app.get('/api/comfy/jobs/:id', h(req => comfy.getJob(req.params.id)));
// plain handler: h() would race sendFile (same latent bug as /api/uploads/:id)
app.get('/api/comfy/image/:name', (req, res) => {
  try { res.sendFile(comfy.imagePath(req.params.name)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/comfy/studio', h(req => comfy.setStudio(!!req.body?.on)));
app.post('/api/comfy/start', h(() => comfy.startComfy()));
app.post('/api/comfy/stop', h(() => comfy.stopComfy()));
app.post('/api/comfy/free', h(() => comfy.freeVram()));
app.get('/api/comfy/plan', h(req => comfy.samplingPlan(String(req.query.checkpoint || ''), Number(req.query.steps) || 8, String(req.query.accel || 'quality'))));
app.post('/api/comfy/expand', h(req => comfy.expandPrompt(req.body || {})));
app.get('/api/llm/status', h(() => ({ ...llmctl.llmStatus(), gpu: gpuStats() })));
app.post('/api/llm/profile', h(req => llmctl.startProfile(String(req.body?.profile || ''))));
app.post('/api/llm/launcher', h(() => llmctl.openLauncher()));
app.get('/api/llm/models', h(() => ({ models: llmctl.listLocalModels() })));
app.post('/api/llm/model', h(req => llmctl.startModel(String(req.body?.path || ''))));
app.get('/api/llm/routing', h(() => router.routingInfo()));
app.post('/api/llm/stop', h(() => llmctl.stopLlama()));
app.get('/api/llm/log', h(req => ({ log: llmctl.llamaLog(Number(req.query?.lines) || 120) })));

// ---------- LLM benchmark ----------

app.get('/api/bench', h(() => ({ ...bench.leaderboard(), ...bench.benchStatus() })));
app.get('/api/bench/runs', h(req => ({ runs: bench.recentRuns(Number(req.query?.limit) || 40) })));
app.get('/api/bench/history', h(req => ({ runs: bench.testHistory(req.query?.model, req.query?.test, Number(req.query?.limit) || 20) })));
app.post('/api/bench/run', h(req => bench.startBench(req.body || {})));
app.post('/api/bench/sweep', h(req => bench.startSweep(req.body || {})));
app.post('/api/bench/stop', h(() => bench.stopBench()));
app.delete('/api/bench/runs', h(() => bench.clearRuns()));
app.post('/api/llm/autosetup', h(req => router.autoSetup(req.body || {})));

// ---------- learning corner ----------

app.get('/api/learn', h(() => learn.listSubjects()));
app.post('/api/learn', h(req => learn.createSubject(req.body || {})));
app.get('/api/learn/:id', h(req => learn.getSubject(req.params.id)));
app.patch('/api/learn/:id', h(req => learn.updateSubject(req.params.id, req.body || {})));
app.delete('/api/learn/:id', h(req => { learn.deleteSubject(req.params.id, { confirm: req.query.confirm }); }));
app.post('/api/learn/:id/roadmap', h(req => learn.generateRoadmap({ id: req.params.id, modelRef: req.body?.modelRef })));
app.post('/api/learn/:id/lesson', h(req => learn.generateLesson({ id: req.params.id, moduleId: req.body?.moduleId, focus: req.body?.focus, review: req.body?.review, modelRef: req.body?.modelRef })));
app.post('/api/learn/:id/modules/:mid', h(req => learn.setModuleDone(req.params.id, req.params.mid, !!req.body?.done)));
app.post('/api/learn/:id/lessons/:lid', h(req => learn.setLessonDone(req.params.id, req.params.lid, req.body?.done !== false)));

// lesson content is fetched on demand — the subject payload carries metadata only
app.get('/api/learn/:id/lessons/:lid', h(req => learn.getLesson(req.params.id, req.params.lid)));
app.delete('/api/learn/:id/lessons/:lid', h(req => learn.deleteLesson(req.params.id, req.params.lid)));

// regenerate a lesson IN PLACE (same slot/id), with revision history to fall back on
app.post('/api/learn/:id/lessons/:lid/regenerate', h(req => learn.regenerateLesson({
  id: req.params.id, lessonId: req.params.lid,
  instructions: req.body?.instructions, focus: req.body?.focus,
  useWeb: req.body?.useWeb, modelRef: req.body?.modelRef,
})));
app.post('/api/learn/:id/lessons/:lid/recheck', h(req => learn.recheckLesson(req.params.id, req.params.lid)));
app.get('/api/learn/:id/lessons/:lid/revisions', h(req => learn.listRevisions(req.params.id, req.params.lid)));
app.get('/api/learn/:id/lessons/:lid/revisions/:rid', h(req => learn.getRevision(req.params.id, req.params.lid, req.params.rid)));
app.post('/api/learn/:id/lessons/:lid/revisions/:rid/restore', h(req => learn.restoreRevision(req.params.id, req.params.lid, req.params.rid)));
app.post('/api/learn/:id/check', h(req => learn.checkSubjectLessons(req.params.id)));
// HTTP twin of the WS learn.cancel — an escape hatch when a run wedges and the app
// isn't open to hit Stop (otherwise the subject stays locked until a restart).
app.post('/api/learn/:id/cancel', h(req => ({ ok: learn.cancel(req.params.id) })));

// assessments: generate → fetch (answers stripped) → start attempt → submit → review
app.post('/api/learn/:id/assessment', h(req => learn.generateAssessment({
  id: req.params.id, kind: req.body?.kind, moduleId: req.body?.moduleId,
  lessonId: req.body?.lessonId, modelRef: req.body?.modelRef,
})));
app.get('/api/learn/:id/assessment/:aid', h(req => learn.getAssessment(req.params.id, req.params.aid)));
app.delete('/api/learn/:id/assessment/:aid', h(req => learn.deleteAssessment(req.params.id, req.params.aid)));
app.post('/api/learn/:id/assessment/:aid/start', h(req => learn.startAttempt(req.params.id, req.params.aid)));
app.post('/api/learn/:id/assessment/:aid/submit', h(req => learn.submitAttempt({
  subjectId: req.params.id, assessmentId: req.params.aid,
  attemptId: req.body?.attemptId, answers: req.body?.answers || {}, modelRef: req.body?.modelRef,
})));
app.get('/api/learn/:id/attempt/:tid', h(req => learn.getAttempt(req.params.id, req.params.tid)));

// the feedback button + the adaptive read-outs behind it
app.post('/api/learn/:id/feedback', h(req => learn.generateFeedback({ id: req.params.id, modelRef: req.body?.modelRef })));
// career/cert advisor — result is stored on the subject and returned by GET /learn/:id
app.post('/api/learn/:id/advise', h(req => learn.generateAdvice({ id: req.params.id, modelRef: req.body?.modelRef })));
app.get('/api/learn/:id/weak', h(req => learn.getWeakTopics(req.params.id, Number(req.query?.limit) || 8)));


// ---------- phone shell ----------
// /m is a separate document with its own CSS and JS — it shares nothing with the
// desktop shell but /css/theme.css (variables and primitives) and /js/api.js, so
// nothing here can move a pixel of the desktop layout.
//
// A phone landing on / is redirected to it, carrying the pairing token through so
// the LAN link printed at boot still works from a photo message. ?desktop=1 opts
// out for anyone who wants the full shell on a phone anyway.
const PHONE_UA = /iPhone|iPod|Android[^;]*Mobile|Windows Phone|BlackBerry|Opera Mini/i;

app.get('/m', (req, res) => {
  res.sendFile(path.join(ROOT, 'web', 'mobile.html'), (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).end();
  });
});

app.get('/', (req, res, next) => {
  if (req.query.desktop !== undefined) return next();
  if (!PHONE_UA.test(req.headers['user-agent'] || '')) return next();
  const qs = req.originalUrl.slice(req.originalUrl.indexOf('?') + 1);
  res.redirect(302, '/m' + (req.originalUrl.includes('?') && qs ? '?' + qs : ''));
});

// ---------- static shell ----------

app.use(express.static(path.join(ROOT, 'web'), { index: 'index.html' }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

// ---------- websocket hub ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

// A socket that stopped reading must not be allowed to buffer forever. Streaming a
// long answer to a phone that walked out of Wi-Fi range used to grow ws's internal
// queue without bound — the socket is open as far as TCP knows, so nothing pushed
// back. Past this much backlog the client is hopeless: close it and let the browser
// reconnect, which it does automatically.
const MAX_BUFFERED = 8 * 1024 * 1024;

function publish(topic, obj) {
  // stamp the topic so the client fans out generically — no per-message-type
  // mapping to keep in sync (that drift silently broke research/comfy/gh streams)
  const msg = JSON.stringify({ ...obj, _topic: topic });
  for (const c of clients) {
    if (!c.subs.has(topic)) continue;
    if (c.ws.bufferedAmount > MAX_BUFFERED) { try { c.ws.terminate(); } catch { } continue; }
    try { c.ws.send(msg); } catch { }
  }
}
agent.setPublisher(publish);
chat.setPublisher(publish);
bench.setPublisher(publish);
vault.setPublisher(publish);
research.setPublisher(publish);
github.setPublisher(publish);
comfy.setPublisher(publish);
learn.setPublisher(publish);

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  if (!authorized(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  const client = { ws, subs: new Set(), alive: true, send: (obj) => { try { ws.send(JSON.stringify(obj)); } catch { } } };
  clients.add(client);

  ws.on('pong', () => { client.alive = true; });
  ws.on('message', async (raw) => {
    client.alive = true;
    let m; try { m = JSON.parse(raw); } catch { return; }
    try { await route(client, m); }
    catch (e) { client.send({ t: 'error', of: m.t, message: e.message }); }
  });
  ws.on('close', () => { clients.delete(client); term.closeClientTerminals(client); });
  ws.on('error', () => { });
});

// Reap dead connections.
//
// A phone that sleeps, a laptop whose lid closes, a device that leaves the network —
// none of them send a close frame, and TCP will not notice for hours. Without this the
// `clients` set only ever grew: every entry kept its subscription set alive, kept the
// user's terminal shells running (closeClientTerminals only fires on 'close'), and got
// a copy of every published message. That is the shape of a server that feels slower
// the longer it has been up, and it is worst on the LAN devices this is built for.
const WS_PING_MS = 30_000;
const wsHeartbeat = setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { try { c.ws.terminate(); } catch { } clients.delete(c); term.closeClientTerminals(c); continue; }
    c.alive = false;                       // set true again by 'pong' or any message
    try { c.ws.ping(); } catch { try { c.ws.terminate(); } catch { } }
  }
}, WS_PING_MS);
wsHeartbeat.unref();

async function route(client, m) {
  switch (m.t) {
    case 'ping': return client.send({ t: 'pong' });
    case 'sub': client.subs.add(m.topic); return;
    case 'unsub': client.subs.delete(m.topic); return;

    // `await`, not fire-and-forget. Both of these can reject BEFORE their own try/catch
    // begins — agent.js getSession and chat.js getChat throw 404 on a stale id, and the
    // whole of chat.sendMessage's 77-line prologue sits outside its try. Un-awaited, that
    // rejection had no handler at all: Node 26 defaults to --unhandled-rejections=throw, so
    // one browser tab posting to a chat another tab had just deleted exited the process,
    // skipping the SIGTERM cleanup and orphaning the detached llama-server. Awaiting hands
    // it to the caller's try/catch, which already answers the client with {t:'error'}.
    case 'agent.user': await agent.userMessage(m.sessionId, String(m.text || ''), uploads.resolveAttachments(m.attachments)); return;
    case 'agent.cancel': agent.cancel(m.sessionId); return;
    case 'agent.approve': agent.approve(m.sessionId, m.callId, m.decision === 'always' ? 'always' : m.decision === 'allow' ? 'allow' : 'deny'); return;
    case 'agent.plan': agent.resolvePlan(m.sessionId, m.decision === 'approve' ? 'approve' : 'reject', typeof m.text === 'string' ? m.text : undefined); return;

    case 'chat.send':
      try {
        await chat.sendMessage(m.chatId, String(m.text || ''), { modelRef: m.modelRef, attachments: uploads.resolveAttachments(m.attachments) });
      } catch (e) {
        // `live.set(cid, ctl)` happens early in sendMessage's prologue, before its own try.
        // A throw after that point would leave the chat permanently answering "Already
        // generating." — moot while the rejection killed the process, live now that it does not.
        try { chat.stop(m.chatId); } catch { /* nothing was in flight */ }
        throw e;
      }
      return;
    case 'chat.stop': chat.stop(m.chatId); return;

    case 'research.cancel': research.cancel(m.id); return;
    case 'learn.cancel': learn.cancel(m.id); return;

    case 'term.open': {
      let cwd = m.cwd;
      if (m.projectId) cwd = projects.getProject(m.projectId)?.path || cwd;
      term.openTerminal({ id: m.id, cols: m.cols, rows: m.rows, cwd }, client);
      return;
    }
    case 'term.in': term.termInput(m.id, m.data); return;
    case 'term.resize': term.termResize(m.id, m.cols, m.rows); return;
    case 'term.close': term.closeTerminal(m.id); return;

    case 'vault.ask': vault.askVault({ reqId: m.reqId, question: m.question, modelRef: m.modelRef }); return;
    case 'vault.summarize': vault.summarizeNote({ reqId: m.reqId, path: m.path, modelRef: m.modelRef }); return;
    case 'vault.wiki': vault.wikiGenerate({ reqId: m.reqId, topic: m.topic, sourcePath: m.sourcePath, count: m.count, modelRef: m.modelRef }); return;
    case 'github.suggest': github.suggest({ reqId: m.reqId, modelRef: m.modelRef, projectId: m.projectId }); return;
    case 'vault.cancel': vault.cancelAI(m.reqId); return;

    default: client.send({ t: 'error', message: `unknown message type: ${m.t}` });
  }
}

// ---------- boot ----------

function lanUrls(withToken = false) {
  const c = loadConfig();
  const port = c.server.port;
  const urls = [`http://localhost:${port}`];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return withToken && c.auth.required !== 'never'
    ? urls.map((u, i) => i === 0 ? u : `${u}/?token=${c.auth.token}`)
    : urls;
}

mail.startAutoScan();   // no-op until mail.enabled + scanIntervalMin are set

// Connect enabled MCP servers in the background. Deliberately not awaited: these are
// third-party processes and one of them being slow, broken, or absent must not hold up
// the hub. Their tools appear on the agent's belt as each handshake completes.
mcp.startEnabled();

// Scans stored before the duplicate guard existed carry no fingerprint, which would leave
// exactly the receipts already in the ledger unprotected. One-time, then a no-op.
try { receipts.backfillFingerprints(); }
catch (e) { console.error('[receipts] could not index existing scans:', e.message); }

server.listen(cfg.server.port, cfg.server.host, () => {
  const urls = lanUrls(true);
  console.log(`
  ╭──────────────────────────────────────────────────────╮
  │              AIOS · your AI operating hub            │
  ╰──────────────────────────────────────────────────────╯

  This machine :  ${urls[0]}
${urls.slice(1).map(u => `  On your LAN  :  ${u}`).join('\n') || '  (no LAN interfaces found)'}

  LAN links include the pairing token (auth mode: ${cfg.auth.required}).
  Data lives in ${DATA}
`);
});

// MCP servers are our child processes; leaving them running would orphan them.
// A personal hub holds state nothing else does: a scan mid-pass, an agent run, open
// terminals, the llama-server it spawned. Node 26 exits on an unhandled rejection by
// default, so one un-awaited promise anywhere took all of that down and skipped the
// cleanup below. The individual offenders are fixed; this is so the next one is a logged
// line rather than an outage.
process.on('unhandledRejection', (e) => {
  console.error('[aios] unhandled promise rejection (kept running):', e?.stack || e);
});

process.on('SIGINT', () => { console.log('\nshutting down…'); mcp.stopAll(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { mcp.stopAll(); server.close(); process.exit(0); });
