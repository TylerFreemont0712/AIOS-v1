// REST + WebSocket client. Token comes from ?token= (stored, then stripped) or localStorage.

let token = null;
{
  const u = new URL(location.href);
  const t = u.searchParams.get('token');
  if (t) {
    localStorage.setItem('aios.token', t);
    u.searchParams.delete('token');
    history.replaceState(null, '', u.pathname + u.search);
  }
  token = localStorage.getItem('aios.token') || '';
}

export function setToken(t) { token = t; localStorage.setItem('aios.token', t); }

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    opts = { ...opts, body: JSON.stringify(opts.body) };
    headers['content-type'] = 'application/json';
  }
  if (token) headers['authorization'] = 'Bearer ' + token;
  const r = await fetch('/api' + path, { ...opts, headers });
  if (r.status === 401) {
    document.dispatchEvent(new CustomEvent('aios:unauthorized'));
    throw new Error('unauthorized — enter the pairing token');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const del = (p) => api(p, { method: 'DELETE' });

/** URL for an API resource loaded by the browser directly (<img>, links) — carries the
 *  pairing token as a query param since those requests can't send an auth header. */
export function mediaUrl(p) {
  return '/api' + p + (token ? (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : '');
}

/**
 * Store a File server-side; resolves to its metadata.
 *
 * Photos are decoded, downscaled and re-encoded as JPEG here first — this is what makes
 * an iPhone HEIC work, since no model provider accepts HEIC and Safari can always
 * decode it locally (see imageprep.js). If this browser cannot decode the file we send
 * the original bytes and the server converts with ffmpeg instead, so the upload still
 * succeeds; it just costs a subprocess.
 *
 * The bytes go up as a binary body rather than base64 inside JSON: base64 inflates a
 * 4MB photo by a third and then has to be parsed and decoded server-side, which
 * measured 3x slower and ~50MB of heap churn per upload.
 */
export async function uploadFile(file) {
  let name = file.name || 'file';
  let body = file;
  try {
    const { prepareImage } = await import('./imageprep.js');
    const prepped = await prepareImage(file);
    if (prepped) { body = prepped.blob; name = prepped.name; }
  } catch { /* prep unavailable or refused the file — upload it as it came */ }

  return uploadBlob(body, name, body.type || file.type || '');
}

/** Store a Blob (or File) server-side as-is; resolves to its metadata. Callers that
 *  have already prepared an image — the phone's receipt flow — use this directly. */
export async function uploadBlob(body, name, mime = '') {
  const type = mime || body.type || '';
  const qs = `?name=${encodeURIComponent(name || 'file')}&mime=${encodeURIComponent(type)}`;
  const headers = { 'content-type': type || 'application/octet-stream' };
  if (token) headers['authorization'] = 'Bearer ' + token;
  const r = await fetch('/api/uploads/raw' + qs, { method: 'POST', headers, body });
  if (r.status === 401) {
    document.dispatchEvent(new CustomEvent('aios:unauthorized'));
    throw new Error('unauthorized — enter the pairing token');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

// ---------- websocket ----------

let ws = null;
let wsReady = false;
const queue = [];
const subs = new Map();     // topic -> Set<fn>
const typeHandlers = new Map(); // msg type -> Set<fn>
let reconnectDelay = 500;

export function wsSend(obj) {
  if (wsReady) ws.send(JSON.stringify(obj));
  else queue.push(obj);
}

/** Subscribe to a server-published topic. Returns unsubscribe fn. */
export function sub(topic, fn) {
  if (!subs.has(topic)) { subs.set(topic, new Set()); wsSend({ t: 'sub', topic }); }
  subs.get(topic).add(fn);
  return () => {
    const set = subs.get(topic);
    if (!set) return;
    set.delete(fn);
    if (!set.size) { subs.delete(topic); wsSend({ t: 'unsub', topic }); }
  };
}

/** Listen for a direct message type (term.out, pong, error…). Returns off fn. */
export function onWS(type, fn) {
  if (!typeHandlers.has(type)) typeHandlers.set(type, new Set());
  typeHandlers.get(type).add(fn);
  return () => typeHandlers.get(type)?.delete(fn);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws${token ? '?token=' + encodeURIComponent(token) : ''}`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    wsReady = true;
    reconnectDelay = 500;
    for (const topic of subs.keys()) ws.send(JSON.stringify({ t: 'sub', topic }));
    while (queue.length) ws.send(JSON.stringify(queue.shift()));
    document.dispatchEvent(new CustomEvent('aios:ws', { detail: { up: true } }));
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    for (const fn of typeHandlers.get(m.t) || []) { try { fn(m); } catch (err) { console.error(err); } }
    // topic fanout: the server stamps _topic on every published message, so any
    // stream (agent/chat/research/comfy/gh.suggest/vault.ai) routes generically.
    // Legacy fallbacks kept in case an older server omits _topic.
    const topic = m._topic ||
      (m.t === 'agent.event' ? `agent:${m.sessionId}` :
       m.t === 'chat.event' ? `chat:${m.chatId}` :
       m.t === 'vault.ai' ? `vaultai:${m.reqId}` : null);
    if (topic) for (const fn of subs.get(topic) || []) { try { fn(m); } catch (err) { console.error(err); } }
  };
  ws.onclose = () => {
    wsReady = false;
    document.dispatchEvent(new CustomEvent('aios:ws', { detail: { up: false } }));
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
  };
  ws.onerror = () => { try { ws.close(); } catch { } };
}
connect();
setInterval(() => wsReady && wsSend({ t: 'ping' }), 25000);
