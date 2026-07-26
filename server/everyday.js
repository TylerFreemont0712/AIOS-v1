// Everyday reference + utility tools: Wikipedia lookup, translation, a safe
// calculator, unit/currency conversion, and date/time math. All keyless and free
// (Wikipedia REST, Google's public gtx translate endpoint, Open-ER-API for FX);
// the calculator, unit table and date math are fully local. Read-only and
// root-independent, so both Chat and the Agent can call them.

const UA = 'AIOS/1.0 (personal assistant hub)';

async function getJSON(url, { signal, headers, timeout = 12000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort); }
}

// ---------- Wikipedia ----------

/** Look up a topic on Wikipedia: resolve the best title, return its summary + url. */
export async function wikipedia(query, { lang = 'en', signal } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('empty query');
  const wiki = `https://${encodeURIComponent(lang)}.wikipedia.org`;
  // find the best-matching page title first (handles partial / imprecise queries)
  let title = q;
  try {
    const s = await getJSON(`${wiki}/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=1`, { signal });
    if (s.pages?.[0]?.title) title = s.pages[0].title;
  } catch { /* fall back to the raw query as a title */ }
  const sum = await getJSON(`${wiki}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, { signal });
  if (sum.type === 'disambiguation') return { title: sum.title, extract: `"${sum.title}" is a disambiguation page — be more specific.`, url: sum.content_urls?.desktop?.page || '' };
  return {
    title: sum.title || title,
    description: sum.description || '',
    extract: sum.extract || '(no summary available)',
    url: sum.content_urls?.desktop?.page || `${wiki}/wiki/${encodeURIComponent(title)}`,
  };
}

// ---------- Translation ----------

/** Translate text via Google's public gtx endpoint (no key). Auto-detects the
 *  source language unless `from` is given; `to` defaults to English. */
export async function translate(text, { to = 'en', from = 'auto', signal } = {}) {
  const q = String(text || '');
  if (!q.trim()) throw new Error('nothing to translate');
  const u = new URL('https://translate.googleapis.com/translate_a/single');
  u.searchParams.set('client', 'gtx');
  u.searchParams.set('sl', from || 'auto');
  u.searchParams.set('tl', to || 'en');
  u.searchParams.set('dt', 't');
  u.searchParams.set('q', q.slice(0, 5000));
  const j = await getJSON(u, { signal });
  const out = (j?.[0] || []).map(seg => seg?.[0] || '').join('');
  const detected = j?.[2] || from || 'auto';
  if (!out) throw new Error('translation failed');
  return { text: out, from: detected, to: to || 'en' };
}

// ---------- Safe calculator ----------

const CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
const FUNCS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: (x) => Math.log10(x), log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  round: Math.round, floor: Math.floor, ceil: Math.ceil, sign: Math.sign,
  min: Math.min, max: Math.max, fact: (n) => { n = Math.round(n); if (n < 0 || n > 170) return NaN; let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; },
};

/** Evaluate an arithmetic expression safely — no eval/Function. Supports + - * / %,
 *  ^ (power), parentheses, unary minus, constants (pi/e/tau) and the FUNCS above. */
export function calculate(expr) {
  const src = String(expr || '').trim();
  if (!src) throw new Error('empty expression');
  const toks = tokenize(src);
  const { value, rest } = parseExpr(toks, 0);
  if (rest !== toks.length) throw new Error('unexpected trailing input');
  if (!Number.isFinite(value)) throw new Error('result is not a finite number');
  return value;
}

function tokenize(s) {
  const out = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_]\w*)|([+\-*/%^(),]))/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m || m.index !== i) throw new Error(`bad character near "${s.slice(i, i + 8)}"`);
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'name', v: m[2] });
    else out.push({ t: 'op', v: m[3] });
    i = re.lastIndex;
  }
  return out;
}

// recursive-descent: expr → term (('+'|'-') term)*, term → power (('*'|'/'|'%') power)*,
// power → unary ('^' power)?, unary → '-'? atom, atom → num | const | func(args) | '(' expr ')'
function parseExpr(t, i) {
  let { value, rest } = parseTerm(t, i);
  while (t[rest]?.t === 'op' && (t[rest].v === '+' || t[rest].v === '-')) {
    const op = t[rest].v; const r = parseTerm(t, rest + 1);
    value = op === '+' ? value + r.value : value - r.value; rest = r.rest;
  }
  return { value, rest };
}
function parseTerm(t, i) {
  let { value, rest } = parsePower(t, i);
  while (t[rest]?.t === 'op' && (t[rest].v === '*' || t[rest].v === '/' || t[rest].v === '%')) {
    const op = t[rest].v; const r = parsePower(t, rest + 1);
    value = op === '*' ? value * r.value : op === '/' ? value / r.value : value % r.value; rest = r.rest;
  }
  return { value, rest };
}
function parsePower(t, i) {
  const base = parseUnary(t, i);
  if (t[base.rest]?.t === 'op' && t[base.rest].v === '^') {
    const exp = parsePower(t, base.rest + 1);   // right-associative
    return { value: Math.pow(base.value, exp.value), rest: exp.rest };
  }
  return base;
}
function parseUnary(t, i) {
  if (t[i]?.t === 'op' && (t[i].v === '-' || t[i].v === '+')) {
    const r = parseUnary(t, i + 1);
    return { value: t[i].v === '-' ? -r.value : r.value, rest: r.rest };
  }
  return parseAtom(t, i);
}
function parseAtom(t, i) {
  const tok = t[i];
  if (!tok) throw new Error('unexpected end of expression');
  if (tok.t === 'num') return { value: tok.v, rest: i + 1 };
  if (tok.t === 'op' && tok.v === '(') {
    const r = parseExpr(t, i + 1);
    if (t[r.rest]?.v !== ')') throw new Error('missing closing paren');
    return { value: r.value, rest: r.rest + 1 };
  }
  if (tok.t === 'name') {
    const name = tok.v.toLowerCase();
    if (t[i + 1]?.t === 'op' && t[i + 1].v === '(') {
      const fn = FUNCS[name];
      if (!fn) throw new Error(`unknown function "${tok.v}"`);
      const args = []; let rest = i + 2;
      if (t[rest]?.v !== ')') {
        for (;;) {
          const a = parseExpr(t, rest); args.push(a.value); rest = a.rest;
          if (t[rest]?.v === ',') { rest++; continue; }
          break;
        }
      }
      if (t[rest]?.v !== ')') throw new Error(`missing ) after ${tok.v}(`);
      return { value: fn(...args), rest: rest + 1 };
    }
    if (name in CONSTS) return { value: CONSTS[name], rest: i + 1 };
    throw new Error(`unknown name "${tok.v}"`);
  }
  throw new Error(`unexpected "${tok.v}"`);
}

// ---------- Unit + currency conversion ----------

// factor = how many BASE units one of this unit is. Temperature is handled separately.
const UNITS = {
  length: { base: 'm', u: { m: 1, meter: 1, meters: 1, km: 1000, kilometer: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, mile: 1609.344, miles: 1609.344, yd: 0.9144, yard: 0.9144, ft: 0.3048, foot: 0.3048, feet: 0.3048, in: 0.0254, inch: 0.0254, inches: 0.0254, nmi: 1852 } },
  mass: { base: 'kg', u: { kg: 1, kilogram: 1, g: 0.001, gram: 0.001, mg: 1e-6, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, oz: 0.0283495231, ounce: 0.0283495231, t: 1000, tonne: 1000, ton: 907.18474, st: 6.35029318, stone: 6.35029318 } },
  volume: { base: 'l', u: { l: 1, liter: 1, litre: 1, ml: 0.001, gal: 3.785411784, gallon: 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735296, m3: 1000 } },
  speed: { base: 'mps', u: { mps: 1, 'm/s': 1, kmh: 0.2777777778, 'km/h': 0.2777777778, kph: 0.2777777778, mph: 0.44704, knot: 0.5144444444, knots: 0.5144444444, kn: 0.5144444444 } },
  data: { base: 'b', u: { b: 1, byte: 1, bytes: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776, bit: 0.125, bits: 0.125 } },
  time: { base: 's', u: { s: 1, sec: 1, second: 1, seconds: 1, min: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600, day: 86400, days: 86400, week: 604800, weeks: 604800, year: 31557600, years: 31557600 } },
};
const TEMP = new Set(['c', 'celsius', 'f', 'fahrenheit', 'k', 'kelvin']);
const norm = (s) => String(s || '').trim().toLowerCase();   // plural aliases live in the tables

function findDim(unit) {
  const key = norm(unit);
  for (const [dim, spec] of Object.entries(UNITS)) if (key in spec.u) return { dim, spec, key };
  return null;
}
function toBaseTemp(v, u) { u = norm(u); if (u.startsWith('c')) return v; if (u.startsWith('f')) return (v - 32) * 5 / 9; return v - 273.15; }
function fromBaseTemp(c, u) { u = norm(u); if (u.startsWith('c')) return c; if (u.startsWith('f')) return c * 9 / 5 + 32; return c + 273.15; }

/** Convert a value between two units (length/mass/volume/speed/data/time/temperature)
 *  or between two 3-letter currency codes (live rates, no key). */
export async function convert(value, from, to, { signal } = {}) {
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error('value must be a number');
  const f = norm(from), t = norm(to);
  if (!f || !t) throw new Error('need both from and to units');

  if (TEMP.has(f) || TEMP.has(t)) {
    if (!(TEMP.has(f) && TEMP.has(t))) throw new Error('cannot convert temperature to a non-temperature unit');
    const out = fromBaseTemp(toBaseTemp(v, f), t);
    return { value: out, from: f, to: t, dim: 'temperature' };
  }

  const a = findDim(from), b = findDim(to);
  if (a && b) {
    if (a.dim !== b.dim) throw new Error(`incompatible units: ${from} is ${a.dim}, ${to} is ${b.dim}`);
    const out = v * a.spec.u[a.key] / b.spec.u[b.key];
    return { value: out, from: a.key, to: b.key, dim: a.dim };
  }

  // currency: both look like ISO codes → fetch live rates
  if (/^[a-z]{3}$/.test(f) && /^[a-z]{3}$/.test(t)) {
    const j = await getJSON(`https://open.er-api.com/v6/latest/${f.toUpperCase()}`, { signal });
    const rate = j?.rates?.[t.toUpperCase()];
    if (j?.result !== 'success' || !rate) throw new Error(`no exchange rate for ${f.toUpperCase()}→${t.toUpperCase()}`);
    return { value: v * rate, from: f.toUpperCase(), to: t.toUpperCase(), dim: 'currency', rate, asOf: j.time_last_update_utc || '' };
  }
  throw new Error(`unknown unit(s): "${from}" / "${to}". Supported: length, mass, volume, speed, data, time, temperature, and ISO currency codes.`);
}

// ---------- Date / time ----------

const fmtParts = (date, tz) => {
  const opt = { year: 'numeric', month: 'short', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  if (tz) opt.timeZone = tz;
  return new Intl.DateTimeFormat('en-GB', opt).format(date);
};

/** Current date/time (optionally in an IANA timezone) plus, when `until` is given,
 *  the time remaining to that date. All local — no network. */
export function datetime({ tz, until } = {}) {
  const now = new Date();
  const out = { now: now.toISOString() };
  try { out.local = fmtParts(now, tz || undefined); }
  catch { throw new Error(`unknown timezone "${tz}" — use an IANA name like "Asia/Tokyo" or "America/New_York".`); }
  if (tz) out.tz = tz;
  if (until) {
    const target = parseDate(until);
    if (!target) throw new Error(`could not read the date "${until}" — try YYYY-MM-DD or an ISO timestamp.`);
    const ms = target.getTime() - now.getTime();
    const past = ms < 0;
    const mins = Math.abs(ms) / 60000;
    const days = Math.floor(mins / 1440), hrs = Math.floor((mins % 1440) / 60), m = Math.round(mins % 60);
    out.until = { date: target.toISOString().slice(0, 10), days, hours: hrs, minutes: m, direction: past ? 'ago' : 'from now' };
  }
  return out;
}

function parseDate(s) {
  const str = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) { const d = new Date(str + 'T00:00:00'); return isNaN(d) ? null : d; }
  const d = new Date(str);
  return isNaN(d) ? null : d;
}
