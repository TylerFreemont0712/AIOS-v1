// Git plumbing for projects: status for the UI chip + agent context, branch and
// commit operations, and AI-drafted commit messages. Commands run as argument
// vectors (never shell strings) with cwd pinned to the project root.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, contextBudget } from './config.js';
import { streamChat } from './llm.js';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

let _hasGit = null;
export function hasGit() {
  if (_hasGit === null) {
    try { _hasGit = spawnSync('git', ['--version'], { timeout: 3000 }).status === 0; }
    catch { _hasGit = false; }
  }
  return _hasGit;
}

/** Run git asynchronously; resolves { code, out } (stdout+stderr combined). */
export function runGit(root, args, { timeoutMs = 20000, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: root, env: GIT_ENV });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    child.stdout.on('data', d => { out += d; if (out.length > 400_000) child.kill('SIGKILL'); });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: `git spawn error: ${e.message}` }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** Quick sync git call for status/context; null on any failure. */
function sync(root, args) {
  try {
    const r = spawnSync('git', args, { cwd: root, timeout: 5000, encoding: 'utf8', env: GIT_ENV });
    return r.status === 0 ? (r.stdout || '').replace(/\n$/, '') : null;
  } catch { return null; }
}

export const isRepo = (root) => hasGit() && sync(root, ['rev-parse', '--is-inside-work-tree']) === 'true';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Compact repo state: branch, dirty files, last commit. Cheap enough to call per request. */
export function gitInfo(root) {
  if (!hasGit()) return { git: false, repo: false };
  if (!isRepo(root)) return { git: true, repo: false };
  // rev-parse handles detached HEAD; symbolic-ref handles unborn branches (no commits yet)
  const branch = sync(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || sync(root, ['symbolic-ref', '--short', 'HEAD']) || '?';
  const porcelain = sync(root, ['status', '--porcelain']) ?? '';
  const lines = porcelain ? porcelain.split('\n').filter(Boolean) : [];
  const lastCommit = sync(root, ['log', '-1', '--format=%h %s']) || '';
  let ahead = 0, behind = 0;
  const lr = sync(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (lr) { const [b, a] = lr.split(/\s+/).map(Number); behind = b || 0; ahead = a || 0; }
  const hasUpstream = lr !== null;
  // origin URL with any embedded credentials stripped — safe to show in the UI
  const remote = (sync(root, ['remote', 'get-url', 'origin']) || '').replace(/\/\/[^@/]*@/, '//');
  return {
    git: true, repo: true, branch, detached: branch === 'HEAD',
    dirty: lines.length,
    files: lines.slice(0, 40).map(l => ({ s: l.slice(0, 2).trim() || '??', path: l.slice(3) })),
    hasCommits: !!lastCommit, lastCommit, ahead, behind, hasUpstream, remote,
  };
}

/** Commits on this branch that the base branch doesn't have (for PR drafting). */
export function branchCommits(root, base) {
  const log = sync(root, ['log', `${base}..HEAD`, '--format=%s']) || '';
  return log.split('\n').filter(Boolean);
}

/** The local default branch a PR would target: main, else master. */
export function defaultBase(root) {
  for (const b of ['main', 'master']) if (sync(root, ['rev-parse', '--verify', '--quiet', b]) !== null) return b;
  return 'main';
}

/** One-line summary for the agent system prompt. Intentionally NOT memoized —
 *  it's rebuilt every loop turn precisely so branch/dirty state stays live
 *  (git_branch mid-run must show up next turn). The ~5 git subprocesses are
 *  negligible next to the LLM call that dominates each turn. */
export function promptContext(root) {
  try {
    if (!hasGit()) return '';
    if (!isRepo(root)) return 'This project is NOT a git repository yet — git_init creates one when version control would help.';
    const i = gitInfo(root);
    return `This project is a git repo on branch "${i.branch}" (${i.dirty ? `${i.dirty} uncommitted change(s)` : 'clean'}${i.hasCommits ? `, last commit: ${i.lastCommit}` : ', no commits yet'}).`;
  } catch { return ''; }
}

export async function gitInit(root) {
  if (!hasGit()) throw err('git is not installed on this machine', 500);
  if (isRepo(root)) return { ok: true, note: 'already a repository' };
  let r = await runGit(root, ['init', '-b', 'main']);
  if (r.code !== 0) r = await runGit(root, ['init']);   // older git without -b
  if (r.code !== 0) throw err(r.out.trim() || 'git init failed', 500);
  return { ok: true, note: 'initialized' };
}

/** Commits need an identity; default a local one from the AIOS profile if unset. */
async function ensureIdentity(root) {
  if (sync(root, ['config', 'user.email'])) return;
  const u = loadConfig().user || {};
  await runGit(root, ['config', 'user.name', u.name || 'AIOS']);
  await runGit(root, ['config', 'user.email', u.email || 'aios@localhost']);
}

export function cleanBranchName(name) {
  const n = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9/_.-]+/g, '-').replace(/-{2,}/g, '-').replace(/\/{2,}/g, '/')
    .replace(/^[-/.]+|[-/.]+$/g, '');
  if (!n) throw err('branch name is empty after sanitizing');
  return n.slice(0, 60);
}

/** Untracked directories that are themselves git repos. `git add -A` on one either
 *  fails outright ("'dir/' does not have a commit checked out" when the inner repo has
 *  no commits) or silently records a gitlink — a submodule entry with no .gitmodules,
 *  which breaks every future clone. Both are traps, so we name them instead of letting
 *  git's cryptic error (or silent success) through. */
export function nestedRepos(root) {
  const porcelain = sync(root, ['status', '--porcelain']) ?? '';
  const out = [];
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('??')) continue;
    const p = line.slice(3).replace(/\/$/, '');
    try { if (fs.existsSync(path.join(root, p, '.git'))) out.push(p); } catch { }
  }
  return out;
}

/** Stage everything and commit. Returns { hash, message, stat }. */
export async function gitCommit(root, { message } = {}) {
  message = String(message || '').trim();
  if (!message) throw err('commit message is required');
  if (!isRepo(root)) throw err('not a git repository');
  await ensureIdentity(root);
  const nested = nestedRepos(root);
  if (nested.length) {
    throw err(`can't stage everything: ${nested.map(n => `"${n}/"`).join(', ')} ${nested.length > 1 ? 'are' : 'is a'} git repo${nested.length > 1 ? 's' : ''} nested inside this one. ` +
      `Git would fail or record a broken submodule. Fix one of three ways: delete the inner .git folder (keeps the files in THIS repo), ` +
      `move the folder out of the project, or add "${nested[0]}/" to .gitignore.`);
  }
  const a = await runGit(root, ['add', '-A']);
  if (a.code !== 0) throw err('git add failed: ' + a.out.trim(), 500);
  if (!sync(root, ['diff', '--cached', '--name-only'])) throw err('nothing to commit — working tree clean');
  const c = await runGit(root, ['commit', '-m', message]);
  if (c.code !== 0) throw err('git commit failed: ' + c.out.trim(), 500);
  return {
    hash: sync(root, ['rev-parse', '--short', 'HEAD']) || '',
    message,
    stat: (sync(root, ['show', '--stat', '--format=', 'HEAD']) || '').slice(0, 2000),
  };
}

/** Working-tree change summary for approval cards / commit modal (sync, may be null). */
export function statPreview(root) {
  if (!isRepo(root)) return null;
  const info = gitInfo(root);
  if (!info.dirty) return null;
  const stat = info.hasCommits ? sync(root, ['diff', 'HEAD', '--stat']) : null;
  return stat || info.files.map(f => `${f.s} ${f.path}`).join('\n');
}

const DIFF_FILE_CAP = 60_000;

/** Per-file unified diffs of everything uncommitted (the diff-rail's payload).
 *  Untracked files render as all-additions via --no-index against /dev/null. */
export async function workingDiff(root) {
  if (!isRepo(root)) throw err('not a git repository');
  const info = gitInfo(root);
  const files = [];
  for (const f of info.files) {
    const p = f.path.includes(' -> ') ? f.path.split(' -> ')[1] : f.path;   // renames: diff the new side
    let r;
    if (f.s === '??') {
      // --no-index exits 1 when the files differ — that's success here
      r = await runGit(root, ['diff', '--no-index', '--', '/dev/null', p]);
      if (r.code !== 0 && r.code !== 1) r = { code: 0, out: '' };
    } else {
      r = await runGit(root, info.hasCommits ? ['diff', 'HEAD', '--', p] : ['diff', '--', p]);
    }
    let diff = (r.out || '').trim();
    const binary = /^Binary files /m.test(diff) || (!diff && f.s !== '??');
    if (diff.length > DIFF_FILE_CAP) diff = diff.slice(0, DIFF_FILE_CAP) + '\n… (diff truncated)';
    files.push({ path: f.path, s: f.s, diff, binary });
  }
  return { branch: info.branch, dirty: info.dirty, files };
}

// ---------- commit message generation ----------

/** No-model fallback: name what was touched. */
function templateMessage(info) {
  const names = info.files.map(f => path.basename(f.path));
  const head = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` +${names.length - 3} more` : '';
  return `chore: update ${head}${more}`.slice(0, 72);
}

/** Strip fences/quotes, clamp subject to 72 chars and body to a few lines. */
export function cleanMessage(text) {
  let t = String(text || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
  t = t.replace(/^["'`]+|["'`]+$/g, '').trim();
  const lines = t.split('\n');
  const subject = (lines.shift() || '').trim().slice(0, 72);
  const body = lines.join('\n').trim().slice(0, 600);
  if (!subject) return '';
  return body ? `${subject}\n\n${body}` : subject;
}

/** The change set as text for the model: stat + capped patch + heads of new files. */
function changesText(root, info, cap) {
  const base = info.hasCommits ? ['diff', 'HEAD'] : ['diff'];
  const stat = (sync(root, [...base, '--stat']) || '').slice(0, 2000);
  let patch = (sync(root, [...base, '--unified=2']) || '');
  let extra = '';
  // untracked files never show in diff — include their heads so the model knows what they are
  for (const f of info.files.filter(f => f.s === '??').slice(0, 6)) {
    try {
      const abs = path.join(root, f.path);
      if (fs.statSync(abs).isFile() && fs.statSync(abs).size < 200_000) {
        extra += `\n--- new file: ${f.path} ---\n${fs.readFileSync(abs, 'utf8').slice(0, 1000)}\n`;
      }
    } catch { }
  }
  const room = Math.max(1000, cap - stat.length - extra.length);
  if (patch.length > room) patch = patch.slice(0, room) + '\n…(diff truncated)';
  return `${stat}\n\n${patch}${extra}`;
}

/** A subject that describes nothing — reject and retry rather than commit it. */
export const isGenericSubject = (subject) => {
  const s = String(subject || '').replace(/^(feat|fix|chore|refactor|docs|test|style|perf)[:!]?\s*/i, '').trim();
  if (s.length < 8) return true;
  return /^(update|change|modify|edit|improve|fix)e?s?\b[\s\w]{0,14}$/i.test(s)
    || /need to|some (changes|updates|fixes)|various (changes|fixes)|make (a )?changes?|^wip\b|misc\b/i.test(s);
};

/** Draft a commit message from the working-tree diff; template fallback without a model. */
export async function commitMessage(root, { modelRef } = {}) {
  if (!isRepo(root)) throw err('not a git repository');
  const info = gitInfo(root);
  if (!info.dirty) throw err('working tree clean — nothing to describe');
  const cfg = loadConfig();
  const ref = modelRef || cfg.defaults.agentModel || cfg.defaults.chatModel;
  if (!ref) return { message: templateMessage(info), generated: false };

  const { inputChars } = contextBudget({ modelRef: ref, wantOutput: 1600 });
  const cap = Math.max(2000, Math.min(inputChars - 1600, 24_000));
  const prompt = (nudge = '') => `Write a git commit message for the diff below.${nudge}

Method: read the diff, identify WHAT actually changed in each file and WHY it matters, then write the message about those specifics.

Format:
- Line 1: imperative subject ≤ 70 chars naming the MAIN concrete change, with a conventional-commit prefix when it fits (feat:/fix:/refactor:/docs:/chore:/test:).
- Then a blank line and 1-4 "- " bullets: one per significant change, each naming the file/area and the specific behavior added, removed, or fixed.

BAD (rejected): "chore: make changes", "fix: update files", "need to make a change"
GOOD: "feat: add sender mute rules to inbox triage" with bullets like "- mail.js: block/star rules by address or domain, checked in notifications()"

Output ONLY the commit message — no fences, no quotes, no commentary.

Branch: ${info.branch}

${changesText(root, info, cap)}`;

  try {
    // reasoning models spend most tokens thinking before the first message line —
    // give them room, and reject content-free subjects with one retry
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await streamChat({
        modelRef: ref, maxTokens: 1600,
        system: 'You write excellent, specific git commit messages. Think briefly if you must, then output only the message itself.',
        messages: [{ role: 'user', text: prompt(attempt ? '\nThe previous draft was too vague — name the actual files and behaviors from the diff.' : '') }],
      });
      const msg = cleanMessage(res.text);
      if (msg && !isGenericSubject(msg.split('\n')[0])) return { message: msg, generated: true };
    }
  } catch { /* fall through to template */ }
  return { message: templateMessage(info), generated: false };
}
