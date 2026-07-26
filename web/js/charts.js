// Shared chart renderers — a peer of ui.js / markdown.js / minimonth.js.
//
// Hand-drawn SVG on purpose. The shell is zero-build at runtime and vendoring a
// charting library would be the single largest asset in the app for four chart
// types. More importantly, everything here reads its colours from the theme's
// CSS custom properties, so charts re-theme with the rest of the UI for free —
// something a canvas-based library cannot do without a redraw hook.
//
// Every renderer returns a detached SVG element and takes its size from the
// caller, so a ResizeObserver can simply re-render into the same slot.

import { el } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

/** SVG needs its own namespace-aware builder; el() is HTML-only. */
export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** Categorical palette. Hue-spun from the theme accent so a user who changes the
 *  accent gets a coherent set rather than a clashing rainbow, with fixed
 *  saturation/lightness steps to keep neighbouring slices distinguishable. */
export function palette(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const hue = (i * 47) % 360;                      // 47° keeps adjacent hues apart
    const light = 52 + (i % 3) * 8;
    out.push(`hsl(${hue} 58% ${light}%)`);
  }
  return out;
}

const fmtNum = (n) => {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (v >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e4) return Math.round(n / 1e3) + 'k';
  return Math.round(n).toLocaleString('en-US');
};

const empty = (w, h, msg) => svgEl('svg', { class: 'chart chart-empty', viewBox: `0 0 ${w} ${h}`, width: '100%', height: h },
  svgEl('text', { x: w / 2, y: h / 2, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'chart-empty-text', text: msg }));

/**
 * Grouped bars with an optional net line — the monthly income/expense trend.
 * series: [{ label, a, b, net }] where `a` is income and `b` is expense.
 */
export function groupedBars(series, { width = 720, height = 240, aLabel = 'in', bLabel = 'out', showNet = true, onPick } = {}) {
  if (!series?.length) return empty(width, height, 'no data for this period');
  const padL = 46, padR = 12, padT = 14, padB = 26;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const max = Math.max(1, ...series.flatMap(s => [s.a || 0, s.b || 0]));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const slot = plotW / series.length;
  const barW = Math.max(3, Math.min(18, slot / 2 - 3));

  const kids = [];
  // horizontal gridlines + value axis
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const yy = y(v);
    kids.push(svgEl('line', { x1: padL, x2: width - padR, y1: yy, y2: yy, class: 'chart-grid' }));
    kids.push(svgEl('text', { x: padL - 6, y: yy + 3, 'text-anchor': 'end', class: 'chart-axis', text: fmtNum(v) }));
  }
  series.forEach((s, i) => {
    const cx = padL + slot * i + slot / 2;
    const aH = Math.max(0, padT + plotH - y(s.a || 0));
    const bH = Math.max(0, padT + plotH - y(s.b || 0));
    const g = svgEl('g', { class: 'chart-bar-group' + (onPick ? ' is-clickable' : '') });
    g.appendChild(svgEl('rect', { x: cx - barW - 1, y: y(s.a || 0), width: barW, height: aH, rx: 2, class: 'chart-bar chart-bar-a' }));
    g.appendChild(svgEl('rect', { x: cx + 1, y: y(s.b || 0), width: barW, height: bH, rx: 2, class: 'chart-bar chart-bar-b' }));
    g.appendChild(svgEl('title', { text: `${s.label}\n${aLabel} ${fmtNum(s.a || 0)} · ${bLabel} ${fmtNum(s.b || 0)}` }));
    if (onPick) g.addEventListener('click', () => onPick(s, i));
    kids.push(g);
    // Thin out labels so they never collide on a narrow panel.
    const every = Math.ceil(series.length / Math.max(4, Math.floor(plotW / 54)));
    if (i % every === 0 || i === series.length - 1) {
      kids.push(svgEl('text', { x: cx, y: height - 8, 'text-anchor': 'middle', class: 'chart-axis', text: s.label }));
    }
  });
  if (showNet && series.some(s => s.net !== undefined)) {
    const nets = series.map(s => s.net || 0);
    const nMax = Math.max(1, ...nets.map(Math.abs));
    const ny = (v) => padT + plotH / 2 - (v / nMax) * (plotH / 2 - 6);
    const d = series.map((s, i) => `${i ? 'L' : 'M'}${padL + slot * i + slot / 2},${ny(s.net || 0)}`).join(' ');
    kids.push(svgEl('path', { d, class: 'chart-line chart-line-net', fill: 'none' }));
  }
  return svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' }, kids);
}

/** Donut for a category split. `items: [{label, value}]`, largest first. */
export function donut(items, { size = 190, thickness = 26, centerLabel = '', centerSub = '', onPick } = {}) {
  const data = (items || []).filter(d => (d.value || 0) > 0);
  if (!data.length) return empty(size, size, 'nothing to show');
  const total = data.reduce((s, d) => s + d.value, 0);
  const r = size / 2 - 2, ir = r - thickness, cx = size / 2, cy = size / 2;
  const colors = palette(data.length);
  const kids = [];
  let angle = -Math.PI / 2;
  data.forEach((d, i) => {
    const sweep = (d.value / total) * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (rad, a) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
    // A single full-circle slice cannot be drawn as an arc (start === end).
    const path = data.length === 1
      ? `M${cx - r},${cy} A${r},${r} 0 1 1 ${cx + r},${cy} A${r},${r} 0 1 1 ${cx - r},${cy} ` +
        `M${cx - ir},${cy} A${ir},${ir} 0 1 0 ${cx + ir},${cy} A${ir},${ir} 0 1 0 ${cx - ir},${cy}`
      : `M${p(r, angle)} A${r},${r} 0 ${large} 1 ${p(r, end)} L${p(ir, end)} A${ir},${ir} 0 ${large} 0 ${p(ir, angle)} Z`;
    const seg = svgEl('path', { d: path, fill: colors[i], class: 'chart-slice' + (onPick ? ' is-clickable' : ''), 'fill-rule': 'evenodd' },
      svgEl('title', { text: `${d.label}: ${fmtNum(d.value)} (${Math.round(d.value / total * 100)}%)` }));
    if (onPick) seg.addEventListener('click', () => onPick(d, i));
    kids.push(seg);
    angle = end;
  });
  if (centerLabel) {
    kids.push(svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'chart-center', text: centerLabel }));
    if (centerSub) kids.push(svgEl('text', { x: cx, y: cy + 16, 'text-anchor': 'middle', class: 'chart-center-sub', text: centerSub }));
  }
  return svgEl('svg', { class: 'chart', viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img' }, kids);
}

/** A legend that pairs with donut() — same palette order. */
export function legend(items, { onPick, format = fmtNum } = {}) {
  const data = (items || []).filter(d => (d.value || 0) > 0);
  const colors = palette(data.length);
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return el('ul', { class: 'chart-legend' }, data.map((d, i) => el('li', {
    class: 'chart-legend-item' + (onPick ? ' is-clickable' : ''),
    onclick: onPick ? () => onPick(d, i) : null,
  },
    el('span', { class: 'chart-swatch', style: { background: colors[i] } }),
    el('span', { class: 'chart-legend-label' }, d.label),
    el('span', { class: 'chart-legend-value' }, format(d.value)),
    el('span', { class: 'chart-legend-pct' }, Math.round(d.value / total * 100) + '%'),
  )));
}

/** Cumulative area — running balance across a period. points: [{label, value}] */
export function areaLine(points, { width = 720, height = 170, cumulative = true } = {}) {
  if (!points?.length) return empty(width, height, 'no activity in this period');
  const padL = 46, padR = 12, padT = 12, padB = 22;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  let acc = 0;
  const vals = points.map(p => (cumulative ? (acc += p.value || 0) : (p.value || 0)));
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = (hi - lo) || 1;
  const x = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - lo) / span) * plotH;

  const kids = [];
  const zeroY = y(0);
  kids.push(svgEl('line', { x1: padL, x2: width - padR, y1: zeroY, y2: zeroY, class: 'chart-grid chart-zero' }));
  for (const v of [hi, lo]) {
    kids.push(svgEl('text', { x: padL - 6, y: y(v) + 3, 'text-anchor': 'end', class: 'chart-axis', text: fmtNum(v) }));
  }
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ');
  kids.push(svgEl('path', { d: `${line} L${x(vals.length - 1)},${zeroY} L${x(0)},${zeroY} Z`, class: 'chart-area', fill: 'currentColor' }));
  kids.push(svgEl('path', { d: line, class: 'chart-line', fill: 'none' }));
  points.forEach((p, i) => kids.push(svgEl('circle', { cx: x(i), cy: y(vals[i]), r: 6, class: 'chart-dot-hit' },
    svgEl('title', { text: `${p.label}: ${fmtNum(vals[i])}` }))));
  kids.push(svgEl('text', { x: padL, y: height - 6, class: 'chart-axis', text: points[0].label }));
  if (points.length > 1) {
    kids.push(svgEl('text', { x: width - padR, y: height - 6, 'text-anchor': 'end', class: 'chart-axis', text: points[points.length - 1].label }));
  }
  return svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' }, kids);
}

/** Horizontal ranked bars — top merchants / categories. */
export function rankedBars(items, { width = 340, rowH = 26, format = fmtNum, onPick } = {}) {
  const data = (items || []).filter(d => (d.value || 0) > 0);
  if (!data.length) return el('p', { class: 'empty' }, 'nothing to rank yet');
  const max = Math.max(...data.map(d => d.value));
  return el('ul', { class: 'chart-ranked' }, data.map((d, i) => el('li', {
    class: 'chart-ranked-row' + (onPick ? ' is-clickable' : ''),
    onclick: onPick ? () => onPick(d, i) : null,
    style: { height: rowH + 'px' },
  },
    el('span', { class: 'chart-ranked-label' }, d.label),
    el('span', { class: 'chart-ranked-track' },
      el('span', { class: 'chart-ranked-fill', style: { width: Math.max(2, d.value / max * 100) + '%' } })),
    el('span', { class: 'chart-ranked-value' }, format(d.value)),
  )));
}

/**
 * Calendar heat map for one month: weeks as rows, weekdays as columns.
 * `days: [{date, spent, count}]` — sparse is fine, missing days render empty.
 * Intensity is bucketed rather than continuous so a single huge day (rent) does
 * not flatten every other day to invisible.
 */
export function calendarHeat(days, { month, max = 0, weekStart = 'monday', format = fmtNum, onPick } = {}) {
  const [y, m] = String(month || '').split('-').map(Number);
  if (!y || !m) return el('p', { class: 'empty sm' }, 'pick a month to see the calendar');
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDate = new Map((days || []).map(d => [d.date, d]));
  const peak = max || Math.max(0, ...(days || []).map(d => d.spent));

  // Bucket on a log-ish scale: quartiles of the peak, so ordinary days separate.
  const level = (v) => {
    if (!v) return 0;
    if (!peak) return 1;
    const r = v / peak;
    return r > 0.5 ? 4 : r > 0.2 ? 3 : r > 0.05 ? 2 : 1;
  };

  const shift = weekStart === 'sunday' ? 0 : 1;
  const labels = weekStart === 'sunday'
    ? ['S', 'M', 'T', 'W', 'T', 'F', 'S']
    : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  const cells = [];
  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() - shift + 7) % 7;
  for (let i = 0; i < firstDow; i++) cells.push(el('span', { class: 'cal-cell is-pad' }));
  for (let d = 1; d <= lastDay; d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    const rec = byDate.get(iso);
    const lv = level(rec?.spent || 0);
    cells.push(el('span', {
      class: `cal-cell l${lv}` + (onPick && rec ? ' is-clickable' : ''),
      title: rec ? `${iso} — ${format(rec.spent)} across ${rec.count} entr${rec.count === 1 ? 'y' : 'ies'}` : `${iso} — nothing`,
      onclick: onPick && rec ? () => onPick(rec) : null,
    }, el('span', { class: 'cal-day' }, String(d))));
  }
  return el('div', { class: 'cal-wrap' },
    el('div', { class: 'cal-dow' }, labels.map(l => el('span', {}, l))),
    el('div', { class: 'cal-grid' }, cells),
    el('div', { class: 'cal-key' },
      el('span', { class: 'muted' }, 'less'),
      [0, 1, 2, 3, 4].map(l => el('span', { class: `cal-cell is-key l${l}` })),
      el('span', { class: 'muted' }, 'more')));
}

/** Tiny inline bars — one per value, sized against the largest. For month cards. */
export function sparkbars(values, { height = 22, width = 64, tone = 'accent' } = {}) {
  const vals = (values || []).map(v => Number(v) || 0);
  if (!vals.length) return svgEl('svg', { class: 'spark', width, height });
  const max = Math.max(1, ...vals.map(Math.abs));
  const bw = width / vals.length;
  return svgEl('svg', { class: 'spark', viewBox: `0 0 ${width} ${height}`, width, height },
    vals.map((v, i) => {
      const h = Math.max(1, (Math.abs(v) / max) * (height - 2));
      return svgEl('rect', {
        x: i * bw + 0.5, width: Math.max(1, bw - 1), y: height - h, height: h, rx: 1,
        class: `spark-bar is-${v < 0 ? 'neg' : tone}`,
      });
    }));
}

/** A meter with an optional second "stretch" marker — budgets and goals. */
export function meter(value, target, { stretch = 0, format = fmtNum, danger = false } = {}) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  const over = target > 0 && value > target;
  return el('div', { class: 'fin-meter' + (over || danger ? ' is-over' : '') },
    el('div', { class: 'fin-meter-track' },
      el('div', { class: 'fin-meter-fill', style: { width: pct + '%' } }),
      stretch > 0 && target > 0 && stretch !== target
        ? el('span', { class: 'fin-meter-mark', style: { left: Math.min(100, target / stretch * 100) + '%' } })
        : null),
    el('div', { class: 'fin-meter-caption' },
      el('span', {}, format(value)),
      el('span', { class: 'fin-meter-target' }, ' / ' + format(target)),
    ));
}

export { fmtNum };
