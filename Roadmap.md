# AIOS Roadmap

An idea bucket for future iterations. Nothing here is committed — it's where features,
improvements, and "wouldn't it be cool if…" get captured so they aren't lost. When you
start something, move it to the top and mark it; when it ships, add it to **Shipped**
and delete it from the buckets below (keep this list forward-looking).

Priority tags: 🔥 wanted soon · ✨ nice-to-have · 🧪 experimental · 💭 blue-sky.

---

## Shipped (baseline — don't re-suggest these)
The hub already has: web desktop (attached page views, dock, Ctrl+K palette, light/dark/accent/wallpaper),
LAN broadcast + token auth, provider abstraction (Anthropic + Ollama + OpenAI-compatible),
**Chat** (streaming, per-chat system prompts, history), **Agent** (Claude-Code-style tool loop:
bash/read/write/edit/glob/grep/fetch, approval modes, self-check syntax loop, injected coding
playbooks, per-project `.aios/` memory + self-improvement, project re-scoping), **Research**
(server-orchestrated plan→search→read→reflect→synthesize with citations, snippet fallback,
relevance ranking, wall-clock budget), **web_search** via bundled SearXNG (+ DDG fallback),
**Files** (tree + CodeMirror, search, previews), **Terminal** (node-pty/xterm), **Projects**
registry (git badges), **Second Brain** (Obsidian read/write/search/graph/backlinks, AI ask/
summarize/wiki-grow), **Mindmaps** (AI generate/expand, vault export), agent **vault_* tools**
(autonomous KB build/maintain), **collapsible chain-of-thought** everywhere (native reasoning +
`<think>` parsing), **shifting context window** (no 32k overflow), smooth throttled streaming,
tools enable/disable menu, desktop launcher + systemd unit, **9 themes** (light/dark/system +
Matrix/Nord/Dracula/Rosé Pine/Synthwave/Solarized, with a Matrix katakana-rain wallpaper),
a **modular services status** panel on Home, and model-pickers that auto-select the first model.
Also shipped (2026-07-08): the **Job Search** app — pluggable-source Discover feed (SearXNG /
Firecrawl multi-board scraping with AI extraction / SerpApi), application Board, AI **profile
memory** (resume import, standing answers, questionnaire answering), fit-scoring + EN/JP cover
letters, an annotation-platform tracker (Outlier, Alignerr, …) with cookie-based task-availability
checks, and `npm run firecrawl` (self-hosted scraping engine).
Also shipped (2026-07-09): Discover's SearXNG source now **expands board index pages** — hits like
"Data Center jobs — 100 results | Indeed" are scraped (Firecrawl, plain-fetch fallback) and the
individual positions AI-extracted into the feed; un-expandable index pages become labeled
"Browse:" links instead of posing as jobs.
Also shipped (2026-07-09): the **autonomy pack** — the agent can run AIOS apps itself
(research_start/research_status, mindmap_generate, wiki_generate); a structured **LLM wiki**
layer (wiki_learn upserts with frontmatter + autolinks, wiki_recall packed-memory retrieval,
auto-generated Home.md map-of-content, vault-app Home button); wiki-scoped writes pre-approved
(vault.autoApprove) and research reports auto-exported to the wiki (vault.autoExport); and a
Hermes-style **tool foundry** (create_tool / list_custom_tools / delete_tool) where the agent
forges persistent sandboxed tools (node:vm, least-privilege read/write capability injection),
managed in Settings → Tools.
Also shipped (2026-07-10): **GitHub app + research v2 + feature audit** — a full **GitHub
window** (Overview / Repositories / Pull Requests / Issues): profile with contribution
**heatmap** (GraphQL calendar, quartile levels), streamed **AI "Suggested next"** card
(2-3 sentence clamp, 15-min cache, chat-style type-out over WS), two-column repo grid with
filter + **create repo** + **clone-to-projects**, PR buckets (review-requested / authored /
involved), issues, notifications with mark-read; **publish project** (init → commit →
create GitHub repo → push, token via header trick with plain-push-first fallback); auth
borrows the **gh CLI login** server-side (PAT in Settings → GitHub overrides; never sent to
the client); GitHub service chip on Home. **Deep research v2**: plan now emits
**sub-questions** that steer everything — reflection reports per-sub-question COVERED/GAP
coverage and chases only gaps, reports lead with a direct **## Answer** (bold takeaway) and
one section per sub-question (+ comparison tables), recency-scented questions search
`time_range=year`, fast providers get +2 reads and 150s/round. **`npm run audit`**: a
26-check feature audit across every subsystem (config redaction, checks, skills, planner,
mail parsers, uploads, vault+wiki, toolforge capability denial, git, tools registry,
projects, agent/chat/mindmap stores, research parsers, jobs, llm budgets, notify) plus
environment probes (providers, SearXNG, GitHub, Open-Meteo, node-pty, IMAP). Also fixed:
confirm dialogs showing "Delete" for non-destructive confirms (init-repo now says
Initialize; confirmBox grew a kind param).
Also shipped (2026-07-10): **git-native agent + Home life rail** — first-class **git tools**
(git_status/diff/log/branch/switch/commit/init, safe arg-vector exec, branch-name sanitizing)
with a branch-before-changes discipline in the agent prompt (work branches like `aios/<slug>`,
never on main, no push/pull without being asked) and live repo state injected per turn; a
**commit chip** in the Agent composer (branch + dirty count, one click → AI-drafted conventional
commit message from the diff with template fallback, editable modal, commit-all; init offer on
repo-less projects); Home's left rail rebuilt: the Planner's **mini calendar** (shared
`minimonth.js` component, day click deep-links Planner to that date), a **weather widget**
(Open-Meteo current + 3-day, geocoded location + °C/°F in Settings → Profile, 10-min cache),
**Next 3 Days** events (work category hidden) and today's tasks; Planner reshaped — compact
week/month calendar band, the **Tasks panel fills the freed space and scopes to the selected
day** (Day/All toggle, quick-add pre-dated to the selection), wider right rail.
Also shipped (2026-07-09): **life layer v2** — Gmail-style agent mail tools (mail_recent /
mail_search with from:/subject:/is:unread syntax / mail_read, all read-only IMAP peek);
Home rails split (agenda left, inbox right); and the **Planner rebuilt** on the
LocalSyncOrganization design: weekly chip-column calendar + todo panel below (with categories),
right rail with interactive mini-month (month/year nav, event dots), selected-day detail, and
Upcoming major events; birthdays store (yearly, ages, manager dialog), soft recurring
reminders with per-day check-off logs, event categories with emoji (work/birthday/trip/holiday/
major/health/social), richer recurrence (multi-weekday, nth-weekday-of-month, until), jump-to-date.
Also shipped (2026-07-09): the **life layer** — full **sampling controls** (temperature, top-p/k,
presence/frequency/repeat penalties, seed, stop sequences; per-provider mapping, blank = default)
in Settings → AI Providers; **Mail triage** (zero-dep IMAP client, read-only peek, AI classifies
importance/urgency/reason; notifications on Home's new right rail with dismiss + scan-now,
optional auto-scan + **Discord webhook** pings); and a **Planner app** (Google-Calendar-style
month/week views, recurring color-coded events, task list with priorities/due dates/overdue
tracking, agenda on Home) with agent tools agenda_view / task_add / event_add.
Also shipped (2026-07-09): **Second Brain as the wiki's home** — Obsidian-like collapsible
folder tree in the sidebar (persisted expand state, reveal-on-open; search stays flat with
excerpts), frontmatter rendered as a properties chip row (tags finally show in the Tags panel),
wider AI sidebar, and `npm run seed-wiki`: 11 starter notes in the canonical format (Meta guide,
Practices, JavaScript, Python, Git, Shell, AIOS primer) seeded into the vault + Home MOC.
Also shipped (2026-07-09): **media/attachment input** for Chat + Agent — attach (button),
drag-drop, or paste **images, PDFs, and files**; images go to any vision model (Anthropic /
llama.cpp `image_url` / Ollama), PDFs to Anthropic's native document blocks, and text/code/CSV
files are inlined for every model. Files are stored server-side (DATA/uploads) and only
lightweight meta rides in the transcript, so context trimming stays intact.

---

## Chat
- 🔥 **Continue generation** when a reply is cut off (`finish_reason: length`) — a "continue" button that resumes from where it stopped.
- 🔥 **Regenerate** last response (optionally with a different model / temperature).
- ✨ Per-message actions: copy, edit-and-resend, delete, quote-reply, "save to vault".
- ✨ **Branch** a conversation from any message (fork history and explore an alternative).
- ✨ Prompt library / saved system-prompt presets ("personas") pickable per chat.
- ✨ Chat organization: pin/star, folders or tags, and search across chat history.
- ✨ Running token + cost meter per chat (and a lifetime total).
- 🧪 **Tool-using chat**: opt-in "smart chat" that can call the agent tool-belt (web_search, vault_*, read_file) for quick one-offs without a full agent session.
- 🧪 Multi-model compare: send one prompt to two models side-by-side.
- 🧪 Read-aloud (TTS) of responses; mic → transcribe for voice input.
- 💭 Slash commands in chat (`/summarize`, `/translate`, `/tone`, `/table`).

## Agent / coding
- 🔥 **Git-aware checkpoints**: snapshot before a run, one-click rollback, per-run diff review. For non-git projects, snapshot to `.aios/checkpoints/`.
- 🔥 **Multi-file / hunk-level patch review**: see all edits of a turn together and approve/reject each hunk, not just whole tool calls.
- 🔥 **Plan mode**: the agent proposes a step plan and waits for approval before executing (great guardrail for a small model).
- ✨ Auto-run the project's own **test/lint** in the self-check loop (detect from package.json / pyproject / Makefile) and feed failures back.
- ✨ `.aios/memory` **viewer/editor** in the UI — browse, edit, and prune what the agent has learned; same for `.aios/instructions.md`.
- ✨ **Attach a screenshot** to an agent message (bug photo → gemma-vision) and files as extra context.
- ✨ Live "changed this session" file-tree panel with per-file diffs.
- ✨ Bash **command allowlist/denylist** for safer Full-auto mode; a dry-run preview for destructive commands.
- ✨ Per-session token/cost budget with stop-at-budget.
- ✨ Session recipes/templates: "add tests", "write docs", "refactor for readability", "fix this stack trace".
- 🧪 Auto web-search on a failed build/test (pull the exact error, find the fix) as an opt-in self-heal step.
- 🧪 Parallel sub-agents for big tasks (fan out over files, gather) — a mini orchestrator.
- 🧪 More playbooks: rust, go, sql, docker, tailwind, fastapi, next.js, bash-scripting, e2e-testing, api-design.
- 💭 "Explain this repo" onboarding that reads the tree and drafts an initial `.aios/instructions.md` + architecture note.

## Deep research
- 🔥 **Follow-up questions** on an existing report — ask more and have it search deltas + append a section instead of restarting.
- 🔥 **Sources drawer**: every candidate considered (read / skipped / why), with citation hover-previews that show the backing snippet.
- ✨ Better extraction: Mozilla-Readability-style main-content picker so fewer pages come back "thin"; **PDF ingestion** for PDF sources.
- ✨ Per-source confidence; let the user pin/exclude sources and re-synthesize.
- ✨ Research templates (compare X vs Y, literature review, how-to, product research) and an auto-save-to-vault option.
- ✨ Export report to PDF/HTML; resume an interrupted/failed run.
- 🧪 Optional **headless-browser fetch** (Playwright) for JS-rendered sites, behind a setting.
- 🧪 Domain trust list (favor docs/academia, down-rank content farms) + per-run cost/ETA estimate.
- 🧪 **Research → Mindmap**: turn a report's structure into a mindmap automatically.
- 💭 Standing/scheduled research ("watch this topic, tell me weekly what's new").

## Second brain (vault)
- 🔥 **Embeddings + semantic search** (Ollama `nomic-embed-text` or similar) for ask-vault retrieval, not just keyword.
- 🔥 **Chat with a note / folder** — scoped RAG over a subset of the vault.
- ✨ Live **file-watcher** → index/graph updates while you edit in Obsidian.
- ✨ **Vault housekeeping** agent pass: find orphans, near-duplicate notes (offer merge), broken `[[links]]`, and stale facts; a "wiki coverage" view showing topics & gaps.
- ✨ Note & daily-note **templates**; tag-management UI (rename-tag-everywhere); vault-wide find & replace.
- ✨ Auto-summary / TL;DR frontmatter on new or updated notes.
- ✨ Task extraction: surface `- [ ]` checkboxes across the vault as a task list.
- 🧪 Mindmap ⇄ vault round-trip (import outlines as maps, export maps as outlines).
- 🧪 Image attachments in notes with OCR → searchable text.
- 💭 Auto-linking suggestions ("this note relates to …") and publish a note/folder as a shareable read-only page.

## Mindmaps
- ✨ Export to **PNG/SVG image**; Mermaid import/export.
- ✨ Node styling (colors, icons, collapse), plus radial and org-chart layouts.
- 🧪 Generate a mindmap from a document / URL / chat transcript.
- 💭 Timeline and force-directed layout modes.

## Files & editor
- 🔥 **Git in the file view**: status, stage/commit, diff gutter, and a side-by-side diff viewer.
- 🔥 **Inline AI edit**: select code → "ask AI to change it" → preview diff → apply (a lighter path than a full agent session).
- ✨ Multi-tab editor + split view; fuzzy file open (Ctrl+P).
- ✨ Project-wide **find & replace** with preview.
- ✨ CSV table view, richer image/PDF preview, drag-to-upload / download.
- ✨ Editor niceties: minimap, bracket-match, format-on-save (via project formatter).

## Terminal
- ✨ **Tabs and splits**; a persistent (tmux-style) session that survives reconnects.
- ✨ Search in scrollback; "send selection to chat/agent".
- ✨ Run-script buttons detected from package.json / Makefile.
- 🧪 Broadcast a command to multiple terminals; themed to the accent color.

## Projects
- 🔥 **Per-project dashboard**: recent agent/chat sessions, git status, README render, and one-click **run-script buttons** (`npm run dev`, etc.).
- ✨ Project **scaffolding/templates** (new React / Python / Node service) and **clone from a GitHub URL**.
- ✨ Per-project defaults (model, agent mode, context size) and per-project `.env`/secret management.
- ✨ Archive/pin projects; project search.
- 💭 Project health: dependency freshness, TODO/FIXME scan, test status badge.

## Providers & models
- 🔥 Auto-detect a model's **context window** (query llama.cpp `/props` or Ollama) so `contextTokens` doesn't have to be set by hand.
- ✨ **Model presets** (named model + params + system prompt) selectable per app; favorites & recently-used.
- ✨ Per-request **temperature / top-p / max-tokens** controls in the composer.
- ✨ Live **model load / VRAM / tok-per-sec** in the provider status.
- 🧪 Provider **fallback chain** (if the primary is down, use the next).
- 🧪 Ollama model **pull/manage** from the UI; Anthropic cost tracking with pricing.
- 💭 Automatic model routing (cheap model for simple asks, big model for hard ones).

## Search & navigation
- 🔥 **Global search** from Ctrl+K across everything — chats, research runs, agent sessions, files, vault, projects (today it covers apps/projects/vault notes only).
- ✨ Recent-views quick-switcher (Ctrl+Tab) and back/forward view history.
- ✨ An **activity feed** of recent items across all apps on Home.
- ✨ Settings search.

## Desktop, shell & QoL
- 🔥 **Notifications**: toast + optional OS/push notification when a long agent or research run finishes (you're often on another device).
- 🔥 Wire up the existing **`density`/compact mode** setting (defined in config, not yet applied) for laptop screens.
- ✨ **Split view / multi-pane** — two apps side by side (e.g. Agent + Files, Chat + Terminal).
- ✨ Drag-and-drop between apps (file → chat, note → mindmap, code → terminal).
- ✨ Per-app keyboard shortcuts + a `?` cheatsheet overlay.
- ✨ First-run onboarding wizard (pick a model, set vault, tour the apps).
- ✨ User-defined custom themes (save your own palette) + import/export theme JSON; custom CSS injection. More animated wallpapers (starfield, gradient flow) using the existing canvas hook.
- 🧪 Multiple user profiles (several people on the LAN, separate data/prefs).
- 💭 PWA / installable app with an offline shell.

## Mobile & accessibility
- 🔥 **Mobile-friendly layout pass** — the LAN use-case implies phones/tablets; responsive dock, touch targets, single-pane views.
- ✨ Voice capture on mobile → daily note / quick chat.
- ✨ Full keyboard navigation, ARIA roles, screen-reader labels, focus rings.
- ✨ Font-size control, reduce-motion, and high-contrast options.
- 💭 Localization / i18n.

## Automation & scheduling
- ✨ **Scheduled tasks / cron**: recurring research, nightly vault housekeeping, backups.
- 🧪 Saved **routines** — multi-step agent recipes runnable on demand or on a schedule.
- 💭 Webhooks / triggers (run a routine when a file changes or an endpoint is hit).

## Infra, reliability & security
- ✨ **Health page** (extends the Home services panel): per-engine SearXNG status (which answered / are rate-limited), `data/` disk usage, uptime, and model latency/tok-per-sec.
- ✨ **Backup & restore**: one-archive export/import of all AIOS data; scheduled snapshots.
- ✨ In-UI **logs viewer** and clearer error surfacing (instead of only the server console).
- ✨ SearXNG engine auto-tuning (disable persistently-failing engines automatically).
- ✨ Self-update: `git pull` + `npm run vendor`/`check` from the UI, with a version banner.
- 🧪 Auth hardening: per-device tokens with names, individual revoke, and an access audit log; optional TLS helper.
- 🧪 Sandboxed agent bash (container / nsjail) as an opt-in for Full-auto; encrypted secrets at rest.
- 💭 Usage metrics dashboard (tokens/requests over time, per app and per model).
