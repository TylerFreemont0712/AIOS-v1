// The tool foundry: Hermes-style self-created tools. The agent templates a tool
// (name, description, JSON-schema params, JS body, declared access level) via
// create_tool; it is persisted under data/tools/ and becomes callable on the next
// turn like any built-in. Code runs in a node:vm sandbox that only sees the
// capability API we inject — read tools never receive write capabilities.
//
// This is a guardrail, not a security boundary: the code is authored by the
// user's own model, creation is approval-gated, and the hub is personal/LAN.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DATA, loadConfig, contextBudget } from './config.js';
import { streamChat } from './llm.js';
import { now, readJSON, writeJSON, truncate } from './util.js';

const DIR = path.join(DATA, 'tools');
const file = (name) => path.join(DIR, name + '.json');

const NAME_RX = /^[a-z][a-z0-9_]{2,31}$/;
export const validName = (n) => NAME_RX.test(String(n || ''));

// ---------- registry ----------

export function listCustomTools() {
  if (!fs.existsSync(DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    const t = readJSON(path.join(DIR, f));
    if (t?.name && validName(t.name)) out.push(t);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const getCustomTool = (name) => validName(name) ? readJSON(file(name)) : null;

export function saveCustomTool({ name, description, parameters, access, code }, { builtinNames = new Set() } = {}) {
  if (!validName(name)) throw new Error('tool name must match ^[a-z][a-z0-9_]{2,31}$ (snake_case)');
  if (builtinNames.has(name)) throw new Error(`"${name}" is a built-in tool — pick another name`);
  if (!String(description || '').trim()) throw new Error('description is required (the model decides when to call the tool from it)');
  if (!parameters || parameters.type !== 'object' || typeof parameters.properties !== 'object') {
    throw new Error('parameters must be a JSON schema object: {"type":"object","properties":{...},"required":[...]}');
  }
  if (!['read', 'write'].includes(access)) throw new Error('access must be "read" (no side effects) or "write" (may modify files/notes)');
  const body = String(code || '');
  if (body.trim().length < 10) throw new Error('code is empty');
  compile(body); // surface syntax errors at creation time, not first call
  const prev = getCustomTool(name);
  const t = {
    name, description: String(description).slice(0, 600), parameters, access, code: body,
    createdAt: prev?.createdAt || now(), updatedAt: now(), runs: prev?.runs || 0, lastError: '',
  };
  fs.mkdirSync(DIR, { recursive: true });
  writeJSON(file(name), t);
  return { name, updated: !!prev };
}

export function deleteCustomTool(name) {
  if (!getCustomTool(name)) throw new Error(`no custom tool named "${name}"`);
  fs.unlinkSync(file(name));
}

// ---------- execution ----------

function compile(code) {
  try {
    return new vm.Script(`(async (args, ctx) => { "use strict";\n${code}\n})`, { filename: 'custom-tool.js' });
  } catch (e) {
    throw new Error(`tool code does not parse: ${e.message}`);
  }
}

/**
 * Run a custom tool. `caps` is the capability API assembled by tools.js
 * ({ webSearch, fetchReadable, readFile, writeFile, listDir, vaultSearch,
 *    vaultRead, vaultWrite }); write capabilities are stripped for read tools.
 * Returns the tool's return value as a string.
 */
export async function runCustomTool(def, args, { caps, modelRef, signal, timeoutMs = 60000 } = {}) {
  const logs = [];
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const guard = (fn, name) => async (...a) => {
    if (ctl.signal.aborted) throw new Error('cancelled');
    if (!fn) throw new Error(`${name} is not available to this tool (declared access: ${def.access})`);
    return fn(...a);
  };

  const ctx = {
    log: (m) => { if (logs.length < 50) logs.push(String(m).slice(0, 500)); },
    fetchText: guard(async (url, opts = {}) => (await caps.fetchReadable(url, 1_000_000, { headers: opts.headers })).text, 'fetchText'),
    fetchJSON: guard(async (url, opts = {}) => {
      const t = setTimeout(() => ctl.abort(), 25000);
      try {
        const r = await fetch(url, { signal: ctl.signal, method: opts.method || 'GET', headers: opts.headers, body: opts.body });
        const text = (await r.text()).slice(0, 1_000_000);
        try { return JSON.parse(text); } catch { throw new Error(`non-JSON response (${r.status}): ${text.slice(0, 200)}`); }
      } finally { clearTimeout(t); }
    }, 'fetchJSON'),
    webSearch: guard(caps.webSearch && (async (q, n = 8) => (await caps.webSearch(q, { n })).results), 'webSearch'),
    readFile: guard(caps.readFile, 'readFile'),
    listDir: guard(caps.listDir, 'listDir'),
    vaultSearch: guard(caps.vaultSearch, 'vaultSearch'),
    vaultRead: guard(caps.vaultRead, 'vaultRead'),
    // write capabilities — only present when the tool declared access:"write"
    writeFile: def.access === 'write' ? guard(caps.writeFile, 'writeFile') : guard(null, 'writeFile'),
    vaultWrite: def.access === 'write' ? guard(caps.vaultWrite, 'vaultWrite') : guard(null, 'vaultWrite'),
    llm: guard(async (prompt, opts = {}) => {
      const ref = modelRef || loadConfig().defaults.chatModel;
      if (!ref) throw new Error('no model available for ctx.llm');
      const maxTokens = Math.min(Math.max(opts.maxTokens || 1024, 64), 4096);
      const { inputChars } = contextBudget({ modelRef: ref, wantOutput: maxTokens });
      const res = await streamChat({
        modelRef: ref, maxTokens, signal: ctl.signal,
        system: opts.system || 'You are a helper inside a custom tool. Follow the requested output format exactly.',
        messages: [{ role: 'user', text: truncate(String(prompt), inputChars) }],
      });
      return res.text || '';
    }, 'llm'),
  };

  const sandbox = vm.createContext({
    JSON, Math, Date, RegExp, String, Number, Boolean, Array, Object, Map, Set,
    Promise, Error, URL, URLSearchParams, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 30000)),
    console: { log: ctx.log },
  }, { codeGeneration: { strings: false, wasm: false } });

  const t = readJSON(file(def.name)) || def;
  let timer;
  try {
    const runner = compile(def.code).runInContext(sandbox);
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => { ctl.abort(); rej(new Error(`tool timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    });
    timeout.catch(() => { }); // losing the race must not become an unhandled rejection
    const result = await Promise.race([runner(args || {}, ctx), timeout]);
    t.runs = (t.runs || 0) + 1; t.lastError = '';
    writeJSON(file(def.name), t);
    const body = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return (logs.length ? `[log]\n${logs.join('\n')}\n\n` : '') + (body ?? '(no return value)');
  } catch (e) {
    t.runs = (t.runs || 0) + 1; t.lastError = String(e.message).slice(0, 300);
    try { writeJSON(file(def.name), t); } catch { }
    throw new Error(`custom tool "${def.name}" failed: ${e.message}${logs.length ? `\n[log]\n${logs.join('\n')}` : ''}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The template shown to the model in create_tool's description — Hermes-style. */
export const TOOL_TEMPLATE = `const data = await ctx.fetchJSON('https://api.example.com/v1?q=' + encodeURIComponent(args.query));
ctx.log('got ' + data.items.length + ' items');
return data.items.slice(0, args.limit || 5).map(x => x.name).join('\\n');`;
