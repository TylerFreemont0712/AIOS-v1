import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, id } from './util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.AIOS_DATA || path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');

const defaults = () => ({
  user: { name: os.userInfo().username, email: '' },
  server: { port: Number(process.env.AIOS_PORT) || 7777, host: '0.0.0.0' },
  auth: {
    // 'never' = open, 'lan' = token required for non-localhost, 'always' = token required everywhere
    required: 'lan',
    token: id(18),
  },
  appearance: { theme: 'system', accent: '#d97757', wallpaper: 'aurora', density: 'comfortable' },
  providers: {
    anthropic: { apiKey: '', enabled: true },
    ollama: { baseUrl: 'http://127.0.0.1:11434', enabled: true },
    custom: [], // { id, name, baseUrl, apiKey, kind: 'openai' }
  },
  // contextTokens: the context window of your local models (llama.cpp/Ollama). AIOS
  // keeps prompts under this so a ~32k model never overflows. Anthropic uses its own large window.
  defaults: { chatModel: '', agentModel: '', agentMode: 'edits', contextTokens: 32000 },
  // Sampling knobs sent with every model call. null = leave it to the provider's default.
  // temperature/top_p/top_k are universal-ish; presence/frequency penalties are
  // OpenAI-compat; repeat_penalty is Ollama/llama.cpp; seed + stop where supported.
  sampling: { temperature: null, top_p: null, top_k: null, presence_penalty: null, frequency_penalty: null, repeat_penalty: null, seed: null, stop: [] },
  // Inbox triage over IMAP (read-only: EXAMINE + BODY.PEEK). Gmail needs an app password.
  mail: { enabled: false, host: '', port: 993, user: '', password: '', mailbox: 'INBOX', lookbackDays: 3, maxMessages: 30, scanIntervalMin: 0, model: '' },
  // Outbound notifications. The Discord webhook URL is a secret (posting rights).
  notify: { discordWebhook: '', onImportantMail: true },
  projectsRoot: path.resolve(ROOT, '..'),
  // Home weather widget — location set via Settings → Profile (Open-Meteo, no key).
  weather: { lat: null, lon: null, place: '', units: 'c' },
  // GitHub app. token is optional — when empty, the server borrows the gh CLI's login.
  github: { token: '' },
  // AIOS owns the local llama.cpp server (approved 2026-07-11). 'big' is the GPU
  // daily driver; 'tiny' runs CPU-only so ComfyUI gets the whole GPU (Studio mode).
  llm: {
    managed: true,
    binary: '/home/joejin/llama.cpp/build/bin/llama-server',
    // the PyQt launcher (Whisper/MusicGen/manual llama tinkering) — AIOS can open it
    launcher: '/home/joejin/ai/llama-launcher/launch_llama_server.sh',
    port: 8080,
    profiles: {
      big: {
        model: '/home/joejin/ai/models/ornith-1.0-9b-Q5_K_M.gguf', alias: 'ornith-9b',
        args: ['--ctx-size', '32758', '-ngl', 'auto', '--batch-size', '2048', '--ubatch-size', '512', '--threads', '8', '--parallel', '1', '--cache-reuse', '256', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0'],
      },
      tiny: {
        // lives in AIOS's data dir — ~/ai/models is root-owned on this machine
        model: path.join(DATA, 'llm', 'models', 'Qwen3-1.7B-Q8_0.gguf'), alias: 'tiny',
        args: ['--ctx-size', '8192', '-ngl', '0', '--threads', '8'],
      },
    },
  },
  // ComfyUI connector (Studio app). autoSwap: generating while the big LLM holds
  // VRAM swaps to the tiny profile first. autoFree: release Comfy VRAM after jobs.
  // dir/python: AIOS can start/stop the ComfyUI server itself (Studio header).
  comfy: {
    url: 'http://127.0.0.1:8188', autoSwap: true, autoFree: true, autoStart: true,
    // listen 0.0.0.0 so the full ComfyUI UI is reachable from other LAN devices too
    // --enable-manager loads ComfyUI's built-in Manager (the pip `comfyui_manager`
    // package, pinned by ComfyUI's manager_requirements.txt). Without the flag the
    // Manager silently does not load — there is no custom_nodes entry for it since
    // v0.28. Its API lives under /api/v2/... ; the old /api/manager/* routes are V3.
    dir: '/home/joejin/comfyui/ComfyUI', python: '/home/joejin/venv/bin/python', listen: '0.0.0.0',
    args: ['--enable-manager'],
  },
  // autoApprove: agent writes scoped to the wiki/daily note skip the approval gate.
  // autoExport: finished deep-research reports are saved into the wiki automatically.
  vault: { path: '', wikiFolder: 'AI Wiki', dailyFolder: 'Daily', autoApprove: true, autoExport: true },
  // selfCheck: 'off' = trust the model, 'syntax' = check every written file,
  // 'review' = also re-check everything when the agent says it's done and bounce failures back.
  // runTests: 'review' = after a clean self-check, run the project's own test command
  // (package.json/pytest/Makefile/cargo/go, or a "verify:" line in .aios/instructions.md)
  // and bounce failures back; 'off' disables.
  // skills: inject stack-matched coding playbooks (skills/*.md) into the agent prompt.
  // memory: per-project persistent memory in <project>/.aios/memory/ + end-of-run record loop.
  agent: { maxTurns: 40, bashTimeoutMs: 60000, maxOutputChars: 30000, selfCheck: 'review', maxFixRounds: 2, runTests: 'review', testTimeoutMs: 120000, skills: true, memory: true },
  tools: {
    disabled: [],                                   // tool names the agent may not use
    searxng: { url: 'http://127.0.0.1:8890' },      // bundled metasearch instance (npm run searxng)
  },
  // Job Search add-on. source picks the active job connector; secrets (firecrawl/jobapi
  // keys, email password) are redacted in publicConfig and only set via explicit fields.
  jobsearch: {
    source: 'searxng',                              // 'searxng' | 'firecrawl' | 'jobapi'
    country: 'jp',                                  // default region (indeed.jp)
    firecrawl: { url: 'http://127.0.0.1:8899', apiKey: '' },  // self-host url and/or cloud key
    jobapi: { provider: 'serpapi', apiKey: '' },    // reliable Indeed via SerpApi when set
    email: { enabled: false, kind: 'imap', host: '', port: 993, user: '', password: '' }, // 1d
    savedSearches: [],                              // [{ id, label, query, location, type }]
    defaultModel: '',                               // model ref for summaries / cover letters
  },
});

let cfg = null;

export function loadConfig() {
  if (cfg) return cfg;
  fs.mkdirSync(DATA, { recursive: true });
  const saved = readJSON(CONFIG_FILE, {});
  cfg = deepMerge(defaults(), saved);
  // env override for the API key, never persisted
  if (process.env.ANTHROPIC_API_KEY && !cfg.providers.anthropic.apiKey) {
    cfg.providers.anthropic.apiKey = process.env.ANTHROPIC_API_KEY;
    cfg.providers.anthropic._fromEnv = true;
  }
  if (!saved.auth?.token) saveConfig(); // persist generated token on first run
  return cfg;
}

export function saveConfig() {
  const clean = JSON.parse(JSON.stringify(cfg));
  if (clean.providers?.anthropic?._fromEnv) { clean.providers.anthropic.apiKey = ''; delete clean.providers.anthropic._fromEnv; }
  writeJSON(CONFIG_FILE, clean);
}

/** Redacted view for the client: never leak keys or token hash-free. */
export function publicConfig() {
  const c = JSON.parse(JSON.stringify(loadConfig()));
  c.providers.anthropic = { enabled: c.providers.anthropic.enabled, hasKey: !!c.providers.anthropic.apiKey };
  c.providers.custom = c.providers.custom.map(p => ({ ...p, apiKey: undefined, hasKey: !!p.apiKey }));
  if (c.jobsearch) {
    const j = c.jobsearch;
    j.firecrawl = { ...j.firecrawl, apiKey: undefined, hasKey: !!j.firecrawl.apiKey };
    j.jobapi = { ...j.jobapi, apiKey: undefined, hasKey: !!j.jobapi.apiKey };
    j.email = { ...j.email, password: undefined, hasPassword: !!j.email.password };
  }
  if (c.mail) c.mail = { ...c.mail, password: undefined, hasPassword: !!c.mail.password };
  if (c.github) c.github = { hasToken: !!c.github.token };
  if (c.notify) c.notify = { ...c.notify, discordWebhook: undefined, hasDiscordWebhook: !!c.notify.discordWebhook };
  delete c.auth.token;
  return c;
}

/** Apply a partial update from the client. Secrets arrive via explicit fields. */
export function updateConfig(patch) {
  const c = loadConfig();
  const allowed = ['user', 'appearance', 'defaults', 'projectsRoot', 'vault', 'agent', 'tools', 'sampling', 'weather', 'llm', 'comfy'];
  for (const k of allowed) if (patch[k] !== undefined) c[k] = deepMerge(c[k], patch[k]);
  if (patch.mail) {
    const m = patch.mail, M = c.mail;
    for (const k of ['enabled', 'host', 'user', 'mailbox', 'model']) if (m[k] !== undefined) M[k] = m[k];
    for (const k of ['port', 'lookbackDays', 'maxMessages', 'scanIntervalMin']) if (m[k] !== undefined) M[k] = Number(m[k]) || 0;
    if (typeof m.password === 'string' && m.password !== '') M.password = m.password;
    if (m.password === null) M.password = '';
  }
  if (patch.github) {
    if (typeof patch.github.token === 'string' && patch.github.token !== '') c.github.token = patch.github.token;
    if (patch.github.token === null) c.github.token = '';
  }
  if (patch.notify) {
    const n = patch.notify, N = c.notify;
    if (typeof n.onImportantMail === 'boolean') N.onImportantMail = n.onImportantMail;
    if (typeof n.discordWebhook === 'string' && n.discordWebhook !== '') N.discordWebhook = n.discordWebhook;
    if (n.discordWebhook === null) N.discordWebhook = '';
  }
  if (patch.providers) {
    const p = patch.providers;
    if (p.anthropic) {
      if (typeof p.anthropic.apiKey === 'string' && p.anthropic.apiKey !== '') { c.providers.anthropic.apiKey = p.anthropic.apiKey; delete c.providers.anthropic._fromEnv; }
      if (p.anthropic.apiKey === null) { c.providers.anthropic.apiKey = ''; delete c.providers.anthropic._fromEnv; }
      if (typeof p.anthropic.enabled === 'boolean') c.providers.anthropic.enabled = p.anthropic.enabled;
    }
    if (p.ollama) c.providers.ollama = deepMerge(c.providers.ollama, p.ollama);
    if (Array.isArray(p.custom)) {
      c.providers.custom = p.custom.map(n => {
        const prev = c.providers.custom.find(x => x.id === n.id);
        return { id: n.id || id(6), name: n.name || 'Custom', baseUrl: n.baseUrl || '', kind: 'openai', apiKey: (typeof n.apiKey === 'string' && n.apiKey !== '') ? n.apiKey : (prev?.apiKey || '') };
      });
    }
  }
  if (patch.auth) {
    if (['never', 'lan', 'always'].includes(patch.auth.required)) c.auth.required = patch.auth.required;
    if (patch.auth.regenerateToken) c.auth.token = id(18);
  }
  if (patch.jobsearch) {
    const j = patch.jobsearch, J = c.jobsearch;
    if (['searxng', 'firecrawl', 'jobapi'].includes(j.source)) J.source = j.source;
    if (typeof j.country === 'string') J.country = j.country;
    if (typeof j.defaultModel === 'string') J.defaultModel = j.defaultModel;
    if (Array.isArray(j.savedSearches)) J.savedSearches = j.savedSearches;
    if (j.firecrawl) {
      if (typeof j.firecrawl.url === 'string') J.firecrawl.url = j.firecrawl.url;
      if (typeof j.firecrawl.apiKey === 'string' && j.firecrawl.apiKey !== '') J.firecrawl.apiKey = j.firecrawl.apiKey;
      if (j.firecrawl.apiKey === null) J.firecrawl.apiKey = '';
    }
    if (j.jobapi) {
      if (typeof j.jobapi.provider === 'string') J.jobapi.provider = j.jobapi.provider;
      if (typeof j.jobapi.apiKey === 'string' && j.jobapi.apiKey !== '') J.jobapi.apiKey = j.jobapi.apiKey;
      if (j.jobapi.apiKey === null) J.jobapi.apiKey = '';
    }
    if (j.email) {
      for (const k of ['enabled', 'kind', 'host', 'port', 'user']) if (j.email[k] !== undefined) J.email[k] = j.email[k];
      if (typeof j.email.password === 'string' && j.email.password !== '') J.email.password = j.email.password;
      if (j.email.password === null) J.email.password = '';
    }
  }
  saveConfig();
  return publicConfig();
}

/**
 * Fit a request inside a model's context window. Returns the output-token cap and
 * the char budget available for the prompt (system + tools + history), so callers
 * can trim history to what's left. Anthropic gets a large window; local models are
 * held under `defaults.contextTokens` with headroom reserved for the reply.
 *   ~3.3 chars/token (conservative — code/JSON is denser than prose, so we under-fill).
 */
export function contextBudget({ modelRef, wantOutput = 4096 }) {
  const cfg = loadConfig();
  const provider = String(modelRef || '').split(':')[0];
  if (provider === 'anthropic') return { maxTokens: wantOutput, inputChars: 600_000 };
  // work a little under the stated window to absorb tokenization variance
  const ctx = Math.max(4000, Math.floor((cfg.defaults.contextTokens || 32000) * 0.95));
  const maxTokens = Math.max(512, Math.min(wantOutput, Math.floor(ctx * 0.28)));
  const inputTokens = Math.max(1500, ctx - maxTokens - 900);   // slack for chat formatting overhead
  return { maxTokens, inputChars: Math.floor(inputTokens * 3.3) };
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
  if (typeof base === 'object' && base && typeof over === 'object' && over) {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over === undefined ? base : over;
}
