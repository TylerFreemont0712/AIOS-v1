// The Voice-mode avatar: a reactive HUD ring the assistant "lives" in.
//
// Canvas rather than SVG or CSS because this redraws every frame against live audio,
// and a few hundred DOM mutations a second is how you make a laptop fan spin. One
// canvas, one requestAnimationFrame loop, no allocation inside it.
//
// What it draws, outward from the middle:
//
//   · a core disc that breathes with the overall level
//   · a radial spectrum — one spoke per frequency band, mirrored around the circle,
//     driven by the microphone while listening and by the ASSISTANT'S OWN voice while
//     speaking, so the ring is doing the same thing your ears are hearing
//   · two counter-rotating dashed rings, the outer one ticked like an instrument dial
//   · a sweep arc that only runs while it is thinking, because a HUD that animates
//     identically in every state tells you nothing
//
// Colour is state, not decoration: accent while listening, amber while it waits for a
// yes, green while speaking, muted grey when it has nothing to say.

const TAU = Math.PI * 2;

// Per-phase palette + behaviour. `spin` is radians/second for the dashed rings.
const LOOK = {
  idle: { key: '--accent', spin: 0.12, glow: 0.20, dim: 0.55 },
  listening: { key: '--accent', spin: 0.42, glow: 0.85, dim: 1 },
  transcribing: { key: '--accent', spin: 0.90, glow: 0.55, dim: 0.9 },
  thinking: { key: '--accent', spin: 1.30, glow: 0.55, dim: 0.9 },
  speaking: { key: '--ok', spin: 0.30, glow: 0.90, dim: 1 },
  answering: { key: '--muted', spin: 0.30, glow: 0.35, dim: 0.8 },
  confirm: { key: '--warn', spin: 0.18, glow: 0.80, dim: 1 },
  error: { key: '--err', spin: 0, glow: 0.30, dim: 0.7 },
};

const rgba = (rgb, a) => `rgba(${rgb.join(',')},${a})`;

/** Resolve a CSS custom property to [r,g,b] so canvas can use the live theme. */
function readColor(el, prop, fallback = [217, 119, 87]) {
  const raw = getComputedStyle(el).getPropertyValue(prop).trim();
  if (!raw) return fallback;
  if (raw.startsWith('#')) {
    const h = raw.length === 4
      ? raw.slice(1).split('').map(c => parseInt(c + c, 16))
      : [raw.slice(1, 3), raw.slice(3, 5), raw.slice(5, 7)].map(x => parseInt(x, 16));
    return h.some(Number.isNaN) ? fallback : h;
  }
  const m = raw.match(/-?\d+(\.\d+)?/g);
  return m && m.length >= 3 ? m.slice(0, 3).map(Number) : fallback;
}

export class VoiceOrb {
  constructor(canvas, { bands = 28 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.phase = 'idle';
    this.level = 0;
    this.n = bands;
    // Two buffers: the raw target and a smoothed copy. Drawing the raw values makes
    // the ring twitch on every frame; easing toward them reads as a physical object.
    this.target = new Float32Array(bands);
    this.shown = new Float32Array(bands);
    this.t = 0;
    this.running = false;
    this._onResize = () => this.resize();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    addEventListener('resize', this._onResize);
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;
      this.draw(dt);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    removeEventListener('resize', this._onResize);
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(120, r.width);
    this.h = Math.max(120, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setPhase(phase) { this.phase = LOOK[phase] ? phase : 'idle'; }

  /** Feed live audio. `bands` is optional — level alone still animates the core. */
  setAudio(level, bands) {
    this.level = Math.max(0, Math.min(1, level || 0));
    if (!bands) return;
    for (let i = 0; i < this.n; i++) this.target[i] = bands[i] || 0;
  }

  draw(dt) {
    const { ctx } = this;
    const look = LOOK[this.phase] || LOOK.idle;
    const rgb = readColor(this.canvas, look.key);
    const cx = this.w / 2, cy = this.h / 2;
    const R = Math.min(this.w, this.h) * 0.5 - 12;

    ctx.clearRect(0, 0, this.w, this.h);

    // Ease the spectrum toward its target. Falls faster than it rises so a peak has
    // a visible attack and a natural decay instead of flickering.
    const rise = 1 - Math.pow(0.001, dt), fall = 1 - Math.pow(0.02, dt);
    let sum = 0;
    for (let i = 0; i < this.n; i++) {
      const t = this.target[i];
      this.shown[i] += (t - this.shown[i]) * (t > this.shown[i] ? rise : fall);
      sum += this.shown[i];
    }
    const energy = Math.max(this.level, sum / this.n);

    // --- glow ---
    const glowR = R * (0.52 + energy * 0.30);
    const g = ctx.createRadialGradient(cx, cy, R * 0.10, cx, cy, glowR);
    g.addColorStop(0, rgba(rgb, 0.30 * look.glow * (0.5 + energy)));
    g.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, glowR, 0, TAU); ctx.fill();

    // --- radial spectrum, mirrored so both halves match ---
    const inner = R * 0.44;
    ctx.lineCap = 'round';
    for (let i = 0; i < this.n; i++) {
      const v = this.shown[i];
      const len = R * (0.05 + v * 0.34);
      const a0 = (i / this.n) * Math.PI;
      for (const dir of [1, -1]) {
        // -90° puts band 0 at the top; mirroring gives a symmetrical instrument face.
        const ang = -Math.PI / 2 + dir * a0;
        const x0 = cx + Math.cos(ang) * inner, y0 = cy + Math.sin(ang) * inner;
        const x1 = cx + Math.cos(ang) * (inner + len), y1 = cy + Math.sin(ang) * (inner + len);
        ctx.strokeStyle = rgba(rgb, (0.25 + v * 0.75) * look.dim);
        ctx.lineWidth = Math.max(1.5, R * 0.018);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    }

    // --- dashed rings, counter-rotating ---
    const ring = (radius, dash, speed, width, alpha) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(this.t * speed);
      ctx.strokeStyle = rgba(rgb, alpha * look.dim);
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.stroke();
      ctx.restore();
    };
    ring(R * 0.94, [R * 0.09, R * 0.05], look.spin, 1.5, 0.45);
    ring(R * 0.86, [2, R * 0.055], -look.spin * 1.6, 1, 0.35);
    ctx.setLineDash([]);

    // Instrument ticks: 48 marks, every 6th longer. Static relative to the rings, so
    // the rotation above reads against something.
    ctx.strokeStyle = rgba(rgb, 0.28 * look.dim);
    ctx.lineWidth = 1;
    for (let i = 0; i < 48; i++) {
      const ang = (i / 48) * TAU;
      const long = i % 6 === 0;
      const r0 = R * (long ? 0.99 : 1.01), r1 = R * 1.05;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.stroke();
    }

    // --- thinking sweep: the one animation unique to "working on it" ---
    if (this.phase === 'thinking' || this.phase === 'transcribing') {
      const head = (this.t * 2.2) % TAU;
      const sweep = ctx.createConicGradient
        ? null   // a conic gradient would be nicer but is not universal; arc + fade is
        : null;
      void sweep;
      ctx.strokeStyle = rgba(rgb, 0.9);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.94, head, head + 0.55);
      ctx.stroke();
    }

    // --- core ---
    const coreR = R * (0.30 + energy * 0.055);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, rgba(rgb, 0.95));
    core.addColorStop(0.72, rgba(rgb, 0.75));
    core.addColorStop(1, rgba(rgb, 0.10));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, TAU); ctx.fill();

    ctx.strokeStyle = rgba(rgb, 0.55);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, coreR + R * 0.045, 0, TAU); ctx.stroke();
  }
}
