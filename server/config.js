import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, id } from './util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.AIOS_DATA || path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');

// The base system prompt prepended to EVERY chat (per-chat instructions stack on top).
// {name}/{date} are filled in at send time. Editable in Settings → Chat.
export const DEFAULT_CHAT_SYSTEM = `You are Claude inside AIOS, {name}'s personal AI hub. Be direct, warm, and genuinely useful, and match {name}'s tone. Use markdown when it helps. Today is {date}.

Accuracy over recall: when a question depends on current, recent, or time-sensitive facts — news, events, prices, releases, "what happened", anything that could have changed since your training — do NOT answer from memory. Use your tools to check first, then answer from what you find. It is far better to search and be right than to guess.`;

const defaults = () => ({
  // home: the user's home location, used as the default origin for directions and the
  // default reference for find_places/weather. Falls back to the weather location.
  user: { name: os.userInfo().username, email: '', home: { place: '', lat: null, lon: null } },
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
  defaults: { chatModel: '', agentModel: '', agentMode: 'edits', agentPlanMode: false, chatTools: true, chatSystem: DEFAULT_CHAT_SYSTEM, contextTokens: 32000 },
  // The AI learns the user's communication style + stable facts from their chat inputs,
  // keeps a profile note in the vault, and injects a condensed version into chat/agent.
  profile: { enabled: true, everyN: 6, inject: true, notePath: 'About Me.md' },
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
    // Reasoning ("thinking") control for models that support it (e.g. the ornith
    // reasoning model, Qwen3, DeepSeek-R1). `default` applies when a caller doesn't
    // specify one; `byModel` overrides per model ref OR alias (e.g. { 'ornith-9b': 'high' }).
    // Levels: auto | off | low | medium | high. 'auto' (the default) sends nothing and lets
    // the model's chat template decide — so normal chat is unchanged. off/low/medium/high map,
    // for local OpenAI-compatible servers, to chat_template_kwargs.enable_thinking +
    // reasoning_effort; for Ollama to `think`. Cloud endpoints ignore these entirely.
    reasoning: { default: 'auto', byModel: {} },
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
    dir: '/mnt/projects/comfyui/ComfyUI', python: '/home/joejin/venv/bin/python', listen: '0.0.0.0',
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
    // Maps & directions. Keyless by default (OpenStreetMap Nominatim + public OSRM);
    // a Google Directions key unlocks transit and exact walking/cycling times.
    // units: metric | imperial (distances in directions/find_places).
    maps: { nominatimUrl: 'https://nominatim.openstreetmap.org', osrmUrl: 'https://router.project-osrm.org', googleKey: '', units: 'metric' },
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
  if (c.mail) c.mail = { ...c.mail, password: undefined, hasPassword: !!c.mail.password };
  if (c.github) c.github = { hasToken: !!c.github.token };
  if (c.notify) c.notify = { ...c.notify, discordWebhook: undefined, hasDiscordWebhook: !!c.notify.discordWebhook };
  if (c.tools?.maps) c.tools.maps = { ...c.tools.maps, googleKey: undefined, hasGoogleKey: !!c.tools.maps.googleKey };
  delete c.auth.token;
  return c;
}

/** Apply a partial update from the client. Secrets arrive via explicit fields. */
export function updateConfig(patch) {
  const c = loadConfig();
  const allowed = ['user', 'appearance', 'defaults', 'projectsRoot', 'vault', 'agent', 'tools', 'sampling', 'weather', 'llm', 'comfy', 'profile', 'finance'];
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
        // optional manual model list — for OpenAI-compatible gateways that don't serve /models
        const models = Array.isArray(n.models) ? n.models.map(s => String(s).trim()).filter(Boolean) : (prev?.models || []);
        return { id: n.id || id(6), name: n.name || 'Custom', baseUrl: n.baseUrl || '', kind: 'openai', apiKey: (typeof n.apiKey === 'string' && n.apiKey !== '') ? n.apiKey : (prev?.apiKey || ''), models };
      });
    }
  }
  if (patch.auth) {
    if (['never', 'lan', 'always'].includes(patch.auth.required)) c.auth.required = patch.auth.required;
    if (patch.auth.regenerateToken) c.auth.token = id(18);
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
