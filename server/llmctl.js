// AIOS-managed llama.cpp lifecycle (ownership approved 2026-07-11). Two profiles:
// 'big'  — the GPU daily driver (ornith-9b)
// 'tiny' — CPU-only (-ngl 0) tool-call model that frees ALL VRAM for ComfyUI.
// Pidfile discipline mirrors scripts/aios-launch.sh; a llama-server started by the
// old PyQt launcher is treated as "foreign" and replaced on the first swap.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA, loadConfig } from './config.js';

const DIR = path.join(DATA, 'llm');
const PIDFILE = path.join(DIR, 'llama.pid');
const PROFILE_FILE = path.join(DIR, 'profile');
const LOG = path.join(DIR, 'llama.log');

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const readPid = () => { try { return Number(fs.readFileSync(PIDFILE, 'utf8').trim()) || 0; } catch { return 0; } };
const alive = (pid) => { try { return pid > 0 && (process.kill(pid, 0), true); } catch { return false; } };
const isLlama = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('llama-server'); } catch { return false; } };

/** llama-server processes AIOS did not start (e.g. the PyQt launcher's child). */
function foreignPids() {
  const r = spawnSync('pgrep', ['-f', 'llama-server --model'], { encoding: 'utf8', timeout: 4000 });
  const own = readPid();
  return (r.stdout || '').split('\n').filter(Boolean).map(Number).filter(p => p && p !== own);
}

export function llmStatus() {
  const cfg = loadConfig().llm || {};
  const pid = readPid();
  const mine = alive(pid) && isLlama(pid);
  let profile = '';
  try { profile = fs.readFileSync(PROFILE_FILE, 'utf8').trim(); } catch { }
  const foreign = foreignPids();
  return {
    managed: cfg.managed !== false,
    running: mine, profile: mine ? profile : '',
    foreign: !mine && foreign.length > 0,
    pid: mine ? pid : (foreign[0] || 0),
    port: cfg.port || 8080,
    profiles: Object.keys(cfg.profiles || {}),
  };
}

/** Open the PyQt launcher GUI on the user's desktop (Whisper/MusicGen/manual llama).
 *  Best-effort DISPLAY: inherit if the server has one, else fall back to :0. */
export function openLauncher() {
  const cfg = loadConfig().llm || {};
  const sh = cfg.launcher;
  if (!sh || !fs.existsSync(sh)) throw err(`launcher not found at ${sh || '(unset)'} — set llm.launcher`, 500);
  const env = { ...process.env };
  if (!env.DISPLAY) env.DISPLAY = ':0';
  if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${os.userInfo().uid}`;
  const child = spawn('/bin/bash', [sh], { detached: true, stdio: 'ignore', env });
  child.unref();
  return { ok: true, launcher: sh, display: env.DISPLAY };
}

async function healthy(port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal }).finally(() => clearTimeout(t));
    return r.ok;
  } catch { return false; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function killPid(pid) {
  if (!alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { }
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { } }
}

/** Stop every llama-server (ours AND foreign) and wait for the port to free. */
export async function stopLlama() {
  const cfg = loadConfig().llm || {};
  const own = readPid();
  if (alive(own) && isLlama(own)) await killPid(own);
  for (const p of foreignPids()) if (isLlama(p)) await killPid(p);
  try { fs.unlinkSync(PIDFILE); } catch { }
  try { fs.unlinkSync(PROFILE_FILE); } catch { }
  for (let i = 0; i < 20 && await healthy(cfg.port || 8080); i++) await sleep(250);
  return { stopped: true };
}

/**
 * Start (or switch to) a profile. Kills whatever llama-server currently runs,
 * spawns the new one detached with logs at data/llm/llama.log, and waits for
 * /health. Model load can take a while for the big profile — be patient.
 */
export async function startProfile(name) {
  const cfg = loadConfig().llm || {};
  if (cfg.managed === false) throw err('AIOS llama management is disabled (config llm.managed)');
  const p = cfg.profiles?.[name];
  if (!p) throw err(`unknown llm profile "${name}" — have: ${Object.keys(cfg.profiles || {}).join(', ')}`);
  if (!fs.existsSync(cfg.binary)) throw err(`llama-server binary not found at ${cfg.binary}`, 500);
  if (!fs.existsSync(p.model)) throw err(`model file missing: ${p.model} — is the download finished?`, 500);

  const cur = llmStatus();
  if (cur.running && cur.profile === name && await healthy(cfg.port || 8080)) return { ok: true, profile: name, already: true };

  await stopLlama();
  fs.mkdirSync(DIR, { recursive: true });
  const args = ['--model', p.model, '--host', '0.0.0.0', '--port', String(cfg.port || 8080), '--alias', p.alias || name, ...(p.args || [])];
  const out = fs.openSync(LOG, 'a');
  fs.writeSync(out, `\n===== ${new Date().toISOString()} starting profile "${name}" =====\n`);
  const child = spawn(cfg.binary, args, { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  fs.writeFileSync(PROFILE_FILE, name);

  const budget = name === 'tiny' ? 60_000 : 240_000;   // big model loads take a while
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    if (await healthy(cfg.port || 8080)) return { ok: true, profile: name, ms: Date.now() - t0 };
    if (!alive(child.pid)) break;
    await sleep(1000);
  }
  let tail = '';
  try { tail = fs.readFileSync(LOG, 'utf8').slice(-600); } catch { }
  throw err(`llama-server (${name}) did not become healthy — log tail:\n${tail}`, 500);
}
