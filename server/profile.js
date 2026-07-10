// The user's job-search profile: one structured document that everything else
// (fit-scoring, cover letters, questionnaire answers, form filling) draws from.
// Stored at data/jobsearch/profile.json. Import merges an AI-parsed resume into it.

import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { readJSON, writeJSON, now } from './util.js';

const DIR = path.join(DATA, 'jobsearch');
const FILE = path.join(DIR, 'profile.json');

export const emptyProfile = () => ({
  contact: { name: '', email: '', phone: '', location: '', links: {} },   // links: { linkedin, github, portfolio, ... }
  summary: '',
  skills: [],          // [{ name, years }] — years optional
  experience: [],      // [{ title, org, start, end, bullets: [] }]
  education: [],       // [{ school, degree, field, year }]
  projects: [],        // [{ name, description, url }]
  certifications: [],  // [string]
  languages: [],       // [{ lang, level }] — e.g. { lang: 'Japanese', level: 'JLPT N2' }
  workAuth: '',        // visa / work-authorization situation, critical for JP applications
  preferences: { roles: [], locations: [], remote: true, minPay: '', types: [] },
  // Standing answers for the questions every application asks. `custom` holds
  // any extra Q/A pairs the user teaches it.
  answers: {
    salaryExpectation: '', noticePeriod: '', earliestStart: '', relocation: '',
    remotePreference: '', reasonForLeaving: '', custom: [],   // [{ q, a }]
  },
  voice: { tone: 'professional, warm, concise' },
  updatedAt: null,
});

export function getProfile() {
  const saved = readJSON(FILE, null);
  if (!saved) return emptyProfile();
  // deep-ish merge so new fields appear for old saves; arrays are taken as-is
  const base = emptyProfile();
  const merged = { ...base, ...saved };
  merged.contact = { ...base.contact, ...(saved.contact || {}) };
  merged.contact.links = { ...(saved.contact?.links || {}) };
  merged.preferences = { ...base.preferences, ...(saved.preferences || {}) };
  merged.answers = { ...base.answers, ...(saved.answers || {}) };
  merged.voice = { ...base.voice, ...(saved.voice || {}) };
  return merged;
}

export function saveProfile(patch) {
  const cur = getProfile();
  const next = { ...cur, ...patch };
  // guard the containers so a partial patch can't null them out
  for (const k of ['contact', 'preferences', 'answers', 'voice']) if (patch[k]) next[k] = { ...cur[k], ...patch[k] };
  for (const k of ['skills', 'experience', 'education', 'projects', 'certifications', 'languages']) {
    if (patch[k] !== undefined && !Array.isArray(patch[k])) next[k] = cur[k];
  }
  next.updatedAt = now();
  fs.mkdirSync(DIR, { recursive: true });
  writeJSON(FILE, next);
  return next;
}

/** Merge an AI-parsed resume into the profile without clobbering user-set fields with blanks. */
export function mergeParsedResume(parsed) {
  const cur = getProfile();
  const keep = (a, b) => (b === undefined || b === null || b === '' || (Array.isArray(b) && !b.length)) ? a : b;
  const next = {
    ...cur,
    summary: keep(cur.summary, parsed.summary),
    skills: keep(cur.skills, parsed.skills),
    experience: keep(cur.experience, parsed.experience),
    education: keep(cur.education, parsed.education),
    projects: keep(cur.projects, parsed.projects),
    certifications: keep(cur.certifications, parsed.certifications),
    languages: keep(cur.languages, parsed.languages),
    workAuth: keep(cur.workAuth, parsed.workAuth),
    contact: {
      ...cur.contact,
      name: keep(cur.contact.name, parsed.contact?.name),
      email: keep(cur.contact.email, parsed.contact?.email),
      phone: keep(cur.contact.phone, parsed.contact?.phone),
      location: keep(cur.contact.location, parsed.contact?.location),
      links: { ...cur.contact.links, ...(parsed.contact?.links || {}) },
    },
  };
  return saveProfile(next);
}

/** How filled-in the profile is (drives the UI meter + nudges). */
export function completeness(p = getProfile()) {
  const checks = [
    ['name', !!p.contact.name], ['email', !!p.contact.email], ['location', !!p.contact.location],
    ['summary', p.summary.length > 30], ['skills', p.skills.length >= 3], ['experience', p.experience.length >= 1],
    ['education', p.education.length >= 1], ['languages', p.languages.length >= 1], ['work authorization', !!p.workAuth],
    ['salary expectation', !!p.answers.salaryExpectation], ['notice period', !!p.answers.noticePeriod],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([k]) => k);
  return { pct: Math.round(((checks.length - missing.length) / checks.length) * 100), missing };
}

/** Compact plain-text rendering for prompts (keeps token cost predictable). */
export function profileText(p = getProfile(), cap = 6000) {
  const L = [];
  const c = p.contact;
  L.push(`Name: ${c.name || '?'} · ${c.location || ''} · ${c.email || ''} ${c.phone || ''}`.trim());
  const links = Object.entries(c.links || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
  if (links) L.push('Links: ' + links);
  if (p.summary) L.push('Summary: ' + p.summary);
  if (p.skills.length) L.push('Skills: ' + p.skills.map(s => s.years ? `${s.name} (${s.years}y)` : s.name).join(', '));
  for (const e of p.experience) L.push(`Experience: ${e.title} @ ${e.org} (${e.start || '?'}–${e.end || 'present'})${e.bullets?.length ? '\n  - ' + e.bullets.join('\n  - ') : ''}`);
  for (const e of p.education) L.push(`Education: ${e.degree || ''} ${e.field || ''}, ${e.school} ${e.year || ''}`.trim());
  for (const pr of p.projects) L.push(`Project: ${pr.name} — ${pr.description || ''}`);
  if (p.certifications.length) L.push('Certifications: ' + p.certifications.join(', '));
  if (p.languages.length) L.push('Languages: ' + p.languages.map(l => `${l.lang} (${l.level})`).join(', '));
  if (p.workAuth) L.push('Work authorization: ' + p.workAuth);
  const pref = p.preferences;
  L.push(`Preferences: roles=${pref.roles.join('/') || 'any'}, locations=${pref.locations.join('/') || 'any'}, remote=${pref.remote}, minPay=${pref.minPay || 'n/a'}, types=${pref.types.join('/') || 'any'}`);
  const a = p.answers;
  const std = [['Salary expectation', a.salaryExpectation], ['Notice period', a.noticePeriod], ['Earliest start', a.earliestStart], ['Relocation', a.relocation], ['Remote preference', a.remotePreference], ['Reason for leaving', a.reasonForLeaving]]
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (std.length) L.push('Standing answers: ' + std.join(' | '));
  for (const qa of a.custom || []) L.push(`Q: ${qa.q}\nA: ${qa.a}`);
  const text = L.join('\n');
  return text.length > cap ? text.slice(0, cap) + '\n…' : text;
}
