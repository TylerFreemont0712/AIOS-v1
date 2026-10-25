// The one place the git workspace spawns git. Everything that touches a repository from
// the GitHub tab goes through run(): argument vectors only (never a shell string), the
// repo's top level as cwd, literal pathspecs so a filename can never be read as a glob,
// and no terminal prompts — a network command that needs a password fails with a message
// instead of hanging a request on a prompt nobody can see. Modelled on the process
// boundary in WorkHub's modules/git_service.py.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const BASE = ['--no-pager', '-c', 'color.ui=false', '-c', 'core.quotepath=off'];
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };
// An inherited git context must never redirect a command at some other repository.
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete ENV[k];

/** Remotes can carry embedded credentials (https://user:token@host); never echo those. */
export const scrub = (s) => String(s || '').replace(/(https?:\/\/)[^/\s@]+@/g, '$1[redacted]@');

/**
 * Run git. Resolves { code, out, err, killed } and never throws — callers decide what a
 * non-zero exit means. `read: true` sets GIT_OPTIONAL_LOCKS=0 so polling status never
 * takes index.lock out from under an editor or a commit running at the same moment.
 * `killed` is 'timeout' or 'size' when we stopped it; `out` then holds what arrived.
 *
 * Pathspecs are literal by default (--literal-pathspecs), so `a[1].txt` or `*.js` as a
 * filename is a filename, never a glob. `literal: false` opts out, and exists for exactly
 * one reason: with the flag set, `git stash --include-untracked` copies untracked files
 * into the stash but fails to remove them from the work tree (measured on git 2.43 — the
 * internal `git clean` inherits the flag and its own `:(top)` pathspecs stop matching), so
 * the tree is left dirty and a later apply collides with the files still sitting there.
 * Callers that opt out must quote each path as `:(literal)<path>` themselves.
 */
export function run(cwd, args, { read = false, timeoutMs = 30_000, maxBytes = 8_000_000, input, extra = [], literal = true } = {}) {
  return new Promise((resolve) => {
    const env = read ? { ...ENV, GIT_OPTIONAL_LOCKS: '0' } : ENV;
    const child = spawn('git', [...BASE, ...(literal ? ['--literal-pathspecs'] : []), ...extra, ...args], { cwd, env });
    const out = [], err = [];
    let size = 0, killed = '';
    const timer = setTimeout(() => { killed = 'timeout'; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > maxBytes) { killed ||= 'size'; child.kill('SIGKILL'); } else out.push(d);
    });
    child.stderr.on('data', (d) => { if (err.length < 200) err.push(d); });
    child.stdin.on('error', () => { });       // git exiting before it reads its input is not our error
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: '', err: `git spawn error: ${e.message}`, killed }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8'), killed });
    });
    child.stdin.end(input ?? '');
  });
}

/** Throw a readable error for a failed command; return the result otherwise. */
export function must(r, label) {
  if (r.code === 0) return r;
  if (r.killed === 'timeout') throw bad(`${label} timed out — check the remote or your credentials, then refresh`, 504);
  const msg = scrub(r.err || r.out).trim().split('\n').filter(Boolean).slice(0, 8).join('\n');
  throw bad(msg || `${label} failed`, r.code === -1 ? 500 : 400);
}

// ---------- locating the repository ----------

const tops = new Map();     // registered path -> repo top level (a project folder can sit below one)

/**
 * The repo's top level for a registered folder, or null when it is not inside a work tree.
 * `git status` prints root-relative paths wherever it is run, so every command runs from
 * here — otherwise a project folder below the repo root would stage the wrong files.
 */
export async function top(root) {
  const hit = tops.get(root);
  if (hit && Date.now() - hit.at < 60_000) return hit.top;
  const r = await run(root, ['rev-parse', '--show-toplevel'], { read: true, timeoutMs: 5000 });
  const t = r.code === 0 ? r.out.trim() : null;
  tops.set(root, { at: Date.now(), top: t });
  return t;
}

/** Drop the cached top level — after `git init`, a folder stops being "not a repo". */
export const forgetTop = (root) => { tops.delete(root); };

/** Top level, or a clear 400 that says what to do. */
export async function needRepo(root) {
  if (!fs.existsSync(root)) throw bad('that project folder no longer exists', 404);
  const t = await top(root);
  if (!t) throw bad('this folder is not a git repository — run git init first', 400);
  return t;
}

// ---------- one writer per repository ----------

const queues = new Map();
/** Serialise mutating commands per repo. Two staging clicks in a row would otherwise race
 *  for .git/index.lock and the loser would fail with a lock error that means nothing to a user. */
export function exclusive(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => { }));
  return next;
}

// ---------- validation: nothing from the client reaches git unchecked ----------

/** Repo-relative paths: no absolute paths, no `..`, nothing inside .git, no NULs. */
export function safePaths(paths, { max = 5000 } = {}) {
  if (!Array.isArray(paths) || !paths.length) throw bad('select one or more files first');
  if (paths.length > max) throw bad(`too many files in one request (${paths.length} > ${max})`);
  return paths.map((p) => {
    const v = String(p ?? '');
    if (!v || v.startsWith('/') || v.includes('\0') || v.split('/').some((x) => x === '..' || x.toLowerCase() === '.git')) {
      throw bad(`unsafe path: ${v.slice(0, 80)}`);
    }
    return v;
  });
}

/** A branch / remote-branch / tag name as typed or listed. No options (leading dash), no
 *  revision-expression syntax: what comes back out of this is only ever a plain ref name. */
export function safeRef(ref, what = 'ref') {
  const v = String(ref ?? '').trim();
  if (!v || v.length > 200 || !/^[A-Za-z0-9_][A-Za-z0-9_./@+#-]*$/.test(v) || v.includes('..') || v.endsWith('/') || v.endsWith('.lock')) {
    throw bad(`invalid ${what}: ${v.slice(0, 60) || '(empty)'}`);
  }
  return v;
}

export const safeHash = (h) => {
  const v = String(h ?? '').trim();
  if (!/^[0-9a-f]{4,64}$/i.test(v)) throw bad('invalid commit id');
  return v;
};

/** "a...b" or "a..b" between two plain refs/hashes, for compare views. */
export function safeRange(range) {
  const m = /^(.+?)(\.\.\.?)(.+)$/.exec(String(range ?? ''));
  if (!m) throw bad('invalid range');
  const side = (s) => /^[0-9a-f]{4,64}$/i.test(s) ? s : safeRef(s, 'ref');
  return `${side(m[1])}${m[2]}${side(m[3])}`;
}

export const abs = (top, rel) => path.join(top, rel);

// ---------- `git status --porcelain=v2 --branch -z` ----------

/**
 * Parse porcelain v2. Chosen over v1 because one call also yields the branch, its upstream
 * and ahead/behind, and because renames arrive with both paths. Paths are always relative
 * to the repo top level. Entry shapes (fields are space-separated, the path is the rest):
 *   1 XY sub mH mI mW hH hI <path>                 ordinary change
 *   2 XY sub mH mI mW hH hI Xscore <path>\0<orig>  rename / copy
 *   u XY sub m1 m2 m3 mW h1 h2 h3 <path>           unmerged (conflict)
 *   ? <path>                                       untracked
 * X is the index side, Y the work-tree side; '.' means unchanged.
 */
export function parseStatus(out) {
  const tokens = String(out || '').split('\0');
  const branch = { oid: '', head: '', upstream: '', ahead: 0, behind: 0, hasUpstream: false };
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const [, key, ...rest] = t.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') branch.oid = val === '(initial)' ? '' : val;
      else if (key === 'branch.head') branch.head = val;
      else if (key === 'branch.upstream') { branch.upstream = val; branch.hasUpstream = true; }
      else if (key === 'branch.ab') { const m = /\+(\d+) -(\d+)/.exec(val); if (m) { branch.ahead = +m[1]; branch.behind = +m[2]; } }
      continue;
    }
    const kind = t[0];
    if (kind === '?') { entries.push({ path: t.slice(2), x: '.', y: '?', kind: 'untracked' }); continue; }
    if (kind === '1') {
      const f = t.split(' ');
      entries.push({ path: f.slice(8).join(' '), x: f[1][0], y: f[1][1], kind: 'ordinary', sub: f[2] !== 'N...' });
    } else if (kind === '2') {
      const f = t.split(' ');
      entries.push({ path: f.slice(9).join(' '), orig: tokens[++i] || '', x: f[1][0], y: f[1][1], kind: 'rename', sub: f[2] !== 'N...' });
    } else if (kind === 'u') {
      const f = t.split(' ');
      entries.push({ path: f.slice(10).join(' '), x: f[1][0], y: f[1][1], kind: 'unmerged', sub: f[2] !== 'N...' });
    }
  }
  return { branch, entries };
}

/** Counts the UI badges are built from. A file edited after being staged counts in both. */
export function countEntries(entries) {
  const c = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, total: entries.length };
  for (const e of entries) {
    if (e.kind === 'untracked') c.untracked++;
    else if (e.kind === 'unmerged') c.conflicts++;
    else { if (e.x !== '.') c.staged++; if (e.y !== '.') c.unstaged++; }
  }
  return c;
}
