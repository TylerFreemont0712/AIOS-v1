// Cheap syntax gates for agent-written files. Not linters, not type checkers —
// just "does this file parse", so a small model gets immediate feedback on typos.
// esbuild (already a dependency of AIOS) covers js/jsx/ts/tsx/css regardless of
// what's installed in the target project; python/bash checkers run when present.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { safePath } from './util.js';

let esbuildPromise;
const esbuild = () => esbuildPromise ??= import('esbuild').then(m => (m.transform ? m : m.default)).catch(() => null);

const available = {};
function hasCmd(cmd) {
  if (available[cmd] === undefined) available[cmd] = spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
  return available[cmd];
}

const ESBUILD_LOADERS = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx', '.css': 'css' };

const pass = (file, checker) => ({ file, checker, ok: true, output: '' });
const fail = (file, checker, output) => ({ file, checker, ok: false, output: String(output || 'unknown error').trim() });

/**
 * Syntax-check one file. Returns { file, ok, checker, output } or null when
 * no checker applies (unknown extension, binary, missing, too big).
 */
export async function checkFile(root, rel) {
  if (!rel || typeof rel !== 'string') return null;
  let abs;
  try { abs = safePath(root, rel); } catch { return null; }
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile() || st.size > 2_000_000) return null;
  const ext = path.extname(abs).toLowerCase();

  try {
    if (ESBUILD_LOADERS[ext]) {
      const es = await esbuild();
      if (!es) return null;
      try {
        await es.transform(fs.readFileSync(abs, 'utf8'), { loader: ESBUILD_LOADERS[ext], logLevel: 'silent' });
        return pass(rel, 'esbuild');
      } catch (e) {
        const msgs = (e.errors || []).slice(0, 5)
          .map(er => `${rel}:${er.location?.line ?? '?'}:${er.location?.column ?? '?'} ${er.text}`);
        return fail(rel, 'esbuild', msgs.join('\n') || e.message);
      }
    }

    if (ext === '.json') {
      try { JSON.parse(fs.readFileSync(abs, 'utf8')); return pass(rel, 'json'); }
      catch (e) { return fail(rel, 'json', `${rel}: ${e.message}`); }
    }

    if (ext === '.py' && hasCmd('python3')) {
      const r = spawnSync('python3', ['-c', 'import ast,sys\nast.parse(open(sys.argv[1]).read(), sys.argv[1])', abs],
        { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) return pass(rel, 'python ast');
      const tail = (r.stderr || '').trim().split('\n').slice(-4).join('\n');
      return fail(rel, 'python ast', tail.replaceAll(abs, rel));
    }

    if ((ext === '.sh' || ext === '.bash') && hasCmd('bash')) {
      const r = spawnSync('bash', ['-n', abs], { encoding: 'utf8', timeout: 5000 });
      return r.status === 0 ? pass(rel, 'bash -n') : fail(rel, 'bash -n', (r.stderr || '').replaceAll(abs, rel));
    }
  } catch { return null; }
  return null;
}

/** Check many files; results only for files a checker applies to. */
export async function checkFiles(root, rels) {
  const out = [];
  for (const rel of rels) {
    const r = await checkFile(root, rel);
    if (r) out.push(r);
  }
  return out;
}

// ---------- project test runner (verify loop v2) ----------

const readIf = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/**
 * Figure out how this project runs its tests. Priority:
 * an explicit `verify: <command>` line in .aios/instructions.md, then the
 * ecosystem defaults. Returns { cmd, via } or null when the project has none.
 */
export function detectTestCommand(root) {
  const inst = readIf(path.join(root, '.aios', 'instructions.md'));
  const explicit = inst.match(/^verify:\s*(.+)$/mi)?.[1]?.trim();
  if (explicit) return { cmd: explicit, via: '.aios/instructions.md' };

  const pkg = readIf(path.join(root, 'package.json'));
  if (pkg) {
    try {
      const test = JSON.parse(pkg).scripts?.test;
      if (test && !/no test specified/i.test(test)) return { cmd: 'npm test --silent', via: 'package.json' };
    } catch { }
  }
  const pyproject = readIf(path.join(root, 'pyproject.toml'));
  if ((fs.existsSync(path.join(root, 'pytest.ini')) || /\[tool\.pytest/i.test(pyproject)) && hasCmd('python3')) {
    return { cmd: 'python3 -m pytest -x -q', via: 'pytest config' };
  }
  if (/^test:/m.test(readIf(path.join(root, 'Makefile'))) && hasCmd('make')) return { cmd: 'make test', via: 'Makefile' };
  if (fs.existsSync(path.join(root, 'Cargo.toml')) && hasCmd('cargo')) return { cmd: 'cargo test --quiet', via: 'Cargo.toml' };
  if (fs.existsSync(path.join(root, 'go.mod')) && hasCmd('go')) return { cmd: 'go test ./...', via: 'go.mod' };
  return null;
}

/** Run the project's tests, bounded and async (never blocks the server loop).
 *  Resolves { ok, cmd, via, output, ms } — or null when the project has no tests. */
export function runProjectTests(root, { timeoutMs = 120_000 } = {}) {
  const t = detectTestCommand(root);
  if (!t) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('/bin/bash', ['-c', t.cmd], {
      cwd: root, detached: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
    let out = '';
    let killed = false;
    const kill = () => { killed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } } };
    const timer = setTimeout(kill, timeoutMs);
    child.stdout.on('data', d => { out += d; if (out.length > 200_000) kill(); });
    child.stderr.on('data', d => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, cmd: t.cmd, via: t.via, output: 'spawn error: ' + e.message, ms: Date.now() - t0 }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let output = out.trim();
      if (output.length > 8000) output = output.slice(0, 3000) + '\n… (middle trimmed) …\n' + output.slice(-4500);
      if (killed) output = `(killed: ${Math.round(timeoutMs / 1000)}s timeout or output cap)\n` + output;
      resolve({ ok: !killed && code === 0, cmd: t.cmd, via: t.via, output, ms: Date.now() - t0 });
    });
  });
}
