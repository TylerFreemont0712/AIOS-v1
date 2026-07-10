# AIOS — your personal AI operating hub

A web desktop that runs on your machine and serves your whole LAN. One place for
chatting with local + cloud models, pointing an agentic coder at your projects,
managing those projects, growing an Obsidian second brain, sketching mindmaps,
editing files, and dropping into real terminals — full-page attached views switched
from a dock, a command palette, and a warm Claude-style aesthetic. Apps keep
running in the background when you switch away (terminals stay alive, agent runs
keep streaming); right-click a dock icon to quit one.

```
npm install       # once (also builds native PTY support)
npm start         # serves http://localhost:7777 and your LAN IP
```

The console prints your addresses. The LAN link includes a pairing token —
open it on any other computer/tablet on your network and it just works.

---

## The apps

| App | What it does |
|---|---|
| **Home** | Greeting, a modular **services status** panel (SearXNG, model providers, vault — anything that can be offline), stats, quick-capture to your daily note, launchers |
| **Chat** | Streaming conversations with any configured model; markdown, code copy, per-chat system prompts, persistent history, and a collapsible **chain-of-thought** panel when the model reasons |
| **Agent** | Claude-Code-style coding agent scoped to a project: it explores with `list_dir`/`glob`/`grep`/`read_file`, changes code with `write_file`/`edit_file`, runs `bash`, searches the web with `web_search`, reads docs with `fetch_url`, pulls best-practice **playbooks** with `skill`, and reads/maintains your **knowledge base** with `vault_*` — streaming every step as collapsible tool cards with diffs. Extra guardrails for small local models: a **self-check** loop that syntax-gates everything it writes, injected coding playbooks, and a per-project **memory** it maintains and learns from. Switching the active project re-scopes the agent to that project |
| **Research** | Deep, cited web research: give it a question and it plans searches, reads real sources through SearXNG, loops on the gaps, and writes a report with inline `[n]` citations and a sources list. Runs entirely server-side (works with any model, no tool-calling needed); export any report into your vault |
| **Job Search** | A personal, AI-driven job engine. **Discover**: pluggable-source search (SearXNG broad · **Firecrawl** scraping of Indeed + TokyoDev/Japan Dev with AI extraction · optional SerpApi key) with fit-scoring against your profile. **Board**: kanban pipeline (Saved → … → Accepted) with AI cover letters (EN/JP), timelines, follow-up nudges. **Platforms**: annotation/gig directory (Outlier, Alignerr, DataAnnotation, …) with membership status + cookie-based **task-availability checks**. **Profile**: your resume imported by AI into a structured memory that powers fit-scores, cover letters, and questionnaire answers |
| **Files** | Tree explorer + CodeMirror editor (JS/TS, Python, Markdown, HTML, CSS, JSON), quick search, image preview, markdown preview, conflict detection if the agent edits a file under you |
| **Terminal** | Real PTYs (node-pty) in xterm.js — colors, vim, resize; one shell per window |
| **Projects** | The hub's registry: register existing folders, create new ones (README + git init), git branch/dirty badges, favorites, notes, jump straight into Agent/Files/Shell |
| **Second Brain** | Your Obsidian vault: browse/edit/search notes, clickable `[[wikilinks]]`, backlinks, tag chips, an interactive link **graph**, daily-note capture — plus AI that answers *from your notes with citations*, summarizes, and **grows the wiki** by writing interlinked atomic notes into an `AI Wiki/` folder |
| **Mindmaps** | Tidy-tree SVG maps: Tab/Enter/Del keyboard editing, collapse branches, pan/zoom — or let a model design the whole map, expand any branch with AI, and export maps into the vault as outlines |
| **Settings** | Providers, **tools** (enable/disable each agent tool, web-search backend), **9 themes** (light/dark/system + Matrix/Nord/Dracula/Rosé Pine/Synthwave/Solarized) with accent & wallpaper, vault paths, agent defaults & self-check, network & security |

Shell niceties: **Ctrl+K** command palette (apps, project switching, vault search,
actions), project switcher and active-view crumb in the top bar, a theme gallery
(9 palettes incl. an animated **Matrix** katakana-rain and a **Synthwave** neon
grid), accent colors, and wallpapers.

## Chain of thought

When a model reasons before answering, AIOS shows it — a Claude-style **collapsible
thinking panel** that streams the reasoning live ("Thinking…"), then auto-collapses
to "Thought for Ns" when the final answer arrives (click to re-open). It appears in
**Chat**, the **Agent** (before each answer / tool run), and **Research** (the whole
plan → search → read → reflect timeline is the panel, collapsing once the report is
written). Reasoning is captured from whatever the provider exposes: Anthropic
thinking blocks, OpenAI-compatible `reasoning_content`/`reasoning` (llama.cpp,
DeepSeek, vLLM), Ollama `thinking`, and a streaming-safe parser for inline
`<think>…</think>` tags — so local reasoning models light up automatically, and the
reasoning is always kept out of the saved answer text.

## Model providers

Configure in **Settings → AI Providers** (or env). All three kinds can be used at
the same time, picked per chat / per agent session:

- **Anthropic** — paste an API key (or run with `ANTHROPIC_API_KEY=…`). Models are
  listed live from the API.
- **Ollama** — auto-detected at `http://127.0.0.1:11434`. Anything you `ollama pull`
  shows up. Tool-use (Agent) requires a tools-capable model (qwen3, llama3.1+, etc.).
- **OpenAI-compatible** — add any `/v1` endpoint: LM Studio, llama.cpp server, vLLM,
  OpenRouter, …

## The agent, precisely

- Each session is scoped to one project root. **Tools cannot read or write outside
  it** (path resolution + prefix checks; `bash` runs with `cwd` inside it).
- Three approval modes, switchable mid-session:
  - **Read-only** — write tools are refused.
  - **Approve edits** (default) — writes/commands pause and show you a diff or the
    exact command; Allow / Always-allow-this-tool / Deny.
  - **Full auto** — everything pre-approved.
- Long outputs truncate middle-out; transcripts trim oldest-first to fit the model's
  context; sessions, tool results, and token usage persist in `data/agent/`.
- Secret-looking env vars (`*_KEY`, `*_TOKEN`, …) are scrubbed from the env the
  agent's bash commands see.
- Watch the same session from two machines — events broadcast to every subscribed
  view.
- **Self-check guardrail** (Settings → Agent; designed for small local models):
  every file the agent writes is immediately syntax-checked (esbuild for
  js/jsx/ts/tsx/css, `JSON.parse`, python `ast`, `bash -n`) and failures are
  appended to the tool result so the model sees breakage in the same breath.
  In *"Gate + review"* mode, when the agent says it's done, every file it touched
  is re-checked — remaining problems are bounced back as an automatic fix request
  (bounded rounds, default 2). The whole exchange shows up in the transcript as
  amber self-check cards.
- **Tool menu** (Settings → Tools): every tool the agent has, grouped and
  toggleable. Disabled tools are removed from the model's tool list entirely.
- **Coding playbooks** (Settings → Agent; designed for small local models): dense
  best-practice guides in `skills/*.md` (core, python, react, javascript,
  typescript, node-api, web, testing, git, debugging, security, shell,
  knowledge-base). The agent's
  stack is auto-detected (package.json deps, tsconfig, pyproject, file extensions)
  and the matching playbooks are packed into its system prompt within a
  per-provider budget; the rest stay reachable via the `skill` tool. Edit the files
  or drop in your own — no registration needed.
- **Project memory & self-improvement** (Settings → Agent): each project gets an
  `.aios/` folder the agent owns (writes there are always pre-approved). At session
  start it reads `.aios/instructions.md` (your standing rules for that project) plus
  its own `.aios/memory/` (an indexed set of topic notes) and `.aios/memory/lessons.md`.
  After a substantial run it's prompted once to record what it learned — and to turn
  this run's *mistakes* (denied calls, failed self-checks) into one-line "next time…"
  lessons. So it gets a little better at each project every time you use it.
- **Knowledge base (autonomous second brain)**: when a vault is connected, the agent
  gets `vault_search` / `vault_list` / `vault_read` / `vault_write` / `vault_append`,
  so it can *build and maintain* your Obsidian LLM-wiki, not just read it. Ask it to
  "add the PyQt6 documentation" and it researches, writes atomic `[[wikilinked]]`
  notes under `AI Wiki/PyQt6/…`, and keeps an index; ask it to "expand the QTable
  note" and it updates in place. Because it can also *consult* the wiki before
  coding, the curated docs it builds reduce future mistakes. The `knowledge-base`
  playbook teaches it good note hygiene (atomic notes, wikilinks, pruning). Vault
  writes go through the normal approval mode.
- **Context window that shifts** (Settings → Agent → *Context window*): set your
  local model's context size (default 32000). AIOS fits system + tools + history
  under it, reserves headroom for the reply, drops oldest exchanges first, and
  middle-truncates any single oversized message — so long chats and agent sessions
  never hit a context-overflow error. Anthropic keeps its own large window.
- **Smooth streaming**: chat, agent, and research render tokens as they arrive
  (throttled, not debounced), so the answer types out live like Claude/ChatGPT
  instead of appearing all at once when the model finishes.

## Web search (SearXNG)

The `web_search` tool queries a **SearXNG** metasearch instance — real aggregated
results (Brave, DuckDuckGo, etc.) with answers/infoboxes, JSON API, no keys.

```
npm run searxng              # start the bundled instance (Docker) on 127.0.0.1:8890
npm run searxng -- status    # is it up?
npm run searxng -- down      # stop it
```

First run writes `scripts/searxng/config/settings.yml` with a fresh secret and
JSON output enabled. The instance binds to localhost only — searches route through
the AIOS server, so other LAN devices never talk to it directly. If SearXNG is
down, `web_search` degrades to a DuckDuckGo HTML fallback and says so in the
result. Endpoint + live status + a "test search" button live in Settings → Tools.
The bundled config enables a broad engine set (Google, Bing, DuckDuckGo, Brave,
Wikipedia, Mojeek, Qwant) so one engine getting rate-limited doesn't zero out your
searches; `npm run searxng -- regen` rewrites the config and restarts.

## Deep research

The **Research** app runs a real research loop on the server, so even a small local
model produces a solid, cited report:

1. **Plan** — the model writes several angled search queries.
2. **Search** — each query goes through SearXNG.
3. **Select** — results are scored against the question's keywords, deduped by
   domain, and ranked so spam/off-topic pages sink.
4. **Read** — top sources are fetched, stripped to text, and reduced to relevant
   notes; when a page is JS-rendered/blocked/thin it falls back to the search
   snippet so the source still counts, and it keeps digging past junk until it has
   enough usable notes.
5. **Reflect** — it asks itself what's still missing and searches again (depth =
   how many rounds: Quick 1 / Standard 2 / Deep 3), stopping early once coverage is
   good. A soft wall-clock budget guarantees it always stops gathering and writes
   the report, however slow the model.
6. **Synthesize** — a structured markdown report with inline `[n]` citations, a
   sources list, and an "Open questions" section; it uses only what it read and says
   so when the evidence is thin.

Progress streams live; runs persist in `data/research/`; any report exports into
your vault under `AI Wiki/Research/`. Because the orchestration is server-side, it
works with every provider — no tool-calling model required.

Meta-trick: AIOS registers itself as a project, so you can point the Agent at
**OS** and have it add features to your own hub.

## Obsidian integration

Point AIOS at your vault folder (Settings → Vault, or the connect screen in Second
Brain). It reads/writes the same markdown Obsidian does — no plugin, no sync layer.
Frontmatter and `#tags` are indexed; `[[wikilinks]]` build the backlink index and
graph. AI-generated notes land in a configurable `AI Wiki/` folder with frontmatter
marking their provenance, densely wikilinked so they weave into your graph.
"Ask vault" retrieves your most relevant notes and answers with `[[citations]]`.

## LAN broadcast & security

- The server binds `0.0.0.0`; startup prints `http://<your-ip>:7777/?token=…` links.
- Default auth mode **Token for LAN**: localhost is open, any other device must
  present the pairing token (the `?token=` link stores it in that browser).
  Settings → Network can switch to *Token always* or *Open*, reveal the token
  (localhost-only endpoint), or rotate it.
- Treat the token like a password: anyone on your LAN with it gets your terminal.
  Don't port-forward AIOS to the internet as-is — put it behind a VPN (Tailscale
  works great) or a reverse proxy with real auth + TLS.

## Layout

```
server/            zero-build Node (ESM), no framework beyond express + ws
  index.js         HTTP + static + REST + WebSocket hub + auth
  config.js        data/config.json, defaults, token
  llm.js           provider abstraction: one event stream over 3 wire protocols
  agent.js         session store + agentic tool loop + approval gate + self-check + memory
  tools.js         sandboxed tool belt (fs, bash, grep, glob, web search, fetch, skill)
  checks.js        syntax gates (esbuild / json / python ast / bash -n)
  skills.js        coding playbooks: stack detection + prompt packing + skill tool
  research.js      deep-research loop (plan→search→read→reflect→synthesize)
  chat.js          plain streaming chat sessions
  projects.js      project registry + git info
  files.js         explorer/editor APIs (root-scoped)
  vault.js         Obsidian index, search, graph, daily, AI wiki growth
  mindmap.js       tree docs + AI generate/expand + vault export
  terminal.js      node-pty (with `script` fallback)
web/               no build step — vanilla ES modules
  js/wm.js         view manager (pages + dock) · js/main.js shell + palette
  js/apps/*.js     the apps (chat, agent, research, files, terminal, projects, vault, mindmap, settings)
  vendor/          self-contained bundles (CodeMirror 6, marked+DOMPurify+hljs, xterm)
skills/            coding playbooks (markdown) injected into the agent by stack
Roadmap.md         idea bucket for future features
data/              your stuff (gitignored): config, chats, agent sessions, research, mindmaps
scripts/           build-vendor.mjs · check.mjs · searxng.mjs · firecrawl.mjs
                   aios-launch.sh + aios.desktop + aios.svg (desktop shortcut)
                   aios.service (systemd unit)
```

`npm run check` bundles the frontend and parse-checks the server — run it after
hacking on AIOS (or let the Agent run it after hacking on itself).
`npm run vendor` rebuilds `web/vendor/` from npm packages.

## Starting it

**Simplest — a desktop shortcut.** `scripts/aios.desktop` (installed to your app
menu and `~/Desktop`) runs `scripts/aios-launch.sh`: it starts the server only if
it isn't already up, waits for it, then opens your browser — with a desktop
notification either way. Right-click the icon for **Open in browser** (no start) and
**Stop AIOS server**. To (re)install after moving the project:

```
desktop-file-install --dir=$HOME/.local/share/applications scripts/aios.desktop
cp scripts/aios.desktop ~/Desktop/ && chmod +x ~/Desktop/aios.desktop
gio set ~/Desktop/aios.desktop metadata::trusted true   # Cinnamon/Nemo: trust it
```

The launcher forces brew's `node` onto PATH (desktop launchers start with a bare
one) and daemonizes the server (PID in `aios.pid`, logs in `aios.log`), so it keeps
running after you close the launcher. The paths inside `aios.desktop` and
`aios-launch.sh` are absolute — edit them if the project moves.

**Always-on — a systemd user service.** Start on login, restart on crash:

```
cp scripts/aios.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now aios
loginctl enable-linger $USER   # keep it up after logout
```

## Roadmap

Future ideas and the running backlog live in [`Roadmap.md`](Roadmap.md) — an idea
bucket you can add to freely. Highlights on deck: vault embeddings for semantic
ask-vault, git-aware agent checkpoints + multi-file patch review, research
follow-ups and a sources drawer, chat attachments (wire vision through
`gemma-vision`), and a mobile-friendly layout pass.
