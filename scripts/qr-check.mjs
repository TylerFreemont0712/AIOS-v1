#!/usr/bin/env node
// Regression check for web/js/mobile/qr.js.
//
// The QR encoder is the one piece of the phone shell whose output cannot be judged by
// looking at it: a code with the format bits written LSB-first has correct finders,
// correct timing, correct data, looks entirely like a QR code, and never scans. That
// is exactly the bug this encoder had, and it was found by comparing module-for-module
// against a reference implementation rather than by reading the code.
//
// scripts/qr-fixtures.json holds sha256 digests of the matrices produced by the Python
// `qrcode` library (error correction M, no border) for five strings across all eight
// mask patterns. Those digests are the reference; this script re-derives the matrices
// and compares. The mask is pinned per fixture because mask SELECTION legitimately
// varies between implementations — the spec's penalty rule 3 is ambiguous about
// double-counting — while the matrix for a given mask does not.
//
//   node scripts/qr-check.mjs

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrMatrix, qrSvg } from '../web/js/mobile/qr.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'qr-fixtures.json'), 'utf8'));

let failed = 0;
let passed = 0;

for (const [key, want] of Object.entries(fixtures)) {
  // The key is "<text> <mask>"; the text may contain spaces, so split from the right.
  const at = key.lastIndexOf(' ');
  const text = key.slice(0, at);
  const mask = Number(key.slice(at + 1));

  let got;
  try {
    got = qrMatrix(text, { forceMask: mask });
  } catch (e) {
    failed++;
    console.error(`✗ mask ${mask} threw for ${JSON.stringify(text.slice(0, 40))}: ${e.message}`);
    continue;
  }

  const sha = createHash('sha256').update(got.modules.map(r => r.join('')).join('\n')).digest('hex');
  if (got.version !== want.version || got.size !== want.size || sha !== want.sha256) {
    failed++;
    console.error(`✗ mask ${mask} ${JSON.stringify(text.slice(0, 40))}`);
    if (got.version !== want.version) console.error(`    version ${got.version}, expected ${want.version}`);
    if (got.size !== want.size) console.error(`    size ${got.size}, expected ${want.size}`);
    if (sha !== want.sha256) console.error(`    matrix digest differs`);
  } else {
    passed++;
  }
}

// The SVG wrapper is trivial, but a change that emits an empty path would still pass
// every matrix check above — so assert it actually drew something.
const svg = qrSvg('https://example.ts.net/m/?token=abc');
if (!/^<svg /.test(svg) || !/<path d="M/.test(svg) || svg.length < 500) {
  failed++;
  console.error('✗ qrSvg did not produce a populated <svg>');
}

// Version 15 at level M holds 415 data codewords, three of which the header takes —
// so 412 bytes must still encode and 413 must throw rather than silently truncate.
try {
  const big = qrMatrix('x'.repeat(412));
  if (big.version !== 15) { failed++; console.error(`✗ 412 bytes chose version ${big.version}, expected 15`); }
} catch (e) {
  failed++;
  console.error(`✗ 412 bytes should fit in version 15: ${e.message}`);
}
try {
  qrMatrix('x'.repeat(413));
  failed++;
  console.error('✗ oversized input did not throw');
} catch { /* expected */ }

console.log(failed
  ? `\n${failed} QR check(s) failed (${passed} passed)`
  : `✓ QR encoder matches the reference on all ${passed} fixtures`);
process.exit(failed ? 1 : 0);
