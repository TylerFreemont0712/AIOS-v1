// Annotation / gig-work platform tracker: a seeded directory (Outlier, Alignerr,
// DataAnnotation, …) plus per-platform membership status, optional login cookie,
// and a best-effort availability check ("are there tasks right now?").
//
// Checking strategy: fetch the worker dashboard with the stored Cookie header —
// through Firecrawl when configured (these dashboards are JS-rendered), else a
// plain fetch — then classify with keyword heuristics + the AI classifier.
// Honest by design: results carry confidence + evidence, never a bare verdict.

import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig } from './config.js';
import { readJSON, writeJSON, now, id as genId } from './util.js';
import { fetchReadable } from './tools.js';
import { classifyAvailability } from './jobai.js';

const FILE = path.join(DATA, 'jobsearch', 'platforms.json');

// Seed directory — known data-annotation / gig platforms. `dash` is the page a
// logged-in worker sees; checks hit it with the stored cookie.
const SEED = [
  { id: 'outlier', name: 'Outlier', url: 'https://outlier.ai', dash: 'https://app.outlier.ai/expert/marketplace', desc: 'LLM training tasks (Scale AI) — writing, coding, evals', tags: ['llm', 'coding', 'writing'] },
  { id: 'alignerr', name: 'Alignerr', url: 'https://www.alignerr.com', dash: 'https://app.alignerr.com', desc: 'AI training & evaluation projects (Labelbox)', tags: ['llm', 'evals'] },
  { id: 'dataannotation', name: 'DataAnnotation', url: 'https://www.dataannotation.tech', dash: 'https://app.dataannotation.tech/workers/projects', desc: 'Chatbot training & coding tasks', tags: ['llm', 'coding'] },
  { id: 'prolific', name: 'Prolific', url: 'https://www.prolific.com', dash: 'https://app.prolific.com/studies', desc: 'Research studies & AI tasks', tags: ['studies'] },
  { id: 'crowdgen', name: 'CrowdGen (Appen)', url: 'https://crowdgen.com', dash: 'https://app.crowdgen.com', desc: 'Search eval, data collection, annotation projects', tags: ['search-eval', 'annotation'] },
  { id: 'clickworker', name: 'Clickworker', url: 'https://www.clickworker.com', dash: 'https://workplace.clickworker.com/en/job_offers', desc: 'Microtasks, UHRS access', tags: ['microtasks'] },
  { id: 'toloka', name: 'Toloka', url: 'https://toloka.ai', dash: 'https://platform.toloka.ai/tasks', desc: 'Annotation & AI tasks', tags: ['annotation'] },
  { id: 'telus', name: 'TELUS Digital AI', url: 'https://www.telusdigital.com/careers/ai-community', dash: 'https://aicommunity-jobs.telusdigital.com', desc: 'Search/ads rating, data collection (JP-friendly)', tags: ['rating', 'jp'] },
  { id: 'mercor', name: 'Mercor', url: 'https://mercor.com', dash: 'https://work.mercor.com/jobs', desc: 'Expert marketplace for AI training work', tags: ['llm', 'expert'] },
  { id: 'remotasks', name: 'Remotasks', url: 'https://www.remotasks.com', dash: 'https://www.remotasks.com/en/tasks', desc: 'Annotation microtasks (Scale AI)', tags: ['annotation'] },
  { id: 'surge', name: 'Surge AI', url: 'https://www.surgehq.ai', dash: 'https://app.surgehq.ai', desc: 'High-quality LLM data work (application-based)', tags: ['llm', 'writing'] },
];

// availability keyword heuristics (checked before burning a model call)
const HEUR = [
  { state: 'logged_out', rx: /(sign in|log in|ログイン|create (an )?account|forgot password|verify (it'?s )?you|captcha)/i },
  { state: 'no_tasks', rx: /(no (tasks|projects|studies|jobs) (are )?(currently )?available|nothing (is )?available right now|check back (later|soon)|empty queue|EQ|現在.*(タスク|案件).*(ありません|なし))/i },
  { state: 'tasks_available', rx: /(start (task|working)|available (tasks|projects|studies|jobs)|new project|begin assessment|継続する|開始する|タスクを開始)/i },
  { state: 'assessment_pending', rx: /(assessment|qualification|screening|onboarding).{0,40}(pending|in progress|review)/i },
  { state: 'waitlist', rx: /(waitlist|wait list|join the waiting|応募多数)/i },
];

function store() { return readJSON(FILE, { user: {}, custom: [] }); }
function saveStore(s) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); writeJSON(FILE, s); }

function defs() {
  const s = store();
  return [...SEED, ...(s.custom || [])];
}

/** Redacted list for the client. */
export function listPlatforms() {
  const s = store();
  return defs().map(d => {
    const u = s.user[d.id] || {};
    return {
      ...d,
      status: u.status || 'none',                 // none|applied|assessment|active|paused|rejected
      username: u.username || '',
      hasCookie: !!u.cookie,
      notes: u.notes || '',
      lastCheck: u.lastCheck || null,             // { at, state, evidence, confidence, via }
      custom: !SEED.some(x => x.id === d.id),
    };
  });
}

export function updatePlatform(id, patch = {}) {
  const d = defs().find(x => x.id === id);
  if (!d) throw Object.assign(new Error('unknown platform'), { status: 404 });
  const s = store();
  const u = s.user[id] || {};
  if (patch.status !== undefined) u.status = String(patch.status);
  if (patch.username !== undefined) u.username = String(patch.username);
  if (patch.notes !== undefined) u.notes = String(patch.notes);
  if (typeof patch.cookie === 'string' && patch.cookie !== '') u.cookie = patch.cookie.trim();
  if (patch.cookie === null) delete u.cookie;
  s.user[id] = u;
  saveStore(s);
  return listPlatforms().find(x => x.id === id);
}

export function addCustomPlatform({ name, url, dash, desc = '' }) {
  if (!name || !url) throw Object.assign(new Error('name and url are required'), { status: 400 });
  const s = store();
  const idStr = genId(6);
  s.custom = [...(s.custom || []), { id: idStr, name: String(name), url: String(url), dash: String(dash || url), desc: String(desc), tags: [] }];
  saveStore(s);
  return listPlatforms().find(x => x.id === idStr);
}

export function removeCustomPlatform(id) {
  const s = store();
  s.custom = (s.custom || []).filter(x => x.id !== id);
  delete s.user[id];
  saveStore(s);
}

// ---------- availability check ----------

async function fetchPage(url, cookie) {
  const cfg = loadConfig();
  const fc = cfg.jobsearch?.firecrawl || {};
  const base = (fc.url || '').replace(/\/$/, '');
  const headers = cookie ? { cookie } : {};
  // Prefer Firecrawl (renders the JS dashboards these platforms use)
  if (base || fc.apiKey) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 60000);
      try {
        const r = await fetch((fc.apiKey && !base ? 'https://api.firecrawl.dev' : base) + '/v1/scrape', {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', ...(fc.apiKey ? { authorization: `Bearer ${fc.apiKey}` } : {}) },
          body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: false, headers, waitFor: 3000 }),
        });
        if (r.ok) {
          const j = await r.json();
          const md = j?.data?.markdown || '';
          if (md.trim().length > 40) return { text: md, via: 'firecrawl' };
        }
      } finally { clearTimeout(t); }
    } catch { /* fall through to plain fetch */ }
  }
  const { text } = await fetchReadable(url, 400_000, { headers });
  return { text, via: 'fetch' };
}

export async function checkPlatform(id, { modelRef } = {}) {
  const d = defs().find(x => x.id === id);
  if (!d) throw Object.assign(new Error('unknown platform'), { status: 404 });
  const s = store();
  const u = s.user[id] || {};
  const url = u.cookie ? d.dash : d.url;    // no cookie → check the public page instead

  let result;
  try {
    const { text, via } = await fetchPage(url, u.cookie);
    if (text.trim().length < 40) {
      result = { state: 'unknown', evidence: 'page returned almost no text (likely JS-only — set up Firecrawl)', confidence: 'low', via };
    } else {
      const hit = HEUR.find(h => h.rx.test(text));
      if (hit && hit.state !== 'tasks_available') {
        // negative/blocked states are reliable from keywords alone
        result = { state: hit.state, evidence: (text.match(hit.rx)?.[0] || '').slice(0, 160), confidence: 'medium', via };
      } else {
        // use the model for the nuanced call when available; fall back to the heuristic
        try {
          result = { ...(await classifyAvailability(text, d.name, { modelRef })), via };
        } catch {
          result = hit
            ? { state: hit.state, evidence: (text.match(hit.rx)?.[0] || '').slice(0, 160), confidence: 'low', via }
            : { state: 'unknown', evidence: 'no clear signals on the page', confidence: 'low', via };
        }
      }
      if (!u.cookie && (result.state === 'logged_out' || result.state === 'unknown')) {
        result.evidence = 'no login cookie stored — checked the public page. ' + (result.evidence || '');
        if (result.state === 'logged_out') result.state = 'unknown';
      }
    }
  } catch (e) {
    result = { state: 'unknown', evidence: `check failed: ${e.message}`, confidence: 'low', via: 'error' };
  }

  u.lastCheck = { at: now(), url, ...result };
  s.user[id] = u;
  saveStore(s);
  return listPlatforms().find(x => x.id === id);
}

export async function checkAll({ modelRef } = {}) {
  const out = [];
  for (const d of defs()) out.push(await checkPlatform(d.id, { modelRef }));
  return out;
}
