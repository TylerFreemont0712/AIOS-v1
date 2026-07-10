// Tracked jobs / applications store + pipeline. One JSON file per job in data/jobs/,
// mirroring the chat/research stores. Status drives the tracking board; the timeline
// records every change (and later, matched emails).

import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { id as genId, now, readJSON, writeJSON } from './util.js';

const DIR = path.join(DATA, 'jobs');
const file = (id) => path.join(DIR, id + '.json');

// Board columns (in order) + closed side-states.
export const STAGES = ['saved', 'applied', 'screening', 'interview', 'offer', 'accepted'];
export const CLOSED = ['rejected', 'ghosted', 'withdrawn'];
export const STATUSES = [...STAGES, ...CLOSED];

const summary = (j) => ({
  id: j.id, title: j.title, company: j.company, location: j.location, source: j.source, url: j.url,
  status: j.status, flags: j.flags, salary: j.salary, remote: j.remote, type: j.type,
  snippet: j.snippet, appliedAt: j.appliedAt, createdAt: j.createdAt, updatedAt: j.updatedAt,
});

export function listJobs() {
  fs.mkdirSync(DIR, { recursive: true });
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json'))
    .map(f => readJSON(path.join(DIR, f))).filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map(summary);
}

export function getJob(id) {
  const j = readJSON(file(id));
  if (!j) throw Object.assign(new Error('job not found'), { status: 404 });
  return j;
}

/** Find a tracked job by posting URL (so we don't double-track the same posting). */
export function findByUrl(url) {
  if (!url) return null;
  const key = String(url).replace(/[#?].*$/, '');
  for (const f of (fs.existsSync(DIR) ? fs.readdirSync(DIR) : [])) {
    const j = readJSON(path.join(DIR, f));
    if (j && String(j.url || '').replace(/[#?].*$/, '') === key) return j;
  }
  return null;
}

export function addJob(data = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  if (!data.title && !data.url) throw Object.assign(new Error('a job needs at least a title or url'), { status: 400 });
  const existing = findByUrl(data.url);
  if (existing) return existing;                       // already tracked → no duplicate
  const status = STATUSES.includes(data.status) ? data.status : 'saved';
  const j = {
    id: genId(8),
    source: data.source || 'manual', sourceId: data.sourceId || '',
    url: data.url || '', title: data.title || '(untitled)', company: data.company || '',
    location: data.location || '', remote: !!data.remote, type: data.type || '',
    salary: data.salary || '', snippet: data.snippet || '', postedAt: data.postedAt || '',
    status, flags: { needsReply: false, actionRequired: false },
    notes: data.notes || '', coverLetter: '', fit: null,
    emails: [], followUps: [],
    timeline: [{ at: now(), kind: 'added', text: `Tracked (${status})` }],
    createdAt: now(), updatedAt: now(), appliedAt: status === 'applied' ? now() : null,
  };
  save(j);
  return j;
}

export function updateJob(id, patch = {}) {
  const j = getJob(id);
  if (patch.status && STATUSES.includes(patch.status) && patch.status !== j.status) {
    j.timeline.push({ at: now(), kind: 'status', text: `${j.status} → ${patch.status}` });
    j.status = patch.status;
    if (patch.status === 'applied' && !j.appliedAt) j.appliedAt = now();
  }
  for (const k of ['notes', 'coverLetter', 'company', 'location', 'salary', 'title']) if (patch[k] !== undefined) j[k] = patch[k];
  if (patch.flags && typeof patch.flags === 'object') j.flags = { ...j.flags, ...patch.flags };
  if (patch.fit !== undefined) j.fit = patch.fit;
  if (patch.timelineAdd) j.timeline.push({ at: now(), kind: patch.timelineAdd.kind || 'note', text: String(patch.timelineAdd.text || '') });
  save(j);
  return j;
}

export function deleteJob(id) { try { fs.unlinkSync(file(id)); } catch { } }

export function stats() {
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  let total = 0, needsReply = 0;
  for (const j of listJobs()) { counts[j.status] = (counts[j.status] || 0) + 1; total++; if (j.flags?.needsReply) needsReply++; }
  const applied = counts.applied + counts.screening + counts.interview + counts.offer + counts.accepted + counts.rejected + counts.ghosted;
  return { total, counts, applied, needsReply };
}

const save = (j) => { j.updatedAt = now(); fs.mkdirSync(DIR, { recursive: true }); writeJSON(file(j.id), j); };
