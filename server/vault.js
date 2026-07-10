// Obsidian vault integration. A vault is just a folder of markdown — we index
// titles, tags, [[wikilinks]] and frontmatter, serve a link graph, and let models
// read, answer from, and *grow* the vault (the "second brain" / LLM-wiki part).

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.js';
import { safePath, walk, now, truncate } from './util.js';
import { streamChat } from './llm.js';

let publish = () => { };
export const setPublisher = (fn) => { publish = fn; };

const vaultPath = () => loadConfig().vault.path;
const mustVault = () => {
  const v = vaultPath();
  if (!v || !fs.existsSync(v)) throw Object.assign(new Error('vault not configured (Settings → Vault)'), { status: 400 });
  return v;
};

// ---------- index ----------

let cache = { at: 0, notes: [] };
export const invalidate = () => { cache.at = 0; };

export function index(force = false) {
  const v = mustVault();
  if (!force && Date.now() - cache.at < 3000) return cache.notes;
  const notes = [];
  walk(v, (abs, rel, e) => {
    if (e.isDirectory() || !rel.endsWith('.md')) return;
    try {
      const st = fs.statSync(abs);
      const text = st.size < 2_000_000 ? fs.readFileSync(abs, 'utf8') : '';
      notes.push({
        path: rel,
        title: path.basename(rel, '.md'),
        folder: path.dirname(rel) === '.' ? '' : path.dirname(rel),
        mtime: st.mtimeMs, size: st.size,
        tags: parseTags(text),
        links: parseLinks(text),
        excerpt: stripMd(text).slice(0, 200),
      });
    } catch { }
  }, { maxFiles: 30000 });
  cache = { at: Date.now(), notes };
  return notes;
}

const parseLinks = (text) => [...new Set([...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim()))];

function parseTags(text) {
  const tags = new Set();
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const tm = fm[1].match(/^tags:\s*(.*)$/m);
    if (tm) {
      const inline = tm[1].trim();
      if (inline.startsWith('[')) inline.slice(1, -1).split(',').forEach(t => t.trim() && tags.add(t.trim().replace(/^["']|["']$/g, '')));
      else if (inline) inline.split(/[, ]+/).forEach(t => t && tags.add(t));
      else for (const lm of fm[1].slice(fm[1].indexOf(tm[0]) + tm[0].length).matchAll(/^\s*-\s*(.+)$/gm)) tags.add(lm[1].trim());
    }
  }
  for (const m of text.replace(/^---\n[\s\S]*?\n---/, '').matchAll(/(?:^|\s)#([a-zA-Z][\w/-]*)/g)) tags.add(m[1]);
  return [...tags].slice(0, 20);
}

const stripMd = (t) => t.replace(/^---\n[\s\S]*?\n---/, '').replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>`\[\]!]/g, '').replace(/\s+/g, ' ').trim();

/** Resolve a wikilink target to an existing note path, or null. */
export function resolveLink(name) {
  const n = name.toLowerCase();
  const notes = index();
  return notes.find(x => x.title.toLowerCase() === n)?.path
    || notes.find(x => x.path.toLowerCase() === n + '.md')?.path
    || null;
}

// ---------- CRUD ----------

export function readNote(rel) {
  const abs = safePath(mustVault(), rel);
  const content = fs.readFileSync(abs, 'utf8');
  const title = path.basename(rel, '.md');
  const backlinks = index().filter(n => n.path !== rel && n.links.some(l => l.toLowerCase() === title.toLowerCase())).map(n => ({ path: n.path, title: n.title }));
  return { path: rel, content, backlinks, mtime: fs.statSync(abs).mtimeMs };
}

export function writeNote(rel, content) {
  const abs = safePath(mustVault(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content ?? '');
  invalidate();
  return { path: rel, mtime: fs.statSync(abs).mtimeMs };
}

export function deleteNote(rel) {
  fs.rmSync(safePath(mustVault(), rel));
  invalidate();
}

export function renameNote(from, to) {
  const v = mustVault();
  const b = safePath(v, to);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(safePath(v, from), b);
  invalidate();
}

export function setVaultPath(p, create = false) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) {
    if (!create) throw Object.assign(new Error('folder does not exist: ' + abs), { status: 400 });
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, 'Welcome.md'), `# Welcome\n\nThis vault was created by AIOS on ${new Date().toDateString()}.\nOpen it in Obsidian too — AIOS and Obsidian share the same folder of markdown files.\n`);
  }
  loadConfig().vault.path = abs;
  saveConfig();
  invalidate();
  return status();
}

export function status() {
  const v = vaultPath();
  const exists = !!v && fs.existsSync(v);
  return { path: v, exists, notes: exists ? index(true).length : 0 };
}

/** Append a timestamped bullet to today's daily note. */
export function dailyCapture(text) {
  const v = mustVault();
  const cfg = loadConfig();
  const d = new Date();
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const rel = path.join(cfg.vault.dailyFolder || 'Daily', name + '.md');
  const abs = safePath(v, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const time = d.toTimeString().slice(0, 5);
  const line = `- ${time} ${text.trim()}\n`;
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, `# ${name}\n\n${line}`);
  else fs.appendFileSync(abs, line);
  invalidate();
  return { path: rel };
}

// ---------- search & graph ----------

export function search(q, limit = 30) {
  const needle = q.toLowerCase().trim();
  if (!needle) return [];
  const terms = needle.split(/\s+/).filter(Boolean);
  const v = mustVault();
  const scored = [];
  for (const n of index()) {
    let score = 0;
    for (const t of terms) {
      if (n.title.toLowerCase().includes(t)) score += 12;
      if (n.tags.some(x => x.toLowerCase().includes(t))) score += 6;
      if (n.path.toLowerCase().includes(t)) score += 3;
    }
    let text = '';
    try { if (n.size < 500_000) text = fs.readFileSync(path.join(v, n.path), 'utf8').toLowerCase(); } catch { }
    for (const t of terms) {
      let i = -1, hits = 0;
      while ((i = text.indexOf(t, i + 1)) >= 0 && hits < 12) hits++;
      score += hits;
    }
    if (score > 0) {
      const i = text.indexOf(terms[0]);
      scored.push({ ...n, score, excerpt: i >= 0 ? '…' + text.slice(Math.max(0, i - 50), i + 110).replace(/\s+/g, ' ') + '…' : n.excerpt });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function graph() {
  const notes = index();
  const byTitle = new Map(notes.map(n => [n.title.toLowerCase(), n.path]));
  const nodes = notes.map(n => ({ id: n.path, title: n.title, folder: n.folder, out: n.links.length, in: 0 }));
  const idx = new Map(nodes.map(n => [n.id, n]));
  const edges = [];
  for (const n of notes) {
    for (const l of n.links) {
      const target = byTitle.get(l.toLowerCase());
      if (target && target !== n.path) {
        edges.push({ s: n.path, t: target });
        const tn = idx.get(target); if (tn) tn.in++;
      }
    }
  }
  return { nodes, edges };
}

// ---------- AI: ask, summarize, wiki-generate ----------

const emit = (reqId, ev) => publish(`vaultai:${reqId}`, { t: 'vault.ai', reqId, ev });
const aborts = new Map();
export const cancelAI = (reqId) => { aborts.get(reqId)?.abort(); aborts.delete(reqId); };

export async function askVault({ reqId, question, modelRef }) {
  const ctl = new AbortController();
  aborts.set(reqId, ctl);
  try {
    const hits = search(question, 8);
    const v = mustVault();
    const context = hits.map(h => {
      let body = '';
      try { body = fs.readFileSync(path.join(v, h.path), 'utf8'); } catch { }
      return `### [[${h.title}]] (${h.path})\n${truncate(stripFrontmatter(body), 2500)}`;
    }).join('\n\n');
    emit(reqId, { type: 'sources', sources: hits.map(h => ({ path: h.path, title: h.title })) });

    const system = `You answer questions from the user's personal Obsidian vault. Ground every claim in the provided notes and cite them inline as wikilinks like [[Note Title]]. If the notes don't contain the answer, say so plainly and answer from general knowledge, clearly separated. Be concise.`;
    const res = await streamChat({
      modelRef, system,
      messages: [{ role: 'user', text: `Vault notes:\n\n${context || '(no relevant notes found)'}\n\n---\nQuestion: ${question}` }],
      signal: ctl.signal, maxTokens: 4000,
      onEvent: ev => { if (ev.type === 'text') emit(reqId, { type: 'delta', delta: ev.delta }); },
    });
    emit(reqId, { type: 'done', text: res.text });
  } catch (e) {
    if (!ctl.signal.aborted) emit(reqId, { type: 'error', message: e.message });
  } finally { aborts.delete(reqId); }
}

export async function summarizeNote({ reqId, path: rel, modelRef }) {
  const ctl = new AbortController();
  aborts.set(reqId, ctl);
  try {
    const { content } = readNote(rel);
    const res = await streamChat({
      modelRef,
      system: 'Summarize the note into a tight markdown digest: 3-6 bullets of key points, then "Connections:" with 2-4 suggested [[wikilinks]] to related concepts worth their own notes.',
      messages: [{ role: 'user', text: truncate(content, 24000) }],
      signal: ctl.signal, maxTokens: 1500,
      onEvent: ev => { if (ev.type === 'text') emit(reqId, { type: 'delta', delta: ev.delta }); },
    });
    emit(reqId, { type: 'done', text: res.text });
  } catch (e) {
    if (!ctl.signal.aborted) emit(reqId, { type: 'error', message: e.message });
  } finally { aborts.delete(reqId); }
}

/**
 * Grow the wiki core: given a topic (or a source note), generate a small web of
 * interlinked atomic notes and write them into the vault's wiki folder.
 * Shared by the Vault app (wikiGenerate below) and the agent's wiki_generate tool.
 */
export async function generateWiki({ topic, sourcePath, count = 5, modelRef, signal, onProgress = () => { } }) {
  const cfg = loadConfig();
  const folder = cfg.vault.wikiFolder || 'AI Wiki';
  let subject = topic;
  if (sourcePath) {
    const { content } = readNote(sourcePath);
    subject = `the concepts in this note:\n\n${truncate(content, 16000)}`;
  }
  const existing = index().map(n => n.title).slice(0, 300).join(', ');

  const system = `You build a Zettelkasten-style wiki. Produce STRICT JSON only — no markdown fences, no commentary. Schema:
{"notes":[{"title":"Concept Name","tags":["tag1"],"content":"markdown body"}]}
Rules:
- ${count} atomic notes, each 150-350 words, densely interlinked with [[wikilinks]] to each other (and to existing notes when natural).
- Titles are concise noun phrases, unique, no slashes.
- Content: a one-line definition in bold, then explanation, examples, and a "Related" section of wikilinks.
- Existing notes you may link to: ${existing || '(none)'}`;

  const res = await streamChat({
    modelRef, system,
    messages: [{ role: 'user', text: `Build ${count} interlinked notes about ${subject}` }],
    signal, maxTokens: 16000,
    onEvent: ev => { if (ev.type === 'text') onProgress(ev.delta.length); },
  });

  const parsed = extractJSON(res.text);
  if (!parsed?.notes?.length) throw new Error('model did not return valid JSON notes — try again or use a stronger model');

  const created = [];
  for (const n of parsed.notes.slice(0, 20)) {
    if (!n.title) continue;
    const safe = n.title.replace(/[/\\:*?"<>|]/g, '-').trim();
    const rel = path.join(folder, safe + '.md');
    const fm = `---\ncreated: ${now()}\nsource: AIOS wiki generator${sourcePath ? `\nfrom: "[[${path.basename(sourcePath, '.md')}]]"` : ''}\ntags: [${['ai-wiki', ...(n.tags || [])].map(t => String(t).replace(/[^\w/-]/g, '')).filter(Boolean).join(', ')}]\n---\n\n`;
    writeNote(rel, fm + `# ${safe}\n\n` + (n.content || ''));
    created.push({ path: rel, title: safe });
  }
  return { created, folder };
}

/** WS-streaming wrapper around generateWiki for the Vault app UI. */
export async function wikiGenerate({ reqId, topic, sourcePath, count = 5, modelRef }) {
  const ctl = new AbortController();
  aborts.set(reqId, ctl);
  try {
    emit(reqId, { type: 'status', message: 'Designing the note web…' });
    const { created, folder } = await generateWiki({
      topic, sourcePath, count, modelRef, signal: ctl.signal,
      onProgress: (chars) => emit(reqId, { type: 'progress', chars }),
    });
    emit(reqId, { type: 'created', notes: created });
    emit(reqId, { type: 'done', text: `Created ${created.length} notes in ${folder}/` });
  } catch (e) {
    if (!ctl.signal.aborted) emit(reqId, { type: 'error', message: e.message });
  } finally { aborts.delete(reqId); }
}

const stripFrontmatter = (t) => t.replace(/^---\n[\s\S]*?\n---\n?/, '');

function extractJSON(text) {
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
