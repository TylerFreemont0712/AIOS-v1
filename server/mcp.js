// MCP: the Model Context Protocol client.
//
// An MCP server is a separate process (or a remote endpoint) that publishes tools over
// JSON-RPC 2.0. This module connects to the ones the user has configured, discovers what
// they offer, and hands the results to tools.js so they land on the agent's belt beside
// the built-ins — same approval gate, same lean-loadout grouping, same Settings row.
//
// Two design constraints shaped everything here:
//
//  1. `enabledTools()` in tools.js is SYNCHRONOUS and runs on every agent turn. Nothing
//     here may block it, so discovery is async and writes into a cache that the sync
//     accessor reads. A server that is slow, broken, or missing simply contributes no
//     tools — it never delays or breaks a turn.
//
//  2. These are other people's processes. They crash, hang, print garbage to stdout, and
//     sometimes never start at all. Every failure is contained to its own server and
//     surfaced as status the UI can show, never thrown at the agent loop.
//
// Transports: stdio (spawn a command — what almost every MCP server ships as, including
// Godot MCP) and streamable HTTP (a URL, for remote servers).

import { spawn } from 'node:child_process';
import { loadConfig, saveConfig } from './config.js';
import { now } from './util.js';

// The revision of the protocol we speak. Servers negotiate down in their initialize
// reply; we accept whatever they answer with rather than insisting, because refusing a
// server over a version string helps nobody.
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'AIOS', version: '0.1.0' };

const CONNECT_TIMEOUT_MS = 30_000;   // npx may be fetching the package on first run
const CALL_TIMEOUT_MS = 120_000;
const LIST_PAGE_CAP = 20;            // paranoia against a server that never stops paginating
const RETRY_BACKOFF_MS = 30_000;     // a crash-looping server must not be respawned per call

export const ID_RX = /^[a-z][a-z0-9_]{1,23}$/;
export const validId = (s) => ID_RX.test(String(s || ''));

/** live state per server id — never persisted; config.js owns the durable part */
const live = new Map();

const rec = (id) => {
  if (!live.has(id)) {
    live.set(id, {
      id, status: 'idle', tools: [], error: '', serverInfo: null,
      proc: null, pending: new Map(), nextId: 1, buf: '', stderr: [],
      connecting: null, connectedAt: '', lastExit: '', failedAt: 0, calls: 0,
    });
  }
  return live.get(id);
};

export const serverConfigs = () => (loadConfig().mcp?.servers || []).filter(s => validId(s?.id));
const configOf = (id) => serverConfigs().find(s => s.id === id) || null;

// ---------- naming ----------
//
// A server's tools are namespaced by its id, for two reasons: two MCP servers may both
// publish a `search`, and the model needs to see at a glance which system a tool drives.
// The group is namespaced too — a server calling itself "files" or "git" must not merge
// into the built-in group of that name and quietly change what load_tools activates.

export const toolName = (serverId, tool) => `${serverId}_${String(tool).replace(/[^a-zA-Z0-9_]/g, '_')}`.slice(0, 64);
export const groupName = (serverId) => `mcp:${serverId}`;
export const isMcpGroup = (g) => String(g || '').startsWith('mcp:');

/** Split a namespaced tool name back into its server and the name the server knows. */
export function resolveTool(name) {
  for (const r of live.values()) {
    const hit = r.tools.find(t => t.name === name);
    if (hit) return { serverId: r.id, remoteName: hit.remoteName, def: hit };
  }
  return null;
}

/** The configured server whose namespace a tool name falls in, connected or not. */
export const ownerOf = (name) => serverConfigs().find(s => String(name || '').startsWith(s.id + '_')) || null;

/** Is this name MCP's to answer for? True even when the server is down, so the caller
 *  reports "that server is not connected" instead of "unknown tool". */
export const owns = (name) => !!resolveTool(name) || !!ownerOf(name);

// ---------- the wire ----------

/** JSON-RPC request over whichever transport this server uses. */
function request(r, method, params, timeoutMs) {
  const cfg = configOf(r.id);
  if (cfg?.transport === 'http') return httpRequest(cfg, method, params, timeoutMs);

  return new Promise((resolve, reject) => {
    if (!r.proc || r.proc.exitCode !== null) return reject(new Error('server is not running'));
    const id = r.nextId++;
    const timer = setTimeout(() => {
      r.pending.delete(id);
      reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    r.pending.set(id, { resolve, reject, timer });
    try {
      r.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
    } catch (e) {
      clearTimeout(timer); r.pending.delete(id);
      reject(new Error(`could not write to the server: ${e.message}`));
    }
  });
}

function notify(r, method, params) {
  const cfg = configOf(r.id);
  if (cfg?.transport === 'http') {
    httpRequest(cfg, method, params, 10_000, true).catch(() => { });
    return;
  }
  try { r.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n'); } catch { }
}

/**
 * Streamable HTTP transport. Stateless per call, which is all the tool surface needs —
 * no session resumption, no server-to-client stream. A server that insists on SSE for
 * ordinary replies will fail here, and says so plainly rather than hanging.
 */
async function httpRequest(cfg, method, params, timeoutMs, isNotification = false) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST', signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(cfg.headers || {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(isNotification ? {} : { id: 1 }), method, ...(params ? { params } : {}) }),
    });
    if (isNotification) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    // An SSE reply frames the JSON in `data:` lines; take the last complete one.
    const payload = /^\s*\{/.test(text)
      ? text
      : text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean).pop();
    if (!payload) throw new Error('empty response');
    const msg = JSON.parse(payload);
    if (msg.error) throw new Error(rpcErrorText(msg.error));
    return msg.result;
  } finally { clearTimeout(timer); }
}

const rpcErrorText = (e) => `${e.message || 'error'}${e.code ? ` (${e.code})` : ''}${e.data ? ` — ${String(JSON.stringify(e.data)).slice(0, 200)}` : ''}`;

/** One newline-delimited JSON-RPC message from a stdio server. */
function onMessage(r, msg) {
  if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
    const p = r.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer); r.pending.delete(msg.id);
    msg.error ? p.reject(new Error(rpcErrorText(msg.error))) : p.resolve(msg.result);
    return;
  }
  // A request FROM the server. We advertise no sampling/roots/elicitation capability, so
  // a well-behaved server never sends one — but an ill-behaved one must get an answer
  // rather than block waiting for a reply that never comes.
  if (msg.method && msg.id !== undefined && msg.id !== null) {
    try {
      r.proc?.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32601, message: `AIOS does not implement ${msg.method}` },
      }) + '\n');
    } catch { }
    return;
  }
  // Notification. The one that matters is the server telling us its tools changed.
  if (msg.method === 'notifications/tools/list_changed') {
    listTools(r).then(tools => { r.tools = tools; }).catch(() => { });
  }
}

// ---------- lifecycle ----------

function spawnServer(r, cfg) {
  const command = String(cfg.command || '').trim();
  if (!command) throw new Error('no command configured');
  const proc = spawn(command, Array.isArray(cfg.args) ? cfg.args.map(String) : [], {
    cwd: cfg.cwd || undefined,
    env: { ...process.env, ...(cfg.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  r.proc = proc;
  r.buf = ''; r.stderr = []; r.lastExit = '';

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    r.buf += chunk;
    // Newline-delimited JSON. A line that is not JSON is a server logging to stdout —
    // technically a protocol violation, common in practice, and not worth dying over.
    let nl;
    while ((nl = r.buf.indexOf('\n')) >= 0) {
      const line = r.buf.slice(0, nl).trim();
      r.buf = r.buf.slice(nl + 1);
      if (!line) continue;
      try { onMessage(r, JSON.parse(line)); }
      catch { keepStderr(r, `[stdout] ${line.slice(0, 300)}`); }
    }
    if (r.buf.length > 8_000_000) r.buf = '';        // a server streaming junk forever
  });

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => keepStderr(r, chunk));

  // Both handlers check they still own the record. A restart replaces r.proc, and the
  // OUTGOING process's exit event lands after the new one is already handshaking — so
  // without this guard a reconnect rejects its own initialize with the previous
  // process's cause of death and then kills the server it just started.
  const current = () => r.proc === proc;
  proc.on('error', (e) => {
    const why = e.code === 'ENOENT' ? `command not found: ${command}` : e.message;
    if (!current()) return;
    r.lastExit = why;
    failAll(r, why);
    r.status = 'down'; r.error = why; r.failedAt = Date.now(); r.proc = null;
  });
  proc.on('exit', (code, signal) => {
    if (!current()) return;
    r.lastExit = signal ? `killed by ${signal}` : `exited with code ${code}`;
    failAll(r, r.lastExit);
    if (r.status !== 'stopped') {
      r.status = 'down';
      r.error = `${r.lastExit}${r.stderr.length ? ` — ${r.stderr.join('').trim().split('\n').pop().slice(0, 200)}` : ''}`;
      r.failedAt = Date.now();
      // tools stay cached on a CRASH so callTool can reconnect transparently; an
      // explicit stop() clears them, because "I turned it off" must mean off.
    }
    r.proc = null;
  });
  return proc;
}

function keepStderr(r, chunk) {
  r.stderr.push(String(chunk));
  // Keep the tail only: a chatty server would otherwise grow this without bound.
  while (r.stderr.length > 80) r.stderr.shift();
}

function failAll(r, why) {
  for (const [, p] of r.pending) { clearTimeout(p.timer); p.reject(new Error(why)); }
  r.pending.clear();
}

/** tools/list, following cursors, mapped into our tool-def shape. */
async function listTools(r) {
  const out = [];
  let cursor;
  for (let page = 0; page < LIST_PAGE_CAP; page++) {
    const res = await request(r, 'tools/list', cursor ? { cursor } : {}, CONNECT_TIMEOUT_MS);
    for (const t of res?.tools || []) {
      if (!t?.name) continue;
      const params = t.inputSchema && t.inputSchema.type === 'object'
        ? t.inputSchema
        : { type: 'object', properties: {} };
      out.push({
        name: toolName(r.id, t.name),
        remoteName: t.name,
        description: String(t.description || t.title || t.name).slice(0, 800),
        parameters: { type: 'object', properties: params.properties || {}, ...(params.required ? { required: params.required } : {}) },
        // MCP annotations are hints and every field is optional. Only an explicit
        // readOnlyHint buys a tool past the approval gate — anything unlabelled is
        // treated as a write, because "we don't know" and "it's safe" are not the same.
        readOnly: t.annotations?.readOnlyHint === true,
      });
    }
    cursor = res?.nextCursor;
    if (!cursor) break;
  }
  return out;
}

/**
 * Connect (or reconnect) one server and discover its tools.
 *
 * Concurrent callers share the same in-flight attempt — several agent turns starting at
 * once must not spawn several copies of the same process.
 */
export function connect(id, { force = false } = {}) {
  const cfg = configOf(id);
  if (!cfg) return Promise.reject(new Error(`no MCP server called "${id}"`));
  const r = rec(id);
  if (r.connecting) return r.connecting;
  if (r.status === 'up' && !force) return Promise.resolve(r);
  // Back off after a failure. Without this, an agent calling a tool on a server whose
  // command does not exist would respawn it on every single turn.
  if (!force && r.failedAt && Date.now() - r.failedAt < RETRY_BACKOFF_MS) {
    return Promise.reject(new Error(r.error || 'server is not available'));
  }

  r.connecting = (async () => {
    stop(id, { quiet: true });
    r.status = 'starting'; r.error = ''; r.tools = [];
    try {
      if (cfg.transport !== 'http') spawnServer(r, cfg);
      const init = await request(r, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }, CONNECT_TIMEOUT_MS);
      r.serverInfo = init?.serverInfo || null;
      notify(r, 'notifications/initialized');
      r.tools = await listTools(r);
      r.status = 'up'; r.error = ''; r.failedAt = 0; r.connectedAt = now();
      console.log(`[mcp] ${id}: ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'} from ${r.serverInfo?.name || cfg.transport}`);
      return r;
    } catch (e) {
      // A stdio server that died during the handshake has a far more useful message on
      // stderr than "timed out" — prefer it.
      const tail = r.stderr.join('').trim().split('\n').filter(Boolean).pop();
      r.status = 'down';
      r.error = r.lastExit ? `${r.lastExit}${tail ? ` — ${tail.slice(0, 200)}` : ''}` : (tail ? `${e.message} — ${tail.slice(0, 200)}` : e.message);
      r.failedAt = Date.now();
      r.tools = [];
      stop(id, { quiet: true });
      throw new Error(r.error);
    } finally {
      r.connecting = null;
    }
  })();
  return r.connecting;
}

export function stop(id, { quiet = false } = {}) {
  const r = live.get(id);
  if (!r) return;
  // An explicit stop also drops the tool cache, so nothing resolves them and callTool
  // cannot quietly respawn a server the user just switched off. `quiet` is the internal
  // teardown inside connect(), which is about to repopulate them anyway.
  if (!quiet) { r.status = 'stopped'; r.tools = []; }
  failAll(r, 'server stopped');
  const p = r.proc;
  r.proc = null;
  if (!p || p.exitCode !== null) return;
  try {
    p.kill('SIGTERM');
    // Give it a moment to close cleanly, then insist.
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { } }, 3000);
    p.once('exit', () => clearTimeout(t));
    t.unref?.();
  } catch { /* already gone */ }
}

export function stopAll() { for (const id of [...live.keys()]) stop(id); }

/** Connect every enabled server, in parallel, swallowing failures — boot must not wait
 *  on someone else's process and must not fail because of one. */
export function startEnabled() {
  const list = serverConfigs().filter(s => s.enabled !== false);
  if (!list.length) return Promise.resolve([]);
  return Promise.all(list.map(s => connect(s.id).catch(e => {
    console.error(`[mcp] ${s.id}: ${e.message}`);
    return null;
  })));
}

/** Forget a server entirely (used when its config row is deleted). */
export function forget(id) { stop(id); live.delete(id); }

// ---------- what tools.js reads ----------

/** SYNCHRONOUS, cached. Called on every agent turn — must never do I/O. */
export function listMcpTools() {
  const enabled = new Set(serverConfigs().filter(s => s.enabled !== false).map(s => s.id));
  const out = [];
  for (const r of live.values()) {
    if (r.status !== 'up' || !enabled.has(r.id)) continue;
    for (const t of r.tools) out.push({ ...t, serverId: r.id, group: groupName(r.id) });
  }
  return out;
}

/**
 * Call one MCP tool. Reconnects first if the server has dropped, so a server that was
 * restarted (or crashed hours ago) recovers on use instead of needing a visit to Settings.
 */
export async function callTool(name, args, { signal } = {}) {
  const hit = resolveTool(name);
  if (!hit) {
    // The name may belong to a configured server that is simply not connected. Saying
    // which one is actionable; "unknown tool" reads like the model invented the name.
    const owner = ownerOf(name);
    if (owner) {
      throw new Error(`"${name}" belongs to the MCP server "${owner.id}", which is not connected`
        + `${owner.enabled === false ? ' (it is switched off in Settings → Tools)' : ` — ${live.get(owner.id)?.error || 'reconnect it in Settings → Tools'}`}`);
    }
    throw new Error(`no MCP tool called "${name}"`);
  }
  const r = rec(hit.serverId);
  const cfg = configOf(hit.serverId);
  if (!cfg || cfg.enabled === false) throw new Error(`the MCP server "${hit.serverId}" is turned off`);
  if (r.status !== 'up' || (cfg.transport !== 'http' && !r.proc)) await connect(hit.serverId, { force: true });

  const timeout = Math.min(Math.max(Number(cfg.timeoutMs) || CALL_TIMEOUT_MS, 5_000), 600_000);
  const p = request(r, 'tools/call', { name: hit.remoteName, arguments: args || {} }, timeout);
  const res = signal
    ? await Promise.race([p, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('cancelled')), { once: true }))])
    : await p;
  r.calls++;
  return renderResult(res);
}

/**
 * MCP returns content BLOCKS, not a string. Text passes straight through; anything else
 * is described rather than dropped, because "the tool returned an image" is information
 * and an empty result reads to the model like the call did nothing.
 */
function renderResult(res) {
  const blocks = Array.isArray(res?.content) ? res.content : [];
  const parts = [];
  for (const b of blocks) {
    if (b?.type === 'text') parts.push(String(b.text ?? ''));
    else if (b?.type === 'image') parts.push(`[image: ${b.mimeType || 'unknown type'}, ${Math.round(String(b.data || '').length * 0.75 / 1024)}KB — not readable as text]`);
    else if (b?.type === 'audio') parts.push(`[audio: ${b.mimeType || 'unknown type'}]`);
    else if (b?.type === 'resource_link') parts.push(`[resource: ${b.uri}${b.name ? ` — ${b.name}` : ''}]`);
    else if (b?.type === 'resource') {
      const rr = b.resource || {};
      parts.push(rr.text != null ? String(rr.text) : `[resource: ${rr.uri || 'unnamed'} (${rr.mimeType || 'binary'})]`);
    } else if (b) parts.push(`[${b.type || 'unknown'} content]`);
  }
  // structuredContent is the typed twin of the text blocks; include it only when there is
  // no text, so a well-behaved server does not get reported twice.
  if (!parts.length && res?.structuredContent) parts.push(JSON.stringify(res.structuredContent, null, 2));
  const text = parts.join('\n').trim();
  if (res?.isError) throw new Error(text || 'the tool reported an error with no detail');
  return text || '(the tool returned nothing)';
}

// ---------- config CRUD ----------
//
// Kept here rather than in config.js's generic updateConfig: the shape has real rules
// (a usable id, a command or a url depending on transport) and a blanket deep-merge over
// an array of servers would silently accept a half-written row.

const bad = (m) => Object.assign(new Error(m), { status: 400 });

/** Secret-ish maps (env, headers): '' keeps what is stored, null deletes the key. */
function mergeSecrets(prev = {}, next) {
  if (!next || typeof next !== 'object') return { ...prev };
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v === null) delete out[k];
    else if (v === '') { if (!(k in out)) out[k] = ''; }
    else out[k] = String(v);
  }
  return out;
}

export function saveServer(input = {}) {
  const id = String(input.id || '').trim().toLowerCase();
  if (!validId(id)) throw bad('id must be 2-24 characters, lower-case letters, digits or _, starting with a letter (it prefixes every tool this server publishes)');
  const transport = input.transport === 'http' ? 'http' : 'stdio';
  if (transport === 'stdio' && !String(input.command || '').trim()) throw bad('a stdio server needs a command to run (e.g. node, npx, python)');
  if (transport === 'http' && !/^https?:\/\//i.test(String(input.url || ''))) throw bad('an http server needs a URL starting with http:// or https://');

  const cfg = loadConfig();
  cfg.mcp ||= { servers: [] };
  cfg.mcp.servers ||= [];
  const prev = cfg.mcp.servers.find(s => s.id === id) || null;

  const row = {
    id,
    name: String(input.name || prev?.name || id).slice(0, 60),
    transport,
    command: transport === 'stdio' ? String(input.command || '').trim() : '',
    args: transport === 'stdio' ? (Array.isArray(input.args) ? input.args.map(a => String(a)) : (prev?.args || [])) : [],
    cwd: transport === 'stdio' ? String(input.cwd || '').trim() : '',
    url: transport === 'http' ? String(input.url || '').trim() : '',
    env: transport === 'stdio' ? mergeSecrets(prev?.env, input.env) : {},
    headers: transport === 'http' ? mergeSecrets(prev?.headers, input.headers) : {},
    timeoutMs: Math.min(Math.max(Number(input.timeoutMs) || CALL_TIMEOUT_MS, 5_000), 600_000),
    enabled: input.enabled !== false,
  };
  cfg.mcp.servers = prev
    ? cfg.mcp.servers.map(s => (s.id === id ? row : s))
    : [...cfg.mcp.servers, row];
  saveConfig();

  // The connection belongs to the old settings — drop it so the next use reconnects
  // with what was just saved rather than answering from a stale process.
  forget(id);
  return row;
}

export function removeServer(id) {
  const cfg = loadConfig();
  const before = (cfg.mcp?.servers || []).length;
  cfg.mcp ||= { servers: [] };
  cfg.mcp.servers = (cfg.mcp.servers || []).filter(s => s.id !== id);
  if (cfg.mcp.servers.length === before) throw Object.assign(new Error(`no MCP server called "${id}"`), { status: 404 });
  saveConfig();
  forget(id);
}

// ---------- status for the UI ----------

export function status() {
  return serverConfigs().map(cfg => {
    const r = live.get(cfg.id);
    return {
      id: cfg.id,
      name: cfg.name || cfg.id,
      transport: cfg.transport || 'stdio',
      command: cfg.command || '',
      args: cfg.args || [],
      cwd: cfg.cwd || '',
      url: cfg.url || '',
      envKeys: Object.keys(cfg.env || {}),        // names only — values may be secrets
      enabled: cfg.enabled !== false,
      status: cfg.enabled === false ? 'off' : (r?.status || 'idle'),
      error: r?.error || '',
      serverInfo: r?.serverInfo || null,
      connectedAt: r?.connectedAt || '',
      calls: r?.calls || 0,
      group: groupName(cfg.id),
      tools: (r?.tools || []).map(t => ({ name: t.name, remoteName: t.remoteName, description: t.description, readOnly: t.readOnly })),
      log: (r?.stderr || []).join('').split('\n').filter(Boolean).slice(-40).join('\n'),
    };
  });
}

/** Ready-made entries for the servers people actually run. Purely a UI convenience —
 *  nothing here is special-cased anywhere else in the code. */
export const PRESETS = [
  {
    id: 'godot', name: 'Godot', transport: 'stdio',
    command: 'node', args: ['/path/to/godot-mcp/build/index.js'],
    env: { GODOT_PATH: '' },
    hint: 'Clone github.com/Coding-Solo/godot-mcp, run `npm install && npm run build`, then point args at its build/index.js. GODOT_PATH is the Godot executable (optional — it probes common locations).',
  },
  {
    id: 'filesystem', name: 'Filesystem', transport: 'stdio',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'],
    hint: 'Official reference server. The trailing paths are the only directories it will touch.',
  },
  {
    id: 'playwright', name: 'Playwright', transport: 'stdio',
    command: 'npx', args: ['-y', '@playwright/mcp@latest'],
    hint: 'Drives a real browser — navigate, click, fill forms, screenshot.',
  },
  {
    id: 'context7', name: 'Context7 docs', transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    hint: 'Up-to-date library documentation, fetched on demand. No key needed for light use.',
  },
];
