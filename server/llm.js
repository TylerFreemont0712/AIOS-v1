// Provider abstraction. One internal message format, one normalized event stream,
// three wire protocols: Anthropic Messages API, Ollama /api/chat, OpenAI-compatible /chat/completions.
//
// Internal transcript format:
//   { role:'user',      text, attachments?: [{ id, name, mime, kind }] }
//   { role:'assistant', text, toolCalls?: [{ id, name, args }] }
//   { role:'tools',     results: [{ id, name, content, isError }] }
//
// Attachments (images / PDFs / documents / text files) are stored as lightweight meta;
// their bytes are materialized from DATA/uploads at send time and converted to each
// provider's native shape: Anthropic image/document blocks, OpenAI-compatible image_url
// parts, Ollama message.images. Text files are inlined as fenced text for every model.
//
// streamChat() emits onEvent: {type:'text',delta} | {type:'reasoning',delta} | {type:'toolCall',call} | {type:'usage',input,output}
// and resolves to { text, reasoning, toolCalls, usage, stopReason }.
//
// Reasoning ("chain of thought") is captured from whatever the provider offers:
// Anthropic thinking blocks, OpenAI-compatible delta.reasoning/reasoning_content
// (llama.cpp, DeepSeek, vLLM), Ollama message.thinking — plus a streaming-safe
// parser for inline <think>…</think> tags that many local models emit in content.

import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { id as genId } from './util.js';
import { readUpload } from './uploads.js';

const ANTHROPIC_FALLBACK_MODELS = [
  'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001',
];

function resolveModelRef(ref) {
  const i = String(ref || '').indexOf(':');
  if (i < 0) throw new Error(`bad model ref: ${ref} (expected provider:model)`);
  return { providerId: ref.slice(0, i), model: ref.slice(i + 1) };
}

function providerFor(providerId) {
  const cfg = loadConfig();
  if (providerId === 'anthropic') return { kind: 'anthropic', ...cfg.providers.anthropic };
  if (providerId === 'ollama') return { kind: 'ollama', ...cfg.providers.ollama };
  const c = cfg.providers.custom.find(p => `custom_${p.id}` === providerId || p.id === providerId);
  if (c) return { kind: 'openai', ...c };
  throw new Error(`unknown provider: ${providerId}`);
}

// ---------- model discovery ----------

export async function listModels() {
  const cfg = loadConfig();
  const out = [];
  const jobs = [];

  if (cfg.providers.anthropic.enabled && cfg.providers.anthropic.apiKey) {
    jobs.push((async () => {
      try {
        const r = await fetchJSON('https://api.anthropic.com/v1/models?limit=50', {
          headers: { 'x-api-key': cfg.providers.anthropic.apiKey, 'anthropic-version': '2023-06-01' },
        }, 6000);
        for (const m of r.data || []) out.push({ ref: `anthropic:${m.id}`, provider: 'anthropic', model: m.id, label: m.display_name || m.id });
      } catch {
        for (const m of ANTHROPIC_FALLBACK_MODELS) out.push({ ref: `anthropic:${m}`, provider: 'anthropic', model: m, label: m });
      }
    })());
  }

  if (cfg.providers.ollama.enabled) {
    jobs.push((async () => {
      try {
        const r = await fetchJSON(`${cfg.providers.ollama.baseUrl}/api/tags`, {}, 2500);
        for (const m of r.models || []) out.push({ ref: `ollama:${m.name}`, provider: 'ollama', model: m.name, label: `${m.name} (local)` });
      } catch { /* ollama down */ }
    })());
  }

  for (const c of cfg.providers.custom) {
    jobs.push((async () => {
      try {
        const headers = c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {};
        const r = await fetchJSON(`${c.baseUrl.replace(/\/$/, '')}/models`, { headers }, 4000);
        for (const m of r.data || []) out.push({ ref: `custom_${c.id}:${m.id}`, provider: c.name, model: m.id, label: `${m.id} (${c.name})` });
      } catch { /* unreachable */ }
    })());
  }

  await Promise.allSettled(jobs);
  return out;
}

export async function probeProviders() {
  const cfg = loadConfig();
  const res = { anthropic: { enabled: cfg.providers.anthropic.enabled, configured: !!cfg.providers.anthropic.apiKey }, ollama: { enabled: cfg.providers.ollama.enabled, up: false, models: 0 }, custom: [] };
  try {
    const r = await fetchJSON(`${cfg.providers.ollama.baseUrl}/api/tags`, {}, 1500);
    res.ollama.up = true; res.ollama.models = (r.models || []).length;
  } catch { }
  for (const c of cfg.providers.custom) {
    let up = false;
    try { await fetchJSON(`${c.baseUrl.replace(/\/$/, '')}/models`, { headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {} }, 2500); up = true; } catch { }
    res.custom.push({ id: c.id, name: c.name, up });
  }
  return res;
}

async function fetchJSON(url, opts = {}, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${await r.text().then(s => s.slice(0, 200)).catch(() => '')}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------- reasoning capture ----------

// A sink that separates a model's reasoning from its answer. Native reasoning
// (provider fields) goes straight to feedReasoning(); the answer stream goes through
// feedText(). Inline <think>…</think> is only treated as a reasoning delimiter when
// the answer stream OPENS with it (before any answer text) and no native reasoning
// was supplied — reasoning models always think first. This avoids hijacking a literal
// "<think>" that appears mid-answer, or in code/docs, or when reasoning is native.
function makeReasoningSink(onEvent) {
  const OPEN = /^<think(?:ing)?>/i;              // anchored: only at the very start
  const CLOSE = /<\/think(?:ing)?>/i;
  const OPEN_TAGS = ['<think>', '<thinking>'];
  const CLOSE_TAGS = ['</think>', '</thinking>'];
  let text = '', reasoning = '';
  let nativeFed = false;                          // provider gave reasoning out-of-band
  let phase = 'undecided';                        // 'undecided' | 'reasoning' | 'plain'
  let buf = '';

  const push = (kind, s) => {
    if (!s) return;
    if (kind === 'text') { text += s; onEvent?.({ type: 'text', delta: s }); }
    else { reasoning += s; onEvent?.({ type: 'reasoning', delta: s }); }
  };
  // could `s` still grow into one of `tags`? (partial tag at a chunk boundary)
  const partialOf = (s, tags) => {
    const low = s.toLowerCase();
    for (let k = Math.min(low.length, 10); k > 0; k--) {
      if (tags.some(t => t.startsWith(low.slice(low.length - k)))) return k;
    }
    return 0;
  };

  return {
    feedReasoning: (d) => { nativeFed = true; push('reasoning', d); },
    feedText(delta) {
      // once we know it's a plain answer (or reasoning came natively), stream straight through
      if (phase === 'plain' || nativeFed) { push('text', delta); return; }
      buf += delta;
      while (buf) {
        if (phase === 'undecided') {
          const lead = buf.match(/^\s*/)[0];
          const rest = buf.slice(lead.length);
          if (rest === '') { push('text', buf); buf = ''; return; }   // only whitespace so far
          if (OPEN.test(rest)) { push('text', lead); buf = rest.replace(OPEN, ''); phase = 'reasoning'; continue; }
          if (partialOf(rest, OPEN_TAGS) === rest.length) return;     // still could become <think>
          phase = 'plain'; push('text', buf); buf = ''; return;       // first real content isn't a tag
        }
        // phase === 'reasoning': everything up to </think> is reasoning; the rest is the answer
        const m = CLOSE.exec(buf);
        if (m) { push('reasoning', buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length); phase = 'plain'; push('text', buf); buf = ''; return; }
        const hold = partialOf(buf, CLOSE_TAGS);
        push('reasoning', buf.slice(0, buf.length - hold));
        buf = buf.slice(buf.length - hold);
        return;
      }
    },
    // Leftover at stream end: an unclosed <think> means the model was still thinking
    // (e.g. truncated) — keep it as reasoning; an undecided partial tag is literal text.
    flush() { if (buf) { push(phase === 'reasoning' ? 'reasoning' : 'text', buf); buf = ''; } },
    get text() { return text; },
    get reasoning() { return reasoning; },
  };
}

// ---------- sampling ----------

/**
 * Resolve the sampling knobs for one call: global config ← per-call overrides,
 * mapped to what each wire protocol understands. null/'' = omit (provider default).
 * Unset values are never sent, so strict APIs (real OpenAI) don't see local-only
 * params like top_k/repeat_penalty unless the user explicitly set them.
 */
export function samplingParams(kind, overrides) {
  const s = { ...(loadConfig().sampling || {}), ...(overrides || {}) };
  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? undefined : Number(v);
  const clamp = (v, lo, hi) => v === undefined ? undefined : Math.min(hi, Math.max(lo, v));
  const t = num(s.temperature), tp = clamp(num(s.top_p), 0, 1), tk = num(s.top_k);
  const pp = clamp(num(s.presence_penalty), -2, 2), fp = clamp(num(s.frequency_penalty), -2, 2);
  const rp = num(s.repeat_penalty), seed = num(s.seed);
  const stop = Array.isArray(s.stop) ? s.stop.map(x => String(x)).filter(Boolean).slice(0, 4) : [];
  const put = (o, k, v) => { if (v !== undefined) o[k] = v; return o; };

  if (kind === 'anthropic') {
    const o = {};
    put(o, 'temperature', clamp(t, 0, 1));
    put(o, 'top_p', tp); put(o, 'top_k', tk);
    if (stop.length) o.stop_sequences = stop;
    return o;
  }
  if (kind === 'ollama') {
    const o = {};
    put(o, 'temperature', clamp(t, 0, 2)); put(o, 'top_p', tp); put(o, 'top_k', tk);
    put(o, 'repeat_penalty', rp); put(o, 'presence_penalty', pp); put(o, 'frequency_penalty', fp);
    put(o, 'seed', seed);
    if (stop.length) o.stop = stop;
    return o; // goes into body.options
  }
  const o = {}; // openai-compatible
  put(o, 'temperature', clamp(t, 0, 2)); put(o, 'top_p', tp);
  put(o, 'presence_penalty', pp); put(o, 'frequency_penalty', fp);
  put(o, 'seed', seed);
  put(o, 'top_k', tk); put(o, 'repeat_penalty', rp);   // llama.cpp/vLLM extensions — omitted unless set
  if (stop.length) o.stop = stop;
  return o;
}

// ---------- streaming chat ----------

export async function streamChat({ modelRef, system, messages, tools, onEvent, signal, maxTokens = 8192, sampling }) {
  const { providerId, model } = resolveModelRef(modelRef);
  const p = providerFor(providerId);
  if (p.kind === 'anthropic') return anthropicStream({ p, model, system, messages, tools, onEvent, signal, maxTokens, sampling });
  if (p.kind === 'ollama') return ollamaStream({ p, model, system, messages, tools, onEvent, signal, sampling });
  return openaiStream({ p, model, system, messages, tools, onEvent, signal, maxTokens, sampling });
}

// ---------- attachments ----------
// Bytes are loaded lazily here (never carried in the transcript) and shaped per provider.

const ATT_TEXT_CAP = 60000;   // inline at most this many chars of a text file

function attBytes(a) {
  try { return readUpload(a.id).buffer; } catch { return null; }
}
function textAttachmentBlock(a, buf) {
  let body = buf.toString('utf8');
  if (body.length > ATT_TEXT_CAP) body = body.slice(0, ATT_TEXT_CAP) + `\n… [truncated — ${body.length - ATT_TEXT_CAP} more chars]`;
  return `Attached file "${a.name}":\n\`\`\`\n${body}\n\`\`\``;
}
function unreadableNote(a) {
  return `[Attached ${a.kind === 'pdf' ? 'PDF' : 'file'} "${a.name}" (${a.mime}) — the selected model can't read this format directly. Use an Anthropic model for PDFs, or attach an image or text version.]`;
}

// --- Anthropic ---

// Images → image blocks; PDFs → document blocks (native); text files → fenced text;
// anything else → a short note. The user's typed text goes last so it can refer back.
function anthropicUserContent(m) {
  const content = [];
  for (const a of m.attachments || []) {
    const buf = attBytes(a);
    if (!buf) continue;
    if (a.kind === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: buf.toString('base64') } });
    else if (a.kind === 'pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });
    else if (a.kind === 'text') content.push({ type: 'text', text: textAttachmentBlock(a, buf) });
    else content.push({ type: 'text', text: unreadableNote(a) });
  }
  if (m.text) content.push({ type: 'text', text: m.text });
  if (!content.length) content.push({ type: 'text', text: '' });
  return content;
}

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: anthropicUserContent(m) });
    else if (m.role === 'assistant') {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls || []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      if (content.length) out.push({ role: 'assistant', content });
    } else if (m.role === 'tools') {
      out.push({
        role: 'user',
        content: m.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: String(r.content ?? ''), is_error: !!r.isError })),
      });
    }
  }
  return out;
}

async function anthropicStream({ p, model, system, messages, tools, onEvent, signal, maxTokens, sampling }) {
  if (!p.apiKey) throw new Error('Anthropic API key not configured (Settings → Providers)');
  const client = new Anthropic({ apiKey: p.apiKey });
  const req = {
    model, max_tokens: maxTokens, stream: true,
    system: system || undefined,
    messages: toAnthropicMessages(messages),
    ...samplingParams('anthropic', sampling),
  };
  if (tools?.length) req.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));

  const stream = await client.messages.create(req, { signal });
  const sink = makeReasoningSink(onEvent);
  const toolCalls = [];
  const usage = { input: 0, output: 0 };
  let stopReason = null;
  const blocks = {}; // index -> {type, id, name, json}

  for await (const ev of stream) {
    if (signal?.aborted) break;
    switch (ev.type) {
      case 'message_start':
        usage.input = ev.message?.usage?.input_tokens || 0;
        break;
      case 'content_block_start': {
        const b = ev.content_block;
        blocks[ev.index] = { type: b.type, id: b.id, name: b.name, json: '' };
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta;
        if (d.type === 'text_delta') sink.feedText(d.text);
        else if (d.type === 'thinking_delta') sink.feedReasoning(d.thinking);
        else if (d.type === 'input_json_delta') { blocks[ev.index].json += d.partial_json; }
        break;
      }
      case 'content_block_stop': {
        const b = blocks[ev.index];
        if (b?.type === 'tool_use') {
          let args = {};
          try { args = b.json ? JSON.parse(b.json) : {}; } catch { args = { _raw: b.json }; }
          const call = { id: b.id, name: b.name, args };
          toolCalls.push(call);
          onEvent?.({ type: 'toolCall', call });
        }
        break;
      }
      case 'message_delta':
        stopReason = ev.delta?.stop_reason || stopReason;
        usage.output = ev.usage?.output_tokens || usage.output;
        break;
    }
  }
  sink.flush();
  onEvent?.({ type: 'usage', ...usage });
  return { text: sink.text, reasoning: sink.reasoning, toolCalls, usage, stopReason };
}

// --- OpenAI-compatible ---

// Vision servers (llama.cpp, vLLM, LM Studio…) take images as `image_url` parts with a
// data: URL. With no attachments we keep `content` a plain string for max compatibility.
function openaiUserContent(m) {
  if (!m.attachments?.length) return m.text || '';
  const parts = [];
  if (m.text) parts.push({ type: 'text', text: m.text });
  for (const a of m.attachments) {
    const buf = attBytes(a);
    if (!buf) continue;
    if (a.kind === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${buf.toString('base64')}` } });
    else if (a.kind === 'text') parts.push({ type: 'text', text: textAttachmentBlock(a, buf) });
    else parts.push({ type: 'text', text: unreadableNote(a) });
  }
  return parts.length ? parts : (m.text || '');
}

function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: openaiUserContent(m) });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || '' };
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }));
      out.push(msg);
    } else if (m.role === 'tools') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: String(r.content ?? '') });
    }
  }
  return out;
}

// Ollama's native /api/chat carries images per-message as a base64 array (no data: URL),
// which is different from the OpenAI `image_url` shape — so it gets its own converter.
function toOllamaMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      let content = m.text || '';
      const images = [];
      for (const a of m.attachments || []) {
        const buf = attBytes(a);
        if (!buf) continue;
        if (a.kind === 'image') images.push(buf.toString('base64'));
        else if (a.kind === 'text') content += (content ? '\n\n' : '') + textAttachmentBlock(a, buf);
        else content += (content ? '\n\n' : '') + unreadableNote(a);
      }
      const msg = { role: 'user', content };
      if (images.length) msg.images = images;
      out.push(msg);
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || '' };
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }));
      out.push(msg);
    } else if (m.role === 'tools') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: String(r.content ?? '') });
    }
  }
  return out;
}

async function openaiStream({ p, model, system, messages, tools, onEvent, signal, maxTokens, sampling }) {
  const body = {
    model, stream: true, max_tokens: maxTokens,
    messages: toOpenAIMessages(system, messages),
    stream_options: { include_usage: true },
    ...samplingParams('openai', sampling),
  };
  if (tools?.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

  const r = await fetch(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${p.name || 'provider'} error ${r.status}: ${(await r.text()).slice(0, 300)}`);

  const sink = makeReasoningSink(onEvent);
  const callsAcc = {}; // index -> {id,name,args:''}
  const usage = { input: 0, output: 0 };
  let stopReason = null;

  for await (const data of sseLines(r.body, signal)) {
    if (data === '[DONE]') break;
    let j; try { j = JSON.parse(data); } catch { continue; }
    if (j.usage) { usage.input = j.usage.prompt_tokens || usage.input; usage.output = j.usage.completion_tokens || usage.output; }
    const ch = j.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) stopReason = ch.finish_reason;
    const d = ch.delta || {};
    // llama.cpp/DeepSeek/vLLM expose reasoning separately from the answer.
    // reasoning_content and reasoning are aliases — consume only one per chunk.
    if (d.reasoning_content) sink.feedReasoning(d.reasoning_content);
    else if (d.reasoning) sink.feedReasoning(d.reasoning);
    if (d.content) sink.feedText(d.content);
    for (const tc of d.tool_calls || []) {
      const slot = (callsAcc[tc.index] ||= { id: tc.id || genId(8), name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      // name usually arrives once; guard against providers that resend it every chunk
      if (tc.function?.name && !slot.name.endsWith(tc.function.name)) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
  }

  sink.flush();
  const toolCalls = Object.keys(callsAcc).sort((a, b) => a - b).map(k => {
    const c = callsAcc[k];
    let args = {}; try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { _raw: c.args }; }
    const call = { id: c.id, name: c.name, args };
    onEvent?.({ type: 'toolCall', call });
    return call;
  });
  onEvent?.({ type: 'usage', ...usage });
  return { text: sink.text, reasoning: sink.reasoning, toolCalls, usage, stopReason: toolCalls.length ? 'tool_use' : (stopReason || 'stop') };
}

// --- Ollama native ---

async function ollamaStream({ p, model, system, messages, tools, onEvent, signal, sampling }) {
  const body = { model, stream: true, messages: toOllamaMessages(system, messages) };
  const opts = samplingParams('ollama', sampling);
  if (Object.keys(opts).length) body.options = opts;
  if (tools?.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

  const r = await fetch(`${p.baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ollama error ${r.status}: ${(await r.text()).slice(0, 300)}`);

  const sink = makeReasoningSink(onEvent);
  const toolCalls = [];
  const usage = { input: 0, output: 0 };

  for await (const line of ndjsonLines(r.body, signal)) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const m = j.message || {};
    if (m.thinking) sink.feedReasoning(m.thinking);
    if (m.content) sink.feedText(m.content);
    for (const tc of m.tool_calls || []) {
      const call = { id: genId(8), name: tc.function?.name, args: tc.function?.arguments || {} };
      toolCalls.push(call);
      onEvent?.({ type: 'toolCall', call });
    }
    if (j.done) { usage.input = j.prompt_eval_count || 0; usage.output = j.eval_count || 0; }
  }
  sink.flush();
  onEvent?.({ type: 'usage', ...usage });
  return { text: sink.text, reasoning: sink.reasoning, toolCalls, usage, stopReason: toolCalls.length ? 'tool_use' : 'stop' };
}

// ---------- stream body parsers ----------

// How long a stream may go with NO bytes at all before we declare it dead. This is a
// wedge detector, not a slowness cap: a local model legitimately sends nothing for
// minutes while it processes a long prompt (measured ~4 min to first token on an 8GB
// GPU with a 10k-token prompt), so the bar is deliberately high. What it catches is a
// provider that dies without closing the socket — without this, reader.read() blocks
// forever and whatever awaited the stream (a chat, an agent run, a Learning Corner
// subject's lock) hangs until the server restarts.
// 8 min: measured ~4 min of silent prompt processing on this machine's worst case
// (10k-token prompt, layers evicted to CPU) — double it so a slow-but-alive run is
// never killed, while a truly wedged one still surfaces instead of hanging forever.
const STREAM_STALL_MS = Number(process.env.AIOS_STREAM_STALL_MS) || 480_000;   // env override is for tests

async function* rawLines(body, signal, sep = '\n') {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) { try { await reader.cancel(); } catch { } return; }
      let stallTimer;
      let chunk;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise((_, rej) => { stallTimer = setTimeout(() => rej(new Error(`stream stalled — no data for ${STREAM_STALL_MS / 1000}s (the model server may have wedged; stop and retry)`)), STREAM_STALL_MS); }),
        ]);
      } catch (e) {
        try { await reader.cancel(); } catch { }
        throw e;
      } finally { clearTimeout(stallTimer); }
      const { done, value } = chunk;
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf(sep)) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + sep.length);
        yield line;
      }
    }
    if (buf.trim()) yield buf;
  } finally { try { reader.releaseLock(); } catch { } }
}

async function* sseLines(body, signal) {
  for await (const line of rawLines(body, signal)) {
    const l = line.trim();
    if (l.startsWith('data:')) yield l.slice(5).trim();
  }
}

async function* ndjsonLines(body, signal) {
  for await (const line of rawLines(body, signal)) {
    const l = line.trim();
    if (l) yield l;
  }
}
