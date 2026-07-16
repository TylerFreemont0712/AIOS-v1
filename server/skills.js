// Coding playbooks: curated best-practice guides in skills/*.md, injected into
// the agent's system prompt by detected stack (small models need the rules in
// context, not in training). The rest stay reachable via the `skill` tool.
// Users can edit the files or drop in new ones — no registration needed.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from './config.js';

const DIR = path.join(ROOT, 'skills');
const cache = new Map(); // name -> { mtime, text }

export function listSkills() {
  try {
    return fs.readdirSync(DIR).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
  } catch { return []; }
}

export function getSkill(name) {
  const clean = String(name || '').toLowerCase().trim().replace(/\.md$/, '').replace(/[^a-z0-9_-]/g, '');
  if (!clean) return null;
  const file = path.join(DIR, clean + '.md');
  try {
    const st = fs.statSync(file);
    const hit = cache.get(clean);
    if (hit && hit.mtime === st.mtimeMs) return hit.text;
    const text = fs.readFileSync(file, 'utf8');
    cache.set(clean, { mtime: st.mtimeMs, text });
    return text;
  } catch { return null; }
}

/** Playbooks relevant to this project, most specific first. Shallow scan: root + first-level dirs. */
export function detectStacks(root) {
  const names = new Set();
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true }).slice(0, 200)) {
      names.add(e.name);
      if (e.isDirectory() && !['node_modules', '.git', '.venv', 'dist', 'build'].includes(e.name)) {
        try { for (const f of fs.readdirSync(path.join(root, e.name)).slice(0, 100)) names.add(e.name + '/' + f); } catch { }
      }
    }
  } catch { return []; }
  const any = (fn) => [...names].some(fn);
  const ext = (e) => any(n => n.endsWith(e));

  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { }
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};

  const found = [];
  if (deps.react || deps['react-dom'] || deps.next || deps.preact || ext('.jsx') || ext('.tsx')) found.push('react');
  const ts = names.has('tsconfig.json') || !!deps.typescript || ext('.ts') || ext('.tsx');
  if (ts) found.push('typescript');
  if (deps.express || deps.fastify || deps.koa || deps.hono || deps.ws) found.push('node-api');
  if (!ts && (pkg || ext('.js') || ext('.mjs') || ext('.cjs'))) found.push('javascript');
  if (names.has('pyproject.toml') || names.has('requirements.txt') || names.has('setup.py') || ext('.py')) found.push('python');
  if (ext('.html') || ext('.css')) found.push('web');
  if (ext('.sh') || ext('.bash')) found.push('shell');
  return found.filter(n => getSkill(n) !== null);
}

/**
 * The playbook block for an agent system prompt: `core` always, plus the top
 * detected stacks, packed into a per-provider char budget so small-context
 * models aren't drowned. Ends with a pointer to the rest via the skill tool.
 */
export function skillsPrompt(root, modelRef) {
  if (loadConfig().agent.skills === false) return '';
  const provider = String(modelRef || '').split(':')[0];
  const budget = provider === 'ollama' ? 7000 : provider === 'anthropic' ? 26000 : 15000;
  const maxDetected = provider === 'ollama' ? 1 : 3;

  const chosen = ['core', ...detectStacks(root).slice(0, maxDetected)];
  // a connected vault means the agent is expected to keep notes — teach the note system
  if (loadConfig().vault?.path && provider !== 'ollama') chosen.push('notes');
  let out = '';
  const included = [];
  for (const name of chosen) {
    const text = getSkill(name);
    if (!text) continue;
    if (out && out.length + text.length > budget) break;
    out += `\n\n--- playbook: ${name} ---\n${text.trim()}`;
    included.push(name);
  }
  if (!out) return '';
  const others = listSkills().filter(n => !included.includes(n));
  if (others.length) out += `\n\nMore playbooks (read with the skill tool when relevant): ${others.join(', ')}.`;
  return `\n\nCoding playbooks — follow these rules; they override your instincts:${out}`;
}
