#!/usr/bin/env node
// E2E runner: executes every scripts/e2e/*.e2e.mjs sequentially (each suite owns
// its ports and temp dirs, and cleans up after itself). The loop-level complement
// to `npm run audit` — mock LLM providers driving the real agent, a mock GitHub
// API, live REST on a throwaway instance, and offline unit suites.
//
//   npm run e2e            all suites
//   npm run e2e -- github  suites whose filename matches "github"

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e');
const filter = process.argv[2] || '';
const suites = fs.readdirSync(DIR).filter(f => f.endsWith('.e2e.mjs') && f.includes(filter)).sort();
if (!suites.length) { console.error(`no suites match "${filter}"`); process.exit(1); }

const results = [];
for (const f of suites) {
  const t0 = Date.now();
  process.stdout.write(`\n━━ ${f} ━━\n`);
  const r = spawnSync('node', [path.join(DIR, f)], { stdio: 'inherit', timeout: 10 * 60_000 });
  results.push({ f, ok: r.status === 0, secs: Math.round((Date.now() - t0) / 1000) });
}

console.log('\n' + '═'.repeat(56));
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.f.padEnd(28)} ${r.secs}s`);
const failed = results.filter(r => !r.ok);
console.log(`${results.length - failed.length}/${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
