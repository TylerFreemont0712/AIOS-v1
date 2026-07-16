// GitHub integration E2E: AIOS against a mock GitHub API (REST + GraphQL), a
// local bare repo as the publish target, and a mock LLM for the streamed
// "suggested next" card. Verifies status/repos/create/prs/heatmap/notifications,
// project publish (init→commit→create→push), and the 3-sentence suggest clamp.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'package.json'))('ws');
const PORT = 7921, GH_PORT = 7922, LLM_PORT = 7923;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-gh-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-ghproj-'));
const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-bare-'));
fs.writeFileSync(path.join(projDir, 'main.py'), 'print("hi")\n');
spawnSync('git', ['init', '--bare', path.join(bareDir, 'target.git')], { encoding: 'utf8' });

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// ---- mock GitHub API ----
const repoObj = (name, priv = false) => ({
  name, full_name: `mock-user/${name}`, private: priv, fork: false, description: `${name} desc`,
  language: 'JavaScript', stargazers_count: 3, forks_count: 1, open_issues_count: 2,
  default_branch: 'main', pushed_at: '2026-07-09T10:00:00Z', html_url: `https://github.com/mock-user/${name}`,
  clone_url: `file://${path.join(bareDir, 'target.git')}`,
});
const item = (i, pr = true) => ({
  number: i, title: `${pr ? 'PR' : 'Issue'} number ${i}`, draft: false, comments: 2,
  updated_at: '2026-07-09T10:00:00Z', html_url: `https://github.com/mock-user/repo/pull/${i}`,
  repository_url: 'https://api.github.com/repos/mock-user/repo', user: { login: 'mock-user' },
});
const ghMock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { message: 'Bad credentials' });
    if (u.pathname === '/user') return send(200, { login: 'mock-user', name: 'Mock User', avatar_url: 'https://example.com/a.png', bio: 'testing', followers: 5, following: 7, public_repos: 2, total_private_repos: 1, html_url: 'https://github.com/mock-user' });
    if (u.pathname === '/user/repos' && req.method === 'GET') return send(200, [repoObj('alpha'), repoObj('beta', true)]);
    if (u.pathname === '/user/repos' && req.method === 'POST') { const b = JSON.parse(raw); return send(201, repoObj(b.name, b.private)); }
    if (u.pathname === '/search/issues') {
      const q = u.searchParams.get('q') || '';
      if (/review-requested/.test(q)) return send(200, { items: [item(11)] });
      if (/author/.test(q)) return send(200, { items: [item(12)] });
      if (/is:issue/.test(q)) return send(200, { items: [item(31, false)] });
      return send(200, { items: [item(12), item(21)] });   // involves: dup of authored + one new
    }
    if (u.pathname === '/notifications' && req.method === 'GET') return send(200, [{
      id: '77', reason: 'review_requested', unread: true, updated_at: '2026-07-10T01:00:00Z',
      subject: { title: 'Please review', type: 'PullRequest', url: 'https://api.github.com/repos/mock-user/repo/pulls/11' },
      repository: { full_name: 'mock-user/repo', html_url: 'https://github.com/mock-user/repo' },
    }]);
    if (u.pathname === '/notifications/threads/77') return send(205, {});
    if (u.pathname === '/users/mock-user/events') return send(200, [{ type: 'PushEvent', created_at: '2026-07-10T02:00:00Z', repo: { name: 'mock-user/alpha' }, payload: { commits: [{}, {}] } }]);
    if (u.pathname === '/graphql') {
      const weeks = Array.from({ length: 4 }, (_, w) => ({
        contributionDays: Array.from({ length: 7 }, (_, d) => ({ date: `2026-06-${String(w * 7 + d + 1).padStart(2, '0')}`, contributionCount: (w * 7 + d) % 5 })),
      }));
      return send(200, { data: { user: { contributionsCollection: { contributionCalendar: { totalContributions: 42, weeks } } } } });
    }
    send(404, { message: 'not found: ' + u.pathname });
  });
});
ghMock.listen(GH_PORT);

// ---- mock LLM (OpenAI SSE): deliberately returns FIVE sentences to test the clamp ----
const llmMock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const text = 'Review mock-user/repo#11 first since a teammate is waiting. Then rebase and land your own repo#12. Publish your local project to GitHub. Also consider cleaning stale branches. Finally write more tests.';
    for (const piece of text.match(/.{1,40}/g)) send({ choices: [{ delta: { content: piece }, finish_reason: null }] });
    send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 40 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
llmMock.listen(LLM_PORT);

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, AIOS_DATA: tmpData, AIOS_PORT: String(PORT), AIOS_NO_OPEN: '1', AIOS_GH_API: `http://127.0.0.1:${GH_PORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let slog = '';
server.stdout.on('data', d => slog += d);
server.stderr.on('data', d => slog += d);
function cleanup(code) {
  try { server.kill('SIGKILL'); } catch { }
  try { ghMock.close(); llmMock.close(); } catch { }
  for (const d of [tmpData, projDir, bareDir]) fs.rmSync(d, { recursive: true, force: true });
  if (code) { console.error('--- server log ---\n' + slog.slice(-2500)); process.exit(code); }
}

let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE + '/status')).ok) { up = true; break; } } catch { }
  await new Promise(r => setTimeout(r, 250));
}
ok(up, 'server up (mock GH API)');

await j('PUT', '/config', {
  github: { token: 'test-token' },
  providers: { custom: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${LLM_PORT}/v1` }] },
  defaults: { chatModel: 'mock:m1' },
});

let r = await j('GET', '/github/status');
ok(r.status === 200 && r.data.configured && r.data.user.login === 'mock-user' && r.data.via === 'settings', 'status: configured via settings token');
r = await j('GET', '/github/overview');
ok(r.data.user.followers === 5 && r.data.activity.some(a => /pushed 2 commit/.test(a.text)), 'overview: profile + activity lines');
r = await j('GET', '/github/repos');
ok(r.data.repos.length === 2 && r.data.repos[1].private === true, 'repos: list + private flag');
r = await j('POST', '/github/repos', { name: 'my new repo!', isPrivate: true });
ok(r.status === 200 && r.data.fullName === 'mock-user/my-new-repo', 'repos: create (name sanitized)');
r = await j('GET', '/github/prs');
ok(r.data.reviewRequested.length === 1 && r.data.authored.length === 1 && r.data.involved.length === 1 && r.data.involved[0].number === 21, 'prs: three buckets, deduped');
r = await j('GET', '/github/issues');
ok(r.data.issues.length === 1 && r.data.issues[0].repo === 'mock-user/repo', 'issues: involves list');
r = await j('GET', '/github/heatmap');
ok(r.data.total === 42 && r.data.weeks.length === 4 && r.data.weeks[0].days[0].level === 0 && r.data.weeks.flatMap(w => w.days).some(d => d.level === 4), 'heatmap: weeks + quartile levels');
r = await j('GET', '/github/notifications');
ok(r.data.notifications[0].unread && r.data.notifications[0].url.includes('github.com/mock-user/repo/pull/11'), 'notifications: web URL conversion');
r = await j('POST', '/github/notifications/77/read', {});
ok(r.status === 200, 'notifications: mark read');

// publish flow: temp project (no repo) → init → commit → create repo → push to local bare
const reg = await j('POST', '/projects/register', { path: projDir });
r = await j('POST', `/projects/${reg.data.id}/git/publish`, { name: 'published-proj', isPrivate: true });
ok(r.status === 200 && r.data.created && r.data.ok, `publish: created + pushed (branch ${r.data.branch})`);
const barelog = spawnSync('git', ['--git-dir', path.join(bareDir, 'target.git'), 'log', '--format=%s', r.data.branch], { encoding: 'utf8' }).stdout.trim();
ok(barelog === 'chore: initial commit', `publish: commit actually landed in the remote (${barelog || 'empty'})`);
r = await j('GET', `/projects/${reg.data.id}/git`);
ok(r.data.remote.startsWith('file://'), 'publish: origin remote set');

// ---- PR drafting: guards + commit-subject fallback ----
const ghMod = await import((await import('node:url')).pathToFileURL(path.join(ROOT, 'server/github.js')).href);
ok(ghMod.parseGithubRemote('https://github.com/o/r.git')?.repo === 'r'
  && ghMod.parseGithubRemote('git@github.com:own/proj.git')?.owner === 'own'
  && ghMod.parseGithubRemote('file:///tmp/x.git') === null, 'pr: remote parser handles https/ssh/non-github');

r = await j('POST', `/projects/${reg.data.id}/git/pr/draft`, {});
ok(r.status === 400 && /work branch/.test(r.data.error), 'pr: refuses drafting from the default branch');

spawnSync('git', ['-C', projDir, 'checkout', '-b', 'aios/feature-x'], { encoding: 'utf8' });
fs.writeFileSync(path.join(projDir, 'feat.js'), 'export const x = 1;\n');
await j('POST', `/projects/${reg.data.id}/git/commit`, { message: 'feat: add feature x module' });
r = await j('POST', `/projects/${reg.data.id}/git/pr/draft`, {});
ok(r.status === 400 && /github\.com remote/.test(r.data.error), 'pr: refuses non-github remote');

spawnSync('git', ['-C', projDir, 'remote', 'set-url', 'origin', 'https://github.com/mock-user/target.git'], { encoding: 'utf8' });
r = await j('POST', `/projects/${reg.data.id}/git/pr/draft`, {});
ok(r.status === 200 && r.data.branch === 'aios/feature-x' && ['main', 'master'].includes(r.data.base), 'pr: draft resolves branch + base');
ok(r.data.title === 'feat: add feature x module' && /- feat: add feature x module/.test(r.data.body), 'pr: commit-subject fallback when model output unparseable');

// streamed suggest over WS — five-sentence model output must clamp to three
const events = [];
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const timer = setTimeout(() => reject(new Error('suggest timeout')), 30_000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'sub', topic: 'gh:suggest:r1' }));
    ws.send(JSON.stringify({ t: 'github.suggest', reqId: 'r1', projectId: reg.data.id }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'gh.suggest') return;
    events.push(m.ev);
    if (m.ev.type === 'done' || m.ev.type === 'error') { clearTimeout(timer); ws.close(); resolve(); }
  });
  ws.on('error', reject);
}).catch(e => { console.error('✗ ' + e.message); cleanup(1); });

const done = events.find(e => e.type === 'done');
ok(events.filter(e => e.type === 'delta').length > 2, 'suggest: streamed deltas (typed-out effect)');
ok(done && !/error/.test(done.text || '') && done.text.length > 20, 'suggest: done text arrived');
const sentenceCount = (done.text.match(/[^.!?]+[.!?]/g) || []).length;
ok(sentenceCount <= 3, `suggest: clamped to ${sentenceCount} sentences (model sent 5)`);
ok(/repo#11/.test(done.text), 'suggest: references concrete items');

// cache: second call returns instantly with cached:true
const ev2 = [];
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const timer = setTimeout(() => reject(new Error('cached suggest timeout')), 10_000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'sub', topic: 'gh:suggest:r2' }));
    ws.send(JSON.stringify({ t: 'github.suggest', reqId: 'r2', projectId: reg.data.id }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'gh.suggest') return;
    ev2.push(m.ev);
    if (m.ev.type === 'done' || m.ev.type === 'error') { clearTimeout(timer); ws.close(); resolve(); }
  });
  ws.on('error', reject);
}).catch(e => { console.error('✗ ' + e.message); cleanup(1); });
ok(ev2.find(e => e.type === 'done')?.cached === true, 'suggest: 15-min cache serves repeat opens');

cleanup(0);
console.log(`\nALL ${n} GITHUB E2E CHECKS PASSED`);
