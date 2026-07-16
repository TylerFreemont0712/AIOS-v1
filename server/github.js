// GitHub integration: profile, repos, PRs/issues, notifications, repo creation,
// project publishing, and clone-to-projects. The token comes from Settings (PAT)
// or the gh CLI's stored login — resolved server-side, never sent to the client.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { streamChat } from './llm.js';
import * as git from './git.js';
import { registerProject, getProject } from './projects.js';

const API = process.env.AIOS_GH_API || 'https://api.github.com';   // overridable for tests
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

let publish = () => { };
export const setPublisher = (fn) => { publish = fn; };

// ---------- auth ----------

let tokCache = { at: 0, token: '', via: '' };

/** Settings PAT wins; otherwise borrow the gh CLI's login (cached 5 min). */
export function resolveToken() {
  const cfg = loadConfig();
  if (cfg.github?.token) return { token: cfg.github.token, via: 'settings' };
  if (Date.now() - tokCache.at < 5 * 60_000) return tokCache;
  let token = '';
  try {
    const r = spawnSync('gh', ['auth', 'token'], { timeout: 5000, encoding: 'utf8' });
    if (r.status === 0) token = (r.stdout || '').trim();
  } catch { }
  tokCache = { at: Date.now(), token, via: token ? 'gh-cli' : '' };
  return tokCache;
}

async function gh(pathname, { method = 'GET', body, params } = {}) {
  const { token } = resolveToken();
  if (!token) throw err('GitHub is not connected — run `gh auth login` on this machine or paste a token in Settings → GitHub.');
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(url, {
      method, signal: ctl.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'AIOS',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch { }
    if (!r.ok) throw err(`GitHub ${r.status}: ${j?.message || text.slice(0, 200)}`, r.status === 401 ? 400 : r.status);
    return { data: j, rate: { remaining: +r.headers.get('x-ratelimit-remaining') || 0, limit: +r.headers.get('x-ratelimit-limit') || 0 } };
  } finally { clearTimeout(t); }
}

// ---------- identity / overview ----------

const pickUser = (u) => ({
  login: u.login, name: u.name || u.login, avatar: u.avatar_url, bio: u.bio || '',
  followers: u.followers ?? 0, following: u.following ?? 0,
  publicRepos: u.public_repos ?? 0, privateRepos: u.total_private_repos ?? null,
  company: u.company || '', location: u.location || '', url: u.html_url,
});

let meCache = { at: 0, me: null };
async function me() {
  if (meCache.me && Date.now() - meCache.at < 5 * 60_000) return meCache.me;
  const { data } = await gh('/user');
  meCache = { at: Date.now(), me: pickUser(data) };
  return meCache.me;
}

export async function status() {
  const { token, via } = resolveToken();
  if (!token) return { configured: false, hint: 'Sign in with `gh auth login` on this machine, or paste a personal access token in Settings → GitHub.' };
  const user = await me();
  return { configured: true, via, user };
}

function eventLine(e) {
  const repo = e.repo?.name || '';
  const p = e.payload || {};
  switch (e.type) {
    case 'PushEvent': return `pushed ${p.commits?.length || 0} commit(s) to ${repo}`;
    case 'PullRequestEvent': return `${p.action} PR #${p.number} in ${repo}`;
    case 'PullRequestReviewEvent': return `reviewed PR #${p.pull_request?.number} in ${repo}`;
    case 'IssuesEvent': return `${p.action} issue #${p.issue?.number} in ${repo}`;
    case 'IssueCommentEvent': return `commented on #${p.issue?.number} in ${repo}`;
    case 'CreateEvent': return `created ${p.ref_type}${p.ref ? ` ${p.ref}` : ''} in ${repo}`;
    case 'DeleteEvent': return `deleted ${p.ref_type} ${p.ref || ''} in ${repo}`;
    case 'WatchEvent': return `starred ${repo}`;
    case 'ForkEvent': return `forked ${repo}`;
    case 'ReleaseEvent': return `released ${p.release?.tag_name || ''} in ${repo}`;
    default: return `${e.type.replace(/Event$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} in ${repo}`;
  }
}

export async function overview() {
  const user = await me();
  let activity = [];
  try {
    const { data } = await gh(`/users/${user.login}/events`, { params: { per_page: 15 } });
    activity = (data || []).map(e => ({ at: e.created_at, text: eventLine(e), repo: e.repo?.name || '' }));
  } catch { /* events API is flaky for new accounts — profile still renders */ }
  return { user, activity };
}

// ---------- repos ----------

const pickRepo = (r) => ({
  name: r.name, fullName: r.full_name, private: !!r.private, fork: !!r.fork,
  description: r.description || '', language: r.language || '',
  stars: r.stargazers_count ?? 0, forks: r.forks_count ?? 0, openIssues: r.open_issues_count ?? 0,
  defaultBranch: r.default_branch || 'main', pushedAt: r.pushed_at || r.updated_at,
  url: r.html_url, cloneUrl: r.clone_url,
});

export async function repos() {
  const { data, rate } = await gh('/user/repos', { params: { sort: 'pushed', per_page: 80, affiliation: 'owner,collaborator' } });
  return { repos: (data || []).map(pickRepo), rate };
}

export async function createRepo({ name, description = '', isPrivate = true, autoInit = false } = {}) {
  name = String(name || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) throw err('repository name is required');
  const { data } = await gh('/user/repos', { method: 'POST', body: { name, description: String(description || ''), private: !!isPrivate, auto_init: !!autoInit } });
  meCache.at = 0;   // repo counts changed
  return pickRepo(data);
}

// ---------- PRs / issues (search API) ----------

const repoFromApiUrl = (u) => String(u || '').replace(/^.*\/repos\//, '');
const pickItem = (it) => ({
  number: it.number, title: it.title, repo: repoFromApiUrl(it.repository_url),
  author: it.user?.login || '', draft: !!it.draft, comments: it.comments ?? 0,
  updatedAt: it.updated_at, url: it.html_url,
});

export async function prs() {
  const login = (await me()).login;
  const search = async (q) => {
    const { data } = await gh('/search/issues', { params: { q, sort: 'updated', per_page: 20 } });
    return (data?.items || []).map(pickItem);
  };
  const [authored, reviewRequested, involved] = await Promise.all([
    search(`is:pr is:open author:${login}`),
    search(`is:pr is:open review-requested:${login}`),
    search(`is:pr is:open involves:${login}`),
  ]);
  const seen = new Set([...authored, ...reviewRequested].map(p => p.url));
  return { authored, reviewRequested, involved: involved.filter(p => !seen.has(p.url)) };
}

export async function issues() {
  const login = (await me()).login;
  const { data } = await gh('/search/issues', { params: { q: `is:issue is:open involves:${login}`, sort: 'updated', per_page: 30 } });
  return { issues: (data?.items || []).map(pickItem) };
}

// ---------- contribution heatmap (GraphQL) ----------

/** GitHub-style contributions calendar: 52 weeks × 7 days with 0-4 levels. */
export async function heatmap() {
  const user = await me();
  const q = 'query($login:String!){ user(login:$login){ contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } } }';
  const { data } = await gh('/graphql', { method: 'POST', body: { query: q, variables: { login: user.login } } });
  if (data?.errors?.length) throw err('GitHub GraphQL: ' + data.errors[0].message, 502);
  const cal = data?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw err('no contribution data returned', 502);
  // levels from quartiles of the non-zero days, so sparse and busy years both look right
  const nz = cal.weeks.flatMap(w => w.contributionDays.map(d => d.contributionCount)).filter(c => c > 0).sort((a, b) => a - b);
  const qt = (p) => nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] : 1;
  const t1 = qt(0.25), t2 = qt(0.5), t3 = qt(0.75);
  const level = (c) => c === 0 ? 0 : c <= t1 ? 1 : c <= t2 ? 2 : c <= t3 ? 3 : 4;
  return {
    total: cal.totalContributions,
    weeks: cal.weeks.map(w => ({ days: w.contributionDays.map(d => ({ date: d.date, count: d.contributionCount, level: level(d.contributionCount) })) })),
  };
}

// ---------- AI "suggested next" (streamed over WS like chat) ----------

let sugCache = { at: 0, key: '', text: '' };

/** Stream 2-3 sentences of prioritized GitHub to-dos to topic gh:suggest:<reqId>. */
export async function suggest({ reqId, modelRef, projectId } = {}) {
  const send = (ev) => publish(`gh:suggest:${reqId}`, { t: 'gh.suggest', reqId, ev });
  try {
    const cfg = loadConfig();
    const ref = modelRef || cfg.defaults.chatModel || cfg.defaults.agentModel;
    if (!ref) { send({ type: 'error', message: 'no model configured' }); return; }
    const user = await me();
    const key = `${user.login}:${projectId || ''}:${ref}`;
    if (sugCache.text && sugCache.key === key && Date.now() - sugCache.at < 15 * 60_000) {
      send({ type: 'done', text: sugCache.text, cached: true });
      return;
    }

    const [p, i, n] = await Promise.all([prs().catch(() => null), issues().catch(() => null), notifications().catch(() => null)]);
    let projLine = '';
    if (projectId) {
      try {
        const proj = getProject(projectId);
        if (proj) {
          const info = git.gitInfo(proj.path);
          projLine = `\n- Active local project "${proj.name}": ${!info.repo ? 'no git repo yet'
            : `branch ${info.branch}, ${info.dirty} uncommitted change(s)${info.remote ? '' : ', not on GitHub yet'}`}`;
        }
      } catch { }
    }
    const fmt = (list, cap = 4) => list.slice(0, cap).map(x => `${x.repo}#${x.number} "${x.title.slice(0, 60)}"`).join('; ') || 'none';
    const unread = (n?.notifications || []).filter(x => x.unread);
    const ctx = `GitHub state for @${user.login}:
- PRs awaiting your review (${p?.reviewRequested.length ?? 0}): ${fmt(p?.reviewRequested || [])}
- Your open PRs (${p?.authored.length ?? 0}): ${fmt(p?.authored || [])}
- Open issues involving you (${i?.issues.length ?? 0}): ${fmt(i?.issues || [])}
- Unread notifications (${unread.length}): ${unread.slice(0, 4).map(x => `${x.repo}: ${x.title.slice(0, 50)} (${x.reason})`).join('; ') || 'none'}${projLine}`;

    const res = await streamChat({
      modelRef: ref, maxTokens: 160,
      system: 'You are a terse GitHub assistant. Reply with 2-3 short sentences (max ~60 words total) of concrete, prioritized next actions based ONLY on the state given. Reference items as repo#number. No greetings, no lists, no markdown, no preamble — just the sentences. If nothing is pending, say so in one sentence and suggest one small concrete improvement.',
      messages: [{ role: 'user', text: ctx }],
      onEvent: (ev) => { if (ev.type === 'text') send({ type: 'delta', delta: ev.delta }); },
    });
    let text = (res.text || '').trim().replace(/\s+/g, ' ');
    const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g);
    if (sentences && sentences.length > 3) text = sentences.slice(0, 3).join('').trim();
    if (text.length > 360) text = text.slice(0, 357).trimEnd() + '…';
    if (!text) { send({ type: 'error', message: 'empty suggestion' }); return; }
    sugCache = { at: Date.now(), key, text };
    send({ type: 'done', text });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
}

// ---------- notifications ----------

/** API subject URLs → browser URLs (pulls/123 → pull/123). */
function webUrl(subject, repository) {
  const s = subject?.url || '';
  if (s) return s.replace('api.github.com/repos/', 'github.com/').replace('/pulls/', '/pull/');
  return repository?.html_url || 'https://github.com/notifications';
}

export async function notifications() {
  const { data } = await gh('/notifications', { params: { per_page: 25 } });
  return {
    notifications: (data || []).map(n => ({
      id: n.id, reason: n.reason, unread: !!n.unread,
      title: n.subject?.title || '', type: n.subject?.type || '',
      repo: n.repository?.full_name || '', updatedAt: n.updated_at,
      url: webUrl(n.subject, n.repository),
    })),
  };
}

export async function markRead(threadId) {
  await gh(`/notifications/threads/${encodeURIComponent(threadId)}`, { method: 'PATCH' });
  return { ok: true };
}

// ---------- publish / clone (git plumbing) ----------

/** Basic-auth header trick for one-shot authenticated push/clone over https —
 *  the token never lands in .git/config or the remote URL. */
function authArgs() {
  const { token } = resolveToken();
  const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`];
}

/** Create the GitHub repo (unless origin already exists) and push the current branch. */
export async function publishProject(root, { name, description = '', isPrivate = true } = {}) {
  if (!git.hasGit()) throw err('git is not installed', 500);
  if (!git.isRepo(root)) await git.gitInit(root);
  let info = git.gitInfo(root);

  // an empty project can't be pushed — make the first commit if there's anything to commit
  if (!info.hasCommits) {
    if (!info.dirty) throw err('nothing to publish — the project has no files or commits yet');
    await git.gitCommit(root, { message: 'chore: initial commit' });
    info = git.gitInfo(root);
  }
  const branch = info.branch === '?' ? 'main' : info.branch;

  let remote = (await git.runGit(root, ['remote', 'get-url', 'origin'])).code === 0
    ? (await git.runGit(root, ['remote', 'get-url', 'origin'])).out.trim()
    : '';
  let repo = null, created = false;
  if (!remote) {
    repo = await createRepo({ name: name || path.basename(root), description, isPrivate });
    created = true;
    const add = await git.runGit(root, ['remote', 'add', 'origin', repo.cloneUrl]);
    if (add.code !== 0) throw err('git remote add failed: ' + add.out.trim(), 500);
    remote = repo.cloneUrl;
  }

  // plain push first (the user's credential helper may handle it), then the
  // token-header retry for machines where git has no GitHub credentials.
  let push = await git.runGit(root, ['push', '--set-upstream', 'origin', branch], { timeoutMs: 60_000 });
  if (push.code !== 0 && /github\.com/.test(remote)) {
    push = await git.runGit(root, [...authArgs(), 'push', '--set-upstream', 'origin', branch], { timeoutMs: 60_000 });
  }
  if (push.code !== 0) throw err('git push failed: ' + push.out.trim().slice(0, 400), 500);

  const htmlUrl = repo?.url || remote.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
  return { ok: true, created, branch, remote: remote.replace(/\/\/[^@/]*@/, '//'), url: htmlUrl };
}

/** Push the current branch. Lighter than publishProject: never creates repos, never
 *  commits — it pushes what exists and explains what's wrong when it can't. */
export async function gitPush(root) {
  if (!git.isRepo(root)) throw err('not a git repository');
  const info = git.gitInfo(root);
  if (!info.hasCommits) throw err('no commits yet — commit something first');
  if (!info.remote) throw err('no origin remote — use Publish to create the GitHub repo first');
  const args = info.hasUpstream ? ['push'] : ['push', '--set-upstream', 'origin', info.branch];
  let r = await git.runGit(root, args, { timeoutMs: 60_000 });
  if (r.code !== 0 && /github\.com/.test(info.remote)) {
    r = await git.runGit(root, [...authArgs(), ...args], { timeoutMs: 60_000 });
  }
  if (r.code !== 0) {
    const out = r.out.trim();
    if (/non-fast-forward|fetch first|\[rejected\]/i.test(out)) {
      throw err('push rejected — the remote has commits you don\'t have locally. Pull first, then push again.', 409);
    }
    throw err('git push failed: ' + out.slice(0, 400), 500);
  }
  const after = git.gitInfo(root);
  return { ok: true, branch: after.branch, ahead: after.ahead, behind: after.behind };
}

/** Pull with rebase + autostash — the safe default for a single-author machine.
 *  On conflict the rebase is aborted so the working tree comes back untouched,
 *  and the error says which files collided instead of leaving a half-rebase. */
export async function gitPull(root) {
  if (!git.isRepo(root)) throw err('not a git repository');
  const info = git.gitInfo(root);
  if (!info.remote) throw err('no origin remote — nothing to pull from');
  const args = ['pull', '--rebase', '--autostash', 'origin', ...(info.hasUpstream ? [] : [info.branch])];
  let r = await git.runGit(root, args, { timeoutMs: 90_000 });
  if (r.code !== 0 && /github\.com/.test(info.remote) && /authentication|403|could not read/i.test(r.out)) {
    r = await git.runGit(root, [...authArgs(), ...args], { timeoutMs: 90_000 });
  }
  if (r.code !== 0) {
    const out = r.out.trim();
    if (/CONFLICT|could not apply/i.test(out)) {
      await git.runGit(root, ['rebase', '--abort']);   // restore the tree — no half-rebase left behind
      const files = [...out.matchAll(/CONFLICT [^:]*: (?:Merge conflict in )?(.+)/g)].map(m => m[1]).slice(0, 6);
      throw err(`pull hit conflicts${files.length ? ` in: ${files.join(', ')}` : ''} — the rebase was aborted, your tree is unchanged. Commit your work, then resolve manually.`, 409);
    }
    throw err('git pull failed: ' + out.slice(0, 400), 500);
  }
  const after = git.gitInfo(root);
  return { ok: true, branch: after.branch, ahead: after.ahead, behind: after.behind, out: r.out.trim().split('\n').slice(-3).join('\n') };
}

/** "https://github.com/o/r.git" or "git@github.com:o/r.git" → { owner, repo }. */
export function parseGithubRemote(remote) {
  const m = String(remote || '').match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Draft a PR title/body from the branch's commits + stat; template fallback. */
export async function draftPR(root, { modelRef } = {}) {
  const info = git.gitInfo(root);
  if (!info.repo) throw err('not a git repository');
  if (['main', 'master'].includes(info.branch)) throw err(`you're on ${info.branch} — create a work branch first (PRs from the default branch aren't useful)`);
  const gh2 = parseGithubRemote(info.remote);
  if (!gh2) throw err('origin is not a github.com remote — publish the project first');
  const localBase = git.defaultBase(root);
  const commits = git.branchCommits(root, localBase);
  if (!commits.length) throw err(`no commits on ${info.branch} beyond ${localBase} — commit something first`);

  const cfg = loadConfig();
  const ref = modelRef || cfg.defaults.agentModel || cfg.defaults.chatModel;
  const fallback = () => ({
    title: commits[commits.length - 1] || `Changes on ${info.branch}`,
    body: `## Changes\n${commits.map(c => `- ${c}`).join('\n')}`,
  });
  if (!ref) return { ...fallback(), branch: info.branch, base: localBase, generated: false };
  try {
    const res = await streamChat({
      modelRef: ref, maxTokens: 1600,
      system: 'You write excellent pull-request descriptions. Think briefly if you must, then output only the PR text.',
      messages: [{
        role: 'user',
        text: `Write a pull request title and description for branch "${info.branch}".

Format EXACTLY:
TITLE: <imperative, ≤ 70 chars, names the main concrete change>
BODY:
## What
<1-3 sentences on what this PR does>
## Changes
<one "- " bullet per meaningful change, specific>

Commits on this branch:
${commits.map(c => `- ${c}`).join('\n')}

Diff stat vs ${localBase}:
${(git.statPreview(root) || '').slice(0, 1500)}`,
      }],
    });
    const t = res.text.match(/TITLE:\s*(.+)/i)?.[1]?.trim();
    const b = res.text.split(/BODY:\s*/i)[1]?.trim();
    if (t && b && !git.isGenericSubject(t)) return { title: t.slice(0, 90), body: b.slice(0, 4000), branch: info.branch, base: localBase, generated: true };
  } catch { /* fall through */ }
  return { ...fallback(), branch: info.branch, base: localBase, generated: false };
}

/** Push the branch and open (or find) its pull request. */
export async function openPR(root, { title, body, base, draft = false, modelRef } = {}) {
  const info = git.gitInfo(root);
  const gh2 = parseGithubRemote(info.remote);
  if (!gh2) throw err('origin is not a github.com remote — publish the project first');
  if (['main', 'master'].includes(info.branch)) throw err(`you're on ${info.branch} — create a work branch first`);

  // make sure the branch exists on the remote (tolerate failure if it was pushed before)
  const pushed = await publishProject(root, {}).catch(e => ({ error: e.message }));
  if (pushed.error && !info.hasUpstream) throw err('push failed: ' + pushed.error, 500);

  const { data: repoInfo } = await gh(`/repos/${gh2.owner}/${gh2.repo}`);
  const baseBranch = base || repoInfo.default_branch || 'main';

  const { data: existing } = await gh(`/repos/${gh2.owner}/${gh2.repo}/pulls`, { params: { head: `${gh2.owner}:${info.branch}`, state: 'open' } });
  if (existing?.length) return { existing: true, url: existing[0].html_url, number: existing[0].number, title: existing[0].title };

  let t = title, b = body;
  if (!t) { const d = await draftPR(root, { modelRef }); t = d.title; b = b || d.body; }
  const { data } = await gh(`/repos/${gh2.owner}/${gh2.repo}/pulls`, {
    method: 'POST',
    body: { title: t, body: b || '', head: info.branch, base: baseBranch, draft: !!draft },
  });
  return { url: data.html_url, number: data.number, title: t };
}

/** Clone one of the user's repos into projectsRoot and register it as a project. */
export async function cloneRepo({ fullName, cloneUrl } = {}) {
  fullName = String(fullName || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw err('fullName must look like "owner/repo"');
  const cfg = loadConfig();
  const target = path.join(cfg.projectsRoot, fullName.split('/')[1]);
  if (fs.existsSync(target)) throw err(`${target} already exists — register it as a project instead`);
  const url = String(cloneUrl || `https://github.com/${fullName}.git`);
  if (!/^https:\/\/github\.com\//.test(url)) throw err('only github.com clone URLs are supported');

  let r = await git.runGit(cfg.projectsRoot, ['clone', url, target], { timeoutMs: 120_000 });
  if (r.code !== 0) r = await git.runGit(cfg.projectsRoot, [...authArgs(), 'clone', url, target], { timeoutMs: 120_000 });
  if (r.code !== 0) throw err('git clone failed: ' + r.out.trim().slice(0, 400), 500);

  const project = registerProject({ path: target });
  return { ok: true, path: target, project };
}
