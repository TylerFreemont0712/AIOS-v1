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
- `npm run check` (fast, parse-level) → `npm run audit` (43 unit checks) → `npm run e2e`
  (14 suites, mock providers). Keep all three green; the counts are stated so a silent
  regression is obvious.
- `receipts.js` has coverage (reconciliation, the summary-line filter, the correction
  loop). Still bare: financedb / financeai / itemsai / gpu / finance.js itself — if you
  touch those, you are also the first test (Roadmap B6).
- Receipt scans are a DRAFT: normalize() flags rather than deletes, and the user's edit is
  the point of truth (finance_receipt_fix replays it per shop). Never make a scan write to
  the ledger without review, and never let a plausibility probe teach the catalogue —
  items.priceProbe() is deliberately read-only for that reason.
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
