// Static sanity check: bundle the frontend from its entry to catch syntax errors,
// unresolved imports, and missing exports. Also parse-checks every server module.
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;

// frontend: full bundle resolution (output discarded). Every HTML entry point
// needs listing — the phone shell at /m has its own and shares no code with the
// desktop bundle beyond api.js.
const ENTRIES = ['web/js/main.js', 'web/js/mobile/app.js'];
for (const entry of ENTRIES) {
  try {
    await build({
      entryPoints: [join(root, entry)],
      bundle: true, write: false, format: 'esm', logLevel: 'silent',
    });
    console.log(`✓ ${entry} bundles cleanly`);
  } catch (e) {
    failed = true;
    console.error(`✗ ${entry} errors:`);
    for (const err of e.errors || []) console.error(`  ${err.location?.file}:${err.location?.line} ${err.text}`);
  }
}

// server: node --check each module (parse only)
for (const f of readdirSync(join(root, 'server')).filter(f => f.endsWith('.js'))) {
  const r = spawnSync(process.execPath, ['--check', join(root, 'server', f)], { encoding: 'utf8' });
  if (r.status !== 0) { failed = true; console.error(`✗ server/${f}: ${r.stderr.split('\n')[0]}`); }
}
if (!failed) console.log('✓ server modules parse');
process.exit(failed ? 1 : 0);
