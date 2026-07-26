// User personality profile — the AI's evolving notes on how the user communicates
// (tone, directness, interests, stable preferences and facts), learned from their chat
// inputs. Canonical copy lives in data/profile/user.json and is mirrored to a vault note
// (Second Brain) so it's visible and hand-editable; a condensed version is injected into
// chat/agent system prompts so the assistant adapts to the user. Auto-maintained, throttled.

import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig } from './config.js';
import { streamChat } from './llm.js';
import { now, readJSON, writeJSON } from './util.js';
import * as vault from './vault.js';

const FILE = path.join(DATA, 'profile', 'user.json');
let learning = false;   // guard against overlapping background learns

function load() {
  return readJSON(FILE) || { text: '', updatedAt: '', seen: 0, learnedSeen: 0 };
}
function persist(p) { writeJSON(FILE, p); }

/** Vault note path for the profile (relative to the vault root). */
function notePath() {
  const raw = (loadConfig().profile?.notePath || 'About Me.md').trim() || 'About Me.md';
  return /\.md$/i.test(raw) ? raw : raw + '.md';
}
function vaultConnected() { try { return !!loadConfig().vault?.path; } catch { return false; } }

export function getProfile() {
  const cfg = loadConfig();
  const p = load();
  return { text: p.text || '', updatedAt: p.updatedAt || '', seen: p.seen || 0, enabled: cfg.profile?.enabled !== false, notePath: notePath() };
}

/** The current profile text — prefers a hand-edited vault note when one exists, so the
 *  user's edits in the Second Brain are always the source of truth. */
function currentText() {
  if (vaultConnected()) {
    try { const n = vault.readNote(notePath()); if (n?.content?.trim()) return n.content; } catch { }
  }
  return load().text || '';
}

/** Set the profile text explicitly (manual edit or after a learn). Mirrors to the vault. */
export function setProfile(text) {
  const p = load();
  p.text = String(text || '').trim();
  p.updatedAt = now();
  persist(p);
  if (vaultConnected()) { try { vault.writeNote(notePath(), p.text ? p.text + '\n' : ''); } catch { } }
  return getProfile();
}

/** Condensed injection for a system prompt — empty until there's real content. */
export function profileInjection(cap = 700) {
  const cfg = loadConfig();
  if (cfg.profile?.enabled === false || cfg.profile?.inject === false) return '';
  let text = currentText().trim();
  if (text.length < 40) return '';                 // nothing meaningful learned yet
  if (text.length > cap) text = text.slice(0, cap).replace(/\s+\S*$/, '') + '…';
  const name = cfg.user?.name || 'the user';
  return `About ${name} — learned from past conversations; adapt your tone and approach to fit them (they can edit this):\n${text}`;
}

const SEED_HEADING = (name) => `# About ${name}`;

/** Count a completed turn; when enough new messages have accrued, learn in the background.
 *  Call fire-and-forget from the chat/agent loop — never blocks the reply. */
export async function recordTurn({ userMessages = [], modelRef } = {}) {
  const cfg = loadConfig();
  if (cfg.profile?.enabled === false) return;
  const p = load();
  p.seen = (p.seen || 0) + 1;
  persist(p);
  const everyN = Math.max(2, Number(cfg.profile?.everyN) || 6);
  if ((p.seen - (p.learnedSeen || 0)) < everyN) return;
  await learnNow({ userMessages, modelRef }).catch(() => { });
}

/** Update the profile now from the given user messages. Merges with the existing profile;
 *  never invents; keeps it concise. Returns the new profile (or the old one on failure). */
export async function learnNow({ userMessages = [], modelRef } = {}) {
  const cfg = loadConfig();
  const ref = modelRef || cfg.defaults?.chatModel;
  const sample = userMessages.map(s => String(s || '').trim()).filter(Boolean).slice(-14).join('\n---\n').slice(0, 6000);
  if (!ref || sample.length < 20 || learning) return getProfile();
  learning = true;
  try {
    const name = cfg.user?.name || 'the user';
    const existing = currentText().trim() || SEED_HEADING(name);
    const res = await streamChat({
      modelRef: ref, maxTokens: 1200,
      system: `You maintain a concise living profile of ${name}, to help an AI assistant adapt to them. Study how they write and update the profile.
Rules:
- MERGE with the existing profile: keep still-valid points, refine them, add what's new. Do not drop good information.
- Capture STABLE traits only: communication style (tone, directness, verbosity, formality, humor), recurring interests/domains, preferences for how they like answers, and durable facts they state about themselves. Ignore one-off task details.
- Never invent or assume beyond the evidence. If little is shown, keep the profile small.
- Output ONLY the updated profile as markdown, starting with "${SEED_HEADING(name)}", with short bulleted sections (e.g. Communication style, Interests, Preferences, Facts). Keep it under ~1400 characters. No preamble, no commentary.`,
      messages: [{ role: 'user', text: `EXISTING PROFILE:\n${existing}\n\nRECENT MESSAGES FROM ${name}:\n${sample}\n\nReturn the updated profile.` }],
    });
    let text = (res.text || '').trim().replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
    if (!text || !/#\s*About/i.test(text.slice(0, 40))) { return getProfile(); }   // reject junk output
    const p = load();
    p.text = text; p.updatedAt = now(); p.learnedSeen = p.seen || 0;
    persist(p);
    if (vaultConnected()) { try { vault.writeNote(notePath(), text + '\n'); } catch { } }
    return getProfile();
  } finally { learning = false; }
}
