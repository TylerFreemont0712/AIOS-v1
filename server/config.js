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
  // confirmActions: writes the assistant wants to make (log a payment, add an event,
  // set a budget) come back as a confirmation card instead of just happening. Turning
  // this off restores the old behaviour, where chat wrote to the ledger and the
  // planner directly — fast, and occasionally wrong in a way you find out about later.
  defaults: { chatModel: '', agentModel: '', agentMode: 'edits', agentPlanMode: false, chatTools: true, chatSystem: DEFAULT_CHAT_SYSTEM, contextTokens: 32000, confirmActions: true },
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
  // daily driver; 'tiny' is a small fast model for quick work. Freeing the card for
  // ComfyUI is no longer a profile swap — Studio stops llama-server outright.
  llm: {
    managed: true,
    // Reasoning ("thinking") control for models that support it (e.g. the ornith
    // reasoning model, Qwen3, DeepSeek-R1). `default` applies when a caller doesn't
    // specify one; `byModel` overrides per model ref OR alias (e.g. { 'ornith-9b': 'high' }).
    // Levels: auto | off | low | medium | high. 'auto' (the default) sends nothing and lets
    // the model's chat template decide — so normal chat is unchanged. off/low/medium/high map,
    // for local OpenAI-compatible servers, to chat_template_kwargs.enable_thinking +
    // reasoning_effort; for Ollama to `think`. Cloud endpoints ignore these entirely.
    // 'tiny' is off by default and that is not arbitrary: Qwen3.5-2B with thinking
    // enabled spent 900 tokens without emitting a single visible word, while the same
    // question answered correctly in 36 tokens with thinking off. A fast small model
    // that never finishes thinking is not a fast small model.
    reasoning: { default: 'auto', byModel: { tiny: 'off' } },
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
        model: '/home/joejin/ai/models/Qwen3.5-2B-UD-Q8_K_XL.gguf', alias: 'tiny',
        // GPU-resident now that Studio stops llama.cpp instead of demoting it: at
        // 2.6GB it leaves ~5GB free, and CPU-only threw away the speed that makes a
        // small model worth having. 32k context is what fitContext allows here.
        args: ['--ctx-size', '32768', '-ngl', '99', '--threads', '8', '--batch-size', '2048',
          '--ubatch-size', '512', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0'],
      },
    },
  },
  // ComfyUI connector (Studio app). autoSwap: generating while llama.cpp holds VRAM
  // stops it first (and restores it afterwards). autoFree: release Comfy VRAM after jobs.
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
  // Attachment intake. ffmpeg is what converts the formats no model provider accepts —
  // above all HEIC, which is what an iPhone shoots by default. Empty = auto-detect on
  // PATH (set an absolute path if AIOS runs from systemd, whose PATH is minimal).
  // maxEdge: long edge in pixels after conversion; vision models gain nothing above it.
  uploads: { ffmpeg: '', maxEdge: 2048 },
  // Speech in and out, both local (faster-whisper + Kokoro-82M on the CPU). See
  // server/voice.js for the layout; `npm run voice` installs it.
  //   home/python: '' = the default ~/.local/share/aios/voice.
  //   idleMinutes: drop the worker after this long unused — the two models cost
  //     ~1.2GB of RAM and this box has an 8GB card that also wants to run an LLM.
  //   stt.model: 'small' (accurate, ~1.9s an utterance) or 'base' (~0.7s, worse on
  //     Japanese and proper nouns). Both are one whisper window, so cost barely
  //     moves with how long you speak.
  //   stt.language: '' auto-detects, which is shaky on very short clips — set 'en'
  //     or 'ja' if you always speak one language.
  //   tts.autoSpeak: read chat replies aloud without being asked.
  //   handsFree: in Voice mode, send when you stop talking instead of on a click.
  voice: {
    enabled: true, home: '', python: '', idleMinutes: 15,
    //   stt.partialModel: the small model behind the live text that appears WHILE you
    //     speak. It is re-run over the whole utterance about once a second, so it has
    //     to be quicker than that interval — 'base' is ~0.7s, 'tiny' ~0.3s. '' turns
    //     partials off. It never produces the text that gets acted on; the accurate
    //     model still does one full pass when you stop.
    //   stt.streaming: the live words that appear WHILE you speak now come from a
    //     streaming Zipformer transducer (sherpa-onnx), not from re-running whisper
    //     over the utterance-so-far. Whisper is a 30s-window seq2seq model — measured
    //     here, 0.83s of audio costs it 1786ms and 9.71s costs 2163ms, so short
    //     dictation pays the full window price and partials were quadratic. The
    //     transducer carries state between chunks (RTF ~0.065 on 4 CPU threads), so
    //     text grows word by word the way phone dictation does.
    //     It is feedback ONLY: it is less accurate than whisper (no punctuation,
    //     upper-case English) and the committed text is still whisper's full pass.
    //   stt.streamMs: how often the browser ships audio. 200ms reads as continuous.
    //   stt.streamRule2: trailing silence (seconds) that ends an utterance, judged
    //     against what was decoded rather than loudness — replaces the fixed VAD wait.
    //   stt.streamDecoding: 'modified_beam_search' or 'greedy_search'. Greedy is
    //     cheaper (RTF 0.086 vs 0.111 on 4 threads) and cannot do contextual bias at
    //     all — hotwords are scored against beams, and greedy has none. Measured on
    //     32 clips: the same word error rate, the first word 130ms sooner, and 22.3%
    //     -> 20.9% once the ledger's merchants are biasing it. On a 200ms chunk
    //     budget neither number is one a person can feel, so beam search is default.
    //   stt.streamBeam: how many beams (sherpa's max_active_paths). 4 is its default.
    //   stt.streamHotwords: bias the live recogniser toward the ledger's merchants,
    //     the same list whisper gets as a prompt. OFF by default because it was
    //     MEASURED on this ledger and did not pay: the merchants here are ordinary
    //     English words ("Outlier", "Mercor", "Prolific", "Micro1") that the model
    //     already reads correctly, so the score moved 25.0% -> 26.4% — noise, in the
    //     wrong direction. It earns its keep on names the model cannot spell:
    //     "FAMILY MARCH" becomes "FAMILY MART" and 32 mixed clips went 22.3% ->
    //     20.9%. Turn it on if the shops you say out loud are Japanese.
    //   stt.streamHotwordScore: how hard to lean on them. Above 3 it starts pulling
    //     unrelated words toward a merchant ("for lunch" -> "for nge"); 2 is the
    //     point where names improve and nothing else moves.
    stt: {
      model: 'small', partialModel: 'base', partialMs: 1100, device: 'cpu', compute: 'int8',
      threads: 0, beam: 1, language: '', prompt: '',
      streaming: true, streamModel: 'sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10',
      streamMs: 200, streamThreads: 4, streamProvider: 'cpu', streamRule2: 0.8,
      streamDecoding: 'modified_beam_search', streamBeam: 4,
      streamHotwords: false, streamHotwordScore: 2,
    },
    // voice may name TWO voices ("af_heart+bf_emma"); `blend` is how much of the
    // first, and the result is a voice the model does not ship. `pitch` shifts it
    // up or down without changing how long the sentence takes to say.
    tts: { model: 'kokoro-v1.0.onnx', voices: 'voices-v1.0.bin', voice: 'af_heart', blend: 0.5, pitch: 1, speed: 1, lang: 'en-us', autoSpeak: false },
    handsFree: true, silenceMs: 1100, maxUtteranceSec: 60,
  },
  // Money. ocrModel MUST be vision-capable (a model whose preset names an mmproj that
  // exists) — receipts.js refuses to OCR with a text-only model rather than silently
  // returning nothing. Empty = pick the best vision model on this machine at scan time.
  // ocrTextModel only matters when ocrModel is a dedicated OCR transcriber (a preset
  // tagged `ocr`): those read a page superbly but do not answer questions about it, so
  // they transcribe and this model turns the transcription into the receipt. Empty =
  // fall back to defaults.chatModel.
  // ocrMinConfidence: a scan scoring below this out of 100 is read again (see
  // receipts.scoreConfidence — arithmetic, missing fields, garbled text, recognised
  // products). ocrMaxAttempts caps that at 1-3 passes; each costs ~15 s of GPU, and past
  // the third the model does not surprise you.
  // ocrTiles: a receipt more than twice as tall as it is wide is read in this many
  // overlapping bands and stitched back together, so the small print (product names) is
  // read at its own resolution instead of being downscaled away with the rest of the
  // strip. 0 or 1 reads every photo whole; 4 is the cap. Costs one model pass per band.
  finance: {
    baseCurrency: 'JPY', ocrModel: '', ocrTextModel: '', itemModel: '', recapModel: '',
    weekStart: 'monday', ocrMinConfidence: 75, ocrMaxAttempts: 3, ocrTiles: 3,
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
    // fetch_url / crawl_site / research refuse private and loopback addresses, because
    // the URL comes from the model and the model got it from a web page — and this box
    // answers on loopback with ComfyUI, llama-server, Ollama and AIOS itself, none of
    // which ask a passing request for a password. Turn this on only if you actually
    // want the agent reading your own LAN services. See safeFetch in server/tools.js.
    allowPrivateFetch: false,
    // Maps & directions. Keyless by default (OpenStreetMap Nominatim + public OSRM);
    // a Google Directions key unlocks transit and exact walking/cycling times.
    // units: metric | imperial (distances in directions/find_places).
    maps: { nominatimUrl: 'https://nominatim.openstreetmap.org', osrmUrl: 'https://router.project-osrm.org', googleKey: '', units: 'metric' },
  },
  // MCP servers — external processes (or URLs) that publish tools over the Model Context
  // Protocol. Each entry: { id, name, transport: 'stdio'|'http', command, args[], env{},
  // cwd, url, headers{}, timeoutMs, enabled }. Their tools join the agent's belt in a
  // group of their own (`mcp:<id>`), so the lean loadout keeps them out of the default
  // schema budget until the model asks for them. See server/mcp.js.
  mcp: { servers: [] },
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
  // An MCP server's env is where its API keys live. The client gets the NAMES so it can
  // show and re-submit the row, never the values.
  if (c.mcp?.servers) {
    c.mcp.servers = c.mcp.servers.map(s => ({
      ...s, env: undefined, envKeys: Object.keys(s.env || {}),
      headers: undefined, headerKeys: Object.keys(s.headers || {}),
    }));
  }
  delete c.auth.token;
  return c;
}

/** Apply a partial update from the client. Secrets arrive via explicit fields. */
export function updateConfig(patch) {
  const c = loadConfig();
  const allowed = ['user', 'appearance', 'defaults', 'projectsRoot', 'vault', 'agent', 'tools', 'sampling', 'weather', 'llm', 'comfy', 'profile', 'finance', 'uploads', 'voice'];
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
