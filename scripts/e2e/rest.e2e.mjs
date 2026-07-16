// Live E2E: boot a fresh AIOS instance (temp data dir → free port), then drive
// the new REST surface: weather config→fetch, geocode, project git init/commit.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 7911;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-e2e-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-proj-'));
fs.writeFileSync(path.join(projDir, 'app.js'), 'console.log(1)\n');

let n = 0;
const ok = (cond, label) => { n++; if (!cond) { console.error(`✗ ${label}`); cleanup(1); } console.log(`✓ ${label}`); };
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
};

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, AIOS_DATA: tmpData, AIOS_PORT: String(PORT), AIOS_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let slog = '';
server.stdout.on('data', d => slog += d);
server.stderr.on('data', d => slog += d);
function cleanup(code) {
  try { server.kill('SIGKILL'); } catch { }
  fs.rmSync(tmpData, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
  if (code) { console.error('--- server log tail ---\n' + slog.slice(-2000)); process.exit(code); }
}

// wait for boot
let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(BASE + '/status'); if (r.ok) { up = true; break; } } catch { }
  await new Promise(r => setTimeout(r, 250));
}
ok(up, 'server boots on temp instance');

// weather: unconfigured → geocode → configure → fetch
let r = await j('GET', '/weather');
ok(r.status === 200 && r.data.configured === false, 'weather: unconfigured initially');
r = await j('GET', '/weather/geocode?q=Sapporo');
ok(r.status === 200 && r.data.length > 0, `weather: geocode → ${r.data[0]?.name} (${r.data[0]?.lat})`);
const hit = r.data[0];
r = await j('PUT', '/config', { weather: { lat: hit.lat, lon: hit.lon, place: hit.name } });
ok(r.status === 200 && r.data.weather?.place === hit.name, 'weather: location saved via config');
r = await j('GET', '/weather');
ok(r.status === 200 && r.data.configured && (r.data.current || r.data.error), `weather: live ${r.data.current ? r.data.current.temp + '° ' + r.data.current.label : r.data.error}`);

// tools catalog exposes the git group
r = await j('GET', '/tools');
ok(r.data.tools.some(t => t.group === 'git' && t.name === 'git_commit' && t.write), 'tools: catalog has git group');

// project git flow over REST
r = await j('POST', '/projects/register', { path: projDir });
ok(r.status === 200 && r.data.id, 'projects: temp project registered');
const pid = r.data.id;
r = await j('GET', `/projects/${pid}/git`);
ok(r.status === 200 && r.data.git === true && r.data.repo === false, 'git REST: no repo yet');
r = await j('POST', `/projects/${pid}/git/init`, {});
ok(r.status === 200 && r.data.ok, 'git REST: init');
r = await j('GET', `/projects/${pid}/git`);
ok(r.data.repo === true && r.data.dirty === 1, 'git REST: dirty after init (untracked app.js)');
r = await j('POST', `/projects/${pid}/git/message`, {});
ok(r.status === 200 && r.data.message.length > 4, `git REST: drafted "${r.data.message}" (generated: ${r.data.generated})`);
r = await j('POST', `/projects/${pid}/git/commit`, { message: r.data.message });
ok(r.status === 200 && r.data.hash, `git REST: committed ${r.data.hash}`);
r = await j('GET', `/projects/${pid}/git`);
ok(r.data.dirty === 0 && r.data.branch === 'main', 'git REST: clean on main');
r = await j('POST', `/projects/${pid}/git/commit`, { message: 'nope' });
ok(r.status === 400, 'git REST: clean tree commit → 400');
r = await j('GET', '/projects/does-not-exist/git');
ok(r.status === 404, 'git REST: unknown project → 404');

// static shell serves the new module
const mm = await fetch(`http://127.0.0.1:${PORT}/js/minimonth.js`);
ok(mm.ok && (await mm.text()).includes('renderMiniMonth'), 'static: minimonth.js served');

// planner 3-day range endpoint (used by the Home rail)
const today = new Date().toISOString().slice(0, 10);
r = await j('POST', '/planner/events', { title: 'work thing', date: today, category: 'work' });
ok(r.status === 200, 'planner: work event added');
r = await j('POST', '/planner/events', { title: 'dinner', date: today, category: 'social' });
ok(r.status === 200, 'planner: social event added');
const to = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
r = await j('GET', `/planner/events?from=${today}&to=${to}`);
ok(r.data.length === 2 && r.data.filter(e => e.category !== 'work').length === 1, 'planner: 3-day range returns both; work filterable client-side');

cleanup(0);
console.log(`\nALL ${n} LIVE CHECKS PASSED`);
