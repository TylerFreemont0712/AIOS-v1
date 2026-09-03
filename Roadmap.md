# AIOS Roadmap

The single planning doc for AIOS — an idea bucket **and** a decision list. It replaces the
old `Suggestions.md` (folded in 2026-07-20) and `comfyui-plan.md` (folded in 2026-07-27).
Nothing below **Shipped** is committed; it's where features, cuts, fixes, and "wouldn't it be
cool if…" get captured so they aren't lost.

**Priority:** 🔥 wanted soon · ✨ nice-to-have · 🧪 experimental · 💭 blue-sky · ✂️ cut/trim
**Effort:** S ≈ an evening · M ≈ a day or two · L ≈ a week of evenings

**Item IDs are stable and section-scoped** (`B9`, `D11`). They are never renumbered — a shipped
item's line is deleted and its ID retires with it, so cross-references in this file, in commit
messages, and in `comfyui-plan.md` keep pointing at the right thing. New items take the next
free number in their section. **75 open items** — 7 cuts, 15 backend, 25 UI, 17 features, 3 money,
8 desktop control.

**Last verified against this machine on 2026-08-30.** The whole suite runs green — `npm run
check`, `audit` (**66 checks**), `e2e` (18 suites), `toolcheck` (78 pass · 5 env · 0 failed) —
and that pass was a *read* of the working tree rather than a re-run: it re-tested the file-level
✅ claims behind **B2 / B9 / C1 / C2 / C3 / A5** (none had drifted), recounted the line and item
totals above, and found the three bugs in the 2026-08-30 entry below. Claims elsewhere in the
buckets still carry the date they were last checked; **2026-08-18** was the last full re-test of
every one of them.

Every forward-looking item carries a **code hook** (the file/function to start from) so it is
actionable. Claims marked **✅ verified <date>** were checked against this machine, not
recalled — trust them; everything else is a hypothesis.

**Start here → [Top 10 next](#top-10-next).**

---

## Top 10 next

The decision list. If you only do ten things, do these — ordered by (value ÷ effort), with the
reason each one earns its slot.

> ⚠️ **Before anything else: the last six weeks are still not in git.** Re-measured
> 2026-08-30 and it has grown, not shrunk: `server/voice.js`, `server/interview.js`,
> `server/actions.js`, the five browser modules that go with them, `scripts/voice/`, three
> benches and **four e2e suites** are all *untracked* — **6,413 lines**, plus **4,603 lines**
> of uncommitted edits across **24** tracked files. Nothing is ignored by `.gitignore`; they
> have simply never been added. The entire voice stack this file celebrates as shipped exists
> in exactly one place, on one laptop, with no history. A stray `git clean -fd` — which every
> "reset my working tree" instinct reaches for — deletes all of it. This is not a feature and
> it does not have an ID; it is a five-minute job that should happen before the next one starts.
>
> While you are there: `aios.pid` is now in `.gitignore` (added 2026-08-30) but is **still
> tracked**, so it keeps dirtying the tree on every restart until one command retires it —
> `git rm --cached aios.pid`. It has caused 7 commits of its own so far.

| # | Item | Effort | Why it's top-10 |
|---|---|---|---|
| 1 | **H1** — open an app by name, and show it | M | The next thing wanted, and ✅ every piece was proven on this box 2026-08-18: 121 apps discovered from `.desktop` files, `wmctrl` resolves the window, a frame costs **68ms / 44KB**. |
| 2 | **B2** — SQLite-aware backups | S | ✅ `scripts/backup.mjs` still does not exist. `finance.db` is 344KB of **hand-entered money** and the only copies are 7 same-disk `.bak-` files. ⚠️ must exclude the **14GB** in `data/llm/`. |
| 3 | **B5** — mark untrusted content | M | Promoted now that **B4** has shipped. The network half of the injection story is closed — the agent can no longer be *pointed* at this host — but a fetched page's text still arrives in the same context as tool access, unmarked. That is the half that is left. |
| 4 | **B3** — finish rolling out `json_schema` | S | ✅ Down from 22 sites to **10**, across 5 modules (`learn` ×5, `vault` ×2, `comfy`, `financeai`, `mail`). The finish line is close enough to be worth crossing. |
| 5 | **C1** — notification center | M | ✅ `server/notify.js` is still **34 lines**. Every long-running seam already emits events; nothing surfaces them. Highest felt-quality-per-hour in the UI, and **H1** wants it too. |
| 6 | **B9** — harden the auth token | S | ✅ Re-confirmed 2026-08-30, `server/index.js:81`: still a plain `token === c.auth.token`, no attempt limiting, no log, and not a constant-time compare. An evening, and **H4** raises the stakes: synthetic input behind a brute-forcible token is a different risk class. |
| 7 | **C2** — wire up `density` | S | ✅ Re-confirmed 2026-08-30: still defined in `config.js` and read by **nothing**. Genuinely an evening, immediately visible on a laptop screen. |
| 8 | **C14** — nothing on screen says something is running | S | Research, agent turns and bench sweeps all run for minutes with no global sign of life. Cheap, and every long-running seam already emits the events it would need. |
| 9 | **C3** — global Ctrl+K search | M | ✅ `server/search.js` still absent; FTS5 + trigram verified available in `node:sqlite`. The palette finds apps, not the chat from Tuesday. |
| 10 | **A5** — one SQLite helper, not four | S | Turns **B2** from a four-file change into one, and **§F**'s `jobs.db` would be the fifth copy of the same 60 lines. |

**Retired from this list because they shipped:** **B4** and **B7** (both 2026-08-30 — the SSRF
guard, and the `engines` pin with its boot guard; see below), **B1** (the `sendFile`/`h()` race —
fixed and pinned by an audit check 2026-08-18) and **D2** (the MCP client — `server/mcp.js` has
been complete since 2026-07-29, with a Settings tab, presets and an audit check; it sat at #3 of
this table for three weeks after it was done).

## What AIOS already is (don't re-suggest these)

A zero-build, local-first **personal AI operating hub** served on the LAN (port 7777, token
auth, PWA-installable): a web desktop of attached page-views with a dock, Ctrl+K palette, and
9 themes. **22.3k lines of server ESM + 15.1k lines of browser ESM** (✅ recounted 2026-08-30),
three runtime dependencies, **88 tools**, 17 registered apps. On a provider abstraction
(Anthropic + Ollama + any OpenAI-compatible endpoint, addressed as `provider:model`) it runs:

- **Chat** — streaming, per-chat system prompts, chain-of-thought panels, image/PDF/file input,
  a bounded **read-only tool belt** (+ a curated additive-write allowance), folders, an
  auto-learned user profile.
- **Agent** — a Claude-Code-style tool loop (bash/read/write/edit/glob/grep/fetch + git, vault,
  planner, mail, comfy, wiki, research, custom-forged tools), approval modes, **plan mode**, a
  syntax **and real-test** self-check loop, injected coding playbooks, per-project `.aios/`
  memory, a per-file diff rail, commit/push/PR from the composer, and a **lean tool loadout**
  that hides non-core tool groups from small models until they ask.
- **Research** — server-orchestrated plan→search→read→reflect→synthesize with citations,
  sub-question steering, PDF ingestion, and a wall-clock budget; auto-exports to the wiki.
- **Studio** — ComfyUI cockpit: txt2img, img2img, and ESRGAN upscale; Animagine + Lightning-LoRA
  sampling plans, pixel-space hi-res 2-pass, an LLM prompt generator, and AIOS-owned
  ComfyUI/llama lifecycle with a VRAM guard that stops llama-server outright for the GPU.
- **Second Brain** — Obsidian vault read/write/search/graph, a typed-note system (7 kinds +
  templates), autolinking, a generated Home MOC, and `wiki_recall` packed-memory retrieval.
- **Learning Corner** — an AI tutor: a subject **tree**, AI-designed capability roadmaps,
  web-grounded lessons, and **assessments with per-question grading + per-topic mastery**
  (SQLite; multiple-choice, short-answer, ordering).
- **Finances** — a full ledger (earnings, expenses, budgets, goals, recurring entries, presets),
  seven tabs over one period selector, CSV export, multi-currency with a re-denominating rate
  table; an **Income tab** for freelance work (four logging modes, hours/pieces recorded,
  a daily log, per-payer effective rates, year-to-date with a run-rate projection);
  **receipt capture** (photo → vision-model OCR → reviewed → posted); and **item price
  tracking** (brand-free catalogue, confirmed-alias point of truth, unit-price comparison).
- **Models / Bench** — the llama-launcher **absorbed into the web UI** (per-model presets, live
  GPU/VRAM, log pane, VRAM-fit hints, mmproj pairing), a **deterministic model benchmark**
  (`data/bench.db`: score + TTFT + tok/s per model per category, no LLM judge), and seamless
  serving: any `local:<alias>` ref hot-swaps llama-server on demand, never mid-generation.
- **Life layer** — Planner (calendar, recurring events, birthdays, reminders, tasks), Mail
  (read-only IMAP triage with sender ratings, mini-Gmail viewer, Discord pings), Weather, an
  **everyday toolbelt** (directions, places, translate, convert, calculate, datetime, wikipedia),
  and a Home dashboard that folds all of it into one glance.
- **Voice** — speech in and out, entirely local: faster-whisper (CPU int8) for listening,
  Kokoro-82M ONNX for speaking, in one on-demand Python worker that is dropped again after
  `voice.idleMinutes`. Dictation in the Chat composer, a hands-free **Voice mode** overlay with
  a live orb, read-aloud on any reply, and ja/zh routed through **misaki** so kanji are read
  rather than described. 54 voices, blendable, with a pinnable spoken language.
- **Interview mode** — the hands-free screen as a practice room: the model interviews you out
  loud and probes the weakest part of each answer, or answers as a strong candidate would. A
  session is an ordinary chat with a composed prompt, so it scrolls, survives a reload and
  shows up in Chat; any turn can be kept to a flashcard **answer bank**.
- **Confirm before writing** — every write the assistant proposes comes back as an editable
  card (`server/actions.js`, 8 actions) and nothing touches the ledger, calendar or vault until
  it is confirmed. By voice the card is read aloud and a spoken "yes"/はい settles it
  **server-side**, so a bare yes never reaches the model and cannot be acted on twice.
- **MCP client** — external MCP servers join the tool belt as a first-class group
  (`mcp:<server>`): stdio transport, paginated discovery, namespaced tool names, the existing
  approval gate, isolated failures, presets and a Settings tab.
- **Phone view** at `/m` — a separate document for one-handed receipt capture, sharing only
  `theme.css`, `api.js` and `imageprep.js` with the desktop shell.
- **Files** (tree + CodeMirror), **Terminal** (node-pty/xterm), **Projects** (git badges),
  **GitHub** (profile, heatmap, repos, PRs, issues, publish/clone).
- **Plumbing** — SearXNG (bundled), PDF ingestion, ffmpeg-backed image intake, sampling
  controls, shifting context window, service probes, desktop launcher, and
  `npm run check | audit | e2e | toolcheck` — **18 e2e suites, 59 audit checks, 88 tool
  checks**, mock-provider driven, ✅ all green 2026-08-18.

### Recently shipped

**2026-08-30 (later) — the words now appear while you are still saying them**

"Why does my old iPhone dictate instantly and this doesn't?" turned out to have a
measurable answer that was not about hardware.

- **Whisper is the wrong shape of model for dictation, and here is the number.** It is a
  seq2seq model over a fixed 30-second window, so it decodes the padding too. On `small`:
  **0.83s of audio costs 1786ms, 9.71s costs 2163ms — 11.7x the audio for 1.21x the time.**
  Saying "Log it." costs the same as a ten-second sentence. The old partials re-ran that over
  the whole utterance once a second, which is quadratic work for a result that keeps changing.
- ✨ **A streaming Zipformer transducer (sherpa-onnx) now drives the live text.** It carries
  decode state between 200ms chunks and emits tokens as they are recognised — **RTF ≈0.065**
  on four CPU threads, so a chunk costs ~14ms. Measured end to end through the HTTP route:
  first words at **0.6–0.8s**, then growing word by word. The model is the multilingual build
  (ar/en/id/ja/ru/th/vi/zh), picked over the better English-only ones because half of what gets
  dictated here is Japanese — it reads 五万円 correctly, which `normalizeTranscript` then turns
  into 50,000円 exactly as it does for whisper.
- **It is feedback, not the answer, and that split is the design.** On the same clips it
  produced "THREE THOUSAND **JANET** LAWSON" for "three thousand yen at Lawson" and read 今日は
  as 気に, and it emits no punctuation and upper-case English. Whisper still does the single
  accurate pass that reaches the model and the ledger. **Feel from one, accuracy from the
  other** — replacing whisper outright would have traded away the thing that was already good.
- ⚠️ **Its endpointer is NOT wired to end a turn, and that is the interesting part.** It was, at
  first: the transducer says when it thinks a sentence finished, which sounds strictly better
  than a loudness timer. The browser e2e refused it immediately — `voice-convo`'s "a mid-sentence
  pause must NOT end the turn" case went red, because at `rule2=0.8` it fires ~1.0s after speech
  stops and this loop is tuned to 1100ms (2400ms in an interview) for a *measured* reason: a
  0.9s thinking pause used to cut the turn and return a confident reading of half a sentence,
  62% WER against 38%. A second opinion that only ever ends turns EARLIER can only reintroduce
  that. The signal is plumbed through and left unwired, with the reason written at the call site.
  → **C25** is the version worth having: use it to *extend* a turn, not shorten one.
- **The browser had to change too.** An `AudioWorkletProcessor` (`web/js/voice-worklet.js`) taps
  every sample — an AnalyserNode could not, because it only ever returns a *snapshot* and the
  audio between animation frames is simply not in it. Blocks are averaged down to 16k rather
  than decimated (plain decimation aliases consonants back into the speech band), converted to
  Int16 and shipped on the existing `/api/voice/partial` route. **MediaRecorder still runs in
  parallel** for the final pass, so the accurate path is untouched.
- **Cold start had to be dealt with.** The model is ~300MB of ONNX and takes **3.7s** to load,
  and the worker answers one request at a time — so opening the mic before it is ready queued
  the first chunks behind the load and the entire first utterance went by with no live text,
  which is the one turn where someone is deciding whether the feature works. Voice mode now
  waits for the warm (capped, and it says so on screen) before opening the mic. Found by the
  browser e2e, not by reasoning: the probe showed the tap working, PCM shipping, and the server
  returning empty text.
- **Chat dictation gets live text as well**, which is the case the question was actually about —
  typing into a box with your voice. The provisional text is anchored to whatever was already
  in the composer and replaced wholesale by the accurate reading, so nothing typed beforehand is
  lost and no guessed word survives.
- **Old clients still work.** The route branches on content type: PCM goes to the transducer,
  a container goes down the original whisper path. The phone PWA caches its bundle hard, so a
  stale client degrades to the old feel rather than to no feedback. Covered by a test.
- `npm run voice` installs it (`--no-streaming` skips the 259MB model); `--check` reports it;
  9 new e2e assertions cover that the hypothesis *grows*, that the endpointer fires after the
  speech and not during it, and that the fallback still answers. **111 voice checks pass.**
- ⚠️ **Still on the table:** `voice.stt.device` is `cpu` while the GPU sits idle. Whisper `small`
  measured **2045ms on CPU vs 180ms on cuda/fp16 — 11.4x**. The driver mismatch that justified
  CPU has been resolved (see above). That is a one-setting change and the single biggest
  remaining latency win.

**2026-09-01 (later) — "Cannot read properties of null (reading 'spoke')": four bugs in
who owns the microphone**

Reported the moment the transducer went live, and nothing to do with streaming. The
recorder handle is read back off `this.rec` / `mic` AFTER an await, and every control
that ends a recording — Pause, the Mode button, `beginInterview`, the Chat pane's
`_voiceCleanup` — calls `abort()` and nulls that field **synchronously**. `abort()`
resolves `done`, but the continuation only runs a microtask later, by which time the
field is already gone. **Deterministic, not a race:** pressing Pause while listening
crashed every single time.

- 🐛 **It bricked voice mode, not just the turn.** `listen()` wraps the whole turn in
  its own try/catch and hands the message to `fail()` — which writes it to the
  overlay's status line **and disables the orb**. The only control left was dead, so
  the overlay had to be closed and reopened. `fail()` is right for "no model
  installed" and wrong for a microphone that was busy for one turn; that path now
  reports and returns to idle.
- 🐛 **`stop()` on a recorder still inside `getUserMedia` was a no-op**, so `start()`
  went on to open the microphone anyway — for a recording nobody was waiting on, with
  the browser's recording indicator lit and no control left to turn it off. `stop()`
  before the device opens is an abort now, and `start()` checks its own state when
  getUserMedia resumes.
- 🐛 **Two fast clicks on the composer mic opened TWO recorders.** `toggleMic` awaits a
  status re-probe and then getUserMedia before assigning `mic`, and the second click
  took the "start" branch as well. The first recorder was then held by nothing at all.
- 🐛 **Closing the Chat pane mid-dictation left the microphone open**, for the same
  reason one step earlier: `_voiceCleanup` finds `mic` still null and has nothing to
  abort.

The fix is ownership rather than four null checks: the recorder is held in a **local
from the moment it is constructed**, the field is only ever an identity check
(`this.rec !== rec` → this turn is no longer mine), and the catch is scoped the same
way so a late error cannot null a *newer* turn's recorder out from under it.

- ⚠️ **Three places a browser failure can hide, and the suites watched two.**
  Exceptions and console errors were covered; error toasts were added after the "v is
  not defined" bug. This one was **a phase attribute and some grey text inside the
  overlay** — invisible to all three, so `voice-ui` sailed past a run with "Cannot read
  properties of null" sitting on screen. `step()` now fails when `.vm-overlay` is in
  the `error` phase.
- ⚠️ **The coverage gap that let it ship: every control was only ever pressed from
  idle.** The suite starts listening and stops again before touching anything else,
  and the bug only exists in the other order. It now presses Pause, `p`, hands-free,
  mute and the orb **while listening**, asserts the orb still works afterwards, and
  double-clicks the composer mic. **122 voice-UI checks, up from 102.**
- 🐛 **A test that lied, found while verifying the above.** `voice-convo`'s speaker
  check started failing as `reports finished (["speaking"])` — which reads exactly
  like the hands-free-loop regression it exists to catch. It was neither that nor the
  mic work: `git stash`-ing the fixes reproduced it just as reliably, and a probe that
  polled instead of sleeping showed the Speaker reaching `idle` in **6236ms** against
  the fixed `setTimeout(4000)` the test allowed. The deadline was accidental — nobody
  meant to assert that three sentences synthesize and play inside four seconds — and
  the user's own browser being open on the hub was enough to blow it. The two halves
  of that test need opposite waits: proving no false `idle` arrives BETWEEN sentences
  is an absence and wants a fixed window; proving `idle` arrives after `flush()` is a
  presence and wants a poll. It polls for 20s now, so a real regression still fails it
  and a busy laptop does not.

**2026-09-01 — the live recogniser, measured for the first time: 39.7% WER → 20.3%**

The transducer shipped on 2026-08-30 with no bench of its own — `voice-bench` scored
whisper and nothing scored the thing writing words on screen. It does now
(`npm run voice-bench -- --stream`, 36 clips, fed 200ms at a time exactly as the
browser feeds it), and it found three defects that reading the code would not have.

| | WER | |
|---|---|---|
| as shipped | **39.7%** | |
| + flush the stream on close | 28.7% | −11.0 |
| + stop resampling in JS | 25.2% | −3.2 (at 48kHz) |
| + `modified_beam_search` | **20.3%** | −3.3, and the first word 130ms sooner |

- 🐛 **The last word or two of every utterance was never emitted.** A zipformer decodes
  in fixed chunks and the samples in the final partial chunk never form one. The live
  line read `…AT LAWSON ON LUN` and stayed there for the two seconds whisper takes.
  `stream.end` pads with silence and flushes — and `endPartial` now **awaits and
  returns** that text, where it was fire-and-forget, so the flush existed but nobody
  ever saw its result. The browser ships its last buffered 200ms before closing too;
  that block was being dropped on the floor.
- 🐛 **The endpointer wiped what it had already heard.** sherpa resets the decoder on
  an endpoint — correct, or the next sentence inherits this one's state — but the
  decoded text went with it, and a 1.2s thinking pause trips it mid-turn routinely.
  The line went from the whole first sentence to only what came after the pause. This
  is the same failure the recorder's 1500ms silence window exists to prevent (see
  **C25**), one layer down. Segments are committed before the reset now.
- 🐛 **The browser was resampling with a box filter.** 48k → 16k by averaging blocks:
  barely a low-pass, aliasing the high frequencies that separate consonants, **3.2
  points**. There is no resampler in the browser any more — the `AudioContext` is
  asked for 16kHz (the browser does it natively, properly) and whatever rate it
  settles on travels with the bytes for sherpa to resample in C++. Roughly 40 lines
  of hand-rolled DSP deleted rather than fixed.
- ✨ **Beam search is the default decoder.** RTF 0.086 → 0.111 against a 200ms budget
  is not a number anyone can feel; 23.6% → 20.3% and 130ms to the first word are.
- ⚖️ **Contextual biasing is built and left OFF, because it was measured.**
  `stt.streamHotwords` feeds the transducer the same merchant list whisper gets as a
  prompt. On *this* ledger — Outlier, Mercor, Prolific, Micro1, all ordinary English
  words the model already reads — it went 25.0% → **26.4%**, and above `hotwordScore`
  3 it starts pulling neighbouring words toward a merchant (`for lunch` → `for nge`).
  It works where it should: "FAMILY MARCH" → "FAMILY MART", and 22.3% → 20.9% on
  clips full of Japanese shop names. One flag, documented with both numbers.
  Getting there needed sherpa's `bpe.vocab`, which the official recipe builds with the
  `sentencepiece` package — a C++ wheel added to the voice venv to read two fields out
  of a protobuf. `_sp_pieces()` reads them directly instead and caches the result
  beside the model; no new dependency.
- ✨ **The live line writes numbers as figures.** The transducer spells them out and
  whisper does not, so the provisional and the settled reading disagreed on screen at
  the moment the eye compares them. `foldSpokenNumbers` is applied to the transducer's
  output ONLY: running it over the reading that reaches the ledger would turn "one of
  the receipts" into "1 of the receipts". A single number word folds only when a
  counter settles it — "TWELVE MAN" must become "12 man" or `normalizeTranscript`'s
  counter rules, which all require a digit, never fire and 120,000 yen goes missing.
- **Coverage: 117 voice checks (was 111), and both new ones were verified with teeth.**
  The first attempt at the endpoint test *passed with the bug reintroduced* — it
  asserted on a variable the test loop had kept rather than on what the server
  returned, and an empty response passes by never overwriting anything. It takes two
  utterances either side of a pause to catch it. The tail test had the same problem
  from the other end: the existing case appends 2s of silence, which trips the
  endpoint, commits the sentence and hides the truncation entirely — it needs a stream
  that ends the instant the speech does, which is what stopping the recorder as you
  finish a word actually does.
- ⚠️ **The running server was 46 hours old and predated the entire feature.** Its
  `/api/voice/status` had no `streaming` field at all, so every client read
  `streaming: false` and silently used the old whisper-rerun partials. The transducer
  had never once run in a browser. Same shape as the six-day stale instance already on
  record: **the pidfile was accurate and the code was correct, and neither tells you
  what is actually serving port 7777.**

**2026-08-30 — a read-through pass: three bugs, and the agent can no longer be aimed at this box**

A full read of the working tree rather than a re-run of the suite, because the suite was already
green and everything wrong with it was in the gap it did not cover. `audit` is **66
checks** now (was 59), `e2e` 18 suites, `check` clean.

- 🐛 **B4 shipped — `fetch_url`, `crawl_site` and Research's PDF ingestion were an SSRF hole,
  and it was reachable by a web page.** The URL comes from the model, or from a search result;
  the model gets its ideas from the page it just read. All three readers (`fetchReadable`,
  `fetchRaw`, `fetchPdfText`) called `fetch()` with `redirect: 'follow'` and no address check
  at all, and this host answers on loopback with ComfyUI (8188), llama-server (8080),
  SearXNG (8890) and Ollama (11434) — none of which ask for a password — plus AIOS itself.
  Confirmed live before the fix, not by reading: `fetchReadable('http://127.0.0.1:7777/api/status')`
  returned the status JSON. Now one `safeFetch()` resolves the name, refuses anything that is not
  public unicast, and **re-checks every redirect hop** — the hop being the interesting half, since
  `redirect: 'follow'` hands the destination to whoever wrote the `Location` header, which is the
  same untrusted party. Proven end to end: `httpbin.org/redirect-to?url=http://127.0.0.1:7777/`
  is allowed at hop 0 and refused at hop 1.
- **The classifier is the part worth checking, so it is checked.** 15 private forms refused
  (v4 private/loopback/CGNAT/link-local/multicast/reserved, v6 loopback/ULA/link-local/multicast,
  and both spellings of an IPv4-mapped v6 address — `::ffff:127.0.0.1` and `::ffff:7f00:1`),
  unparseable input fails closed, and `8.8.8.8`, `1.1.1.1`, `172.32.0.1` (just past `172.16/12`)
  and a public v6 address stay fetchable. **All** addresses a name resolves to are tested, not the
  first — a name answering with one public and one loopback address is the standard way past this.
- **There is an escape hatch, off by default:** `tools.allowPrivateFetch`, for someone who
  genuinely wants the agent reading their own LAN. `everyday.e2e.mjs` crawls a loopback test
  server, so it now asserts the refusal *first* and then opts in, which is the honest way to
  keep that test.
- 🐛 **A live partial could overwrite the finished transcription — the guard against it never
  ran.** `endPartial()` sets `closed = true` on the stream object *and* deletes the map entry;
  the in-flight check read `streams.get(id)?.closed`, which is `undefined` once the entry is
  gone, so it never fired. Reproduced against the real worker: pre-fix an in-flight partial came
  back `{text, raw, ms, bytes}` after the recording had ended, post-fix `{stale: true}`. The
  browser had its own `state === 'recording'` guard, which is why nobody saw it — the server
  half was simply doing a wasted ~0.4s whisper decode and returning a result that should not
  exist. Both fixes are pinned by audit checks; the SSRF one strips comments before grepping,
  because the paragraph explaining why `redirect: 'follow'` is wrong otherwise counts as an
  offence (the same false positive the 2026-08-18 `sendFile` check documents).
- 🐛 **One bad spawn left voice dead until the server restarted.** `ensureWorker()` assigns
  `booting = new Promise(...)`, and the failure path calls `killWorker()`, which nulls `booting`.
  When the failure is *synchronous* — `spawn` throwing rather than emitting `'error'` — that null
  happens inside the executor, and the assignment then overwrites it with the rejected promise.
  Every later `ensureWorker()` hit `if (booting) return booting` and replayed the original error
  forever. Proven in isolation (the retry rejects with the first error, unchanged), then fixed by
  clearing through the local on both outcomes, with an identity check so a superseded boot cannot
  clear a newer one. Narrow to trigger and total when it does, which is the worst combination for
  something you would try to debug from a log.
- ✅ **B7 shipped — the runtime is pinned.** `engines: node >=22.13.0` plus a boot guard in
  `server/index.js` that names the reason: four stores are `node:sqlite`, which is not importable
  unflagged before 22.13 / 23.4, and an older Node otherwise fails deep inside whichever data
  module loads first with an error about an unknown module.
- **`vocabularyPrompt()` cached one budget and served it to every caller.** The cache was keyed on
  time alone, so a caller asking for a smaller `max` got a string built to fill a larger one.
  Latent today (both callers use the default) and a one-line key change, but it is the kind of
  thing that is only ever found on purpose.
- **`aios.pid` is in `.gitignore` at last** — 7 commits of its own so far. ⚠️ Still *tracked*,
  so it keeps dirtying the tree until `git rm --cached aios.pid`.
- ⚠️ **The working tree is still not in git, and has grown**: 6,413 untracked lines and 4,603
  uncommitted across 24 files. See the warning above the Top 10.

**2026-08-29 — receipt OCR: a bench first, then a reader a ninth the size**

The pipeline had no way to answer "is this reading any good", so every model decision was a
guess against somebody else's leaderboard. It has one now, and the first thing it measured was
the model that was already installed.

- **`npm run receipt-bench` — the archive was already a labelled test set.** Every receipt
  pressed *Log* on is one checked against the paper, and `finance_receipt.parsed` holds that
  settled version; `parsed_ai` holds what the model said before the correction. 23 applied
  receipts, 18 of them hand-corrected. `--stored` scores the readings already in the database
  and needs no GPU at all.
- **Baseline, measured not recalled:** Gemma 4 E4B over the 18 corrected receipts scores
  **72% on totals, 89% on the shop, 65% of line amounts found, 16 invented lines and 45 missed.**
  The failure is concentrated exactly where the resolution story predicted: small receipts are
  perfect, and a 19-item drugstore receipt came back **0/19**.
- 🔥 **HunyuanOCR (Q8_0, 578 MB) replaces Gemma 4 E4B (4.74 GB) as the reader.** On the same
  19-item receipt it transcribed every product, every JAN barcode and the exact total ¥4,123.
  Over the 9 item-rich receipts: **79% of line amounts, totals found 7/9**, mean 52 s on CPU.
  PaddleOCR-VL 1.6 (935 MB) is also installed and configured — 78% amounts, totals 6/9, and it
  dropped the ¥305 tax line by unpairing labels from amounts, which is why it is second choice
  rather than first.
- **Single-pass extraction was tested and rejected.** HunyuanOCR advertises structured field
  extraction and would have collapsed both stages into one. Asked for the receipt schema
  directly it returned `4.123` for ¥4,123 — a JSON number grammar cannot carry a thousands
  separator — plus an unparsed Japanese date and the branch instead of the chain. Transcribing,
  it got all three right. **The two-stage split stays**, now for a recorded reason.
- **Deskew.** `uploads.deskew()` measures the hand-held tilt by projection profiling and undoes
  it before the crop. Verified ±8° measured within 1° and corrected to ~0, and a straight page
  is left alone. No new dependency: ffmpeg's `rotate`, and an aspect-preserving raster
  (`greyFit`) because the square one used elsewhere distorts the very angle being measured.
- **Runaway readers are cut off.** Greedy decoding at temperature 0 is what makes this pipeline
  reproducible and also what makes a reader loop: HunyuanOCR read a McDonald's receipt as a
  Markdown table, got every line right, then emitted `| | | |` to the token cap — 7,987
  characters. `trimRepetition()` cuts a run of ≥6 identical lines that reaches the end. A
  repetition *penalty* was rejected: this archive has 国産豚肉 ミンチ printed three times at
  three prices, and that is the correct reading.
- **Per-model prompts are configuration now.** `TRANSCRIBE_PROMPTS` matched by substring and
  knew one model; `presetFor()` carries `ocrPrompt` and `ocrStyle`, so adding a reader is a
  preset edit. Six readers are installed and tagged.
- ⚠️ **The full bake-off has not run.** `nvidia-driver-580` was updated to 580.173.02 without a
  reboot, so the loaded kernel module is still 580.159.03 and `ggml_cuda_init` fails — llama.cpp
  sees no GPU and everything above was measured on CPU. The matching module is installed for
  this kernel; a reboot fixes it. Then: `npm run receipt-bench -- --all-ocr`.
  **✅ Resolved by 2026-08-30** — the loaded module is now 580.173.02 and CTranslate2 reports one
  CUDA device with fp16 available. The bake-off is still worth running; the blocker is gone.


**2026-08-18 — a full audit pass: one silent, total failure found and fixed**

The whole suite was run and every forward-looking ✅ claim in this file re-tested against this
machine rather than carried forward. The headline is that the test story is genuinely strong —
**59 audit checks, 18 e2e suites, 88 tool checks, 0 failures** — and that the one confirmed bug
was in the gap none of them covered.

- 🐛 **B1 shipped — every file download the Files app has ever made was broken.**
  `/api/fs/raw` was wrapped in `h()`, whose callback returns `undefined`, so the wrapper fired
  `res.json({ok:true})` while `res.sendFile` was still doing its async stat. Confirmed live, not
  by reading: `curl /api/fs/raw?…&path=package.json` returned
  `content-type: application/json` and the eleven bytes `{"ok":true}`. It has been that way since
  the route was written; the three sibling routes (`/api/uploads/:id`, `/api/comfy/image/:name`,
  `/m`) were each converted to plain handlers when the bug was understood, and this one was
  missed every time — which is precisely why it is now checked instead of remembered.
- **The check has teeth, and getting there was the interesting part.** A naive grep for
  `sendFile` near `h(` matched every route in the file. Two reasons, both worth recording:
  `h\(` also matches the tail of `push(` and `imagePath(`, and a naive string-skipper reads the
  apostrophe in a comment — *"a sample of the user's recent messages"* — as an opening quote and
  swallows every paren after it. The shipped detector paren-matches from the `h(` and skips
  comments and string literals; it was validated by running it against the pre-fix source
  (finds exactly `/api/fs/raw`) and the post-fix source (finds nothing) before being trusted.
- ⚠️ **D2 had been sitting at #3 of the Top 10 for three weeks after it shipped.**
  `server/mcp.js` has been a complete MCP client — stdio transport, paginated discovery,
  namespaced names, the approval gate, presets, a Settings tab and its own audit check — since
  2026-07-29. A decision list that recommends work already done is worse than no list, so
  re-verifying the Top 10 is now part of the audit rather than a thing done from memory.
- ⚠️ **The voice subsystem is not in version control.** See the warning above the Top 10.
- **Re-confirmed still open** (all ✅ re-tested 2026-08-18, none had drifted): **B4** — no SSRF
  protection of any kind in `tools.js`; **B7** — no `engines` field, with four `node:sqlite`
  stores; **B9** — `token === c.auth.token`, no attempt limiting; **C2** — `appearance.density`
  read by nothing; **C1** — `notify.js` still 34 lines; **C3** / **A5** / **B2** — `search.js`,
  `db.js` and `backup.mjs` still do not exist. **B3** has genuinely moved: 22 hand-parse sites
  down to **10**.
- **Measured, so §H can be planned rather than guessed** (this box, X11/Cinnamon, `DISPLAY=:0`):
  121 launchable apps parse out of 173 `.desktop` files; Obsidian is the flatpak
  `md.obsidian.Obsidian` and declares `StartupWMClass=obsidian`, which is the key that resolves
  its window after launch; `wmctrl -lpx` gives window↔PID↔class; a window frame captured with
  `xwd | ffmpeg` costs **68ms and 44KB** scaled to 900px, so a 2-4fps live pane is ~5% of one
  core. `xdotool` is *not* installed (it is one `apt install` away) and is the only missing
  piece, needed solely for synthetic input (**H4**).
- **Housekeeping found:** `data/` is **14GB**, of which `data/llm/` is 14GB and everything that
  matters is ~30MB (⚠️ **B2**); `data/aios.db` is a 0-byte file referenced by nothing;
  `aios.pid` is **tracked in git** and churns on every restart, which is where the
  "chore: update aios process PID" commits come from — it belongs in `.gitignore`. Dependency
  drift is mild: `@anthropic-ai/sdk` 0.112.4 → 0.117.1, `@xterm/xterm` 5.5 → 6.0 (major),
  `ws`/`marked`/`highlight.js`/`dompurify` one patch behind (**B16**).
- **No leaks found where they were looked for.** The voice worker (1.3GB RSS) is a plain child
  whose `readline()` loop breaks on stdin EOF, so it dies with the server rather than orphaning;
  WS clients, PTYs, MCP children, chat/agent/research abort maps and vault aborts all have
  matching cleanup, and the WS layer already terminates a client whose backlog passes 8MB.

**2026-08-15 — it listens, it answers, and it asks before it writes**

- ✅ **D8 shipped — voice in and out, all local.** faster-whisper (CTranslate2, CPU int8) for
  listening and **Kokoro-82M** ONNX for speaking, in one long-lived Python worker
  (`scripts/voice/worker.py`) that loads on demand and is dropped again after
  `voice.idleMinutes`. Three surfaces: dictation in the Chat composer, a hands-free
  **Voice mode** overlay, and read-aloud on any reply. `npm run voice` installs the lot into
  its own venv under `~/.local/share/aios/voice` — deliberately not the ComfyUI venv.
  Roadmap note said Piper was archived; Kokoro was the right call, at ~4× realtime on CPU.
- **Japanese actually works.** espeak-ng does not read kanji, it reads *about* them —
  今月の食費 phonemizes as "Chinese letter, Chinese letter, Chinese letter", 17.5s of audio for
  a 20-character sentence. Routing ja/zh through **misaki** instead gives 3.5s and a clean
  whisper round trip. The voice you pick now sets the language, so this cannot be
  mismatched by accident.
- 🐛 **Two bugs the browser E2E caught that no unit test could.** (1) The silence detector
  calibrated its noise floor on the first 400ms — so answering the moment it started
  listening, which is exactly what hands-free invites, made your own first syllable the
  "room noise" and gated out everything you said. It now tracks the floor continuously,
  fast toward quiet and barely toward loud, and freezes once speech is confirmed.
  (2) The streaming speaker reported "finished" whenever its queue drained, which during a
  stream happens *between sentences* — so the loop started listening to the second half of
  its own answer. Both are covered by `scripts/e2e/voice-convo.e2e.mjs`, which feeds Chromium
  a WAV as its microphone and drives the whole loop with nobody in it.
- ✨ **Confirm before writing (new `server/actions.js`).** Chat used to run a handful of
  additive writes outright. Now every one comes back as an editable card — "Income JPY 50,000
  from Uber Eats · Freelance · 2026-08-15" with Confirm / Edit / Discard — and nothing is
  written until you agree. By voice the card is read aloud and a spoken "yes" (or はい) settles
  it, handled server-side so a bare yes never reaches the model and cannot be acted on twice.
  Eight actions registered, including two new ones (`finance_budget_set`, `finance_goal_set`).
  Off switch in Settings → Chat.
- 🐛 **Uncategorised income was about to default to "Main Job"** — the one category the
  monthly goal EXCLUDES, so gig income would have silently vanished from the number being
  watched. Caught while writing the action defaults; it now defaults to Other Income.
- **Finances Overview leads with the two questions you actually open it for.** A status band
  across the top: *goal met* vs *what is left to spend*, the latter measured in the same scope
  as the budget and with recurring bills that have not posted yet subtracted out — because a
  "left to spend" figure that quietly includes next week's rent is the most misleading number
  this screen could show. The twelve-month chart moved below it; the old small Goal card is
  gone (`finance.monthStatus`, `GET /api/finance/status`).
- 🐛 **`meter()` drew two contradictory readings of the same bar** when a stretch target was
  set: the fill scaled to the base target while the stretch mark was positioned as a fraction
  of the stretch, so a met goal sat at 100% *and* its own marker sat at 55%. The track now
  spans the stretch, and passing an income goal paints green instead of the red it shares
  with a blown budget.

**2026-08-04 — the small print gets read, and typing a number stops fighting back**

- 🐛 **You could not type a multi-digit amount into the income form.** Every keystroke
  repainted the field slot to keep the running total honest, and emptying that slot detaches
  the `<input>` the caret is in — a detached input is a blurred one. "1200" landed as four
  separate one-character edits. Split into `paintMode()` (chips + fields, on mode change
  only) and `paintPreview()` (the live total, which contains nothing focusable). Same bug
  the receipt editor had and the same fix; the receipt one carried a comment explaining it,
  which is how this one was found.
- **The keyboard now finishes what it starts.** Adding a receipt line puts the caret in it,
  Enter on the last line adds another (Enter elsewhere steps down the table), and Enter in
  the income form logs it. Adding several missed lines was the case that mattered: it is
  exactly what you do when the model read the receipt badly, and it cost a click per line.
- **A long receipt is read in overlapping bands.** The same finding that made cropping worth
  more than the model swap, one step further: a model resizes its input before it reads
  anything, so a cropped till receipt at 3-6:1 loses most of its vertical resolution — and
  that is the resolution the *product names* are printed in. Totals are large text and
  survive, which is exactly the reported symptom: right total, wrong names, sometimes an
  item code where a name should be. `uploads.sliceTall()` cuts a strip into bands of about
  1.4:1 with a 14% overlap; `stitchTranscripts()` joins them by finding **two or more
  identical lines** agreeing across a seam. One matching line is never a seam — a lone
  "¥180" repeats innocently — and when nothing agrees the halves are simply concatenated,
  because a duplicated line overshoots the total and lands in front of the reviewer, while a
  dropped one balances and is silently wrong. Only line-oriented readers can be tiled;
  dots.ocr answers with one layout object per image and keeps the whole photo.
  `finance.ocrTiles` (default 3, cap 4, 1 = off), exposed in Settings → Finances.
- **An item code is not a product name.** Both prompts now say so, and `looksLikeCode()`
  flags a name that is a bare run of digits. Flagged, never dropped — something *was* bought
  on that line, and the reviewer's correction is what the catalogue learns from. Deliberately
  narrow (no letters, no CJK, 3+ digits) so "500ml" and "2%" never trip it: a warning on a
  real product teaches people to ignore warnings.
- **Income from a screenshot.** A payout screen already states the payout, the platform's
  cut, the trips and the hours; logging it meant reading four numbers off a phone and typing
  them into another screen, which is the kind of task that stops getting done after a
  fortnight. `readEarnings()` shares the reader and *nothing else* — no scan stored, no fix
  written, no path to the ledger — because a payout screen has no shop, no basket and no
  arithmetic of its own to check a reading against. It fills the income form in the mode the
  reading supports (gross + cut → gross − fee, hours → hourly, jobs → per item, otherwise a
  flat amount), and a figure worked out from the other two is declared as such.
- ⚠️ **Two tests were found asserting behaviour that had been deliberately changed** — the
  re-read loop and `crawl_site`'s place in the chat belt. Both now pin the *current*
  contract, in both directions. See the correction under the re-read bullet below.
- **Coverage:** three new audit checks (`a long receipt is read in bands and stitched back`,
  `an item code is not a product name`, `a payout screen fills the form, not the ledger`).
  **58 hard checks, 0 failing; 14/14 e2e suites.**


**2026-07-27 — receipts: no duplicates, a visible confidence score, and a learning loop that
covers amounts and shop names**

Three things a scanner needs before it can be trusted with money unattended.

- **One purchase cannot be logged twice.** The same receipt photographed on the phone and
  again at the desk used to post twice and silently double a day's spend — nothing
  downstream could tell the copy from the original. `receipts.receiptFingerprint()` keys a
  scan on **date + currency + total + the sorted line items**, deliberately *not* the shop
  name: that is the field two readings of one receipt are most likely to word differently
  ("7-ELEVEN" vs "セブン-イレブン"), and letting a copy through because the shop wobbled
  defeats the point. A receipt with no line items falls back to including the shop, because
  two ¥500 lunches on one day is a real thing where an identical basket is not. Stored on
  `finance_receipt.fingerprint` (indexed), checked in `apply()`, and **refused outright with
  409** — no "add it anyway", which is a button that gets clicked past exactly when it
  matters. The review screen and the phone card show it *before* the Log button, and hide
  the button rather than offering one whose only outcome is an error. Reverting the original
  frees the copy: the guard is about the ledger, not the scan. `backfillFingerprints()` runs
  once at boot so scans stored *before* the guard existed are covered too — otherwise the
  hole would sit exactly where it is least expected, over the receipts already logged
  (✅ indexed 7 on this machine).
- **Every scan scores itself, 0-100, and says why.** `receipts.scoreConfidence()` is
  deterministic — no second model call, and no self-reported confidence from a model that
  has no idea when it is wrong. It weighs the arithmetic (by far the strongest signal, since
  a receipt is a closed system), fields that are printed on every receipt ever issued,
  garbled codepoints, per-line price-probe objections, summary lines the model handed over
  as products, and **how much of the basket the catalogue recognises** — a line matching a
  string the user personally confirmed is near-certainly read right. `normalize()` now
  *declares* the two substitutions it used to make silently (`dateGuessed`, `totalDerived`)
  so a reading held together by defaults cannot look as good as one read off the paper. The
  number appears as a meter with reasons in the review editor, a pill in the list, and a
  compressed strip on the phone.
- **An unreadable scan turns the photo and reads it again, up to three times.** The two
  failure modes want opposite responses, and telling them apart is most of the value:
  **nothing legible** is what a receipt at the wrong angle looks like, so the photo gets
  turned (180° first — undoing a wrong `detectSideways` guess — then 90°); **legible but
  does not add up** means the paper was read and a number misjudged, and that one is handed
  over as-is. ⚠️ **Corrected 2026-08-04:** it used to be re-read on the theory that the
  model varies run to run. It does not — every call is temperature 0 under a fixed grammar,
  so a second look at byte-identical input reproduces the reading that just failed the
  floor. That was 25-40 s of GPU for an outcome that could not change, and on the rescan
  path (where an explicit angle pins the loop) it was *every* remaining pass. Retries read a
  *throwaway rotated copy*, so the picture the reviewer checks against is only re-encoded
  once, for the winning angle. The best-scoring pass wins; readings are never merged,
  because a receipt stitched from two disagreeing sources is one nobody can check against
  the paper. An explicit `rotate` is an instruction — retries may re-read it, never re-turn
  it. Tunable via `finance.ocrMinConfidence` (75) and `finance.ocrMaxAttempts` (3, 1-3).
- **The correction loop learned three things it was missing.**
  - `amount` fixes were recorded and never replayed. They are now — but **only when the
    model repeats the identical misread**, so a genuinely new price is never overwritten by
    last month's correction. That would be a hallucination the app invented itself, which
    is worse than the misread it set out to fix.
  - **Shop names are learned and replayed.** This matters more than it looks: the merchant
    is the key every other fix is filed under, so a misread name meant none of that shop's
    drops or renames could be found. Gated on the same two-hits rule, because a user may
    type something branch-specific.
  - 🐛 **Fixed a destructive bug in `learnFromEdit`.** Correcting the *printed text* — the
    牛丼 → 牛乳 case that field is editable for — changes the very key the diff matches on,
    so the line looked deleted and was filed as a `drop`. That taught the scanner to
    **silently bin a real product every time it was printed**. Unmatched model lines are now
    paired against the user's unclaimed lines on the amount before "deleted" is concluded.
- **The loop can show its work.** `GET /api/finance/receipt-learning` reports corrections
  stored vs. in force, catalogue vocabulary, and the last 10 scans' average confidence
  against the 10 before — rendered as a strip above the receipt list. A correction loop that
  cannot show it is working is indistinguishable from one that isn't.
- **Coverage:** three new audit tests (`one purchase cannot be logged twice`, `a doubtful
  reading is read again`, `a reading scores its own confidence`) plus extensions to the
  existing learning test. The retry loop runs against a scripted model in a subprocess and
  counts the calls, so the control flow — how many passes, which angle, which one wins — is
  pinned. **52 hard checks, 0 failing.**


**2026-07-27 — receipt reading rebuilt: 63% → 100% of totals correct**
Benchmarked over **8 real receipts** with hand-checked ground truth (two chains, 1-8 line
items, three photographed sideways), through the real HTTP path:

| pipeline | parsed | **totals right** | item counts | avg |
|---|---|---|---|---|
| Gemma-4-E4B, single stage (was the default) | 100% | 63% | 25% | 21s |
| dots.ocr, two stage | 75% | 38% | 63% | 24s |
| **DeepSeek-OCR → E4B, two stage** | **100%** | **100%** | **88%** | 28s |

- **Two stages, because one model cannot do both halves.** A dedicated OCR model reads a
  page far better than a general VLM but does not answer questions about it: driven
  end-to-end with our schema, dots.ocr scored 25% and hit the token cap on five of eight.
  Asked only to transcribe, it read a receipt the VLM had scored ¥3,138 (true ¥799) and
  returned every number exactly. So the reader transcribes and a text model structures —
  each doing the job it was trained for. `llmctl.refIsTranscriber()` decides, from an `ocr`
  tag on the model's preset, so adding another reader is configuration.
- **Crop to the document first — this was worth more than the model swap.** A receipt fills
  only **37-46%** of the frame on every real example, and the model downsamples whatever it
  is handed, so most of the pixel budget was going to woodgrain. One receipt transcribed to
  **86 characters** uncropped (it found the card slip and missed every product) and **698**
  cropped — that single change took the pipeline from 88% to 100%. `uploads.cropToContent()`
  thresholds between the darkest and brightest deciles, requires a quarter of a row to be
  bright before it counts as paper, and declines when there is nothing to gain. The crop is
  a *temporary* upload; the reviewer's photo stays whole.
- Stage 2 retries once on failure (cheap — no image, usually no model swap).
- New models live in `data/llm/models/` (14GB); `*.gguf` added to `.gitignore` tree-wide,
  and **B2** now carries a ⚠️ to exclude them from backups.


**2026-07-27 — the receipt gets straightened before the model sees it**
- ✅ **Angle was a leading cause of bad reads, and it is now measured, not assumed.** Three
  of the photos on this machine were taken with the receipt lying across a landscape frame,
  so the model was asked to read Japanese rotated 90° — the case the OCR literature calls
  out as the weakest for these models. A controlled A/B on one of them, same photo, same
  model: **rotation suppressed → the scan failed outright with no JSON; auto-rotated →
  parsed, correct shop and date, item names largely right.** A later manual re-read at 270°
  produced the exact right total (¥2,160).
- **Detection is deliberately dumb and was validated 5/5** against every real receipt here:
  a till receipt is a long narrow strip, so a **landscape photo of one means it is lying
  sideways**. Only near-square photos fall through to the subtler test — where the
  brightness steps are, since they occur across the strip's short axis. A projection
  measure *alone* scored 4/5 and was least confident exactly where it was wrong (1.1×),
  so aspect leads and projection breaks ties.
- **Direction is counter-clockwise**, because on all three real examples the header sat on
  the right — where it lands when a right-handed person puts a receipt down. A wrong guess
  costs one click: the review editor says what it did and offers "turned the wrong way?",
  and rotating the photo pane now grows a **"Re-read at N°"** button that saves the angle
  and re-runs the scan.
- New `uploads.imageSize()`, `greyRaster()` and `rotateStored()` (rotates the stored file
  in place, so the photo you check against is the one the model was given).
  `scan()`/`rescan()` take a `rotate` override; `0` means "leave it alone".


**2026-07-27 — an Income tab, for freelance work**
- **New tab.** Income is not "expenses with the sign flipped" — the questions are what came
  in today, from which client, for how many hours, and is the year ahead. It reads the same
  `finance_txn` rows, so a logged hour immediately moves the Overview net, the goal meter
  and the year-to-date.
- **Four ways to log money**, because it does not always arrive the same shape: a flat
  **amount**; **hourly** (hours × rate); **per item** (pieces × price — words, lessons,
  deliveries); and **gross − fee**, which takes what the client paid and the platform's cut
  and logs what you actually keep, recording the gross in the note. A live line shows the
  result before you commit. Plus one-tap **quick-log chips** from the existing presets.
- **Work is recorded, not just money.** New `finance_txn.units` + `unit` columns, so hourly
  and per-item entries carry their hours or pieces. That is what makes "what am I actually
  earning per hour" answerable — per payer, per period and year to date.
- **The daily log** groups entries by day (Today / Yesterday / weekday), each with its own
  total and hours; double-click or right-click an entry to edit, duplicate or delete.
- **Where it came from** ranks payers by share, with entries, hours and effective rate.
- **Overview: daily spend became daily NET.** `calendarHeat` gained a `signed` mode —
  direction by hue, magnitude by intensity, so a +8,000 day and a −8,000 day read as
  equally strong opposites. On freelance income the daily question is which way you came out.
- **Year-to-date card** on the Overview and in the Income hero: in / out / net, run rate per
  day, hours logged, and a projection for the full year. The figure a tax return starts from.
- ✅ Caught in testing: the per-payer rollup aliased its group key `source`, but `finance_txn`
  already **has** a `source` column — SQLite grouped by that instead and collapsed every
  client into one row. Now grouped by the expression, with a regression test.

**2026-07-27 — steering the OCR, and correcting it after the fact**
- **Your corrected name now outranks the model's.** ✅ A real bug: a receipt printed 牛乳
  (milk), the OCR read 牛丼 (beef bowl), the user renamed it to "Milk" — and the catalogue
  still filed "Beef Bowl", because resolution ran on the *printed* string and never
  consulted the correction. Worse, the edit then promoted 牛丼 → Beef Bowl to a **confirmed**
  alias, cementing it. Edited lines now bypass the classifier entirely
  (`items.itemForName`), and the printed text is bound to the user's item instead.
- **The printed text is editable too.** When the OCR misreads the characters themselves,
  fixing only the tidy name leaves the catalogue keyed on the wrong string.
- **The photo sits beside the fields** on desktop — zoom (wheel/±/double-click), rotate
  either way, drag to pan, reset, open full size. Cross-checking a thermal receipt against
  a text field is the whole job, and 牛乳-vs-牛丼 is invisible without it.
- **Re-read button**, desktop and phone: `POST /api/finance/receipts/:id/rescan`, ~15s,
  refuses once applied. Worth pressing when something about the *input* changed — the photo
  was turned, a different reader was picked in Settings, or the correction loop has since
  learned a fix that `replayFixes()` will now apply. Not worth pressing otherwise; see the
  2026-08-04 correction above.
- **Quick edits on the phone** — tap a line to fix its name or amount, × to remove it.
- **OCR priming from settled vocabulary.** Confirmed aliases (never unconfirmed ones — that
  would feed the model its own misreads back) go into the prompt as "products bought
  before", tilting 牛乳-vs-牛丼 toward the word that actually occurs in this kitchen.
- **Measured on a real 8-line Japanese drugstore receipt:** it now parses and balances
  exactly (2132 = 2132) where the same photo failed twice before.

**2026-07-27 — schema-constrained output: "did not return usable JSON" is fixed at the decoder**
- **Diagnosed, not guessed.** The failed scans stored 3,130 characters of *"Here's a
  thinking process to arrive at the desired JSON output: 1. Analyze the Request…"* and were
  cut off before the object began. Successful ones are ~330 characters. It was never a
  formatting problem — Gemma 4 is a thinking model and was spending the whole 2400-token
  budget narrating.
- **`response_format: {type:'json_schema'}` now flows through `streamChat({ schema })`**
  (llama.cpp → GBNF grammar; Ollama → `format`). ✅ Verified genuinely enforced on this box:
  a schema containing an enum came back with exactly that enum value, which no model
  volunteers. Wired into `receipts.js` and `itemsai.js` — the two financial JSON callers.
- **Thinking cannot be switched off for this model.** ✅ `enable_thinking:false`,
  `reasoning_effort:none|low` and `thinking:{type:disabled}` were each measured against the
  live server: all three are no-ops for Gemma's template, which emits 180-250 reasoning
  tokens regardless. So the fix is headroom, not suppression — 4096 first pass, one retry
  at 8192, and `stopReason === 'length'` reported as truncation rather than "bad JSON".
- **The prompt got shorter, not longer.** With the grammar owning the shape, the JSON
  template block came out of the prompt; only policy remains. Long rule lists measurably
  lengthen this model's deliberation, which is what pushed scans past the cap.
- **Result: 3/3 consecutive scans parsed** (was intermittent), ~14-18s each, totals correct
  and reconciliation balanced every time.
- **Model size answer: bigger is worse here.** ✅ `gemma-4-12b-it-qat` (6.5GB + a 175MB
  projector on an 8GB card) managed **18.4 tok/s against the E4B's 82**, and on an
  unbounded array it decoded **6,876 tokens on a one-item receipt without stopping** — a
  10-minute timeout, no result. The E4B split stays the right OCR model. The runaway also
  bought a `maxItems: 100` bound in the schema: a grammar guarantees shape, not termination.

**2026-07-27 — fixing a receipt *after* it is in the ledger, and bulk item naming**
- **Undo & edit an applied receipt.** `POST /api/finance/receipts/:id/revert` removes the
  rows it created *and* the prices recorded from them, then reopens the scan in the review
  editor. Editing the ledger row alone would fix the total but leave the scan wrong and
  teach the scanner nothing — reverting puts the correction back through the loop that
  remembers it.
- **Deleting a transaction now forgets its price.** ✅ A real bug, and it had already bitten
  on this machine: a phantom `お茶` at ¥1650 was deleted from the ledger by hand, but its
  price observation survived and kept counting toward what tea "usually" costs — so
  `priceProbe()` would have judged future scans against a hallucination. `deleteTxn`,
  `deleteTxns` and `revertReceipt` all purge now, and `getDb()` runs a one-time sweep so
  databases written before the fix heal themselves (cleared exactly 1 here).
- **Bulk item review.** The queue was a 30-row modal needing one decision per line, which
  is why a twenty-line grocery receipt never got filed. Now: `xl` modal, up to 120 lines on
  screen, confident matches (≥0.72) **pre-ticked**, "Tick confident" / "Clear" /
  "Apply *n*" in one pass, and a **"Not a product"** action that discards observations
  outright rather than forcing a junk catalogue entry for レジ袋 or ポイント値引. New
  `POST /api/finance/purchases/assign` (bulk) and `/drop`. Verified in-browser: 12 lines →
  bin 2 → "Filed 2 lines · discarded 2".
- Two more audit checks (`finance: deleting a row forgets its price`, `items: bulk review
  actions`).

**2026-07-27 — receipt review, and catching the model's inventions**
- **The scan is a draft, not a result.** A vision model reading a crumpled thermal receipt
  gets most lines right and then invents one, so every field is now editable before
  anything reaches the ledger: `PATCH /api/finance/receipts/:id`, a review editor in the
  Finances → Receipts tab (edit/add/delete lines, fix shop/date/subtotal/tax/total, tap a
  category), and one-tap line deletion on the phone. An applied receipt is frozen.
- **Hallucination is caught arithmetically.** A receipt is a closed system: the lines must
  sum to the subtotal, or to total minus tax. An invented line overshoots *by its own
  amount*, which tells the reviewer exactly what to look for — verified live, a phantom
  ¥180 line produced "JPY 180 too much". Tolerance is 1 unit or 1% (Japanese receipts
  round per-line tax). A line worth more than the whole receipt is dropped outright.
- **Summary lines are filtered deterministically.** Observed live: the model returned
  `小計 1点 ￥300` ("subtotal, 1 item") as a product named "Product" while missing the real
  line — a failure the arithmetic check *cannot* see, because a subtotal equals the sum it
  replaced. A closed-vocabulary matcher now drops 小計/合計/お預り/お釣り/ポイント/レジ袋/
  消費税/伝票番号 and the Latin equivalents, requiring the keyword be the whole line plus
  only numbers and counters — so `カード型ケース`, `Card case`, `現金書留封筒` and
  `ポイントカード発行手数料` survive. 29 cases pinned in the audit suite.
- **Corrections become the point of truth.** `finance_receipt_fix` records what you
  changed, per merchant, with a hit count; a fix is replayed only after you've made it
  more than once, so one odd misread never becomes a rule. Then a fresh scan of the same
  shop self-corrects with **no model call** — verified: the phantom line is dropped and
  the check flips from "overshoot 180" to "balanced". Fixes never leak between shops. The
  most-dropped lines are also injected into the next scan's prompt, item names the user
  edited are promoted to **confirmed aliases** (already authoritative in the catalogue),
  and `items.priceProbe()` uses purchase history as a prior to flag "usually around ¥X".
- **Prompt hardened, and measured rather than assumed.** A/B'd against the real receipt:
  the new prompt reads `虫ゴム交換(前後セット)` correctly where the old one hallucinated
  `缶ジュース` ("canned juice"), with the totals right in both. Line items now carry a
  verbatim `printed` field alongside the tidied name (this closed D12, now retired), and the catalogue
  keys on the printed text — the only stable join key across receipts from one shop.
- Two new audit checks (`receipts: hallucination guards`, `receipts: the correction loop
  learns`) — the first coverage the money stack has had.

**2026-07-27 — iPhone uploads, vision OCR, and a performance pass**
- **Image intake rebuilt** (`server/uploads.js`, `web/js/imageprep.js`). The **bytes** decide the
  type, not the client — iOS sends `image/heic`, an empty MIME, or occasionally the wrong type
  outright, so a magic-byte sniffer runs first. HEIC/HEIF/AVIF/TIFF/BMP are transcoded to JPEG
  on arrival via **ffmpeg** (✅ verified: decodes HEIC with no libheif, ~45ms/photo). The
  browser-side decode/orient/downscale pipeline moved out of the phone view into a shared
  module used by every attach point — the desktop Finances picker used to fail on iPhone photos
  because only `/m` converted them. New `POST /api/uploads/raw` takes bytes as a binary body;
  base64-in-JSON measured 3× slower and ~50MB of heap churn per photo.
- **Receipt OCR now demands a model that can see.** `finance.ocrModel` was unset, so it fell
  through to `defaults.chatModel` — a text-only 9B — and llama.cpp answered
  `"image input is not supported … you may need to provide the mmproj"`, which reads like an
  upload error and cost a debugging session. An unset value now auto-selects the smallest
  vision-capable local model and **persists** it; a text-only choice is refused with an
  actionable message. One definition of vision-capable: `llmctl.visionModels()` /
  `refSeesImages()` — the preset names an mmproj that exists on disk.
- **Performance pass, all measured.** `spawnSync('pgrep')` in `llmStatus()` cost ✅ **23.8ms of
  blocked event loop per call** and ran up to 4× per chat send → replaced with a /proc scan
  (2.4ms) + 1s cache. Two **fd leaks** (`llmctl.js`, `comfy.js`: `openSync` never closed, one
  per model swap) fixed. **WS heartbeat + backpressure cap** added — `clients` only ever grew, so
  a sleeping phone kept its subscriptions, kept terminal shells alive, and buffered every
  published message. `listChats`/`listSessions`/`listResearch` stopped parsing every transcript
  in full for a message count (mtime-cached `jsonDirIndex`). Transcripts write compact instead of
  pretty. `probeProviders` cached 5s + in-flight dedup. Prepared-statement caches in
  `financedb`/`learndb`. `express.json` scoped to `/api`.
- **`auto:<category>` routing removed.** Ten pseudo-models in every picker to express a
  preference the Local list already expresses directly; the per-category bench winners it
  displayed live in the Bench app. `legacyAutoRef()` keeps refs saved before the removal
  resolving. Pickers went 21 entries → 10.
- **Agnes AI provider removed** from config (with its key) and from the settings preset list.
  `defaults.chatModel`/`agentModel` were stale `custom_…:ornith-9b` refs — the managed provider
  is deliberately *not* offered in pickers because llama-server answers under any name you send,
  so they silently ran whatever gguf was loaded. Both are now honest `local:` refs.

**2026-07-26 — Finances**
- The whole money stack: ledger, budgets, goals, recurring entries, presets, five tabs, CSV,
  multi-currency; **receipt capture** end-to-end (phone or desktop → OCR → review → ledger);
  **item price tracking** with a brand-free catalogue and unit-price shop comparison.

**2026-07-23 — Everyday assistant toolbelt**
- A keyless, free-by-default suite for Chat and the Agent: **directions** (OSM/OSRM, home as
  default origin), **find_places**, **weather** (Open-Meteo), **wikipedia**, **translate**,
  **calculate** (safe parser, no eval), **convert** (units + live FX), **datetime**,
  **crawl_site**, **quick_note**. New `server/geo.js` + `server/everyday.js`; `everyday.e2e`
  (50 hard checks + 7 live probes).

**Earlier**
- **Bench + Models v2** — deterministic per-category local-model leaderboard; the desktop
  llama-launcher re-implemented as the in-browser Models app.
- **Learning Corner → SQLite** — subject tree, assessments, per-topic mastery.
- **Agent lean tool loadout**, **agent plan mode**, **tool-using Chat**, **chat personalization
  + organization**, **PDF ingestion in research**.
- **Studio / ComfyUI integration** — Phases 0-3 of the old `comfyui-plan.md`: connector, Studio
  app, agent hooks, VRAM guard, workflow menu.
- **Cut**: the **Mindmap** subsystem, the **Job Search** subsystem (a ToS-aware redesign is
  parked in **§F**).

---

## A. Cut / consolidate — shrink the surface area ✂️

Maintenance is the tax on a solo project. Every one of these is dead weight or duplicated
effort that can go, freeing time for the buckets below.

**A1. ✂️ Sunset the PyQt desktop launcher for the LLM — S.** Models v2 owns
start/stop/preset/serve in the browser, so `llmctl.openLauncher()` and its button are legacy.
Keep the launcher only for Whisper/MusicGen (or drop it entirely) and delete the AIOS-side
plumbing that duplicates the new UI. *Hook:* `server/llmctl.js:openLauncher`.

**A2. ✂️ Collapse the scattered model-ref config into roles — S.** `defaults.chatModel`,
`defaults.agentModel`, `mail.model`, `learn` model, `finance.ocrModel`/`itemModel`/`recapModel`,
`jobsearch.defaultModel` — seven places a ref can be set, and an unset one has now twice caused
a silent failure (mail triage off for days; receipt OCR pointed at a text-only model). Make
every caller resolve a **role** — `fast` / `smart` / `vision` — through one resolver that knows
which local models can see and which are benched fastest, and delete the per-feature fields.
`llmctl.refSeesImages()` is the first half of that resolver, already written. Kills the
empty-default bug class outright. *Hook:* new `server/models.js`; callers in `receipts.js`,
`itemsai.js`, `mail.js`, `learn.js`, `chat.js`, `agent.js`.

**A3. ✂️ Trim the theme roster from 9 to ~4 — S.** The animated wallpapers (Matrix katakana
canvas in `web/js/matrix.js`, Synthwave CSS grid) and the long tail of palettes are pure
aesthetic upkeep. Keep light/dark/system + one signature theme; move the rest to an optional
theme pack. *Hook:* `web/js/themes.js`, `web/css/theme.css`.

**A4. ✂️ De-duplicate the two research/lesson pipelines — S.** Research and the Learning Corner
both do plan→search→read→synthesize with near-identical helpers, now including PDF ingestion.
Extract the shared pipeline so a fix to extraction/snippet-fallback/PDF lands in both instead of
drifting. *Hook:* `server/research.js` ↔ `server/learn.js`.

**A5. ✂️ One SQLite helper module, not four — S.** `financedb.js`, `learndb.js` and `bench.js`
each define their own `getDb`/`all`/`one`/`run`/`tx`/`ensureColumn`/dated-backup, and the
2026-07-27 statement cache had to be written **twice** — which is the tell. Extract
`server/db.js` (open, WAL, migrate, statement cache, `tx`, boot backup, keep-last-N) and have
each store declare only its schema. Makes **B2** a one-file change instead of four.
*Hook:* `server/financedb.js:195-260`, `server/learndb.js:160-230`, `server/bench.js:40-70`.

**A6. ✂️ Retire the legacy base64 upload route — S.** `POST /api/uploads` only exists now for
clients holding a cached older bundle, and it is the reason `express.json` still carries a 60MB
limit (a real memory-spike surface: ~50MB of heap churn per photo). Once the phone PWA has
certainly rolled over, delete `saveUpload`, keep `saveUploadBuffer`, and drop the JSON limit to
a few MB. *Hook:* `server/index.js:187`, `server/uploads.js:saveUpload`.

**A7. ✂️ Delete `comfyui-plan.md`'s dead phases — S.** Done as part of this pass: it was a
pre-implementation plan still saying "Checkpoints: **None yet** — nothing can generate until
Phase 0" months after Studio shipped. Rewritten as a current-state doc. Keep it that way or fold
it entirely into §D here. *Hook:* `comfyui-plan.md`.

## B. Backend & reliability

**B2. 🔥 Make backups SQLite-aware — S.** ⚠️ **Must exclude `*.gguf`.** `data/llm/models/` now
holds **14GB** of model weights, against a few hundred MB of actual data — a naive `tar data/`
would produce a 14GB archive of things that are all re-downloadable from Hugging Face. Exclude
model weights (and `.part` files) wherever they sit; back up the ledger, the vault index, the
chats and the config.

Data now lives in JSON **and four** WAL databases
(`bench.db`, `learn.db`, `finance.db`, and whatever §F adds). A naive `tar data/` mid-write
captures a torn WAL. Add `scripts/backup.mjs`: `PRAGMA wal_checkpoint(TRUNCATE)` on each `.db`,
tar `data/` + registered `.aios/` dirs into `backups/` with keep-last-N, and a `--restore` that
refuses to run while the server is up. This machine has hard-crashed under load before, and
`finance.db` is **hand-entered money** — the least reproducible data in the project.
Do **A5** first and this is one file. *Hook:* new `scripts/backup.mjs`; `financedb.js:backupOnBoot`
already has the checkpoint pattern.

**B3. 🔥 Structured output via `json_schema` / GBNF — S (was M).** Landed 2026-07-27 for the
transport (`streamChat({ schema })`, OpenAI-compat + Ollama) and for `receipts.js` /
`itemsai.js`. What remains is adopting it in the other callers, and this has genuinely moved: ✅ **10**
`extractJSON()` sites across **5** modules as of 2026-08-18 (`learn` ×5, `vault` ×2, `comfy`,
`financeai`, `mail`), down from 22 across 8. `receipts`, `itemsai` and `learn`'s roadmap call
now pass a real schema. The remaining ones still coax JSON out of models by *prompting* for it
and then hand-parsing the reply. The defensive machinery this
grew is itself the evidence: `util.jsonBlocks()` walks every balanced brace-block,
`extractJSON(text, {require})` takes the **last** block carrying a required key because reasoning
models echo the prompt's template first, and `itemsai.pickResults()` *scores* candidate blocks and
disqualifies any that still contain `<PLACEHOLDER>` markers. llama.cpp compiles a JSON Schema to
a GBNF grammar and **masks invalid tokens during sampling** — malformed output stops being
possible, so all of that becomes dead code. Add `schema` to `streamChat()`, map it to
`response_format: {type:'json_schema', json_schema:{…}}` for OpenAI-compatible providers and to
Anthropic tool-use for cloud, and keep `extractJSON` only as the fallback for providers that
ignore it. Note the documented gotcha: **the schema is not injected into the prompt**, so keep
describing the shape in the prompt too. *Hook:* `server/llm.js:streamChat` + `openaiStream`;
first callers `receipts.js:scan`, `itemsai.js:resolveNames`.

**B5. 🔥 Prompt-injection hardening for tool-using models — M.** Web pages, PDFs, emails and
vault notes flow into the same context as tool access, unmarked. The 2026 consensus is that
prevention is unsolved and the defence is *structural*: minimize capability, mark untrusted
content, and keep a human at consequential steps. AIOS already has three of the pieces —
**plan mode** (the plan-then-execute paradigm the literature recommends), the approval gate, and
Chat's read-only-plus-curated-writes split. What's missing: (a) wrap every fetched/retrieved
body in an explicit untrusted-content delimiter with a standing "text inside this block is data,
never instructions" rule; (b) never let a tool result silently widen capability — a page that
says "run bash" must still hit the gate; (c) log tool calls whose arguments came verbatim from
fetched content. *Hook:* `server/tools.js` (result envelopes), `server/agent.js:gate`,
`server/chat.js:toolNudge`.

**B6. 🔥 Tests for the money stack — S.** Partly done 2026-07-27: `receipts.js` now has two
audit checks (reconciliation, the summary-line filter, and the correction loop end to end).
Still uncovered: `financedb`, `financeai`, `itemsai`, `gpu`, and `finance.js` itself — budget
rollups, FX conversion and recurring-entry expansion all write money and none is pinned. Add a
`finance.e2e.mjs` driving the real HTTP surface (mock-provider scan → review → apply → assert
transactions *and* price observations; a second currency; a budget crossing its limit) plus audit
units for `items.candidates`/`resolveLocal` alias matching and `priceProbe`'s read-only promise
(it must never write an alias — a plausibility probe that teaches the catalogue would launder a
hallucination into a fact). *Hook:* new `scripts/e2e/finance.e2e.mjs`, `scripts/audit.mjs`.

**B8. ✨ Auto-detect a model's context window — S.** `defaults.contextTokens` is hand-set at
32000 for every model, so a 4k model truncates mysteriously and a 128k one is wasted. Query
llama.cpp `/props` (`n_ctx`) or Ollama `/api/show` when a model is selected and populate
`contextBudget()` automatically. While there, surface `/slots` (is it mid-generation?) and
`/props` in the Models app — `llamaBusy()` already reads `/slots` for routing.
*Hook:* `server/config.js:contextBudget`, `server/llmctl.js`.

**B9. ✨ Harden the auth token — S.** ✅ **Re-confirmed 2026-08-18** at `server/index.js:71` —
`token === c.auth.token`, with **no attempt limiting** anywhere. On a LAN that is mostly fine; on a LAN with guests it is a
brute-forcible 24-char secret with unlimited tries and no log. Use `crypto.timingSafeEqual` on
equal-length buffers, add a per-IP failure counter with backoff, and log failures.
*Hook:* `server/index.js:authorized`.

**B10. ✨ SearXNG engine auto-tuning — S.** Brave/DDG rate-limit fast and stall queries. Track
per-engine failure rates in `webSearch` and auto-disable a persistently failing engine for a
cooldown window; surface it on the Health page (**C5**). *Hook:* `server/tools.js:webSearch`.

**B11. ✨ Per-device auth tokens with revoke + access log — M.** One shared token today, so a
leaked pairing URL can't be contained without rotating everyone. Issue named per-device tokens
(the pairing link already exists), allow individual revoke, keep a small access audit log.
Pairs naturally with **B9**. *Hook:* `server/config.js:auth`, `server/index.js:authorized`.

**B12. ✨ Speculative decoding for the big model — S.** ✅ The plumbing already anticipates it:
`llmctl.listLocalModels()` filters out files matching `/mmproj|draft|dflash/i`, but
`modelArgsFor()` has no `--model-draft`. Published speedups are 1.5-3× on tok/s depending on
acceptance rate. Caveat that decides feasibility: the draft model must share the target's
tokenizer/vocab, so `Qwen3-1.7B-Q8_0.gguf` (already on disk in `data/llm/models/`) drafts for a
Qwen-family target — **not** for gemma or ornith. Add `draft` to the per-model preset, wire
`--model-draft`/`--draft-max`, and let Bench prove the delta per pair rather than trusting the
claim. *Hook:* `server/llmctl.js:presetFor`/`modelArgsFor`, `web/js/apps/models.js`.

**B13. 🧪 Provider fallback chain — S.** When the primary provider is down a request just fails.
Let `llm.js` fall through an ordered list (local → Anthropic) on connection error; the
"first reachable" logic added for mail already proves the pattern.
*Hook:* `server/llm.js:streamChat`.

**B14. 🧪 Config-write safety — S.** The live server rewrites *all* of `config.json` on any
settings save, silently clobbering concurrent or hand edits. Write via tmp+rename with an
mtime/version check and warn on conflict, mirroring `writeJSON`'s atomicity for the one file that
isn't fully guarded. *Hook:* `server/config.js:saveConfig`.

**B15. 🧪 Cancellation that actually reaches the model — S.** A stopped chat aborts the
`AbortController`, but a llama-server slot can keep decoding to completion, burning GPU on an
answer nobody will read. Send llama.cpp's cancel (or drop the connection and confirm the slot
frees via `/slots`) and assert it in an e2e. *Hook:* `server/llm.js:openaiStream`,
`server/chat.js:stop`.

**B16. ✨ Keep dependencies current — S.** ✅ As of 2026-07-27: `@xterm/xterm` 5.5.0 → **6.0.0**
(major), `@xterm/addon-fit` 0.10 → 0.11, `@anthropic-ai/sdk` 0.112.4 → 0.115.0, `marked`
18.0.6 → 18.0.7. Vendored browser libs are rebuilt by `npm run vendor`, so the xterm major is the
only one with real risk — do it deliberately with the Terminal app open.
*Hook:* `package.json`, `scripts/build-vendor.mjs`.

**B17. 🧪 Structured logging + optional OpenTelemetry — M.** Everything goes to `aios.log` via
`console.log`, so "why was that agent run slow?" is unanswerable after the fact. Emit one JSON
line per LLM call and tool call (model, tokens, ttft, tok/s, ok/error — `streamChat` already
measures all of it in `res.perf`), which makes **C5**'s health page and any future eval loop
nearly free. The GenAI semantic conventions now define agent/workflow/tool/model spans and are
what Claude Code and Copilot emit, so an opt-in OTLP exporter behind a config flag would let AIOS
be inspected with standard tooling. Keep it off by default — local-first means no telemetry
unless asked. *Hook:* `server/llm.js:streamChat` (perf is already computed), new `server/log.js`.

**B18. 🔥 Calibrate the confidence weights against the receipt bench — S.** The penalties in
`scoreConfidence()` are *reasoned* — arithmetic dominates, recognition is a capped bonus that
can never mask a receipt that does not add up — but they are hand-set, and the 75 floor with
them. That is one unfitted constant deciding how much GPU every scan costs and how much the
user is asked to check. The 8 hand-checked receipts from the 2026-07-27 bench are already the
ground truth: score each, plot score against "was the total actually right", and pick the
threshold where re-reading stops paying. Two numbers worth knowing and currently unknown —
**how often a ≥75 scan is wrong** (false confidence, the expensive direction) and **how often
a re-read actually improves the score** (if it rarely does, the cap should be 2, not 3).
*Hook:* `server/receipts.js:scoreConfidence`, the bench receipts, `scripts/audit.mjs`
`'a reading scores its own confidence'`.

## C. UI / UX

**C1. 🔥 Unified notification center (topbar bell) — M.** ✅ `server/notify.js` is still **34
lines** (re-checked 2026-08-18). Runs finish while you're in another app; research completes silently; birthdays sit in the Planner. Grow `server/notify.js` into an
in-app event store (`pushEvent`) + `GET /api/notifications` + WS topic `notify`, emitting from
the seams that already exist (agent `turn.done`, research `done`, mail scan, planner
overdue/birthday, finished bench run, GitHub review-requested delta, **receipt scanned**).
Topbar bell with unread count + dropdown; entries deep-link via `openApp(app, opts)`; per-source
toggles, optional Discord mirroring. *Hook:* `server/notify.js`, `web/js/main.js` topbar.

**C2. 🔥 Wire up the `density` / compact mode — S.** ✅ **Re-confirmed 2026-08-18:**
`appearance.density: 'comfortable'` is defined at `config.js:27` and the string `density` appears
**nowhere else in `web/`** — it is read by nothing. Add a `data-density` attribute plus
a compact spacing pass and honour it — a quick, high-visibility win on laptop screens.
*Hook:* `web/js/main.js:applyAppearance`, `web/css/shell.css`.

**C3. 🔥 Global Ctrl+K search across your actual data — M.** The palette finds apps, projects and
vault notes but not the things you actually lose: a chat from Tuesday, an agent session, a task,
an email, a receipt. ✅ This got much cheaper than when first filed: `node:sqlite` on this box
(SQLite 3.53) supports **FTS5 including the trigram tokenizer**, verified 2026-07-27 — so build
one `data/search.db` FTS5 index fed by the existing stores, with trigram matching for the
substring-y queries people actually type (and for Japanese, which whitespace tokenizers get
wrong). `GET /api/search?q=` + grouped palette results with deep links. The same index can back
vault search and `wiki_recall`'s keyword pass. *Hook:* new `server/search.js`,
`web/js/main.js:openPalette`.

**C4. 🔥 Chat quality-of-life — M.** The composer is missing table stakes: **Continue** when a
reply hits `finish_reason: length`, **Regenerate** (optionally at a different model/temp),
per-message copy / edit-resend / delete, **branch from a message**, and a running token meter
(`res.perf` already carries the numbers). *Hook:* `server/chat.js`, `web/js/apps/chat.js`.

**C5. ✨ Health page + in-UI log viewer — M.** Extend the Home services panel into a real status
page: which SearXNG engines answered vs are rate-limited, `data/` disk usage, uptime, model
latency/tok-per-sec (Bench measures both), fd/RSS trend, and a tail of `aios.log` in the browser
instead of only the server console. **B17** makes this mostly a rendering job.
*Hook:* `web/js/apps/dashboard.js`, `server/checks.js`.

**C6. ✨ Settings search + section split — S.** `web/js/apps/settings.js` is ~40KB in one file and
finding a toggle means scrolling. Add a filter box that jump-scrolls to matching settings, and
split the file per-tab so it stays maintainable. *Hook:* `web/js/apps/settings.js`.

**C7. ✨ Finish the mobile pass — M.** The ≤760px breakpoint exists but the Planner week strip,
Studio, and the Bench/Models tables overflow. One pass: swipeable Planner day columns,
single-pane Bench/Models, bigger touch targets. The LAN-broadcast use case *is* phones, and `/m`
proves the appetite — but `/m` only does receipts. *Hook:* `web/css/apps.css` breakpoints.

**C8. ✨ PWA offline shell + real push — M.** `web/sw.js` is a deliberate no-op passthrough, so
the phone view is installable but not resilient: a dropped Wi-Fi connection gives a blank page
rather than "offline, queued". Cache the shell, queue receipt uploads for retry, and add Web
Push so **C1**'s notifications reach a locked phone (this is also the paid-tier surface in
**E1**). *Hook:* `web/sw.js`, `server/notify.js`.

**C9. ✨ Japanese-first polish — M.** The owner lives in Japan: the ledger is JPY, receipts are
Japanese thermal prints, `translate` exists "for life in Japan", and the item catalogue carries
`name_ja`. Yet the UI is English-only and search tokenizes on whitespace. Add a locale layer
(ja/en) for UI strings and date/number formats, trigram search so Japanese queries work
(**C3**), and JP-aware receipt fields (税抜/税込, 軽減税率 8% vs 10%). Small, and it makes the
app feel native rather than translated. *Hook:* new `web/js/i18n.js`, `server/receipts.js`
schema prompt.

**C10. 🧪 Split view / multi-pane — M.** Two apps side-by-side (Agent + Files, Chat + Terminal).
`wm.js` already keeps every app mounted, so this is a layout shell over it.
*Hook:* `web/js/wm.js`.

**C11. 🧪 Accessibility + keyboard-completeness pass — S.** Custom `switch`/`select`/modal
widgets are divs with click handlers: no roles, no focus traps, no Escape contract in places, and
the dock isn't tab-navigable. One pass for roles/aria-labels/focus order pays off for keyboard
use generally, not just screen readers. *Hook:* `web/js/ui.js` primitives.

**C12. ✨ Show where the scanner is still weak — S.** The learning strip above the receipt
list answers "is it improving?" in aggregate. The more actionable question is *where it
isn't*: average confidence **per shop**, and which printed strings are corrected most often.
A shop that consistently scores 50 is usually one artefact — a receipt printer that renders
katakana badly, a layout that folds the total under the barcode — and knowing which one turns
a vague "the OCR is bad sometimes" into a fixable target (a per-merchant prompt hint, or just
photographing that chain's receipts differently). All the data is already recorded:
`finance_receipt.confidence` + `merchant` from `parsed`, and `finance_receipt_fix.hits`.
*Hook:* `server/receipts.js:learningStats()` (add a per-merchant rollup),
`web/js/apps/finance.js:learningStrip`.

**C13. 🔥 The dock has outgrown itself — S.** ✅ 17 apps registered, **16 in the dock**
(`main.js:renderDock`), separated by three `|` dividers that are doing the work a grouping
mechanism should. Two apps are already deliberately undocked (Bench opens from Models, Files from
a project row) — that instinct was right and needs to become a rule rather than a one-off. Give
the dock a **pinned set + overflow**: pinned icons stay, the rest live behind a "More" tile or
appear automatically as *recents*, and every app remains reachable from Ctrl+K regardless. The
test for whether an icon has earned its place is the same one that removed Bench: is it a
destination, or is it something you do *to* something else. *Hook:* `web/js/main.js:renderDock`,
`web/js/wm.js`.

**C14. 🔥 Nothing on screen says something is running — S.** Research, agent turns, bench sweeps,
lesson generation, receipt scans and comfy jobs all run for minutes, and the moment you switch
apps the only evidence is that the tab you left is still spinning. `wm.js` keeps every app
mounted, so the state is already in memory: put a **dot on the dock icon** of any app with work
in flight and a count in the topbar, both driven by the same event stream **C1** needs. This is
the cheap half of the notification center and it removes the main reason to sit and watch a
progress bar. *Hook:* `web/js/wm.js`, `web/js/main.js` topbar, `server/notify.js`.

**C15. ✨ Home is a second dock; make it a "what changed" screen — M.** ✅ `dashboard.js` renders
twelve `card(app, title, blurb)` tiles that duplicate the dock immediately below them, plus mail
and agenda strips. The tiles are the least valuable pixels on the most-opened screen. Replace
them with **since you last looked**: research that finished, agent sessions awaiting approval,
receipts queued for review, budgets that crossed, tasks overdue, birthdays this week, a bench run
that completed, unread mail. Every one of those already exists as a store query; none of them is
on Home today. Keep exactly one row of launchers for the things with no state to report.
*Hook:* `web/js/apps/dashboard.js`, `server/context.js:liveBrief` (which already assembles most
of this for the model — the screen should show what the model is already told).

**C16. ✨ Settings: show me what I changed — S.** ✅ Thirteen sections in one **1,416-line** file
(**C6** splits it). The missing view is orthogonal to search: a **"differs from default"** filter
that lists only the keys this install has actually changed, with a one-click revert per key. On a
config this wide it is the fastest way to answer "what did I do to it?" after something starts
behaving oddly — and it is the natural home for an export/import of a settings profile.
`config.js` already knows every default, so the diff is a walk of two objects.
*Hook:* `server/config.js` defaults, `web/js/apps/settings.js`.

**C17. 🔥 An action ledger — what the assistant wrote, and an undo — M.** `server/actions.js`
proposes and you confirm, which is the right gate, but once confirmed a write vanishes into
whichever store owns it. There is no one place that answers *"what has this thing written on my
behalf this week?"* — and for money that is the question that matters. Persist every settled
proposal (tool, args, result id, chat it came from, confirmed or discarded) and render it as a
reverse-chronological list with a filter per action type. `revertReceipt()` already proves the
pattern for unwinding a write cleanly; the same shape gives **undo** to `finance_log`, `task_add`
and `event_add`. Pairs with **C1**: a confirmed action is exactly the kind of event the bell
should carry. *Hook:* new `data/actions.json` or a table, `server/actions.js:execute`,
`web/js/apps/*` a shared "recent writes" panel.

**C18. ✨ Split `finance.js` — S.** ✅ **2,311 lines** in one browser module, the largest file in
`web/` by a factor of 1.6, covering seven tabs that share almost nothing but the period selector.
It is where the two focus-loss bugs of 2026-08-04 lived, and it is the file most likely to be
edited by a model that cannot hold it all at once. Split per tab (`finance/overview.js`,
`income.js`, `receipts.js`, `items.js`, …) behind the existing tab switch, with the period
selector and formatting helpers extracted to a shared module. No behaviour change; purely a
change in how much has to be understood to touch one tab. *Hook:* `web/js/apps/finance.js`.

**C19. ✨ Empty states that teach — S.** Most screens in a *personal* hub are empty for the first
week, and an empty screen currently says nothing. Every app should answer, in its empty state,
"what do I put here and how does it get here": Finance → *scan a receipt, or log your first
expense* with the buttons inline; Learn → *pick a subject and I'll design the roadmap*; Vault →
*point me at your Obsidian folder*; Interview → *tell me the role and we'll start*. This is the
cheapest onboarding that exists and it doubles as documentation for **E1**.
*Hook:* `web/js/ui.js` — one `emptyState({icon, title, hint, actions})` primitive, then one call
per app.

**C20. 🔥 Quick capture — one keystroke, anywhere — S.** ✅ Ctrl+K exists and *navigates*; there
is no way to **record** without first travelling to the right app. Add a second bar (Ctrl+Shift+K,
or a Ctrl+K mode) that takes one line of natural language, routes it through the same
`actions.js` proposal path chat uses, and shows the confirm card in place: *"1200 lunch at
Lawson"*, *"call the clinic tomorrow 10am"*, *"idea: tile the receipt reader"*. The parsing,
the defaults and the confirmation are all built — this is a text box wired to machinery that
already exists, and it is the single change most likely to make the ledger actually get used.
*Hook:* `web/js/main.js:openPalette`, `server/actions.js:propose`, `server/chat.js`.

**C21. ✨ Voice mode should keep its receipts — S.** The overlay shows the running transcript and
then closes, and while the chat survives, *what the recogniser actually heard* does not. When a
command is misheard the useful question is always "what did it think I said?" — and today the
answer is gone. Keep the raw transcript beside the normalised one (`normalizeTranscript()` already
rewrites 八万円 → 80,000円 and friends), show both on the turn, and offer **"that's not what I
said"** which re-sends the corrected text and files the pair as vocabulary. The vocabulary prompt
already exists (`voice.vocabularyPrompt`); this is how it should be fed.
*Hook:* `web/js/voicemode.js:addTurn`, `server/voice.js:normalizeTranscript`.

**C22. ✨ Push-to-talk, and a wake word — S/M.** Hands-free is all-or-nothing today: either the
mic re-opens after every reply or you tap. A held key (Space is already the tap key — make
*hold* mean push-to-talk) covers the common case of one command in a quiet room, and is strictly
more reliable than silence detection because the boundary is stated rather than inferred. The
wake word is the harder half and should stay optional: the small partial-transcribe model is
already loaded and streaming, so matching a phrase against its partials costs nothing extra —
no second always-on model. *Hook:* `web/js/voicemode.js:tap`/`listen`, `server/voice.js`
partial stream.

**C23. ✨ A keyboard map, and a `?` that shows it — S.** Ctrl+K, Space in voice mode, Enter in the
receipt table, Escape in modals — the shortcuts exist and are discoverable only by reading source.
Register them centrally so each app declares its own, then `?` opens a cheatsheet scoped to the
app you are in. Doing this centrally is also what makes **C11**'s focus-order work checkable
rather than aspirational. *Hook:* new `web/js/keys.js`, `web/js/ui.js`.

**C24. ✨ Make failures legible — S.** Errors surface as a toast that disappears in a few seconds
and is then unrecoverable, which is the wrong lifetime for the ones that matter (a model refusing,
a provider down, a scan rejected). Keep a small in-memory error log behind the topbar with the
full message, the request that caused it and a copy button, and have the toast link into it.
`server/index.js`'s `h()` already returns `{error}` consistently, so the client half is a
wrapper around `post`/`get` in `api.js`. Feeds **C5**'s health page directly.
*Hook:* `web/js/api.js`, `web/js/ui.js:toast`.

**C25. 🔥 Let the recogniser EXTEND a turn, not end one — S.** The streaming transducer already
reports when it thinks a sentence finished (`endpoint` on every `/api/voice/partial` response,
shipped 2026-08-30) and it is deliberately unwired, because anything that ends a turn earlier
than the tuned silence window reintroduces the mid-sentence-pause bug — the browser e2e catches
it within one run. The valuable direction is the opposite one: when the loudness timer is about
to fire but the transducer's hypothesis looks *unfinished*, wait a little longer. That turns a
fixed 1100ms window into one that gives you more time exactly when you are mid-thought, which is
the case the fixed number cannot serve. Needs tuning against real speech rather than TTS, and a
hard ceiling so a confused recogniser cannot hold the mic open forever. Start by logging, for
real utterances, where the endpointer would have fired against where the timer actually did.
*Hook:* `web/js/voice.js:Recorder._meter` (the silence decision), `onEndpoint`, `server/voice.js:streamFeed`.

## D. New features worth building

**D1. 🔥 Embeddings + reranking for the vault — M.** The single biggest upgrade to `wiki_recall`
and Ask-Vault. Index notes, chunk, embed, store vectors in `data/vault.db`, rank by cosine before
the keyword pass. Two things learned since this was filed: (a) **llama.cpp serves embeddings
itself** at `/v1/embeddings` (`--embedding --pooling mean`), so no Ollama dependency is required
— though it means a second model resident or a swap, which the 8GB card feels; (b) the bigger
quality jump for the effort is **reranking**: `/v1/rerank` with `--reranking` (= `--embedding
--pooling rank`) and a small cross-encoder (bge-reranker-v2-m3 class) re-scores the top ~30
keyword hits, which usually beats pure vector search and needs no vector store at all. **Do the
reranker first** — it is strictly less machinery than an embedding index and improves the
existing keyword path immediately. Then add vectors if recall is still the gap.
*Hook:* `server/vault.js:recall`, `server/wiki.js:recall`, `server/llm.js` (new embed/rerank
calls), `server/llmctl.js` (a second served model or a swap policy).

**D3. ✨ MCP server — expose AIOS to Claude Code — M.** The mirror of **D2**, and the cheaper
half. Publish AIOS's genuinely unique surfaces — vault search/write, planner, the ledger,
`wiki_recall`, bench results — as an MCP server over stdio, and the Claude Code sessions that
build AIOS (plus Claude Desktop, Cursor, anything else) can read the second brain and log
expenses directly. Also the most credible on-ramp for **E1**: "install AIOS, get an MCP server
for your whole life" is a one-line pitch. *Hook:* new `server/mcpserver.js`, reusing `toolCatalog`.

**D4. 🔥 Calendar sync — ICS subscribe + export — M.** The Planner is an island. A zero-dep
VEVENT parser maps cleanly onto `planner.js`'s existing `parseRecur` forms; subscribe to
Google/Outlook/school feeds (merged read-only, distinct colour) and expose
`GET /api/planner/ics?token=` so AIOS events show up in Google Calendar. Home's Next-3-Days
picks both up for free. *Hook:* `server/planner.js:parseRecur`.

**D5. 🔥 Hunk-level patch review + agent checkpoints — M.** The diff rail shows per-file diffs;
per-**hunk** approve/reject is the natural next step, plus a pre-run snapshot (git stash, or
`.aios/checkpoints/` for non-git projects) with one-click rollback. Turns Full-auto from scary
into reversible, and completes the plan-mode story: approve the plan, then approve the hunks.
*Hook:* `server/tools.js:diffPreview`, `web/js/apps/agent.js` diff rail.

**D6. ✨ Scheduled tasks / routines — M.** A cron layer (`data/schedules.json` + one interval
driver, exactly like `mail.startAutoScan`) for recurring research ("watch this topic weekly"),
nightly vault housekeeping, the **B2** backups, a weekly finance recap, and re-running Bench when
a new gguf lands. Saved multi-step agent recipes become runnable on demand or on a schedule.
Needs **C1** to be worth anything — a routine that finishes silently may as well not have run.
*Hook:* new `server/schedules.js`, pattern from `server/mail.js:startAutoScan`.

**D7. ✨ Reply from the inbox (SMTP send) — L.** Mail is read-only IMAP and the mini-Gmail viewer
makes the missing *Reply* conspicuous. A minimal SMTP submit client in the `mail.js` style
(node:tls, implicit-TLS 465, same app password, `In-Reply-To`/`References` from the stored
Message-ID) → an LLM-drafted, **fully editable, never auto-sent** reply. Send-only, hard-gated.
*Hook:* `server/mail.js`.

**D9. ✨ Vault housekeeping pass — M.** An agent/scripted sweep that finds orphan notes,
near-duplicates (offer merge), broken `[[links]]`, and stale facts, with a "wiki coverage" view of
topics vs gaps. `wiki.js` already computes orphans — extend it. Good first **D6** routine.
*Hook:* `server/wiki.js` index.

**D10. ✨ Per-project dashboard + run-script buttons — M.** The Projects app shows git badges
only. Give each project a panel: recent agent/chat sessions, rendered README, git status, and
one-click **run-script buttons** detected from `package.json`/`Makefile` (the Terminal can host
the process). The most-requested "make it feel like an IDE" gap.
*Hook:* `web/js/apps/projects.js`, `server/checks.js:runProjectTests` (script detection exists).

**D11. ✨ Finance: budgets that warn, and a forecast — M.** The ledger records the past well;
it says nothing about the future. Add burn-rate projection to month end, "you are 80% through
Groceries on day 12" alerts through **C1**, recurring-entry drift detection (a subscription that
quietly went up), and a month-end recap the `recapModel` writes. The data is all there — this is
queries plus a card. *Hook:* `server/finance.js:summary`, `server/financeai.js`.

**D18. ✨ Receipt scan: a *targeted* second pass when the arithmetic fails — S.** Partly
shipped 2026-07-27: `scan()` now re-reads a low-confidence scan up to three times and keeps
the best. What it does **not** do is tell the model what was wrong — each pass starts from
nothing, so a model that hallucinated the same line twice hallucinates it a third time. The
remaining half: on a `short`/`overshoot` verdict, hand the model back its own extraction
plus the discrepancy ("your lines come to 480, the receipt says 300 — which line is not on
the image?") as one of the retry passes, and keep it only if it reconciles *and* scores
higher. Cheap, bounded to the scans that already failed, and it attacks the one failure the
generic re-read cannot: a confident, repeatable invention.
*Hook:* `server/receipts.js:planAngle`/the retry loop in `scan()` — the ladder is already
there, this adds a rung; `reconcile()` supplies the number to quote back.


**D13. 🧪 Files: git gutter + inline AI edit — M.** Bring the working-diff data already exposed at
`/git/diff` into the CodeMirror gutter, and add "select code → ask AI to change it → preview diff
→ apply" as a lighter path than a full agent session. *Hook:* `web/js/apps/files.js`,
`server/git.js:workingDiff`.

**D14. 🧪 Learning Corner spaced repetition — M.** The `mastery` table already tracks a decaying
correct/seen tally per topic. Add an SM-2-style scheduler that surfaces due-for-review topics on
Home and auto-mixes weak topics into the next assessment — closing the loop from "graded" to
"actually retained." *Hook:* `server/learndb.js` mastery, `server/learn.js`.

**D15. 🧪 Household / multi-user — L.** Everything assumes one person: one profile, one vault, one
ledger, one token. A "who am I" layer (built on **B11**'s per-device tokens) would let a partner
have their own chats and shared finances. Large, and only worth it if **E1** happens — but it is
the feature that turns a personal tool into a product. *Hook:* `server/config.js:user`,
every store's schema.

**D16. 💭 Bench as an eval harness for AIOS itself — M.** Bench measures *models* on generic
categories. The same deterministic runner could measure **AIOS's own flows**: does receipt OCR
still extract this fixture correctly, does research still cite real sources, does the agent still
pass the self-check loop on a known repo. That is a regression suite for prompt changes, which is
exactly what the project lacks — every prompt edit today is untested. *Hook:* `server/bench.js`
TESTS registry.

**D17. 🔥 Studio: video, ControlNet and inpaint workflows — M.** ✅ The models are already on the
box and unreachable from AIOS: `ltx-2.3-22b-distilled-lora-384`, `ltx-2.3_text_projection_bf16`,
`DasiwaLTX23_goldenlace`, plus the **ComfyUI-LTXVideo** and **VideoHelperSuite** custom nodes and
RIFE frame interpolation — but `server/comfy.js` exports only `txt2imgWorkflow`,
`img2imgWorkflow` and `upscaleWorkflow`, so using any of it means opening raw ComfyUI. Add a
`videoWorkflow` template (+ a job kind that saves mp4/webm instead of png, and a `<video>` tile in
the gallery), then **inpainting** (mask + repaint, built-in nodes) and **ControlNet**
(`models/controlnet/` is empty; control-lora variants are ~700MB and fit). Biggest capability
jump available in Studio, and Phase 0 is already paid for.
*Hook:* `server/comfy.js` workflow builders + `generate()` output handling,
`web/js/apps/studio.js` workflow picker.

**D19. 🔥 Catch the duplicate the *fingerprint* cannot — S.** The guard shipped 2026-07-27
matches on date + total + line items, which is exact by design: it is the only key that
cannot produce a false positive on real spending. Its blind spot is the case it was built
for. Photograph one receipt twice and the second read misjudges a single character or a
single yen, and the fingerprints differ — two rows, doubled spend, no warning. The fix is a
*second, softer* key over the **photo** rather than the reading: a perceptual hash (aHash or
dHash over `uploads.greyRaster()`, which already produces the grid) stored beside the
fingerprint, with a Hamming-distance lookup at scan time. Two photos of one piece of paper
are visually near-identical however the model reads them. Soft key ⇒ soft treatment: a
"you may have already logged this" banner with a link to the other scan, **not** a block —
the exact key stays the only thing allowed to refuse.
*Hook:* `server/receipts.js:receiptFingerprint`/`duplicateOf`, `uploads.greyRaster()`,
new `finance_receipt.phash` column.

**D20. ✨ Let a confident scan file itself — S.** Now that a scan scores itself, the payoff
is not having to review the easy ones. A receipt that reconciles, matches confirmed
catalogue vocabulary and clears a (high, user-set) bar could post straight to the ledger,
with a notification instead of a queue entry, and a one-tap undo — `revertReceipt()` already
unwinds rows *and* their price observations cleanly, so the escape hatch exists. Ships best
**after D19** (a mis-filed duplicate is worse when nobody looked) and after the weights are
calibrated per **B18**. Off by default: this is money, and the whole design so far has been
"the scan is a draft, never a result".
*Hook:* `server/receipts.js:scan` tail + `apply()`, `finance.autoPostAbove` config key.

## H. Desktop control — "open Obsidian for me", and show me that you did 🖥️

The ask: say *"can you open Obsidian for me"* and have it happen, and — because a voice
assistant that acts invisibly is indistinguishable from one that is broken — **see** it happen,
in a pane inside AIOS rather than only on the desktop behind it.

**It is possible, and every piece was measured on this machine on 2026-08-18** rather than
assumed. The findings that decide the design:

- The AIOS server is a **child of the desktop session**: `/proc/<pid>/environ` carries
  `DISPLAY=:0`, `XAUTHORITY`, and `DBUS_SESSION_BUS_ADDRESS`. It can already talk to X and to the
  session bus; nothing needs to be added for that. (The browser tab cannot and never will — this
  is server-side work with a browser front end, exactly like every other app here.)
- **121 launchable applications** parse out of 173 `.desktop` files across the five standard
  directories. Obsidian is the flatpak `md.obsidian.Obsidian`, and — the part that makes the
  "show me" half work — it declares **`StartupWMClass=obsidian`**, which is precisely the key
  needed to find its window after launch.
- `wmctrl -lpx` (installed) gives window id ↔ PID ↔ WM_CLASS ↔ title; `xprop -root
  _NET_ACTIVE_WINDOW` gives focus; `xwininfo -id` gives geometry. `gtk-launch` (installed) runs a
  `.desktop` entry properly, honouring flatpak wrappers and `%U`/`%F` field codes — which naive
  `Exec=` splitting gets wrong on exactly the flatpak lines this box is full of.
- A window frame captured as `xwd -id <win> | ffmpeg -f xwd_pipe`, scaled to 900px and JPEG'd,
  costs **68ms and 44KB**, repeatably. A 2-4fps live pane is therefore ~5% of one core and
  ~130KB/s over the WebSocket that is already open. No new dependency: `ffmpeg`, `xwd`,
  `xwininfo`, `wmctrl` and `gtk-launch` are all present.
- ⚠️ **`xdotool` is not installed** (candidate `1:3.20160805.1-5build1`, one `apt install` away).
  It is needed *only* for **H4** — synthetic clicks and keystrokes. Everything in **H1-H3** and
  **H5** works without it.
- ⚠️ **X11 has no off-screen window store.** A capture of a partially covered window includes
  whatever is covering it — verified. So the pane shows the window *as it appears on screen*,
  which is honest and is what you want for "did that work?", but it is not a private render. Say
  so in the UI rather than letting a screenshot with a terminal across it look like a bug.
- ⚠️ **This is X11-only** (`XDG_SESSION_TYPE=x11`, Cinnamon). Wayland forbids all of it by design
  — see **H7**.

**H1. 🔥 Open an app by name, and prove it opened — M.** The whole feature in one tool.
`server/desktop.js`: parse the five `.desktop` directories into a cached catalogue (name,
`Exec`, `StartupWMClass`, categories, icon), fuzzy-match a spoken name against it, launch via
`gtk-launch <id>`, then **wait for the window** — poll `wmctrl -lpx` for up to ~15s for a window
whose class matches `StartupWMClass` (falling back to the launched PID, then to a new window that
was not there before). Return what actually happened: *which* app matched, its window id and
title, or a clean failure. Two rules earn their keep: (a) a fuzzy name match that is not
confident **asks** — "I found Obsidian and Obsidian Sandbox, which one?" — because launching the
wrong program is cheap to prevent and annoying to undo; (b) if the app is already running,
**focus it** (`wmctrl -ia`) rather than starting a second copy, which is what a person means by
"open Obsidian" when Obsidian is open. *Hook:* new `server/desktop.js`, a `desktop` tool group in
`server/tools.js`, `server/voice.js` for the spoken confirmation.

**H2. 🔥 The window pane — see what it's doing — S.** The "second screen". A panel that shows the
window AIOS just acted on, updating a few times a second: `GET /api/desktop/frame?win=<id>`
for a single JPEG, and a WS topic `desktop.frame` for a live view that only runs while the pane
is visible and stops the moment it is not. Two surfaces: a **strip inside Voice mode** (the
overlay is already the hands-free screen, and this is where "show me that it worked" belongs) and
a full **Desktop app** for driving it deliberately. Cheap wins that make it feel alive: a
one-frame capture attached to the transcript line for *every* desktop action, so scrolling back
through a voice session shows a filmstrip of what happened; and a click-to-enlarge. Deliberately
**not** a remote desktop — no input travels back from the pane in this item (that is **H4**), so
it is a viewer and cannot do harm. *Hook:* new `server/desktop.js:captureWindow`,
`server/index.js` route + WS topic, `web/js/voicemode.js`, new `web/js/apps/desktop.js`.

**H3. ✨ Window management by voice — S.** Once **H1** can name a window, the verbs are almost
free and are the ones actually said out loud: *focus / close / minimise / maximise / move to
workspace 2 / put it on the left half*. `wmctrl` does all of it (`-a`, `-c`, `-b add,maximized_*`,
`-t`, `-e` for geometry) with no new dependency, and each is a one-line implementation over the
window list **H1** already builds. "What's open?" — reading back the window list — is worth
having on its own. *Hook:* `server/desktop.js`, same tool group.

**H4. 🧪 Synthetic input — click and type — M.** The half that makes it *interact* rather than
merely launch: `xdotool` to focus a window, send keystrokes (`key ctrl+n`, `type "…"`) and click
at a coordinate. The honest position is that this is a **different risk class** from everything
above and should be built last and gated hardest. Launching the wrong app wastes a second;
sending keystrokes to the wrong window can type into a chat, a terminal or a form. Three
constraints that should not be negotiable: (a) input is always addressed to an **explicit window
id**, never "whatever is focused", so a focus change between decision and action cannot redirect
it; (b) every input action is a **confirmable action** in the `server/actions.js` sense — the
same propose→confirm gate the ledger uses, with the target window named in the spoken summary;
(c) a **deny-list of window classes** (password managers, terminals, the browser's own address
bar) that never receive synthetic input at all, because those are where a misdirected keystroke
does lasting damage. Bitwarden is installed on this box, which is the concrete version of that
argument. *Hook:* `server/desktop.js`, `server/actions.js` (new action kinds), `apt install
xdotool` as a documented prerequisite with a `serviceProbe()` entry.

**H5. ✨ Prefer the app's own front door to a synthetic click — S.** Before reaching for **H4**,
reach for the interface the app already exposes. Obsidian speaks `obsidian://open?vault=…&file=…`
— so *"open my notes on kilns in Obsidian"* is a **URI**, not a search box plus typing plus
Enter, and it is deterministic in a way that clicking never is. Brave takes `--new-tab <url>`;
`nemo <path>` opens a folder; `xdg-open` handles anything with a registered handler; and AIOS
*already knows the vault path*, so the file half is a `vault_search` away. Build a small map of
**app → deep-link recipes** and make the tool try that route first. This is the difference
between "it clicked around and probably worked" and "it opened the right note". *Hook:*
`server/desktop.js` recipe table, `server/vault.js` for path resolution.

**H6. 🔥 The safety model, decided before the capability lands — S.** This is the first feature in
AIOS where a mistake escapes the browser tab, and the project already owns the right pattern:
propose, confirm, then act. Concretely — an **allow-list** of launchable apps in Settings
(default: everything discovered, with a switch to flip to explicit-only), **launching is
low-consequence** and can run on confirmation-by-default like the additive writes, **synthetic
input is always confirmed** (**H4**), nothing here is ever reachable from Chat's tool belt
without the gate, and every desktop action is logged with its target so **C17**'s ledger can show
what was done. One more, specific to this feature: a fetched web page or a vault note can already
steer the agent (**B5**) — and "the model can now start programs" is exactly the escalation that
threat model is about. Desktop tools must be **agent-and-voice only**, never in the chat belt
that a summarised web page flows through. *Hook:* `server/tools.js` gating, `server/config.js`
new `desktop` section, `server/actions.js`.

**H7. 🧪 See-and-act: let the model read the screen — M.** The pane in **H2** produces a JPEG, and
this box has a **vision model already wired for receipts** over the same `image_url` path. So
*"is the export finished?"* becomes: capture the window, ask the vision model, answer out loud.
That is a genuinely new capability and it needs no new stack — `receipts.js` proves the plumbing
end to end. The version to resist is the general one: a loop that screenshots, asks the model
where to click, clicks, and repeats is a computer-use agent, and on an 8GB card with a local
model it will be slow, wrong, and unattended in front of your real desktop. **Read the screen to
answer questions; act through H1/H3/H5's named verbs.** *Hook:* `server/desktop.js:captureWindow`
→ `server/llm.js` vision path, the pattern in `server/receipts.js:scan`.

**H8. 💭 Wayland — know now that this ends — S to find out, L to solve.** Every mechanism above is
X11 (`xwd`, `wmctrl`, `xdotool`, region grabs). Wayland deliberately forbids one client seeing or
driving another, and the replacements are the **xdg-desktop-portal** screencast API (PipeWire,
user grants a permission dialog per session) and `ydotool` via uinput (needs a privileged
daemon). Cinnamon on X11 is where this box is today and there is no reason to pre-solve it — but
the abstraction should be one `desktop.js` backend interface with an `x11` implementation, so
the day the session type changes the answer is a second backend rather than a rewrite. Put the
session type on the health page (**C5**) so the failure is legible instead of mysterious.
*Hook:* `server/desktop.js` backend split, `server/checks.js`.

## E. Monetization / return-on-investment 💰

A genuinely differentiated, private, local-first hub. The 2026 comparison landscape sharpens the
pitch: **Open WebUI** is the best Ollama front-end and has the most mature multi-user/RBAC story;
**AnythingLLM** is RAG-first with per-workspace document sets; **LibreChat** is the multi-provider
chat with token tracking. All three are *chat interfaces*. None of them has an agentic coder
scoped to your projects, a planner, a ledger with receipt OCR, a second brain, an image studio,
and local-model lifecycle management in one shell — **that combination is the moat**, and it is
also why AIOS should not try to out-RAG AnythingLLM (see **D1**: borrow the reranker, skip the
vector-DB arms race).

**E1. 💰 Productize AIOS as a self-hostable "private AI OS" — L.** The homelab / r/selfhosted /
privacy crowd duct-tapes a chat UI + Obsidian + cron + a dozen tabs. Package it: a one-command
Docker/install script, a short landing page, and a one-time "Pro" licence or Sponsors tier that
unlocks the convenience layer. Ship **B2** (backups), **B11** (multi-device), **C1**+**C8**
(notifications/push) and **C7** (mobile) *first* — they are the paid-tier surface. Core stays
open to build trust and inbound. **D3** (MCP server) is the cheapest possible top-of-funnel.

**E2. 💰 Publish the local-model benchmark as a public content asset — M.** Bench answers a
question thousands of people Google — *"which local model is actually best for coding / JSON /
agents on 8GB VRAM?"* — and it is **deterministic**, so the numbers are credible in a field full
of vibes. Export `data/bench.db` to a static leaderboard page, auto-published from a scheduled
run (**D6**), seeded to r/LocalLLaMA and HN. Near-zero marginal cost and the most SEO-friendly
thing in the repo. Sharpen it with an angle the big leaderboards can't copy: *measured on one
real 8GB laptop, with the VRAM math shown*. Adding **B12**'s speculative-decoding deltas would
make it genuinely novel.

**E3. 💰 Direct RoI you can turn on this week — S.** Use AIOS itself as a portfolio and
consulting lead: "I build private, self-hosted AI hubs for your team", with AIOS as the live
demo. Billable hours, not speculative product revenue.

## F. Parked — Job Search v2 (a design for when we revisit)

The v1 app was cut because its *sourcing* layer was the problem, not its idea. The AI value —
resume → structured profile, fit-scoring, EN/JP cover letters, questionnaire answers, a kanban
pipeline — worked. What didn't: self-hosted Firecrawl/SearXNG **scraping** of Indeed and job
boards fought Cloudflare intermittently, violated ToS, returned index pages posing as postings,
and was high-maintenance for one user. (A `jobsearch` config block still lingers in
`data/config.json` from v1 — delete it, or keep it as the v2 seed.)

**Design principles**
- **Don't scrape hostile boards — ingest what's already permitted.** Sourcing, in priority order:
  1. **Capture box + bookmarklet / share-target** (primary): paste a job URL or its text and the
     local model extracts structured fields. Zero ToS risk, always works, mirrors what you do by
     hand. **B3**'s schema-constrained output makes this extraction reliable.
  2. **Official feeds / ATS endpoints**: RSS/Atom job feeds and the public per-company JSON that
     Greenhouse (`boards.greenhouse.io/<co>.json`) and Lever (`api.lever.co/v0/postings/<co>`)
     expose. Curate a company watch-list; poll politely.
  3. **Email-driven**: reuse the IMAP layer — a "jobs" folder whose alert emails (board digests
     you already subscribe to) get parsed into postings. Their delivery becomes the feed.
  4. **One reputable aggregator API** (opt-in, user's own key) for breadth — a single connector
     behind a paid tier, not three brittle ones.
- **Relational store** — `data/jobs.db` (built on **A5**'s shared helper): `postings` (source,
  url, company, title, location, remote, comp, description, fingerprint for dedup),
  `applications` (posting_id, stage, dates, timeline), `contacts`, `documents`. "Which
  applications are stalled >14 days?" is a relational query.
- **Keep the AI that worked** — profile memory, fit-scoring, tailored cover letters (EN/JP),
  questionnaire answering: provider-agnostic plain-prompt flows; they just need the new sourcing
  and store under them.
- **Reuse existing infra** — `mail.js`, the notification center (**C1**, for follow-up nudges),
  the Planner, model roles (**A2**), the SQLite pattern. New surface is small.
- **Gig/annotation earnings** — a lightweight, opt-in watcher that surfaces "work available now"
  via *official* status endpoints (no cookie-scraping like v1) → a notification. Doubles as the
  **E3** lever.
- **Scope discipline** — ship capture-box + ATS-feed + email-extraction first (all legitimate,
  all reliable), prove it's useful, only then add the paid aggregator.

## G. Decided against — don't re-suggest

Recording the *reasoning*, because a good idea that was already rejected costs a whole session to
re-litigate.

- **`auto:<category>` model routing** (built, removed 2026-07-27). Bench-driven pseudo-models that
  picked a winner per request. Ten extra entries in every picker to express a preference the
  Local list expresses directly, and the per-category winners it showed duplicate the Bench app.
  `router.legacyAutoRef()` remains only so refs saved in old transcripts still resolve. If
  per-task model selection returns, it should be **A2**'s roles resolver (`fast`/`smart`/`vision`),
  not user-visible pseudo-models.
- **Mindmaps** (built, removed). The Learning Corner replaced the UI; outlines still land in the
  wiki via `wiki_generate`.
- **Job Search v1** (built, removed). See **§F** — the idea survives, the scraping doesn't.
- **A separate OCR stack** (PaddleOCR / tesseract / dots.ocr) for receipts. Measured: the local
  vision model reads a real photographed Japanese receipt correctly, over the `image_url` path
  `llm.js` already speaks. A second VRAM tenant to beat that marginally on clean input is a bad
  trade on an 8GB card.
- **`sharp` / `pillow-heif` / ImageMagick** for image conversion. ffmpeg is already on the box and
  decodes HEIC natively without libheif (✅ verified against the Nokia HEIF conformance suite),
  so the conversion costs one subprocess and zero dependencies.
- **Reading the JAN barcode above each receipt line.** Sound in theory — Japanese receipts
  print a 13-digit code per line, digits OCR better than katakana, and a JAN is a globally
  unique product id, so it would be a perfect catalogue key. Tried it (schema field +
  prompt) and measured: **0 of 4 codes captured, and asking degraded everything else** —
  the total came back 3302 against a real 2302, with amounts shuffled between lines. The
  consistent finding for this model is that it gets *worse* the more you ask of it in one
  pass. Revisit only with a stronger reader, or as a separate second pass over a crop.
- **Multi-user as a near-term goal.** Parked as **D15** — real work in every store's schema, and
  only justified if **E1** happens.

---

## Sources

Research behind the items marked with 2026 findings (checked 2026-07-27):

- **Structured output / GBNF** — [llama.cpp grammars README](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md) ·
  [Structured Output and Function Calling (DeepWiki)](https://deepwiki.com/qualcomm/llama.cpp/8-structured-output-and-function-calling)
- **MCP adoption + 2026-07-28 spec** — [MCP spec release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) ·
  [MCP adoption statistics 2026](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol) ·
  [Complete guide to MCP in 2026](https://dev.to/x4nent/complete-guide-to-mcp-model-context-protocol-in-2026-architecture-implementation-and-4a11)
- **Embeddings + reranking in llama-server** — [llama.cpp server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) ·
  [How to call the llama.cpp rerank API](https://www.simplified.guide/llama-cpp/server-call-rerank-api)
- **Speculative decoding** — [llama.cpp docs/speculative.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md) ·
  [Speculative decoding on consumer GPUs (discussion #10466)](https://github.com/ggml-org/llama.cpp/discussions/10466)
- **Prompt injection defence** — [Unit 42: web-based indirect prompt injection in the wild](https://unit42.paloaltonetworks.com/ai-agent-prompt-injection/) ·
  [Web agents should adopt plan-then-execute](https://arxiv.org/pdf/2605.14290) ·
  [Sysdig: comprehensive guide to prompt injection 2026](https://www.sysdig.com/learn-cloud-native/prompt-injection)
- **Competitor comparison** — [Open WebUI vs LibreChat vs AnythingLLM](https://www.local-llm.net/compare/open-webui-vs-librechat-vs-anythingllm/) ·
  [AnythingLLM vs Open WebUI vs LibreChat 2026](https://runaihome.com/blog/anythingllm-vs-open-webui-vs-librechat-2026/)
- **Local models for 8GB** — [Best local LLMs for 4/6/8GB VRAM by task](https://www.mayhemcode.com/2026/06/best-local-llms-for-4gb-6gb-and-8gb.html) ·
  [Best open-source LLMs: July 2026 leaderboard](https://techsy.io/en/blog/best-open-source-llms-2026)
- **Voice stack** — [Local voice assistant: Whisper + LLM + TTS](https://www.local-llm.net/guides/local-voice-assistant/) ·
  [Piper archived, use Kokoro/XTTS](https://brainsteam.co.uk/2025/4/6/adding-voice-to-selfhosted-ai/)
- **Observability** — [OpenTelemetry GenAI observability](https://opentelemetry.io/blog/2026/genai-observability/) ·
  [How OTel traces LLM calls, agent reasoning, and MCP tools](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions)

---

*Backlog hygiene: when an item ships, replace it with a one-line note under **Recently shipped**
and delete the bucket entry — **do not renumber**, IDs are stable and retire with their item. If
you reject an idea, move it to **§G** with the reasoning rather than deleting it. Keep this file
forward-looking; the changelog lives in git history and project memory.*
