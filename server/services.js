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

  // Each entry resolves to one-or-more chips. Everything runs CONCURRENTLY so a
  // slow/unreachable service (network timeout) can't stall the whole row, while
  // the output order stays stable for the dashboard.
  const searxng = (async () => {
    try {
      const sx = await searxngStatus();
      return [{ id: 'searxng', name: 'SearXNG', group: 'Search', settingsTab: 'tools',
        status: !sx.url ? 'off' : sx.up ? 'up' : 'down',
        detail: sx.up ? sx.url : (sx.url ? 'not responding' : 'not configured') }];
    } catch (e) { return [{ id: 'searxng', name: 'SearXNG', group: 'Search', settingsTab: 'tools', status: 'down', detail: e.message }]; }
  })();

  const providers = (async () => {
    try {
      const pv = await probeProviders();
      return [
        { id: 'anthropic', name: 'Anthropic', group: 'Models', settingsTab: 'providers', status: pv.anthropic.configured ? 'up' : 'off', detail: pv.anthropic.configured ? 'API key set' : 'no key' },
        { id: 'ollama', name: 'Ollama', group: 'Models', settingsTab: 'providers', status: pv.ollama.up ? 'up' : 'off', detail: pv.ollama.up ? `${pv.ollama.models} model${pv.ollama.models === 1 ? '' : 's'}` : 'not running' },
        ...pv.custom.map(c => ({ id: 'custom_' + c.id, name: c.name, group: 'Models', settingsTab: 'providers', status: c.up ? 'up' : 'down', detail: c.up ? 'reachable' : 'unreachable' })),
      ];
    } catch (e) { return [{ id: 'models', name: 'Model providers', group: 'Models', settingsTab: 'providers', status: 'down', detail: e.message }]; }
  })();

  const vault = (async () => {
    const vpath = cfg.vault?.path;
    const vaultOk = vpath && fs.existsSync(vpath);
    return [{ id: 'vault', name: 'Second brain', group: 'Data', settingsTab: 'vault',
      status: !vpath ? 'off' : vaultOk ? 'up' : 'down',
      detail: !vpath ? 'not connected' : vaultOk ? 'connected' : 'path missing' }];
  })();

  const extras = extra.map(s => (async () => {
    try { const r = await s.probe(cfg); return [{ id: s.id, name: s.name, group: s.group || 'Service', settingsTab: s.settingsTab, status: r.status || 'unknown', detail: r.detail || '' }]; }
    catch (e) { return [{ id: s.id, name: s.name, group: s.group || 'Service', settingsTab: s.settingsTab, status: 'down', detail: e.message }]; }
  })());

  const groups = await Promise.all([searxng, providers, vault, ...extras]);
  return groups.flat();
}
