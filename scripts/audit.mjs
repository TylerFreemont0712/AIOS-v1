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

await hard('mcp: an external server\'s tools join the belt', async () => {
  const mcp = await S('mcp.js');
  const t = await S('tools.js');

  // A minimal MCP server over stdio: handshake, a paginated tools/list, and calls.
  // Written here rather than shipped as a fixture so the audit stays self-contained.
  const stub = path.join(tmpData, 'stub-mcp.mjs');
  fs.writeFileSync(stub, `
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle({ id, method, params }) {
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } });
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    if (!params?.cursor) return send({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'echo', description: 'Echo back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } }
    ], nextCursor: 'p2' } });
    return send({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'mutate', description: 'Unannotated, so it must be gated.', inputSchema: { type: 'object', properties: {} } },
      { name: 'boom', description: 'Fails.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }
    ] } });
  }
  if (method === 'tools/call') {
    const n = params?.name;
    if (n === 'echo') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'echo: ' + params.arguments?.text }] } });
    if (n === 'boom') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'it broke' }], isError: true } });
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no ' + method } });
}
`);

  mcp.saveServer({ id: 'stub', name: 'Stub', transport: 'stdio', command: process.execPath, args: [stub] });
  assert(mcp.listMcpTools().length === 0, 'saving a server must not connect it');

  await mcp.connect('stub');
  const tools = mcp.listMcpTools();
  assert(tools.length === 3, `expected 3 tools across both pages, got ${tools.length}`);
  assert(tools.every(x => x.name.startsWith('stub_')), 'tools must be namespaced by server id');
  assert(tools.every(x => x.group === 'mcp:stub'), 'tools must land in their own lean-loadout group');

  // the belt, the gate, and the directory the model reads
  assert(t.enabledTools().some(x => x.name === 'stub_echo'), 'MCP tools must reach enabledTools');
  assert(t.toolGroups().includes('mcp:stub'), 'the group must be offerable to load_tools');
  assert(!t.isWriteTool('stub_echo'), 'readOnlyHint must skip the approval gate');
  assert(t.isWriteTool('stub_mutate'), 'an UNANNOTATED tool must be gated as a write');
  assert(t.toolCatalog().some(x => x.mcp && x.server === 'stub'), 'Settings must list MCP tools');

  const ok = await t.runTool('stub_echo', { text: 'hi' }, { root: tmpProj });
  assert(!ok.isError && ok.content === 'echo: hi', 'runTool must dispatch to MCP: ' + ok.content);
  const bad = await t.runTool('stub_boom', {}, { root: tmpProj });
  assert(bad.isError && /it broke/.test(bad.content), 'a server-reported error must surface as one');

  // an explicit stop means stopped — no silent respawn behind the user's back
  mcp.stop('stub');
  assert(!t.enabledTools().some(x => x.name === 'stub_echo'), 'a stopped server must leave the belt');
  const gone = await t.runTool('stub_echo', { text: 'x' }, { root: tmpProj });
  assert(gone.isError && /server "stub"/.test(gone.content), 'the error must name the server, not blame the tool');
  assert(mcp.status()[0].status === 'stopped', 'stop() must not be undone by a later call');

  // one broken server must not disturb anything else
  const before = t.enabledTools().length;
  mcp.saveServer({ id: 'nope', transport: 'stdio', command: 'definitely-not-a-real-binary-xyz' });
  await mcp.connect('nope').then(() => { throw new Error('a missing command should not connect'); }, () => { });
  assert(mcp.status().find(s => s.id === 'nope').status === 'down', 'a failed server must report down');
  assert(t.enabledTools().length === before, 'a broken server must not change the belt');

  for (const badCfg of [{}, { id: 'has-dash', command: 'x' }, { id: 'nocmd' }, { id: 'nourl', transport: 'http' }]) {
    let refused = false;
    try { mcp.saveServer(badCfg); } catch { refused = true; }
    assert(refused, `bad config accepted: ${JSON.stringify(badCfg)}`);
  }

  mcp.removeServer('stub'); mcp.removeServer('nope');
  mcp.stopAll();
  return 'stdio handshake · paginated discovery · namespaced · gated by annotation · dispatch · isolated failures';
});

await hard('chat: the belt is lean, not just short', async () => {
  const t = await S('tools.js');
  const pool = t.chatTools();
  const core = t.chatCoreNames();
  const lo = t.leanLoadout({ pool, coreNames: core, activeGroups: [] });
  const chars = (x) => JSON.stringify(x).length;

  // The whole point: a fresh chat pays for a handful of schemas, not all of them.
  assert(lo.tools.length < pool.length / 2, `core is ${lo.tools.length} of ${pool.length} — not lean`);
  assert(chars(lo.tools) + lo.directory.length < chars(pool.map(x => x.parameters)) , 'lean loadout is not smaller than the full one');
  assert(lo.directory.length > 0 && lo.dormantGroups.length > 0, 'nothing was deferred');
  // ~1.5k tokens on a 32k local window; it was ~4.2k before the split.
  const tok = Math.ceil((chars([...lo.tools, t.META_LOAD]) + lo.directory.length) / 4);
  assert(tok < 2200, `per-round tool cost regressed to ~${tok} tokens`);

  // The things a chat does on ANY topic must not cost a round-trip to reach.
  for (const n of ['web_search', 'agenda_view', 'quick_note', 'datetime']) {
    assert(lo.tools.some(x => x.name === n), `${n} should be core — it is needed regardless of topic`);
  }
  // Every dormant tool must be reachable: named in the directory, in a loadable group.
  const dormant = pool.filter(x => !core.has(x.name));
  for (const d of dormant.slice(0, 40)) {
    assert(lo.directory.includes(d.name), `${d.name} is deferred but missing from the directory`);
  }
  // Loading a group actually delivers it.
  const g = lo.dormantGroups[0];
  const after = t.leanLoadout({ pool, coreNames: core, activeGroups: [g] });
  assert(after.tools.length > lo.tools.length, `load_tools on "${g}" delivered nothing`);
  assert(!after.dormantGroups.includes(g), 'a loaded group must leave the directory');

  // activateGroups is what the tool call runs; a typo must teach, not silently no-op.
  const state = {};
  assert(/Activated/.test(t.activateGroups(state, [g], { pool })) && state.toolGroups.includes(g), 'activateGroups did not activate');
  assert(/No valid groups|Unknown/.test(t.activateGroups(state, ['nonsense'], { pool })), 'a bad group name must be explained');
  return `${pool.length} reachable · ${lo.tools.length} core (~${tok} tok/round) · ${lo.dormantGroups.length} groups on demand`;
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

await hard('agent: a long run checkpoints rarely, not every step', async () => {
  const a = await S('agent.js');
  const BUDGET = 30_000;                       // ~18k-token window minus system + tools
  const turn = (bytes) => ([
    { role: 'assistant', text: 'a'.repeat(700), toolCalls: [{ name: 'read_file', args: {} }] },
    { role: 'tools', results: [{ name: 'read_file', content: 'r'.repeat(bytes) }] },
  ]);

  // One user prompt, then 40 tool calls — the long-horizon shape. Count how often
  // compaction would be due; each one costs a model call.
  const dueCount = (bytes) => {
    let transcript = [{ role: 'user', text: 'do the thing' }], due = 0;
    for (let t = 0; t < 40; t++) {
      if (a.fitHistory({ transcript }, BUDGET).lossy) {
        due++;
        const cut = a.checkpointCut(transcript, BUDGET * 0.35);
        transcript = [{ role: 'user', kind: 'checkpoint', text: 'S'.repeat(2400) }, ...transcript.slice(cut)];
      }
      transcript.push(...turn(bytes));
    }
    return due;
  };
  for (const bytes of [3000, 7000, 12_000]) {
    const n = dueCount(bytes);
    assert(n <= 6, `${bytes}-byte tool results produced ${n} checkpoints over 40 calls`);
  }

  // Whatever the sizes, what actually reaches the model always fits — the trim is the
  // safety net, so compaction is never load-bearing for correctness.
  const huge = [{ role: 'user', text: 'go' }, ...turn(400_000)];
  const { messages, lossy } = a.fitHistory({ transcript: huge }, BUDGET);
  assert(lossy, 'a 400KB tool result must register as a real loss');
  assert(JSON.stringify(messages).length <= BUDGET, 'trimmed history still overflows the window');

  // The cut never separates an assistant from the results of the calls it made.
  const pairs = [{ role: 'user', text: 'go' }];
  for (let t = 0; t < 20; t++) pairs.push(...turn(2000));
  assert(pairs[a.checkpointCut(pairs, BUDGET * 0.35)]?.role !== 'tools', 'cut orphaned a tool-results message');
  return 'trims before compacting · bounded checkpoints · payload always fits · pairs kept whole';
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

await hard('receipts: one purchase cannot be logged twice', async () => {
  const r = await S('receipts.js');
  const { run } = await S('financedb.js');
  const { now } = await S('util.js');

  // The reported problem: the same receipt photographed twice (phone, then desktop) posts
  // twice and silently doubles a day's spend. The key is what a person would compare —
  // the date, the products and the prices — deliberately NOT the shop name, because that
  // is the field two readings of one receipt are most likely to word differently.
  const basket = (over = {}) => r.normalizeParsed({
    merchant: 'Dupe Mart', date: '2026-05-04', currency: 'JPY',
    items: [
      { printed: '牛乳', name: 'Milk', qty: 1, amount: 220 },
      { printed: 'パン', name: 'Bread', qty: 1, amount: 180 },
    ], subtotal: 400, tax: 32, total: 432, ...over,
  });
  const seed = (id, parsed) => {
    run(`INSERT INTO finance_receipt (id,upload_id,status,model,raw,parsed,parsed_ai,error,txn_ids,fingerprint,confidence,created_at,updated_at)
         VALUES (?,'','parsed','audit','',?,'','','[]',?,-1,?,?)`,
      id, JSON.stringify(parsed), r.receiptFingerprint(parsed), now(), now());
    return id;
  };

  const fp = r.receiptFingerprint(basket());
  assert(fp, 'a complete receipt should have a fingerprint');
  assert(fp === r.receiptFingerprint(basket({ merchant: 'ダイエー' })), 'the shop name must not change the key');
  assert(fp === r.receiptFingerprint(basket({ items: [...basket().items].reverse() })), 'line order must not change the key');
  assert(fp !== r.receiptFingerprint(basket({ date: '2026-05-05' })), 'another day is another receipt');

  seed('dup1', basket());
  assert((await r.apply('dup1', { mode: 'total' })).created.length === 1, 'the first copy should post');

  // The second copy, read slightly differently, is refused outright — no confirm step:
  // an "add it anyway" button gets clicked past exactly when it matters.
  seed('dup2', basket({ merchant: 'ダイエー' }));
  assert(r.getReceipt('dup2').duplicate?.id === 'dup1', 'the copy should be flagged before it is applied');
  let status = 0;
  try { await r.apply('dup2', { mode: 'total' }); } catch (e) { status = e.status; }
  assert(status === 409, 'applying a duplicate should be refused with 409, got ' + status);

  // Two ¥500 lunches on one day are a real thing, so a receipt with no lines to compare
  // falls back to including the shop rather than colliding on date+total alone.
  const bare = (m) => r.normalizeParsed({ merchant: m, date: '2026-05-04', currency: 'JPY', items: [], total: 500 });
  assert(r.receiptFingerprint(bare('Cafe A')) !== r.receiptFingerprint(bare('Cafe B')),
    'with no line items the shop must be part of the key');

  // Undoing the original frees the copy: the guard is about the ledger, not the scan.
  r.revertReceipt('dup1');
  assert(r.getReceipt('dup2').duplicate === null, 'reverting the original should unblock the copy');
  assert((await r.apply('dup2', { mode: 'total' })).created.length === 1, 'the copy should post once the original is gone');

  return 'fingerprint ignores the shop · refused with 409 · flagged before applying · bare receipts keyed on shop · revert unblocks';
});

await hard('receipts: a reading is re-read only when that can change it', async () => {
  // The control flow is what matters here — how many passes, which angle, which one wins
  // — so it runs against a SCRIPTED model in a subprocess (own data dir, own config) and
  // counts the calls. Same shape as the schema-wiring test above.
  //
  // The contract is deliberately asymmetric, and the asymmetry is the point: an ILLEGIBLE
  // reading gets the photo turned (a genuinely different input), a LEGIBLE one that simply
  // does not reconcile is handed over as-is (the same input at temperature 0 cannot produce
  // a different answer). Both counts below are pinned so neither half drifts back.
  const { spawnSync } = await import('node:child_process');
  const script = `
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let queue = [], calls = 0;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'v' }] }));
    }
    calls++;
    const next = queue.shift() || {};
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(next) } }] }) + '\\n\\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\\n\\n');
    res.write('data: [DONE]\\n\\n'); res.end();
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const boot = await import(${JSON.stringify(path.join(ROOT, 'server', 'config.js'))});
const cfg = boot.loadConfig();          // mutate the LIVE object — loadConfig() caches
cfg.providers.custom = [{ id: 'm', name: 'Mock', baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'x', kind: 'openai', models: ['v'] }];
cfg.defaults.chatModel = 'custom_m:v';
cfg.finance = { ...cfg.finance, ocrModel: 'custom_m:v', ocrMinConfidence: 75, ocrMaxAttempts: 3 };
boot.saveConfig();

const receipts = await import(${JSON.stringify(path.join(ROOT, 'server', 'receipts.js'))});
const uploads = await import(${JSON.stringify(path.join(ROOT, 'server', 'uploads.js'))});

// A portrait strip, so the orientation heuristic leaves it alone and the ladder starts at 0.
const dir = fs.mkdtempSync('/tmp/aios-loop-');
const jpg = path.join(dir, 'r.jpg');
const ff = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=white:s=200x600','-frames:v','1', jpg]);
if (ff.status !== 0) { console.log('RESULT ' + JSON.stringify({ skip: 'no ffmpeg' })); srv.close(); process.exit(0); }
const up = uploads.saveUploadSync({ name: 'r.jpg', mime: 'image/jpeg', buffer: fs.readFileSync(jpg) });

const GOOD = { merchant: 'Loop Mart', date: '2026-08-01', time: '10:00', currency: 'JPY', category: 'Groceries',
  items: [{ printed: 'A', name: 'A', qty: 1, amount: 220 }, { printed: 'B', name: 'B', qty: 1, amount: 180 }],
  subtotal: 400, tax: 32, total: 432, payment_method: 'cash' };
const OVER = { ...GOOD, items: [...GOOD.items, { printed: 'Ghost', name: 'Ghost', qty: 1, amount: 200 }] };
const BLANK = { ...GOOD, merchant: null, items: [], subtotal: null, tax: null, total: 500 };

const go = async (script, opts) => { queue = script.slice(); calls = 0;
  const r = await receipts.scan({ uploadId: up.id, ...opts }); return { r, calls }; };

const sure = await go([GOOD]);
const wrong = await go([OVER, GOOD]);
const blank = await go([BLANK, BLANK, GOOD]);
const blind = await go([BLANK, BLANK, BLANK]);
const pinned = await go([BLANK, BLANK, BLANK], { rotate: 180 });
cfg.finance.ocrMaxAttempts = 1; boot.saveConfig();
const capped = await go([BLANK, GOOD]);

srv.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log('RESULT ' + JSON.stringify({
  sureCalls: sure.calls, sureScore: sure.r.parsed?.confidence?.score, sureReads: sure.r.parsed?.confidence?.reads,
  wrongCalls: wrong.calls, wrongItems: wrong.r.parsed?.items?.length, wrongVerdict: wrong.r.parsed?.check?.verdict,
  wrongReads: wrong.r.parsed?.confidence?.reads, wrongScore: wrong.r.parsed?.confidence?.score,
  blankCalls: blank.calls, blankMerchant: blank.r.parsed?.merchant, blankAngle: blank.r.parsed?.confidence?.angle,
  blankReads: blank.r.parsed?.confidence?.reads,
  blindCalls: blind.calls,
  pinnedCalls: pinned.calls, pinnedAngle: pinned.r.parsed?.confidence?.angle,
  cappedCalls: capped.calls,
}));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, AIOS_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'aios-loop-')) },
  });
  const m = r.stdout.match(/RESULT (\{.*\})/);
  assert(m, 'retry-loop subprocess failed: ' + (r.stderr || r.stdout).slice(0, 400));
  const o = JSON.parse(m[1]);
  if (o.skip) return 'skipped — ' + o.skip;

  assert(o.sureCalls === 1, 'a confident reading must not be re-read, took ' + o.sureCalls);
  assert(o.sureScore >= 75 && o.sureReads === 1, 'a clean scan should score above the floor: ' + o.sureScore);

  // Legible but does not add up. Every call is temperature 0 under a fixed grammar, so
  // asking the same question of the same pixels returns the same answer — the second pass
  // would cost 25-40s of GPU and change nothing. The reviewer gets the reading NOW, with
  // the arithmetic objection attached, which is the thing that actually helps them.
  assert(o.wrongCalls === 1, 'a legible reading must not be re-read — the answer cannot change; took ' + o.wrongCalls);
  assert(o.wrongItems === 3 && o.wrongVerdict === 'overshoot', 'the reading is handed over as read, got ' + o.wrongItems + ' items / ' + o.wrongVerdict);
  assert(o.wrongScore < 75 && o.wrongReads === 1, 'and it must still be flagged as doubtful: ' + o.wrongScore);

  // Nothing legible is the other failure entirely — that is what a receipt at the wrong
  // angle looks like — so this case turns the photo, which IS something new to read.
  assert(o.blankCalls === 3 && o.blankMerchant === 'Loop Mart', 'an illegible reading should be turned and read again');
  assert(o.blankAngle === 180 || o.blankAngle === 90, 'the winning angle should be recorded, got ' + o.blankAngle);
  assert(o.blankReads === 3, 'the UI should be told it took three goes');
  assert(o.blindCalls === 3, 'the cap must hold when no angle ever reads, took ' + o.blindCalls);

  // An explicit rotation is an instruction: the user turned the preview until it read
  // right and asked for THAT. With the angle pinned there is nothing left to vary, so the
  // loop stops after one pass rather than re-reading identical bytes twice more.
  assert(o.pinnedCalls === 1 && o.pinnedAngle === 0, 'an explicit angle must never be overridden, got ' + o.pinnedCalls + ' calls at ' + o.pinnedAngle);
  assert(o.cappedCalls === 1, 'ocrMaxAttempts=1 should disable re-reading, took ' + o.cappedCalls);

  return 'legible readings read once (a re-read cannot differ) · illegible turns the photo · best pass wins · cap holds · explicit angle pinned';
});

await hard('receipts: a reading scores its own confidence', async () => {
  const r = await S('receipts.js');
  const p = (o) => r.normalizeParsed({ merchant: 'Sure Shop', date: '2026-05-10', currency: 'JPY', ...o });

  const balanced = p({
    items: [{ printed: '牛乳', name: 'Milk', qty: 1, amount: 220 }, { printed: 'パン', name: 'Bread', qty: 1, amount: 180 }],
    subtotal: 400, tax: 32, total: 432,
  });
  const good = r.scoreConfidence(balanced);
  assert(good.score >= 85 && good.level === 'high', 'a receipt that adds up should score high: ' + good.score);

  // An invented line is the failure this whole screen exists to catch, so it has to be
  // the single biggest thing pulling the score down.
  const ghost = p({
    items: [
      { printed: '牛乳', name: 'Milk', qty: 1, amount: 220 },
      { printed: 'パン', name: 'Bread', qty: 1, amount: 180 },
      { printed: '幽霊', name: 'Ghost', qty: 1, amount: 200 },
    ], subtotal: 400, tax: 32, total: 432,
  });
  const bad = r.scoreConfidence(ghost);
  assert(bad.score < 60, 'a receipt that does not add up should score low: ' + bad.score);
  assert(bad.reasons.some(x => /more than the receipt/.test(x.text)), 'the reason should name the surplus');

  // The substitutions normalize() makes quietly have to reach the score, or a reading
  // held together by defaults looks as trustworthy as one actually read off the paper.
  const vague = p({ merchant: '', date: 'illegible', items: [], total: 500 });
  assert(vague.dateGuessed && r.scoreConfidence(vague).level === 'low', 'a reading with nothing in it should score low');
  const derived = p({ items: [{ printed: 'x', name: 'x', qty: 1, amount: 300 }] });
  assert(derived.totalDerived && r.scoreConfidence(derived).reasons.some(x => /added up from the lines/.test(x.text)),
    'a total inferred from the lines should be declared');

  for (const one of [good, bad, r.scoreConfidence(vague), r.scoreConfidence(null)]) {
    assert(one.score >= 0 && one.score <= 100, 'score out of range: ' + one.score);
  }
  return 'balanced scores high · phantom line dominates · guessed date/derived total declared · clamped 0-100';
});

await hard('receipts: a long receipt is read in bands and stitched back', async () => {
  const r = await S('receipts.js');
  const u = await S('uploads.js');

  // --- the seam ---------------------------------------------------------------
  // The bands deliberately overlap, so the shared lines arrive twice and have to be
  // removed exactly once. Both ways of getting that wrong cost money: a line left in
  // twice inflates the basket, one cut out takes a real purchase out of the ledger.
  const st = (parts) => r.stitchTranscripts(parts);
  assert(st(['a\nb']) === 'a\nb' && st([]) === '', 'one band (or none) is not stitching');
  assert(st(['milk 220\nbread 180\neggs 300', 'bread 180\neggs 300\njam 400'])
    === 'milk 220\nbread 180\neggs 300\njam 400', 'the shared lines should appear once');
  assert(st(['1\n2\n3', '2\n3\n4\n5', '4\n5\n6']) === '1\n2\n3\n4\n5\n6', 'three bands should chain');

  // The model does not transcribe a band edge to the character, so the seam is matched on
  // content, not spacing.
  assert(st(['milk 220\nbread  180\neggs 300', 'bread 180\neggs   300\njam 400']).split('\n').length === 4,
    'the seam should survive different spacing');

  // …but ONE line agreeing is not a seam. Prices and blanks repeat innocently all over a
  // receipt, and cutting on one of those deletes a real product silently.
  assert(st(['milk 220\n180', '180\njam 400']) === 'milk 220\n180\n180\njam 400',
    'a single coincidental line must not be treated as the overlap');
  assert(st(['a\nb', 'c\nd']) === 'a\nb\nc\nd', 'when nothing agrees, keep everything');

  // --- the cut ----------------------------------------------------------------
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-band-'));
  const make = (w, h) => {
    const f = path.join(dir, `${w}x${h}.jpg`);
    const s = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', `color=c=white:s=${w}x${h}`, '-frames:v', '1', f]);
    return s.status === 0 ? fs.readFileSync(f) : null;
  };
  const tall = make(600, 3000);
  try {
    if (!tall) return 'skipped — no ffmpeg';

    const s = u.sliceTall(tall, { max: 3 });
    assert(s && s.n === 3, 'a 5:1 strip should be read in three bands, got ' + s?.n);
    // Every pixel row has to land in some band: a gap is a product nobody ever reads.
    const covered = s.bandHeight * (1 + (s.n - 1) * (1 - s.overlap));
    assert(Math.abs(covered - s.height) <= 2, `the bands should cover the strip: ${covered} vs ${s.height}`);
    for (const b of s.bands) {
      const d = u.imageSize(b);
      assert(d.width === 600 && Math.abs(d.height - s.bandHeight) <= 2, 'each band should be a full-width slice');
    }

    // Slicing is an optimisation for one shape of photo, so everything else reads whole.
    assert(u.sliceTall(make(600, 600), { max: 3 }) === null, 'a square photo has nothing to gain');
    assert(u.sliceTall(tall, { max: 1 }) === null, 'max 1 means read it whole');
    assert(u.sliceTall(make(600, 900), { max: 3 }) === null, 'a small photo is already readable');

    // A reader that answers with one layout object per image cannot have its answers
    // stitched, so it must never be handed a band.
    assert(r.transcribeStyle('local:dots.ocr-3b') === 'layout-json'
      && r.transcribeStyle('local:deepseek-ocr') === 'lines', 'the reader style gate is wrong');

    return '3 bands cover the strip · seams matched on content not spacing · one line is not a seam · square/short/JSON readers opt out';
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
});

await hard('finance: a payout screen fills the form, not the ledger', async () => {
  const r = await S('receipts.js');
  const E = (o) => r.reconcileEarnings({ payer: 'Uber', gross: null, fee: null, net: null, jobs: null, hours: null, ...o });

  // A payout screen almost never prints all three figures, and the missing one follows
  // from the other two — but ONLY from two that were actually read. Anything filled in
  // here is declared, so the form can say which number came off the screen and which came
  // off arithmetic; a derived figure the user cannot see on their phone is one they have
  // no way to check.
  const derivedNet = E({ gross: 5000, fee: 1250 });
  assert(derivedNet.net === 3750 && derivedNet.derived.join() === 'net', 'net should follow from gross − fee');
  const derivedFee = E({ gross: 5000, net: 3750 });
  assert(derivedFee.fee === 1250 && derivedFee.derived.join() === 'fee', 'the cut should follow from gross − net');
  const derivedGross = E({ net: 3750, fee: 1250 });
  assert(derivedGross.gross === 5000 && derivedGross.derived.join() === 'gross', 'gross should follow from net + fee');
  assert(E({ net: 3750 }).derived.length === 0, 'a payout on its own needs no arithmetic');

  // Two figures read off unrelated parts of the screen produce a nonsense subtraction.
  // Handing over just the payout is right where inventing a gross is not.
  const nonsense = E({ net: 1000, fee: 9000, gross: 500 });
  assert(nonsense.net === 1000 && nonsense.fee === null && nonsense.gross === null,
    'an impossible fee should be dropped, not logged');

  // The mode decides what the entry RECORDS, not just how it looks: hourly and per-job
  // entries carry their units, which is what makes "what am I really earning per hour"
  // answerable later. Ordered by how much the reading supports, so the fee mode — the
  // only one that records what was skimmed — wins whenever both figures are there.
  assert(r.earningsMode(E({ gross: 5000, fee: 1250, hours: 4, jobs: 9 })) === 'fee', 'gross + cut should log as gross − fee');
  assert(r.earningsMode(E({ net: 3750, hours: 4, jobs: 9 })) === 'hourly', 'hours should log as hourly');
  assert(r.earningsMode(E({ net: 3750, jobs: 9 })) === 'unit', 'jobs alone should log per item');
  assert(r.earningsMode(E({ net: 3750 })) === 'amount', 'a bare payout should log as a flat amount');

  // Read-only by construction: an earnings screen has no arithmetic of its own to check a
  // reading against, so the user pressing the button in the form IS the check.
  const src = fs.readFileSync(path.join(ROOT, 'server', 'receipts.js'), 'utf8');
  const from = src.indexOf('export async function readEarnings');
  const fn = src.slice(from, src.indexOf('\n}\n', from));
  for (const forbidden of ['save(', 'run(', 'learnFix', 'receiptFingerprint', 'apply(']) {
    assert(!fn.includes(forbidden), `readEarnings must not call ${forbidden} — it may not reach the ledger`);
  }
  return 'the third figure derived from two read ones and declared · impossible fee dropped · mode by what was read · reaches no table';
});

await hard('receipts: an item code is not a product name', async () => {
  const r = await S('receipts.js');
  // Narrow on purpose. A missed code is a line the reviewer reads off the photo anyway;
  // a false positive puts a warning on a real product and teaches them to ignore warnings.
  for (const s of ['4901234567890', '001-234', '12 345', '#4901 22', '218'])
    assert(r.looksLikeCode(s), `${s} should read as a code`);
  for (const s of ['牛乳', 'Milk', '500ml', '2%', '明治おいしい牛乳', '12', '', '1.5', 'A1234', 'コーヒー 2'])
    assert(!r.looksLikeCode(s), `${s} should NOT read as a code`);

  // Flagged, never dropped: something WAS bought on that line, so removing it loses a
  // purchase. The warning is what turns it into a correction the catalogue learns from.
  const p = r.normalizeParsed({
    merchant: 'Code Mart', date: '2026-05-10', currency: 'JPY',
    items: [{ printed: '4901234567890', name: '4901234567890', qty: 1, amount: 220 },
      { printed: '牛乳', name: 'Milk', qty: 1, amount: 180 }],
    subtotal: 400, tax: 0, total: 400,
  });
  assert(p.items.length === 2, 'a coded line must survive normalisation');
  assert(p.items[0].warn?.some(w => /item code/.test(w)), 'the coded line should be flagged');
  assert(!p.items[1].warn, 'a named line should be left alone');
  return 'codes flagged, never dropped · products and quantities not mistaken for codes';
});

await hard('receipts: the correction loop learns', async () => {
  const r = await S('receipts.js');
  const { run } = await S('financedb.js');
  const { now } = await S('util.js');

  const scanOn = (date) => r.normalizeParsed({
    merchant: 'Learn Shop', date, currency: 'JPY',
    items: [
      { printed: '本物の品', name: 'Real thing', qty: 1, amount: 300 },
      { printed: '幽霊の品', name: 'Phantom', qty: 1, amount: 180 },   // invented
    ], subtotal: 300, tax: 30, total: 330,
  });
  const scanned = scanOn('2026-06-01');
  assert(!scanned.check.ok, 'the seeded scan should not reconcile');

  const seed = (id, parsed) => run(`INSERT INTO finance_receipt (id,upload_id,status,model,raw,parsed,parsed_ai,error,txn_ids,created_at,updated_at)
    VALUES (?,'','parsed','audit','',?,'','','[]',?,?)`, id, JSON.stringify(parsed), now(), now());

  // Correct it twice — a fix is only trusted after being made more than once, so one
  // odd misread never becomes a standing rule. Two separate shopping trips, because two
  // identical baskets on one day is the duplicate the guardrail exists to refuse.
  for (const [id, date] of [['aud1', '2026-06-01'], ['aud2', '2026-06-02']]) {
    const p = scanOn(date);
    seed(id, p);
    r.editReceipt(id, { ...p, items: p.items.filter(i => i.name !== 'Phantom') });
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

  // A corrected AMOUNT replays only when the model repeats the identical misread. Prices
  // change, and overwriting a genuinely new price with last month's would be a
  // hallucination the app invented itself — worse than the misread it set out to fix.
  for (let i = 0; i < 2; i++) {
    r.learnFix({ merchant: 'Learn Shop', kind: 'amount', raw: 'コーヒー', aiValue: '980', userValue: '198' });
  }
  const line = (amount) => r.replayFixes(r.normalizeParsed({
    merchant: 'Learn Shop', date: '2026-06-15', currency: 'JPY',
    items: [{ printed: 'コーヒー', name: 'Coffee', qty: 1, amount }], total: 198,
  })).items[0].amount;
  assert(line(980) === 198, 'the known misread should be corrected automatically');
  assert(line(210) === 210, 'a genuinely new price must not be overwritten by an old fix');

  // The SHOP NAME is the key every other fix is filed under, so learning it is what makes
  // the per-shop corrections findable on the next receipt from that shop.
  for (let i = 0; i < 2; i++) {
    r.learnFix({ merchant: '', kind: 'merchant', raw: 'LEARN SH0P', aiValue: 'LEARN SH0P', userValue: 'Learn Shop' });
  }
  const renamed = r.replayFixes(r.normalizeParsed({
    merchant: 'LEARN SH0P', date: '2026-06-15', currency: 'JPY',
    items: [
      { printed: '本物の品', name: 'Real thing', qty: 1, amount: 300 },
      { printed: '幽霊の品', name: 'Phantom', qty: 1, amount: 180 },
    ], subtotal: 300, tax: 30, total: 330,
  }));
  assert(renamed.merchant === 'Learn Shop', 'a settled shop name should be restored');
  assert(renamed.items.length === 1, 'fixing the shop name should make its own drops apply');

  // Correcting the PRINTED text (the 牛丼 → 牛乳 case this editor exists for) changes the
  // very key the diff matches on. Filing that as a drop would teach the scanner to bin a
  // real product on sight, so an unmatched line is paired on the money before conceding.
  const before = r.normalizeParsed({
    merchant: 'Typo Shop', date: '2026-06-20', currency: 'JPY',
    items: [{ printed: '牛丼', name: 'Beef bowl', qty: 1, amount: 250 }], subtotal: 250, tax: 0, total: 250,
  });
  seed('aud3', before);
  r.editReceipt('aud3', { ...before, items: [{ printed: '牛乳', name: 'Milk', qty: 1, amount: 250, edited: true }] });
  await r.apply('aud3', { mode: 'total' });
  const fixes = r.listFixes().filter(f => f.raw === '牛丼');
  assert(!fixes.some(f => f.kind === 'drop'), 'a renamed line must not be learned as a phantom: ' + JSON.stringify(fixes));
  assert(fixes.some(f => f.kind === 'rename' && f.userValue === 'Milk'), 'the correction should be learned as a rename');

  const stats = r.learningStats();
  assert(stats.corrections.total > 0 && stats.corrections.activeAfter === 2, 'learning stats should report the gate');
  assert('recent' in stats.confidence, 'learning stats should track the confidence trend');

  return 'learn on apply · hits gate · deterministic replay · merchant-scoped · amount only on the same misread · '
    + 'shop name restored · corrected text is a rename not a drop · applied is frozen';
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

await hard('receipts: a corrected name outranks the model', async () => {
  const r = await S('receipts.js');
  const items = await S('items.js');
  const { run } = await S('financedb.js');
  const { now } = await S('util.js');

  // The reported failure, exactly: the receipt printed 牛乳 (milk), the OCR read it as
  // 牛丼 (beef bowl), the user renamed it to "Milk" in the review editor — and the Items
  // catalogue still said "Beef Bowl", because resolution ran on the printed string and
  // never consulted the correction. Worse, the edit then CONFIRMED 牛丼 → Beef Bowl.
  const parsed = r.normalizeParsed({
    merchant: 'Name Test Super', date: '2026-07-25', currency: 'JPY',
    items: [{ printed: '牛丼 1000ml', name: 'Beef Bowl', qty: 1, amount: 250 }],
    subtotal: 250, tax: 0, total: 250,
  });
  run(`INSERT INTO finance_receipt (id,upload_id,status,model,raw,parsed,parsed_ai,error,txn_ids,created_at,updated_at)
       VALUES ('nm1','','parsed','audit','',?,'','','[]',?,?)`, JSON.stringify(parsed), now(), now());

  r.editReceipt('nm1', { ...parsed, items: [{ ...parsed.items[0], name: 'Audit Milk', edited: true }] });
  const applied = await r.apply('nm1', { mode: 'items' });
  assert(applied.items.userNamed === 1, 'the edited line should be treated as user-named');

  const list = items.listItems({ limit: 100 });
  const arr = Array.isArray(list) ? list : (list.items || []);
  assert(arr.some(i => i.nameEn === 'Audit Milk'), 'the catalogue should hold the name the USER typed');
  assert(!arr.some(i => i.nameEn === 'Beef Bowl'), 'the model\'s guess must not become a catalogue entry');

  // …and the printed string is bound to the user's item, confirmed, so the same misread
  // resolves correctly next time with no model involved.
  const back = items.resolveLocal('牛丼 1000ml');
  assert(back?.how === 'confirmed-alias', 'the printed text should be a confirmed alias, got ' + JSON.stringify(back));
  const mine = arr.find(i => i.nameEn === 'Audit Milk');
  assert(back.itemId === mine.id, 'the alias must point at the user-named item');

  // The `edited` flag has to survive normalisation — correcting the PRINTED text changes
  // the very key any diff-based detection would match on, so it cannot be inferred.
  const kept = r.normalizeParsed({ ...parsed, items: [{ ...parsed.items[0], edited: true }] });
  assert(kept.items[0].edited === true, 'the edited flag must survive normalize()');

  // A line the user did NOT touch still goes through the model path unchanged.
  const untouched = r.normalizeParsed({ ...parsed, items: [{ ...parsed.items[0] }] });
  assert(!untouched.items[0].edited, 'an untouched line must not be marked edited');

  return 'user name wins · no ghost catalogue entry · confirmed alias · flag survives';
});

await hard('receipts: OCR priming uses only settled vocabulary', async () => {
  // Priming the reader with product strings it has seen before is the cheap fix for
  // character-level misreads (牛乳 vs 牛丼 on smudged thermal paper). But it must draw ONLY
  // on confirmed aliases: unconfirmed ones are the model's own guesses, and feeding those
  // back is a loop that entrenches the very misread it is meant to prevent.
  const src = fs.readFileSync(path.join(ROOT, 'server', 'receipts.js'), 'utf8');
  const block = src.slice(src.indexOf('function learnedPromptBlock'), src.indexOf('function ocrModel'));
  assert(/a\.confirmed = 1/.test(block), 'the vocabulary query must filter to confirmed aliases only');
  assert(/kind = 'drop'/.test(block), 'learned phantom lines should still be listed');
  assert(/vocab\.length >= 3/.test(block), 'too small a vocabulary should be skipped, not sent');
  return 'confirmed-only vocabulary · phantom list · minimum size';
});

await hard('finance: income tracking', async () => {
  const fin = await S('finance.js');
  const y = new Date().getFullYear();
  // Earlier checks in this suite write to the same temp ledger, so measure DELTAS rather
  // than absolutes — an assertion that depends on test order is a flake waiting to fire.
  const before = fin.yearToDate(y);

  // Four shapes freelance money arrives in. All become ordinary income rows; only the
  // arithmetic that produced the amount differs, plus the `units` that make an effective
  // hourly rate knowable months later.
  fin.addTxn({ date: `${y}-03-04`, kind: 'income', amount: 24000, currency: 'JPY', category: 'Freelance', merchant: 'Audit Client A', units: 6, unit: 'hour' });
  fin.addTxn({ date: `${y}-03-05`, kind: 'income', amount: 8000, currency: 'JPY', category: 'Freelance', merchant: 'Audit Client A', units: 2, unit: 'hour' });
  fin.addTxn({ date: `${y}-03-06`, kind: 'income', amount: 3000, currency: 'JPY', category: 'Side Job', merchant: 'Audit Platform', units: 12, unit: 'item' });
  fin.addTxn({ date: `${y}-03-07`, kind: 'income', amount: 45000, currency: 'JPY', category: 'Main Job', merchant: 'Audit Employer', isMainJob: true });
  fin.addTxn({ date: `${y}-03-08`, kind: 'expense', amount: 5000, currency: 'JPY', category: 'Groceries', merchant: 'Audit Shop' });

  const q = { from: `${y}-03-01`, to: `${y}-03-31` };

  // units must survive the round trip, or effective rate is unanswerable.
  const back = fin.listTxns({ ...q, kind: 'income' }).items.find(t => t.merchant === 'Audit Client A' && t.amountBase === 24000);
  assert(back && back.units === 6 && back.unit === 'hour', 'units/unit must persist, got ' + JSON.stringify(back && { u: back.units, k: back.unit }));

  // Per payer. This is the regression that matters: the group key was aliased `source`,
  // but finance_txn HAS a `source` column, so SQLite grouped by that instead and every
  // client collapsed into one row.
  const src = fin.incomeBySource(q);
  assert(src.items.length === 3, 'income should group into 3 payers, got ' + src.items.length + ' — the source/alias collision is back');
  const byName = Object.fromEntries(src.items.map(i => [i.source, i]));
  assert(byName['Audit Client A'].total === 32000, 'payer totals should sum their entries');
  assert(byName['Audit Client A'].hours === 8, 'hours should roll up per payer');
  assert(byName['Audit Client A'].rate === 4000, 'effective rate = total / hours, got ' + byName['Audit Client A'].rate);
  assert(byName['Audit Platform'].rate === null, 'a payer with no hours has no hourly rate');
  assert(!byName['Audit Shop'], 'expenses must never appear as an income source');

  // The daily log groups by day, newest first.
  const log = fin.incomeLog(q);
  assert(log.days.length === 4, 'four income days, got ' + log.days.length);
  assert(log.days[0].date > log.days[1].date, 'the log is newest-first');
  assert(log.days.find(d => d.date === `${y}-03-04`).hours === 6, 'per-day hours');

  // Year to date, and the projection that makes a part-year legible.
  const ytd = fin.yearToDate(y);
  assert(ytd.earned - before.earned === 80000, `ytd should gain 80000 income, got ${ytd.earned - before.earned}`);
  assert(ytd.spent - before.spent === 5000, `ytd should gain 5000 spend, got ${ytd.spent - before.spent}`);
  assert(ytd.net === Math.round((ytd.earned - ytd.spent) * 100) / 100, 'ytd net must equal earned − spent');
  assert(ytd.hours - before.hours === 8, 'ytd counts hour-units only, not the 12 items, got ' + (ytd.hours - before.hours));
  assert(ytd.effectiveRate === Math.round(ytd.earned / ytd.hours * 100) / 100, 'ytd effective rate = earned / hours');
  assert(ytd.isCurrent === true && ytd.range.start === `${y}-01-01`, 'the current year runs to today, not to Dec 31');
  assert(ytd.projectedNet > ytd.net, 'a part-year projection should exceed the part-year net');

  // Main-job income is excluded from the side-income goal, which is the whole point of the flag.
  const s = fin.summary(q);
  assert(s.earned === 80000, `March income, got ${s.earned}`);
  assert(s.sideEarned === 35000, `side income should exclude the 45000 main job, got ${s.sideEarned}`);

  // The Overview carries YTD too, so a month in isolation is never the only view.
  assert(fin.overview({ from: q.from, to: q.to }).ytd?.year === String(y), 'overview must include ytd');

  // The calendar can speak net, and its scale is the largest swing either way.
  const cal = fin.calendar(q);
  const d8 = cal.days.find(x => x.date === `${y}-03-08`);
  assert(d8.net === -5000, 'an expense-only day is negative net, got ' + d8.net);
  assert(cal.maxNet >= 45000, 'maxNet is the biggest absolute swing, got ' + cal.maxNet);

  return 'units persist · per-payer rollup · effective rate · daily log · ytd + projection · side vs main · net calendar';
});

await hard('finance: a template fills everything but the amount', async () => {
  const fin = await S('finance.js');
  const y = new Date().getFullYear();

  // A template is a preset with NO amount. Every other field of the stream is answered
  // once, so logging it later is one number — which is the entire point of the feature.
  const tpl = fin.addPreset({
    name: 'Audit Micro1', amount: '', kind: 'income', category: 'Freelance',
    merchant: 'Micro1 Inc', note: 'micro tasks', currency: 'JPY',
  });
  assert(tpl.amount === 0 && tpl.asksAmount === true, 'a blank amount must mark the preset as a template');

  const r = fin.logPreset(tpl.id, { amount: 3200, date: `${y}-04-02` });
  const t = r.created[0];
  assert(t.amount === 3200, 'the typed amount is what gets logged, got ' + t.amount);
  assert(t.category === 'Freelance' && t.merchant === 'Micro1 Inc' && t.note === 'micro tasks',
    'the template must fill category/payer/note without them being typed, got ' + JSON.stringify(t));
  assert(t.source === 'preset' && t.presetId === tpl.id, 'the row must point back at the template it came from');

  // A template with no merchant falls back to its own name, so the common case
  // ("the chip is called X and X is who pays") needs nothing typed at all.
  const bare = fin.addPreset({ name: 'Audit Bare', amount: '', kind: 'income', category: 'Side Job' });
  assert(fin.logPreset(bare.id, { amount: 100, date: `${y}-04-02` }).created[0].merchant === 'Audit Bare',
    'a template with no payer set is logged against its own name');

  // A template with no amount cannot be logged without one — silently writing a zero-yen
  // row would be worse than the error.
  let threw = '';
  try { fin.logPreset(tpl.id, {}); } catch (e) { threw = e.message; }
  assert(/no fixed amount/.test(threw), 'logging a template with no amount must be refused, got ' + JSON.stringify(threw));

  // A FIXED preset is untouched by any of this: still one tap, still N rows for N items.
  const fixed = fin.addPreset({ name: 'Audit Coffee', amount: 480, kind: 'expense', category: 'Food & Drink' });
  assert(fixed.asksAmount === false, 'a preset with an amount is not a template');
  assert(fin.logPreset(fixed.id, { count: 3, date: `${y}-04-02` }).created.length === 3, 'flat presets still split by count');

  return 'blank amount = template · fills payer/type/note · name as payer fallback · amountless log refused · fixed presets unchanged';
});

await hard('finance: an estimate is not money until it is paid', async () => {
  const fin = await S('finance.js');
  const y = new Date().getFullYear();
  const q = { from: `${y}-05-01`, to: `${y}-05-31` };
  const before = fin.summary(q);

  // Four days of freelance work, guessed on the day.
  const est = ['05-04:5000', '05-05:7000', '05-06:3000', '05-07:4000'].map(x => {
    const [d, amt] = x.split(':');
    return fin.addPending({ date: `${y}-${d}`, amount: Number(amt), merchant: 'Audit Payer', category: 'Freelance', units: 2, unit: 'hour' });
  });

  // THE load-bearing assertion. An estimate must move no total anywhere — this is what
  // separates the feature from "an income row with a flag", which would have to be
  // excluded by every aggregate in finance.js and would silently leak the day one missed it.
  const mid = fin.summary(q);
  assert(mid.earned === before.earned, `estimates must never count as earned (${before.earned} → ${mid.earned})`);
  assert(fin.incomeBySource(q).items.every(i => i.source !== 'Audit Payer'), 'an estimate is not an income source yet');
  assert(fin.getGoal(`${y}-05`).progress === fin.getGoal(`${y}-05`).progress, 'goal progress reads without estimates');

  const open = fin.listPending({});
  assert(open.total === 19000 && open.items.length >= 4, 'open estimates total 19000, got ' + open.total);

  // Paid twice a month against a fortnight of guesses: one payout, many estimates.
  const paid = fin.settlePending({ ids: est.map(e => e.id), amount: 20900, date: `${y}-05-15` });
  assert(paid.expected === 19000 && paid.actual === 20900, 'settlement compares the guess with what arrived');
  assert(paid.variance === 1900 && paid.biasPct === 10, `variance +1900 / +10%, got ${paid.variance} / ${paid.biasPct}`);
  assert(paid.txn.kind === 'income' && paid.txn.amount === 20900 && paid.txn.source === 'settle',
    'settling writes exactly one real income row for what arrived');
  assert(paid.txn.units === 8 && paid.txn.unit === 'hour', 'work carries onto the payout when every estimate measured it the same way');

  // NOW it is money — and only the amount that actually arrived, never the guess.
  const after = fin.summary(q);
  assert(after.earned - before.earned === 20900, `only the received amount enters the ledger, got ${after.earned - before.earned}`);

  // The allocation back across the estimates must add up to exactly the payout, or the
  // per-client calibration below is quietly wrong.
  const settled = fin.listPending({ status: 'settled', month: `${y}-05` });
  const alloc = Math.round(settled.items.reduce((n, r) => n + r.actualBase, 0) * 100) / 100;
  assert(alloc === 20900, `pro-rata shares must sum back to the payout, got ${alloc}`);
  assert(settled.items.find(r => r.amountBase === 7000).actualBase === 7700, 'shares are proportional to each estimate');

  // Calibration: which way the intuition leans, per client.
  const ov = fin.pendingOverview({ month: `${y}-05` });
  assert(ov.settled.variance === 1900 && ov.settled.payouts === 1, 'the period rolls the payouts up');
  const payer = ov.byPayer.find(b => b.payer === 'Audit Payer');
  assert(payer && payer.biasPct === 10, 'per-payer bias says the guesses ran 10% low, got ' + JSON.stringify(payer));
  assert(ov.open.total === 0 && ov.open.groups.length === 0, 'a settled estimate leaves the open pile');

  // Settling twice, or editing a settled guess, would rewrite history that has already
  // been reported. Both are refused.
  let e1 = '', e2 = '';
  try { fin.settlePending({ ids: [est[0].id], amount: 1 }); } catch (e) { e1 = e.message; }
  try { fin.updatePending(est[0].id, { amount: 1 }); } catch (e) { e2 = e.message; }
  assert(/already settled/.test(e1) && /already settled/.test(e2), 'a settled estimate is frozen');

  // Undo puts everything back exactly as it was, including removing the payout row.
  fin.unsettlePending(paid.txn.id);
  assert(fin.summary(q).earned === before.earned, 'unsettling removes the payout from the ledger');
  assert(fin.listPending({ merchant: 'Audit Payer' }).total === 19000, 'unsettling reopens the estimates it closed');

  // Writing one off keeps the record without letting it count anywhere.
  fin.voidPending([est[0].id]);
  assert(fin.listPending({ merchant: 'Audit Payer' }).total === 14000, 'a written-off estimate leaves the open total');
  assert(fin.pendingOverview({ month: `${y}-05` }).open.count === 3, 'and leaves the open count');

  // An estimate template routes to the expected ledger without anything being ticked.
  const tpl = fin.addPreset({ name: 'Audit Guessed', amount: '', kind: 'income', category: 'Freelance', merchant: 'Audit Payer', isEstimate: true });
  const g = fin.logPreset(tpl.id, { amount: 2500, date: `${y}-05-20` });
  assert(g.estimate === true && g.created.length === 0 && g.pending[0].amount === 2500,
    'a template marked 想定 logs an estimate, not a transaction');
  assert(fin.summary(q).earned === before.earned, 'and still moves no total');

  return 'estimates move no total · batch settle · pro-rata shares sum exact · variance + per-payer bias · frozen once settled · undo · write-off · 想定 templates';
});

await hard('uploads: orientation detection and rotation', async () => {
  const up = await S('uploads.js');
  if (!up.canConvertImages()) return 'skipped — no ffmpeg on this machine';
  const { execFileSync } = await import('node:child_process');
  const ff = process.env.FFMPEG || '/home/linuxbrew/.linuxbrew/bin/ffmpeg';

  // Synthesise a "receipt": a bright tall strip on a dark field, then the same thing
  // lying on its side. Angle was measured as a leading cause of bad reads on this
  // machine — the same photo failed outright unrotated and parsed once straightened.
  const make = (w, h, sw, sh) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-orient-'));
    const out = path.join(dir, 'r.jpg');
    execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}`,
      '-f', 'lavfi', '-i', `color=c=white:s=${sw}x${sh}`,
      '-filter_complex', '[0][1]overlay=(W-w)/2:(H-h)/2', '-frames:v', '1', out]);
    return { buf: fs.readFileSync(out), dir };
  };

  const tall = make(600, 900, 180, 760);      // strip standing up  → portrait photo
  const wide = make(900, 600, 760, 180);      // strip lying down   → landscape photo

  const t = up.imageSize(tall.buf);
  assert(t && t.width === 600 && t.height === 900, 'imageSize should read the dimensions, got ' + JSON.stringify(t));
  const g = up.greyRaster(tall.buf, 64);
  assert(g && g.n === 64 && g.data.length === 64 * 64, 'greyRaster should return an n×n plane');

  // Rotation is applied to the STORED file, so the photo the reviewer checks against is
  // the one the model was given.
  const stored = await up.saveUploadBuffer({ name: 'wide.jpg', mime: 'image/jpeg', buffer: wide.buf });
  const before = up.imageSize(up.readUpload(stored.id).buffer);
  assert(before.width > before.height, 'the fixture should start landscape');
  const after = up.rotateStored(stored.id, 270);
  const dim = up.imageSize(up.readUpload(stored.id).buffer);
  assert(dim.height > dim.width, `rotating 270° should make it portrait, got ${dim.width}x${dim.height}`);
  assert(after.rotatedBy === 270, 'the meta should record the rotation, got ' + after.rotatedBy);
  assert(after.size > 0 && after.mime === 'image/jpeg', 'the rotated file should still be a JPEG');

  // A no-op rotation must not re-encode (each pass costs quality).
  const same = up.rotateStored(stored.id, 0);
  assert(same.size === after.size, '0° should be a no-op');

  // Cropping to the document is a RESOLUTION fix, not a tidiness one: the model
  // downsamples whatever it is handed, and a receipt fills under half the frame on every
  // real example here. Measured — uncropped, one transcribed to 86 characters and missed
  // every product; cropped, 698 characters and a perfect reading.
  const crop = up.cropToContent(wide.buf);
  assert(crop && crop.buffer?.length, 'a strip on a dark field should be croppable');
  assert(crop.area < 80, 'the crop should save real area, got ' + crop.area + '%');
  const cd = up.imageSize(crop.buffer);
  assert(cd.width < 900 && cd.height < 600, `the crop should be smaller than the frame, got ${cd.width}x${cd.height}`);

  // …and it must decline when there is nothing to gain, rather than nibbling every photo.
  const full = make(600, 900, 600, 900);
  assert(up.cropToContent(full.buf) === null, 'an image that already fills the frame must not be cropped');
  fs.rmSync(full.dir, { recursive: true, force: true });

  for (const f of [tall, wide]) fs.rmSync(f.dir, { recursive: true, force: true });
  return 'imageSize · greyRaster · rotate in place · meta records the angle · 0° no-op · crop-to-document · declines when pointless';
});

await hard('uploads: a hand-held tilt is measured and undone', async () => {
  const up = await S('uploads.js');
  if (!up.canConvertImages()) return 'skipped — no ffmpeg on this machine';
  const { execFileSync } = await import('node:child_process');
  const ff = process.env.FFMPEG || '/home/linuxbrew/.linuxbrew/bin/ffmpeg';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-skew-'));

  // A synthetic receipt: dark bars on white paper, evenly spaced. That comb of text lines
  // is exactly the structure the projection profile locks onto, so it is the honest test
  // of the detector — and unlike a photo, its true angle is known to the degree.
  const bars = Array.from({ length: 14 }, (_, i) =>
    `drawbox=x=60:y=${70 + i * 52}:w=280:h=16:color=black:t=fill`).join(',');
  const straight = path.join(dir, 'straight.jpg');
  execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:s=400x800', '-vf', bars, '-frames:v', '1', straight]);
  const flat = fs.readFileSync(straight);

  const tilt = (deg) => {
    const rad = (deg * Math.PI / 180).toFixed(6);
    const out = path.join(dir, `t${deg}.jpg`);
    execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', straight,
      '-vf', `rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):fillcolor=white`, '-q:v', '2', out]);
    return fs.readFileSync(out);
  };

  try {
    // Straight paper is left alone. This matters more than the correction: re-encoding a
    // photo that was already square costs quality and buys nothing.
    assert(up.deskew(flat) === null, 'a straight page must not be rotated, got ' + JSON.stringify(up.detectSkew(flat)));

    for (const deg of [-8, -4, 3, 6]) {
      const buf = tilt(deg);
      const found = up.detectSkew(buf);
      assert(Math.abs(found.degrees - deg) <= 1,
        `a ${deg}° tilt should be measured within 1°, got ${found.degrees}`);
      const fixed = up.deskew(buf);
      assert(fixed, `a ${deg}° tilt should be corrected, but deskew declined`);
      const residual = up.detectSkew(fixed.buffer).degrees;
      assert(Math.abs(residual) <= 1, `after correcting ${deg}° the residual should be ~0, got ${residual}`);
    }

    // The angle is measured on an aspect-PRESERVING raster. greyRaster squashes to a
    // square, which stretches a 400x800 page by 2x vertically and would report a 4° tilt
    // as roughly 8°. This is the assertion that catches that regression.
    const g = up.greyFit(flat, 320);
    assert(g && Math.abs((g.w / g.h) - (400 / 800)) < 0.02, 'greyFit must keep the picture proportions, got ' + (g && `${g.w}x${g.h}`));

    // Bounded: a quarter-turn is a different problem with a different fix, and a detector
    // that "corrects" 90° would fight the orientation logic that owns it.
    const sideways = up.detectSkew(tilt(0));
    assert(Math.abs(sideways.degrees) <= 12, 'the search must stay inside its bounds');

    return 'straight left alone · ±8° measured within 1° and corrected to ~0 · aspect preserved · bounded';
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
});

await hard('receipts: a looping reader is cut off, a repeated purchase is not', async () => {
  const r = await S('receipts.js');

  // The failure this exists for, taken from life: HunyuanOCR read a McDonald's receipt as
  // a Markdown table, got every line right, then emitted empty rows to the token cap.
  const runaway = ['# マクドナルド', '(Big Mac Set) 880', '(Teriyaki Set) 720',
    ...Array(9).fill('| | | |')].join('\n');
  const cut = r.trimRepetition(runaway);
  assert(!cut.includes('| | | |'), 'the repeated tail must be cut');
  assert(cut.includes('880') && cut.includes('720'), 'the real lines before it must survive');

  // The reason a repetition PENALTY was rejected instead: this is a real receipt in the
  // archive, and the same product at three prices is the correct reading.
  const legit = ['国産豚肉 ミンチ 264', '国産豚肉 ミンチ 299', '国産豚肉 ミンチ 273', '合計 4123'].join('\n');
  assert(r.trimRepetition(legit) === legit, 'genuinely repeated purchases must be kept');

  // Five in a row is under the bar; six is degeneration.
  assert(r.trimRepetition(['a', ...Array(5).fill('x')].join('\n')).split('\n').length === 6, '5 repeats are tolerated');
  assert(r.trimRepetition(['a', ...Array(6).fill('x')].join('\n')) === 'a', '6 repeats to the end is a loop');

  // Only a run that reaches the END is degeneration. A repeated block in the middle is
  // followed by real content, so the model clearly recovered and nothing may be dropped.
  const middle = ['a', ...Array(8).fill('x'), 'b', 'c'].join('\n');
  assert(r.trimRepetition(middle) === middle, 'a run that recovers is not a runaway');

  assert(r.trimRepetition('') === '' && r.trimRepetition(null) === '', 'empty input is safe');
  return 'runaway tail cut · repeated purchases kept · threshold at 6 · mid-text runs kept · empty safe';
});

await hard('receipts: a reader is asked the way it expects', async () => {
  const r = await S('receipts.js');
  // Style decides whether a long receipt can be read in bands at all: only line-oriented
  // output can be stitched back together, so a layout-JSON reader must opt out.
  assert(r.transcribeStyle('local:dots.ocr-q8_0') === 'layout-json', 'dots.ocr answers in layout JSON');
  assert(r.transcribeStyle('local:hunyuanocr-q8_0') === 'lines', 'HunyuanOCR answers in lines');
  assert(r.transcribeStyle('local:paddleocr-vl-1.6-q8_0') === 'lines', 'PaddleOCR-VL answers in lines');
  // A ref that resolves to nothing local (a cloud model) must fall back, not throw: the
  // lookup runs on every scan and a broken ref cannot be allowed to take one down.
  assert(r.transcribeStyle('anthropic:claude-opus-5') === 'lines', 'an unresolvable ref falls back to lines');
  assert(r.transcribeStyle('') === 'lines' && r.transcribeStyle(undefined) === 'lines', 'no ref falls back to lines');
  return 'per-model style · unresolvable refs fall back instead of throwing';
});

await hard('llm: schema-constrained output', async () => {
  // The fix for "the model did not return usable JSON": llama.cpp compiles a JSON Schema
  // to a GBNF grammar and masks any token that would break it. Verified against a real
  // llama-server on this box (an enum in the schema came back as exactly that enum), but
  // what an offline suite can pin is the WIRING — that a schema reaches the provider in
  // the right field, since a silently-dropped response_format looks identical to success
  // until a scan fails weeks later.
  const { spawnSync } = await import('node:child_process');
  const script = `
import http from 'node:http';
const seen = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    seen.push(JSON.parse(b));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' } }] }) + '\\n\\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\\n\\n');
    res.write('data: [DONE]\\n\\n'); res.end();
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const fs = await import('node:fs'); const path = await import('node:path');
fs.writeFileSync(path.join(process.env.AIOS_DATA, 'config.json'), JSON.stringify({
  providers: { custom: [{ id: 'm', name: 'Mock', baseUrl: 'http://127.0.0.1:' + port + '/v1' }] },
}));
const { streamChat } = await import(${JSON.stringify(path.join(ROOT, 'server', 'llm.js'))});
const SCHEMA = { name: 'thing', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } };
const withSchema = await streamChat({ modelRef: 'custom_m:x', messages: [{ role: 'user', text: 'hi' }], schema: SCHEMA, maxTokens: 64 });
await streamChat({ modelRef: 'custom_m:x', messages: [{ role: 'user', text: 'hi' }], maxTokens: 64 });
srv.close();
console.log('RESULT ' + JSON.stringify({
  text: withSchema.text,
  rf: seen[0].response_format,
  plainHasRf: Object.prototype.hasOwnProperty.call(seen[1], 'response_format'),
}));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, AIOS_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'aios-schema-')) },
  });
  const m = r.stdout.match(/RESULT (\{.*\})/);
  assert(m, 'schema subprocess failed: ' + (r.stderr || r.stdout).slice(0, 300));
  const o = JSON.parse(m[1]);
  assert(o.text === '{"ok":true}', 'the constrained reply should stream through as content');
  assert(o.rf?.type === 'json_schema', 'response_format.type should be json_schema, got ' + JSON.stringify(o.rf));
  assert(o.rf?.json_schema?.strict === true, 'strict mode must be on or the grammar is advisory');
  assert(o.rf?.json_schema?.schema?.required?.[0] === 'ok', 'the caller schema should be passed through intact');
  assert(!o.plainHasRf, 'a call without a schema must not send response_format');
  return 'schema → response_format · strict · passthrough · absent when unused';
});

await hard('receipts: the OCR request is budgeted for a thinking model', async () => {
  // Gemma 4 emits 180-250 reasoning tokens even with enable_thinking/reasoning_effort/
  // thinking.type all set to off — measured, all three are no-ops for its template. The
  // old 2400-token cap was therefore spent narrating and the JSON never arrived: 3130
  // characters of "Here's a thinking process…" stored as a failed scan. These constants
  // are the fix; if someone trims them back, this fails.
  const src = fs.readFileSync(path.join(ROOT, 'server', 'receipts.js'), 'utf8');
  assert(/schema:\s*RECEIPT_SCHEMA/.test(src), 'the scan must send the schema');
  const caps = [...src.matchAll(/attempt\((\d+)\)/g)].map(x => Number(x[1]));
  assert(caps.length >= 2, 'expected a first pass and a retry');
  assert(Math.min(...caps) >= 4096, 'the first pass needs room for reasoning + JSON, got ' + Math.min(...caps));
  assert(Math.max(...caps) > Math.min(...caps), 'the retry should raise the cap, got ' + JSON.stringify(caps));
  assert(/maxItems:\s*\d+/.test(src), 'the items array must be bounded — an unbounded one ran away for 6876 tokens');
  assert(/stopReason === 'length'/.test(src), 'truncation must be detected, not reported as bad JSON');
  return 'schema sent · 4096 first pass · larger retry · bounded array · truncation detected';
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

await hard('tools: the agent cannot be pointed at this machine', async () => {
  // fetch_url and crawl_site take their URL from the model, which takes its ideas from
  // whatever page it just read. Loopback here answers with ComfyUI, llama-server,
  // SearXNG and Ollama, none of which authenticate, so "see http://127.0.0.1:11434/api/tags"
  // used to be a working instruction. Every hop is checked now, including redirects.
  const t = await S('tools.js');

  const blocked = ['127.0.0.1', '127.1.2.3', '0.0.0.0', '10.1.2.3', '172.16.5.4', '192.168.0.9',
    '169.254.169.254', '100.64.1.1', '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1'];
  for (const ip of blocked) assert(t.blockedAddress(ip), `${ip} should be refused`);
  // Fails closed: anything it cannot parse is not a public address either.
  for (const junk of ['', 'not-an-ip', '999.1.1.1']) assert(t.blockedAddress(junk), `${junk || '(empty)'} should be refused`);
  // …without swallowing the real internet, and without catching the neighbours of a
  // private block (172.32/16 sits just past 172.16/12).
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert(!t.blockedAddress(ip), `${ip} is public and must stay fetchable`);
  }

  // The name is resolved, not just pattern-matched: localhost is not a literal IP.
  let reached = false;
  try { await t.fetchReadable('http://localhost:7777/api/status'); reached = true; } catch { }
  assert(!reached, 'fetch_url reached a loopback service by name');

  // And the guard is wired into every model-facing entry point, not just one.
  const src = fs.readFileSync(path.join(ROOT, 'server', 'tools.js'), 'utf8');
  // Comments stripped first — the paragraph above safeFetch explains why
  // redirect:'follow' is wrong, and a naive grep counts that explanation as an offence.
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const follows = code.match(/redirect:\s*'follow'/g) || [];
  assert(!follows.length, `redirect:'follow' hands the destination to the page being read (${follows.length} site(s))`);
  for (const fn of ['fetchReadable', 'fetchRaw', 'fetchPdfText']) {
    const body = src.slice(src.indexOf(`function ${fn}(`));
    assert(/safeFetch\(/.test(body.slice(0, 900)), `${fn} still calls fetch() directly`);
  }
  return `${blocked.length} private forms refused · public + redirect hops checked · 3 entry points guarded`;
});

await hard('voice: a partial that lost its race is discarded', async () => {
  // The final full-quality pass is what gets acted on. A live partial still decoding
  // when the user stops talking is worth nothing and would overwrite it on screen.
  // The flag is set on the stream object AND the entry is removed from the map, so
  // reading the flag back through the map finds undefined and never fires — which is
  // exactly how this shipped.
  const src = fs.readFileSync(path.join(ROOT, 'server', 'voice.js'), 'utf8');
  const body = src.slice(src.indexOf('export async function partialTranscribe'), src.indexOf('export function endPartial'));
  assert(!/streams\.get\([^)]*\)\?\.closed/.test(body),
    'the staleness guard reads through the map, which endPartial has already emptied');
  // Both engines have to guard, and each has to do it on BOTH sides of its await:
  // before, so a stream closed while queued never starts; after, so one closed mid-
  // decode does not return anyway. The count is per-engine rather than absolute so
  // adding a third recogniser does not silently pass with no guard of its own.
  for (const [fn, next] of [['partialTranscribe', 'async function streamFeed'], ['async function streamFeed', '']]) {
    const from = body.indexOf(fn);
    const seg = next ? body.slice(from, body.indexOf(next)) : body.slice(from);
    assert((seg.match(/if \(s\.closed\)/g) || []).length >= 2,
      `${fn.replace('async function ', '')} does not check the captured stream either side of its decode`);
  }
  return 'both engines guard the captured stream, before and after the decode';
});

// ---------- environment-dependent (reported, never failed) ----------

await hard('routes: no sendFile inside the h() wrapper', async () => {
  // h() resolves its callback and then sends {"ok":true} when nothing was returned.
  // res.sendFile streams asynchronously, so a route that does both sends the JSON
  // first and the file never arrives — a silent, total failure of that download.
  // /api/fs/raw shipped that way and survived three sibling routes being fixed
  // around it, so the shape is checked here rather than left to memory.
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  // Paren-matched, and skipping comments and strings: an apostrophe in a comment
  // ("the user's messages") and the `h(` at the tail of `push(`/`imagePath(` both
  // produced false positives on the naive version of this.
  const offenders = [];
  const re = /app\.(get|post|put|delete)\(\s*('[^']*'|"[^"]*")([\s\S]*?)(?<![\w.$])h\(/g;
  for (let m; (m = re.exec(src));) {
    if (/[;}]/.test(m[3])) continue;               // ran past this route's own call
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
      if (c === "'" || c === '"' || c === '`') {
        const q = c; i++;
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      } else if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    if (/res\.sendFile\(/.test(src.slice(m.index, i))) offenders.push(m[2].replace(/['"]/g, ''));
  }
  assert(!offenders.length, `sendFile inside h(): ${offenders.join(', ')}`);
  const total = (src.match(/res\.sendFile\(/g) || []).length;
  assert(total >= 4, `expected the 4 known sendFile routes, found ${total}`);
  return `${total} sendFile routes, none wrapped in h()`;
});

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
