// Rendering helpers for the git workspace: a unified-diff viewer with line numbers and
// per-hunk actions, a splitter for multi-file patches, and the lane layout behind the
// history graph. Everything that came out of a repository (file names, code, commit
// subjects) is inserted with textContent — a diff of someone's HTML must stay text.

import { el } from '../ui.js';

// ---------- unified diff ----------

/** Parse one file's unified diff into hunks with old/new line numbers. */
export function parseDiff(text) {
  const hunks = [];
  let cur = null, o = 0, n = 0;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      cur = { header: m ? line.slice(0, line.indexOf('@@', 2) + 2) : line, ctx: m ? m[3].trim() : '', raw: line, lines: [] };
      o = m ? +m[1] : 0; n = m ? +m[2] : 0;
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;                              // file header lines (diff --git, index, ---, +++)
    if (line.startsWith('\\')) { cur.lines.push({ t: 'meta', s: line }); continue; }
    const c = line[0];
    if (c === '+') cur.lines.push({ t: 'add', n: n++, s: line.slice(1) });
    else if (c === '-') cur.lines.push({ t: 'del', o: o++, s: line.slice(1) });
    else if (c === ' ') cur.lines.push({ t: 'ctx', o: o++, n: n++, s: line.slice(1) });
  }
  return hunks;
}

/** Split a multi-file patch ("diff --git a/x b/x" blocks) into per-file texts. */
export function splitPatch(patch) {
  const out = [];
  let cur = null;
  for (const line of String(patch || '').split('\n')) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) { cur = { path: m[2], lines: [line] }; out.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return out.map((f) => {
    const text = f.lines.join('\n');
    return { path: f.path, text, binary: /^(Binary files|GIT binary patch)/m.test(text), hunks: parseDiff(text) };
  });
}

const LINE_CAP = 2500;

/**
 * Render parsed hunks. `hunkAction` ({ label, title, run(index, hunk) }) adds a button to each
 * hunk header — "Stage hunk" in the work-tree view, "Unstage hunk" in the staged view.
 */
export function renderDiff(hunks, { hunkAction = null, wrap = false } = {}) {
  const root = el('div', { class: 'df' + (wrap ? ' wrap' : '') });
  const total = hunks.reduce((a, h) => a + h.lines.length, 0);
  const paint = (cap) => {
    root.textContent = '';
    let budget = cap, cut = 0;
    hunks.forEach((h, i) => {
      if (budget <= 0) { cut += h.lines.length; return; }
      root.append(el('div', { class: 'df-hunk' },
        el('span', { class: 'df-hunk-h mono' }, h.header, h.ctx ? el('span', { class: 'df-hunk-ctx' }, ' ' + h.ctx) : null),
        hunkAction ? el('button', { class: 'btn xs', title: hunkAction.title || '', onclick: () => hunkAction.run(i, h) }, hunkAction.label) : null));
      const body = el('div', { class: 'df-body' });
      for (const l of h.lines) {
        if (budget-- <= 0) { cut++; continue; }
        body.append(el('div', { class: 'df-l df-' + l.t },
          el('span', { class: 'df-no' }, l.o ?? ''), el('span', { class: 'df-no' }, l.n ?? ''),
          el('span', { class: 'df-sg' }, l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''),
          el('span', { class: 'df-tx' }, l.s)));
      }
      root.append(body);
    });
    if (cut) root.append(el('button', { class: 'btn sm df-more', onclick: () => paint(Infinity) }, `Show the remaining ${cut.toLocaleString()} lines`));
  };
  paint(total > LINE_CAP ? LINE_CAP : Infinity);
  return root;
}

// ---------- history graph ----------

export const LANE_COLORS = ['#5b8def', '#e0833f', '#4aa56a', '#b565d9', '#d9564f', '#2fb5b0', '#c9a227', '#7a7fe0'];
const LW = 14, RH = 40;

/**
 * Assign every commit (newest first) to a lane. `lanes[i]` is the hash lane i is waiting
 * for; a commit takes the lane that expects it, or opens a new one, and hands its lane to
 * its first parent. Extra parents of a merge get lanes of their own; lanes that were all
 * waiting for the same commit converge into it.
 */
export function layoutGraph(commits) {
  let lanes = [];
  const rows = [];
  let width = 1;
  for (const c of commits) {
    const before = lanes.slice();
    let idx = lanes.indexOf(c.hash);
    if (idx < 0) { idx = lanes.indexOf(null); if (idx < 0) idx = lanes.length; lanes[idx] = c.hash; }
    const converge = [];
    lanes.forEach((h, i) => { if (h === c.hash && i !== idx) { converge.push(i); lanes[i] = null; } });
    const parentLanes = [];
    const ps = c.parents || [];
    if (!ps.length) lanes[idx] = null;
    else {
      const k = lanes.indexOf(ps[0]);
      if (k >= 0 && k !== idx) { lanes[idx] = null; parentLanes.push(k); }      // first parent already has a lane: join it
      else { lanes[idx] = ps[0]; parentLanes.push(idx); }
      for (const p of ps.slice(1)) {
        let j = lanes.indexOf(p);
        if (j < 0) { j = lanes.indexOf(null); if (j < 0) j = lanes.length; lanes[j] = p; }
        parentLanes.push(j);
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, before.length, lanes.length, idx + 1);
    rows.push({ idx, before, after: lanes.slice(), converge, parentLanes, merge: ps.length > 1 });
  }
  return { rows, width };
}

/** One row's slice of the graph as an inline SVG (all numbers, no repo-derived strings). */
export function graphCell(row, width) {
  const x = (i) => i * LW + LW / 2, mid = RH / 2;
  const col = (i) => LANE_COLORS[i % LANE_COLORS.length];
  const p = [];
  const line = (x1, y1, x2, y2, c) => p.push(`<path d="M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}" stroke="${c}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`);
  row.before.forEach((h, i) => {
    if (h === null || i === row.idx || row.converge.includes(i)) return;
    if (row.after[i] === h) line(x(i), 0, x(i), RH, col(i));                     // a lane passing straight through
  });
  if (row.before[row.idx] != null) line(x(row.idx), 0, x(row.idx), mid, col(row.idx));
  for (const i of row.converge) line(x(i), 0, x(row.idx), mid, col(i));
  for (const j of row.parentLanes) line(x(row.idx), mid, x(j), RH, col(j));
  p.push(row.merge
    ? `<circle cx="${x(row.idx)}" cy="${mid}" r="4.2" fill="var(--surface)" stroke="${col(row.idx)}" stroke-width="2"/>`
    : `<circle cx="${x(row.idx)}" cy="${mid}" r="4" fill="${col(row.idx)}"/>`);
  const w = Math.max(1, width) * LW;
  const span = el('span', { class: 'gl-graph', style: { width: w + 'px' } });
  span.innerHTML = `<svg width="${w}" height="${RH}" viewBox="0 0 ${w} ${RH}">${p.join('')}</svg>`;
  return span;
}
