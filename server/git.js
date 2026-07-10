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
  // origin URL with any embedded credentials stripped — safe to show in the UI
  const remote = (sync(root, ['remote', 'get-url', 'origin']) || '').replace(/\/\/[^@/]*@/, '//');
  return {
    git: true, repo: true, branch, detached: branch === 'HEAD',
    dirty: lines.length,
    files: lines.slice(0, 40).map(l => ({ s: l.slice(0, 2).trim() || '??', path: l.slice(3) })),
    hasCommits: !!lastCommit, lastCommit, ahead, behind, remote,
  };
}

/** One-line summary for the agent system prompt. */
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

/** Stage everything and commit. Returns { hash, message, stat }. */
export async function gitCommit(root, { message } = {}) {
  message = String(message || '').trim();
  if (!message) throw err('commit message is required');
  if (!isRepo(root)) throw err('not a git repository');
  await ensureIdentity(root);
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
  let patch = (sync(root, [...base, '--unified=1']) || '');
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

/** Draft a commit message from the working-tree diff; template fallback without a model. */
export async function commitMessage(root, { modelRef } = {}) {
  if (!isRepo(root)) throw err('not a git repository');
  const info = gitInfo(root);
  if (!info.dirty) throw err('working tree clean — nothing to describe');
  const cfg = loadConfig();
  const ref = modelRef || cfg.defaults.agentModel || cfg.defaults.chatModel;
  if (!ref) return { message: templateMessage(info), generated: false };

  const { inputChars } = contextBudget({ modelRef: ref, wantOutput: 300 });
  const cap = Math.max(2000, Math.min(inputChars - 1200, 24_000));
  const prompt = `Write a git commit message for these changes.

Format:
- Line 1: imperative subject, at most 70 chars, with a conventional-commit prefix when it fits (feat:/fix:/refactor:/docs:/chore:/test:)
- Optionally a blank line, then 1-3 short "- " bullets for the why/what that doesn't fit the subject.
Output ONLY the commit message — no fences, no quotes, no commentary.

Branch: ${info.branch}

${changesText(root, info, cap)}`;

  try {
    const res = await streamChat({
      modelRef: ref, maxTokens: 220,
      system: 'You write excellent git commit messages. Output only the message itself.',
      messages: [{ role: 'user', text: prompt }],
    });
    const msg = cleanMessage(res.text);
    if (msg) return { message: msg, generated: true };
  } catch { /* fall through to template */ }
  return { message: templateMessage(info), generated: false };
}
