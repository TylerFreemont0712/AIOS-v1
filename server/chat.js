// Plain chat sessions (no tools) — works with every provider, streams over WS.

import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig, contextBudget } from './config.js';
import { streamChat } from './llm.js';
import { id as genId, now, readJSON, writeJSON, clampMiddle } from './util.js';

const DIR = path.join(DATA, 'chats');
const live = new Map(); // chatId -> AbortController
const file = (id) => path.join(DIR, id + '.json');

let publish = () => { };
export const setPublisher = (fn) => { publish = fn; };
const emit = (cid, ev) => publish(`chat:${cid}`, { t: 'chat.event', chatId: cid, ev });

export function listChats() {
  fs.mkdirSync(DIR, { recursive: true });
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    const c = readJSON(path.join(DIR, f));
    return c && { id: c.id, title: c.title, modelRef: c.modelRef, updatedAt: c.updatedAt, messages: c.messages.length };
  }).filter(Boolean).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function createChat({ modelRef, system } = {}) {
  const cfg = loadConfig();
  const c = {
    id: genId(8), title: 'New chat',
    modelRef: modelRef || cfg.defaults.chatModel, system: system || '',
    createdAt: now(), updatedAt: now(), messages: [], usage: { input: 0, output: 0 },
  };
  writeJSON(file(c.id), c);
  return c;
}

export function getChat(id) {
  const c = readJSON(file(id));
  if (!c) throw Object.assign(new Error('chat not found'), { status: 404 });
  return c;
}

export function updateChat(id, patch) {
  const c = getChat(id);
  for (const k of ['title', 'modelRef', 'system']) if (patch[k] !== undefined) c[k] = patch[k];
  save(c);
  return c;
}

export function deleteChat(id) {
  stop(id);
  try { fs.unlinkSync(file(id)); } catch { }
}

export function stop(id) {
  live.get(id)?.abort();
  live.delete(id);
}

const save = (c) => { c.updatedAt = now(); writeJSON(file(c.id), c); };

export async function sendMessage(cid, text, { modelRef, attachments } = {}) {
  const c = getChat(cid);
  if (live.has(cid)) { emit(cid, { type: 'error', message: 'Already generating.' }); return; }
  if (modelRef) c.modelRef = modelRef;
  if (!c.modelRef) { emit(cid, { type: 'error', message: 'No model selected.' }); return; }

  const atts = Array.isArray(attachments) ? attachments : [];
  if (!text && !atts.length) return;   // nothing to send

  if (c.messages.length === 0) { const base = text || atts[0]?.name || 'New chat'; c.title = base.slice(0, 60) + (base.length > 60 ? '…' : ''); }
  const userMsg = { role: 'user', text, ts: now() };
  if (atts.length) userMsg.attachments = atts;
  c.messages.push(userMsg);
  save(c);
  emit(cid, { type: 'user', text, attachments: atts });

  const ctl = new AbortController();
  live.set(cid, ctl);
  const cfg = loadConfig();
  const system = c.system || `You are Claude inside AIOS, ${cfg.user.name}'s personal AI hub. Be direct, warm, and genuinely useful. Use markdown when it helps. Today is ${new Date().toDateString()}.`;

  try {
    // fit system + history inside the model's context window, reserving room for the reply
    const { maxTokens, inputChars } = contextBudget({ modelRef: c.modelRef, wantOutput: 8192 });
    const budget = Math.max(2000, inputChars - system.length);
    const msgs = [];
    let sz = 0;
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const src = c.messages[i];
      // clamp any single message so a huge paste can't overflow the window on its own
      const t = clampMiddle(src.text || '', budget);
      sz += t.length;
      if (sz > budget && msgs.length >= 2) break;
      const mm = { role: src.role, text: t };
      if (src.attachments?.length) mm.attachments = src.attachments;
      msgs.unshift(mm);
    }
    const res = await streamChat({
      modelRef: c.modelRef, system, messages: msgs,
      signal: ctl.signal, maxTokens,
      onEvent: (ev) => {
        if (ev.type === 'text') emit(cid, { type: 'delta', delta: ev.delta });
        else if (ev.type === 'reasoning') emit(cid, { type: 'reasoning', delta: ev.delta });
      },
    });
    c.usage.input += res.usage.input; c.usage.output += res.usage.output;
    const asst = { role: 'assistant', text: res.text, ts: now() };
    if (res.reasoning) asst.reasoning = res.reasoning;
    c.messages.push(asst);
    save(c);
    emit(cid, { type: 'done', text: res.text, reasoning: res.reasoning, usage: c.usage });
  } catch (e) {
    if (!ctl.signal.aborted) emit(cid, { type: 'error', message: e.message });
    else emit(cid, { type: 'done', text: '', cancelled: true });
  } finally {
    live.delete(cid);
  }
}
