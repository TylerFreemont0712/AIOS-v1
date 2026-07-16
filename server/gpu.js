// GPU visibility for the VRAM guard: one nvidia-smi query, no dependencies.

import { spawnSync } from 'node:child_process';

let hasSmi = null;

/** { name, totalMB, usedMB, freeMB } or null (no NVIDIA GPU / driver). */
export function gpuStats() {
  if (hasSmi === false) return null;
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) { hasSmi = false; return null; }
    hasSmi = true;
    const [name, total, used] = r.stdout.trim().split('\n')[0].split(',').map(s => s.trim());
    return { name, totalMB: +total || 0, usedMB: +used || 0, freeMB: (+total || 0) - (+used || 0) };
  } catch { hasSmi = false; return null; }
}
