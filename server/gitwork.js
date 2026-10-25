// The git workspace behind the GitHub tab: look at a repository (status split into staged
// and unstaged, per-file and per-hunk diffs, history, branches, stashes) and control it
// (stage, unstage, discard, commit only what is staged, branch, stash, fetch / pull / push
// with a look at what will move first). Modelled on WorkHub's Git workspace
// (modules/git_service.py): literal pathspecs, no terminal prompts, and a digest of the
// staged tree that invalidates a stale commit review.
//
// Reads run freely. Writes are serialised per repository and invalidate the cached
// summary the project list is built from. Nothing here pushes, force-anything, or deletes
// history unless the caller says so explicitly, and the destructive ones (discard, drop,
// force-delete) additionally require `confirm: true` that only a confirmation dialog sends.

import fs from 'node:fs';
import path from 'node:path';
import * as git from './git.js';
import * as github from './github.js';
import { invalidate, githubSlug } from './repos.js';
import {
  run, must, bad, scrub, needRepo, exclusive, safePaths, safeRef, safeHash, safeRange,
  parseStatus, countEntries,
} from './gitrun.js';

const clamp = (n, lo, hi, dflt) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt; };
const lines = (s) => String(s || '').split('\n').filter(Boolean);

const read = async (root, fn) => fn(await needRepo(root));
/** A write: waits its turn for this repo, and always drops the cached summary afterwards. */
const write = async (root, fn) => {
  const t = await needRepo(root);
  try { return await exclusive(t, () => fn(t)); } finally { invalidate(root); }
};

// ---------- status ----------

/** Per-path +/- counts from `diff --numstat -z`. Renames arrive as `add\tdel\t\0old\0new\0`. */
function parseNumstat(out) {
  const map = new Map();
  const tok = String(out || '').split('\0');
  for (let i = 0; i < tok.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(tok[i]);
    if (!m) continue;
    let p = m[3];
    if (!p) { i += 2; p = tok[i] || ''; }          // rename: the next two tokens are old, new
    map.set(p, { add: m[1] === '-' ? null : +m[1], del: m[2] === '-' ? null : +m[2] });
  }
  return map;
}

const IN_PROGRESS = [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']];

/** Everything the Changes view needs, in one call. */
export function status(root) {
  return read(root, async (t) => {
    const [st, sl, lg, cf, gd, numU, numS] = await Promise.all([
      run(t, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { read: true, timeoutMs: 25_000, maxBytes: 8_000_000 }),
      run(t, ['stash', 'list', '--format=%H'], { read: true, timeoutMs: 5000 }),
      run(t, ['log', '-1', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct'], { read: true, timeoutMs: 8000 }),
      run(t, ['config', '--get-regexp', '^remote\\..*\\.url$'], { read: true, timeoutMs: 5000 }),
      run(t, ['rev-parse', '--absolute-git-dir'], { read: true, timeoutMs: 5000 }),
      run(t, ['diff', '--numstat', '-M', '-z', '--no-ext-diff', '--no-textconv'], { read: true, timeoutMs: 25_000, maxBytes: 4_000_000 }),
      run(t, ['diff', '--cached', '--numstat', '-M', '-z', '--no-ext-diff', '--no-textconv'], { read: true, timeoutMs: 25_000, maxBytes: 4_000_000 }),
    ]);
    must(st, 'git status');
    const { branch, entries } = parseStatus(st.out);
    const nU = parseNumstat(numU.out), nS = parseNumstat(numS.out);
    const CAP = 4000;
    const files = entries.slice(0, CAP).map((e) => {
      const u = nU.get(e.path), s = nS.get(e.path);
      return {
        path: e.path, orig: e.orig || '',
        x: e.x === '.' ? ' ' : e.x, y: e.kind === 'untracked' ? '?' : (e.y === '.' ? ' ' : e.y),
        staged: e.kind !== 'untracked' && e.kind !== 'unmerged' && e.x !== '.',
        unstaged: e.kind === 'untracked' || (e.kind !== 'unmerged' && e.y !== '.'),
        untracked: e.kind === 'untracked', conflict: e.kind === 'unmerged', submodule: !!e.sub,
        addU: u?.add ?? null, delU: u?.del ?? null, addS: s?.add ?? null, delS: s?.del ?? null,
      };
    });
    let last = null;
    if (lg.code === 0 && lg.out.trim()) {
      const [hash, short, subject, author, ct] = lg.out.trim().split('\x1f');
      last = { hash, short, subject, author, at: new Date(Number(ct) * 1000).toISOString() };
    }
    const remotes = {};
    for (const line of lines(cf.out)) { const m = /^remote\.(.+)\.url\s+(.+)$/.exec(line); if (m) remotes[m[1]] = scrub(m[2]); }
    const gitDir = gd.out.trim();
    const inProgress = IN_PROGRESS.find(([f]) => gitDir && fs.existsSync(path.join(gitDir, f)))?.[1] || '';
    return {
      top: t, branch: branch.head === '(detached)' ? 'HEAD' : branch.head, detached: branch.head === '(detached)',
      head: branch.oid.slice(0, 7), hasCommits: !!last, lastCommit: last,
      upstream: branch.upstream, hasUpstream: branch.hasUpstream, ahead: branch.ahead, behind: branch.behind,
      files, counts: countEntries(entries), truncated: entries.length > CAP,
      stashCount: lines(sl.out).length, remotes, github: githubSlug(remotes.origin || Object.values(remotes)[0])?.slug || '',
      inProgress,
    };
  });
}

// ---------- diffs ----------

const DIFF_CAP = 700_000;

function diffStats(diff) {
  let add = 0, del = 0, inHunk = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (l.startsWith('+')) add++; else if (l.startsWith('-')) del++;
  }
  return { additions: add, deletions: del };
}

const ctxArg = (context) => context === 'full' ? 100000 : clamp(context, 0, 1000, 3);

/**
 * One file's unified diff from one of: the work tree (default), the index (`staged`), a
 * commit (`commit`), or a compare range (`range`). An untracked file has no diff in git's
 * eyes, so it is shown as all additions, the way WorkHub's untracked-file view does.
 */
export function fileDiff(root, { path: rel, staged = false, commit = '', range = '', context = 3, ignoreWs = false } = {}) {
  return read(root, async (t) => {
    const [p] = safePaths([rel]);
    const u = ctxArg(context);
    const common = ['--no-ext-diff', '--no-textconv', '--no-color', `-U${u}`, ...(ignoreWs ? ['-w'] : [])];
    let args;
    if (commit) args = ['show', '--format=', '-m', '--first-parent', ...common, safeHash(commit), '--', p];
    else if (range) args = ['diff', ...common, safeRange(range), '--', p];
    else if (staged) args = ['diff', '--cached', ...common, '--', p];
    else args = ['diff', ...common, '--', p];
    let r = await run(t, args, { read: true, maxBytes: DIFF_CAP, timeoutMs: 20_000 });
    if (r.code !== 0 && !r.killed) must(r, 'git diff');
    let diff = r.out, note = '';

    if (!diff && !staged && !commit && !range) {
      const un = await run(t, ['ls-files', '--others', '--exclude-standard', '-z', '--', p], { read: true, timeoutMs: 8000 });
      if (un.out.split('\0').includes(p)) {
        const file = path.join(t, p);
        let size = 0;
        try { size = fs.statSync(file).size; } catch { }
        if (size > 1_000_000) note = `new file, ${(size / 1e6).toFixed(1)} MB — too large to show here`;
        else {
          let head = Buffer.alloc(0);
          try { const fd = fs.openSync(file, 'r'); head = Buffer.alloc(Math.min(8192, size)); fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd); } catch { }
          if (head.includes(0)) note = `new binary file, ${size} bytes`;
          else {
            // --no-index exits 1 when the files differ, which is what we expect
            r = await run(t, ['diff', '--no-index', '--no-color', `-U${u}`, '--', '/dev/null', p], { read: true, maxBytes: DIFF_CAP });
            diff = r.out;
          }
        }
      }
    }
    const binary = /^Binary files .* differ$/m.test(diff) || /^GIT binary patch/m.test(diff);
    if (binary) diff = '';
    if (!diff && !binary && !note) note = ignoreWs ? 'no changes once whitespace is ignored' : 'no textual changes (a mode change, or the file matches)';
    return { path: p, diff, binary, truncated: r.killed === 'size', note, ...diffStats(diff) };
  });
}

// ---------- staging ----------

export const stage = (root, { paths, all = false } = {}) => write(root, async (t) => {
  if (all) {
    // `git add -A` would record a nested repo as a gitlink with no .gitmodules — a trap
    const nested = git.nestedRepos(t);
    if (nested.length) throw bad(`can't stage everything: ${nested.map((n) => `"${n}/"`).join(', ')} ${nested.length > 1 ? 'are git repos' : 'is a git repo'} nested inside this one. Add ${nested.length > 1 ? 'them' : 'it'} to .gitignore, move ${nested.length > 1 ? 'them' : 'it'} out, or stage files individually.`, 409);
    must(await run(t, ['add', '-A']), 'git add');
    return { ok: true, all: true };
  }
  const ps = safePaths(paths);
  must(await run(t, ['add', '--', ...ps]), 'git add');
  return { ok: true, staged: ps.length };
});

export const unstage = (root, { paths, all = false } = {}) => write(root, async (t) => {
  const hasHead = (await run(t, ['rev-parse', '--verify', '-q', 'HEAD'], { read: true })).code === 0;
  if (all) {
    must(await run(t, hasHead ? ['reset', '-q'] : ['rm', '-r', '--cached', '-q', '--', '.']), 'git reset');
    return { ok: true, all: true };
  }
  const ps = safePaths(paths);
  must(await run(t, hasHead ? ['restore', '--staged', '--', ...ps] : ['rm', '-r', '--cached', '-q', '--', ...ps]), 'git restore');
  return { ok: true, unstaged: ps.length };
});

/**
 * Stage (or, with `reverse`, unstage) a single hunk. The server re-derives the diff and
 * checks that the hunk at `index` still starts with the header the client was showing; if
 * the file moved under the user it says so rather than staging the wrong lines.
 */
export const stageHunk = (root, { path: rel, index, header, reverse = false, context = 3 } = {}) => write(root, async (t) => {
  const [p] = safePaths([rel]);
  const r = must(await run(t, ['diff', ...(reverse ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--no-color', `-U${ctxArg(context)}`, '--', p], { read: true, maxBytes: DIFF_CAP }), 'git diff');
  const all = r.out.replace(/\n$/, '').split('\n');
  const first = all.findIndex((l) => l.startsWith('@@'));
  if (first < 0) throw bad('this file has no hunks to stage — stage the whole file instead', 409);
  const head = all.slice(0, first);
  const hunks = [];
  for (const l of all.slice(first)) { if (l.startsWith('@@')) hunks.push([l]); else hunks[hunks.length - 1].push(l); }
  const h = hunks[Number(index)];
  if (!h || h[0] !== header) throw bad('the file changed since you opened it — refresh and try again', 409);
  const patch = `${head.join('\n')}\n${h.join('\n')}\n`;
  must(await run(t, ['apply', '--cached', '--recount', ...(reverse ? ['--reverse'] : []), '-'], { input: patch }), 'git apply');
  return { ok: true };
});

/** Throw away work-tree changes. Irreversible, so it needs `confirm: true` on top of the dialog. */
export const discard = (root, { paths, confirm = false } = {}) => write(root, async (t) => {
  if (confirm !== true) throw bad('discarding changes needs explicit confirmation');
  const ps = safePaths(paths);
  const un = new Set((await run(t, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...ps], { read: true })).out.split('\0').filter(Boolean));
  const tracked = ps.filter((p) => !un.has(p));
  if (tracked.length) must(await run(t, ['restore', '--worktree', '--', ...tracked]), 'git restore');
  if (un.size) must(await run(t, ['clean', '-f', '--', ...un]), 'git clean');
  return { ok: true, restored: tracked.length, removed: un.size };
});

// ---------- commit ----------

/** A fingerprint of exactly what is staged. `write-tree` hashes the index; it fails on
 *  unmerged entries, which a commit would too. */
async function indexDigest(t) {
  const r = await run(t, ['write-tree'], { timeoutMs: 15_000 });
  return r.code === 0 ? r.out.trim() : '';
}

/** The staged patch for review, plus the digest the commit must present back. */
export function stagedPatch(root) {
  return read(root, async (t) => {
    const [p, ns, ds] = await Promise.all([
      run(t, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-color'], { read: true, maxBytes: 1_500_000, timeoutMs: 25_000 }),
      run(t, ['diff', '--cached', '--numstat', '-M', '-z', '--no-ext-diff', '--no-textconv'], { read: true, maxBytes: 2_000_000 }),
      indexDigest(t),
    ]);
    const stats = parseNumstat(ns.out);
    const files = [...stats].map(([file, v]) => ({ path: file, additions: v.add, deletions: v.del }));
    return { patch: p.out, truncated: p.killed === 'size', digest: ds, files };
  });
}

/** Commit what is staged and nothing else. Unstaged changes are left exactly as they were. */
export const commit = (root, { message, digest = '' } = {}) => write(root, async (t) => {
  const msg = String(message || '').trim();
  if (!msg) throw bad('enter a commit message');
  if (msg.length > 20_000) throw bad('that commit message is too long');
  const staged = must(await run(t, ['diff', '--cached', '--name-only', '-z']), 'git diff').out;
  if (!staged) throw bad('nothing is staged — stage the changes you want in this commit', 409);
  if (digest) {
    const cur = await indexDigest(t);
    if (cur && cur !== digest) throw bad('the staged changes changed after you reviewed them — review again before committing', 409);
  }
  await git.ensureIdentity(t);
  must(await run(t, ['commit', '-F', '-'], { input: `${msg}\n`, timeoutMs: 120_000 }), 'git commit');
  const hash = (await run(t, ['rev-parse', '--short', 'HEAD'], { read: true })).out.trim();
  return { ok: true, hash, message: msg.split('\n')[0], files: staged.split('\0').filter(Boolean).length };
});

// ---------- history ----------

const FMT = '%H%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%D%x1f%s%x1e';

function parseRefs(deco, remoteNames) {
  const out = [];
  for (const raw of String(deco || '').split(', ').map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith('HEAD -> ')) out.push({ name: raw.slice(8), type: 'branch', head: true });
    else if (raw === 'HEAD') out.push({ name: 'HEAD', type: 'head' });
    else if (raw.startsWith('tag: ')) out.push({ name: raw.slice(5), type: 'tag' });
    else if (remoteNames.has(raw.split('/')[0])) { if (!raw.endsWith('/HEAD')) out.push({ name: raw, type: 'remote' }); }
    else out.push({ name: raw, type: 'branch' });
  }
  return out;
}

function parseLog(out, remoteNames) {
  return String(out || '').split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [hash, parents, author, email, ct, deco, subject] = r.split('\x1f');
    return {
      hash, short: hash.slice(0, 7), parents: parents ? parents.split(' ') : [], author, email,
      at: new Date(Number(ct) * 1000).toISOString(), refs: parseRefs(deco, remoteNames), subject,
    };
  });
}

async function remoteNames(t) { return new Set(lines((await run(t, ['remote'], { read: true, timeoutMs: 5000 })).out)); }
const noCommits = (r) => /does not have any commits yet|unknown revision|bad default revision|ambiguous argument/i.test(r.err + r.out);

export function log(root, { ref = '', all = false, limit = 60, skip = 0, path: rel = '', search = '' } = {}) {
  return read(root, async (t) => {
    const lim = clamp(limit, 1, 300, 60);
    const args = ['log', `--max-count=${lim + 1}`, `--skip=${clamp(skip, 0, 1_000_000, 0)}`, '--date-order', `--format=${FMT}`];
    if (search) args.push('--regexp-ignore-case', '--fixed-strings', `--grep=${String(search).slice(0, 200)}`);
    args.push(all ? '--all' : ref ? safeRef(ref, 'branch') : 'HEAD');
    if (rel) args.push('--', safePaths([rel])[0]);
    const [r, rn] = await Promise.all([run(t, args, { read: true, timeoutMs: 20_000, maxBytes: 4_000_000 }), remoteNames(t)]);
    if (r.code !== 0) { if (noCommits(r)) return { commits: [], hasMore: false }; must(r, 'git log'); }
    const commits = parseLog(r.out, rn);
    return { commits: commits.slice(0, lim), hasMore: commits.length > lim };
  });
}

/** One commit: message, parents, and its changed files with +/- counts. */
export function commitDetail(root, hash) {
  return read(root, async (t) => {
    const h = safeHash(hash);
    const meta = must(await run(t, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%D%x1f%B', h], { read: true, timeoutMs: 10_000 }), 'git show');
    const [hh, parents, author, email, ct, deco, ...body] = meta.out.split('\x1f');
    // A merge is shown against its FIRST parent — what the merge brought into this branch.
    // (diff-tree has a --first-parent flag that it silently ignores, printing the union of
    // every parent's diff, so the two trees are named explicitly instead.)
    const first = (parents || '').split(' ').filter(Boolean);
    const tree = ['diff-tree', '-r', '-M', '--no-commit-id', '-z', ...(first.length ? [] : ['--root'])];
    const range = first.length > 1 ? [first[0], hh] : [hh];
    const [ns, nn, rn] = await Promise.all([
      run(t, [...tree, '--name-status', ...range], { read: true, timeoutMs: 15_000, maxBytes: 4_000_000 }),
      run(t, [...tree, '--numstat', ...range], { read: true, timeoutMs: 15_000, maxBytes: 4_000_000 }),
      remoteNames(t),
    ]);
    const stats = parseNumstat(nn.out);
    const files = [];
    const tok = ns.out.split('\0').filter((x) => x !== '');
    for (let i = 0; i < tok.length; i++) {
      const st = tok[i];
      if (!/^[A-Z]\d*$/.test(st)) continue;
      const renamed = st[0] === 'R' || st[0] === 'C';
      const from = renamed ? tok[++i] : '';
      const file = tok[++i];
      const s = stats.get(file);
      files.push({ path: file, orig: from, status: st[0], additions: s?.add ?? null, deletions: s?.del ?? null });
    }
    const message = body.join('\x1f').trim();
    return {
      hash: hh, short: hh.slice(0, 7), parents: parents ? parents.split(' ') : [], author, email,
      at: new Date(Number(ct) * 1000).toISOString(), refs: parseRefs(deco, rn),
      subject: message.split('\n')[0], message, files,
    };
  });
}

// ---------- branches ----------

const TRACK = (s) => {
  if (!s) return { ahead: 0, behind: 0, gone: false };
  const a = /ahead (\d+)/.exec(s), b = /behind (\d+)/.exec(s);
  return { ahead: a ? +a[1] : 0, behind: b ? +b[1] : 0, gone: /gone/.test(s) };
};

export function branches(root) {
  return read(root, async (t) => {
    const fmt = ['%(refname)', '%(refname:short)', '%(objectname:short)', '%(upstream:short)', '%(upstream:track)', '%(committerdate:unix)', '%(subject)', '%(HEAD)', '%(authorname)'].join('%1f');
    const [fe, cur, sym] = await Promise.all([
      run(t, ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads', 'refs/remotes'], { read: true, timeoutMs: 15_000, maxBytes: 4_000_000 }),
      run(t, ['symbolic-ref', '-q', '--short', 'HEAD'], { read: true }),
      run(t, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { read: true }),
    ]);
    must(fe, 'git for-each-ref');
    const locals = [], remotes = [];
    for (const line of lines(fe.out)) {
      const [ref, name, hash, upstream, track, ct, subject, head, author] = line.split('\x1f');
      const base = { name, hash, subject, author, at: ct ? new Date(Number(ct) * 1000).toISOString() : null };
      if (ref.startsWith('refs/heads/')) locals.push({ ...base, current: head === '*', upstream, ...TRACK(track) });
      else if (ref.startsWith('refs/remotes/') && !name.endsWith('/HEAD')) remotes.push({ ...base, remote: name.split('/')[0] });
    }
    // "merged" is judged against the default branch, so a finished branch is easy to spot
    const names = new Set(locals.map((b) => b.name));
    const baseName = (sym.code === 0 ? sym.out.trim().replace(/^origin\//, '') : '') || ['main', 'master'].find((n) => names.has(n)) || '';
    let merged = new Set();
    if (baseName && names.has(baseName)) {
      const m = await run(t, ['branch', '--merged', baseName, '--format=%(refname:short)'], { read: true, timeoutMs: 10_000 });
      if (m.code === 0) merged = new Set(lines(m.out));
    }
    for (const b of locals) b.merged = !b.current && b.name !== baseName && merged.has(b.name);
    for (const r of remotes) r.hasLocal = names.has(r.name.slice(r.remote.length + 1));
    return { current: cur.code === 0 ? cur.out.trim() : '', detached: cur.code !== 0, base: baseName, locals, remotes };
  });
}

export const createBranch = (root, { name, from = '', checkout = true } = {}) => write(root, async (t) => {
  const n = String(name || '').trim();
  const chk = await run(t, ['check-ref-format', '--branch', n], { read: true });
  if (!n || chk.code !== 0 || n.startsWith('-')) throw bad(`"${n.slice(0, 60)}" is not a valid branch name`);
  const start = from ? [/^[0-9a-f]{4,64}$/i.test(from) ? from : safeRef(from, 'start point')] : [];
  must(await run(t, checkout ? ['switch', '-c', n, ...start] : ['branch', n, ...start]), 'git branch');
  return { ok: true, branch: n, checkedOut: !!checkout };
});

/** Switch branches. `remoteBranch` ("origin/foo") creates a local branch that tracks it. */
export const checkout = (root, { branch = '', remoteBranch = '' } = {}) => write(root, async (t) => {
  if (remoteBranch) {
    const rb = safeRef(remoteBranch, 'remote branch');
    const local = rb.slice(rb.indexOf('/') + 1);
    const exists = (await run(t, ['rev-parse', '--verify', '-q', `refs/heads/${local}`], { read: true })).code === 0;
    must(await run(t, exists ? ['switch', local] : ['switch', '--track', rb]), 'git switch');
    return { ok: true, branch: local };
  }
  const b = safeRef(branch, 'branch');
  must(await run(t, ['switch', b]), 'git switch');
  return { ok: true, branch: b };
});

export const deleteBranch = (root, { name, force = false, confirm = false } = {}) => write(root, async (t) => {
  const n = safeRef(name, 'branch');
  const cur = (await run(t, ['symbolic-ref', '-q', '--short', 'HEAD'], { read: true })).out.trim();
  if (n === cur) throw bad('that is the branch you are on — switch to another branch first', 409);
  if (force && confirm !== true) throw bad('force-deleting a branch needs explicit confirmation');
  const r = await run(t, ['branch', force ? '-D' : '-d', n]);
  if (r.code !== 0 && /not fully merged/i.test(r.err + r.out)) {
    const base = (await run(t, ['rev-parse', '--abbrev-ref', `${n}@{upstream}`], { read: true })).out.trim() || cur;
    const cnt = (await run(t, ['rev-list', '--count', `${base}..${n}`], { read: true })).out.trim();
    throw Object.assign(bad(`"${n}" has ${cnt || 'some'} commit${cnt === '1' ? ' that exists' : 's that exist'} nowhere else — deleting it would lose ${cnt === '1' ? 'it' : 'them'}`, 409), { unmerged: true });
  }
  must(r, 'git branch -d');
  return { ok: true };
});

/** What differs between two refs: commits each side has, and the files a PR would show. */
export function compare(root, { base, head } = {}) {
  return read(root, async (t) => {
    const side = (s) => /^[0-9a-f]{4,64}$/i.test(s) ? s : safeRef(s, 'ref');
    const b = side(base), h = side(head);
    const [cnt, lg, ns, nn, rn] = await Promise.all([
      run(t, ['rev-list', '--left-right', '--count', `${b}...${h}`], { read: true }),
      run(t, ['log', '--max-count=100', '--date-order', `--format=${FMT}`, `${b}..${h}`], { read: true, maxBytes: 2_000_000 }),
      run(t, ['diff', '--name-status', '-M', '-z', '--no-ext-diff', `${b}...${h}`], { read: true, maxBytes: 4_000_000 }),
      run(t, ['diff', '--numstat', '-M', '-z', '--no-ext-diff', `${b}...${h}`], { read: true, maxBytes: 4_000_000 }),
      remoteNames(t),
    ]);
    must(cnt, 'git rev-list'); must(lg, 'git log');
    const [behind, ahead] = cnt.out.trim().split(/\s+/).map(Number);
    const stats = parseNumstat(nn.out);
    const files = [];
    const tok = ns.out.split('\0').filter((x) => x !== '');
    for (let i = 0; i < tok.length; i++) {
      const st = tok[i];
      if (!/^[A-Z]\d*$/.test(st)) continue;
      const renamed = st[0] === 'R' || st[0] === 'C';
      const from = renamed ? tok[++i] : '';
      const file = tok[++i];
      const s = stats.get(file);
      files.push({ path: file, orig: from, status: st[0], additions: s?.add ?? null, deletions: s?.del ?? null });
    }
    return { base: b, head: h, ahead: ahead || 0, behind: behind || 0, commits: parseLog(lg.out, rn), files };
  });
}

// ---------- remotes: fetch / pull / push, with a look first ----------

async function remoteUrl(t, name) {
  return scrub((await run(t, ['config', '--get', `remote.${name}.url`], { read: true })).out.trim());
}

/** Network command with the plain attempt first (the user's credential helper or SSH key
 *  may handle it) and a token-header retry for github.com remotes when it can't. */
async function net(t, args, remote) {
  let r = await run(t, args, { timeoutMs: 90_000 });
  if (r.code !== 0 && /authentication|403|could not read|denied|invalid credentials/i.test(r.err + r.out) && /github\.com/.test(await remoteUrl(t, remote))) {
    const { token } = github.resolveToken();
    if (token) r = await run(t, args, { timeoutMs: 90_000, extra: github.authArgs() });
  }
  return r;
}

/** What a push would send and what a pull would bring — shown before either happens. */
export function outgoing(root) {
  return read(root, async (t) => {
    const [st, rn, remotesOut] = await Promise.all([
      run(t, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], { read: true }),
      remoteNames(t),
      run(t, ['config', '--get-regexp', '^remote\\..*\\.url$'], { read: true }),
    ]);
    const { branch } = parseStatus(st.out);
    const remotes = {};
    for (const line of lines(remotesOut.out)) { const m = /^remote\.(.+)\.url\s+(.+)$/.exec(line); if (m) remotes[m[1]] = scrub(m[2]); }
    const names = [...rn];
    const detached = branch.head === '(detached)';
    const remote = branch.upstream ? branch.upstream.split('/')[0] : (names.includes('origin') ? 'origin' : names[0] || '');
    const base = { branch: detached ? 'HEAD' : branch.head, detached, upstream: branch.upstream, remote, remotes, setUpstreamNeeded: !branch.hasUpstream && !!remote };
    if (!remote) return { ...base, noRemote: true, outgoing: [], incoming: [], files: [] };
    let out = [], inc = [], files = [];
    if (branch.hasUpstream) {
      const [o, i, n] = await Promise.all([
        run(t, ['log', '--max-count=200', `--format=${FMT}`, `${branch.upstream}..HEAD`], { read: true, maxBytes: 2_000_000 }),
        run(t, ['log', '--max-count=200', `--format=${FMT}`, `HEAD..${branch.upstream}`], { read: true, maxBytes: 2_000_000 }),
        run(t, ['diff', '--numstat', '-M', '-z', '--no-ext-diff', `${branch.upstream}...HEAD`], { read: true, maxBytes: 4_000_000 }),
      ]);
      out = parseLog(o.out, rn); inc = parseLog(i.out, rn);
      files = [...parseNumstat(n.out)].map(([p, v]) => ({ path: p, additions: v.add, deletions: v.del }));
    } else if (!detached) {
      // never pushed: everything the remote has no ref for
      const o = await run(t, ['log', '--max-count=200', `--format=${FMT}`, 'HEAD', '--not', `--remotes=${remote}`], { read: true, maxBytes: 2_000_000 });
      out = o.code === 0 ? parseLog(o.out, rn) : [];
    }
    return { ...base, noRemote: false, outgoing: out, incoming: inc, files };
  });
}

export const fetchRemote = (root, { remote = '' } = {}) => write(root, async (t) => {
  const rn = await remoteNames(t);
  if (!rn.size) throw bad('this repository has no remote to fetch from');
  const target = remote ? safeRef(remote, 'remote') : '';
  const r = await net(t, ['fetch', '--prune', ...(target ? [target] : ['--all'])], target || [...rn][0]);
  must(r, 'git fetch');
  return { ok: true, out: scrub(r.err || r.out).trim().slice(-400) };
});

export const push = (root, { remote = '', branch = '', setUpstream = false } = {}) => write(root, async (t) => {
  const cur = (await run(t, ['symbolic-ref', '-q', '--short', 'HEAD'], { read: true })).out.trim();
  const b = branch ? safeRef(branch, 'branch') : cur;
  if (!b) throw bad('you are on a detached HEAD — switch to a branch before pushing', 409);
  if ((await run(t, ['rev-parse', '--verify', '-q', `refs/heads/${b}`], { read: true })).code !== 0) throw bad(`there is no local branch "${b}"`, 404);
  const rn = await remoteNames(t);
  if (!rn.size) throw bad('no remote configured — publish this project to GitHub first (Overview → Publish)', 409);
  const up = (await run(t, ['rev-parse', '--abbrev-ref', `${b}@{upstream}`], { read: true })).out.trim();
  const rem = remote ? safeRef(remote, 'remote') : (up ? up.split('/')[0] : (rn.has('origin') ? 'origin' : [...rn][0]));
  if (!rn.has(rem)) throw bad(`no remote named "${rem}"`, 404);
  const args = ['push', ...((setUpstream || !up) ? ['--set-upstream'] : []), rem, b];
  const r = await net(t, args, rem);
  if (r.code !== 0) {
    const out = scrub(r.err + r.out);
    if (/non-fast-forward|fetch first|\[rejected\]/i.test(out)) throw bad('push rejected — the remote has commits you don\'t have. Pull first, then push again.', 409);
    must(r, 'git push');
  }
  return { ok: true, remote: rem, branch: b, out: scrub(r.err || r.out).trim().slice(-400) };
});

export const pull = (root, { mode = 'ff' } = {}) => write(root, async (t) => {
  if (mode === 'rebase') return github.gitPull(t);       // keeps its own abort-on-conflict safety net
  const rn = await remoteNames(t);
  if (!rn.size) throw bad('this repository has no remote to pull from');
  const r = await net(t, ['pull', '--ff-only'], rn.has('origin') ? 'origin' : [...rn][0]);
  if (r.code !== 0) {
    const out = scrub(r.err + r.out);
    if (/not possible to fast-forward|diverging|divergent/i.test(out)) throw Object.assign(bad('your branch and the remote have both moved on, so it can\'t fast-forward. Use "Pull with rebase", or push/merge by hand.', 409), { diverged: true });
    must(r, 'git pull');
  }
  return { ok: true, out: scrub(r.out).trim().split('\n').slice(-4).join('\n') };
});

// ---------- stashes ----------

async function stashList(t) {
  const r = await run(t, ['stash', 'list', '--format=%H%x1f%gd%x1f%ct%x1f%gs%x1e'], { read: true, timeoutMs: 10_000 });
  return r.out.split('\x1e').map((x) => x.replace(/^\n/, '')).filter(Boolean).map((x) => {
    const [oid, ref, ct, message] = x.split('\x1f');
    return { oid, ref, at: new Date(Number(ct) * 1000).toISOString(), message };
  });
}

export const stashes = (root) => read(root, async (t) => ({ stashes: await stashList(t) }));

export const stashSave = (root, { message = '', includeUntracked = true, paths } = {}) => write(root, async (t) => {
  const args = ['stash', 'push', ...(includeUntracked ? ['--include-untracked'] : []), '-m', String(message || 'AIOS stash').slice(0, 200)];
  if (Array.isArray(paths) && paths.length) args.push('--', ...safePaths(paths).map((p) => `:(literal)${p}`));
  // not literal mode: --literal-pathspecs makes `stash -u` leave untracked files behind (see run())
  const r = await run(t, args, { timeoutMs: 60_000, literal: false });
  if (r.code === 0 && /No local changes to save/i.test(r.out)) throw bad('nothing to stash — the working tree is clean', 409);
  must(r, 'git stash');
  return { ok: true };
});

/** A stash is addressed by its commit id, never by stash@{n}: indexes shift whenever one is
 *  added or dropped, so an index from a list the user looked a minute ago can name the wrong one. */
async function stashAt(t, oid) {
  const o = safeHash(oid);
  const list = await stashList(t);
  const i = list.findIndex((s) => s.oid.startsWith(o));
  if (i < 0) throw bad('that stash is no longer there — refresh the list', 409);
  return { entry: list[i], ref: `stash@{${i}}` };
}

export const stashApply = (root, { oid, drop = false } = {}) => write(root, async (t) => {
  const { entry, ref } = await stashAt(t, oid);
  const r = await run(t, ['stash', drop ? 'pop' : 'apply', ref], { timeoutMs: 60_000 });
  if (r.code !== 0) {
    const out = scrub(r.err + r.out);
    if (/CONFLICT|conflict/.test(out)) throw bad('applying it hit conflicts. The stash is still saved; resolve the conflicted files by hand.', 409);
    must(r, 'git stash apply');
  }
  return { ok: true, applied: entry.message, kept: !drop };
});

export const stashDrop = (root, { oid, confirm = false } = {}) => write(root, async (t) => {
  if (confirm !== true) throw bad('dropping a stash needs explicit confirmation');
  const { ref } = await stashAt(t, oid);
  must(await run(t, ['stash', 'drop', ref]), 'git stash drop');
  return { ok: true };
});

/** What is inside a stash, for the preview. */
export const stashShow = (root, oid) => read(root, async (t) => {
  const { ref } = await stashAt(t, oid);
  const [ns, d] = await Promise.all([
    run(t, ['stash', 'show', '--include-untracked', '--numstat', '-z', ref], { read: true, maxBytes: 2_000_000 }),
    run(t, ['stash', 'show', '--include-untracked', '-p', '--no-color', ref], { read: true, maxBytes: DIFF_CAP }),
  ]);
  return {
    files: [...parseNumstat(ns.out)].map(([p, v]) => ({ path: p, additions: v.add, deletions: v.del })),
    diff: d.out, truncated: d.killed === 'size',
  };
});

// ---------- export ----------

/** A binary-capable patch. Untracked files are not in it — stage them first (as in WorkHub). */
export function patch(root, scope = 'all') {
  return read(root, async (t) => {
    const hasHead = (await run(t, ['rev-parse', '--verify', '-q', 'HEAD'], { read: true })).code === 0;
    const base = ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-color'];
    const args = scope === 'staged' ? [...base, '--cached'] : scope === 'unstaged' ? base : hasHead ? [...base, 'HEAD'] : [...base, '--cached'];
    const r = must(await run(t, args, { read: true, maxBytes: 25_000_000, timeoutMs: 60_000 }), 'git diff');
    if (r.killed) throw bad('that patch is larger than 25 MB — export a smaller selection', 413);
    return { patch: r.out, scope };
  });
}
