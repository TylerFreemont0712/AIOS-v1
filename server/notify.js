// Outbound notifications. Discord webhook for now; add channels here (ntfy,
// Telegram, …). Nothing here fires on a schedule — a push only happens when the user
// tests the webhook or the agent's `notify` tool is called for something that matters.

import { loadConfig } from './config.js';

/** Post a message to the configured Discord webhook. Throws when unconfigured/failing. */
export async function sendDiscord(content) {
  const url = (loadConfig().notify?.discordWebhook || '').trim();
  if (!url) throw Object.assign(new Error('no Discord webhook configured (Settings → Mail & Alerts)'), { status: 400 });
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) {
    throw Object.assign(new Error('that does not look like a Discord webhook URL'), { status: 400 });
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: String(content).slice(0, 1900) }),
    });
    if (!r.ok && r.status !== 204) throw new Error(`Discord webhook error ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return { ok: true };
  } finally { clearTimeout(t); }
}

export function notifyStatus() {
  const n = loadConfig().notify || {};
  return { discord: !!n.discordWebhook };
}
