# AIOS Roadmap

The single planning doc for AIOS — an idea bucket **and** a decision list. It replaces the
old `Suggestions.md` (folded in here on 2026-07-20). Nothing below the "Shipped" section is
committed; it's where features, cuts, fixes, and "wouldn't it be cool if…" get captured so
they aren't lost. When you start something, mark it; when it ships, move a one-liner into
**Shipped** and delete it from the buckets.

**Priority:** 🔥 wanted soon · ✨ nice-to-have · 🧪 experimental · 💭 blue-sky · ✂️ cut/trim
**Effort:** S ≈ an evening · M ≈ a day or two · L ≈ a week of evenings

Every forward-looking item has a code hook (file/function to start from) so it's actionable,
not just a wish. Items are numbered so the backlog is easy to reference — **~30 in total**,
spread across *cut, backend, UI, new features, and money*.

---

## What AIOS already is (don't re-suggest these)

A zero-build, local-first **personal AI operating hub** served on the LAN (port 7777, token
auth, PWA-installable): a web desktop of attached page-views with a dock, Ctrl+K palette, and
9 themes. On top of a provider abstraction (Anthropic + Ollama + any OpenAI-compatible
endpoint, addressed as `provider:model`) it runs:

- **Chat** — streaming, per-chat system prompts, chain-of-thought panels, image/PDF/file input.
- **Agent** — a Claude-Code-style tool loop (bash/read/write/edit/glob/grep/fetch + git,
  vault, planner, mail, comfy, wiki, research, custom-forged tools), approval modes, a
  syntax **and real-test** self-check loop, injected coding playbooks, per-project `.aios/`
  memory + self-improvement, a per-file diff rail, commit/push/PR from the composer, and a
  **lean tool loadout** that hides non-core tool groups from small models until they ask.
- **Research** — server-orchestrated plan→search→read→reflect→synthesize with citations,
  sub-question steering, snippet fallback, and a wall-clock budget; auto-exports to the wiki.
- **Studio** — ComfyUI cockpit: text→image, image→image, and upscale workflows, Animagine +
  Lightning-LoRA sampling plans, hi-res 2-pass, an LLM prompt generator, and AIOS-owned
  ComfyUI/llama lifecycle with a VRAM guard.
- **Second Brain** — Obsidian vault read/write/search/graph, a typed-note system (7 kinds +
  templates), autolinking, a generated Home MOC, and `wiki_recall` packed-memory retrieval.
- **Learning Corner** — an AI tutor: a subject **tree**, AI-designed capability roadmaps,
  web-grounded lessons, and **assessments with per-question grading + per-topic mastery**
  (SQLite; question kinds incl. multiple-choice, short-answer, ordering).
- **Models / Bench / Routing** — the llama-launcher **absorbed into the web UI** (per-model
  presets, live GPU/VRAM, log pane, VRAM-fit hints), a **deterministic model benchmark**
  (`data/bench.db`: score + time-to-first-token + tok/s per model per category, no LLM
  judge), and **auto-routing** (`auto:coding`, `local:<alias>` refs resolve to the
  bench-winning local model and hot-swap llama-server on demand).
- **Life layer** — Planner (calendar, recurring events, birthdays, reminders, tasks), Mail
  (read-only IMAP triage with sender ratings, mini-Gmail viewer, Discord pings), Weather,
  and a Home dashboard that folds all of it (+ services status) into one glance.
- **Files** (tree + CodeMirror), **Terminal** (node-pty/xterm), **Projects** (git badges),
  **GitHub** (profile, heatmap, repos, PRs, issues, publish/clone).
- **Plumbing** — SearXNG (bundled), PDF ingestion for research (`pdftotext` + OCR fallback),
  sampling controls, shifting context window, modular services probes, desktop launcher,
  `npm run check | audit | e2e` (11 e2e suites, mock-provider driven).

### Recently shipped (this update, 2026-07-20)
- **Bench + auto-routing + Models v2** — deterministic per-category local-model leaderboard,
  `auto:<category>`/`local:<alias>` model refs with on-demand llama-server swapping, and the
  desktop llama-launcher fully re-implemented as the in-browser **Models** app.
- **Learning Corner → SQLite** (`server/learndb.js`) — subject tree, assessments,
  per-topic mastery; short-answer + ordering question kinds; guarded (name-confirmed)
  subject deletion.
- **Agent lean tool loadout** (`agent.leanTools: 'auto'`) — core tools only until the model
  activates a group, so small models stop losing the plot on long tasks (`lean-agent.e2e`).
- **Cut the Mindmap subsystem** — `server/mindmap.js`, its routes, and the `mindmap_generate`
  tool are gone (the UI was already replaced by the Learning Corner); no orphaned tool for the
  agent to trip over. Outlines still land in the wiki via `wiki_generate`.
- **Cut the Job Search subsystem** — the whole stack (`jobsource`/`platforms`/`jobai`/`jobs`/
  `profile`, the app, Firecrawl scripts, config, settings tab, Home card, service probe) was
  removed after it didn't pan out; the shared `extractJSON` helper moved to `util.js`. A fresh,
  ToS-aware design is parked in **§F** for a future revisit.
- **PDF ingestion in research** — `.pdf` sources are now fetched and text-extracted
  (`tools.fetchPdfText`: `pdftotext` text layer, with a `pdftoppm`→`tesseract` OCR fallback for
  scanned PDFs when those are installed) instead of being skipped; PDFs served without a `.pdf`
  extension are detected by header and rerouted. `tools: PDF ingestion` audit check + verified
  end-to-end over HTTP.
- **Agent plan mode** (`defaults.agentPlanMode`, per-session `planMode` toggle in the composer)
  — a no-tools planning turn proposes a numbered step plan and blocks; you approve (editing the
  plan inline), or reject, before any tool runs. `plan.e2e` (18 checks) covers approve+edit,
  reject, and the no-tools planning turn.

---

## A. Cut / consolidate — shrink the surface area ✂️

Maintenance is the tax on a solo project. Every one of these is dead weight or duplicated
effort that can go, freeing time for the buckets below.

> Done this pass: the **Mindmap** and **Job Search** subsystems were fully removed (see
> Recently shipped). A reworked, ToS-aware Job Search is parked in **§F**.

1. **✂️ Sunset the PyQt desktop launcher for the LLM — S.** Now that **Models v2** owns
   start/stop/preset/serve in the browser, `llmctl.openLauncher()` and the "Open launcher"
   button are legacy. Keep the launcher only for Whisper/MusicGen (or drop entirely) and
   delete the AIOS-side plumbing that duplicates the new UI.
2. **✂️ Collapse the scattered model-ref config into routing roles — S.** `defaults.chatModel`,
   `defaults.agentModel`, `mail.model`, `learn` model — several places a ref can be set (and an
   unset one silently disabled mail triage for days). Now that `auto:`/`local:` refs exist, make
   every caller resolve a **role** (`fast`/`smart`/`vision`) through one resolver and delete the
   per-feature fields. Kills the empty-default bug class.
3. **✂️ Trim the theme roster from 9 to ~4 — S.** The animated wallpapers (Matrix katakana
   canvas in `web/js/matrix.js`, Synthwave CSS grid) and the long tail of palettes
   (Solarized, Rosé Pine) are pure aesthetic upkeep in `theme.css`. Keep light/dark/system +
   one signature theme; move the rest to an optional "theme pack" so the core stays lean.
4. **✂️ De-duplicate the two research depth/report paths — S.** Research and the Learning
   Corner both do plan→search→read→synthesize with near-identical helpers (now including the
   new PDF-ingestion path). Extract the shared pipeline (`research.js` ↔ `learn.js`) into one
   module so a fix to extraction/snippet-fallback/PDF lands in both instead of drifting.

## B. Backend & reliability — things to fix under the hood

5. **🔥 Audit every `sendFile` route for the `h()` race — S.** The memory flags that the
   `h()` wrapper sends `{ok:true}` JSON *before* `sendFile` streams the file, and that
   `/api/fs/raw` likely still has this latent bug (uploads was already patched to a plain
   handler). Grep every `res.sendFile`/`sendFile(` in `server/index.js` and convert them to
   plain handlers with the callback for errors. Corrupted downloads are the symptom.
6. **🔥 Make backups SQLite-aware — S.** Data now lives in JSON **and** two WAL databases
   (`data/bench.db`, `data/learn.db`). A naive `tar data/` mid-write can capture a torn WAL.
   Add `scripts/backup.mjs` that runs `PRAGMA wal_checkpoint(TRUNCATE)` on each `.db` before
   archiving, tars `data/` (+ registered `.aios/` dirs) into `backups/` with keep-last-N,
   and a `--restore` that refuses to run while the server is up. This machine has hard-crashed
   under load before — disaster recovery is overdue.
7. **✨ Pin/verify the Node runtime for `node:sqlite` — S.** `learndb.js`/`bench.js` depend on
   the built-in SQLite module (stabilised in recent Node; the box runs brew Node 26, fine).
   Add an `engines` field to `package.json` and a startup guard that fails loudly with a clear
   message on older Node instead of a cryptic import error — the LAN "just clone and run"
   story breaks silently otherwise.
8. **✨ Auto-detect a model's context window — S.** `contextTokens` is still hand-set.
   Query llama.cpp `/props` (`n_ctx`) or Ollama `/api/show` when a `local:`/custom model is
   selected and populate `contextBudget()` automatically — the Models app already reads
   server state, so it's the natural home. Removes the last "why is it truncating?" footgun.
9. **✨ SearXNG engine auto-tuning — S.** Brave/DDG rate-limit fast and stall queries. Track
   per-engine failure rates in `tools.js`'s `webSearch` and auto-disable a persistently-
   failing engine for a cooldown window (surface it on the Health page, item 17).
10. **✨ Per-device auth tokens with revoke + access log — M.** Auth is one shared token today.
    For a multi-device LAN, issue named per-device tokens (pairing link already exists),
    allow individual revoke, and keep a small access audit log. The single-token model means
    one leaked pairing URL can't be contained without rotating everyone.
11. **🧪 Provider fallback chain — S.** When the primary provider is down a request just fails.
    Let `llm.js` fall through an ordered list (e.g. local → Anthropic) on connection error —
    the `resolveModel` "first reachable" logic added for mail already proves the pattern.
12. **🧪 Config-write safety — S.** The live server rewrites *all* of `config.json` on any
    settings save, silently clobbering concurrent/direct edits (a known gotcha). Write via
    tmp+rename with a version/mtime check and warn on conflict, mirroring `writeJSON`'s
    atomicity guarantee for the one file that isn't fully guarded.

## C. UI / UX — make what exists nicer to use

13. **🔥 Unified notification center (topbar bell) — M.** Runs finish while you're in another
    app; research completes silently; birthdays sit in the Planner. Grow `server/notify.js`
    into an in-app event store (`pushEvent`) + `GET /api/notifications` + WS topic `notify`,
    emitting from the seams that already exist (agent `turn.done`, research `done`, mail scan,
    planner overdue/birthday, a finished bench run, GitHub review-requested delta). Topbar
    bell with unread count + dropdown; entries deep-link via `openApp(app, opts)`; per-source
    toggles, optional Discord mirroring per source.
14. **🔥 Wire up the `density`/compact mode — S.** `appearance.density: 'comfortable'` is
    defined in `config.js:19` but never applied. Add a `data-density` attribute + a compact
    spacing pass in `shell.css`/`apps.css` and honour it — a quick, high-visibility win for
    laptop screens.
15. **🔥 Global Ctrl+K search across your actual data — M.** The palette finds apps/projects/
    vault notes but not the things you lose: a chat from Tuesday, an agent session, a task, an
    email. Add `GET /api/search?q=` scanning the small JSON/SQLite stores with a
    `vault.search`-style scorer; palette gains grouped results with deep links.
16. **✨ Settings search + section split — S.** `web/js/apps/settings.js` is ~40KB and growing;
    finding a toggle means scrolling. Add a filter box that jump-scrolls to matching settings,
    and consider splitting the monster file per-tab so it's maintainable.
17. **✨ Health page + in-UI log viewer — M.** Extend the Home services panel into a real
    status page: which SearXNG engines answered vs are rate-limited, `data/` disk usage,
    uptime, model latency/tok-per-sec (bench already measures the last two), and a tail of
    `aios.log` in the browser instead of only the server console.
18. **✨ Chat quality-of-life — M.** The composer is missing table stakes: **Continue** when a
    reply hits `finish_reason: length`, **Regenerate** (optionally different model/temp),
    per-message copy/edit-resend/delete, **branch from a message**, and a running token/cost
    meter. All are `chat.js` + `web/js/apps/chat.js` work; none exist today (verified).
19. **✨ Finish the mobile pass — M.** The ≤760px breakpoint exists but the Planner week strip,
    Studio, and the new Bench/Models tables overflow. One pass: swipeable Planner day columns,
    single-pane Bench/Models, bigger touch targets — the LAN-broadcast use-case *is* phones.
20. **🧪 Split view / multi-pane — M.** Two apps side-by-side (Agent + Files, Chat + Terminal).
    The `wm.js` view manager already keeps apps mounted; this is a layout shell over it.

## D. New features worth building

21. **🔥 Embeddings + semantic vault search — M.** The single biggest upgrade to `wiki_recall`
    and Ask-Vault: index notes with Ollama `nomic-embed-text`, store vectors in a new
    `data/vault.db` table (SQLite is already in the stack), and rank by cosine before the
    keyword pass. Unlocks "chat with a note/folder" scoped RAG as a follow-on.
22. **🔥 Calendar sync — ICS subscribe + export — M.** The Planner is an island. A zero-dep
    VEVENT parser maps cleanly onto `planner.js`'s existing `parseRecur` forms; subscribe to
    Google/Outlook/school feeds (merged read-only, distinct color) and expose
    `GET /api/planner/ics?token=` so AIOS events show up in Google Calendar. Home's Next-3-Days
    picks both up for free.
23. **🔥 Hunk-level patch review + agent checkpoints — M.** The diff rail shows per-file diffs;
    the natural next step is per-**hunk** approve/reject, plus a pre-run snapshot (git stash or
    `.aios/checkpoints/` for non-git projects) with one-click rollback. Turns Full-auto from
    scary into reversible — and complements the just-shipped plan mode (approve the plan, then
    approve the hunks).
24. **✨ Reply from the inbox (SMTP send) — L.** Mail is read-only IMAP; the mini-Gmail viewer
    makes the missing *Reply* conspicuous. A minimal SMTP submit client in the `mail.js` style
    (node:tls, implicit-TLS 465, same Gmail app password, `In-Reply-To`/`References` from the
    stored Message-ID) → an LLM-drafted, **fully editable, never auto-sent** reply. Send-only,
    hard-gated.
25. **✨ Voice in/out — M.** Whisper already runs on this machine (via the launcher). Wire
    mic→transcribe for Chat/quick-note capture and TTS read-aloud of replies. High value on
    mobile; reuses the uploads pipeline for audio blobs.
26. **✨ Scheduled tasks / routines — M.** A cron layer (`data/schedules.json` + one interval
    driver like `mail.startAutoScan`) for recurring research ("watch this topic weekly"),
    nightly vault housekeeping, and the item-6 backups. Saved multi-step agent recipes become
    runnable on demand or on a schedule.
27. **✨ Vault housekeeping pass — M.** An agent/scripted sweep that finds orphan notes,
    near-duplicates (offer merge), broken `[[links]]`, and stale facts, with a "wiki coverage"
    view of topics vs gaps. The wiki index (`wiki.js`) already computes orphans — extend it.
28. **✨ Per-project dashboard + run-script buttons — M.** The Projects app shows git badges
    only. Give each project a panel: recent agent/chat sessions, README render, git status,
    and one-click **run-script buttons** detected from `package.json`/`Makefile` (the Terminal
    can host the process). The single most-requested "make it feel like an IDE" gap.
29. **🧪 Files: git gutter + inline AI edit — M.** Bring the working-diff data already exposed
    at `/git/diff` into the CodeMirror gutter, and add "select code → ask AI to change it →
    preview diff → apply" as a lighter path than a full agent session.
30. **🧪 Learning Corner spaced repetition — M.** The new `mastery` table already tracks a
    decaying correct/seen tally per topic. Add an SM-2-style scheduler that surfaces
    due-for-review topics on Home and auto-mixes weak topics into the next assessment —
    closing the loop from "graded" to "actually retained."

## E. Monetization / return-on-investment 💰

This is a genuinely differentiated, private, local-first hub. Two realistic paths to make it
pay for itself, plus one that earns *directly*.

31. **💰 Productize AIOS as a self-hostable "private AI OS" (best shot) — L.** The homelab /
    r/selfhosted / privacy crowd currently duct-tapes ChatGPT + Obsidian + cron + a dozen
    tabs. AIOS already *is* the unified, local-first, LAN-broadcast alternative — its moat is
    that everything (agent, wiki, planner, studio, mail, bench-routed local models) lives on
    your own hardware. **Package it**: a one-command Docker/install script, a short landing
    page, and a **one-time "Pro" license or GitHub Sponsors tier** that unlocks the
    convenience layer (item 6 backups, item 10 multi-user, item 19 mobile, item 13 push
    notifications). Core stays open/free to build trust and inbound; Pro funds the time.
    Ship items 6/10/13/19 *first* — they're the paid-tier surface.
32. **💰 Publish the local-model benchmark as a public content asset — M.** The Bench
    subsystem answers a question thousands of people Google: *"which local model is actually
    best for coding / JSON / agents on 8GB VRAM?"* — and it's **deterministic**, so the
    numbers are credible. Export `data/bench.db` to a static, shareable leaderboard page
    (auto-published from a scheduled run, item 26), seed it to r/LocalLLaMA / HN, and let it
    drive traffic to the AIOS project (item 31) via a newsletter + affiliate hardware links.
    Near-zero marginal cost, and it's the most SEO-friendly thing in the repo.
33. **💰 Direct RoI you can turn on this week — S.** Use AIOS itself as a **portfolio /
    consulting lead**: the connected Upwork MCP can post a "I build private, self-hosted AI
    hubs for your team" gig, with AIOS as the live demo — billable hours, not speculative
    product revenue. (The gig/annotation-earnings angle from the old Job Search app is folded
    into the §F revival as a small, opt-in "work available now" alert.)

## F. Parked — Job Search v2 (a design for when we revisit)

The v1 Job Search app was cut because its *sourcing* layer was the problem, not its idea. The
AI value — resume → structured profile, fit-scoring, EN/JP cover letters, questionnaire
answers, a kanban pipeline — worked. What didn't: self-hosted Firecrawl/SearXNG **scraping**
of Indeed and job boards fought Cloudflare intermittently, violated ToS, returned index pages
posing as postings, and was high-maintenance for a single user. v2 keeps the value and
replaces fragile scraping with legitimate, low-maintenance inputs.

**Design principles**
- **Don't scrape hostile boards — ingest what's already permitted.** Sourcing, in priority order:
  1. **Capture box + bookmarklet / share-target** (primary): paste a job URL or its text and the
     local model extracts structured fields. Zero ToS risk, always works, and mirrors what you
     already do by hand.
  2. **Official feeds / ATS endpoints**: RSS/Atom job feeds and the public per-company JSON that
     Greenhouse (`boards.greenhouse.io/<co>.json`) and Lever (`api.lever.co/v0/postings/<co>`)
     expose. Curate a company watch-list; poll politely. Structured and stable.
  3. **Email-driven**: reuse the existing IMAP layer — a "jobs" label/folder whose alert emails
     (Indeed/LinkedIn/board digests you already subscribe to) get parsed into postings. The
     boards' own delivery becomes the feed; no scraping.
  4. **One reputable aggregator API** (opt-in, user's own key) for breadth — a single connector
     behind a paid tier, not three brittle ones.
- **Relational store** — `data/jobs.db` (matching the bench/learn SQLite move): `postings`
  (source, url, company, title, location, remote, comp, description, fingerprint for dedup),
  `applications` (posting_id, stage, dates, timeline), `contacts`, `documents` (tailored
  resume/cover-letter versions). "Which applications are stalled >14 days?" is a relational query.
- **Keep the AI that worked** — profile memory, fit-scoring, tailored cover letters (EN/JP),
  questionnaire answering: all provider-agnostic plain-prompt flows; they just need the new
  sourcing + store under them.
- **Reuse existing infra** — mail.js (email ingestion), the notification center (item 13, for
  follow-up nudges), the Planner (follow-up reminders), model-routing roles, and the SQLite
  pattern. New surface is small.
- **Gig/annotation earnings** — a lightweight, opt-in watcher that surfaces "work available now"
  on annotation platforms via their *official* login/status (no cookie-scraping heuristics like
  v1) → a notification. Small and honest; doubles as the item-33 RoI lever.
- **Scope discipline** — ship the capture-box + ATS-feed + email-extraction MVP first (all
  legitimate, all reliable), prove it's useful, and only then add the paid aggregator.

---

*Backlog hygiene: when an item ships, replace its entry with a one-line note under "Recently
shipped" and delete the bucket entry (renumber the buckets so there are no holes). Keep this
file forward-looking — the detailed changelog lives in git history and project memory, not here.*
