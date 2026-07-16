# AIOS — Suggested Additions & Improvements

*A curated review (2026-07-11) after building out the life layer, git/GitHub integration, and
inbox v2. Ten concrete items, each grounded in the current code with an implementation sketch.
Deeper than the Roadmap idea bucket — when one gets started, move it to Roadmap and mark it.*

Effort: **S** ≈ an evening · **M** ≈ a day or two · **L** ≈ a week of evenings.

---

## 1. 🔥 Phone-ready AIOS (responsive pass + PWA) — M

The server already broadcasts on the LAN with pairing links, and `index.html` has a viewport
meta — but the dock, `.app-cols` layouts, and most panes assume a desktop. From a phone the
most valuable screens (Home rails, Planner day view, Inbox, Chat) are exactly the ones that
should work.

- Add `manifest.json` + icons (the `scripts/aios.svg` art exists) so it installs as a PWA
  from the pairing link; standalone display, theme-color from the active theme.
- One breakpoint pass: dock becomes a bottom tab bar, `.app-cols` side panels collapse behind
  a toggle (the pattern exists — `.dash-inner.wide` already wraps at 1180px).
- Chat/Agent composers are near-usable already; Planner's week strip → swipeable day columns.

## 2. 🔥 Unified notification center (topbar bell) — M

Discord pings exist for mail only, and each app surfaces its own state. Meanwhile agent runs
finish while you're in another app, research completes silently, birthdays sit in the Planner.

- `server/notify.js` grows an in-app event store: `pushEvent({source, title, body, app, ts})`
  + `GET /api/notifications` + WS topic `notify` (the pub/sub plumbing in `index.js` is there).
- Emit from the seams that already exist: agent `turn.done`, research `done`, mail scan
  (new important / fast-tracked), planner (birthday today, task overdue), GitHub
  (review-requested delta on refresh).
- Topbar bell with unread count + dropdown; each entry deep-links via `openApp(app, opts)`
  (every app now supports opts). Per-source toggles in Settings; Discord mirroring optional
  per source instead of mail-only.

## 3. 🔥 Calendar sync — ICS subscribe + export — M

The Planner is an island. Google/Outlook/school calendars speak ICS both ways.

- **Subscribe**: `planner.icsFeeds[]` config; a zero-dep VEVENT parser (DTSTART/DTEND/RRULE
  FREQ/BYDAY/UNTIL maps cleanly onto the existing `parseRecur` forms in `server/planner.js`);
  fetched on a `startAutoScan`-style interval, merged read-only into `eventsInRange` with a
  distinct color + source tag, never written to `planner.json`.
- **Export**: `GET /api/planner/ics?token=` — AIOS events as a feed Google Calendar can
  subscribe to. Recurrence maps back the other way.
- Home's Next-3-Days and the mini calendar pick both up for free.

## 4. 🔥 Finish the git loop: push + pull request from the hub — S/M

Branch → commit → diff-rail review all work; the last mile still needs a browser or terminal.

- **Push** button on the agent git chip when `gitInfo.ahead > 0` (already computed) — reuse
  `publishProject`'s plain-push-then-token-header fallback in `server/git.js`.
- **Open PR**: `POST /repos/{owner}/{repo}/pulls` via the existing `gh()` wrapper in
  `server/github.js`; title/body drafted by the LLM from `git log main..HEAD` using the
  `commitMessage` machinery — including the `isGenericSubject` quality gate and the
  1600-token reasoning headroom (the pattern that fixed commit messages).
- Surface "your branch has an open PR" state on the chip; the GitHub app's PR tab already
  lists it once created.

## 5. ✨ Model roles instead of one default — S

Model refs are scattered: `defaults.chatModel`, `defaults.agentModel`, `mail.model`,
`jobsearch.defaultModel` — and an unset default silently disabled mail triage for days.

- Define **roles** in Settings → Providers: `fast` (triage, suggestions, commit messages),
  `smart` (agent, research synthesis), `vision` (image input). One resolver in `llm.js`:
  `resolveRole('fast')` → explicit role ref → defaults → *first reachable model* (generalize
  the `resolveModel` fallback added to `mail.js`).
- Callers switch to roles; the empty-default bug class dies permanently, and pairing
  Anthropic-for-agent with the local 9B-for-triage becomes one dropdown each.

## 6. ✨ Agent verify loop v2: run the project's real tests — M

`agent.selfCheck: review` only re-parses syntax (`server/checks.js`). The agent can write
code that parses and still doesn't work.

- Detect the test command: `package.json scripts.test`, `pyproject`/`pytest.ini`, `Makefile
  test` — or an explicit `verify:` line in `.aios/instructions.md` (already read into the
  prompt by `projectContext`).
- In the end-of-turn review pass, run it bounded (existing bash tool timeout + output caps);
  failures bounce back exactly like `selfCheckMessage` does for syntax, counted against
  `maxFixRounds`.
- Keep it opt-in per project (tests can be slow on the 9B's turn loop): config
  `agent.runTests: 'off' | 'review' | 'always'`.

## 7. ✨ Global search in the palette — S/M

Ctrl+K searches apps, projects, actions, and vault notes — but not the things you actually
lose: that chat from Tuesday, an agent session, a task, a tracked job, an email.

- One federated endpoint `GET /api/search?q=` scanning the JSON stores (chats, agent session
  titles + first user messages, planner tasks/events, jobs board, mail notifications) — they
  are all small local files; a simple scorer like `vault.search`'s is plenty.
- Palette gains groups with deep links: `openApp('chat', {session})`,
  `openApp('planner', {date})`, `openApp('jobsearch', {view:'board'})` — the opts plumbing
  already exists everywhere.

## 8. ✨ Check the E2E harness into the repo — S

`npm run audit` (26 unit checks) is in-repo, but the *loop-level* tests that caught real bugs
this week — the mock-OpenAI SSE provider driving a full agent git workflow, the mock GitHub
API (REST + GraphQL) exercising publish/heatmap/suggest, the inbox composition suite — live
in a session scratchpad and will be lost.

- Port them to `scripts/e2e/*.mjs` + `npm run e2e` (they already spawn a temp-data AIOS on a
  free port and clean up after themselves; ~5 focused files).
- These are the tests that catch "the model returned reasoning and no content" classes of
  regression that unit checks can't.

## 9. ✨ Reply from the inbox (SMTP send) — L

Mail is deliberately read-only IMAP. The mini-Gmail viewer makes the absence of *Reply*
conspicuous.

- A minimal SMTP submit client in the `mail.js` style (node:tls, implicit-TLS 465 — same
  Gmail app password, `AUTH PLAIN`, `MAIL FROM`/`RCPT TO`/`DATA`); no attachments, plain
  text + quoted original, `In-Reply-To`/`References` headers from the stored Message-ID.
- UI: Reply button in the email modal → LLM-drafted reply (role `fast`, with the
  quality-gate + generous-token pattern) shown **fully editable** with an explicit Send —
  never auto-sent.
- Staged: send-only first; agent tooling for outbound mail only if ever wanted, gated hard.

## 10. ✨ Backups: `npm run backup` + rotation — S

Everything lives in `data/` (config, planner, jobs pipeline, chats, mail state, custom
tools) and this machine has hard-crashed under load before. `writeJSON` is already atomic
per-file (tmp + rename) — what's missing is disaster recovery.

- `scripts/backup.mjs`: tar.gz of `data/` (+ optionally `.aios/` dirs of registered
  projects) into `backups/` with keep-last-N rotation; `--restore <file>` path that refuses
  to run while the server is up.
- Optional daily auto-snapshot via the same interval pattern as `mail.startAutoScan`; a line
  in Settings → About showing last backup age.
- Pairs with a `.gitignore`d `backups/` and one doc paragraph in the README.

---

### Honorable mentions (already in Roadmap's bucket, still worth their slots)
- **Embeddings for vault search** (`nomic-embed-text` via Ollama) — biggest single upgrade to
  `wiki_recall`'s usefulness for the agent.
- **PDF ingestion for research** — candidates ending in `.pdf` are currently skipped in
  `research.js`; shelling to `pdftotext` when present (the `checks.js` `hasCmd` pattern)
  would unlock academic sources.
- **Hunk-level patch review** for agent edits — the diff rail now shows per-file diffs;
  per-hunk approve/reject is the natural next step of that UI.
