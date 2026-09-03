// A QR encoder, in about 200 lines.
//
// This exists because the pairing link CONTAINS THE PAIRING TOKEN. Every "just use a
// QR API" option — quickchart, goqr, Google's old chart endpoint — works by sending
// the string to someone else's server, which for this particular string means handing
// away access to the hub. So it is generated locally, or not at all.
//
// Model 2, byte mode, error-correction level M (~15% recoverable), versions 1-15,
// which covers 271 bytes — far more than any `https://host.ts.net/m/?token=…` link.
// Verified module-for-module against the `qrcode` reference implementation; see
// scripts/qr-check.mjs.

// ---------- tables ----------

// Per version at level M: [ecCodewordsPerBlock, blocksInGroup1, dataPerBlock1, blocksInGroup2, dataPerBlock2]
const EC_M = [
  null,
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37], [26, 4, 43, 1, 44], [30, 1, 50, 4, 51], [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
];

const ALIGN = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70],
];

// ---------- GF(256) ----------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;      // the QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

/** Reed-Solomon remainder of `data` for `ecLen` error-correction codewords. */
function rsEncode(data, ecLen) {
  // Generator polynomial: product of (x - a^i) for i in 0..ecLen-1.
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= mul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

// ---------- bit stream ----------

class Bits {
  constructor() { this.bytes = []; this.len = 0; }
  push(value, width) {
    for (let i = width - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      if (this.len % 8 === 0) this.bytes.push(0);
      if (bit) this.bytes[this.bytes.length - 1] |= 0x80 >>> (this.len % 8);
      this.len++;
    }
  }
}

// ---------- BCH, for the format and version stripes ----------

function bch(value, poly, dataBits, totalBits) {
  let v = value << (totalBits - dataBits);
  const polyBits = 32 - Math.clz32(poly);
  for (let i = totalBits; i >= polyBits; i--) {
    if (v & (1 << (i - 1))) v ^= poly << (i - polyBits);
  }
  return (value << (totalBits - dataBits)) | v;
}

// EC level M is 0b00; the mask goes in the low three bits.
const formatBits = (mask) => bch((0b00 << 3) | mask, 0x537, 5, 15) ^ 0x5412;
const versionBits = (version) => bch(version, 0x1f25, 6, 18);

// ---------- encoding ----------

function pickVersion(byteLen) {
  for (let v = 1; v <= 15; v++) {
    const [, g1, d1, g2, d2] = EC_M[v];
    if (byteLen + 2 + (v >= 10 ? 1 : 0) <= g1 * d1 + g2 * d2) return v;
  }
  throw new Error('too much data for a version-15 QR code');
}

function encodeData(bytes, version) {
  const [ecLen, g1, d1, g2, d2] = EC_M[version];
  const totalData = g1 * d1 + g2 * d2;

  const bits = new Bits();
  bits.push(0b0100, 4);                                 // byte mode
  bits.push(bytes.length, version >= 10 ? 16 : 8);      // character count
  for (const b of bytes) bits.push(b, 8);
  // Terminator, then pad to a byte, then the alternating pad codewords.
  bits.push(0, Math.min(4, totalData * 8 - bits.len));
  while (bits.len % 8 !== 0) bits.push(0, 1);
  const data = Array.from(bits.bytes);
  for (let i = 0; data.length < totalData; i++) data.push(i % 2 ? 0x11 : 0xec);

  // Split into blocks, compute EC for each, then interleave both sets.
  const blocks = [];
  let at = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const size = i < g1 ? d1 : d2;
    const chunk = data.slice(at, at + size);
    at += size;
    blocks.push({ data: chunk, ec: rsEncode(chunk, ecLen) });
  }

  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ---------- matrix ----------

function buildMatrix(version, codewords) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Int8Array(size).fill(-1));  // -1 = free
  const set = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = v; };

  // Finder patterns and their separators.
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(fr + r, fc + c, on ? 1 : 0);
      }
    }
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centers = ALIGN[version];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0);
        }
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    if (m[6][i] === -1) m[6][i] = i % 2 === 0 ? 1 : 0;
    if (m[i][6] === -1) m[i][6] = i % 2 === 0 ? 1 : 0;
  }
  set(size - 8, 8, 1);                       // the always-dark module

  // Reserve the format areas so data placement skips them.
  const reserved = [];
  for (let i = 0; i < 9; i++) { reserved.push([8, i], [i, 8]); }
  for (let i = 0; i < 8; i++) { reserved.push([8, size - 1 - i], [size - 1 - i, 8]); }
  for (const [r, c] of reserved) if (m[r][c] === -1) m[r][c] = 0;

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = i % 3;
      set(size - 11 + c, r, 0);
      set(r, size - 11 + c, 0);
    }
  }

  // Snapshot which cells are function patterns BEFORE data goes in — masking must
  // not touch them, and after placement the two are indistinguishable by value.
  const fixed = m.map(row => row.map(v => v !== -1));

  // Data, in the standard upward/downward zigzag of two-module columns.
  let bit = 0;
  const total = codewords.length * 8;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;                    // the vertical timing column is not data
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (m[row][c] !== -1) continue;
        const v = bit < total ? (codewords[bit >> 3] >> (7 - (bit & 7))) & 1 : 0;
        m[row][c] = v;
        bit++;
      }
    }
    up = !up;
  }

  return { m, size, fixed };
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * Write the 15 format bits into their two copies.
 *
 * Both copies are written MOST-significant bit first — that is the part worth stating,
 * because writing them LSB-first produces a code that still looks entirely plausible
 * (correct finders, correct timing, correct data) and simply never scans. The position
 * tables below are in bit-14-down-to-bit-0 order, verified against a reference encoder.
 */
function applyFormat(m, size, mask) {
  const bits = formatBits(mask);
  const copy1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const copy2 = [[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8],
    [size - 6, 8], [size - 7, 8], [8, size - 8], [8, size - 7], [8, size - 6],
    [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]];
  for (let k = 0; k < 15; k++) {
    const v = (bits >> (14 - k)) & 1;
    m[copy1[k][0]][copy1[k][1]] = v;
    m[copy2[k][0]][copy2[k][1]] = v;
  }
}

function penalty(m, size) {
  let score = 0;
  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map(row => row[i])]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  }
  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules beside it.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      const rowSeg = [], colSeg = [];
      for (let k = 0; k < 11; k++) { rowSeg.push(m[i][j + k]); colSeg.push(m[j + k][i]); }
      for (const pat of [A, B]) {
        if (rowSeg.every((v, k) => v === pat[k])) score += 40;
        if (colSeg.every((v, k) => v === pat[k])) score += 40;
      }
    }
  }
  // Rule 4: deviation from a 50/50 light-dark balance.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * Encode `text` and return { size, modules } where modules[r][c] is 0 or 1.
 *
 * `forceMask` is a test seam: it pins the mask instead of choosing by penalty, which
 * is what lets scripts/qr-check.mjs compare this matrix against a reference encoder
 * mask-for-mask. Any mask produces a valid, decodable code.
 */
export function qrMatrix(text, { forceMask = null } = {}) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  const version = pickVersion(bytes.length);
  const codewords = encodeData(bytes, version);
  const { m, size, fixed } = buildMatrix(version, codewords);

  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const v = (vb >> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      m[size - 11 + c][r] = v;
      m[r][size - 11 + c] = v;
    }
  }

  // Try all eight masks; keep the one the spec's penalty rules like best.
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== null && mask !== forceMask) continue;
    const cand = m.map(row => Array.from(row));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!fixed[r][c] && MASKS[mask](r, c)) cand[r][c] ^= 1;
      }
    }
    applyFormat(cand, size, mask);
    const score = penalty(cand, size);
    if (!best || score < best.score) best = { score, modules: cand, mask };
  }

  return { size, modules: best.modules, version, mask: best.mask };
}

/**
 * An SVG string for `text`, sized to its container.
 *
 * One <path> of rectangles rather than a rect per module: a version-4 code is 1089
 * modules, and that many DOM nodes is a visible hitch on a phone.
 */
export function qrSvg(text, { margin = 4 } = {}) {
  const { size, modules } = qrMatrix(text);
  const dim = size + margin * 2;
  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return `<svg viewBox="0 0 ${dim} ${dim}" width="100%" height="100%" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">`
    + `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
