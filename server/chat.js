// Chat sessions — streams over WS, works with every provider. Chat can also call a
// curated set of READ-ONLY tools (web search/read, vault, mail, planner, learning) so
// it can answer time-sensitive questions ("what's the news on X?") instead of guessing.
// No project root and no approval gate, so write/filesystem tools stay Agent-only.

import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig, contextBudget, DEFAULT_CHAT_SYSTEM } from './config.js';
import { streamChat } from './llm.js';
import { chatTools, chatCoreNames, leanLoadout, activateGroups, META_LOAD, runTool, isWriteTool, isChatSafeWrite } from './tools.js';
import { profileInjection, recordTurn } from './profile.js';
import { id as genId, now, readJSON, writeJSON, clampMiddle, jsonDirIndex } from './util.js';
import * as actions from './actions.js';

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

export function createChat({ modelRef, system, tools, folder, title, context } = {}) {
  const cfg = loadConfig();
  const c = {
    id: genId(8), title: String(title || '').trim() || 'New chat',
    modelRef: modelRef || cfg.defaults.chatModel, system: system || '',
    tools: tools !== undefined ? !!tools : cfg.defaults.chatTools !== false,
    // context: whether this chat gets the ambient injections — what the AI has learned
    // about the user, plus the planner/mail/weather brief. On for anything meant to
    // answer real questions; off for a chat that is a ROLE (see server/interview.js),
    // where a model that knows about tomorrow's dentist appointment will use it.
    context: context !== false,
    folder: typeof folder === 'string' ? folder : '',
    createdAt: now(), updatedAt: now(), messages: [], usage: { input: 0, output: 0 },
    // tool groups the model activated with load_tools; they stay active for this chat
    toolGroups: [],
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
  if (patch.context !== undefined) c.context = !!patch.context;
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

// ---------------------------------------------------------------- proposals
//
// A staged write lives on the assistant message that proposed it, which is what makes
// the card survive a reload and stops a "confirm" arriving twice from doing the thing
// twice: the status is stored next to the action, not held in a server-side map that
// a restart would lose.

function findProposal(cid, pid) {
  const c = getChat(cid);
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const list = c.messages[i].proposals;
    if (!Array.isArray(list)) continue;
    const idx = list.findIndex(p => p.id === pid);
    if (idx >= 0) return { chat: c, msg: c.messages[i], list, idx };
  }
  throw Object.assign(new Error('that action is no longer available'), { status: 404 });
}

/** Update the staged fields without doing it — the card's Edit mode. */
export function editProposal(cid, pid, patch) {
  const { chat, list, idx } = findProposal(cid, pid);
  if (list[idx].status !== 'pending') throw Object.assign(new Error('that action is already settled'), { status: 409 });
  list[idx] = actions.reshape(list[idx], patch || {});
  save(chat);
  emit(cid, { type: 'proposal.update', proposal: list[idx] });
  return list[idx];
}

/**
 * Carry over any proposal that was settled WHILE a turn was running.
 *
 * A turn holds the copy of the chat it loaded when it started, and settling a card
 * (from the UI, another tab, Voice mode) rewrites the same file underneath it. Saving
 * the turn's copy afterwards would put those cards back to `pending` — reviving a
 * Confirm button on something already done. Statuses are taken from disk; everything
 * else is the running turn's, which is the only writer for the rest of the file.
 */
function mergeSettled(c) {
  const disk = readJSON(file(c.id));
  if (!disk) return c;
  const settled = new Map();
  for (const m of disk.messages || []) for (const p of m.proposals || []) settled.set(p.id, p);
  if (!settled.size) return c;
  for (const m of c.messages) {
    if (Array.isArray(m.proposals)) m.proposals = m.proposals.map(p => settled.get(p.id) || p);
  }
  return c;
}

/**
 * The pending proposal on the LAST assistant turn, if any.
 *
 * Deliberately only the last one: "yes" answers the question that was just asked, and
 * letting it reach back through the transcript would let a fresh "yes, please do"
 * settle a card from twenty minutes ago that the user had simply ignored.
 */
function openProposal(c) {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (m.role === 'user') continue;                    // the reply we are answering
    if (m.role !== 'assistant') return null;
    return (m.proposals || []).find(p => p.status === 'pending') || null;
  }
  return null;
}

/** Handle "yes"/"no" as an answer to a card. Returns true when it was one. */
async function settleByReply(c, cid, text) {
  const pending = openProposal(c);
  if (!pending) return false;
  const decision = actions.readDecision(text);
  if (!decision) return false;

  const p = await decideProposal(cid, pending.id, decision === 'yes' ? 'confirm' : 'discard');
  const line = p.status === 'confirmed' ? `Done — ${p.summary}.`
    : p.status === 'failed' ? `That did not work: ${p.result}`
      : 'Discarded — nothing was saved.';
  // RE-READ the chat: decideProposal wrote the settled status to the same file, and
  // `c` is a copy loaded before that happened. Appending to the stale copy and saving
  // it put the card back to `pending` — invisible until a reload, at which point
  // Confirm was live again on something already done.
  const fresh = getChat(cid);
  fresh.messages.push({ role: 'assistant', text: line, ts: now(), settled: p.id });
  save(fresh);
  emit(cid, { type: 'done', text: line, tools: [], usage: c.usage });
  return true;
}

/** Confirm (optionally with edits) or discard. Returns the settled proposal. */
export async function decideProposal(cid, pid, decision, patch) {
  const { chat, list, idx } = findProposal(cid, pid);
  let p = list[idx];
  if (p.status !== 'pending') return p;    // idempotent: a double-tap must not double-log

  if (decision !== 'confirm') {
    p = { ...p, status: 'discarded', settledAt: now() };
  } else {
    if (patch && Object.keys(patch).length) p = actions.reshape(p, patch);
    // Marked done BEFORE the tool runs: two confirms racing in from two tabs must
    // not both get past the pending check and write the row twice.
    list[idx] = { ...p, status: 'running' };
    save(chat);
    let out;
    try { out = await actions.execute(p); }
    catch (e) { out = { ok: false, content: e.message }; }
    p = { ...p, status: out.ok ? 'confirmed' : 'failed', result: out.content, settledAt: now() };
  }
  list[idx] = p;
  save(chat);
  emit(cid, { type: 'proposal.update', proposal: p });
  return p;
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
  if (has.has('finance_log')) lines.push('- finance_log / finance_budget_set / finance_goal_set: record money in or out, cap a category, set the monthly goal.');
  if (has.has('mail_recent')) lines.push("- mail_recent / mail_search / mail_read: the user's inbox (read-only).");

  // The confirmation step changes what good behaviour looks like: guessing is now
  // cheap (the user sees and can fix every field before anything happens) while
  // interrogating them is expensive. Without this the model asks "which category?"
  // and "what date?" first, which is exactly the friction the cards remove.
  if (actions.confirmEnabled() && toolDefs.some(t => actions.isConfirmable(t.name))) {
    lines.push(
      'IMPORTANT — writes are confirmed, not automatic. When the user states something that belongs in their'
      + ' records ("I made 50000 through Uber Eats today", "I have a dentist appointment next Tuesday at 3pm",'
      + ' "cap groceries at 45000"), CALL THE TOOL with your best reading of it. It will NOT be saved: they get'
      + ' a card showing every field, which they can edit and then confirm. So do not interrogate them first —'
      + ' fill in sensible defaults (today\'s date, the most likely category) and let them correct the card.'
      + ' Convert what they said into real numbers first: 5万円 is 50000 JPY, "3pm" is 15:00, "next Tuesday" is'
      + ' a real date. After proposing, reply in ONE short sentence saying what you are about to do.');
  }
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

  // Title from the first message — unless the caller already named the chat. A session
  // opened with a purpose (an interview, a saved workflow) knows what it is better than
  // its opening line does, and its opening line is often a priming instruction.
  if (c.messages.length === 0 && (!c.title || c.title === 'New chat')) {
    const base = text || atts[0]?.name || 'New chat';
    c.title = base.slice(0, 60) + (base.length > 60 ? '…' : '');
  }
  const userMsg = { role: 'user', text, ts: now() };
  if (atts.length) userMsg.attachments = atts;
  c.messages.push(userMsg);
  save(c);
  emit(cid, { type: 'user', text, attachments: atts });

  // A bare "yes" or "no" answering the card the previous turn put up is a DECISION,
  // not a message. Settling it here rather than round-tripping through the model is
  // both faster and safer: a small local model asked to interpret "yes" can decide to
  // helpfully call the tool a second time, and then it happens twice.
  if (!atts.length) {
    const settled = await settleByReply(c, cid, text);
    if (settled) return;
  }

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
  // Both injections below describe the USER's real life. A chat that is playing a part
  // (createChat({ context: false })) has to be sealed off from them, or the interviewer
  // starts asking about your calendar.
  const ambient = c.context !== false;
  try { if (ambient) { const prof = profileInjection(); if (prof) system += '\n\n' + prof; } } catch { }
  // app-wide awareness: planner/mail/weather brief so day-to-day questions
  // ("what's going on tomorrow?") answer from real data, on every provider
  if (ambient && cfg.defaults.appContext !== false) {
    try {
      const { appContext } = await import('./context.js');
      const ctx = appContext({ chars: 1900 });
      if (ctx) system += '\n\n' + ctx;
    } catch { }
  }

  // Read-only tool belt (unless disabled for this chat). The nudge is what actually
  // gets small models to use it instead of declining.
  //
  // Lean, like the agent: full schemas only for the handful chat uses on every topic,
  // and a one-line-per-group directory for the rest, which the model activates with
  // load_tools. Sending all of them cost ~4.2k tokens of a 32k local window on EVERY
  // round — a quarter of the budget spent before the conversation started, mostly on
  // finance and mail schemas that a given chat never touches.
  const useTools = c.tools !== false;
  const pool = useTools ? chatTools() : [];
  const baseSystem = system;

  /** The belt as it stands, given what this chat has activated so far. */
  const buildLoadout = () => {
    if (!pool.length) return { defs: [], names: new Set(), directory: '' };
    const { tools, directory, dormantGroups } = leanLoadout({
      pool, coreNames: chatCoreNames(), activeGroups: c.toolGroups || [],
    });
    const defs = dormantGroups.length ? [...tools, META_LOAD] : tools;
    return { defs, names: new Set(defs.map(t => t.name)), directory };
  };
  /** System prompt for the current loadout. Recomposed after load_tools so the newly
   *  activated tools are described and the directory stops offering them again. */
  const composeSystem = (lo) => {
    if (!lo.defs.length) return baseSystem;
    let s = baseSystem + '\n\n' + toolNudge(lo.defs);
    if (lo.directory) {
      s += '\n\nMore tools exist but are not loaded yet. When the question needs one, call '
        + 'load_tools {"groups":["<name>"]} first — its tools become callable on your next turn. Directory:\n'
        + lo.directory;
    }
    // Reluctant models answer time-sensitive questions from stale memory — push harder.
    if (lo.names.has('web_search') && looksTimeSensitive(text)) {
      s += '\n\n[This message looks time-sensitive. Call web_search BEFORE answering it — do not rely on memory.]';
    }
    return s;
  };

  let loadout = buildLoadout();
  system = composeSystem(loadout);

  try {
    // fit system + history inside the model's context window, reserving room for the reply
    const { maxTokens, inputChars } = contextBudget({ modelRef: c.modelRef, wantOutput: 8192 });
    // Reserve against the LARGEST the belt could become, not the one we start with: the
    // history is chosen once, but load_tools can grow the schemas underneath it mid-turn,
    // and a budget spent on the lean loadout would then overflow the window.
    const maxDefs = pool.length
      ? leanLoadout({ pool, coreNames: chatCoreNames(), activeGroups: [...new Set(pool.map(t => t.group))] }).tools
      : [];
    const budget = Math.max(2000, inputChars - system.length - JSON.stringify(maxDefs).length);
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
    // Writes the model asked for this turn, staged for the user to confirm. They
    // ride along on the assistant message so a reload still shows the card in the
    // state it was left in — pending, confirmed, or discarded.
    const proposals = [];
    let res;
    for (let round = 0; ; round++) {
      const lastRound = round >= MAX_TOOL_ROUNDS;
      res = await streamChat({
        modelRef: c.modelRef, system, messages: msgs, tools: lastRound ? [] : loadout.defs,
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
        // Activating a group is bookkeeping, not a tool run: it changes what the NEXT
        // round is allowed to call, so the loadout and the prompt are rebuilt here.
        if (call.name === 'load_tools') {
          const msg = activateGroups(c, call.args?.groups, { pool });
          loadout = buildLoadout();
          system = composeSystem(loadout);
          save(c);
          emit(cid, { type: 'tool.start', callId: call.id, name: call.name, args: call.args });
          emit(cid, { type: 'tool.end', callId: call.id, name: call.name, ok: true, content: msg });
          results.push({ id: call.id, name: call.name, content: msg, isError: false });
          continue;
        }
        // A tool the model remembers from the directory but has not loaded: say so
        // rather than refusing outright, or it gives up instead of loading the group.
        if (!loadout.names.has(call.name)) {
          const known = pool.find(t => t.name === call.name);
          results.push({
            id: call.id, name: call.name, isError: true,
            content: known
              ? `"${call.name}" is not loaded yet. Call load_tools {"groups":["${known.group}"]} first, then call it.`
              : `Tool "${call.name}" is not available in chat (read-only + note/planner tools only — use the Agent for anything that edits files).`,
          });
          continue;
        }
        if (isWriteTool(call.name) && !isChatSafeWrite(call.name)) {
          results.push({ id: call.id, name: call.name, content: `Tool "${call.name}" is not available in chat (read-only + note/planner tools only — use the Agent for anything that edits files).`, isError: true });
          continue;
        }
        // A write the user has to agree to is not run here — it is PROPOSED. The
        // model gets told it was proposed (and told not to try again), the client
        // gets a card with an editable summary and a Confirm button, and the ledger
        // stays untouched until that button is pressed. See server/actions.js.
        if (actions.confirmEnabled() && actions.isConfirmable(call.name)) {
          let proposal;
          try { proposal = actions.propose(call.name, call.args); }
          catch (e) {
            results.push({ id: call.id, name: call.name, content: `Could not prepare that action: ${e.message}`, isError: true });
            continue;
          }
          proposals.push(proposal);
          emit(cid, { type: 'proposal', proposal });
          results.push({
            id: call.id, name: call.name, isError: false,
            content: `PROPOSED — nothing has been saved. ${loadConfig().user?.name || 'The user'} has been shown a confirmation card reading "${proposal.summary}".`
              + ' Do NOT call this tool again for the same thing. In your reply, say in one short sentence what you are about to do and ask them to confirm.',
          });
          if (!usedTools.includes(call.name)) usedTools.push(call.name);
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
    if (proposals.length) asst.proposals = proposals;
    c.messages.push(asst);
    save(mergeSettled(c));
    emit(cid, { type: 'done', text: res.text, reasoning: res.reasoning, tools: usedTools, usage: c.usage, perf: res.perf, proposals });
    // Let the AI learn the user's style from their messages (throttled, background).
    // Symmetric with the injection above: a chat sealed off from the profile does not
    // feed it either — interview answers are a performance, not how this person talks.
    if (!ctl.signal.aborted && ambient) {
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
