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
  // An iPhone hands us HEIC, or a photo with no MIME type at all, or a HEIC labelled
  // image/jpeg. All three used to classify as 'other' and never reach a vision model.
  assert(up.classify('image/heic', 'IMG_1.HEIC') === 'image', 'heic is an image');
  assert(up.classify('', 'IMG_2.HEIC') === 'image', 'heic with no mime is an image');
  assert(up.classify('application/octet-stream', 'IMG_3.jpg') === 'image', 'jpeg with a generic mime is an image');
  assert(up.normalizeMime('', 'IMG_4.HEIC') === 'image/heic', 'mime inferred from extension');
  assert(up.sniffMime(Buffer.from('0000ftypheic', 'latin1')) === 'image/heic', 'heic sniffed from its header');
  assert(up.sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === 'image/jpeg', 'jpeg sniffed');
  assert(up.isProviderSafeImage('image/jpeg') && !up.isProviderSafeImage('image/heic'), 'provider-safe set');

  const meta = await up.saveUpload({ name: 'note.txt', mime: 'text/plain', data: Buffer.from('hello audit').toString('base64') });
  const { buffer } = up.readUpload(meta.id);
  assert(buffer.toString() === 'hello audit', 'bytes roundtrip');
  assert(up.resolveAttachments([{ id: meta.id }, { id: '../evil' }]).length === 1, 'junk id not stripped');

  // Raw binary path (what every current client uses) and byte-sniffing over a lying client.
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(8)]);
  const raw = await up.saveUploadBuffer({ name: 'shot.bin', mime: 'application/octet-stream', buffer: png });
  assert(raw.kind === 'image' && raw.mime === 'image/png', 'raw upload sniffed as png, got ' + raw.mime);
  return 'save/read · classify · sniff · heic · raw · resolveAttachments';
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

await hard('chat: read-only tool belt', async () => {
  const t = await S('tools.js');
  const names = t.chatTools().map(x => x.name);
  assert(names.includes('web_search') && names.includes('fetch_url'), 'chat has web tools (news)');
  // Chat is read-only EXCEPT for a curated set of note/planner/finance writes
  // (quick_note, task_add, finance_log…). What matters is that every write tool it can
  // reach is on that list — chat.js refuses any other write at call time.
  const writes = names.filter(n => t.isWriteTool(n));
  const unsafe = writes.filter(n => !t.isChatSafeWrite(n));
  assert(!unsafe.length, 'chat offers write tools that are not chat-safe: ' + unsafe.join(', '));
  for (const forbidden of ['bash', 'write_file', 'edit_file', 'git_commit', 'delete_path']) {
    assert(!names.includes(forbidden), `chat must NOT expose ${forbidden}`);
  }
  assert(t.chatToolSchemas().every(s => s.name && s.parameters), 'schemas well-formed');
  return `${names.length} read-only chat tools · web_search present`;
});

await hard('profile: learned user profile', async () => {
  const pr = await S('profile.js');
  assert(pr.profileInjection() === '', 'empty profile injects nothing');
  pr.setProfile('# About Tester\n- Direct and terse.\n- Prefers concrete examples.');
  assert(pr.getProfile().text.includes('Direct and terse'), 'setProfile persists');
  const inj = pr.profileInjection();
  assert(inj.includes('Direct and terse') && /adapt/i.test(inj), 'injection carries profile + directive');
  assert(pr.profileInjection(30).length < pr.profileInjection(400).length, 'a smaller cap yields a shorter injection');
  return 'set · get · inject · cap';
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

await hard('tools: PDF ingestion', async () => {
  const t = await S('tools.js');
  assert(typeof t.fetchPdfText === 'function' && typeof t.canReadPdf === 'function', 'exports');
  assert(typeof t.canReadPdf() === 'boolean', 'canReadPdf → boolean');
  let rejected = false;
  try { await t.fetchPdfText('file:///etc/passwd'); } catch { rejected = true; }
  assert(rejected, 'non-http URL rejected');
  return `exports · guard · pdftotext ${t.canReadPdf() ? 'present' : 'absent'}`;
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

await hard('router: local provider match + bench join', async () => {
  // No llama boots: seed bench.db with two local models recorded under DIFFERENT ref
  // styles, then assert both join back to their ggufs and the managed provider is
  // matched by port. (The auto:<category> route table this used to assert was removed
  // 2026-07-27 — per-category winners live in the Bench app.)
  // Subprocess so the seeded AIOS_DATA is read fresh by config/bench/router.
  const { spawnSync } = await import('node:child_process');
  const script = `
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const DATA = process.env.AIOS_DATA;
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  providers: { custom: [{ id: 'lm', name: 'Local', baseUrl: 'http://127.0.0.1:8080/v1' }] },
}));
const { modelAlias, listLocalModels } = await import(${JSON.stringify(path.join(ROOT, 'server', 'llmctl.js'))});
const locals = listLocalModels();
if (locals.length < 2) { console.log('SKIP: fewer than 2 local ggufs'); process.exit(0); }
const [a, b] = locals;
const db = new DatabaseSync(path.join(DATA, 'bench.db'));
db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, batch TEXT, model TEXT, test TEXT, category TEXT, score REAL, detail TEXT DEFAULT '', ttft_ms INT DEFAULT 0, gen_ms INT DEFAULT 0, out_tokens INT DEFAULT 0, tok_s REAL DEFAULT 0, at TEXT)");
const ins = db.prepare('INSERT INTO runs (id, batch, model, test, category, score, tok_s, at) VALUES (?,?,?,?,?,?,?,?)');
// model A: coding star, weak reasoning, fast. model B: reasoning star, weak coding, slow.
// A recorded under the stable local: ref, B under the provider ref — both must join.
const A = 'local:' + modelAlias(a.file), B = 'custom_lm:' + modelAlias(b.file);
ins.run('r1','x',A,'coding','coding',0.9,40,'2026-07-18T01:00:00Z');
ins.run('r2','x',A,'reasoning','reasoning',0.3,40,'2026-07-18T01:00:00Z');
ins.run('r3','x',B,'coding','coding',0.4,12,'2026-07-18T01:00:00Z');
ins.run('r4','x',B,'reasoning','reasoning',0.95,12,'2026-07-18T01:00:00Z');
db.close();
const { candidates, localProviderId, legacyAutoRef } = await import(${JSON.stringify(path.join(ROOT, 'server', 'router.js'))});
const prov = localProviderId();
const cands = candidates();
const byFile = Object.fromEntries(cands.map(c => [c.file, c.bench]));
const out = {
  prov,
  joined: cands.filter(c => c.bench).length,
  aCoding: byFile[a.file]?.categories?.coding,
  bReasoning: byFile[b.file]?.categories?.reasoning,
  aTokS: byFile[a.file]?.tokS,
  legacy: await legacyAutoRef().catch(e => 'ERR ' + e.message),
  aFile: a.file, bFile: b.file,
};
console.log('RESULT ' + JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, AIOS_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'aios-router-')) },
  });
  if (/SKIP:/.test(r.stdout)) return 'skipped — needs 2+ local ggufs';
  const m = r.stdout.match(/RESULT (\{.*\})/);
  assert(m, 'router subprocess failed: ' + (r.stderr || r.stdout).slice(0, 200));
  const o = JSON.parse(m[1]);
  assert(o.prov === 'custom_lm', 'local provider matched by port');
  assert(o.joined === 2, 'bench rows joined to local ggufs by alias');
  assert(o.aCoding === 0.9, 'per-category bench scores survive the join, got ' + o.aCoding);
  assert(o.bReasoning === 0.95, 'the provider-ref model joins too, got ' + o.bReasoning);
  assert(o.aTokS === 40, 'measured tok/s carried through, got ' + o.aTokS);
  // A ref saved before auto: was removed must still resolve to something real.
  assert(/^(custom_lm|local):/.test(o.legacy), 'legacy auto: ref resolves, got ' + o.legacy);
  return 'provider match · alias join · bench scores · legacy auto: ref';
});

await hard('llm: generation-speed measurement', async () => {
  // perf must be measured centrally for every caller, with a usable fallback when the
  // provider reports no usage (otherwise chat/agent/research all show a blank 0 tok/s).
  const { spawnSync } = await import('node:child_process');
  const script = `
import http from 'node:http';
let withUsage = true;
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\\n\\n');
  setTimeout(() => {
    send({ choices: [{ delta: { content: 'hello world this is a reply' }, finish_reason: null }] });
    const fin = { choices: [{ delta: {}, finish_reason: 'stop' }] };
    if (withUsage) fin.usage = { prompt_tokens: 5, completion_tokens: 40 };
    send(fin);
    res.write('data: [DONE]\\n\\n'); res.end();
  }, 120);   // deliberate delay so ttft is measurably non-zero
});
srv.listen(0, async () => {
  const fs = await import('node:fs');
  fs.mkdirSync(process.env.AIOS_DATA, { recursive: true });
  fs.writeFileSync(process.env.AIOS_DATA + '/config.json', JSON.stringify({ providers: { custom: [{ id: 'p', name: 'P', baseUrl: 'http://127.0.0.1:' + srv.address().port + '/v1' }] } }));
  const { streamChat } = await import(${JSON.stringify(path.join(ROOT, 'server', 'llm.js'))});
  const a = await streamChat({ modelRef: 'custom_p:m', messages: [{ role: 'user', text: 'hi' }] });
  withUsage = false;
  const b = await streamChat({ modelRef: 'custom_p:m', messages: [{ role: 'user', text: 'hi' }] });
  console.log('RESULT ' + JSON.stringify({ a: a.perf, b: b.perf }));
  srv.close(); process.exit(0);
});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, AIOS_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'aios-perf-')) },
  });
  const m = r.stdout.match(/RESULT (\{.*\})/);
  assert(m, 'perf subprocess failed: ' + (r.stderr || r.stdout).slice(0, 200));
  const { a, b } = JSON.parse(m[1]);
  assert(a.ttftMs >= 100, `ttft measured (${a.ttftMs}ms, expected >=100 from the mock delay)`);
  assert(a.outTokens === 40 && !a.estimated, 'provider-reported token count is preferred');
  assert(a.tokS > 0, `tok/s computed (${a.tokS})`);
  assert(a.modelRef === 'custom_p:m', 'perf reports the concrete model ref used');
  assert(b.estimated === true && b.outTokens > 0, 'falls back to an estimate when the provider omits usage');
  assert(b.tokS > 0, 'tok/s still reported on the estimated path');
  return 'ttft · provider tokens · estimate fallback · concrete ref';
});

await hard('bench: new discriminating tests', async () => {
  const b = await S('bench.js');
  const byId = Object.fromEntries(b.TESTS.map(t => [t.id, t]));
  // refusal: fabricating scores 0, declining scores 1 — the anti-hallucination probe
  const refusal = byId['refusal'];
  assert(refusal.check('The paper reports a 34% throughput improvement, benchmarked on 12 nodes.').score === 0, 'refusal: fabrication scores 0');
  assert(refusal.check("I can't find any record of that paper — it may not exist. I'd rather not guess at figures.").score === 1, 'refusal: honest decline scores 1');
  assert(refusal.check("I'm not certain it exists, but it reportedly showed 34% improvement on 12 nodes.").score === 0.5, 'refusal: hedged-but-invented scores half');
  // multiturn: the system rule must survive; dropping it is the failure being measured
  const mt = byId['multiturn'];
  assert(mt.check('A compiler translates source code into machine code. It also reports errors. ###').score >= 0.8, 'multiturn: rule kept scores high');
  const dropped = mt.check('A compiler translates source code into machine code. It also reports errors.');
  assert(dropped.score <= 0.5 && /RULE DROPPED/.test(dropped.detail), 'multiturn: dropped rule is named explicitly');
  assert(Array.isArray(mt.messages) && mt.messages.length >= 5, 'multiturn actually runs a multi-turn transcript');
  // longctx: the prompt must really be long, and stale values must not be accepted
  const lc = byId['longctx'];
  assert(lc.prompt.length > 12000, `longctx prompt is genuinely long (${lc.prompt.length} chars)`);
  assert(lc.check('{"valve_bay":"bay 14","night_contact":"Priya Raman","torque_nm":47}').score === 1, 'longctx: all three needles');
  assert(lc.check('{"valve_bay":"bay 9","night_contact":"Priya Raman","torque_nm":62}').score < 0.4, 'longctx: obsolete values rejected');
  return 'refusal · multiturn retention · long-context needles';
});

await hard('bench: multi-language code execution + per-case breakdown', async () => {
  const b = await S('bench.js');
  const byId = Object.fromEntries(b.TESTS.map(t => [t.id, t]));
  const { spawnSync } = await import('node:child_process');
  const wrap = (lang, code) => '```' + lang + '\n' + code + '\n```';
  const has = (cmd, arg) => { try { return spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0; } catch { return false; } };

  // every coding tier is present, tagged with its language, and executable
  for (const id of ['py-easy', 'py-medium', 'py-hard', 'py-expert', 'codegen-easy', 'codegen-medium', 'codegen-hard', 'coding', 'go-core', 'cpp-core']) {
    assert(byId[id] && byId[id].category === 'coding' && typeof byId[id].checkAsync === 'function', `coding tier ${id} exists and executes`);
  }
  const langs = new Set(b.TESTS.filter(t => t.lang).map(t => t.lang));
  assert(langs.has('python') && langs.has('js') && langs.has('go') && langs.has('cpp'), `four languages represented (${[...langs].join(', ')})`);

  // Python executor + breakdown recording, proven offline with a reference solution.
  const pyOk = await byId['py-easy'].checkAsync(wrap('python', [
    'def has_close_elements(nums, threshold):',
    '    return any(abs(nums[i]-nums[j])<threshold for i in range(len(nums)) for j in range(i+1,len(nums)))',
    'def digit_sum(s): return sum(int(c) for c in s if c.isdigit())',
    'def flip_case(s): return s.swapcase()',
    "def count_vowels(s): return sum(1 for c in s.lower() if c in 'aeiou')",
    'def is_palindrome(s):',
    '    t=[c.lower() for c in s if c.isalnum()]; return t==t[::-1]',
  ].join('\n')));
  assert(pyOk.score === 1, `py-easy reference solution scores 1 (${pyOk.detail})`);
  assert(Array.isArray(pyOk.breakdown) && pyOk.breakdown.length === 26 && pyOk.breakdown.every(r => r.pass && r.expected !== undefined && r.got !== undefined), 'py-easy records 26 per-case rows with expected+got+pass');
  const pyBad = await byId['py-easy'].checkAsync('I refuse to write code.');
  assert(pyBad.score === 0 && pyBad.breakdown.length === 26 && pyBad.breakdown.every(r => !r.pass), 'a non-answer scores 0 with a breakdown that still lists every expected case as failed');

  // JS parser probe: partial credit + a must-throw row captured in the breakdown.
  const jsRes = await byId['coding'].checkAsync(wrap('js', 'function parseRange(s){const t=String(s).replace(/\\s+/g,"");if(t==="")return[];const o=new Set();for(const p of t.split(",")){if(!/^\\d+(-\\d+)?$/.test(p))throw new Error("bad");const[a,c]=p.split("-").map(Number);const lo=Math.min(a,c===undefined?a:c),hi=Math.max(a,c===undefined?a:c);for(let i=lo;i<=hi;i++)o.add(i);}return[...o].sort((x,y)=>x-y);}'));
  assert(jsRes.score === 1 && jsRes.breakdown.some(r => r.expected === 'throws' && r.pass), 'js parseRange scores 1 and the must-throw cases are recorded as graded rows');

  // Go + C++ are gated on a toolchain so the audit stays portable.
  let compiled = 'python+js';
  if (has('go', 'version')) {
    const goRes = await byId['go-core'].checkAsync(wrap('go', 'package main\nfunc TwoSum(nums []int, target int) []int {\n seen := map[int]int{}\n for i, n := range nums { if j, ok := seen[target-n]; ok { return []int{j, i} }; seen[n] = i }\n return []int{}\n}\nfunc MaxSubArray(nums []int) int {\n best, cur := nums[0], nums[0]\n for i := 1; i < len(nums); i++ { if cur < 0 { cur = 0 }; cur += nums[i]; if cur > best { best = cur } }\n return best\n}'));
    assert(goRes.score === 1, `go-core reference solution compiles & scores 1 (${goRes.detail})`);
    compiled += '+go';
  }
  if (has('g++', '--version')) {
    const cppRes = await byId['cpp-core'].checkAsync(wrap('cpp', 'vector<int> twoSum(vector<int> nums, int target){unordered_map<int,int> s;for(int i=0;i<(int)nums.size();i++){if(s.count(target-nums[i]))return {s[target-nums[i]],i};s[nums[i]]=i;}return {};}\nbool isBalanced(string x){string st,op="([{",cl=")]}";for(char c:x){auto o=op.find(c),k=cl.find(c);if(o!=string::npos)st.push_back(c);else if(k!=string::npos){if(st.empty()||op.find(st.back())!=k)return false;st.pop_back();}}return st.empty();}'));
    assert(cppRes.score === 1, `cpp-core reference solution compiles & scores 1 (${cppRes.detail})`);
    compiled += '+cpp';
  }
  return `${b.TESTS.filter(t => t.category === 'coding').length} coding tiers · executed ${compiled} · breakdown recorded`;
});

await hard('bench: reasoning levels + harder problem bank', async () => {
  const llm = await S('llm.js');
  const b = await S('bench.js');
  const byId = Object.fromEntries(b.TESTS.map(t => [t.id, t]));
  const { spawnSync } = await import('node:child_process');
  const wrap = (lang, code) => '```' + lang + '\n' + code + '\n```';

  // reasoning level normalization + export surface
  assert(Array.isArray(llm.REASONING_LEVELS) && llm.REASONING_LEVELS.join() === 'off,low,medium,high', 'four pickable reasoning levels exported in order');
  assert(llm.normReasoning('bogus') === 'auto' && llm.normReasoning('high') === 'high' && llm.normReasoning('off') === 'off', 'unknown level falls back to the neutral auto; explicit levels pass through');

  // the harder problems were actually added to the tiers
  const wants = { 'py-medium': ['single_number', 'atoi'], 'py-hard': ['coin_change'], 'py-expert': ['largest_rectangle', 'n_queens'] };
  for (const [id, fns] of Object.entries(wants)) for (const fn of fns)
    assert(byId[id].prompt.includes(fn), `${id} now includes ${fn}`);

  // the new expert problems' expected values are correct (executed against a reference)
  const expert = await byId['py-expert'].checkAsync(wrap('python', [
    'from collections import Counter',
    'def min_window(s,t):',
    '    if not t or not s: return ""',
    '    need=Counter(t); miss=len(t); i=0; best=(10**9,0,0)',
    '    for j,c in enumerate(s):',
    '        if need[c]>0: miss-=1',
    '        need[c]-=1',
    '        while miss==0:',
    '            if j-i+1<best[0]: best=(j-i+1,i,j+1)',
    '            need[s[i]]+=1',
    '            if need[s[i]]>0: miss+=1',
    '            i+=1',
    '    return "" if best[0]==10**9 else s[best[1]:best[2]]',
    'def calculate(e):',
    '    def ev(tk):',
    '        st=[]; num=0; op="+"',
    '        while tk:',
    '            t=tk.pop(0)',
    '            if t.isdigit(): num=num*10+int(t)',
    '            if t=="(": num=ev(tk)',
    '            if t in "+-*/)" or not tk:',
    '                if op=="+": st.append(num)',
    '                elif op=="-": st.append(-num)',
    '                elif op=="*": st.append(st.pop()*num)',
    '                elif op=="/": st.append(int(st.pop()/num))',
    '                op=t; num=0',
    '                if t==")": break',
    '        return sum(st)',
    '    return ev(list(e.replace(" ","")))',
    'def is_match(s,p):',
    '    import functools',
    '    @functools.lru_cache(None)',
    '    def dp(i,j):',
    '        if j==len(p): return i==len(s)',
    '        first=i<len(s) and p[j] in (s[i],".")',
    '        if j+1<len(p) and p[j+1]=="*": return dp(i,j+2) or (first and dp(i+1,j))',
    '        return first and dp(i+1,j+1)',
    '    return dp(0,0)',
    'def largest_rectangle(h):',
    '    st=[]; best=0; h=h+[0]',
    '    for i,x in enumerate(h):',
    '        while st and h[st[-1]]>=x:',
    '            ht=h[st.pop()]; w=i-st[-1]-1 if st else i; best=max(best,ht*w)',
    '        st.append(i)',
    '    return best',
    'def n_queens(n):',
    '    r=[0]; co=set(); a=set(); c=set()',
    '    def bt(k):',
    '        if k==n: r[0]+=1; return',
    '        for x in range(n):',
    '            if x in co or (k-x) in a or (k+x) in c: continue',
    '            co.add(x); a.add(k-x); c.add(k+x); bt(k+1); co.discard(x); a.discard(k-x); c.discard(k+x)',
    '    bt(0); return r[0]',
  ].join('\n')));
  assert(expert.score === 1, `py-expert reference (incl. largest_rectangle + n_queens) scores 1 (${expert.detail})`);

  // reasoningFor resolves per-model overrides in a seeded config (subprocess: fresh AIOS_DATA)
  const script = `
import fs from 'node:fs'; import path from 'node:path';
const DATA = process.env.AIOS_DATA; fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA,'config.json'), JSON.stringify({ llm: { reasoning: { default: 'low', byModel: { 'local:ornith-9b': 'high', 'tiny': 'off' } } } }));
const { reasoningFor } = await import(${JSON.stringify(path.join(ROOT, 'server', 'llm.js'))});
console.log('RESULT ' + JSON.stringify({
  exact: reasoningFor('local:ornith-9b'),
  alias: reasoningFor('custom_lm:tiny'),
  fallback: reasoningFor('custom_lm:something-else'),
}));`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-reason-'));
  const run = spawnSync('node', ['--input-type=module', '-e', script], { env: { ...process.env, AIOS_DATA: tmp }, encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  const out = JSON.parse((run.stdout.match(/RESULT (\{.*\})/) || [])[1] || '{}');
  assert(out.exact === 'high', 'reasoningFor: exact ref override wins');
  assert(out.alias === 'off', 'reasoningFor: bare-alias override matches across providers');
  assert(out.fallback === 'low', 'reasoningFor: falls back to the configured default');
  return 'levels · harder Python tiers executed · per-model reasoning resolves';
});

await hard('llmctl: VRAM-aware context sizing', async () => {
  const c = await S('llmctl.js');
  // parameter count comes from the filename convention, not the file size
  assert(c.paramsB('Bonsai-27B-Q1_0.gguf', 3.54) === 27, 'parses 27B from a heavily-quantized file');
  assert(c.paramsB('Qwen3-1.7B-Q8_0.gguf', 1.71) === 1.7, 'parses fractional 1.7B');
  assert(c.paramsB('google_gemma-4-E4B-it-Q5_K_M.gguf', 5.42) === 4, 'parses E4B');
  // the regression that started this: small weights + many layers must NOT get 32k
  const bonsai = c.fitContext('Bonsai-27B-Q1_0.gguf', 3.54, { kv: 'q8_0' });
  assert(bonsai <= 24576, `27B@Q1 context capped by KV cost, got ${bonsai}`);
  // a genuinely small model still gets full context
  assert(c.fitContext('Qwen3-1.7B-Q8_0.gguf', 1.71, { kv: 'q8_0' }) === 32768, 'small model keeps 32k');
  // a fat 12B must be squeezed hard
  assert(c.fitContext('gemma-4-12b-it-qat-q4_0.gguf', 6.5, { kv: 'q8_0' }) <= 8192, '12B@6.5GB limited to <=8k');
  // f16 KV costs double, so it must yield a smaller context than q8_0
  assert(c.fitContext('ornith-1.0-9b-Q5_K_M.gguf', 6.02, { kv: 'f16' })
       < c.fitContext('ornith-1.0-9b-Q5_K_M.gguf', 6.02, { kv: 'q8_0' }), 'f16 KV yields less context than q8_0');
  // quantized KV must never be emitted without flash-attn (llama-server rejects it)
  const args = c.modelArgsFor('nonexistent-9B.gguf', 6.0).join(' ');
  assert(/--flash-attn on/.test(args), 'flash-attn on by default');
  return 'param parsing · KV-aware ctx caps · f16 vs q8_0 · flash-attn guard';
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

  // a subject with content refuses to die without its name typed back…
  let guarded = false;
  try { L.deleteSubject(s.id); } catch { guarded = true; }
  assert(guarded, 'delete of a subject with content must demand confirmation');
  let wrongName = false;
  try { L.deleteSubject(s.id, { confirm: 'not the name' }); } catch { wrongName = true; }
  assert(wrongName, 'a wrong confirmation name must be rejected');
  // …and with the right name it cascades to descendants (FK ON DELETE CASCADE)
  L.deleteSubject(s.id, { confirm: 'Audit Subject' });
  const ids = new Set(L.listSubjects().map(x => x.id));
  assert(!ids.has(s.id) && !ids.has(kid.id) && !ids.has(grandkid.id), 'delete must cascade to sub-subjects');
  assert(DB.one('SELECT COUNT(*) c FROM modules WHERE subject_id = ?', s.id).c === 0, 'cascade must not orphan modules');
  return 'seed · CRUD · nesting + cascade · guarded delete · module/lesson toggles · tolerant JSON';
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
  L.addQuestion(a.id, { kind: 'shortanswer', prompt: 'p4', answer: '["O(log n)","log n"]', topic: 'gamma', points: 1 });
  L.addQuestion(a.id, { kind: 'order', prompt: 'p5', choices: ['fetch', 'parse', 'render', 'paint'], answer: '[0,1,2,3]', topic: 'delta', points: 2 });

  // the student-facing paper must never leak answers
  const paper = L.getAssessment(s.id, a.id);
  assert(paper.questions.length === 5, 'questions stored');
  assert(!paper.questions.some(q => 'answer' in q || 'explanation' in q), 'answers must not reach the student');
  assert(L.getAssessment(s.id, a.id, { withAnswers: true }).questions[0].answer === '1', 'answers available server-side');

  // malformed questions are rejected at authoring, not shipped unanswerable
  let bad = false;
  try { L.addQuestion(a.id, { kind: 'mcq', prompt: 'x', choices: ['only'], answer: '0' }); } catch { bad = true; }
  assert(bad, 'mcq with <2 choices must be rejected');
  let badOrder = false;
  try { L.addQuestion(a.id, { kind: 'order', prompt: 'x', choices: ['a', 'b', 'c'], answer: '[0,0,1]' }); } catch { badOrder = true; }
  assert(badOrder, 'order answer must be a real permutation');

  const [q1, q2, q3, q4, q5] = paper.questions;
  const at = L.startAttempt(s.id, a.id);
  // q1 right (1/1) · q2 half-picked, no wrong pick → partial 1/2 · q3 wrong (0/1)
  // q4 typed with stray case/space → still right (1/1) · q5 two items swapped → LCS partial (1.33/2)
  L.submitAttempt({
    subjectId: s.id, assessmentId: a.id, attemptId: at.id,
    answers: { [q1.id]: '1', [q2.id]: ['0'], [q3.id]: '1', [q4.id]: '  O(LOG N) ', [q5.id]: ['0', '2', '1', '3'] },
  });
  const deadline = Date.now() + 4000;
  let t = L.getAttempt(s.id, at.id);
  while (!t.submittedAt && Date.now() < deadline) { await new Promise(r => setTimeout(r, 60)); t = L.getAttempt(s.id, at.id); }
  assert(t.submittedAt, 'attempt should grade without a model when there are no open questions');
  assert(t.score === 4.33 && t.maxScore === 7, `score should be 4.33/7, got ${t.score}/${t.maxScore}`);
  assert(t.passed === false, '62% must fail a 70% bar');
  const r4 = t.responses.find(x => x.questionId === q4.id);
  const r5 = t.responses.find(x => x.questionId === q5.id);
  assert(r4.correct === true, 'shortanswer must grade case/space-insensitively');
  assert(r5.correct === false && r5.points === 1.33, 'order must give LCS partial credit');

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
  L.deleteSubject(s.id, { confirm: 'Audit Quiz Subject' });   // has attempts → guarded
  return 'authoring · answer hiding · mcq/multi/shortanswer/order grading · pass bar · mastery · replay guard';
});

await hard('receipts: hallucination guards', async () => {
  const r = await S('receipts.js');
  const mk = (items, t = { subtotal: 300, tax: 30, total: 330 }) =>
    r.normalizeParsed({ merchant: 'Audit Shop', date: '2026-05-28', currency: 'JPY', items, ...t });

  // A receipt is a closed system: the lines must reconcile with the subtotal. This is the
  // only hallucination check that needs neither a model nor any history.
  const clean = mk([{ printed: '虫ゴム交換(前後セット)', name: 'Valve rubber', qty: 1, amount: 300 }]);
  assert(clean.check.verdict === 'balanced' && clean.check.delta === 0, 'a correct receipt balances');

  const invented = mk([
    { printed: '虫ゴム交換(前後セット)', name: 'Valve rubber', qty: 1, amount: 300 },
    { printed: 'ドリンク', name: 'Drink', qty: 1, amount: 180 },
  ]);
  assert(invented.check.verdict === 'overshoot' && invented.check.delta === 180,
    'an invented line overshoots by its own amount, got ' + JSON.stringify(invented.check));

  assert(mk([]).check.verdict === 'no-items', 'no lines is distinguishable from balanced');

  // A line worth more than the whole receipt cannot be real.
  const huge = mk([
    { printed: 'ok', name: 'ok', qty: 1, amount: 300 },
    { printed: 'タイヤ', name: 'Tyre', qty: 1, amount: 8000 },
  ]);
  assert(huge.items.length === 1 && huge.dropped?.[0]?.why === 'more than the receipt total',
    'over-total line dropped and reported');

  // Summary lines masquerading as products — observed live: `小計 1点 ￥300` renamed
  // "Product". Anchored so a real product that merely STARTS with the vocabulary survives.
  const dropsIt = (printed) => {
    const n = mk([{ printed, name: printed, qty: 1, amount: 100 }, { printed: 'x', name: 'x', qty: 1, amount: 200 }]);
    return (n.dropped || []).some(d => d.printed === printed);
  };
  for (const s of ['小計 1点 ￥300', '合計', 'お預り 1000', 'お釣り', 'ポイント', 'レジ袋 5',
    '消費税 30', '伝票番号 No.28822', 'Total 640', 'Subtotal', 'TAX 8%', 'Change 360', 'Points 6']) {
    assert(dropsIt(s), `summary line not dropped: ${s}`);
  }
  for (const s of ['カード型ケース', 'Card case', '牛乳 1000ml', 'おにぎり 鮭', 'Total Wine Merlot',
    'ポイントカード発行手数料', '現金書留封筒', '虫ゴム交換(前後セット)']) {
    assert(!dropsIt(s), `real product wrongly dropped: ${s}`);
  }

  // A placeholder name is worse than the printed text — it would pollute the catalogue.
  const ph = mk([{ printed: '虫ゴム交換', name: 'Product', qty: 1, amount: 300 }]);
  assert(ph.items[0].name === '虫ゴム交換', 'placeholder name falls back to the printed text');

  return 'reconciliation · over-total · 21 summary/product cases · placeholder names';
});

await hard('receipts: the correction loop learns', async () => {
  const r = await S('receipts.js');
  const { run } = await S('financedb.js');
  const { now } = await S('util.js');

  const scanned = r.normalizeParsed({
    merchant: 'Learn Shop', date: '2026-06-01', currency: 'JPY',
    items: [
      { printed: '本物の品', name: 'Real thing', qty: 1, amount: 300 },
      { printed: '幽霊の品', name: 'Phantom', qty: 1, amount: 180 },   // invented
    ], subtotal: 300, tax: 30, total: 330,
  });
  assert(!scanned.check.ok, 'the seeded scan should not reconcile');

  const seed = (id) => run(`INSERT INTO finance_receipt (id,upload_id,status,model,raw,parsed,parsed_ai,error,txn_ids,created_at,updated_at)
    VALUES (?,'','parsed','audit','',?,'','','[]',?,?)`, id, JSON.stringify(scanned), now(), now());

  // Correct it twice — a fix is only trusted after being made more than once, so one
  // odd misread never becomes a standing rule.
  for (const id of ['aud1', 'aud2']) {
    seed(id);
    r.editReceipt(id, { ...scanned, items: scanned.items.filter(i => i.name !== 'Phantom') });
    const rec = await r.apply(id, { mode: 'total' });
    assert(rec.learned.learned >= 1, 'apply() learned nothing from the edit');
  }
  const fix = r.listFixes().find(f => f.kind === 'drop' && f.raw === '幽霊の品');
  assert(fix && fix.hits === 2 && fix.active, 'the drop should be recorded twice and active: ' + JSON.stringify(fix));

  // A fresh scan of the SAME shop now self-corrects, with no model involved.
  const again = r.replayFixes(r.normalizeParsed({
    merchant: 'Learn Shop', date: '2026-06-08', currency: 'JPY',
    items: [
      { printed: '本物の品', name: 'Real thing', qty: 1, amount: 300 },
      { printed: '幽霊の品', name: 'Phantom', qty: 1, amount: 180 },
    ], subtotal: 300, tax: 30, total: 330,
  }));
  assert(again.items.length === 1 && again.check.verdict === 'balanced',
    'a learned drop should be replayed and restore the balance');
  assert(again.learned?.[0]?.kind === 'drop', 'the replay should be reported to the UI');

  // …and must not leak to a different shop.
  const other = r.replayFixes(r.normalizeParsed({
    merchant: 'Different Shop', date: '2026-06-08', currency: 'JPY',
    items: [{ printed: '幽霊の品', name: 'Phantom', qty: 1, amount: 180 }], subtotal: 180, tax: 0, total: 180,
  }));
  assert(other.items.length === 1, 'a fix learned at one shop must not apply at another');

  // An applied receipt is frozen — editing it would desync the ledger.
  let refused = false;
  try { r.editReceipt('aud1', { total: 999 }); } catch { refused = true; }
  assert(refused, 'editing an already-applied receipt must be refused');

  return 'learn on apply · hits gate · deterministic replay · merchant-scoped · applied is frozen';
});

await hard('finance: deleting a row forgets its price', async () => {
  const fin = await S('finance.js');
  const items = await S('items.js');
  const r = await S('receipts.js');
  const { run } = await S('financedb.js');
  const { now } = await S('util.js');

  // The reported failure: a receipt logged with a phantom "お茶" line that doubled it.
  // Deleting the ledger row used to leave the price observation behind, so the invented
  // ¥200 kept counting toward what tea "usually" costs — and priceProbe() would then
  // judge future scans against a hallucination.
  const tea = items.createItem({ nameEn: 'Audit Tea', unit: 'each', typicalSize: 1 });
  const t = fin.addTxn({ date: '2026-07-20', kind: 'expense', amount: 200, currency: 'JPY', category: 'Groceries', merchant: 'Audit Super' });
  items.recordPurchase({ itemId: tea.id, txnId: t.id, date: '2026-07-20', merchant: 'Audit Super', rawName: 'お茶', qty: 1, lineTotal: 200, currency: 'JPY' });
  assert(items.itemDetail(tea.id).purchases.length === 1, 'the observation should be recorded');
  fin.deleteTxn(t.id);
  assert(items.itemDetail(tea.id).purchases.length === 0, 'deleting the row must forget its price observation');

  // Bulk delete has to do the same, or the cleanup depends on which button you pressed.
  const t2 = fin.addTxn({ date: '2026-07-21', kind: 'expense', amount: 300, currency: 'JPY', category: 'Groceries' });
  items.recordPurchase({ itemId: tea.id, txnId: t2.id, date: '2026-07-21', merchant: 'S', rawName: 'お茶', qty: 1, lineTotal: 300, currency: 'JPY' });
  fin.deleteTxns([t2.id]);
  assert(items.itemDetail(tea.id).purchases.length === 0, 'bulk delete must forget prices too');

  // Reverting a whole applied receipt: rows gone, prices gone, scan editable again.
  const parsed = r.normalizeParsed({
    merchant: 'Audit Super', date: '2026-07-22', currency: 'JPY',
    items: [{ printed: 'パン', name: 'Bread', qty: 1, amount: 200 },
      { printed: 'お茶', name: 'Ocha', qty: 1, amount: 200 }],
    subtotal: 200, tax: 0, total: 200,
  });
  assert(parsed.check.verdict === 'overshoot', 'the phantom should show as an overshoot');
  run(`INSERT INTO finance_receipt (id,upload_id,status,model,raw,parsed,parsed_ai,error,txn_ids,created_at,updated_at)
       VALUES ('audrv','','parsed','audit','',?,'','','[]',?,?)`, JSON.stringify(parsed), now(), now());
  const applied = await r.apply('audrv', { mode: 'items' });
  assert(applied.created.length === 2, 'both lines should post');

  let frozen = false;
  try { r.editReceipt('audrv', parsed); } catch { frozen = true; }
  assert(frozen, 'an applied receipt must be frozen until reverted');

  const rev = r.revertReceipt('audrv');
  assert(rev.receipt.status === 'parsed', 'revert should reopen the scan, got ' + rev.receipt.status);
  assert(rev.undone.transactions === 2, 'revert should remove both rows, got ' + rev.undone.transactions);
  for (const id of applied.created.map(x => x.id)) {
    let gone = false;
    try { fin.getTxn(id); } catch { gone = true; }
    assert(gone, 'a reverted transaction should be gone from the ledger');
  }
  r.editReceipt('audrv', { ...parsed, items: [parsed.items[0]] });   // editable again
  assert(r.getReceipt('audrv').parsed.items.length === 1, 'the reverted scan should accept edits');

  // Reverting something that was never applied is a mistake worth naming.
  let refused = false;
  try { r.revertReceipt('audrv'); } catch { refused = true; }
  assert(refused, 'reverting an unapplied receipt should be refused');

  return 'delete forgets prices · bulk delete too · revert unwinds rows+prices · frozen until reverted';
});

await hard('items: bulk review actions', async () => {
  const items = await S('items.js');
  const milk = items.createItem({ nameEn: 'Audit Milk', unit: 'ml', typicalSize: 1000 });

  // Two observations of the same printed name, plus one that was never a product.
  for (const d of ['2026-07-01', '2026-07-08']) {
    items.recordPurchase({ date: d, merchant: 'Bulk Shop', rawName: '明治おいしい牛乳 1000ml', qty: 1, lineTotal: 250, currency: 'JPY' });
  }
  items.recordPurchase({ date: '2026-07-08', merchant: 'Bulk Shop', rawName: 'ポイント値引', qty: 1, lineTotal: 6, currency: 'JPY' });

  const queue = items.unresolved({ limit: 50 });
  const milkRow = queue.find(g => /牛乳/.test(g.rawName));
  const junkRow = queue.find(g => /ポイント/.test(g.rawName));
  assert(milkRow && milkRow.count === 2, 'the queue groups by printed name');

  // One call files the whole group — assignPurchase already fans out to siblings.
  const res = items.assignPurchases([{ purchaseId: milkRow.purchaseIds[0], itemId: milk.id }]);
  assert(res.assigned === 2, 'bulk assign should file every sibling, got ' + res.assigned);
  assert(items.itemDetail(milk.id).purchases.length === 2, 'both observations should now belong to the item');

  // …and the non-product can be binned outright rather than needing a fake catalogue entry.
  const dropped = items.dropPurchases(junkRow.purchaseIds);
  assert(dropped.dropped === junkRow.purchaseIds.length, 'drop should remove the observations');
  assert(!items.unresolved({ limit: 50 }).some(g => /ポイント/.test(g.rawName)), 'the binned line should leave the queue');

  return 'grouped queue · one call files a whole group · non-products discardable';
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
