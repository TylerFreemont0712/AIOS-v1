// The map of every project on this machine: one row per registered folder with its branch,
// how much is uncommitted, what is unpushed or unpulled, and — the part the list is sorted
// by — when it last CHANGED. "Changed" is the newer of the last commit and the newest
// edited file that is not committed yet, so a repo you were typing in ten minutes ago sorts
// above one whose last commit was yesterday, even though git log would say otherwise.
//
// Read-only. Everything that writes lives in gitwork.js.

import fs from 'node:fs';
import path from 'node:path';
import { run, top, forgetTop, parseStatus, countEntries, scrub } from './gitrun.js';

const TTL_MS = 20_000;
const cache = new Map();         // registered path -> { at, value }
const inflight = new Map();      // registered path -> promise (collapse concurrent callers)

/** Forget a repo's cached summary — every write operation calls this. */
export const invalidate = (root) => { cache.delete(root); forgetTop(root); };

/** "https://github.com/o/r.git" / "git@github.com:o/r.git" -> { owner, repo } or null. */
export function githubSlug(remote) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(remote || ''));
  return m ? { owner: m[1], repo: m[2], slug: `${m[1]}/${m[2]}` } : null;
}

/** A remote URL reduced to something two clones of the same repo agree on. */
const remoteKey = (remote) => scrub(remote).toLowerCase()
  .replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '').replace(/\/$/, '');

// A folder with no repo is judged by its files, but never by walking into dependencies.
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', 'target', '.godot', '.import', '.cache', '.next', '.gradle']);

/** Newest file mtime and file count under a folder, bounded so a huge tree cannot stall the list. */
export function walkFolder(dir, { maxEntries = 20_000, maxDepth = 6 } = {}) {
  let newest = 0, files = 0, seen = 0, truncated = false;
  const stack = [[dir, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++seen > maxEntries) { truncated = true; stack.length = 0; break; }
      if (e.isDirectory()) { if (depth < maxDepth && !SKIP_DIRS.has(e.name)) stack.push([path.join(d, e.name), depth + 1]); continue; }
      if (!e.isFile()) continue;
      files++;
      try { const m = fs.lstatSync(path.join(d, e.name)).mtimeMs; if (m > newest) newest = m; } catch { }
    }
  }
  return { files, newest, truncated };
}

/** Immediate child folders that are themselves repos (a container like WorkHub/<repo>). */
function childRepos(dir) {
  const out = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(dir, e.name, '.git'))) out.push(e.name);
    }
  } catch { }
  return out;
}

async function folderSummary(root) {
  const w = walkFolder(root);
  let at = w.newest;
  if (!at) { try { at = fs.statSync(root).mtimeMs; } catch { } }
  return {
    repo: false, empty: w.files === 0, files: w.files, filesTruncated: w.truncated,
    contains: childRepos(root), activityAt: at, activityKind: 'files',
  };
}

async function repoSummaryUncached(root, topDir) {
  const [st, lg, sl, cf] = await Promise.all([
    run(topDir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], { read: true, timeoutMs: 15_000, maxBytes: 4_000_000 }),
    run(topDir, ['log', '-1', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct'], { read: true, timeoutMs: 8000 }),
    run(topDir, ['stash', 'list', '--format=%H'], { read: true, timeoutMs: 5000 }),
    run(topDir, ['config', '--get-regexp', '^remote\\..*\\.url$'], { read: true, timeoutMs: 5000 }),
  ]);
  if (st.code !== 0) return { repo: false, error: scrub(st.err).trim().slice(0, 200) };
  const { branch, entries } = parseStatus(st.out);
  const counts = countEntries(entries);

  // newest edit among uncommitted paths (bounded: a 5,000-file refactor must not stat 5,000 files)
  let dirtyAt = 0;
  for (const e of entries.slice(0, 400)) {
    try { const m = fs.lstatSync(path.join(topDir, e.path)).mtimeMs; if (m > dirtyAt) dirtyAt = m; } catch { }
  }

  let last = null;
  if (lg.code === 0 && lg.out.trim()) {
    const [hash, short, subject, author, ct] = lg.out.trim().split('\x1f');
    last = { hash, short, subject, author, at: Number(ct) * 1000 };
  }
  const remotes = {};
  for (const line of cf.out.split('\n').filter(Boolean)) {
    const m = /^remote\.(.+)\.url\s+(.+)$/.exec(line);
    if (m) remotes[m[1]] = scrub(m[2]);
  }
  const remote = remotes.origin || Object.values(remotes)[0] || '';

  let activityAt = Math.max(last?.at || 0, dirtyAt);
  if (!activityAt) { try { activityAt = fs.statSync(topDir).mtimeMs; } catch { } }

  return {
    repo: true,
    subdir: path.resolve(topDir) !== path.resolve(root) ? topDir : '',
    branch: branch.head === '(detached)' ? 'HEAD' : branch.head,
    detached: branch.head === '(detached)',
    head: branch.oid.slice(0, 7),
    hasCommits: !!last,
    upstream: branch.upstream, hasUpstream: branch.hasUpstream,
    ahead: branch.ahead, behind: branch.behind,
    counts, dirty: counts.total,
    lastCommit: last,
    stashes: sl.out.split('\n').filter(Boolean).length,
    remote, remotes: Object.keys(remotes),
    github: githubSlug(remote)?.slug || '',
    dirtyAt: dirtyAt || null,
    activityAt,
    activityKind: dirtyAt && dirtyAt > (last?.at || 0) ? 'uncommitted' : 'commit',
  };
}

/** Summary for one registered path. Cached briefly; concurrent callers share one run. */
export async function summarize(root, { fresh = false } = {}) {
  if (!fresh) {
    const hit = cache.get(root);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  }
  if (inflight.has(root)) return inflight.get(root);
  const p = (async () => {
    if (!fs.existsSync(root)) return { repo: false, missing: true, activityAt: 0, activityKind: 'missing' };
    const t = await top(root);
    const value = t ? await repoSummaryUncached(root, t) : await folderSummary(root);
    if (value.repo === false && !value.missing && value.error) return value;       // do not cache a failure
    cache.set(root, { at: Date.now(), value });
    return value;
  })().finally(() => inflight.delete(root));
  inflight.set(root, p);
  return p;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/**
 * Every registered project with its git state, newest change first.
 * `registry` is the plain project list ({ id, name, path, favorite, lastOpenedAt }).
 */
export async function overview(registry, { fresh = false } = {}) {
  const rows = await pool(registry, 4, async (p) => ({ ...p, ...(await summarize(p.path, { fresh })) }));

  // Two registered folders that are clones of the same remote — worth saying out loud, since
  // edits to one never show up in the other.
  const byRemote = new Map();
  for (const r of rows) {
    if (!r.repo || !r.remote) continue;
    const k = remoteKey(r.remote);
    (byRemote.get(k) || byRemote.set(k, []).get(k)).push(r);
  }
  for (const group of byRemote.values()) {
    if (group.length < 2) continue;
    for (const r of group) r.alsoAt = group.filter((o) => o !== r).map((o) => ({ id: o.id, name: o.name, path: o.path }));
  }

  rows.sort((a, b) => (b.activityAt || 0) - (a.activityAt || 0) || a.name.localeCompare(b.name));
  return rows.map((r) => ({
    ...r,
    activityAt: r.activityAt ? new Date(r.activityAt).toISOString() : null,
    dirtyAt: r.dirtyAt ? new Date(r.dirtyAt).toISOString() : null,
    lastCommit: r.lastCommit ? { ...r.lastCommit, at: new Date(r.lastCommit.at).toISOString() } : null,
  }));
}

/** Roll-up numbers for the strip above the list. */
export function totals(rows) {
  const t = { projects: rows.length, repos: 0, uncommitted: 0, unpushed: 0, behind: 0, noRemote: 0, notRepos: 0 };
  for (const r of rows) {
    if (!r.repo) { t.notRepos++; continue; }
    t.repos++;
    if (r.dirty) t.uncommitted++;
    if (r.ahead) t.unpushed++;
    if (r.behind) t.behind++;
    if (!r.remote) t.noRemote++;
  }
  return t;
}

// ---------- discovery: what is in the projects folder that is not registered yet ----------

/** origin's URL straight from .git/config — a small file read, no git process per folder. */
function configRemote(dir) {
  try {
    const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const m = /\[remote "origin"\][^\[]*?\burl\s*=\s*(\S+)/.exec(cfg);
    return m ? remoteKey(m[1]) : '';
  } catch { return ''; }   // a worktree's .git is a file, and there may be no config at all
}

/**
 * Look through a projects root for folders worth registering. Classifies each as a repo,
 * a plain folder, an empty folder, a symlink out of the tree, or a container whose
 * repos are one level down (those repos are offered instead of the wrapper).
 */
export function discover(root, registeredPaths = []) {
  const reg = new Set(registeredPaths.map((p) => path.resolve(p)));
  // remote -> where that repo is already known, so a second clone is offered but not pre-ticked
  const known = new Map();
  for (const p of registeredPaths) { const k = configRemote(p); if (k && !known.has(k)) known.set(k, path.basename(p)); }
  const out = [];
  const markClone = (item) => {
    const k = configRemote(item.path);
    if (!k) return;
    if (known.has(k) && !item.registered) {
      item.suggested = false;
      item.note = `${item.note ? item.note + ' · ' : ''}a second clone of ${known.get(k)} (same remote) — tick it if you want both`;
    } else if (!known.has(k)) known.set(k, item.name);
  };
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const abs = path.join(root, e.name);
    const item = { name: e.name, path: abs, registered: reg.has(path.resolve(abs)), kind: 'folder', suggested: false, note: '' };
    if (e.isSymbolicLink()) {
      let target = '';
      try { target = fs.realpathSync(abs); } catch { }
      item.kind = 'symlink'; item.note = target ? `link to ${target} — outside this folder, not added by default` : 'broken link';
      out.push(item); continue;
    }
    if (!e.isDirectory()) continue;
    if (fs.existsSync(path.join(abs, '.git'))) {
      item.kind = 'repo'; item.suggested = !item.registered;
      markClone(item);
      out.push(item); continue;
    }
    const kids = childRepos(abs);
    const w = walkFolder(abs, { maxEntries: 3000, maxDepth: 3 });
    if (kids.length) {
      item.kind = 'container'; item.note = `holds ${kids.join(', ')}`;
      out.push(item);
      for (const k of kids) {
        const kp = path.join(abs, k);
        const kid = { name: `${e.name}/${k}`, path: kp, registered: reg.has(path.resolve(kp)), kind: 'repo', suggested: !reg.has(path.resolve(kp)), note: `inside ${e.name}` };
        markClone(kid);
        out.push(kid);
      }
      continue;
    }
    if (!w.files) { item.kind = 'empty'; item.note = 'empty folder'; out.push(item); continue; }
    item.suggested = !item.registered; item.note = `${w.files}${w.truncated ? '+' : ''} files, not a git repo`;
    out.push(item);
  }
  return out;
}
