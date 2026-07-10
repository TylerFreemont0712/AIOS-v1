// Mindmaps: tree documents stored as JSON, with AI generation/expansion and
// export into the Obsidian vault as a nested outline.

import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig } from './config.js';
import { id as genId, now, readJSON, writeJSON, truncate } from './util.js';
import { streamChat } from './llm.js';
import * as vault from './vault.js';

const DIR = path.join(DATA, 'mindmaps');
const file = (id) => path.join(DIR, id + '.json');

export function listMaps() {
  fs.mkdirSync(DIR, { recursive: true });
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    const m = readJSON(path.join(DIR, f));
    return m && { id: m.id, name: m.name, updatedAt: m.updatedAt, nodes: countNodes(m.root) };
  }).filter(Boolean).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function createMap({ name }) {
  const m = {
    id: genId(8), name: name || 'Untitled map',
    createdAt: now(), updatedAt: now(),
    root: { id: genId(6), text: name || 'Central idea', children: [] },
  };
  writeJSON(file(m.id), m);
  return m;
}

export function getMap(id) {
  const m = readJSON(file(id));
  if (!m) throw Object.assign(new Error('mindmap not found'), { status: 404 });
  return m;
}

export function saveMap(id, { name, root }) {
  const m = getMap(id);
  if (name !== undefined) m.name = name;
  if (root !== undefined) m.root = sanitize(root);
  m.updatedAt = now();
  writeJSON(file(id), m);
  return { ok: true, updatedAt: m.updatedAt };
}

export function deleteMap(id) { try { fs.unlinkSync(file(id)); } catch { } }

function sanitize(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  return {
    id: String(node.id || genId(6)),
    text: String(node.text || '').slice(0, 500),
    color: typeof node.color === 'string' ? node.color.slice(0, 20) : undefined,
    collapsed: !!node.collapsed || undefined,
    children: (Array.isArray(node.children) ? node.children : []).map(c => sanitize(c, depth + 1)).filter(Boolean).slice(0, 50),
  };
}

const countNodes = (n) => n ? 1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0) : 0;

// ---------- AI ----------

const TREE_SCHEMA = `{"text":"node label","children":[{"text":"...","children":[]}]}`;

export async function aiGenerate({ topic, modelRef, depth = 3, breadth = 4 }) {
  const res = await streamChat({
    modelRef,
    system: `You design mindmaps. Return STRICT JSON only (no fences): ${TREE_SCHEMA}. Root is the topic; ~${breadth} children per node, ${depth} levels deep where the topic warrants it. Labels are short (2-6 words), concrete, non-repetitive.`,
    messages: [{ role: 'user', text: `Mindmap topic: ${topic}` }],
    maxTokens: 8000,
  });
  const tree = extract(res.text);
  if (!tree?.text) throw new Error('model did not return a valid tree');
  const m = createMap({ name: topic.slice(0, 60) });
  m.root = withIds(tree);
  writeJSON(file(m.id), m);
  return m;
}

export async function aiExpand({ id, nodeId, modelRef, count = 4 }) {
  const m = getMap(id);
  const node = findNode(m.root, nodeId);
  if (!node) throw Object.assign(new Error('node not found'), { status: 404 });
  const pathText = pathTo(m.root, nodeId).map(n => n.text).join(' → ');
  const res = await streamChat({
    modelRef,
    system: `You expand one branch of a mindmap. Return STRICT JSON only: {"children":[{"text":"..."}]}. ${count} short, concrete, distinct child labels. No duplicates of existing siblings.`,
    messages: [{ role: 'user', text: `Map: "${m.name}". Branch path: ${pathText}. Existing children: ${node.children.map(c => c.text).join(', ') || '(none)'}. Expand "${node.text}".` }],
    maxTokens: 2000,
  });
  const parsed = extract(res.text);
  const kids = (parsed?.children || []).slice(0, 12).map(c => ({ id: genId(6), text: String(c.text || '').slice(0, 200), children: [] }));
  if (!kids.length) throw new Error('no children generated');
  node.children.push(...kids);
  m.updatedAt = now();
  writeJSON(file(id), m);
  return { node: nodeId, added: kids };
}

/** Export a map into the vault as a nested outline note. */
export function exportToVault(id, { wikilinks = false } = {}) {
  const m = getMap(id);
  const lines = [`# ${m.name}`, '', `> Mindmap exported from AIOS on ${new Date().toDateString()}`, ''];
  const rec = (n, d) => {
    if (d >= 0) lines.push('  '.repeat(d) + '- ' + (wikilinks && d > 0 ? `[[${n.text}]]` : n.text));
    for (const c of n.children || []) rec(c, d + 1);
  };
  rec(m.root, -1); // root becomes the title, children start at indent 0
  lines.unshift('---', `created: ${now()}`, `source: AIOS mindmap`, 'tags: [mindmap]', '---', '');
  const folder = loadConfig().vault.wikiFolder || 'AI Wiki';
  const rel = path.join(folder, m.name.replace(/[/\\:*?"<>|]/g, '-') + ' (map).md');
  vault.writeNote(rel, lines.join('\n'));
  return { path: rel };
}

function withIds(n) { return { id: genId(6), text: String(n.text || '').slice(0, 300), children: (n.children || []).slice(0, 20).map(withIds) }; }
function findNode(n, id) { if (n.id === id) return n; for (const c of n.children || []) { const r = findNode(c, id); if (r) return r; } return null; }
function pathTo(n, id, acc = []) {
  if (n.id === id) return [...acc, n];
  for (const c of n.children || []) { const r = pathTo(c, id, [...acc, n]); if (r) return r; }
  return null;
}

function extract(text) {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
