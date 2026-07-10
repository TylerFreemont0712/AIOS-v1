#!/usr/bin/env node
// Feature audit: exercises every AIOS subsystem against a throwaway data dir and
// prints a pass/fail table. Hard failures exit 1; environment-dependent services
// (providers, SearXNG, GitHub, network) are probed and REPORTED, never failed.
//
//   npm run audit

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-audit-'));
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-audit-vault-'));
const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-audit-proj-'));
process.env.AIOS_DATA = tmpData;

const results = [];
const hard = async (area, fn) => {
  try { const detail = await fn(); results.push({ area, state: 'pass', detail: detail || '' }); }
  catch (e) { results.push({ area, state: 'FAIL', detail: e.message.slice(0, 110) }); }
};
const soft = async (area, fn) => {
  try { const detail = await fn(); results.push({ area, state: 'pass', detail: detail || '' }); }
  catch (e) { results.push({ area, state: 'env', detail: e.message.slice(0, 110) }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const S = (m) => import(path.join(ROOT, 'server', m));

// ---------- core plumbing ----------

await hard('config: defaults + secrets redaction', async () => {
  const cfg = await S('config.js');
  const c = cfg.loadConfig();
  assert(c.weather && c.github && c.agent && c.vault, 'missing config sections');
  cfg.updateConfig({ github: { token: 'tok_secret' }, weather: { lat: 1.5, lon: 2.5, place: 'X' } });
  const pub = cfg.publicConfig();
  assert(pub.github.hasToken === true && pub.github.token === undefined, 'github token leaked');
  assert(pub.mail.password === undefined, 'mail password leaked');
  assert(pub.auth.token === undefined, 'auth token leaked');
  cfg.updateConfig({ github: { token: null } });
  assert(cfg.publicConfig().github.hasToken === false, 'token clear failed');
  return 'sections + redaction + explicit-secret roundtrip';
});

await hard('util: helpers', async () => {
  const u = await S('util.js');
  assert(u.id(6).length === 8 && u.id(6) !== u.id(6), 'id: 6 bytes → 8 base64url chars, unique');
  const clamped = u.clampMiddle('a'.repeat(50_000), 2000);
  assert(clamped.length < 2600 && clamped.includes('trimmed'), 'clampMiddle');
  assert(u.estTokens('word '.repeat(100)) > 20, 'estTokens');
  return 'id · clampMiddle · estTokens';
});

await hard('checks: syntax gates', async () => {
  const { checkFile } = await S('checks.js');
  fs.writeFileSync(path.join(tmpProj, 'ok.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(tmpProj, 'bad.js'), 'function ( {\n');
  fs.writeFileSync(path.join(tmpProj, 'bad.json'), '{"a":,}\n');
  assert((await checkFile(tmpProj, 'ok.js')).ok === true, 'valid js flagged');
  assert((await checkFile(tmpProj, 'bad.js')).ok === false, 'broken js passed');
  assert((await checkFile(tmpProj, 'bad.json')).ok === false, 'broken json passed');
  return 'js good/bad + json bad';
});

await hard('skills: playbooks load + stack detection', async () => {
  const sk = await S('skills.js');
  const names = sk.listSkills();
  assert(names.length >= 10, `only ${names.length} playbooks`);
  for (const n of names) assert((sk.getSkill(n) || '').length > 400, `playbook ${n} is thin/empty`);
  const stacks = sk.detectStacks(ROOT);
  assert(stacks.includes('javascript') || stacks.includes('node-api'), 'AIOS stacks not detected: ' + stacks);
  const prompt = sk.skillsPrompt(ROOT, 'ollama:x');
  assert(prompt.length > 500 && prompt.length < 9000, `ollama skills prompt ${prompt.length} chars (budget 7k)`);
  return `${names.length} playbooks · stacks: ${stacks.join(',')}`;
});

// ---------- life layer ----------

await hard('planner: recurrence + agenda', async () => {
  const p = await S('planner.js');
  assert(p.recursOn({ anchor: '2026-01-01', recur: 'daily' }, '2026-07-10'), 'daily');
  assert(p.recursOn({ anchor: '2026-07-06', recur: 'weekly:1,5' }, '2026-07-10'), 'weekly Fri');
  assert(!p.recursOn({ anchor: '2026-07-06', recur: 'weekly:1,5' }, '2026-07-09'), 'weekly Thu excluded');
  assert(p.recursOn({ anchor: '2026-01-11', recur: 'nth_weekday:2:6' }, '2026-07-11'), '2nd Saturday');
  assert(!p.recursOn({ anchor: '2026-01-01', recur: 'daily', until: '2026-06-01' }, '2026-07-10'), 'until respected');
  const ev = p.addEvent({ title: 'audit event', date: p.todayStr(), category: 'social' });
  const t = p.addTask({ title: 'audit task', due: p.todayStr() });
  const a = p.agenda();
  assert(a.events.some(e => e.id === ev.id) && a.tasks.some(x => x.id === t.id), 'agenda missing items');
  p.deleteEvent(ev.id); p.deleteTask(t.id);
  return 'recur forms · agenda assembly';
});

await hard('mail: parser units', async () => {
  const m = await S('mail.js');
  const crit = m.searchCriteria('from:alice subject:"weekly report" is:unread hello', 7);
  assert(/FROM/.test(crit) && /SUBJECT/.test(crit) && /UNSEEN/.test(crit) && /SINCE/.test(crit), 'searchCriteria: ' + crit);
  assert(m.decodeMimeWords('=?UTF-8?B?44GT44KT44Gr44Gh44Gv?=').includes('こんにちは'), 'RFC2047 B');
  const buf = 'A1 OK done\r\n';
  assert(m.findTagLine(buf, 'A1'), 'findTagLine');
  return 'searchCriteria · RFC2047 · findTagLine';
});

await hard('uploads: roundtrip + classify', async () => {
  const up = await S('uploads.js');
  assert(up.classify('image/png', 'x.png') === 'image' && up.classify('', 'a.py') === 'text' && up.classify('application/pdf', '') === 'pdf', 'classify');
  const meta = up.saveUpload({ name: 'note.txt', mime: 'text/plain', data: Buffer.from('hello audit').toString('base64') });
  const { buffer } = up.readUpload(meta.id);
  assert(buffer.toString() === 'hello audit', 'bytes roundtrip');
  assert(up.resolveAttachments([{ id: meta.id }, { id: '../evil' }]).length === 1, 'junk id not stripped');
  return 'save/read · classify · resolveAttachments';
});

await hard('weather: WMO map + unconfigured state', async () => {
  const w = await S('weather.js');
  assert(w.describeWMO(0)[0] === 'Clear' && w.describeWMO(95)[1] === '⛈️' && w.describeWMO(12345)[0] === '—', 'WMO');
  const cfg = await S('config.js');
  cfg.updateConfig({ weather: { lat: null, lon: null } });
  assert((await w.getWeather()).configured === false, 'unconfigured leak');
  return 'WMO codes · configured gate';
});

// ---------- knowledge layer ----------

await hard('vault + wiki: notes, autolink, recall, index', async () => {
  const cfg = await S('config.js');
  cfg.loadConfig().vault.path = tmpVault;
  const v = await S('vault.js');
  const wiki = await S('wiki.js');
  wiki.upsertNote({ title: 'Alpha Concept', content: 'A base concept for the audit.', tags: ['audit'] });
  const r2 = wiki.upsertNote({ title: 'Beta Uses Alpha', content: 'Beta builds on Alpha Concept in practice.' });
  assert(r2.linked.some(l => /Alpha/.test(l)), 'autolink missed: ' + r2.linked);
  const rec = wiki.recall('alpha concept', { chars: 4000 });
  assert(rec.notes.length >= 1 && rec.text.includes('Alpha'), 'recall');
  const idx = wiki.rebuildIndex();
  assert(idx.notes >= 2, 'index count');
  v.invalidate?.();
  const hits = v.search('beta', 5);
  assert(hits.length >= 1, 'vault search');
  return 'upsert · autolink · recall · Home index · search';
});

await hard('toolforge: create/run/deny/delete', async () => {
  const f = await S('toolforge.js');
  f.saveCustomTool({
    name: 'audit_echo', description: 'echo', access: 'read',
    parameters: { type: 'object', properties: { v: { type: 'string' } } },
    code: 'return "echo:" + args.v;',
  }, { builtinNames: new Set() });
  const out = await f.runCustomTool(f.getCustomTool('audit_echo'), { v: 'hi' }, { caps: {} });
  assert(String(out).includes('echo:hi'), 'run output: ' + out);
  f.saveCustomTool({
    name: 'audit_wr', description: 'write attempt', access: 'read',
    parameters: { type: 'object', properties: {} },
    code: 'try { await ctx.writeFile("a.txt", "x"); return "LEAKED"; } catch (e) { return "denied: " + e.message; }',
  }, { builtinNames: new Set() });
  const denied = await f.runCustomTool(f.getCustomTool('audit_wr'), {}, { caps: { writeFile: () => 'x' } });
  assert(String(denied).includes('denied'), 'read tool got write capability! → ' + denied);
  f.deleteCustomTool('audit_echo'); f.deleteCustomTool('audit_wr');
  return 'vm run · least-privilege caps · delete';
});

// ---------- code layer ----------

await hard('git: init/branch/commit/info', async () => {
  const g = await S('git.js');
  assert(g.hasGit(), 'git missing');
  await g.gitInit(tmpProj);
  fs.writeFileSync(path.join(tmpProj, 'f.txt'), 'x\n');
  await g.gitCommit(tmpProj, { message: 'chore: audit' });
  const info = g.gitInfo(tmpProj);
  assert(info.repo && info.hasCommits && ['main', 'master'].includes(info.branch), 'info: ' + JSON.stringify(info));
  assert(g.cleanBranchName('Fix Stuff!') === 'fix-stuff', 'branch clean');
  assert(g.cleanMessage('```\nfeat: x\n```') === 'feat: x', 'message clean');
  return 'init · commit · info · sanitizers';
});

await hard('tools: registry + read tools on disk', async () => {
  const t = await S('tools.js');
  const names = t.enabledTools().map(x => x.name);
  for (const n of ['bash', 'read_file', 'edit_file', 'git_status', 'git_commit', 'web_search', 'create_tool']) {
    assert(names.includes(n), 'missing tool ' + n);
  }
  assert(t.isWriteTool('git_commit') && !t.isWriteTool('git_status'), 'write classification');
  const r = await t.runTool('read_file', { path: 'f.txt' }, { root: tmpProj });
  assert(!r.isError && r.content.includes('x'), 'read_file');
  const g = await t.runTool('git_status', {}, { root: tmpProj });
  assert(!g.isError && /On branch/.test(g.content), 'git_status via runTool');
  return `${names.length} tools enabled · runTool ok`;
});

await hard('projects: register/get/remove', async () => {
  const p = await S('projects.js');
  const proj = p.registerProject({ path: tmpProj, name: 'audit-proj' });
  assert(p.getProject(proj.id)?.path === fs.realpathSync(tmpProj) || p.getProject(proj.id)?.path === tmpProj, 'getProject');
  p.removeProject(proj.id);
  assert(!p.getProject(proj.id), 'remove failed');
  return 'register · get · remove';
});

await hard('agent: session store', async () => {
  const p = await S('projects.js');
  const a = await S('agent.js');
  const proj = p.registerProject({ path: tmpProj, name: 'audit-proj' });
  const s = a.createSession({ projectId: proj.id, modelRef: 'ollama:x', mode: 'read' });
  assert(a.getSession(s.id).mode === 'read', 'get');
  a.updateSession(s.id, { title: 'audited' });
  assert(a.getSession(s.id).title === 'audited', 'update');
  a.deleteSession(s.id);
  p.removeProject(proj.id);
  return 'create · update · delete';
});

// ---------- apps ----------

await hard('chat: store', async () => {
  const c = await S('chat.js');
  const chat = c.createChat({});
  assert(c.getChat(chat.id).id === chat.id, 'get');
  c.updateChat(chat.id, { title: 'audited' });
  assert(c.getChat(chat.id).title === 'audited', 'update');
  c.deleteChat(chat.id);
  return 'create · get · update · delete';
});

await hard('mindmap: store', async () => {
  const m = await S('mindmap.js');
  const map = m.createMap({ name: 'audit map' });
  m.saveMap(map.id, { ...m.getMap(map.id), name: 'audit map 2' });
  assert(m.getMap(map.id).name === 'audit map 2', 'save');
  m.deleteMap(map.id);
  return 'create · save · delete';
});

await hard('research: plan/reflect/report helpers', async () => {
  const r = await S('research.js');
  const plan = r.parsePlan('SUBQUESTIONS:\n- What is X?\n- How does X compare to Y?\nQUERIES:\nx overview\nx vs y benchmark', 3);
  assert(plan.subs.length === 2 && plan.queries.length === 2, 'parsePlan: ' + JSON.stringify(plan));
  const messy = r.parsePlan('1. "query one here"\n2. query two here', 3);
  assert(messy.queries.length === 2 && messy.subs.length === 0, 'parsePlan fallback');
  const refl = r.parseReflect('COVERED: What is X?\nGAP: comparison to Y — no benchmarks\nQUERIES:\nx vs y speed', 3);
  assert(refl.covered === 1 && refl.gaps.length === 1 && refl.queries.length === 1 && !refl.done, 'parseReflect');
  assert(r.parseReflect('COVERED: a\nCOVERED: b\nDONE', 3).done, 'parseReflect DONE');
  const kw = r.keywords('How does Rust compare to Go for web servers?');
  assert(kw.includes('rust') && !kw.includes('how'), 'keywords');
  assert(r.relevance({ title: 'Rust vs Go performance', url: 'https://x.org/a' }, kw) > 0, 'relevance');
  return 'parsePlan · parseReflect · keywords · relevance';
});

await hard('jobs: pipeline store', async () => {
  const j = await S('jobs.js');
  const job = j.addJob({ title: 'Audit Engineer', company: 'ACME', url: 'https://example.com/job1' });
  j.updateJob(job.id, { status: 'applied' });
  assert(j.getJob(job.id).status === 'applied', 'stage move');
  assert(j.stats().total >= 1, 'stats');
  j.deleteJob(job.id);
  return 'add · stage · stats · delete';
});

await hard('jobsource: listing-page classifier', async () => {
  const js = await S('jobsource.js');
  assert(js.isListingPage('https://jp.indeed.com/jobs?q=x', '541 Data Center jobs in Tokyo'), 'listing missed');
  assert(!js.isListingPage('https://example.com/careers/senior-engineer', 'Senior Engineer — ACME'), 'posting misflagged');
  return 'index-page vs posting';
});

await hard('profile + platforms: stores', async () => {
  const pr = await S('profile.js');
  pr.saveProfile({ name: 'Audit Person', skills: ['node'] });
  assert(pr.getProfile().name === 'Audit Person', 'profile save');
  assert(typeof pr.completeness() === 'number' || typeof pr.completeness() === 'object', 'completeness');
  const pl = await S('platforms.js');
  assert(pl.listPlatforms().length >= 8, 'platform directory seeded');
  return 'profile roundtrip · platform directory';
});

await hard('llm: sampling + context budgets', async () => {
  const l = await S('llm.js');
  const cfg = await S('config.js');
  const anth = l.samplingParams('anthropic', { temperature: 3, stop: ['x'] });
  assert(anth.temperature === 1 && Array.isArray(anth.stop_sequences), 'anthropic clamp/stop');
  const oai = l.samplingParams('openai', {});
  assert(!('top_k' in oai), 'openai sends unset knobs');
  const b = cfg.contextBudget({ modelRef: 'ollama:x', wantOutput: 16000 });
  assert(b.maxTokens < 16000 && b.inputChars > 10000, 'local budget shape');
  assert(cfg.contextBudget({ modelRef: 'anthropic:x' }).inputChars === 600_000, 'anthropic budget');
  return 'sampling mapping · context budgets';
});

await hard('notify: webhook validation', async () => {
  const n = await S('notify.js');
  await n.sendDiscord('x').then(
    () => { throw new Error('sendDiscord succeeded with no webhook configured'); },
    () => { });
  return 'unconfigured webhook rejects';
});

// ---------- environment-dependent (reported, never failed) ----------

await soft('env: model providers', async () => {
  const l = await S('llm.js');
  const models = await l.listModels();
  if (!models.length) throw new Error('no providers reachable (Ollama down, no Anthropic key, no custom)');
  return `${models.length} models across providers`;
});

await soft('env: SearXNG web search', async () => {
  const t = await S('tools.js');
  const s = await t.searxngStatus();
  if (!s.up) throw new Error(`not answering at ${s.url || '(unset)'} — web_search falls back to DuckDuckGo`);
  return 'up at ' + s.url;
});

await soft('env: GitHub auth', async () => {
  const gh = await S('github.js');
  const { token, via } = gh.resolveToken();
  if (!token) throw new Error('no gh CLI login and no PAT in Settings');
  const st = await gh.status();
  return `@${st.user.login} via ${via}`;
});

await soft('env: weather (Open-Meteo reachability)', async () => {
  const w = await S('weather.js');
  const g = await w.geocode('Tokyo');
  if (!g.length) throw new Error('geocode returned nothing');
  return 'geocoding reachable';
});

await soft('env: terminal (node-pty)', async () => {
  await S('terminal.js');
  const havePty = await import('node-pty').then(() => true, () => false);
  if (!havePty) throw new Error('node-pty not installed — Terminal app disabled');
  return 'node-pty present';
});

await soft('env: mail account', async () => {
  const m = await S('mail.js');
  const st = m.mailStatus();
  if (!st.configured) throw new Error('IMAP not configured');
  return `configured (${st.host || 'host set'})`;
});

// ---------- report ----------

fs.rmSync(tmpData, { recursive: true, force: true });
fs.rmSync(tmpVault, { recursive: true, force: true });
fs.rmSync(tmpProj, { recursive: true, force: true });

const pad = (s, n) => String(s).padEnd(n);
const W = Math.max(...results.map(r => r.area.length)) + 2;
console.log('\n' + pad('AREA', W) + pad('STATE', 7) + 'DETAIL');
console.log('-'.repeat(W + 60));
for (const r of results) {
  const mark = r.state === 'pass' ? '✓ pass' : r.state === 'env' ? '– env ' : '✗ FAIL';
  console.log(pad(r.area, W) + pad(mark, 7) + r.detail);
}
const fails = results.filter(r => r.state === 'FAIL');
const envs = results.filter(r => r.state === 'env');
console.log('-'.repeat(W + 60));
console.log(`${results.length - fails.length - envs.length} passed · ${envs.length} environment-dependent · ${fails.length} FAILED\n`);
process.exit(fails.length ? 1 : 0);
