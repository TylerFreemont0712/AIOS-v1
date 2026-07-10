// Project registry: the hub's list of workspaces. Registering never copies or
// moves anything — it just records a path. Removing only forgets it.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA, loadConfig } from './config.js';
import { id as genId, now, readJSON, writeJSON } from './util.js';

const FILE = path.join(DATA, 'projects.json');

const load = () => readJSON(FILE, []);
const persist = (list) => writeJSON(FILE, list);

export function getProject(id) { return load().find(p => p.id === id) || null; }

export async function listProjects() {
  const list = load();
  await Promise.all(list.map(async p => {
    p.exists = fs.existsSync(p.path);
    p.git = p.exists ? await gitInfo(p.path) : null;
  }));
  return list.sort((a, b) => (b.favorite - a.favorite) || (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''));
}

export function registerProject({ path: p, name }) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw Object.assign(new Error('not a directory: ' + abs), { status: 400 });
  const list = load();
  const existing = list.find(x => x.path === abs);
  if (existing) return existing;
  const proj = { id: genId(6), name: name || path.basename(abs), path: abs, notes: '', favorite: false, createdAt: now(), lastOpenedAt: now() };
  list.push(proj); persist(list);
  return proj;
}

export function createProject({ name, gitInit = true }) {
  if (!name || /[/\\]/.test(name)) throw Object.assign(new Error('invalid project name'), { status: 400 });
  const cfg = loadConfig();
  const abs = path.join(cfg.projectsRoot, name);
  if (fs.existsSync(abs)) throw Object.assign(new Error('directory already exists: ' + abs), { status: 409 });
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'README.md'), `# ${name}\n\nCreated with AIOS on ${new Date().toDateString()}.\n`);
  if (gitInit) { try { execFile('git', ['-C', abs, 'init', '-q']); } catch { } }
  return registerProject({ path: abs, name });
}

export function updateProject(id, patch) {
  const list = load();
  const p = list.find(x => x.id === id);
  if (!p) throw Object.assign(new Error('project not found'), { status: 404 });
  for (const k of ['name', 'notes', 'favorite']) if (patch[k] !== undefined) p[k] = patch[k];
  if (patch.touch) p.lastOpenedAt = now();
  persist(list);
  return p;
}

export function removeProject(id) {
  persist(load().filter(p => p.id !== id)); // registry only — files are untouched
}

/** All roots the file APIs may serve: project paths + the vault. */
export function allowedRoots() {
  const roots = new Map();
  for (const p of load()) roots.set(p.id, p.path);
  const v = loadConfig().vault.path;
  if (v) roots.set('vault', v);
  return roots;
}

function gitInfo(dir) {
  const run = (args) => new Promise(res => execFile('git', ['-C', dir, ...args], { timeout: 3000 }, (e, out) => res(e ? null : out.trim())));
  return (async () => {
    if (!fs.existsSync(path.join(dir, '.git'))) return null;
    const [branch, status, last] = await Promise.all([
      run(['rev-parse', '--abbrev-ref', 'HEAD']),
      run(['status', '--porcelain']),
      run(['log', '-1', '--format=%h %s', '--no-show-signature']),
    ]);
    if (branch === null) return null;
    return { branch, dirty: status ? status.split('\n').filter(Boolean).length : 0, lastCommit: last || '' };
  })();
}
