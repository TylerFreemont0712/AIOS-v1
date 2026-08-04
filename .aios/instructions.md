# AIOS — instructions for the agent working on this project

verify: npm run check

## Shape of the project
- Zero-build: plain ESM on both sides, no bundler, no TypeScript, three runtime deps
  (express, ws, @anthropic-ai/sdk). `npm run check` must pass after every change — it
  esbuild-parses web/js and syntax-checks server/.
- UI is pages, not windows: apps mount once into `.page` sections (web/js/wm.js) and stay
  alive when switched away. Register new apps in web/js/main.js (import + registerApp + dock).
- Server modules live in server/, one concern per file. Routes are wired in server/index.js
  with the `h()` JSON wrapper — but use a **PLAIN handler for `res.sendFile`** (h() returns
  before the stream finishes and races it; `/api/fs/raw` still has this bug — Roadmap B1).
- Secrets never reach the client: redact in `publicConfig()` and accept them only via
  explicit fields in `updateConfig()` (server/config.js).

## Testing
- `npm run check` (fast, parse-level) → `npm run audit` (58 unit checks) → `npm run e2e`
  (14 suites, mock providers). Keep all three green; the counts are stated so a silent
  regression is obvious.
- **A test that contradicts deliberately changed behaviour is the test's bug, but check
  which one it is before rewriting it.** Two of these were found stale on 2026-08-04: the
  re-read loop (narrowed on purpose, see below) and `crawl_site` (dropped from the chat
  belt on purpose, tools.js ~989). Both are now pinned in the *new* direction — asserting
  that a legible reading is read once, and that crawl_site stays out — so the next change
  in either direction trips a test rather than passing quietly.
- `receipts.js` has coverage (reconciliation, the summary-line filter, the correction loop,
  the duplicate guard, confidence scoring, and the re-read loop — that last one drives
  `scan()` against a scripted model in a subprocess and counts the calls). Still bare:
  financedb / financeai / itemsai / gpu / finance.js itself — if you touch those, you are
  also the first test (Roadmap B6).
- **Receipt reading is TWO STAGE**: a dedicated OCR model transcribes
  (`finance.ocrModel`, currently DeepSeek-OCR), then a text model structures that into the
  schema (`finance.ocrTextModel`). `llmctl.refIsTranscriber()` picks the path from an `ocr`
  tag on the model preset. Before the image is read it is auto-**oriented** (a landscape
  photo of a receipt means it is lying sideways) and **cropped** to the paper (it fills
  under half the frame; the model downsamples whatever it gets). Measured 63% → 100% of
  totals correct over 8 real receipts. Don't collapse this back to one model.
- Receipt scans are a DRAFT: normalize() flags rather than deletes, and the user's edit is
  the point of truth (finance_receipt_fix replays it per shop). Never make a scan write to
  the ledger without review, and never let a plausibility probe teach the catalogue —
  items.priceProbe() and items.aliasLookup() are deliberately read-only for that reason.
- **A scan scores itself** (`scoreConfidence()`, floor `finance.ocrMinConfidence`, cap
  `finance.ocrMaxAttempts` 1-3). The score is deterministic — arithmetic, missing fields,
  garbled codepoints, catalogue recognition — never a model asked how sure it is.
- **A low score only triggers a re-read when the INPUT can be made different**, i.e. when
  the reading is illegible and the photo can be turned (`planAngle()`). A legible reading
  that simply does not reconcile is handed over as-is: every OCR call is temperature 0
  under a fixed grammar, so re-reading identical bytes reproduces the same answer for
  25-40 s of GPU. Do not "restore" the retry — it was measured, not assumed. Retries read a
  *throwaway rotated copy* so the reviewer's photo is re-encoded once at most, and readings
  are never merged: the best pass wins whole, because a receipt stitched from two sources
  cannot be checked against the paper.
- **A long receipt is read in overlapping bands** (`uploads.sliceTall()` →
  `stitchTranscripts()`, `finance.ocrTiles`, default 3). Same problem the crop solves, one
  step on: the model resizes its input before reading, so a 5:1 strip loses the vertical
  resolution the *small* text lives in — which is why a bad scan gets the total right and
  the product names wrong. The seam is found by two-or-more identical lines agreeing, never
  by pixel arithmetic; one matching line is not a seam (prices repeat). When nothing agrees
  the halves are concatenated, because a duplicate line overshoots the total and gets
  caught, while a dropped one balances and is wrong. Only line-oriented readers can be
  tiled — `transcribeStyle()` keeps dots.ocr, which answers with one layout object per
  image, on the whole-photo path.
- **An earnings screenshot is not a receipt** (`readEarnings()`). It has no shop, no basket
  and no arithmetic of its own, so it shares the reader and nothing else: it stores no scan,
  writes no fix, and cannot reach the ledger. It returns a prefill for the income form and
  the user presses the button — that press is the only check available.
- **One purchase, one ledger entry.** `receiptFingerprint()` keys on date + currency +
  total + line items — *not* the merchant, which is what a re-read most often words
  differently. `apply()` refuses a match with 409, no override. Anything that changes what
  `parsed` holds must go through `save()`, which recomputes the fingerprint from it.
- When learning from an edit, an unmatched model line is **not automatically a phantom**:
  correcting the printed text changes the diff's own key. Pair on the amount before filing
  a `drop`, or you teach the scanner to bin a real product on sight.
- **A price observation may not outlive its transaction.** deleteTxn/deleteTxns/
  revertReceipt all purge finance_purchase, and getDb() sweeps pre-existing orphans. An
  orphan is invisible wrong data: the ledger looks right while an item's price history
  still contains a row the user deleted *because* it was a hallucination.

## Model refs — get this right or you will debug the wrong thing
- `local:<alias>` is the canonical way to name a local gguf. It auto-serves on demand
  (router.js → llmctl), never mid-generation.
- The managed llama.cpp custom provider is **deliberately excluded from pickers**:
  llama-server answers under *any* model name you send, so a stale `custom_x:name` ref
  silently runs whichever gguf is loaded. Never introduce one.
- `auto:<category>` routing was removed 2026-07-27. `router.legacyAutoRef()` exists only so
  refs saved in old transcripts still resolve. Don't add pseudo-models.
- "Can this model see images?" has exactly one definition: `llmctl.refSeesImages()` /
  `visionModels()` — the model's preset names an mmproj that exists on disk. A text-only
  model given an image makes llama.cpp return `500 "image input is not supported"`, which
  looks like an upload bug and is not one.

## Attachments
- `uploads.saveUpload()` / `saveUploadBuffer()` are **async** (they may shell out to ffmpeg).
- The **bytes** decide the type, not the client's MIME — iOS sends `image/heic`, an empty
  type, or the wrong type. `sniffMime()` runs first, then the declared type, then the
  extension.
- Anything not png/jpeg/gif/webp is transcoded to JPEG on arrival (ffmpeg, no libheif
  needed). Browser-side prep lives in `web/js/imageprep.js` — use it for any new file input,
  and `IMAGE_ACCEPT` for the `accept` attribute (plain `image/*` hides HEIC on iOS).
- Prefer `POST /api/uploads/raw` (binary body). The base64-in-JSON route is legacy.

## Performance rules learned the hard way
- **Never `spawnSync` on a request path.** A `pgrep` fork measured 23.8ms of blocked event
  loop and was running 4× per chat send. Use `llmctl.pidsMatching()` (reads /proc) instead.
- Anything written on every turn (transcripts) uses `writeJSON(file, data, { pretty: false })`.
- Listing a directory of JSON records for a sidebar: use `util.jsonDirIndex()`, which caches
  by mtime. Don't parse every transcript just to count its messages.
- `fs.openSync` for a detached child's stdio must be `closeSync`'d after spawn — the child
  dups it, so the parent's copy is a leak (this bit twice: llmctl and comfy).
- The SQLite stores cache prepared statements; call `resetStatements()` after any DDL.

## Operational notes
- `data/config.json` is owned by the **running server** — it rewrites the whole file on any
  save, so a hand edit gets clobbered. Patch via `PUT /api/config` instead.
- Restart onto new code: `AIOS_NO_OPEN=1 bash scripts/aios-launch.sh --restart`. That script
  also puts brew's bin on PATH, which is how ffmpeg gets found.
- Before deep-diving a subsystem, read `Roadmap.md` — "Recently shipped" carries the design
  decisions and gotchas, **§G** records what was deliberately cut and why (don't re-suggest
  it), and every open item names the file to start from. `comfyui-plan.md` holds the
  ComfyUI/VRAM state.
