// The LLM wiki layer on top of the vault: structured upserts with frontmatter and
// conservative autolinking, an auto-generated Home.md index (the "map of content"
// that makes the wiki presentable in Obsidian and in the Vault app), and recall() —
// one call that packs the most relevant note bodies into a prompt-ready block, so
// the agent gets efficient memory instead of many search/read round-trips.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { now, truncate } from './util.js';
import { index as vaultIndex, search as vaultSearch, readNote, writeNote } from './vault.js';

export const wikiFolder = () => (loadConfig().vault.wikiFolder || 'AI Wiki').replace(/^\/+|\/+$/g, '');
const inWiki = (rel) => {
  const w = wikiFolder().toLowerCase() + '/';
  return String(rel || '').toLowerCase().startsWith(w) || String(rel || '').toLowerCase() + '/' === w;
};
export const isWikiPath = inWiki;

const safeName = (t) => String(t || '').replace(/[/\\:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);

// ---------- the typed note system ----------
// A fixed set of note kinds, each with a canonical template. The `notes` skill
// teaches when to use which; note_template hands the agent the exact scaffold;
// wiki_learn stamps the kind into frontmatter so notes stay filterable.

export const NOTE_KINDS = {
  concept: {
    what: 'what something IS — definition, mechanics, example',
    template: '**<One-sentence definition.>**\n\n## Why it matters\n<the problem it solves / where you meet it>\n\n## How it works\n<the mental model, mechanics>\n\n## Example\n```\n<minimal runnable example>\n```\n\n## Pitfalls\n- <common misunderstanding>\n\n## Related\n- [[<parent topic>]]\n- [[<sibling topic>]]',
  },
  howto: {
    what: 'a repeatable task recipe with verification',
    template: '**Goal: <what this achieves, one line.>**\n\n## Prerequisites\n- <tool/version/access needed>\n\n## Steps\n1. <one command or edit per step>\n\n## Verify\n<how you know it worked>\n\n## Pitfalls\n- <the step people get wrong>\n\n## Related\n- [[<related note>]]',
  },
  reference: {
    what: 'exact API/tool/flag facts, versioned and sourced',
    template: '**<What this covers, one line, with version.>**\n\n## Key signatures\n```\n<the signatures that matter, exact>\n```\n\n## Options that matter\n| option | effect | default |\n|---|---|---|\n\n## Minimal example\n```\n```\n\n## Gotchas\n- \n\n## Source\n<url>\n\n## Related\n- [[<related note>]]',
  },
  decision: {
    what: 'a choice that must stick — context, rationale, revisit trigger',
    template: '**Decision: <what was decided> (<YYYY-MM-DD>).**\n\n## Context\n\n## Options considered\n- <option — the pro/con that mattered>\n\n## Rationale\n\n## Consequences\n\n## Revisit when\n<the concrete trigger that would reopen this>\n\n## Related\n- [[<related note>]]',
  },
  troubleshooting: {
    what: 'an error diagnosed and fixed — searchable by symptom',
    template: '**Symptom: <exact error text or observable failure.>**\n\n## Root cause\n\n## Fix\n```\n<the working fix>\n```\n\n## Prevention\n\n## Environment\n<versions/OS, date seen>\n\n## Related\n- [[<related note>]]',
  },
  source: {
    what: 'distilled book/article/video with attributed claims',
    template: '**<Author> — *<Title>* (<year>): <one-line thesis.>**\n\n## Key claims\n- <claim + where in the source>\n\n## Quotes\n> <verbatim quote worth keeping>\n\n## Takeaways\n- <what changes in practice>\n\n## Related\n- [[<related note>]]',
  },
  project: {
    what: 'the hub note for an ongoing effort — links out, logs tersely',
    template: '**<Project> — <goal in one line.> Status: active.**\n\n## Goal & success criteria\n\n## Current state\n\n## Key notes\n- [[<its decisions/references/howtos>]]\n\n## Log\n- <YYYY-MM-DD> <event>\n\n## Related\n- [[<related note>]]',
  },
};

/** The scaffold for one kind, or the kind catalog when none/unknown given. */
export function noteTemplate(kind) {
  const k = String(kind || '').toLowerCase().trim();
  if (NOTE_KINDS[k]) return { kind: k, what: NOTE_KINDS[k].what, template: NOTE_KINDS[k].template };
  return { kinds: Object.entries(NOTE_KINDS).map(([name, v]) => ({ kind: name, what: v.what })) };
}

/** Where upsertNote will write a given title/folder — used for approval previews. */
export function notePathFor({ title, folder = '' }) {
  const sub = String(folder || '').replace(/^\/+|\/+$/g, '').split('/').map(safeName).filter(Boolean).join('/');
  return path.posix.join(wikiFolder(), sub, safeName(title) + '.md');
}

// ---------- upsert with frontmatter + autolinking ----------

/**
 * Create or update a wiki note. Preserves the original `created:` stamp on update,
 * merges tags, and autolinks the first mention of other wiki note titles so the
 * graph stays connected without the model having to remember every title.
 * Returns { path, created:boolean, linked:[titles] }.
 */
export function upsertNote({ title, folder = '', content = '', tags = [], source = '', kind = '' }) {
  const name = safeName(title);
  if (!name) throw Object.assign(new Error('note title is empty'), { status: 400 });
  const sub = String(folder || '').replace(/^\/+|\/+$/g, '').split('/').map(safeName).filter(Boolean).join('/');
  const rel = path.posix.join(wikiFolder(), sub, name + '.md');

  let prevCreated = '', prevTags = [], prevType = '';
  let existed = false;
  try {
    const prev = readNote(rel);
    existed = true;
    prevCreated = prev.content.match(/^---\n[\s\S]*?^created:\s*(\S+)/m)?.[1] || '';
    prevType = prev.content.match(/^---\n[\s\S]*?^type:\s*(\S+)/m)?.[1] || '';
    const tm = prev.content.match(/^---\n[\s\S]*?^tags:\s*\[([^\]]*)\]/m)?.[1] || '';
    prevTags = tm.split(',').map(s => s.trim()).filter(Boolean);
  } catch { }

  const type = NOTE_KINDS[String(kind || '').toLowerCase()] ? String(kind).toLowerCase() : prevType;
  const allTags = [...new Set(['ai-wiki', ...prevTags, ...(tags || []).map(t => String(t).replace(/[^\w/-]/g, ''))])].filter(Boolean);
  const body = String(content || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim(); // callers pass bodies; we own the frontmatter
  const { text: linkedBody, linked } = autolink(body, name);

  const fm = [
    '---',
    `created: ${prevCreated || now()}`,
    `updated: ${now()}`,
    ...(type ? [`type: ${type}`] : []),
    `tags: [${allTags.join(', ')}]`,
    ...(source ? [`source: ${safeName(source)}`] : []),
    '---', '',
  ].join('\n');
  const heading = new RegExp(`^#\\s`).test(linkedBody) ? '' : `# ${name}\n\n`;
  writeNote(rel, fm + heading + linkedBody + '\n');
  return { path: rel, created: !existed, linked };
}

/**
 * Link the first plain-text mention of each existing wiki note title.
 * Conservative on purpose: titles ≥ 4 chars only, whole-word, skips fenced code,
 * inline code, headings, and text that is already inside a link.
 */
export function autolink(text, selfTitle = '') {
  const titles = vaultIndex()
    .filter(n => inWiki(n.path) && n.title.length >= 4 && n.title.toLowerCase() !== String(selfTitle).toLowerCase())
    .map(n => n.title)
    .sort((a, b) => b.length - a.length)   // longest first so "Node Streams" wins over "Node"
    .slice(0, 400);
  if (!titles.length) return { text, linked: [] };

  // split out segments we must not touch: fenced code, inline code, existing links, headings
  const parts = String(text).split(/(```[\s\S]*?```|`[^`\n]*`|\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|^#{1,6} .*$)/m);
  const linked = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const t of titles) {
    if (linked.length >= 12) break;
    const rx = new RegExp(`(^|[^\\w\\[])(${esc(t)})(?=$|[^\\w\\]])`, 'i');
    for (let i = 0; i < parts.length; i += 2) {         // even indices = plain text segments
      if (rx.test(parts[i])) {
        parts[i] = parts[i].replace(rx, (m, pre, hit) => `${pre}[[${t}|${hit}]]`);
        linked.push(t);
        break;                                          // first mention only
      }
    }
  }
  return { text: parts.join(''), linked };
}

// ---------- the index (Home.md map of content) ----------

/** Regenerate `<wiki>/Home.md`: notes grouped by folder with one-line excerpts,
 *  a recently-updated list, and orphans that need linking. Pure fs — no LLM. */
export function rebuildIndex() {
  const w = wikiFolder();
  const notes = vaultIndex(true).filter(n => inWiki(n.path) && n.title.toLowerCase() !== 'home');
  const byFolder = new Map();
  for (const n of notes) {
    const sub = n.folder === w ? '' : n.folder.slice(w.length + 1);
    if (!byFolder.has(sub)) byFolder.set(sub, []);
    byFolder.get(sub).push(n);
  }
  const linkedTo = new Set();
  for (const n of notes) for (const l of n.links) linkedTo.add(l.toLowerCase());

  const lines = [
    '---', `updated: ${now()}`, 'tags: [ai-wiki, moc]', '---', '',
    '# Wiki Home', '',
    `> Map of content — regenerated automatically. ${notes.length} notes.`, '',
  ];
  for (const sub of [...byFolder.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b))) {
    const group = byFolder.get(sub).sort((a, b) => a.title.localeCompare(b.title));
    lines.push(`## ${sub || 'General'}`, '');
    for (const n of group.slice(0, 200)) {
      let ex = n.excerpt || '';
      // excerpts start with the H1 (= the title) — drop it, the wikilink already says it
      if (ex.toLowerCase().startsWith(n.title.toLowerCase())) ex = ex.slice(n.title.length).replace(/^[\s—:–-]+/, '');
      lines.push(`- [[${n.title}]]${ex ? ` — ${ex.slice(0, 110)}${ex.length > 110 ? '…' : ''}` : ''}`);
    }
    lines.push('');
  }
  const recent = [...notes].sort((a, b) => b.mtime - a.mtime).slice(0, 10);
  if (recent.length) {
    lines.push('## Recently updated', '');
    for (const n of recent) lines.push(`- [[${n.title}]] — ${new Date(n.mtime).toISOString().slice(0, 10)}`);
    lines.push('');
  }
  const orphans = notes.filter(n => !linkedTo.has(n.title.toLowerCase()) && !n.links.length).slice(0, 15);
  if (orphans.length) {
    lines.push('## Orphans (link these into the graph)', '');
    for (const n of orphans) lines.push(`- [[${n.title}]]`);
    lines.push('');
  }
  const rel = path.posix.join(w, 'Home.md');
  writeNote(rel, lines.join('\n'));
  return { path: rel, notes: notes.length, orphans: orphans.length };
}

// ---------- recall (efficient memory) ----------

/**
 * One-call memory: search the whole vault, then pack the top note bodies into a
 * prompt-ready block under a char budget. Wiki notes rank first, whole-vault next.
 */
export function recall(query, { chars = 6000, limit = 5 } = {}) {
  const hits = vaultSearch(String(query || ''), 20);
  if (!hits.length) return { text: '', notes: [] };
  hits.sort((a, b) => (inWiki(b.path) - inWiki(a.path)) || (b.score - a.score));
  const v = loadConfig().vault.path;
  const blocks = [];
  const used = [];
  let budget = Math.max(1000, chars);
  for (const h of hits) {
    if (used.length >= limit || budget < 400) break;
    let body = '';
    try { body = fs.readFileSync(path.join(v, h.path), 'utf8'); } catch { continue; }
    body = body.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    const take = truncate(body, Math.min(Math.floor(budget / Math.max(1, Math.min(limit, hits.length) - used.length)), 2600));
    blocks.push(`### [[${h.title}]] (${h.path})\n${take}`);
    budget -= take.length + h.path.length + 20;
    used.push({ path: h.path, title: h.title });
  }
  return { text: blocks.join('\n\n'), notes: used };
}
