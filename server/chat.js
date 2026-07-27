// Chat sessions — streams over WS, works with every provider. Chat can also call a
// curated set of READ-ONLY tools (web search/read, vault, mail, planner, learning) so
// it can answer time-sensitive questions ("what's the news on X?") instead of guessing.
// No project root and no approval gate, so write/filesystem tools stay Agent-only.

import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig, contextBudget, DEFAULT_CHAT_SYSTEM } from './config.js';
import { streamChat } from './llm.js';
import { chatToolSchemas, runTool, isWriteTool, isChatSafeWrite } from './tools.js';
import { profileInjection, recordTurn } from './profile.js';
import { id as genId, now, readJSON, writeJSON, clampMiddle, jsonDirIndex } from './util.js';

const DIR = path.join(DATA, 'chats');
const live = new Map(); // chatId -> AbortController
const file = (id) => path.join(DIR, id + '.json');

let publish = () => { };
export const setPublisher = (fn) => { publish = fn; };
const emit = (cid, ev) => publish(`chat:${cid}`, { t: 'chat.event', chatId: cid, ev });

const MAX_TOOL_ROUNDS = 5;   // safety cap on tool-call iterations per user message

const chatIndex = jsonDirIndex(DIR, (c) => ({
  id: c.id, title: c.title, modelRef: c.modelRef, tools: c.tools !== false,
  folder: c.folder || '', updatedAt: c.updatedAt, messages: c.messages.length,
}));

export function listChats() {
  fs.mkdirSync(DIR, { recursive: true });
  return chatIndex().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function createChat({ modelRef, system, tools, folder } = {}) {
  const cfg = loadConfig();
  const c = {
    id: genId(8), title: 'New chat',
    modelRef: modelRef || cfg.defaults.chatModel, system: system || '',
    tools: tools !== undefined ? !!tools : cfg.defaults.chatTools !== false,
    folder: typeof folder === 'string' ? folder : '',
    createdAt: now(), updatedAt: now(), messages: [], usage: { input: 0, output: 0 },
  };
  writeJSON(file(c.id), c);
  return c;
}

/** Delete several chats at once (multi-select / delete a whole folder). */
export function bulkDelete(ids) {
  let n = 0;
  for (const id of Array.isArray(ids) ? ids : []) { try { deleteChat(id); n++; } catch { } }
  return { deleted: n };
}

/** Move several chats into a folder ('' = ungrouped). Also renames a folder when the
 *  caller passes every chat currently in the old folder. */
export function moveChats(ids, folder) {
  const f = String(folder || '').trim();
  let n = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    try { const c = getChat(id); c.folder = f; save(c); n++; } catch { }
  }
  return { moved: n, folder: f };
}

export function getChat(id) {
  const c = readJSON(file(id));
  if (!c) throw Object.assign(new Error('chat not found'), { status: 404 });
  return c;
}

export function updateChat(id, patch) {
  const c = getChat(id);
  for (const k of ['title', 'modelRef', 'system', 'folder']) if (patch[k] !== undefined) c[k] = patch[k];
  if (patch.tools !== undefined) c.tools = !!patch.tools;
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

// Compact, not pretty: this runs on every turn and the file is the whole transcript.
const save = (c) => { c.updatedAt = now(); writeJSON(file(c.id), c, { pretty: false }); };

/** A short directive that makes small models actually reach for tools instead of
 *  declining ("I can't access the internet") — tailored to what's actually available. */
function toolNudge(toolDefs) {
  const has = new Set(toolDefs.map(t => t.name));
  const lines = ['You have live tools. USE them instead of guessing or refusing — call one whenever it would make your answer more current or accurate, then answer from the results and mention sources briefly. For casual conversation, just reply normally.'];
  if (has.has('web_search')) lines.push('- web_search: for ANYTHING current, time-sensitive, or factual you are not certain of — news, events, "what happened", specific dates, prices, releases, people, sports, documentation. Do NOT answer such questions from memory (your knowledge is stale and may be wrong); search FIRST, then answer. NEVER say you cannot access the internet — you can, so search.');
  if (has.has('fetch_url')) lines.push('- fetch_url: read a specific page or article (a link the user gives you, or a result you found).');
  if (has.has('crawl_site')) lines.push('- crawl_site: read SEVERAL pages of a website at once (follows its links). Use when one page is not enough — docs, a company/product site, "read this site and tell me…".');
  if (has.has('wikipedia')) lines.push('- wikipedia: quick, reliable summaries of encyclopedic topics (people, places, science, history).');
  if (has.has('directions')) lines.push('- directions / find_places / weather: real-world local questions — travel time & distance (origin defaults to home), nearby places (stations, shops), and the forecast for any place.');
  if (has.has('translate')) lines.push('- translate / calculate / convert / datetime: translate text, do exact arithmetic, convert units & currencies, and compute times/countdowns — do NOT do this math or these conversions in your head, use the tool.');
  if (has.has('vault_search')) lines.push("- vault_search / vault_read / wiki_recall: consult the user's Obsidian notes and knowledge base.");
  if (has.has('quick_note')) lines.push('- quick_note / daily_log: save a note or log the day to the vault when the user says "note this", "save this", "remember that". quick_note never overwrites — it appends.');
  if (has.has('agenda_view')) lines.push("- agenda_view: the user's planner (events, tasks) for date/schedule questions.");
  if (has.has('task_add')) lines.push('- task_add / event_add: add a to-do or calendar event when the user asks you to remember/schedule something.');
  if (has.has('mail_recent')) lines.push("- mail_recent / mail_search / mail_read: the user's inbox (read-only).");
  return lines.join('\n');
}

// Heuristic: does the latest message look like it needs current/real-world info? When it
// does and web_search is available, we add a firm per-turn instruction so reluctant models
// search instead of answering from stale memory (the "4th of July events" problem).
const TIME_RX = /\b(news|today|tonight|yesterday|tomorrow|latest|recent|recently|current|currently|right now|this (week|month|year|morning|afternoon)|what('s| is| are| happened| happening)|who (won|is winning|is)|score|weather|price|stock|release[ds]?|update[ds]?|as of|202\d|version|newest|breaking)\b/i;
const looksTimeSensitive = (text) => TIME_RX.test(String(text || ''));

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
  // Effective system prompt = shared base (Settings → Chat) + this chat's own instructions
  // + what the AI has learned about the user + live app context + the tool nudge.
  const base = (cfg.defaults.chatSystem || DEFAULT_CHAT_SYSTEM)
    .replace(/\{name\}/g, cfg.user?.name || 'the user')
    .replace(/\{date\}/g, new Date().toDateString());
  let system = base;
  if (c.system?.trim()) system += '\n\n[Instructions for this chat]\n' + c.system.trim();
  try { const prof = profileInjection(); if (prof) system += '\n\n' + prof; } catch { }
  // app-wide awareness: planner/mail/weather brief so day-to-day questions
  // ("what's going on tomorrow?") answer from real data, on every provider
  if (cfg.defaults.appContext !== false) {
    try {
      const { appContext } = await import('./context.js');
      const ctx = appContext({ chars: 1900 });
      if (ctx) system += '\n\n' + ctx;
    } catch { }
  }

  // Read-only tool belt (unless disabled for this chat). The nudge is what actually
  // gets small models to use it instead of declining.
  const useTools = c.tools !== false;
  const toolDefs = useTools ? chatToolSchemas() : [];
  if (toolDefs.length) {
    system += '\n\n' + toolNudge(toolDefs);
    // Reluctant models answer time-sensitive questions from stale memory — push harder.
    if (toolDefs.some(t => t.name === 'web_search') && looksTimeSensitive(text)) {
      system += '\n\n[This message looks time-sensitive. Call web_search BEFORE answering it — do not rely on memory.]';
    }
  }
  const toolNames = new Set(toolDefs.map(t => t.name));

  try {
    // fit system + history inside the model's context window, reserving room for the reply
    const { maxTokens, inputChars } = contextBudget({ modelRef: c.modelRef, wantOutput: 8192 });
    const budget = Math.max(2000, inputChars - system.length - JSON.stringify(toolDefs).length);
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

    const usedTools = [];
    let res;
    for (let round = 0; ; round++) {
      const lastRound = round >= MAX_TOOL_ROUNDS;
      res = await streamChat({
        modelRef: c.modelRef, system, messages: msgs, tools: lastRound ? [] : toolDefs,
        signal: ctl.signal, maxTokens,
        onEvent: (ev) => {
          if (ev.type === 'text') emit(cid, { type: 'delta', delta: ev.delta });
          else if (ev.type === 'reasoning') emit(cid, { type: 'reasoning', delta: ev.delta });
        },
      });
      c.usage.input += res.usage.input; c.usage.output += res.usage.output;
      if (!res.toolCalls?.length) break;   // model is done → res.text is the answer

      // record the assistant's tool-call turn, run each read-only tool, feed results back
      msgs.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls });
      const results = [];
      for (const call of res.toolCalls) {
        if (ctl.signal.aborted) { results.push({ id: call.id, name: call.name, content: 'Cancelled.', isError: true }); continue; }
        if (!toolNames.has(call.name) || (isWriteTool(call.name) && !isChatSafeWrite(call.name))) {
          results.push({ id: call.id, name: call.name, content: `Tool "${call.name}" is not available in chat (read-only + note/planner tools only — use the Agent for anything that edits files).`, isError: true });
          continue;
        }
        emit(cid, { type: 'tool.start', callId: call.id, name: call.name, args: call.args });
        const r = await runTool(call.name, call.args, { signal: ctl.signal, modelRef: c.modelRef });
        emit(cid, { type: 'tool.end', callId: call.id, name: call.name, ok: !r.isError, content: r.content.slice(0, 4000) });
        results.push({ id: call.id, name: call.name, content: r.content, isError: r.isError });
        if (!r.isError && !usedTools.includes(call.name)) usedTools.push(call.name);
      }
      msgs.push({ role: 'tools', results });
      if (ctl.signal.aborted) break;
    }

    const asst = { role: 'assistant', text: res.text, ts: now(), perf: res.perf };
    if (res.reasoning) asst.reasoning = res.reasoning;
    if (usedTools.length) asst.tools = usedTools;
    c.messages.push(asst);
    save(c);
    emit(cid, { type: 'done', text: res.text, reasoning: res.reasoning, tools: usedTools, usage: c.usage, perf: res.perf });
    // Let the AI learn the user's style from their messages (throttled, background).
    if (!ctl.signal.aborted) {
      const userMsgs = c.messages.filter(m => m.role === 'user').slice(-14).map(m => m.text);
      recordTurn({ userMessages: userMsgs, modelRef: c.modelRef }).catch(() => { });
    }
  } catch (e) {
    if (!ctl.signal.aborted) emit(cid, { type: 'error', message: e.message });
    else emit(cid, { type: 'done', text: '', cancelled: true });
  } finally {
    live.delete(cid);
  }
}
