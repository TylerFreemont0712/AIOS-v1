// Project registry: the hub's list of workspaces. Registering never copies or
// moves anything — it just records a path. Removing only forgets it.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA, loadConfig } from './config.js';
import { id as genId, now, readJSON, writeJSON } from './util.js';
import { summarize } from './repos.js';

const FILE = path.join(DATA, 'projects.json');

const load = () => readJSON(FILE, []);
const persist = (list) => writeJSON(FILE, list);

export function getProject(id) { return load().find(p => p.id === id) || null; }

/** The plain registry, untouched — what the repo overview is built from. */
export const rawList = () => load();

/**
 * Projects with their git chip, favourites first and then by when each one last CHANGED
 * (newest of the last commit and the newest uncommitted edit), not when it was last opened:
 * the project you were working in an hour ago belongs above the one you clicked yesterday.
 */
export async function listProjects() {
  const list = load();
  const sums = new Map();
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
    while (i < list.length) { const p = list[i++]; sums.set(p.id, await summarize(p.path)); }
  }));
  for (const p of list) {
    const s = sums.get(p.id) || {};
    p.exists = fs.existsSync(p.path);
    p.git = p.exists && s.repo
      ? { branch: s.branch, dirty: s.dirty, lastCommit: s.lastCommit ? `${s.lastCommit.short} ${s.lastCommit.subject}` : '', ahead: s.ahead, behind: s.behind, hasRemote: !!s.remote }
      : null;
    p.activityAt = s.activityAt ? new Date(s.activityAt).toISOString() : null;
  }
  return list.sort((a, b) => (b.favorite - a.favorite) || (b.activityAt || '').localeCompare(a.activityAt || '') || (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''));
}

/**
 * Register several folders at once — only ones inside the projects root, so this bulk
 * endpoint cannot be used to pull arbitrary directories into the file APIs' reach.
 * Each item is { path, name? }. Already-registered paths are returned as they are.
 */
export function registerMany(items) {
  const root = fs.realpathSync(path.resolve(loadConfig().projectsRoot));
  const out = [];
  for (const it of Array.isArray(items) ? items.slice(0, 100) : []) {
    const abs = path.resolve(String(it?.path || ''));
    let real;
    try { real = fs.realpathSync(abs); } catch { continue; }
    if (real !== root && !real.startsWith(root + path.sep)) continue;
    try { out.push(registerProject({ path: abs, name: it.name ? String(it.name).slice(0, 80) : undefined })); } catch { }
  }
  return out;
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
