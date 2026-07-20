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
import * as uploads from './uploads.js';
import * as vault from './vault.js';
import * as wiki from './wiki.js';
import * as forge from './toolforge.js';
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
import { gpuStats } from './gpu.js';

const cfg = loadConfig();
fs.mkdirSync(DATA, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '60mb' }));   // headroom for base64 image/PDF uploads

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


// ---------- static shell ----------

app.use(express.static(path.join(ROOT, 'web'), { index: 'index.html' }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

// ---------- websocket hub ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function publish(topic, obj) {
  // stamp the topic so the client fans out generically — no per-message-type
  // mapping to keep in sync (that drift silently broke research/comfy/gh streams)
  const msg = JSON.stringify({ ...obj, _topic: topic });
  for (const c of clients) if (c.subs.has(topic)) { try { c.ws.send(msg); } catch { } }
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
  const client = { ws, subs: new Set(), send: (obj) => { try { ws.send(JSON.stringify(obj)); } catch { } } };
  clients.add(client);

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try { await route(client, m); }
    catch (e) { client.send({ t: 'error', of: m.t, message: e.message }); }
  });
  ws.on('close', () => { clients.delete(client); term.closeClientTerminals(client); });
  ws.on('error', () => { });
});

async function route(client, m) {
  switch (m.t) {
    case 'ping': return client.send({ t: 'pong' });
    case 'sub': client.subs.add(m.topic); return;
    case 'unsub': client.subs.delete(m.topic); return;

    case 'agent.user': agent.userMessage(m.sessionId, String(m.text || ''), uploads.resolveAttachments(m.attachments)); return;
    case 'agent.cancel': agent.cancel(m.sessionId); return;
    case 'agent.approve': agent.approve(m.sessionId, m.callId, m.decision === 'always' ? 'always' : m.decision === 'allow' ? 'allow' : 'deny'); return;
    case 'agent.plan': agent.resolvePlan(m.sessionId, m.decision === 'approve' ? 'approve' : 'reject', typeof m.text === 'string' ? m.text : undefined); return;

    case 'chat.send': chat.sendMessage(m.chatId, String(m.text || ''), { modelRef: m.modelRef, attachments: uploads.resolveAttachments(m.attachments) }); return;
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

process.on('SIGINT', () => { console.log('\nshutting down…'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
