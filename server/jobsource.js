// Pluggable job-search sources. Every connector takes {query, location, type} and
// returns { source, jobs: [<common job>], note } so the rest of the system is
// source-agnostic. Config `jobsearch.source` picks the active one; add a connector +
// a registry entry to support a new board later — nothing else needs to change.
//
// Common job shape (pre-tracking; the store assigns an id when saved):
//   { source, sourceId?, url, title, company, location, remote?, type, salary, snippet, postedAt }

import { loadConfig } from './config.js';
import { webSearch, fetchReadable } from './tools.js';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isIndeed = (u) => /(^|\.)indeed\.(com|jp)$|\.indeed\.com$/.test(hostOf(u)) || /(^|\/\/)(to|jp|[a-z]{2})\.indeed\./i.test(u);
// strip trailing " - Company - Location | Indeed.com" style noise from web titles
const cleanTitle = (t) => clean(t).replace(/\s*[|\-–]\s*(indeed\.com|indeed).*$/i, '').replace(/\s*\|\s*Indeed.*$/i, '');
const absUrl = (u, base) => { try { return new URL(u || '', base).href; } catch { return base || ''; } };

// A board's SEARCH/INDEX page ("1,143 Data Center jobs | Indeed.com"), not an
// individual posting. These carry no position info — they get expanded (scrape +
// AI-extract the postings on them) or demoted to a "Browse:" link, never shown as jobs.
const LISTING_URL = /indeed\.[a-z.]+\/(jobs|m\/jobs|q-[^/]*-jobs\.html|%E6%B1%82%E4%BA%BA|求人)|\/jobs\/search\b|[?&](q|search|keywords?)=/i;
const LISTING_TITLE = /\b\d[\d,.]*\+?\s[^|–-]{0,60}?\b(results?|jobs?|openings?|vacancies|positions?)\b|\d[\d,.]*\+?\s*件|\bjobs?,\s*employment\b|の求人|求人情報|求人・仕事/i;
export const isListingPage = (url, title) => LISTING_URL.test(String(url || '')) || LISTING_TITLE.test(String(title || ''));

// ---------- connectors ----------

const JOB_DOMAINS = /indeed|linkedin\.com\/jobs|glassdoor|tokyodev|japan-dev|wantedly|gaijinpot|daijob|careercross|doda|rikunabi|mynavi|en-japan|green-japan|weworkremotely|remoteok|remotive|wellfound|lever\.co|greenhouse\.io|workable|recruit/i;
const JUNK_DOMAINS = /wikipedia|weblio|dictionary|youtube|facebook|instagram|tiktok|quora|hatena|amazon\.|\bebay\b|pinterest/i;

/** Scrape one board search/index page and AI-extract the individual postings on it.
 *  Firecrawl when configured (renders JS, passes Cloudflare sometimes), plain
 *  readable fetch as fallback. Returns null when the page couldn't be read. */
async function expandListing(pageUrl, { query, location, type, modelRef }, cfg) {
  const fc = cfg.jobsearch.firecrawl || {};
  let md = '';
  if ((fc.url || '').trim() || fc.apiKey) md = await fcScrape(pageUrl, cfg, 35000);
  if (!md) {
    try {
      const { text } = await fetchReadable(pageUrl, 400_000);
      if (text.trim().length > 600 && !/Additional Verification Required|Cloudflare|Ray ID|verify (it'?s )?you are (a )?human/i.test(text.slice(0, 1500))) md = text;
    } catch { }
  }
  if (!md) return null;
  const { extractJobsFromMarkdown } = await import('./jobai.js');
  const found = await extractJobsFromMarkdown(md, { modelRef, source: hostOf(pageUrl), query });
  return found.map(x => ({
    source: isIndeed(pageUrl) ? 'indeed' : hostOf(pageUrl),
    url: absUrl(x.url && /^(https?:|\/)/.test(x.url) ? x.url : '', pageUrl),
    title: clean(x.title), company: clean(x.company), location: clean(x.location) || location || '',
    remote: /remote|リモート|在宅/i.test(`${x.title} ${x.location} ${x.snippet || ''}`),
    type: type || '', salary: clean(x.salary), snippet: clean(x.snippet), postedAt: '',
  }));
}

/** SearXNG (zero-setup, works today): job-biased web search with domain ranking.
 *  Board search/index pages found in the results ("N results | Indeed") are expanded
 *  into their individual positions instead of being shown as pills. */
async function searxngSource({ query, location, type, modelRef }, cfg) {
  const jp = cfg.jobsearch.country === 'jp';
  // two angles: a generic job-biased query + an Indeed-scoped one, merged
  const queries = [
    [query, location, jp ? '求人' : 'jobs'].filter(Boolean).join(' '),
    `site:${jp ? 'jp.indeed.com' : 'www.indeed.com'} ${query} ${location || ''}`.trim(),
  ];
  const all = [];
  let note = '';
  for (const q of queries) {
    try { const r = await webSearch(q, { n: 15 }); all.push(...r.results); }
    catch (e) { note = e.message; }
  }
  const ranked = all
    .map(r => {
      const host = hostOf(r.url);
      let rank = 0;
      if (JOB_DOMAINS.test(r.url)) rank += 2;
      if (isIndeed(r.url)) rank += 1;
      if (JUNK_DOMAINS.test(host)) rank -= 4;
      if (/求人|jobs?|hiring|career|recruit|採用/i.test(r.title)) rank += 1;
      return { rank, job: {
        source: isIndeed(r.url) ? 'indeed' : host,
        url: r.url, title: cleanTitle(r.title),
        company: '', location: location || '', remote: /remote|リモート/i.test(r.title + r.snippet),
        type: type || '', salary: '', snippet: clean(r.snippet), postedAt: '',
      } };
    })
    .filter(x => x.rank >= 0)
    .sort((a, b) => b.rank - a.rank)
    .map(x => x.job);

  const postings = [], listings = [];
  for (const j of ranked) (isListingPage(j.url, j.title) ? listings : postings).push(j);

  // Expand up to 2 index pages (one per host, Indeed first) into real positions.
  const extracted = [];
  const notes = [];
  const expanded = new Set();
  if (listings.length) {
    const targets = [];
    const seenHost = new Set();
    for (const l of [...listings].sort((a, b) => (b.source === 'indeed') - (a.source === 'indeed'))) {
      const h = hostOf(l.url);
      if (seenHost.has(h)) continue;
      seenHost.add(h); targets.push(l);
      if (targets.length >= 2) break;
    }
    for (const l of targets) {
      try {
        const found = await expandListing(l.url, { query, location, type, modelRef }, cfg);
        if (found === null) notes.push(`${hostOf(l.url)} blocked the scrape${isIndeed(l.url) ? ' (Cloudflare — a SerpApi key in Settings → Job Search gets reliable Indeed)' : ''}.`);
        else if (found.length) { extracted.push(...found); expanded.add(l.url); notes.push(`opened the ${hostOf(l.url)} results page → ${found.length} positions`); }
        if (extracted.length >= 8) break; // enough real positions — skip the second scrape+extract
      } catch (e) {
        notes.push(/no model/i.test(e.message)
          ? 'Pick a model in the Job Search header to expand board result pages into individual positions.'
          : `${hostOf(l.url)}: ${e.message}`);
        break; // a model problem will repeat on the next page — stop
      }
    }
  }
  // Index pages that weren't expanded stay as explicit browse links at the bottom (max 2).
  const browse = listings.filter(l => !expanded.has(l.url)).slice(0, 2)
    .map(l => ({ ...l, title: `Browse: ${l.title}` }));

  const jobs = [...extracted, ...postings, ...browse];
  return {
    source: 'searxng',
    jobs,
    note: notes.join(' ')
      || (jobs.length
        ? 'Web results via SearXNG (broad). Switch the source to Firecrawl or add a job-API key for structured listings.'
        : (note || `No results for "${query}". Try broader keywords.`)),
  };
}

/** One Firecrawl markdown scrape. Returns '' on failure or anti-bot pages. */
async function fcScrape(url, cfg, timeoutMs = 60000) {
  const fc = cfg.jobsearch.firecrawl || {};
  const base = (fc.url || '').replace(/\/$/, '');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch((fc.apiKey && !base ? 'https://api.firecrawl.dev' : base) + '/v1/scrape', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', ...(fc.apiKey ? { authorization: `Bearer ${fc.apiKey}` } : {}) },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: false, waitFor: 3000, timeout: Math.min(timeoutMs - 5000, 55000) }),
    });
    if (!r.ok) return '';
    const md = (await r.json())?.data?.markdown || '';
    if (md.length < 600 || /Additional Verification Required|Cloudflare|Ray ID|verify (it'?s )?you are (a )?human/i.test(md.slice(0, 1500))) return '';
    return md;
  } catch { return ''; } finally { clearTimeout(t); }
}

/** Firecrawl: scrape job boards (Indeed attempt + scrape-friendly boards for the
 *  region) and extract structured jobs with AIOS's own model. Needs a Firecrawl
 *  instance (`npm run firecrawl`) and a model. */
async function firecrawlSource({ query, location, type, modelRef }, cfg) {
  const fc = cfg.jobsearch.firecrawl || {};
  if (!(fc.url || '').trim() && !fc.apiKey) throw new Error('Firecrawl is not configured — run `npm run firecrawl`, then set the URL in Settings → Job Search.');
  const { extractJobsFromMarkdown } = await import('./jobai.js');
  const jp = cfg.jobsearch.country === 'jp';
  const enc = encodeURIComponent;
  // Indeed first (works when Cloudflare allows), then boards that reliably scrape.
  const targets = jp ? [
    { name: 'indeed', url: `https://jp.indeed.com/jobs?q=${enc(query)}&l=${enc(location || '')}` },
    { name: 'tokyodev', url: 'https://www.tokyodev.com/jobs' },
    { name: 'japan-dev', url: `https://japan-dev.com/jobs?search=${enc(query)}` },
  ] : [
    { name: 'indeed', url: `https://www.indeed.com/jobs?q=${enc(query)}&l=${enc(location || '')}` },
    { name: 'remoteok', url: `https://remoteok.com/remote-${enc(query.replace(/\s+/g, '-'))}-jobs` },
    { name: 'weworkremotely', url: `https://weworkremotely.com/remote-jobs/search?term=${enc(query)}` },
  ];

  const jobs = [];
  const blocked = [];
  for (const tg of targets) {
    const md = await fcScrape(tg.url, cfg);
    if (!md) { blocked.push(tg.name); continue; }
    try {
      const found = await extractJobsFromMarkdown(md, { modelRef, source: tg.name, query });
      for (const x of found) jobs.push({
        source: tg.name, url: absUrl(x.url && /^(https?:|\/)/.test(x.url) ? x.url : '', tg.url),
        title: clean(x.title), company: clean(x.company), location: clean(x.location) || location || '',
        remote: /remote|リモート/i.test(`${x.title} ${x.location} ${x.snippet || ''}`), type: type || '',
        salary: clean(x.salary), snippet: clean(x.snippet), postedAt: '',
      });
    } catch { blocked.push(tg.name + ' (extract failed)'); }
  }
  const notes = [];
  if (blocked.includes('indeed')) notes.push('Indeed blocked the scrape (Cloudflare) — a SerpApi key in Settings → Job Search gets reliable Indeed results.');
  else if (blocked.length) notes.push(`Some boards did not respond: ${blocked.join(', ')}.`);
  return { source: 'firecrawl', jobs, note: notes.join(' ') || (jobs.length ? '' : `No jobs extracted for "${query}".`) };
}

/** SerpApi Google Jobs (aggregates Indeed.jp + more) — most reliable, needs a key. */
async function jobapiSource({ query, location, type }, cfg) {
  const api = cfg.jobsearch.jobapi || {};
  if (!api.apiKey) throw new Error('No job-API key set — add a SerpApi key in Settings → Job Search.');
  const u = new URL('https://serpapi.com/search.json');
  u.searchParams.set('engine', 'google_jobs');
  u.searchParams.set('q', [query, location].filter(Boolean).join(' '));
  u.searchParams.set('hl', cfg.jobsearch.country === 'jp' ? 'ja' : 'en');
  u.searchParams.set('gl', cfg.jobsearch.country || 'us');
  u.searchParams.set('api_key', api.apiKey);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(u, { signal: ctl.signal });
    if (!r.ok) throw new Error(`SerpApi ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const jobs = (j.jobs_results || []).map(x => {
      const link = x.apply_options?.[0]?.link || x.related_links?.[0]?.link || x.share_link || '';
      return {
        source: (x.via || '').replace(/^via\s+/i, '') || 'google-jobs', url: link,
        title: clean(x.title), company: clean(x.company_name), location: clean(x.location) || location || '',
        remote: !!x.detected_extensions?.work_from_home, type: clean(x.detected_extensions?.schedule_type) || type || '',
        salary: clean(x.detected_extensions?.salary), snippet: clean(x.description).slice(0, 400),
        postedAt: clean(x.detected_extensions?.posted_at),
      };
    });
    return { source: 'jobapi', jobs, note: jobs.length ? '' : `No results for "${query}".` };
  } finally { clearTimeout(t); }
}

const CONNECTORS = { searxng: searxngSource, firecrawl: firecrawlSource, jobapi: jobapiSource };

// ---------- public API ----------

export async function searchJobs({ query, location = '', type = '', modelRef = '' }) {
  const cfg = loadConfig();
  query = clean(query);
  if (!query) throw Object.assign(new Error('search query is empty'), { status: 400 });
  const pick = CONNECTORS[cfg.jobsearch.source] ? cfg.jobsearch.source : 'searxng';
  const res = await CONNECTORS[pick]({ query, location, type, modelRef }, cfg);
  // de-dupe by normalized url/title
  const seen = new Set();
  res.jobs = res.jobs.filter(j => {
    const k = (j.url || '').replace(/[#?].*$/, '') + '|' + j.title.toLowerCase();
    if (seen.has(k) || (!j.url && !j.title)) return false;
    seen.add(k); return true;
  });
  return { active: pick, ...res };
}

/** Source availability for the Settings panel / services registry. */
export async function jobSourceStatus() {
  const cfg = loadConfig();
  const j = cfg.jobsearch;
  const out = { active: j.source, searxng: !!cfg.tools?.searxng?.url, firecrawl: false, jobapi: !!j.jobapi?.apiKey };
  const base = (j.firecrawl?.url || '').replace(/\/$/, '');
  if (base) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
      // self-hosted Firecrawl answers GET /test; any sub-500 response means it's up
      const r = await fetch(base + '/test', { signal: ctl.signal }).catch(() => fetch(base, { signal: ctl.signal }));
      out.firecrawl = !!r && r.status < 500; clearTimeout(t);
    } catch { }
  } else out.firecrawl = !!j.firecrawl?.apiKey;
  return out;
}
