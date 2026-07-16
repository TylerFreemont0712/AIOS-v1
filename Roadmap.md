# AIOS Roadmap

An idea bucket for future iterations. Nothing here is committed — it's where features,
improvements, and "wouldn't it be cool if…" get captured so they aren't lost. When you
start something, move it to the top and mark it; when it ships, add it to **Shipped**
and delete it from the buckets below (keep this list forward-looking).

Priority tags: 🔥 wanted soon · ✨ nice-to-have · 🧪 experimental · 💭 blue-sky.
See also **Suggestions.md** — a curated 2026-07-11 review with implementation sketches.

---

## Shipped (baseline — don't re-suggest these)
Shipped (2026-07-16): **Studio workflows + typed notes + Learning Corner** — (1) **Studio
gained a workflow selector**: Text→Image (unchanged), **Image→Image** (source picker —
"Use render" from the history strip or upload any image — plus a remix-strength/denoise
slider with plain-language hints; source scaled to the target size, batch via
RepeatLatentBatch), and **Upscale** (pure-ESRGAN 2×/4× with upscaler model pick, no
prompt/checkpoint needed, relaxed VRAM guard at 2.5GB so it rarely triggers the LLM swap);
sources upload into ComfyUI via /upload/image; deeper graph surgery (LoRA stacks,
ControlNet) stays one click away in ComfyUI proper. (2) **The second brain became a typed
note system**: seven note kinds (concept / howto / reference / decision / troubleshooting
/ source / project), each with a canonical template — served to the agent via a new
`note_template` tool and a `kind` param on wiki_learn that stamps `type:` frontmatter
(preserved across untyped updates); a new **`notes` skill** teaches the system (quality
bar, filing, maintenance) and is auto-packed into the agent prompt when a vault is
connected; `npm run seed-wiki` now also seeds `Meta/Note System` + `Meta/Templates/*`
(ran live: 8 new notes). (3) **Mindmaps → Learning Corner**: a lesson-plan/roadmap tutor
app (`learn` in the dock) — subjects with goal + level, an AI-designed roadmap of
capability modules (prerequisite-ordered, project modules, grounded by web search of
current curricula), and one-click **web-grounded lessons** (plan → search current sources
→ read → streamed lesson with objectives / runnable examples / exercises-with-folded-
solutions / self-quiz / cited sources / next-lesson ideas), lesson types standard/project/
review/deep-dive per the new **`tutor` skill**; progress toggles per module and lesson,
lessons auto-export to the vault's `Learning/` shelf, default **Programming** subject
seeded. Mindmap UI removed (server store + agent tool remain, outlines still land in the
wiki). New `learn.e2e.mjs` (15 checks, mock LLM + SearXNG) — e2e now 8 suites; audit +2
areas (learn store, workflow graphs + typed notes) → 30 hard checks.

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
Also shipped (2026-07-12, night): **research streaming fix + deeper research + launcher fit** —
**the big one**: the WS client's topic-fanout only mapped agent/chat/vault message types, so
**research, Studio progress, AND GitHub-suggestion streams were silently dropped** (nothing
showed until you refreshed and re-read persisted state). Fixed at the choke point — the
server now stamps `_topic` on every published message and the client routes generically
(no per-type mapping to drift out of sync). Verified live: first event at 245ms, 540
thinking-deltas + 2613 report-deltas streamed. **Research depth raised** for genuinely
deliberate investigations: tiers quick/standard/deep now 4/5/6 queries and 5/8/11 reads
(deep is 4 rounds, was 3), per-round wall-clock budget 100→180s local / 150→240s cloud (the
old budget cut the slow local model off after 2-3 reads), synthesis token cap 4k→5k/8k with
a "thorough briefing, 2-4 paragraphs per section" prompt. A real quick run now reads 6
sources over ~4.7 min and writes a 14.5KB/7-section cited report (was "a few seconds, not
much"). **Launcher fit**: the two-column split was wildly imbalanced (left 247px vs right
632px = 385px of deadspace) — rebalanced to model+draft+serving left / tuning right (95px
gap), window reshaped to landscape 1460×900 (from 1060×1040). New `stream.e2e.mjs` (7 checks)
locks in the fanout fix.
Also shipped (2026-07-12, evening): **polish sweep + llama-launcher integration** —
efficiency: `/api/services` probes now run **concurrently** (a down ComfyUI no longer
stalls the row on its network timeout; ~0.4s with everything up), the ComfyUI service chip
uses a **lightweight ping** (no nvidia-smi/pgrep spawns), **Studio render PNGs are
garbage-collected** when jobs fall off the 100-ring (was an unbounded disk leak), agent
tool-card icons cover comfy/mail/wiki/planner/research, and a dead per-turn tool rescan was
removed. Two **premature memoizations were caught and reverted** — the git prompt-context
memo broke the per-turn branch-state refresh (the agent-git e2e caught it) and the
app-context memo risked "add an event, ask again → stale"; both are now correctly always-
fresh. **llama-launcher in AIOS**: Settings → AI Providers gained a "LOCAL LLAMA.CPP
(AIOS-managed)" section — shows the active profile, switches **big ⇄ tiny** inline, and an
**Open launcher** button spawns the desktop GUI (Whisper/MusicGen/manual tuning) via
`/api/llm/launcher`. The **launcher GUI was redesigned**: the llama tab's six config
sections went from one tall vertical stack to a **two-column layout**, each tab wrapped in a
**scroll area**, window reshaped 1060×1040 → **1280×860 landscape** (backup kept as
`.py.bak`). `.aios/instructions.md` added (verify: npm run check). Audit +3 checks (context,
comfy plan, llmctl) → 29 total; all 6 e2e suites green.
Also shipped (2026-07-12, later): **Studio v2 — the generation cockpit** — access fixed at
every layer (ComfyUI now binds the LAN via `--listen`, the ↗ link rewrites localhost to
wherever you're browsing from, and **Generate auto-boots ComfyUI** when it's down);
two-column layout: inputs LEFT (model + live **sampling-plan line** showing exactly what
will run, style presets with Animagine-official quality-tags-at-the-end, **positive starter
templates** [portrait/landscape/chibi/dark-fantasy/retro-90s/mecha/cozy], **negative
templates** incl. the official Animagine negative, an **LLM prompt generator** — type an
idea, get a proper danbooru-tag prompt + matching negative), render RIGHT (big hero image +
click-to-open, meta line with seed/steps/mode, history thumbnail strip); **hi-res 2-pass
checkbox** — calibrated live to PIXEL space (decode → 4x-AnimeSharp → ×1.5 lanczos →
0.45-denoise repaint) after latent upscales turned to mush under few-step models; **speed
select** with quality as default (Animagine-official euler_a · cfg 5 · 28 steps) and the
Lightning LoRA as explicit ⚡ opt-in — verified over three seed-777 renders that the LoRA
shreds busy backgrounds on Animagine while characters stay clean. Two more workflows in
ComfyUI's browser: **Anime Hi-Res 2-pass** and **Anime img2img** (native settings, LoRA
node present but bypassed, Ctrl+B to enable).
Also shipped (2026-07-12): **anime stack v2 + app-wide chat awareness** — **Animagine XL
4.0** (real anime finetune) + SDXL-Lightning **4/8-step LoRAs** + **4x-AnimeSharp**
upscaler installed; Studio's generator became Lightning-aware (`samplingPlan`: fast
checkpoints keep 4/8-step cfg-1, plain finetunes auto-attach the Lightning LoRA, no LoRA →
proper 26-step cfg-6 sampling) so picking Animagine "just works"; anime preset upgraded
with quality tags; two more workflows in ComfyUI's browser (**Anime v2 Animagine+LoRA**,
**Upscale 4x AnimeSharp**) + a tiered "what your 8GB can do" menu in comfyui-plan.md
(hi-res fix → ControlNet → AnimateDiff/LTX-Video/WAN-1.3B ceiling). **Live app context**
(`server/context.js`): a compact planner/birthdays/tasks/mail/weather/job-pipeline brief
injected into every chat message and the agent prompt (sync — weather self-refreshes its
cache; toggle in Settings → Agent; `GET /api/chat/context` shows exactly what's shared) —
"what's going on tomorrow?" now answers from the calendar ("🎂 Tyler (turns 34)" proved it
live on first try).
Also shipped (2026-07-11, later): **Studio server controls + first live render** — AIOS now
starts/stops ComfyUI itself (config comfy.dir/python — the shared venv at `~/venv` was
discovered via ComfyUI's own logs; Start/Free-VRAM/Stop buttons in the Studio header,
foreign-instance detection, logs at data/comfy/comfyui.log); style presets (anime default,
painterly, photo) decorating prompts; an "AIOS Anime txt2img" workflow saved into ComfyUI's
own workflow browser; **comfyui-mcp added to Claude Code** (user scope, npx, connected) so
Claude sessions can drive ComfyUI directly; fixed a real install bug (venv had comfy-aimdo
0.3.0, repo pins 0.4.10 → CheckpointLoader crashed with ModelMMAP.get_file_handle). **Live
end-to-end test passed**: AIOS started ComfyUI (7.5s), the VRAM guard auto-killed the
launcher's 9B and brought up tiny CPU Qwen (7.8GB freed), SDXL-Lightning rendered an anime
Pikachu (4 steps), the image landed in the Studio gallery, and Studio-mode-off restored the
big model. The GUI launcher no longer owns the text LLM.
Also shipped (2026-07-11): **Studio — ComfyUI phases 0-2** (decisions: SDXL-Lightning first,
AIOS owns llama.cpp, tiny = Qwen3-1.7B): **downloads** — `sdxl_lightning_4step.safetensors`
(6.9GB → ComfyUI checkpoints) + `Qwen3-1.7B-Q8_0.gguf` (1.8GB → `data/llm/models/`;
`~/ai/models` turned out to be root-owned). **server/llmctl.js** — AIOS-managed llama.cpp:
config-defined profiles (`big` = ornith-9b GPU exactly as the launcher ran it, `tiny` =
1.7B CPU-only `-ngl 0`), pidfile discipline, detects/replaces "foreign" (GUI-launcher)
instances, /health-gated startup with log-tail errors. **server/comfy.js** — status probe,
checkpoint discovery, SDXL-Lightning txt2img template (euler · sgm_uniform · cfg 1 ·
4/8 steps), job store, ComfyUI-WS progress → AIOS WS relay, output copies under
`data/comfy/`, `POST /free` after jobs (autoFree), and the **VRAM guard**: generating while
the big LLM holds the GPU auto-swaps to tiny first (autoSwap). **Studio app** in the dock:
prompt + checkpoint/size/steps/batch/seed, live progress bar, gallery, ComfyUI ↗ link, and
a **Studio-mode toggle** (tiny CPU LLM ⇄ big GPU LLM, Comfy unloads first). Agent tools
`comfy_generate` / `comfy_status`. Service chips for ComfyUI + llama profile. gpu.js
nvidia-smi wrapper.
Also shipped (2026-07-11): **suggestions batch 1 (items 1/4/6/8) + ComfyUI plan** —
**E2E harness in-repo**: `npm run e2e` runs scripts/e2e/*.e2e.mjs (agent-git loop, github
mock API incl. PR drafting, REST, mail/MIME units, core git/weather/verify units + a
verify-loop suite) — the mock-provider tests that caught this week's real bugs are now
permanent. **Push + PR**: `↑n` push chip and `⇄ PR` button in the agent composer — PR
title/body AI-drafted from branch commits (1600-token budget + generic-subject gate,
commit-subject fallback), draft-PR checkbox, existing-PR detection; routes
/git/pr/draft + /git/pr. **Verify v2**: after a clean syntax self-check the agent run now
executes the project's real test command (package.json test, pytest, Makefile, cargo, go,
or a `verify:` line in .aios/instructions.md; async + process-group killed, 120s default)
and failures bounce back exactly like syntax errors — proven by an E2E where the mock
agent ships a parsing-but-failing bug and fixes it from the bounced test output; Settings →
Agent toggle. **PWA + responsive**: manifest + passthrough SW + pure-Node-generated PNG
icons (`npm` dep-free rasterizer in scripts/make-icons.mjs), installable from the pairing
link; ≤760px the dock becomes a swipeable bottom strip, side panels become ☰-toggled
off-canvas overlays, planner/diff rails hide, week/month grids side-scroll; Planner and
GitHub finally added to the dock. **comfyui-plan.md**: machine survey (8GB 3070 Ti, 6.5GB
held by ornith-9b, ComfyUI 0.25 installed but zero checkpoints), three VRAM strategies
(recommended: "Studio mode" tiny CPU-only tool-model swap), MCP research (official cloud
MCP vs artokun local-first for Claude Code), and a 5-phase build plan.
Also shipped (2026-07-11): **agent diff rail + commit messages that read the diff** — a `±`
button beside the commit chip expands a third column from the right: per-file working diffs
(status badge, +/− counts, accordion bodies; untracked files render as additions via
`--no-index`), auto-refreshing after agent turns and commits; GET /api/projects/:id/git/diff.
Commit drafting fixed for reasoning models: 1600-token budget (was 220 — the 9B burned it all
thinking), a method-first prompt with GOOD/BAD examples, unified=2 context, and a
**generic-subject gate** ("make changes"/"update files" → one stern retry → template
fallback). Verified live: the 9B produced an accurate multi-bullet message naming each file's
actual classes/functions.
Also shipped (2026-07-10): **Home inbox v2 — interactive triage + sender ratings** — looser
LEAN-IMPORTANT triage prompt (versioned verdict cache re-judges on policy change), NDJSON
per-line verdicts (truncation-proof for reasoning models; 8-msg batches, 6k output budget,
per-batch retry, coverage + errors REPORTED in the card, model fallback to any reachable
provider), JIS-mojibake stripped from headers; **read mail drops off the list**, ★
message-starred mail (≤10 days) tails it newest-first; rows click into a **mini window**
(why-it-matters + full body fetched read-only) with **↗ open-in-Gmail** deep links
(rfc822msgid) on rows + modal; **sender ratings**: ⊘ mute address/domain (never notify
again), ⚡ star sender (fast-tracked above triage), **3 dismissals auto-mute** a sender —
all managed under Settings → Mail; Discord pings respect rules; wider inbox rail; the whole
dashboard self-refreshes every 5 min. Follow-up polish: the email popup is now a **mini mail
client** — a zero-dep MIME walker (nested multipart, base64/QP, charsets) extracts the real
text/html part, scripts/handlers stripped, rendered in a big sandboxed iframe (no JS, links
escape to new tabs, remote images allowed) in a new XL modal size; plain-text mail falls back
to the text box; Home center widened (3-column launch grid restored next to the wider rails).
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
