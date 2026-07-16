// Agentic coding sessions: a Claude-Code-style loop over llm.js + tools.js.
// Transcript persists per session; events stream to every client subscribed to `agent:<id>`.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA, loadConfig, contextBudget } from './config.js';
import { streamChat } from './llm.js';
import { toolSchemas, runTool, isWriteTool, isWikiScopedCall, diffPreview } from './tools.js';
import { checkFile, checkFiles, runProjectTests } from './checks.js';
import { skillsPrompt } from './skills.js';
import { id as genId, now, readJSON, writeJSON, estTokens, safePath, clampMiddle } from './util.js';
import { getProject } from './projects.js';
import { promptContext as gitContext } from './git.js';
import { appContext } from './context.js';

const DIR = path.join(DATA, 'agent');
const live = new Map(); // sessionId -> { abort, approvals: Map, running }

let publish = () => { };
export const setPublisher = (fn) => { publish = fn; };
const emit = (sid, ev) => publish(`agent:${sid}`, { t: 'agent.event', sessionId: sid, ev });

// ---------- session store ----------

const file = (id) => path.join(DIR, id + '.json');

export function listSessions(projectId) {
  fs.mkdirSync(DIR, { recursive: true });
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    const s = readJSON(path.join(DIR, f));
    if (!s || (projectId && s.projectId !== projectId)) continue;
    out.push({ id: s.id, projectId: s.projectId, title: s.title, modelRef: s.modelRef, mode: s.mode, updatedAt: s.updatedAt, usage: s.usage, messages: s.transcript.length, running: live.get(s.id)?.running || false });
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function createSession({ projectId, modelRef, mode }) {
  const cfg = loadConfig();
  const proj = getProject(projectId);
  if (!proj) throw Object.assign(new Error('unknown project'), { status: 404 });
  const s = {
    id: genId(8), projectId, root: proj.path, title: 'New session',
    modelRef: modelRef || cfg.defaults.agentModel, mode: mode || cfg.defaults.agentMode || 'edits',
    createdAt: now(), updatedAt: now(),
    transcript: [], usage: { input: 0, output: 0 }, allowedTools: [],
  };
  writeJSON(file(s.id), s);
  return s;
}

export function getSession(id) {
  const s = readJSON(file(id));
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  s.running = live.get(id)?.running || false;
  return s;
}

export function updateSession(id, patch) {
  const s = getSession(id);
  for (const k of ['modelRef', 'mode', 'title']) if (patch[k] !== undefined) s[k] = patch[k];
  save(s);
  return s;
}

export function deleteSession(id) {
  cancel(id);
  try { fs.unlinkSync(file(id)); } catch { }
}

const save = (s) => { s.updatedAt = now(); writeJSON(file(s.id), s); };

// ---------- control ----------

export function cancel(sid) {
  const st = live.get(sid);
  if (!st) return false;
  st.abort.abort();
  for (const [, resolve] of st.approvals) resolve('deny');
  st.approvals.clear();
  return true;
}

export function approve(sid, callId, decision) {
  const st = live.get(sid);
  const resolve = st?.approvals.get(callId);
  if (!resolve) return false;
  st.approvals.delete(callId);
  emit(sid, { type: 'approval.resolved', callId, decision });
  resolve(decision);
  return true;
}

// ---------- the loop ----------

export async function userMessage(sid, text, attachments) {
  const s = getSession(sid);
  if (live.get(sid)?.running) { emit(sid, { type: 'error', message: 'Agent is already running — stop it first.' }); return; }
  if (!s.modelRef) { emit(sid, { type: 'error', message: 'No model selected for this session.' }); return; }

  const atts = Array.isArray(attachments) ? attachments : [];
  if (!text && !atts.length) return;   // nothing to send

  const st = { abort: new AbortController(), approvals: new Map(), running: true };
  live.set(sid, st);

  if (s.transcript.length === 0) { const base = text || atts[0]?.name || 'New session'; s.title = base.slice(0, 64) + (base.length > 64 ? '…' : ''); }
  const userMsg = { role: 'user', text, ts: now() };
  if (atts.length) userMsg.attachments = atts;
  s.transcript.push(userMsg);
  save(s);
  emit(sid, { type: 'user', text, attachments: atts });

  const cfg = loadConfig();
  // fit the whole prompt (system + tools + trimmed transcript) inside the model's
  // context window, reserving headroom for the reply — prevents 32k overflow errors.
  const { maxTokens, inputChars } = contextBudget({ modelRef: s.modelRef, wantOutput: 16000 });

  // run bookkeeping: files touched (self-check), mistakes (memory reflection), loop guards
  const touched = new Set();
  let fixRounds = 0;
  let testRounds = 0;
  let testedClean = false;
  let denied = 0;
  let editsMade = 0;
  let memoryWrites = 0;
  let memoryPrompted = false;

  try {
    for (let turn = 0; turn < cfg.agent.maxTurns; turn++) {
      if (st.abort.signal.aborted) break;
      emit(sid, { type: 'status', state: 'thinking' });

      // re-read tools + system every turn: a create_tool call mid-run must be callable
      // immediately, and env context (git branch/dirty state) must track the run
      const tools = toolSchemas();
      const system = systemPrompt(s);
      const historyBudget = Math.max(4000, inputChars - system.length - JSON.stringify(tools).length);
      const messages = trimmed(s, historyBudget);
      const res = await streamChat({
        modelRef: s.modelRef, system, messages, tools,
        signal: st.abort.signal, maxTokens,
        onEvent: (ev) => {
          if (ev.type === 'text') emit(sid, { type: 'text.delta', delta: ev.delta });
          else if (ev.type === 'reasoning') emit(sid, { type: 'reasoning.delta', delta: ev.delta });
          else if (ev.type === 'toolCall') emit(sid, { type: 'tool.request', call: ev.call });
        },
      });

      s.usage.input += res.usage.input; s.usage.output += res.usage.output;
      const asst = { role: 'assistant', text: res.text, ts: now() };
      if (res.reasoning) asst.reasoning = res.reasoning;
      if (res.toolCalls.length) asst.toolCalls = res.toolCalls;
      s.transcript.push(asst);
      save(s);
      emit(sid, { type: 'text.done', text: res.text, reasoning: res.reasoning });

      if (st.abort.signal.aborted) break;

      if (!res.toolCalls.length) {
        const agentCfg = loadConfig().agent;

        // 1) Self-check review: the model believes it's done — re-check everything
        // it touched and bounce remaining syntax problems back (bounded rounds).
        const maxFix = Math.max(0, Math.min(5, agentCfg.maxFixRounds ?? 2));
        if (agentCfg.selfCheck === 'review' && touched.size && fixRounds < maxFix) {
          const checked = await checkFiles(s.root, [...touched]);
          const fails = checked.filter(r => !r.ok);
          emit(sid, { type: 'check.report', checked: checked.length, failed: fails.length, round: fixRounds + 1, files: fails.map(f => f.file) });
          if (fails.length) {
            fixRounds++;
            const text = selfCheckMessage(fails, fixRounds, maxFix);
            s.transcript.push({ role: 'user', text, auto: true, kind: 'check', ts: now() });
            save(s);
            emit(sid, { type: 'user', text, auto: true, kind: 'check' });
            continue;
          }
          touched.clear();
        }

        // 2) Verify v2: syntax is clean and files changed — run the project's real
        // tests (when it has any) and bounce failures back, bounded like self-check.
        if (agentCfg.runTests !== 'off' && editsMade > 0 && !testedClean && testRounds < maxFix) {
          const tr = await runProjectTests(s.root, { timeoutMs: Math.max(10_000, Math.min(agentCfg.testTimeoutMs || 120_000, 600_000)) });
          if (tr) {
            emit(sid, { type: 'test.report', ok: tr.ok, cmd: tr.cmd, via: tr.via, ms: tr.ms, round: testRounds + 1 });
            if (!tr.ok) {
              testRounds++;
              const text = `[automatic test run ${testRounds}/${maxFix}] The turn ended, but the project's tests FAIL (\`${tr.cmd}\`, from ${tr.via}):\n\n${tr.output || '(no output)'}\n\nFix the failures now: read the failing test/file, make a minimal change, and re-run \`${tr.cmd}\` with bash to confirm before finishing. Do not touch unrelated code, and never weaken a test just to make it pass.`;
              s.transcript.push({ role: 'user', text, auto: true, kind: 'check', ts: now() });
              save(s);
              emit(sid, { type: 'user', text, auto: true, kind: 'check' });
              continue;
            }
            testedClean = true;
          }
        }

        // 3) Memory round: substantial run and nothing recorded → one bounded nudge
        // to persist learnings (and lessons from this run's mistakes) to .aios/memory/.
        if (agentCfg.memory !== false && !memoryPrompted && memoryWrites === 0
          && (editsMade >= 2 || fixRounds > 0 || denied > 0)) {
          memoryPrompted = true;
          const text = memoryMessage(fixRounds, denied);
          s.transcript.push({ role: 'user', text, auto: true, kind: 'memory', ts: now() });
          save(s);
          emit(sid, { type: 'user', text, auto: true, kind: 'memory' });
          continue;
        }
        break;
      }

      const results = [];
      for (const call of res.toolCalls) {
        if (st.abort.signal.aborted) { results.push({ id: call.id, name: call.name, content: 'Cancelled by user.', isError: true }); continue; }
        const verdict = await gate(s, st, call);
        if (verdict !== 'allow') {
          denied++;
          results.push({ id: call.id, name: call.name, content: 'User denied this tool call. Ask before retrying or take a different approach.', isError: true });
          emit(sid, { type: 'tool.end', callId: call.id, name: call.name, ok: false, content: '(denied by user)' });
          continue;
        }
        emit(sid, { type: 'tool.start', callId: call.id, name: call.name, args: call.args });
        const t0 = Date.now();
        const r = await runTool(call.name, call.args, { root: s.root, signal: st.abort.signal, modelRef: s.modelRef });
        // syntax gate: check written files immediately so the model sees breakage in the tool result
        if (!r.isError && (call.name === 'write_file' || call.name === 'edit_file') && typeof call.args?.path === 'string') {
          if (inAios(s.root, call.args.path)) memoryWrites++;
          else {
            editsMade++;
            testedClean = false;   // new edits invalidate a previous green test run
            if (loadConfig().agent.selfCheck !== 'off') {
              touched.add(call.args.path);
              const chk = await checkFile(s.root, call.args.path);
              if (chk && !chk.ok) r.content += `\n\n⚠ Automatic syntax check failed (${chk.checker}):\n${chk.output}\nFix this file before doing anything else.`;
            }
          }
        }
        results.push({ id: call.id, name: call.name, content: r.content, isError: r.isError });
        emit(sid, { type: 'tool.end', callId: call.id, name: call.name, ok: !r.isError, content: r.content.slice(0, 4000), ms: Date.now() - t0 });
      }
      s.transcript.push({ role: 'tools', results, ts: now() });
      save(s);

      if (turn === cfg.agent.maxTurns - 1) emit(sid, { type: 'error', message: `Reached max turns (${cfg.agent.maxTurns}). Send a message to continue.` });
    }
  } catch (e) {
    if (!st.abort.signal.aborted) emit(sid, { type: 'error', message: e.message });
  } finally {
    st.running = false;
    live.delete(sid);
    save(s);
    emit(sid, { type: 'turn.done', usage: s.usage, cancelled: st.abort.signal.aborted });
    emit(sid, { type: 'status', state: 'idle' });
  }
}

/** Is this path inside the project's .aios/ folder (memory, instructions)? */
function inAios(root, p) {
  try { return safePath(root, p).startsWith(path.join(path.resolve(root), '.aios') + path.sep); } catch { return false; }
}

/** Approval gate. Returns 'allow' | 'deny'. */
async function gate(s, st, call) {
  if (!isWriteTool(call.name)) return 'allow';
  if (s.mode === 'read') return 'deny';
  if (s.mode === 'auto') return 'allow';
  // memory/instructions maintenance is always pre-approved — it's how the agent learns
  if (['write_file', 'edit_file'].includes(call.name) && typeof call.args?.path === 'string' && inAios(s.root, call.args.path)) return 'allow';
  // knowledge upkeep (wiki folder, daily note, generated maps) is pre-approved unless turned off
  if (loadConfig().vault?.autoApprove !== false && isWikiScopedCall(call.name, call.args)) return 'allow';
  if (s.allowedTools.includes(call.name)) return 'allow';

  emit(s.id, { type: 'status', state: 'waiting-approval' });
  emit(s.id, {
    type: 'approval.request', callId: call.id, name: call.name, args: call.args,
    diff: diffPreview(s.root, call.name, call.args),
  });
  const decision = await new Promise((resolve) => {
    st.approvals.set(call.id, resolve);
    setTimeout(() => { if (st.approvals.delete(call.id)) resolve('deny'); }, 10 * 60 * 1000);
  });
  if (decision === 'always') {
    s.allowedTools.push(call.name);
    save(s);
    return 'allow';
  }
  return decision;
}

/** The message injected when the review pass still finds broken files. */
function selfCheckMessage(fails, round, maxRounds) {
  return `[automatic self-check ${round}/${maxRounds}] The turn ended, but ${fails.length} file(s) you changed still fail syntax checks:\n\n`
    + fails.map(f => `• ${f.file} (${f.checker}):\n${f.output}`).join('\n\n')
    + `\n\nFix these now: use read_file on the failing lines first, then make a minimal edit_file change. Do not touch anything unrelated.`;
}

/** The end-of-run nudge to persist learnings into .aios/memory/. */
function memoryMessage(fixRounds, denied) {
  const mistakes = [];
  if (fixRounds) mistakes.push(`${fixRounds} self-check round(s) caught broken code you wrote`);
  if (denied) mistakes.push(`${denied} tool call(s) were denied by the user`);
  return `[automatic memory] The work is done — before finishing, update your persistent memory in .aios/memory/ (these writes are pre-approved):
- Write or update a short topic file for anything non-obvious you learned about this project this run (how something works, a decision, a gotcha, a command that works).
- Keep .aios/memory/MEMORY.md as the index: one line per topic file, format "- filename.md — what it covers".${mistakes.length ? `
- This run had problems: ${mistakes.join('; ')}. Append one short "next time, …" rule for each to .aios/memory/lessons.md.` : ''}
Be terse — a few lines per file. If nothing is genuinely worth recording, reply exactly "nothing to record".`;
}

// ---------- context ----------

function systemPrompt(s) {
  const cfg = loadConfig();
  // one schema read per prompt build — the module-level hasTool would rescan the
  // custom-tools dir for every feature check, every turn
  const toolNames = new Set(toolSchemas().map(t => t.name));
  const hasTool = (name) => toolNames.has(name);
  let listing = '';
  try {
    listing = fs.readdirSync(s.root, { withFileTypes: true })
      .filter(e => !['node_modules', '.git'].includes(e.name)).slice(0, 40)
      .map(e => e.isDirectory() ? e.name + '/' : e.name).join(', ');
  } catch { }
  return `You are the AIOS coding agent — a capable, autonomous software engineer working inside the user's personal AI hub.

Environment:
- Project: ${path.basename(s.root)} at ${s.root} (all tool paths are relative to this root; you cannot leave it)
- Platform: ${os.platform()} ${os.release()}, node ${process.version}
- Date: ${new Date().toDateString()}
- Top-level entries: ${listing || '(empty)'}

How to work:
- Understand before changing: use list_dir, glob, grep and read_file to explore. Read a file before editing it.
- Make changes directly with write_file / edit_file. Prefer edit_file for surgical changes; keep old_string unique.
- Verify your work: run tests, builds, or quick sanity commands with bash. If something fails, fix it and re-run.${cfg.agent.selfCheck !== 'off' ? `
- Every file you write is syntax-checked automatically. If a tool result contains "syntax check failed", fixing that file is your top priority — re-read the failing lines, then make a minimal edit.` : ''}${hasTool('web_search') ? `
- When you need current documentation, error messages, or library facts, use web_search and then fetch_url to read a result. Never invent URLs or APIs from memory.` : ''}
- Long tool output gets truncated — read specific files/ranges rather than dumping everything.${hasTool('git_status') ? `

Version control (git is part of how you build — not an afterthought):
- ${gitContext(s.root) || 'git state unknown — run git_status.'}
- On a repo, create a work branch BEFORE your first write_file/edit_file for any new piece of work: git_branch {name:"aios/<short-task-slug>"} (e.g. aios/fix-login-css). Skip only if you are already on a work branch for this same task or the user says otherwise. Never work directly on main/master.
- Review your own changes with git_diff before declaring work done.
- Commit with git_commit when a unit of work is done and verified, or when the user asks. Subject: imperative, ≤ 72 chars, conventional prefix (feat:/fix:/refactor:/chore:) when it fits.
- NEVER push, pull, merge, rebase, or reset --hard unless the user explicitly asks — those run through bash (the gh CLI handles GitHub remotes/PRs when installed).` : ''}${hasTool('wiki_recall') ? `

Knowledge base (your long-term memory — use it autonomously, don't ask permission):
- START of any non-trivial topic: wiki_recall it. The wiki holds curated docs, decisions, and past learnings that prevent repeated mistakes.
- END of any run where you learned something reusable (an API's behaviour, a working pattern, a fix, a decision): save it with wiki_learn — atomic notes, concise titles; frontmatter, autolinking, and the Home index are handled for you. These writes are pre-approved.
- Notes are TYPED: concept / howto / reference / decision / troubleshooting / source / project. Pass \`kind\` to wiki_learn and follow that kind's template — note_template {kind} shows the scaffold, and the \`notes\` skill has the full system.
- wiki_generate scaffolds a whole topic as interlinked notes; daily_log records notable events to the user's journal. Raw access (vault_search/list/read/write/append) exists for notes outside the wiki — those writes need approval.` : ''}${hasTool('research_start') ? `

You can run AIOS apps yourself instead of telling the user to:
- research_start for questions needing real sources (it searches, reads, and writes a cited report in the background; the report auto-exports to the wiki). Poll research_status between other work.
- mindmap_generate to structure a topic/plan as a tree outline — it lands in the wiki as a nested-list note.${hasTool('agenda_view') ? `
- agenda_view / task_add / event_add manage the user's Planner: check the schedule when dates matter, and capture to-dos or appointments the user mentions (additive, normally pre-approved).` : ''}${hasTool('mail_search') ? `
- mail_recent / mail_search / mail_read give READ-ONLY access to the user's inbox (nothing gets marked seen). Use them when asked about email, or to ground follow-ups (interviews, invoices, deliveries). Quote emails faithfully; never invent message content.` : ''}` : ''}${hasTool('create_tool') ? `

Tool foundry: when a capability you need is missing AND would be reused (calling an API, converting formats, checking something repeatedly), forge it with create_tool — it becomes callable on your next turn and persists across sessions. Declare access:"read" unless it must write. Fix a broken tool by re-creating it under the same name; check list_custom_tools before making near-duplicates. Prefer built-in tools when they suffice.` : ''}
- The conversation transcript may be trimmed for length; re-read files if you need exact current content.
- Be concise in prose. Explain what you did and why in a short summary when you finish, referencing files as path:line.
- Never fabricate tool results or claim success without verifying.
- If the user asks a question rather than requesting changes, answer it — don't modify files unprompted.
${cfg.defaults.appContext !== false ? (() => { try { const ctx = appContext({ chars: 1100, days: 2 }); return ctx ? '\n' + ctx + '\n(agenda_view has the full planner when you need more.)\n' : ''; } catch { return ''; } })() : ''}${projectContext(s)}${skillsPrompt(s.root, s.modelRef)}

User: ${cfg.user.name}. Approval mode: ${s.mode} (${s.mode === 'edits' ? 'write tools require user approval — if denied, adapt' : s.mode === 'auto' ? 'all tools pre-approved' : 'read-only: write tools are unavailable'}).`;
}

/** Per-project context: user-authored instructions + the agent's own memory, capped for small models. */
function projectContext(s) {
  const cfg = loadConfig();
  const readCapped = (rel, cap) => {
    try {
      const t = fs.readFileSync(path.join(s.root, rel), 'utf8').trim();
      return t.length > cap ? t.slice(0, cap) + '\n… (truncated — read the file for the rest)' : t;
    } catch { return ''; }
  };
  let out = '';
  const inst = readCapped('.aios/instructions.md', 2400);
  if (inst) out += `\n\nProject instructions (from .aios/instructions.md — follow them):\n${inst}`;
  if (cfg.agent.memory !== false) {
    const mem = readCapped('.aios/memory/MEMORY.md', 2000);
    const lessons = readCapped('.aios/memory/lessons.md', 1600);
    out += `\n\nPersistent memory — yours, at .aios/memory/ (create it when first needed; writes there are pre-approved):
- When you discover something non-obvious (how a subsystem works, a decision, a gotcha, a command that works), save a short topic file there and index it with one line in MEMORY.md.
- When something goes wrong (denied action, failed check, wrong assumption), append a one-line "next time, …" rule to lessons.md.
- Read a topic file before re-deriving something it already covers.`;
    if (mem) out += `\n\nMemory index (.aios/memory/MEMORY.md):\n${mem}`;
    if (lessons) out += `\n\nLessons from previous runs (follow these):\n${lessons}`;
  }
  return out;
}

/** Trim transcript to a char budget by dropping oldest exchanges (user → next user). */
function trimmed(s, budget) {
  const msgs = s.transcript.map(m => ({ ...m }));
  const size = () => msgs.reduce((n, m) => n + JSON.stringify(m).length, 0);

  // pass 1: squash old bulky tool results (keep last 2 exchanges intact)
  if (size() > budget) {
    const lastUserIdx = msgs.map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0);
    const protectedFrom = lastUserIdx.length >= 2 ? lastUserIdx[lastUserIdx.length - 2] : 0;
    for (let i = 0; i < protectedFrom && size() > budget; i++) {
      const m = msgs[i];
      if (m.role === 'tools') m.results = m.results.map(r => ({ ...r, content: r.content?.length > 400 ? r.content.slice(0, 400) + '\n[trimmed]' : r.content }));
    }
  }
  // pass 2: drop whole oldest exchanges
  while (size() > budget) {
    const userIdxs = msgs.map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0);
    if (userIdxs.length <= 1) break;
    msgs.splice(0, userIdxs[1]); // drop first exchange
  }
  // pass 3: last resort — even the newest exchange overflows; hard-truncate its bulk
  // so a single huge tool result or message can never blow the context window.
  if (size() > budget) {
    for (const m of msgs) {
      if (m.role === 'tools') m.results = m.results.map(r => ({ ...r, content: r.content?.length > 800 ? r.content.slice(0, 800) + '\n[trimmed]' : r.content }));
    }
    for (let i = 0; i < msgs.length - 1 && size() > budget; i++) {
      const m = msgs[i];
      if (typeof m.text === 'string' && m.text.length > 600) m.text = m.text.slice(0, 600) + '\n[trimmed]';
    }
    // even the newest message alone overflows — middle-truncate it so the model never errors
    if (size() > budget) {
      const last = msgs[msgs.length - 1];
      if (last && typeof last.text === 'string') {
        const overhead = size() - JSON.stringify(last).length;
        last.text = clampMiddle(last.text, Math.max(1000, budget - overhead - 200));
      }
    }
  }
  return msgs;
}

export const estimateContext = (s) => estTokens(JSON.stringify(s.transcript));
