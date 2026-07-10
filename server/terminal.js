// Browser terminals: real PTYs via node-pty when available, with a util-linux
// `script` fallback so the terminal still works if the native module is missing.

import { spawn as spawnProc } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

let pty = null;
try { pty = (await import('node-pty')).default ?? await import('node-pty'); } catch { /* fallback below */ }

const terms = new Map(); // id -> { kind, proc, client }

export function openTerminal({ id, cols = 120, rows = 30, cwd }, client) {
  closeTerminal(id);
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const shell = process.env.SHELL || '/bin/bash';

  if (pty?.spawn) {
    const p = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color', cols, rows, cwd: dir,
      env: { ...process.env, TERM: 'xterm-256color', AIOS: '1' },
    });
    p.onData(d => client.send({ t: 'term.out', id, data: d }));
    p.onExit(({ exitCode }) => { client.send({ t: 'term.exit', id, code: exitCode }); terms.delete(id); });
    terms.set(id, { kind: 'pty', proc: p, client });
  } else {
    // `script` gives the child a real tty; resize is unsupported here.
    const p = spawnProc('script', ['-qfc', shell + ' -l', '/dev/null'], {
      cwd: dir, env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows), AIOS: '1' },
    });
    p.stdout.on('data', d => client.send({ t: 'term.out', id, data: d.toString() }));
    p.stderr.on('data', d => client.send({ t: 'term.out', id, data: d.toString() }));
    p.on('close', code => { client.send({ t: 'term.exit', id, code }); terms.delete(id); });
    terms.set(id, { kind: 'pipe', proc: p, client });
  }
  client.send({ t: 'term.ready', id, pty: !!pty?.spawn });
}

export function termInput(id, data) {
  const t = terms.get(id);
  if (!t) return;
  if (t.kind === 'pty') t.proc.write(data);
  else t.proc.stdin.write(data);
}

export function termResize(id, cols, rows) {
  const t = terms.get(id);
  if (t?.kind === 'pty') { try { t.proc.resize(Math.max(2, cols), Math.max(2, rows)); } catch { } }
}

export function closeTerminal(id) {
  const t = terms.get(id);
  if (!t) return;
  try { t.kind === 'pty' ? t.proc.kill() : t.proc.kill('SIGKILL'); } catch { }
  terms.delete(id);
}

export function closeClientTerminals(client) {
  for (const [id, t] of terms) if (t.client === client) closeTerminal(id);
}
