// Matrix "digital rain" — falling katakana for the Matrix theme wallpaper.
// One canvas mounted into #wallpaper; a translucent fade each frame leaves the
// glowing green trails. Time-throttled (~18fps) so it's easy on the CPU/battery.

const GLYPHS = ('アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨ'
  + 'ラリルレロワヲンガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポ'
  + '0123456789:.=*+-<>¦｜╌').split('');

let raf = null, canvas = null, ctx = null, onResize = null, drops = [], cols = 0, cell = 16, last = 0;

function resize() {
  if (!canvas) return;
  const p = canvas.parentElement;
  const w = p.clientWidth || innerWidth, h = p.clientHeight || innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cell = w < 640 ? 13 : 16;
  cols = Math.ceil(w / cell);
  drops = Array.from({ length: cols }, () => Math.random() * -60);
  ctx.fillStyle = '#000400'; ctx.fillRect(0, 0, w, h);
}

function frame(t) {
  raf = requestAnimationFrame(frame);
  if (t - last < 55) return;               // ~18fps
  last = t;
  const w = canvas.clientWidth, h = canvas.clientHeight;

  // fade the previous frame toward black — this is what makes the trailing streaks
  ctx.fillStyle = 'rgba(0, 5, 1, 0.09)';
  ctx.fillRect(0, 0, w, h);
  ctx.font = `${cell}px "Cascadia Code", ui-monospace, monospace`;
  ctx.textBaseline = 'top';

  for (let i = 0; i < cols; i++) {
    const g = GLYPHS[(Math.random() * GLYPHS.length) | 0];
    const x = i * cell, y = drops[i] * cell;
    if (y > 0) {
      // bright leading glyph, then a dimmer green body (the fade darkens the rest)
      ctx.fillStyle = Math.random() < 0.5 ? '#d6ffe2' : '#7dffab';
      ctx.fillText(g, x, y);
      ctx.fillStyle = 'rgba(40, 220, 100, 0.55)';
      ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], x, y - cell);
    }
    drops[i] += 0.5 + Math.random() * 0.55;
    if (y > h && Math.random() > 0.972) drops[i] = Math.random() * -20;  // respawn at top
  }
}

export function startMatrix(container) {
  stopMatrix();
  canvas = document.createElement('canvas');
  canvas.className = 'wp-canvas';
  container.append(canvas);
  ctx = canvas.getContext('2d', { alpha: false });
  resize();
  onResize = () => resize();
  addEventListener('resize', onResize);
  last = 0;
  raf = requestAnimationFrame(frame);
}

export function stopMatrix() {
  if (raf) cancelAnimationFrame(raf);
  if (onResize) removeEventListener('resize', onResize);
  canvas?.remove();
  raf = null; canvas = null; ctx = null; onResize = null; drops = [];
}
