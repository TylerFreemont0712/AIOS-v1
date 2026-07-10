// Manage the bundled SearXNG metasearch instance (Docker).
//   npm run searxng             start it (writes config with a fresh secret on first run)
//   npm run searxng -- regen    rewrite config with the current engine set + restart
//   npm run searxng -- down     stop it
//   npm run searxng -- status   check whether it's answering
//   npm run searxng -- logs     tail container logs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'searxng');
const composeFile = path.join(dir, 'docker-compose.yml');
const settingsFile = path.join(dir, 'config', 'settings.yml');
const CONTAINER = 'aios-searxng';
const BASE = 'http://127.0.0.1:8890';
const cmd = process.argv[2] || 'up';

function settingsYaml() {
  return `# SearXNG settings for AIOS — overrides on top of the image defaults.
# The JSON format must stay enabled: the AIOS web_search tool depends on it.
use_default_settings: true
server:
  secret_key: "${crypto.randomBytes(24).toString('hex')}"
  limiter: false
  image_proxy: true
search:
  # keep JSON on for the web_search tool; html for browsing the instance directly
  formats:
    - html
    - json
outgoing:
  request_timeout: 6.0
  max_request_timeout: 12.0
# Enable a broad, resilient engine set — if Brave/DuckDuckGo get rate-limited,
# Google/Bing/Wikipedia/Mojeek still return results so searches rarely come back empty.
engines:
  - name: google
    disabled: false
  - name: bing
    disabled: false
  - name: duckduckgo
    disabled: false
  - name: brave
    disabled: false
  - name: wikipedia
    disabled: false
  - name: mojeek
    disabled: false
  - name: qwant
    disabled: false
`;
}

function ensureSettings() {
  if (fs.existsSync(settingsFile)) return;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, settingsYaml());
  console.log(`wrote ${path.relative(process.cwd(), settingsFile)}`);
}

// Once the container has run, it owns the mounted config dir (its uid), so the
// host user can't overwrite settings.yml directly. Push the new file in through
// Docker (root) via `docker cp`, which lands on the bind-mounted host file too.
function regenSettings() {
  const tmp = path.join(dir, '.settings.new.yml'); // dir itself is host-owned
  fs.writeFileSync(tmp, settingsYaml());
  const cp = spawnSync('docker', ['cp', tmp, `${CONTAINER}:/etc/searxng/settings.yml`], { stdio: 'inherit' });
  fs.rmSync(tmp, { force: true });
  if (cp.status !== 0) { console.error(`\n✗ could not write into ${CONTAINER} — is it running? start it with: npm run searxng`); process.exit(1); }
  compose('restart', 'searxng');
  console.log('✓ engines: google, bing, duckduckgo, brave, wikipedia, mojeek, qwant');
}

const compose = (...args) => spawnSync('docker', ['compose', '-f', composeFile, ...args], { stdio: 'inherit' });

async function probe(timeoutMs = 2000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { return (await fetch(BASE + '/healthz', { signal: ctl.signal })).ok; }
  catch { return false; }
  finally { clearTimeout(t); }
}

if (cmd === 'up') {
  ensureSettings();
  if (compose('up', '-d').status !== 0) {
    console.error('\n✗ docker compose failed — is Docker installed and running? (https://docs.docker.com/engine/install/)');
    process.exit(1);
  }
  process.stdout.write('waiting for SearXNG ');
  let up = false;
  for (let i = 0; i < 30 && !(up = await probe()); i++) {
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(up
    ? `\n✓ SearXNG is up at ${BASE} — the AIOS web_search tool will use it automatically.`
    : '\n✗ not answering after 30s — inspect with: npm run searxng -- logs');
  process.exit(up ? 0 : 1);
} else if (cmd === 'regen') {
  regenSettings();
} else if (cmd === 'down') {
  process.exit(compose('down').status ?? 1);
} else if (cmd === 'logs') {
  process.exit(compose('logs', '--tail', '100', 'searxng').status ?? 1);
} else if (cmd === 'status') {
  const up = await probe();
  console.log(up ? `✓ SearXNG is up at ${BASE}` : `✗ SearXNG is not answering at ${BASE} (start it with: npm run searxng)`);
  process.exit(up ? 0 : 1);
} else {
  console.error(`unknown command "${cmd}" — use up | down | status | logs`);
  process.exit(1);
}
