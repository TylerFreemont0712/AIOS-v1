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

await hard('mail: parser units + notification rules', async () => {
  const m = await S('mail.js');
  const crit = m.searchCriteria('from:alice subject:"weekly report" is:unread hello', 7);
  assert(/FROM/.test(crit) && /SUBJECT/.test(crit) && /UNSEEN/.test(crit) && /SINCE/.test(crit), 'searchCriteria: ' + crit);
  assert(m.decodeMimeWords('=?UTF-8?B?44GT44KT44Gr44Gh44Gv?=').includes('こんにちは'), 'RFC2047 B');
  assert(m.findTagLine('A1 OK done\r\n', 'A1'), 'findTagLine');
  assert(m.parseImapDate('09-Jul-2026 08:15:22 +0900') > 0 && m.parseImapDate('junk') === 0, 'parseImapDate');
  assert(m.webmailLink('imap.gmail.com', 'x@y').includes('rfc822msgid') && m.webmailLink('imap.other.com', 'x@y') === '', 'webmailLink');
  // notification composition: read mail drops, starred ≤10d tails newest-first
  const day = (off) => { const d = new Date(Date.now() - off * 86400_000); const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return `${d.getDate()}-${MO[d.getMonth()]}-${d.getFullYear()} 10:00:00 +0000`; };
  const mk = (uid, over) => ({ id: uid + '@h', uid, from: 'x', subject: 's', date: day(1), seen: false, starred: false, important: true, urgency: 'normal', via: 'ai', tv: m.TRIAGE_VERSION, ...over });
  fs.mkdirSync(path.join(tmpData, 'mail'), { recursive: true });
  fs.writeFileSync(path.join(tmpData, 'mail', 'state.json'), JSON.stringify({
    scannedAt: 'x', account: 'a', error: '', dismissed: [],
    messages: [mk(1), mk(2, { seen: true }), mk(3, { important: false, starred: true, seen: true, date: day(4) }), mk(4, { important: false, starred: true, seen: true, date: day(20) })],
  }));
  const out = m.notifications();
  assert(out.items.length === 1 && out.items[0].uid === 1, 'unread-important only');
  assert(out.starred.length === 1 && out.starred[0].uid === 3, 'starred 10-day tail');
  return 'searchCriteria · RFC2047 · findTagLine · dates · links · notification rules';
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
  assert(wiki.noteTemplate('').kinds?.length === 7, 'note kind catalog should list 7 kinds');
  assert(wiki.noteTemplate('decision').template.includes('## Revisit when'), 'decision template sections');
  const rk = wiki.upsertNote({ title: 'Gamma Fix', content: 'symptom and fix', kind: 'troubleshooting' });
  assert(/^type: troubleshooting$/m.test(v.readNote(rk.path).content), 'kind should stamp type: frontmatter');
  wiki.upsertNote({ title: 'Gamma Fix', content: 'symptom and fix v2' });
  assert(/^type: troubleshooting$/m.test(v.readNote(rk.path).content), 'type should survive an untyped update');
  return 'upsert · autolink · recall · Home index · search · typed notes';
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

await hard('git: nested repo guard + push/pull (local remotes)', async () => {
  const g = await S('git.js');
  const gh = await S('github.js');
  const run = (cwd, args) => g.runGit(cwd, args);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-audit-git-'));

  // --- nested repo guard: the "AIOS-v1/ does not have a commit" failure mode
  const work = path.join(base, 'work');
  fs.mkdirSync(path.join(work, 'inner'), { recursive: true });
  await g.gitInit(work);
  fs.writeFileSync(path.join(work, 'a.txt'), '1\n');
  await run(path.join(work, 'inner'), ['init']);
  assert(g.nestedRepos(work).includes('inner'), 'nested repo detected');
  let blocked = '';
  try { await g.gitCommit(work, { message: 'x' }); } catch (e) { blocked = e.message; }
  assert(/nested inside/.test(blocked) && /\.gitignore/.test(blocked), 'commit blocked with actionable message');
  fs.writeFileSync(path.join(work, '.gitignore'), 'inner/\n');
  await g.gitCommit(work, { message: 'chore: initial' });   // gitignored nested repo no longer blocks

  // --- push/pull against a local bare remote (no network, no auth path)
  const bare = path.join(base, 'origin.git');
  await run(base, ['init', '--bare', bare]);
  await run(work, ['remote', 'add', 'origin', bare]);
  const p1 = await gh.gitPush(work);
  assert(p1.ok && p1.ahead === 0, 'first push sets upstream');

  // a second clone commits + pushes; our copy must now be rejected with the friendly 409…
  const other = path.join(base, 'other');
  // -b main: a fresh bare repo's HEAD may say "master", which would silently give the
  // clone its own empty branch and the test would push past itself
  await run(base, ['clone', '-b', 'main', bare, other]);
  await run(other, ['config', 'user.email', 'a@b.c']); await run(other, ['config', 'user.name', 'a']);
  fs.writeFileSync(path.join(other, 'b.txt'), '2\n');
  await run(other, ['add', '-A']); await run(other, ['commit', '-m', 'other side']);
  await run(other, ['push']);
  fs.writeFileSync(path.join(work, 'c.txt'), '3\n');
  await g.gitCommit(work, { message: 'chore: local' });
  let rejected = null;
  try { await gh.gitPush(work); } catch (e) { rejected = e; }
  assert(rejected && rejected.status === 409 && /Pull first/i.test(rejected.message), 'behind push → friendly 409');

  // …and pull rebases us cleanly, after which push succeeds
  const pull = await gh.gitPull(work);
  assert(pull.ok && pull.behind === 0, 'pull rebases onto remote');
  const p2 = await gh.gitPush(work);
  assert(p2.ok && p2.ahead === 0, 'push after pull succeeds');

  // --- conflicting pull: rebase must abort and leave the tree exactly as it was
  // (other is behind after work's p2 push — sync it first or ITS push gets rejected
  //  and the conflict never reaches the remote)
  await run(other, ['pull', '--rebase']);
  fs.writeFileSync(path.join(other, 'a.txt'), 'theirs\n');
  await run(other, ['commit', '-am', 'their edit']); await run(other, ['push']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'ours\n');
  await g.gitCommit(work, { message: 'chore: our edit' });
  let conflict = null;
  try { await gh.gitPull(work); } catch (e) { conflict = e; }
  assert(conflict && /conflict/i.test(conflict.message) && /unchanged/i.test(conflict.message), 'conflict → abort + clear message');
  assert(fs.readFileSync(path.join(work, 'a.txt'), 'utf8') === 'ours\n', 'tree untouched after aborted rebase');
  assert((await run(work, ['rebase', '--show-current-patch'])).code !== 0, 'no rebase left in progress');
  return 'nested guard · upstream push · behind→409 · pull-rebase · conflict abort';
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

await hard('llm: stream stall detector', async () => {
  // A provider that wedges mid-stream (socket open, no data, no close) must throw,
  // not hang forever holding locks. Runs in a subprocess because STREAM_STALL_MS is
  // read at module load — the env override can't apply once this process imported llm.js.
  const { spawnSync } = await import('node:child_process');
  const script = `
import http from 'node:http';
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: null }] }) + '\\n\\n');
});
srv.listen(0, async () => {
  const fs = await import('node:fs');
  fs.mkdirSync(process.env.AIOS_DATA, { recursive: true });
  fs.writeFileSync(process.env.AIOS_DATA + '/config.json', JSON.stringify({ providers: { custom: [{ id: 'w', name: 'W', baseUrl: 'http://127.0.0.1:' + srv.address().port + '/v1' }] } }));
  const { streamChat } = await import(${JSON.stringify(path.join(ROOT, 'server', 'llm.js'))});
  try { await streamChat({ modelRef: 'custom_w:m', messages: [{ role: 'user', text: 'hi' }], maxTokens: 10 }); console.log('RESOLVED'); }
  catch (e) { console.log('THREW: ' + e.message); }
  srv.close(); process.exit(0);
});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, AIOS_STREAM_STALL_MS: '1000', AIOS_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'aios-stall-')) },
  });
  assert(/THREW: stream stalled/.test(r.stdout), 'wedged stream must throw, got: ' + (r.stdout || r.stderr).slice(0, 120));
  return 'wedged provider throws instead of hanging';
});

await hard('notify: webhook validation', async () => {
  const n = await S('notify.js');
  await n.sendDiscord('x').then(
    () => { throw new Error('sendDiscord succeeded with no webhook configured'); },
    () => { });
  return 'unconfigured webhook rejects';
});

await hard('context: live app brief', async () => {
  const ctx = await S('context.js');
  const planner = await S('planner.js');
  const today = planner.todayStr();
  const ev = planner.addEvent({ title: 'Audit Standup', date: today, start: '09:00', category: 'work' });
  const bd = planner.addBirthday({ name: 'Audit Friend', month: +today.slice(5, 7), day: +today.slice(8, 10) });
  const brief = ctx.appContext({ chars: 1900, days: 3 });
  assert(/Today/.test(brief) && /Audit Standup/.test(brief), 'today\'s event missing from brief');
  assert(/Audit Friend/.test(brief), 'birthday missing from brief');
  assert(ctx.appContext({ chars: 1900, days: 3 }) === brief, 'deterministic output expected');
  const empty = ctx.appContext({ chars: 50, days: 3 });   // tiny budget still yields a clipped, valid string
  assert(empty.length <= 50, 'char budget not enforced');
  planner.deleteEvent(ev.id); planner.deleteBirthday(bd.id);
  return 'planner/birthday surfaced · char budget enforced';
});

await hard('comfy: sampling plan + workflow builder', async () => {
  const comfy = await S('comfy.js');
  const fast = await comfy.samplingPlan('sdxl_lightning_4step.safetensors', 4);
  assert(fast.mode === 'lightning' && fast.cfg === 1 && !fast.lora, 'lightning ckpt plan wrong');
  const quality = await comfy.samplingPlan('animagine-xl-4.0.safetensors', 8, 'quality');
  assert(quality.mode === 'standard-sdxl' && quality.steps === 28 && quality.cfg === 5, 'quality plan should be Animagine-official 28/cfg5');
  const wf = comfy.txt2imgWorkflow({ checkpoint: 'x.safetensors', prompt: 'a', negative: 'b', width: 1024, height: 1024, steps: 8, cfg: 1, seed: 1, count: 1, hires: true, upscaleModel: '4x-AnimeSharp.pth' });
  assert(wf['13']?.class_type === 'UpscaleModelLoader' && wf['16']?.class_type === 'VAEEncode', 'hi-res pixel-space chain missing');
  assert(wf['9'].inputs.images[0] === '17', 'hi-res save should read from the repaint decode');
  const i2i = comfy.img2imgWorkflow({ checkpoint: 'x.safetensors', prompt: 'a', negative: 'b', width: 896, height: 1152, steps: 28, cfg: 5, seed: 1, count: 2, denoise: 0.55, image: 'src.png' });
  assert(i2i['1']?.class_type === 'LoadImage' && i2i['5']?.class_type === 'VAEEncode', 'img2img load/encode chain missing');
  assert(i2i['3'].inputs.denoise === 0.55 && i2i['3'].inputs.latent_image[0] === '11', 'img2img sampler should repaint the batched source latent');
  const up = comfy.upscaleWorkflow({ image: 'src.png', upscaleModel: '4x-AnimeSharp.pth', scale: 2 });
  assert(up['3']?.class_type === 'ImageUpscaleWithModel' && up['4']?.inputs.scale_by === 0.5 && up['9'].inputs.images[0] === '4', '2x-from-4x-model downscale chain wrong');
  assert(!comfy.upscaleWorkflow({ image: 's.png', upscaleModel: '4x-AnimeSharp.pth', scale: 4 })['4'], 'native 4x should not add a rescale node');
  return 'lightning/quality plans · pixel-space hi-res · img2img · upscale graphs';
});

await hard('learn: subject tree + roadmap/lesson state', async () => {
  const L = await S('learn.js');
  const DB = await S('learndb.js');
  const seeded = L.listSubjects();
  assert(seeded.length >= 1 && seeded.some(s => s.name === 'Programming'), 'first list should seed the Programming subject');
  const s = L.createSubject({ name: 'Audit Subject', goal: 'g', level: 'advanced' });
  assert(L.getSubject(s.id).level === 'advanced', 'create/get');
  L.updateSubject(s.id, { goal: 'g2' });
  assert(L.getSubject(s.id).goal === 'g2', 'update');

  // subjects nest, and the breadcrumb walks back to the root
  const kid = L.createSubject({ name: 'Audit Child', parentId: s.id });
  const grandkid = L.createSubject({ name: 'Audit Grandchild', parentId: kid.id });
  assert(L.getSubject(grandkid.id).path.map(p => p.name).join('>') === 'Audit Subject>Audit Child>Audit Grandchild', 'breadcrumb');
  assert(L.getSubject(s.id).children.length === 1, 'children listed');
  let threw = false;
  try { L.updateSubject(s.id, { parentId: grandkid.id }); } catch { threw = true; }
  assert(threw, 'moving a subject inside its own descendant must be rejected');

  // roadmap/lesson rows live in SQLite now (the JSON store is gone)
  DB.run(`INSERT INTO modules (id, subject_id, idx, title, summary, topics, kind, done, created_at)
          VALUES ('m1', ?, 0, 'M', '', '["t"]', 'standard', 0, ?)`, s.id, new Date().toISOString());
  DB.run(`INSERT INTO lessons (id, subject_id, module_id, n, title, topic, type, content, sources, next, done, model, exported_to, created_at)
          VALUES ('l1', ?, 'm1', 1, 'T', 't', 'standard', 'body', '[]', '[]', 0, '', '', ?)`, s.id, new Date().toISOString());
  L.setModuleDone(s.id, 'm1', true);
  L.setLessonDone(s.id, 'l1', true);
  const after = L.getSubject(s.id);
  assert(after.roadmap.modules[0].done && after.lessons[0].done, 'done toggles');
  assert(!('content' in after.lessons[0]), 'subject payload must not carry lesson bodies');
  assert(L.getLesson(s.id, 'l1').content === 'body', 'getLesson returns the body');

  const j = L.extractJSON('noise {"modules":[{"title":"a","topics":["t",]}]} tail');
  assert(j?.modules?.[0]?.title === 'a', 'extractJSON should survive noise + trailing commas');

  // deleting a parent cascades to descendants (FK ON DELETE CASCADE)
  L.deleteSubject(s.id);
  const ids = new Set(L.listSubjects().map(x => x.id));
  assert(!ids.has(s.id) && !ids.has(kid.id) && !ids.has(grandkid.id), 'delete must cascade to sub-subjects');
  assert(DB.one('SELECT COUNT(*) c FROM modules WHERE subject_id = ?', s.id).c === 0, 'cascade must not orphan modules');
  return 'seed · CRUD · nesting + cascade · module/lesson toggles · tolerant JSON';
});

await hard('learn: lesson health checker', async () => {
  const L = await S('learn.js');
  const body = (extra = '') => `# Lesson 1: Closures\n## Objectives\n- understand closures\n## Practice\n- build a counter\n## Next lesson ideas\n- Currying${extra}`.padEnd(1600, ' More prose here.') + '.';
  const src = [{ n: 1, url: 'https://x.dev', title: 'x' }];

  // A healthy lesson must raise NO errors. This is the assertion that matters most:
  // a checker that flags good lessons trains the user to ignore the badge.
  assert(L.lessonHealth(body(), src).every(i => i.level !== 'error'), 'a well-formed lesson must raise no errors');
  assert(L.healthLevel(L.lessonHealth(body(), src)) !== 'error', 'healthLevel agrees');

  // Markdown legitimately ends on a bullet / table row / fence — none of these are truncation.
  assert(!L.lessonHealth('# L\n## Objectives\n- a\n## Practice\n- b\n## Next lesson ideas\n- Review scoping drills'.padEnd(1600, ' x.') + '\n- a final bullet', src)
    .some(i => /mid-sentence/.test(i.text)), 'a lesson ending on a bullet is not truncation');

  // The real failure this was built for: the model narrates a search instead of writing.
  const narrated = L.lessonHealth("I'll search for current best practices on closures before writing this lesson.".padEnd(1600, ' more.') + '.', src);
  assert(narrated.some(i => i.level === 'error' && /narrat/.test(i.text)), 'narration instead of a lesson must be an error');

  // Truncation shapes
  assert(L.lessonHealth(body() + '\n```js\nconst x = 1;', src).some(i => /unclosed code fence/.test(i.text)), 'unclosed fence detected');
  assert(L.lessonHealth(body() + '\n<details><summary>S</summary>', src).some(i => /unbalanced/.test(i.text)), 'unbalanced details detected');
  assert(L.lessonHealth(body() + '\n\nAnd then the function returns a', src).some(i => /mid-sentence/.test(i.text)), 'prose cut mid-sentence detected');
  assert(L.lessonHealth(body() + '\n\n## A dangling heading', src).some(i => /heading with nothing/.test(i.text)), 'dangling heading detected');
  assert(L.lessonHealth('tiny', src)[0].level === 'error', 'near-empty body is an error');

  // Warnings, not errors — a real lesson missing house style is still a lesson.
  const noSrc = L.lessonHealth(body(), []);
  assert(noSrc.some(i => i.level === 'warn' && /ungrounded/.test(i.text)), 'missing sources is a warning');
  assert(!noSrc.some(i => i.level === 'error'), 'missing sources must not be an error');
  // Section synonyms must be accepted: models write "## Exercises", not always "## Practice".
  assert(!L.lessonHealth('# L\n## Why this lesson\n- a\n## Exercises\n- b\n## Next lesson ideas\n- c.'.padEnd(1600, ' x.') + '.', src)
    .some(i => /no practice|no objectives/.test(i.text)), 'section synonyms accepted');
  return 'clean lessons pass · narration/truncation caught · synonyms accepted · warn vs error split';
});

await hard('learn: assessments, scoring + mastery', async () => {
  const L = await S('learn.js');
  const s = L.createSubject({ name: 'Audit Quiz Subject', level: 'beginner' });

  const a = L.createAssessment({ subjectId: s.id, kind: 'quiz', title: 'Q', passPct: 70 });
  L.addQuestion(a.id, { kind: 'mcq', prompt: 'p1', choices: ['a', 'b', 'c', 'd'], answer: '1', topic: 'alpha', points: 1 });
  L.addQuestion(a.id, { kind: 'multi', prompt: 'p2', choices: ['a', 'b', 'c', 'd'], answer: '[0,2]', topic: 'beta', points: 2 });
  L.addQuestion(a.id, { kind: 'mcq', prompt: 'p3', choices: ['a', 'b'], answer: '0', topic: 'alpha', points: 1 });

  // the student-facing paper must never leak answers
  const paper = L.getAssessment(s.id, a.id);
  assert(paper.questions.length === 3, 'questions stored');
  assert(!paper.questions.some(q => 'answer' in q || 'explanation' in q), 'answers must not reach the student');
  assert(L.getAssessment(s.id, a.id, { withAnswers: true }).questions[0].answer === '1', 'answers available server-side');

  // a malformed mcq (too few choices) is demoted rather than shipped unanswerable
  let bad = false;
  try { L.addQuestion(a.id, { kind: 'mcq', prompt: 'x', choices: ['only'], answer: '0' }); } catch { bad = true; }
  assert(bad, 'mcq with <2 choices must be rejected');

  const [q1, q2, q3] = paper.questions;
  const at = L.startAttempt(s.id, a.id);
  // q1 right (1/1) · q2 half-picked, no wrong pick → partial 1/2 · q3 wrong (0/1)
  L.submitAttempt({ subjectId: s.id, assessmentId: a.id, attemptId: at.id, answers: { [q1.id]: '1', [q2.id]: ['0'], [q3.id]: '1' } });
  const deadline = Date.now() + 4000;
  let t = L.getAttempt(s.id, at.id);
  while (!t.submittedAt && Date.now() < deadline) { await new Promise(r => setTimeout(r, 60)); t = L.getAttempt(s.id, at.id); }
  assert(t.submittedAt, 'attempt should grade without a model when there are no open questions');
  assert(t.score === 2 && t.maxScore === 4, `score should be 2/4, got ${t.score}/${t.maxScore}`);
  assert(t.passed === false, '50% must fail a 70% bar');

  // every graded answer moves per-topic mastery — the adaptive spine
  const weak = L.getWeakTopics(s.id);
  const alpha = weak.find(w => w.topic === 'alpha');
  assert(alpha && alpha.seen === 2 && alpha.correct === 1, 'mastery must tally per topic');
  assert(weak[0].topic === 'beta' || weak[0].ratio <= alpha.ratio, 'weak list sorts worst-first');

  // resubmitting a graded attempt must not double-count
  let dup = false;
  try { L.submitAttempt({ subjectId: s.id, assessmentId: a.id, attemptId: at.id, answers: {} }); } catch { dup = true; }
  assert(dup, 'a submitted attempt cannot be resubmitted');

  L.recordTopicResult(s.id, 'alpha', true);
  assert(L.getWeakTopics(s.id).find(w => w.topic === 'alpha').seen === 3, 'conversational grading moves mastery too');
  L.deleteSubject(s.id);
  return 'authoring · answer hiding · mcq/multi partial credit · pass bar · mastery · replay guard';
});

await hard('llmctl: profiles + launcher config', async () => {
  const llm = await S('llmctl.js');
  const st = llm.llmStatus();
  assert(Array.isArray(st.profiles) && st.profiles.includes('big') && st.profiles.includes('tiny'), 'profiles missing');
  assert(typeof st.managed === 'boolean' && typeof st.foreign === 'boolean', 'status shape');
  await llm.startProfile('nonexistent').then(
    () => { throw new Error('startProfile accepted an unknown profile'); },
    (e) => assert(/unknown llm profile/.test(e.message), 'wrong error for bad profile'));
  return 'big/tiny profiles · unknown rejected';
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
