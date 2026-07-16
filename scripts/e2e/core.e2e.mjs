// Offline smoke test: git module + git tools + weather + config.
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-data-'));
process.env.AIOS_DATA = tmpData;

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); process.exit(1); } console.log(`✓ ${label}`); };

const S = (m) => import(pathToFileURL(path.join(ROOT, 'server', m)).href);
const git = await S('git.js');
const tools = await S('tools.js');
const weather = await S('weather.js');
const cfgMod = await S('config.js');

// ---- config ----
const cfg = cfgMod.loadConfig();
ok(cfg.weather && cfg.weather.units === 'c' && cfg.weather.lat === null, 'config: weather defaults present');
const pub = cfgMod.publicConfig();
ok(pub.weather && pub.weather.units === 'c', 'config: weather survives publicConfig');
cfgMod.updateConfig({ weather: { lat: 35.6895, lon: 139.6917, place: 'Tokyo' } });
ok(cfgMod.loadConfig().weather.lat === 35.6895, 'config: weather updates via updateConfig');

// ---- git module ----
ok(git.hasGit() === true, 'git: binary detected');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-repo-'));
ok(git.gitInfo(repo).repo === false, 'git: non-repo detected');
ok(git.promptContext(repo).includes('NOT a git repository'), 'git: prompt context for non-repo');

await git.gitInit(repo);
ok(git.isRepo(repo), 'git: init creates repo');
const r2 = await git.gitInit(repo);
ok(r2.note === 'already a repository', 'git: init idempotent');

fs.writeFileSync(path.join(repo, 'hello.js'), 'console.log("hi")\n');
let info = git.gitInfo(repo);
ok(info.repo && info.dirty === 1 && info.files[0].s === '??', 'git: untracked file shows dirty');
ok(git.statPreview(repo).includes('hello.js'), 'git: statPreview lists file');

// template message (no model configured in fresh data dir)
const gen = await git.commitMessage(repo, {});
ok(gen.generated === false && gen.message.includes('hello.js'), `git: template message "${gen.message}"`);

const c1 = await git.gitCommit(repo, { message: 'feat: add hello script' });
ok(/^[0-9a-f]{4,}$/.test(c1.hash), `git: committed ${c1.hash}`);
info = git.gitInfo(repo);
ok(info.dirty === 0 && info.hasCommits && info.lastCommit.includes('feat: add hello'), 'git: clean after commit');
await git.gitCommit(repo, { message: 'x' }).then(() => ok(false, 'git: empty commit should fail'), e => ok(/nothing to commit/.test(e.message), 'git: clean tree refuses commit'));

ok(git.cleanBranchName('  AIOS/Fix Login CSS!! ') === 'aios/fix-login-css', 'git: branch name sanitized');
ok(git.cleanMessage('```\nfix: thing\n\n- because\n```') === 'fix: thing\n\n- because', 'git: message fence-stripped');
ok(git.cleanMessage('"' + 'a'.repeat(100) + '"').length === 72, 'git: subject clamped to 72');

// ---- git tools through runTool ----
const names = tools.enabledTools().map(t => t.name);
for (const t of ['git_status', 'git_diff', 'git_log', 'git_branch', 'git_switch', 'git_commit', 'git_init']) {
  ok(names.includes(t), `tools: ${t} enabled`);
}
ok(tools.isWriteTool('git_commit') && tools.isWriteTool('git_branch') && !tools.isWriteTool('git_status'), 'tools: write classification');

const ctx = { root: repo };
let r = await tools.runTool('git_status', {}, ctx);
ok(!r.isError && r.content.includes('On branch') && r.content.includes('clean'), 'tools: git_status reads state');

r = await tools.runTool('git_branch', { name: 'AIOS/Try This' }, ctx);
ok(!r.isError && r.content.includes('aios/try-this'), 'tools: git_branch creates + switches');
fs.writeFileSync(path.join(repo, 'hello.js'), 'console.log("hello world")\n');
r = await tools.runTool('git_diff', {}, ctx);
ok(!r.isError && r.content.includes('hello world'), 'tools: git_diff shows change');
r = await tools.runTool('git_commit', { message: 'fix: greet the world' }, ctx);
ok(!r.isError && r.content.includes('aios/try-this'), 'tools: git_commit on branch');
r = await tools.runTool('git_log', { limit: 5 }, ctx);
ok(!r.isError && r.content.split('\n').length === 2, 'tools: git_log two commits');
r = await tools.runTool('git_switch', { name: 'main' }, ctx);
ok(!r.isError, 'tools: git_switch back to main');
ok(tools.diffPreview(repo, 'git_commit', {}) === null, 'tools: commit preview null when clean');
fs.writeFileSync(path.join(repo, 'extra.txt'), 'x\n');
ok(String(tools.diffPreview(repo, 'git_commit', {})).includes('extra.txt'), 'tools: commit preview lists pending file');

// ---- weather ----
ok(weather.describeWMO(0)[0] === 'Clear' && weather.describeWMO(95)[1] === '⛈️', 'weather: WMO mapping');
ok(weather.describeWMO(9999)[0] === '—', 'weather: unknown code safe');
// live call — tolerated to fail offline
try {
  const w = await weather.getWeather();
  ok(w.configured === true, 'weather: configured with Tokyo coords');
  if (w.error) console.log(`  (network unavailable: ${w.error})`);
  else ok(typeof w.current.temp === 'number' && w.days.length === 4, `weather: live Tokyo ${w.current.temp}° ${w.current.emoji} + ${w.days.length}-day forecast`);
} catch (e) { console.log('  (weather live call failed: ' + e.message + ')'); }
try {
  const g = await weather.geocode('Tokyo');
  ok(g.length > 0 && typeof g[0].lat === 'number', `weather: geocode "${g[0].name} — ${g[0].detail}"`);
} catch (e) { console.log('  (geocode live call failed: ' + e.message + ')'); }

// ---- workingDiff + commit-message quality gate ----
for (const bad of ['chore: make changes', 'fix: update files', 'need to make a change', 'wip stuff'])
  ok(git.isGenericSubject(bad), `gate: generic rejected "${bad}"`);
for (const good of ['feat: add sender mute rules to inbox triage', 'refactor: extract mini-month into shared module'])
  ok(!git.isGenericSubject(good), `gate: specific accepted "${good}"`);
const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-wd-'));
await git.gitInit(wd);
fs.writeFileSync(path.join(wd, 'a.js'), 'line one\n');
await git.gitCommit(wd, { message: 'chore: seed' });
fs.writeFileSync(path.join(wd, 'a.js'), 'line one CHANGED\n');
fs.writeFileSync(path.join(wd, 'newfile.txt'), 'fresh content\n');
const d2 = await git.workingDiff(wd);
ok(d2.files.length === 2 && /\+line one CHANGED/.test(d2.files.find(f => f.path === 'a.js').diff), 'workingDiff: tracked change diffed');
ok(/\+fresh content/.test(d2.files.find(f => f.path === 'newfile.txt').diff), 'workingDiff: untracked as additions');
fs.rmSync(wd, { recursive: true, force: true });

// ---- verify v2: test-command detection + bounded runner ----
const checks = await S('checks.js');
const tp = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-tests-'));
ok(checks.detectTestCommand(tp) === null, 'verify: empty project → no test command');
fs.writeFileSync(path.join(tp, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
ok(checks.detectTestCommand(tp) === null, 'verify: npm placeholder test ignored');
fs.writeFileSync(path.join(tp, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node t.js' } }));
ok(checks.detectTestCommand(tp)?.via === 'package.json', 'verify: npm test script detected');
fs.mkdirSync(path.join(tp, '.aios'), { recursive: true });
fs.writeFileSync(path.join(tp, '.aios', 'instructions.md'), 'notes\nverify: node t.js --custom\nmore notes');
ok(checks.detectTestCommand(tp)?.cmd === 'node t.js --custom', 'verify: .aios "verify:" line wins');
fs.rmSync(path.join(tp, '.aios'), { recursive: true });
fs.writeFileSync(path.join(tp, 't.js'), 'process.exit(0)');
let tr = await checks.runProjectTests(tp);
ok(tr?.ok === true && tr.cmd === 'npm test --silent', 'verify: passing run → ok');
fs.writeFileSync(path.join(tp, 't.js'), 'console.error("boom assertion"); process.exit(1)');
tr = await checks.runProjectTests(tp);
ok(tr?.ok === false && /boom assertion/.test(tr.output), 'verify: failure output captured');
fs.rmSync(tp, { recursive: true, force: true });

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(tmpData, { recursive: true, force: true });
console.log(`\nALL ${n} CHECKS PASSED`);
