// Manage the bundled Firecrawl instance (Docker) — AIOS's headless scraping engine.
// Used by Job Search (structured indeed.jp results, annotation-platform checks) and
// available to anything else that needs JS-rendered pages.
//   npm run firecrawl             start it (fetches + adapts the official compose on first run)
//   npm run firecrawl -- down     stop it
//   npm run firecrawl -- status   is it answering?
//   npm run firecrawl -- logs     tail the api container logs
//   npm run firecrawl -- refresh  re-fetch the official compose (upgrades)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'firecrawl');
const composeFile = path.join(dir, 'docker-compose.yaml');
const PORT = process.env.FIRECRAWL_PORT || '8899';
const BASE = `http://127.0.0.1:${PORT}`;
const COMPOSE_URL = 'https://raw.githubusercontent.com/firecrawl/firecrawl/refs/heads/main/docker-compose.yaml';
const cmd = process.argv[2] || 'up';

// Fetch the official compose and flip it from build-from-source to the prebuilt
// GHCR images (the exact toggle the file's own NOTEs describe). We also drop the
// experimental FoundationDB services — the Postgres queue backend is the default.
async function ensureCompose(force = false) {
  if (fs.existsSync(composeFile) && !force) return;
  console.log('fetching official docker-compose.yaml…');
  const r = await fetch(COMPOSE_URL);
  if (!r.ok) { console.error(`✗ could not fetch compose (${r.status})`); process.exit(1); }
  let y = await r.text();
  y = y
    .replace(/^(\s*)# (image: ghcr\.io\/firecrawl\/firecrawl)\s*$/m, '$1$2:latest')
    .replace(/^(\s*)# (image: ghcr\.io\/firecrawl\/playwright-service:latest)\s*$/m, '$1$2')
    .replace(/^(\s*)# (image: ghcr\.io\/firecrawl\/nuq-postgres:latest)\s*$/m, '$1$2')
    .replace(/^\s*build: apps\/(api|playwright-service-ts|nuq-postgres)\s*$/gm, '');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(composeFile, y);
  console.log(`wrote ${path.relative(process.cwd(), composeFile)} (prebuilt images)`);
}

const compose = (...args) => spawnSync('docker', ['compose', '-p', 'aios-firecrawl', '-f', composeFile, ...args],
  { stdio: 'inherit', env: { ...process.env, PORT } });

async function probe(timeoutMs = 3000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    for (const p of ['/test', '/']) {
      try { const r = await fetch(BASE + p, { signal: ctl.signal }); if (r.status < 500) return true; } catch { }
    }
    return false;
  } finally { clearTimeout(t); }
}

if (cmd === 'up') {
  await ensureCompose();
  // api's depends_on covers redis/rabbitmq/playwright; nuq-postgres must be named.
  if (compose('up', '-d', '--no-build', 'api', 'nuq-postgres').status !== 0) {
    console.error('\n✗ docker compose failed — is Docker running?');
    process.exit(1);
  }
  process.stdout.write('waiting for Firecrawl ');
  let up = false;
  for (let i = 0; i < 60 && !(up = await probe()); i++) { process.stdout.write('.'); await new Promise(r => setTimeout(r, 2000)); }
  console.log(up
    ? `\n✓ Firecrawl is up at ${BASE} — set Settings → Job Search source to "firecrawl".`
    : `\n✗ not answering after 2 min — inspect with: npm run firecrawl -- logs`);
  process.exit(up ? 0 : 1);
} else if (cmd === 'down') {
  process.exit(compose('down').status ?? 1);
} else if (cmd === 'logs') {
  process.exit(compose('logs', '--tail', '120', 'api').status ?? 1);
} else if (cmd === 'refresh') {
  await ensureCompose(true);
  console.log('re-fetched — run `npm run firecrawl` to restart on the new file');
} else if (cmd === 'status') {
  const up = await probe();
  console.log(up ? `✓ Firecrawl is up at ${BASE}` : `✗ Firecrawl is not answering at ${BASE} (start it with: npm run firecrawl)`);
  process.exit(up ? 0 : 1);
} else {
  console.error(`unknown command "${cmd}" — use up | down | status | logs | refresh`);
  process.exit(1);
}
