#!/usr/bin/env node
// Rasterize the AIOS icon (dark rounded square + accent rings) to PNG without
// any image dependency — flat geometry drawn per-pixel, zlib-deflated IDAT.
//   node scripts/make-icons.mjs   → web/icons/aios-192.png, aios-512.png

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');

const BG = [0x26, 0x26, 0x24, 255];      // #262624 rounded square
const RING = [0xd9, 0x77, 0x57, 255];    // #d97757 accent circle
const CORE = [0xf0, 0xee, 0xe5, 255];    // #f0eee5 center

/** Is (x,y) inside a rounded rect covering the full canvas with radius r? */
function inRoundedRect(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x <= size - r) || (y >= r && y <= size - r)
    ? ((x >= r && x <= size - r) || (y >= r && y <= size - r) || (x - cx) ** 2 + (y - cy) ** 2 <= r * r)
    : false;
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const rRect = size * 0.22, rRing = size * 0.30, rCore = size * 0.11;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d2 = (x - c + 0.5) ** 2 + (y - c + 0.5) ** 2;
      let col = null;
      if (inRoundedRect(x + 0.5, y + 0.5, size, rRect)) col = BG;
      if (d2 <= rRing * rRing) col = RING;
      if (d2 <= rCore * rCore) col = CORE;
      if (col) col.forEach((v, i) => { px[(y * size + x) * 4 + i] = v; });
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size) {
  const px = draw(size);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;                    // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;               // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(OUT, `aios-${size}.png`);
  fs.writeFileSync(file, png(size));
  console.log(`✓ ${file} (${fs.statSync(file).size} bytes)`);
}
