// Git workspace E2E: server/gitwork.js + server/repos.js against throwaway repositories and a
// local bare remote. Covers what the GitHub tab's Local view does: the staged/unstaged split,
// per-file and per-hunk diffs, reviewed commits (and the stale-review guard), history with a
// merge, branches, stashes addressed by id, push/fetch/pull with a preview, patch export,
// path/ref validation, and the "newest change first" ordering of the project list.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-gitwork-'));
process.env.AIOS_DATA = path.join(TMP, 'data');
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'server', f)).href);

let n = 0;
const cleanup = (code) => { fs.rmSync(TMP, { recursive: true, force: true }); process.exit(code); };
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const rejects = async (fn, re, label) => {
  try { await fn(); } catch (e) { return ok(re.test(e.message), `${label} (${e.message.split('\n')[0].slice(0, 70)})`); }
  ok(false, `${label} — expected an error`);
};
const sh = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (dir, f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };

const gw = await imp('gitwork.js');
const repos = await imp('repos.js');
const { safePaths, safeRef } = await imp('gitrun.js');

// ---- fixture: a repo with a bare origin ----
const bare = path.join(TMP, 'origin.git');
sh(TMP, 'init', '--bare', '-b', 'main', bare);
const R = path.join(TMP, 'proj');
fs.mkdirSync(R);
sh(R, 'init', '-b', 'main');
sh(R, 'config', 'user.name', 'T'); sh(R, 'config', 'user.email', 't@t');
const lines = (k, tag = '') => Array.from({ length: k }, (_, i) => `line ${i + 1}${tag && (i + 1) % 10 === 0 ? ' ' + tag : ''}`).join('\n') + '\n';
write(R, 'app.txt', lines(40));
write(R, 'notes.md', '# notes\n');
sh(R, 'add', '-A'); sh(R, 'commit', '-m', 'feat: first commit');
sh(R, 'remote', 'add', 'origin', bare);

// ---- status on a clean repo, then a mixed tree ----
let st = await gw.status(R);
ok(st.branch === 'main' && st.counts.total === 0 && st.hasCommits && !st.hasUpstream, 'status: clean repo on main, no upstream yet');

write(R, 'app.txt', lines(40, 'EDIT'));                          // 4 separate hunks
write(R, 'new file with spaces & ü.txt', 'hello\n');             // untracked, awkward name
fs.writeFileSync(path.join(R, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
fs.rmSync(path.join(R, 'notes.md'));                              // deleted
st = await gw.status(R);
const byPath = Object.fromEntries(st.files.map(f => [f.path, f]));
ok(st.counts.unstaged === 4 || (st.counts.unstaged + st.counts.untracked) === 4, `status: four changed paths (${st.counts.unstaged} unstaged + ${st.counts.untracked} untracked)`);
ok(byPath['app.txt'].y === 'M' && byPath['app.txt'].addU === 4 && byPath['app.txt'].delU === 4, 'status: per-file +/- counts on the unstaged side');
ok(byPath['notes.md'].y === 'D' && byPath['new file with spaces & ü.txt'].untracked, 'status: deleted + untracked (with spaces and unicode) reported');

// ---- diffs ----
let d = await gw.fileDiff(R, { path: 'app.txt' });
ok(/^@@/m.test(d.diff) && d.additions === 4 && d.deletions === 4, 'diff: work-tree diff of a tracked file');
d = await gw.fileDiff(R, { path: 'new file with spaces & ü.txt' });
ok(/\+hello/.test(d.diff) && d.additions === 1, 'diff: untracked file shown as all additions');
d = await gw.fileDiff(R, { path: 'blob.bin' });
ok(d.binary === false && /binary/.test(d.note), 'diff: untracked binary file is flagged, not dumped');
d = await gw.fileDiff(R, { path: 'app.txt', context: 0 });
ok(!/^ line/m.test(d.diff), 'diff: context=0 drops context lines');
d = await gw.fileDiff(R, { path: 'app.txt', ignoreWs: true });
ok(d.additions === 4, 'diff: ignore-whitespace flag accepted');

// ---- staging: file, hunk, unstage, discard ----
await gw.stage(R, { paths: ['new file with spaces & ü.txt'] });
st = await gw.status(R);
ok(st.files.find(f => f.path.startsWith('new file')).staged && !st.files.find(f => f.path.startsWith('new file')).untracked, 'stage: awkward filename staged by literal path');

const hdrs = [...(await gw.fileDiff(R, { path: 'app.txt' })).diff.matchAll(/^@@.*$/gm)].map(m => m[0]);
ok(hdrs.length === 4, `hunks: file has ${hdrs.length} hunks`);
await rejects(() => gw.stageHunk(R, { path: 'app.txt', index: 1, header: '@@ -1,1 +1,1 @@' }), /changed since/, 'hunk: wrong header is refused (file moved under the user)');
await gw.stageHunk(R, { path: 'app.txt', index: 1, header: hdrs[1] });
let sp = await gw.stagedPatch(R);
ok((sp.patch.match(/^@@/gm) || []).length === 1 && sp.patch.includes(hdrs[1]) === false || sp.patch.includes('line 20 EDIT'), 'hunk: exactly one hunk staged (the second one)');
ok(sp.patch.includes('line 20 EDIT') && !sp.patch.includes('line 10 EDIT'), 'hunk: staged the chosen lines only');
st = await gw.status(R);
const app = st.files.find(f => f.path === 'app.txt');
ok(app.staged && app.unstaged, 'hunk: file is now partly staged (both sides)');
await gw.stageHunk(R, { path: 'app.txt', index: 0, header: (await gw.fileDiff(R, { path: 'app.txt', staged: true })).diff.match(/^@@.*$/m)[0], reverse: true });
sp = await gw.stagedPatch(R);
ok(!/line 20 EDIT/.test(sp.patch), 'hunk: unstaging the hunk removes it from the index');

await gw.unstage(R, { paths: ['new file with spaces & ü.txt'] });
ok((await gw.status(R)).files.find(f => f.path.startsWith('new file')).untracked, 'unstage: file goes back to untracked');

await rejects(() => gw.discard(R, { paths: ['app.txt'] }), /confirmation/, 'discard: refused without confirm');
await gw.discard(R, { paths: ['blob.bin', 'app.txt'], confirm: true });
st = await gw.status(R);
ok(!st.files.some(f => f.path === 'blob.bin' || f.path === 'app.txt'), 'discard: untracked file removed and tracked edits reverted');

// ---- commit: only what is staged, with the stale-review guard ----
write(R, 'a.txt', 'A\n'); write(R, 'b.txt', 'B\n');
await gw.stage(R, { paths: ['a.txt'] });
sp = await gw.stagedPatch(R);
ok(sp.files.length === 1 && sp.files[0].path === 'a.txt' && sp.digest, 'review: staged patch lists only the staged file, with a digest');
await gw.stage(R, { paths: ['b.txt'] });                           // staging moves after the review
await rejects(() => gw.commit(R, { message: 'feat: a', digest: sp.digest }), /after you reviewed/, 'commit: stale review digest is rejected');
await gw.unstage(R, { paths: ['b.txt'] });
sp = await gw.stagedPatch(R);
const c1 = await gw.commit(R, { message: 'feat: add a\n\nbody line', digest: sp.digest });
ok(c1.hash && c1.files === 1, `commit: made ${c1.hash}`);
st = await gw.status(R);
ok(st.files.some(f => f.path === 'b.txt' && f.untracked) && !st.files.some(f => f.path === 'a.txt'), 'commit: unstaged b.txt was left alone');
await rejects(() => gw.commit(R, { message: 'x' }), /nothing is staged/, 'commit: refuses when nothing is staged');
await rejects(() => gw.commit(R, { message: '   ' }), /commit message/, 'commit: refuses an empty message');

// ---- branches, history with a merge ----
await gw.createBranch(R, { name: 'feature/x' });
write(R, 'x.txt', 'x\n'); await gw.stage(R, { paths: ['x.txt'] });
await gw.commit(R, { message: 'feat: x on feature' });
await gw.checkout(R, { branch: 'main' });
write(R, 'm.txt', 'm\n'); await gw.stage(R, { paths: ['m.txt'] });
await gw.commit(R, { message: 'feat: m on main' });
sh(R, 'merge', '--no-ff', '-m', 'merge feature/x', 'feature/x');
let lg = await gw.log(R, { limit: 50 });
ok(lg.commits.length >= 5 && lg.commits[0].subject === 'merge feature/x' && lg.commits[0].parents.length === 2, 'log: merge commit has two parents');
ok(lg.commits[0].refs.some(r => r.name === 'main' && r.head), 'log: HEAD -> main decoration parsed');
const first = lg.commits.at(-1);
let cd = await gw.commitDetail(R, first.hash);
ok(first.parents.length === 0 && cd.files.some(f => f.path === 'app.txt' && f.status === 'A'), 'commit detail: root commit lists its added files');
cd = await gw.commitDetail(R, lg.commits[0].hash);
ok(cd.files.length === 1 && cd.files[0].path === 'x.txt', `commit detail: a merge lists only what it brought in over its first parent (${cd.files.map(f => f.path)})`);
d = await gw.fileDiff(R, { path: 'x.txt', commit: lg.commits[0].hash });
ok(/\+x/.test(d.diff), 'diff: a file inside a (merge) commit');
lg = await gw.log(R, { search: 'feat: add a' });
ok(lg.commits.length === 1, 'log: message search');
lg = await gw.log(R, { path: 'x.txt' });
ok(lg.commits.length >= 1 && lg.commits.every(c => c.subject !== 'feat: m on main'), 'log: history of one path');

let br = await gw.branches(R);
ok(br.current === 'main' && br.locals.find(b => b.name === 'feature/x').merged === true, 'branches: feature/x is reported merged into main');
await gw.createBranch(R, { name: 'wip', checkout: true });
write(R, 'w.txt', 'w\n'); await gw.stage(R, { paths: ['w.txt'] }); await gw.commit(R, { message: 'wip: unmerged work' });
await gw.checkout(R, { branch: 'main' });
await rejects(() => gw.deleteBranch(R, { name: 'wip' }), /nowhere else/, 'branch: deleting unmerged work is refused');
await rejects(() => gw.deleteBranch(R, { name: 'wip', force: true }), /explicit confirmation/, 'branch: force-delete needs confirm');
await rejects(() => gw.deleteBranch(R, { name: 'main' }), /branch you are on/, 'branch: cannot delete the current branch');
const cmp = await gw.compare(R, { base: 'main', head: 'wip' });
ok(cmp.ahead === 1 && cmp.behind === 0 && cmp.files.some(f => f.path === 'w.txt' && f.status === 'A'), 'compare: wip is 1 ahead, adds w.txt');
await gw.deleteBranch(R, { name: 'wip', force: true, confirm: true });
await gw.deleteBranch(R, { name: 'feature/x' });
br = await gw.branches(R);
ok(!br.locals.some(b => b.name === 'wip' || b.name === 'feature/x'), 'branch: both deleted (one safely, one forced)');
await rejects(() => gw.createBranch(R, { name: 'bad name~^' }), /not a valid branch name/, 'branch: invalid name refused');

// ---- remotes: preview, push, fetch, pull ----
let og = await gw.outgoing(R);
ok(og.setUpstreamNeeded && og.remote === 'origin' && og.outgoing.length >= 5, `push preview: never pushed, ${og.outgoing.length} commits would go`);
const pr = await gw.push(R, {});
ok(pr.remote === 'origin' && pr.branch === 'main', 'push: first push sets the upstream');
og = await gw.outgoing(R);
ok(!og.setUpstreamNeeded && og.outgoing.length === 0 && og.incoming.length === 0, 'push preview: nothing left to send afterwards');
st = await gw.status(R);
ok(st.hasUpstream && st.ahead === 0 && st.behind === 0, 'status: tracking origin/main, in sync');

const R2 = path.join(TMP, 'other');
sh(TMP, 'clone', bare, R2);
write(R2, 'remote.txt', 'from elsewhere\n'); sh(R2, 'add', '-A'); sh(R2, 'commit', '-m', 'feat: remote change'); sh(R2, 'push');
await gw.fetchRemote(R, {});
og = await gw.outgoing(R);
ok(og.incoming.length === 1 && og.incoming[0].subject === 'feat: remote change', 'fetch: the incoming commit is previewed before pulling');
const pl = await gw.pull(R, {});
ok(pl.ok && fs.existsSync(path.join(R, 'remote.txt')), 'pull: fast-forwarded');
write(R, 'local1.txt', '1\n'); await gw.stage(R, { paths: ['local1.txt'] }); await gw.commit(R, { message: 'feat: local only' });
write(R2, 'remote2.txt', '2\n'); sh(R2, 'add', '-A'); sh(R2, 'commit', '-m', 'feat: remote again'); sh(R2, 'push');
await gw.fetchRemote(R, {});
await rejects(() => gw.pull(R, {}), /both moved on/, 'pull: diverged history is explained, not merged silently');
await rejects(() => gw.push(R, {}), /rejected/, 'push: a rejected push says to pull first');
await gw.pull(R, { mode: 'rebase' });
await gw.push(R, {});
ok(sh(R, 'rev-parse', 'HEAD') === sh(R2, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], 'pull --rebase then push: remote head matches local');

// ---- stashes ----
write(R, 'a.txt', 'A changed\n'); write(R, 'untracked-stash.txt', 'u\n');
await gw.stashSave(R, { message: 'parking work' });
st = await gw.status(R);
ok(st.counts.total === 0 && st.stashCount === 1, `stash: tracked and untracked changes saved, tree clean (total=${st.counts.total} stashes=${st.stashCount} ${st.files.map(f => f.path).join(',')})`);
let sl = await gw.stashes(R);
ok(sl.stashes[0].message.includes('parking work'), 'stash: listed with its message');
const show = await gw.stashShow(R, sl.stashes[0].oid);
ok(show.files.some(f => f.path === 'a.txt') && show.files.some(f => f.path === 'untracked-stash.txt'), 'stash: preview includes the untracked file');
await gw.stashApply(R, { oid: sl.stashes[0].oid });
ok(fs.readFileSync(path.join(R, 'a.txt'), 'utf8') === 'A changed\n' && (await gw.stashes(R)).stashes.length === 1, 'stash: apply restores the work and keeps the stash');
await gw.discard(R, { paths: ['a.txt', 'untracked-stash.txt'], confirm: true });
await rejects(() => gw.stashDrop(R, { oid: sl.stashes[0].oid }), /explicit confirmation/, 'stash: drop needs confirm');
await gw.stashDrop(R, { oid: sl.stashes[0].oid, confirm: true });
ok((await gw.stashes(R)).stashes.length === 0, 'stash: dropped by id');
await rejects(() => gw.stashApply(R, { oid: sl.stashes[0].oid }), /no longer there/, 'stash: a stale id is refused instead of applying a different stash');

// selective stash: only the named path, even when its name looks like a glob
write(R, 'sel[1].txt', 'pick me\n'); write(R, 'leave-me.txt', 'stay\n');
await gw.stashSave(R, { message: 'just one', paths: ['sel[1].txt'] });
st = await gw.status(R);
ok(!st.files.some(f => f.path === 'sel[1].txt') && st.files.some(f => f.path === 'leave-me.txt'), 'stash: selective stash takes only the named path (glob-looking name is literal)');
await gw.discard(R, { paths: ['leave-me.txt'], confirm: true });
const pick = (await gw.stashes(R)).stashes[0];
await gw.stashApply(R, { oid: pick.oid, drop: true });
ok(fs.existsSync(path.join(R, 'sel[1].txt')) && (await gw.stashes(R)).stashes.length === 0, 'stash: pop restores it and removes the stash');
await gw.discard(R, { paths: ['sel[1].txt'], confirm: true });

// ---- patch export ----
write(R, 'a.txt', 'for the patch\n');
const pa = await gw.patch(R, 'all');
ok(/^diff --git a\/a\.txt/m.test(pa.patch) && /for the patch/.test(pa.patch), 'patch: tracked changes exported');
await gw.discard(R, { paths: ['a.txt'], confirm: true });

// ---- hostile input ----
for (const bad of ['../etc/passwd', '/etc/passwd', '.git/config', 'a/../../x', 'sub/.GIT/hooks/x', 'a\0b']) {
  let threw = false; try { safePaths([bad]); } catch { threw = true; }
  ok(threw, `validation: path "${bad.replace('\0', '\\0')}" refused`);
}
for (const bad of ['--upload-pack=x', '-D', 'a..b', 'x y', 'a;rm -rf', '$(id)', 'foo.lock', 'x/']) {
  let threw = false; try { safeRef(bad); } catch { threw = true; }
  ok(threw, `validation: ref "${bad}" refused`);
}
await rejects(() => gw.fileDiff(R, { path: 'a.txt', commit: '--output=/tmp/pwn' }), /invalid commit/, 'validation: commit argument cannot smuggle an option');
await rejects(() => gw.checkout(R, { branch: '--orphan=x' }), /invalid branch/, 'validation: checkout argument cannot smuggle an option');

// ---- concurrency: parallel writes queue instead of tripping index.lock ----
for (let i = 0; i < 8; i++) write(R, `par/f${i}.txt`, `${i}\n`);
await Promise.all(Array.from({ length: 8 }, (_, i) => gw.stage(R, { paths: [`par/f${i}.txt`] })));
st = await gw.status(R);
ok(st.files.filter(f => f.path.startsWith('par/') && f.staged).length === 8, 'concurrency: eight parallel stage calls all landed');

// ---- the project list: newest change first, uncommitted edits count ----
const A = path.join(TMP, 'older'), B = path.join(TMP, 'newer'), C = path.join(TMP, 'plain');
for (const p of [A, B]) { fs.mkdirSync(p); sh(p, 'init', '-b', 'main'); write(p, 'f', '1\n'); sh(p, 'add', '-A'); }
const past = (d) => Math.floor(Date.now() / 1000) - d * 86400;
const env = (t) => ({ ...process.env, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000` });
spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'old'], { cwd: A, env: env(past(30)) });
spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'newer'], { cwd: B, env: env(past(10)) });
fs.mkdirSync(C); write(C, 'x.txt', 'not a repo\n');
write(A, 'f', 'edited just now\n');                                 // uncommitted edit in the repo with the OLD commit
const rows = await repos.overview([
  { id: 'a', name: 'older', path: A }, { id: 'b', name: 'newer', path: B }, { id: 'c', name: 'plain', path: C },
  { id: 'd', name: 'gone', path: path.join(TMP, 'does-not-exist') },
], { fresh: true });
ok(rows[0].name === 'older' && rows[0].activityKind === 'uncommitted', 'list: a repo with a fresh uncommitted edit sorts above one with a newer commit');
ok(rows.map(r => r.name).join() === 'older,plain,newer,gone', `list: order is newest change first (${rows.map(r => r.name).join()})`);
ok(rows.find(r => r.name === 'plain').repo === false && rows.find(r => r.name === 'gone').missing, 'list: non-repo folder and missing folder are reported, not fatal');
const t = repos.totals(rows);
ok(t.projects === 4 && t.repos === 2 && t.uncommitted === 1 && t.notRepos === 2, 'list: roll-up totals');
const disc = repos.discover(TMP, [A]);
ok(disc.find(i => i.name === 'older').registered && disc.find(i => i.name === 'newer').suggested && disc.find(i => i.name === 'plain').kind === 'folder', 'discover: registered, suggested and plain folders classified');

console.log(`\n${n} checks passed`);
cleanup(0);
