// Service health for the Home dashboard. A small, modular registry so any
// "can-be-offline" dependency shows a live status — and future services just
// call registerService() with a probe.
//
// Each entry resolves to { id, name, group, status, detail, settingsTab? }.
// status: 'up' (green) · 'down' (red — configured but failing) · 'off' (gray —
// not configured/optional) · 'warn' (amber) · 'unknown'.

import fs from 'node:fs';
import { loadConfig } from './config.js';
import { probeProviders } from './llm.js';
import { searxngStatus } from './tools.js';

const extra = []; // future services register here

/** Register an additional service probe. `probe(cfg)` returns { status, detail }. */
export function registerService(svc) { extra.push(svc); return svc; }

export async function probeServices() {
  const cfg = loadConfig();
  const out = [];

  // web search (SearXNG)
  try {
    const sx = await searxngStatus();
    out.push({
      id: 'searxng', name: 'SearXNG', group: 'Search', settingsTab: 'tools',
      status: !sx.url ? 'off' : sx.up ? 'up' : 'down',
      detail: sx.up ? sx.url : (sx.url ? 'not responding' : 'not configured'),
    });
  } catch (e) { out.push({ id: 'searxng', name: 'SearXNG', group: 'Search', settingsTab: 'tools', status: 'down', detail: e.message }); }

  // model providers
  try {
    const pv = await probeProviders();
    out.push({
      id: 'anthropic', name: 'Anthropic', group: 'Models', settingsTab: 'providers',
      status: pv.anthropic.configured ? 'up' : 'off',
      detail: pv.anthropic.configured ? 'API key set' : 'no key',
    });
    out.push({
      id: 'ollama', name: 'Ollama', group: 'Models', settingsTab: 'providers',
      status: pv.ollama.up ? 'up' : 'off',
      detail: pv.ollama.up ? `${pv.ollama.models} model${pv.ollama.models === 1 ? '' : 's'}` : 'not running',
    });
    for (const c of pv.custom) out.push({
      id: 'custom_' + c.id, name: c.name, group: 'Models', settingsTab: 'providers',
      status: c.up ? 'up' : 'down', detail: c.up ? 'reachable' : 'unreachable',
    });
  } catch (e) { out.push({ id: 'models', name: 'Model providers', group: 'Models', settingsTab: 'providers', status: 'down', detail: e.message }); }

  // second brain (vault)
  const vpath = cfg.vault?.path;
  const vaultOk = vpath && fs.existsSync(vpath);
  out.push({
    id: 'vault', name: 'Second brain', group: 'Data', settingsTab: 'vault',
    status: !vpath ? 'off' : vaultOk ? 'up' : 'down',
    detail: !vpath ? 'not connected' : vaultOk ? 'connected' : 'path missing',
  });

  // future services
  for (const s of extra) {
    try { const r = await s.probe(cfg); out.push({ id: s.id, name: s.name, group: s.group || 'Service', settingsTab: s.settingsTab, status: r.status || 'unknown', detail: r.detail || '' }); }
    catch (e) { out.push({ id: s.id, name: s.name, group: s.group || 'Service', settingsTab: s.settingsTab, status: 'down', detail: e.message }); }
  }

  return out;
}
