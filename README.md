# AIOS — your personal AI operating hub

A web desktop that runs on your machine and serves your whole LAN. One place for
chatting with local + cloud models, pointing an agentic coder at your projects,
growing an Obsidian second brain, learning something with an AI tutor, tracking
your money (photograph a receipt, it files itself), generating images, running
local models, and dropping into real terminals — full-page attached views switched
from a dock, a command palette, and a warm Claude-style aesthetic. Apps keep
running in the background when you switch away (terminals stay alive, agent runs
keep streaming); right-click a dock icon to quit one.

```
npm install       # once (also builds native PTY support)
npm start         # serves http://localhost:7777 and your LAN IP
```

The console prints your addresses. The LAN link includes a pairing token —
open it on any other computer/tablet on your network and it just works. Phones get a
purpose-built shell at `/m`; `npm run remote-setup` extends that to anywhere you are.

---

## The apps

| App | What it does |
|---|---|
| **Home** | Greeting, a modular **services status** panel (SearXNG, model providers, vault — anything that can be offline), stats, quick-capture to your daily note, launchers |
| **Chat** | Streaming conversations with any configured model; markdown, code copy, per-chat system prompts, persistent history, and a collapsible **chain-of-thought** panel when the model reasons. **Talk to it** — dictate into the composer, or open **Voice mode** for a hands-free back-and-forth — and when it wants to write something (log a payment, add an event) it asks first with an editable **confirmation card** |
| **Agent** | Claude-Code-style coding agent scoped to a project: it explores with `list_dir`/`glob`/`grep`/`read_file`, changes code with `write_file`/`edit_file`, runs `bash`, searches the web with `web_search`, reads docs with `fetch_url`, pulls best-practice **playbooks** with `skill`, and reads/maintains your **knowledge base** with `vault_*` — streaming every step as collapsible tool cards with diffs. Extra guardrails for small local models: a **self-check** loop that syntax-gates everything it writes, injected coding playbooks, and a per-project **memory** it maintains and learns from. Switching the active project re-scopes the agent to that project |
| **Research** | Deep, cited web research: give it a question and it plans searches, reads real sources through SearXNG, loops on the gaps, and writes a report with inline `[n]` citations and a sources list. Runs entirely server-side (works with any model, no tool-calling needed); export any report into your vault |
| **Files** | Tree explorer + CodeMirror editor (JS/TS, Python, Markdown, HTML, CSS, JSON), quick search, image preview, markdown preview, conflict detection if the agent edits a file under you |
| **Terminal** | Real PTYs (node-pty) in xterm.js — colors, vim, resize; one shell per window |
| **Projects** | The hub's registry: register existing folders, create new ones (README + git init), git branch/dirty badges, favorites, notes, jump straight into Agent/Files/Shell |
| **Second Brain** | Your Obsidian vault: browse/edit/search notes, clickable `[[wikilinks]]`, backlinks, tag chips, an interactive link **graph**, daily-note capture — plus AI that answers *from your notes with citations*, summarizes, and **grows the wiki** by writing interlinked atomic notes into an `AI Wiki/` folder |
| **Learning Corner** | An AI tutor: a subject **tree**, AI-designed capability roadmaps, web-grounded lessons, and **assessments** with per-question grading (multiple-choice, short-answer, ordering) and per-topic **mastery** tracking |
| **Interview** | Practice interviews out loud, and the answers worth keeping. Voice mode's **Mode** button puts the AI on either side of the table — it interviews you and probes the weak half of every answer, or it answers *your* questions the way a strong candidate would. Press **Keep** on any turn and it lands here as a flashcard: question first, answer hidden until you ask for it, with **Listen** and **Practise** (which reopens hands-free and asks you that exact question again) |
| **Finances** | A real ledger: earnings, expenses, budgets, goals, recurring entries and presets across five tabs sharing one period selector; multi-currency, CSV export — plus **receipt capture** (photograph it, a local vision model reads it, you review, it posts) and **item price tracking** that tells you which shop is actually cheaper per unit. Every scan **scores its own confidence** and re-reads itself (turning the photo when nothing was legible) until it is convincing or has had three goes; the same purchase **cannot be logged twice**; and what you correct is remembered per shop, so the next receipt from there arrives already fixed |
| **Studio** | ComfyUI cockpit: text→image, image→image and 4× upscale, Animagine + Lightning-LoRA sampling plans, pixel-space hi-res, an LLM prompt generator — and AIOS owns the ComfyUI/llama lifecycle so the 8GB card never double-books |
| **Models & Bench** | The llama-launcher, absorbed: per-model presets (context, offload, KV quant, flash-attn, vision projector), live GPU/VRAM, log pane, VRAM-fit hints — plus a **deterministic** benchmark scoring every local model per category with TTFT and tok/s (no LLM judge) |
| **Planner** | Calendar, recurring events, birthdays, reminders and tasks, folded into Home's next-three-days |
| **Mail** | Read-only IMAP triage with sender ratings and a mini-Gmail viewer; important mail can ping Discord |
| **GitHub** | Profile, contribution heatmap, repos, PRs, issues; publish a local project or clone one |
| **Settings** | Providers, **tools** (enable/disable each agent tool, web-search backend), **9 themes** (light/dark/system + Matrix/Nord/Dracula/Rosé Pine/Synthwave/Solarized) with accent & wallpaper, vault paths, agent defaults & self-check, **voice** (speech model, voice, rate, and whether replies are spoken at all), network & security |

Shell niceties: **Ctrl+K** command palette (apps, project switching, vault search,
actions), project switcher and active-view crumb in the top bar, a theme gallery
(9 palettes incl. an animated **Matrix** katakana-rain and a **Synthwave** neon
grid), accent colors, and wallpapers.

## Voice

Speak to it, and have it answer. Both halves run **on this machine** — the microphone
audio and the replies never leave the box.

| | |
|---|---|
| **Listening** | Two recognisers, because they are good at opposite things. [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2) produces the text that is *acted on* — `small` at ~1.9s an utterance on CPU, ~180ms on the GPU. A streaming [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) Zipformer transducer produces the words that appear *while you talk* (20.3% WER, first word at 0.62s), and decides when your sentence ended. Silero VAD trims the silence, which is what stops whisper hallucinating "Thank you for watching" into a quiet clip |
| **Speaking** | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) as ONNX — 54 voices, ~4× realtime on the CPU. Piper was archived in October 2025; Kokoro is the current small-and-good option |
| **Languages** | English (US/UK), 日本語, 中文, and six more. Japanese and Mandarin go through **misaki**, not espeak — espeak does not read kanji, it reads *about* them, phonemizing 今月の食費 as "Chinese letter, Chinese letter, Chinese letter" |
| **Mixed speech** | Two aids for saying Japanese amounts inside English sentences (see below) |

Three ways in:

- **Dictate** — the mic button beside **Send**. What you say lands in the box so you
  can fix a misheard word before sending. (Optionally sends straight away.)
- **Voice mode** — the waveform button beside it, or `Ctrl+K → Voice mode`. A
  full-page, hands-free conversation: it listens, notices when you stop talking,
  answers, reads the answer back, and listens again. Space to talk, Esc to leave,
  tap to interrupt. The agent gets the left half as a reactive HUD — a radial
  spectrum driven by the **microphone while it listens and by its own voice while it
  speaks**, counter-rotating instrument rings, a 32-bar input register and a
  `LISTENING · LVL 812 · JA` telemetry line — with the transcript scrolling beside it
  on the right. Colour is state: accent listening, green speaking, amber waiting on
  a yes. **Pause** stops the loop without losing the transcript, **Repeat** says the
  last answer again, **Keep** files an answer in the interview bank, **Save** files the
  conversation in today's note, and short tones mark the microphone opening and closing
  so you can tell listening from thinking without looking. **Mode** decides how it
  answers you at all — see *Practice interviews* below. `Space` talk · `M` mute ·
  `H` hands-free · `R` repeat · `S` keep · `I` mode · `P` pause · `Esc` close.
- **Spoken replies** — the **Voice** control next to *Tools* in the chat header, with
  three positions: **Always on**, **On click**, **Muted**. It shows the current one,
  and also opens Voice mode and the voice settings.

None of these controls hide themselves when voice is unavailable — they say what is
wrong when you press them. A missing button and a blocked microphone look identical,
and the most common reason for "unavailable" is not a missing model but the LAN-address
rule below.

**Making it sound like yours.** Settings → Voice has a shortlist of the genuinely
good voices (the whispery close-mic ones stay in the full list of 54, out of the
shortlist — they sound like an ASMR channel reading your budget). Two knobs go past
what the model ships:

- **Blend** — Kokoro addresses a voice by an *embedding*, not a name, so two can be
  averaged into a real third one. "Heart 55 / Emma 45" is a consistent speaker that
  is not in the list and that nobody else has.
- **Pitch** — shifts the voice up or down with the speaking rate pre-compensated, so
  the sentence still takes about as long to say. Roughly: the model's own rate control
  is not linear, so a lower pitch also reads a little quicker.

**What it does NOT read aloud.** The model writes for a screen, and read literally
that becomes "hash hash hash", "star star", "dash dash verbose". Before anything is
spoken it is flattened: headings, emphasis, code fences, tables, bullets and
list numbering go; `--verbose` loses its dashes; `~/notes/budget.md` becomes
"budget.md"; `n-1` becomes "n minus 1" while `2020-2024` becomes "2020 to 2024";
`>=` becomes "at least". Two of those were structural rather than cosmetic:

- Replies are spoken **sentence by sentence as they stream**, so a chunk routinely
  ends mid-markup — `the total is **8,000` with no closing pair anywhere in it. No
  balanced-pair rule can see that, so a final sweep removes orphan delimiters.
- The sentence splitter used to cut inside decimals: `1,234.56` became two chunks,
  and the second was heard as a separate number — which is where "zero zero zero"
  came from. A full stop between two digits is no longer a sentence end (and 。 never
  needed a following space, which is a Latin-typography rule).

**Muting is first-class.** Set it from the chat header or Settings → Voice. On
**Muted** the speech model is never even loaded and the per-message speaker buttons
disappear — voice becomes a pure input method, which is the right answer on a phone in
a meeting. It is a per-device setting, so the laptop in the study and the phone in
your pocket can disagree.

### Practice interviews

The **Mode** button in the hands-free header (or `I`) decides how the AI behaves when
you talk to it. Every voice session gets the same base instruction — *you are being
heard, not read*, so no markdown, short sentences, lists spoken as prose, code
described rather than read out, at most one question per turn — plus an **answer
style**: Natural, Brief, In depth, or Socratic (which refuses to hand you the whole
answer and asks the question that makes you find the rest).

Switch it to **Interview** and pick which side the AI plays:

- **AI interviews me.** It opens with one question and then stops. Your answer arrives
  through speech-to-text, so it is told to read through the transcription noise rather
  than pull you up on "mute ex". When an answer is thin it follows up on the weakest
  part instead of politely moving on; when it is strong it goes harder on the same
  thread. Say you are finished and it drops character for a debrief: what was strong,
  the two biggest gaps, and a model answer to the question you handled worst.
- **AI answers me.** You interview it. It answers as a strong candidate would answer
  *out loud* — the direct answer first, then the mechanism or the trade-off, then what
  it would do in practice — in about 45 to 90 seconds, ending with one specific offer
  to go deeper. This is the mode that produces answers worth keeping.

Set the role ("Senior backend engineer — Node, Postgres"), the level, and the focus
(coding, system design, language deep-dive, debugging, behavioural). Anything you type
under *In your own words* is passed through verbatim.

Two things change in the loop itself, because an interview answer is not a chat
message: the pause that ends your turn stretches to 2.4s, and a single answer can run
to three minutes. At the conversational thresholds the recorder cuts you off in the
middle of your own answer, which is the most infuriating thing this feature could do.

**The answer bank.** Press **Keep** on any turn (or `S`) and that exchange is saved
with the session's topic and level. The **Interview** app is where they live, built as
flashcards rather than as an archive: the question shows, the answer is hidden until
you ask for it, and every card can be **listened** to or **practised** — which opens a
fresh hands-free session where the interviewer asks you that exact question again.

An interview session is an ordinary chat underneath (it appears in Chat, under an
*Interview* folder, and scrolls back like anything else) with a composed system prompt
and no tools — an interview is answered from the head, and a web search mid-question is
eight seconds of silence you cannot account for. It is also the one kind of chat that
is sealed off from the ambient context: the shared prompt normally carries your
planner, inbox and profile, and an interviewer that knows about tomorrow's dentist
appointment will eventually mention it.

Every voice control is exercised by `scripts/e2e/voice-ui.e2e.mjs`, which drives a
real browser and fails on error toasts as well as exceptions — a caught error that
becomes a red toast is invisible to a bundler and to `node --check`, and that is
exactly the shape of bug it exists to catch. It covers the interview setup form and
the answer bank too, since a form is nothing but click paths that only exist at click
time.

Install with **`npm run voice`** (~2GB: a private venv under
`~/.local/share/aios/voice`, the two models, and the CJK phonemizers — `--no-cjk`
skips those). Models load on first use and are dropped again after
`voice.idleMinutes` of quiet, so an idle hub is not sitting on ~1.2GB of speech
models. Nothing else on the box is touched: the venv is deliberately its own, because
pip-installing into somebody's ComfyUI environment is how you break image generation.

> **The one gotcha:** browsers only hand out a microphone in a *secure context*. That
> means voice input works on `http://localhost:7777` but the mic is simply **absent**
> on `http://192.168.x.x:7777` — no prompt, no error. Settings → Voice says so
> explicitly when it detects it. To use voice from another machine, either serve AIOS
> over HTTPS or allow the origin under `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

### Live text while you speak

Words appear **as you say them**, not a second at a time — because two different
recognisers are doing two different jobs.

Whisper cannot do this one, and it is not a tuning problem. It is a sequence-to-sequence
model over a fixed **30-second window**, so it decodes the padding along with the
speech. Measured here on `small`:

| audio | decode | |
|---|---|---|
| 0.83s — "Log it." | 1786 ms | 1.00x |
| 2.09s | 1848 ms | 1.04x |
| 9.71s | 2163 ms | 1.21x |

**11.7x the audio for 1.21x the time.** Short dictation — which is most dictation — pays
the full window price every time, and re-running that over the growing utterance once a
second was quadratic work for a result that kept changing.

So the live text comes from a **streaming Zipformer transducer** ([sherpa-onnx]
(https://github.com/k2-fsa/sherpa-onnx)) instead. It consumes 200ms chunks, carries its
decode state between them, and emits tokens as it goes — **RTF ≈0.065** on four CPU
threads, so a chunk costs about 14ms and it never competes with anything. The model is
the multilingual build (ar/en/id/ja/ru/th/vi/zh), chosen over the better English-only
ones because half of what gets dictated here is Japanese and a live recogniser that
cannot hear 五万円 is no use for logging money.

```
+0.8s  live      I SPENT
+1.6s  live      I SPENT THREE THOUSAND
+2.4s  live      I SPENT THREE THOUSAND TWO HUNDRED YEN
+3.2s  live      I SPENT THREE THOUSAND TWO HUNDRED YEN AT LAWSON ON
+4.2s  ENDPOINT  (it heard the sentence finish)
+4.4s  FINAL     I spent 3,200 yen at Lawson on lunch today.
```

The transducer is **feedback, not the answer** — and deliberately so. On the same clips
it produced "THREE THOUSAND **JANET** LAWSON" and read 今日は as 気に, and it emits no
punctuation and upper-case English. Whisper still does one full pass when you stop, and
that reading is what reaches the language model and the ledger. Feel from one, accuracy
from the other; the live text is replaced wholesale the moment the real one lands.

**Three things it was getting wrong, all found by measuring it** (`npm run voice-bench
-- --stream`, 36 clips through the same worker the microphone uses):

| | WER |
|---|---|
| as first shipped | **39.7%** |
| + flush the stream when it closes | 28.7% |
| + stop resampling in JavaScript | 25.2% |
| + beam search instead of greedy | **20.3%** |

1. **A zipformer decodes in fixed chunks**, so the samples left in the final partial
   chunk are never formed into one and the last word or two is simply never emitted.
   The live line read `…AT LAWSON ON LUN` and sat there for the two seconds whisper
   takes to answer. Closing the stream now pads it with silence, flushes it, and
   *returns* the result — it used to be fire-and-forget, so nobody ever saw it.
2. **The endpointer wiped what it had already heard.** sherpa resets the decoder when
   it decides a sentence finished, which is correct — the next sentence must not
   inherit this one's state — but the text was going with it. A 1.2-second thinking
   pause mid-turn trips it routinely, and the line went from `I SPENT 3200 YEN AT
   LAWSON ON LUNCH TODAY` to whatever came after the pause. Segments are committed
   before the reset now.
3. **The browser was resampling 48kHz down to 16k with a box filter**, which is barely
   a low-pass — it aliases exactly the high-frequency detail that separates one
   consonant from another, and cost **3.2 points**. There is no resampler in the
   browser any more: the `AudioContext` is asked for 16kHz so the browser does it
   natively, and whatever rate it settles on travels with the bytes for sherpa to
   resample in C++.

**Beam search is the default** (`stt.streamDecoding`): same cost to a person — RTF
0.086 → 0.111 against a 200ms chunk budget — for 23.6% → 20.3% WER and the first word
**130ms sooner**. **Contextual biasing is not**: `stt.streamHotwords` feeds the
transducer the same merchant list whisper gets as a prompt, and on *this* ledger it
measured as noise in the wrong direction (25.0% → 26.4%) because these merchants are
ordinary English words the model already reads. It earns its keep on names the model
cannot spell — "FAMILY MARCH" becomes "FAMILY MART" — so it is one flag away if the
shops you say out loud are Japanese.

And the live line now **writes numbers as figures**, because the transducer spells them
out and whisper does not: `I SPENT THREE THOUSAND TWO HUNDRED YEN` and `I spent 3,200
yen` disagreed on screen at exactly the moment the eye compares them. Folded on the
live side only — rewriting whisper's output would put a guess about English number
words in front of the ledger.

It also brings its own **endpointer**, which is the better half of the deal. Ending a
turn on trailing silence *measured against what was actually decoded* beats a fixed
loudness timer, because it will not cut you off during a mid-sentence pause.

Settings → Voice: `stt.streaming` turns it off, and the live text falls back to the old
behaviour — re-reading the utterance with a small whisper (`tiny` ≈0.3s, `base` ≈0.7s).
That path is still there for a client too old to send PCM, and `npm run voice
--no-streaming` skips the 259MB model entirely.

### Hearing what you actually said

**Which model to actually use** (`npm run voice-bench -- --models small,medium,turbo
--degrade`, 36 clips, 16-core CPU): `small` at **1.7% WER / 2.1s**. `base` is 4.6% —
fine for the live partials, wrong for the pass that gets acted on. `medium` ties `small`
at 2.6× the cost, and **large-v3-turbo is both worse and 4× slower on CPU** (it is
distilled for GPU batching). `beam_size=5` helped nothing. int8 beats float32 on both
speed and accuracy. The defaults are those numbers, not a guess.

**The other setting that matters is not the model either.** `npm run voice-bench` synthesises a
realistic phrase set with AIOS's own voices, feeds it back through the same worker the
microphone uses, and scores word error rate — so the knobs get chosen from numbers
rather than instinct. On clean audio `small` sits at **1.7% WER**, and neither the
bitrate nor the browser's noise-suppression flags moved it measurably.

What did move it was **when the recording stops**. Measured through a real browser with
a real `getUserMedia`, against a sentence containing a normal 0.9-second thinking pause:

| silence window | recorded | WER | what it heard |
|---|---|---|---|
| 1100 ms (the old default) | 3.4 s | **62%** | *"I made 8 man end through Micro 1."* |
| 1500 ms (now the default) | 6.8 s | 38% | the whole sentence |
| 2000 ms | 7.4 s | 38% | no better |

The second half of the sentence was **never captured at all** — and a confident
transcription of half a thought is indistinguishable, from the outside, from the model
mishearing you. The effective tolerance is shorter than the number too, because noise
suppression gates a pause to digital silence before the tail of your voice has finished
decaying. Settings → Voice lets you pick Snappy / Natural / Patient / Very patient per
device, and `voice-convo.e2e.mjs` now fails if a mid-sentence pause ever truncates a
turn again.


Two things wreck transcription for a bilingual user, and neither is the model's fault
— whisper simply has no idea what *you* talk about.

**Names it has never heard.** "I spent 3000 at Lawson" came back as *"I spent three
cents and it lost in"*. Whisper accepts a vocabulary hint, so it is primed with your
own merchants and categories straight from the ledger, plus anything you add under
Settings → Voice → *Words to listen for* (platform names, people, projects). Same
sentence now keeps the merchant.

**Japanese counters inside an English sentence.** "I made 8 man en through Micro1"
transcribes as *"I made 8-Man N through Micro1"* — every word heard, the meaning gone,
and 万 is **four orders of magnitude**. That is fixed after transcription:

| you say | whisper hears | the model gets |
|---|---|---|
| I made 8 man en through Micro1 | `I made 8-Man N through Micro1` | `I made 80,000 yen through Micro1` |
| I got 12 man from Upwork | `I Got 12 Man From Upwork` | `I got 120,000 from Upwork` |
| 八万円もらった | `八万円もらった` | `80,000円もらった` |
| 十二万円 | `十二万円` | `120,000円` (twelve *man*, not a hundred and two) |

It stays deliberately narrow: every rule needs a number next to a counter, so "the man
at the counter" is left alone and "and" is never eaten as 円. One honest limit — 千
(*sen*) said inside an English sentence collides with "cents" and whisper often writes
`$3.00`; 万 is the one that carries real money and it is reliable.

## Confirm before writing

Say *"I made 50000 through Uber Eats today"* or *"I have a dentist appointment next
Tuesday at 3pm"* and the assistant does **not** quietly write to your ledger or your
calendar. It comes back with a card:

```
LOG INCOME                                    needs your ok
Income JPY 50,000 from Uber Eats · Freelance · 2026-08-15
[ ✓ Confirm ]  [ ✎ Edit ]  [ Discard ]
```

Every field is editable in place before you agree — amount, category, payer, date —
because catching a misheard `5万` costs one keystroke here and an unexplained
reconciliation gap later. By voice, the same card is read out ("Add fifty thousand yen
of income from Uber Eats under Freelance, today. Shall I?") and a spoken **yes** or
**no** settles it; a bare yes/no never reaches the model, so it cannot be
"helpfully" acted on twice.

Confirmable today: log income/expense, add a calendar event, add a to-do, set a
category budget, set the monthly goal, save a note, append to a note, add to the daily
note. Adding another is one entry in `server/actions.js`. Turn the whole thing off in
Settings → Chat if you prefer the old direct-write behaviour.

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

## MCP servers

An **MCP server** is a small program that publishes tools over the Model Context
Protocol — driving Godot, a browser, a database, whatever someone has written one
for. AIOS connects to the ones you configure and its tools join the agent's belt
beside the built-ins: same approval gate, same Settings rows, same everything.

Add one in **Settings → Tools → MCP servers**. Presets fill in Godot, the official
filesystem server, Playwright and Context7; anything else is a command and its
arguments (or a URL for a remote server). Saving does *not* start it — **Connect**
does, because spawning a program should be something you asked for. **Try** runs one
of its tools by hand, which is how you tell "it connected" from "it works".

```
Godot:  git clone https://github.com/Coding-Solo/godot-mcp && cd godot-mcp
        npm install && npm run build
        → command: node   args: /abs/path/to/godot-mcp/build/index.js
        → env GODOT_PATH=/path/to/godot   (optional — it probes common locations)
```

How it fits the rest of the hub:

- **Namespaced.** A server with id `godot` publishes `godot_launch_editor`, and its
  tools sit in a group called `mcp:godot`. Two servers can both offer a `search`
  without colliding, and a built-in name always wins over a remote one.
- **Free until used.** Each server is its own lean-loadout group, so its schemas
  stay out of the prompt until the model calls `load_tools`. Adding five servers
  costs a 32k local model nothing on turns that don't need them.
- **Gated by default.** MCP's `readOnlyHint` annotation is optional, so any tool
  that doesn't explicitly declare itself read-only goes through the approval mode.
  An unannotated tool is treated as one that writes.
- **Isolated.** These are other people's processes: they crash, hang, or fail to
  start. A broken server contributes no tools and shows its own stderr in Settings;
  it never delays a turn or takes the agent down. Enabled servers connect at boot,
  reconnect on use after a crash, and are killed with the hub rather than orphaned.

Both transports are supported: **stdio** (a local command — what nearly every MCP
server ships as) and **streamable HTTP** (a URL, for remote servers).

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

## On your phone, and away from home

`/m` is the whole hub in a phone-shaped document — a tab bar over **Home · Chat ·
Money · Tasks**, with **Notes, Files, Agent, Terminal** and **Settings** behind More.
A phone user-agent hitting `/` is redirected there (`?desktop=1` opts out). It shares
nothing with the desktop shell but `theme.css`, `api.js`, `themes.js` and
`imageprep.js`, so it can be opinionated about touch targets and the soft keyboard
without moving a desktop pixel.

The screen worth calling out is **Agent**: a run blocked on a file write is idle until
someone approves it, and approving from a train turns a two-hour gap into two minutes.

### Reaching it from outside the house

```
npm run remote-setup      # checks, configures, and tells you what needs sudo
```

The transport is **Tailscale** — a private WireGuard mesh, so AIOS is never placed on
the public internet the way a port-forward or a tunnel would. Your machine keeps a
permanent `<host>.<tailnet>.ts.net` name, and `tailscale serve` fronts port 7777 with a
real certificate. Install the Tailscale app on your phone, sign into the same account,
and open the link the setup script prints.

**The certificate is the point, not the polish.** Two things on a phone need a *secure
context* and silently do not exist without one:

- **The microphone.** `getUserMedia` is not *denied* over plain http — it is **absent**,
  so voice has never worked on a phone over the LAN. Chat hides the mic button rather
  than offering one that can only throw.
- **Add to Home Screen.** The PWA is pinned to an origin, so a stable HTTPS name is what
  makes the install stick.

Settings → Remote shows both live (`isSecureContext`, microphone availability), turns
HTTPS on and off, and offers a **QR code** for pairing another device. That code is
generated on the box: the pairing link contains the token, so handing it to a QR web
service would be handing away access.

## LAN broadcast & security

- The server binds `0.0.0.0`; startup prints `http://<your-ip>:7777/?token=…` links,
  and — once Tailscale is set up — the away-from-home address too.
- Default auth mode **Token for LAN**: localhost is open, any other device must
  present the pairing token (the `?token=` link stores it in that browser).
  Settings → Network can switch to *Token always* or *Open*, reveal the token
  (localhost-only endpoint), or rotate it.
- **Guessing the token is rate-limited.** `server/auth.js` compares with
  `crypto.timingSafeEqual`, counts failures per IP with exponential backoff (three free
  tries, then 1s doubling to 15 minutes), and logs every refusal with the source
  classified as `local` / `tailnet` / `lan` / `remote`. The **WebSocket upgrade shares
  that counter** — the browser reconnects automatically on close, so an unpaired client
  hammers `/ws` rather than `/api`. While locked out, even the *correct* token is
  refused, so tripping the lockout cannot be used to confirm a guess.
- Treat the token like a password: anyone holding it gets your terminal. Don't
  port-forward AIOS to the internet as-is — `npm run remote-setup` puts it on your
  tailnet instead, where it is reachable only by devices signed into your own account.
- **The agent cannot be pointed back at this machine.** `fetch_url`, `crawl_site` and
  Research's PDF reader take their URL from the model, and the model takes its ideas
  from the page it just read — so every fetch resolves the hostname first and refuses
  loopback, private, link-local (`169.254.169.254` included), CGNAT and multicast
  addresses, re-checking **after every redirect**. That matters here because this box
  answers on loopback with ComfyUI, llama-server, Ollama and SearXNG, none of which ask
  a passing request for a password. Set `tools.allowPrivateFetch` if you genuinely want
  the agent reading your own LAN services.

## Layout

```
server/            zero-build Node (ESM), no framework beyond express + ws
  index.js         HTTP + static + REST + WebSocket hub
  auth.js          the door: constant-time token compare, per-IP lockout, refusal log
  remote.js        away-from-home access over Tailscale (+ `tailscale serve` HTTPS)
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
  wiki.js          typed notes, autolinking, Home MOC, packed-memory recall
  learn.js         AI tutor: subjects, roadmaps, lessons, assessments (+ learndb.js)
  finance.js       ledger, budgets, goals, recurring, FX (+ financedb.js, financeai.js)
  receipts.js      photo → vision-model OCR → scored, re-read if doubtful → reviewed
                   → posted once (duplicate-guarded) → corrections learned per shop
  items.js         brand-free product catalogue + price history (+ itemsai.js)
  uploads.js       attachment intake: byte-sniffing + ffmpeg transcode (HEIC → JPEG)
  llmctl.js        AIOS owns llama-server: profiles, presets, mmproj, hot model swaps
  bench.js         deterministic per-category model benchmark (bench.db)
  router.js        local: refs → serve on demand · LLM auto-setup for new ggufs
  comfy.js         ComfyUI connector + workflow templates + VRAM guard
  planner.js       calendar/tasks · mail.js  IMAP triage · geo.js/everyday.js  toolbelt
  voice.js         local speech in/out: owns one Python worker holding both models
  actions.js       confirmable writes: what each one is called, how it reads, defaults
  terminal.js      node-pty (with `script` fallback)
web/               no build step — vanilla ES modules
  js/wm.js         view manager (pages + dock) · js/main.js shell + palette
  js/apps/*.js     the apps (chat, agent, research, studio, finance, learn, models,
                   bench, planner, files, terminal, projects, github, vault, settings)
  js/voice.js      mic capture, silence detection, spectrum, streaming playback
  js/voicemode.js  the hands-free conversation overlay (HUD + transcript)
  js/voiceviz.js   the canvas avatar: radial spectrum, rings, state colour
  js/mobile/       the phone shell at /m — app.js (router + tabs), ui.js (primitives),
                   md.js, qr.js (local QR, because the pairing link holds the token),
                   receipts.js (capture), screens/*.js (home, chat, money, tasks,
                   notes, files, agent, terminal, settings)
  js/imageprep.js  shared photo intake (HEIC decode, EXIF rotate, downscale)
  vendor/          self-contained bundles (CodeMirror 6, marked+DOMPurify+hljs, xterm)
skills/            coding playbooks (markdown) injected into the agent by stack
Roadmap.md         idea bucket for future features
data/              your stuff (gitignored): config, chats, agent sessions, research,
                   uploads, comfy renders, and four SQLite stores: learn, bench,
                   finance, plus per-project .aios/ memory
scripts/           build-vendor.mjs · check.mjs · audit.mjs · toolcheck.mjs · e2e.mjs
                   remote-setup.mjs (`npm run remote-setup`) · qr-check.mjs (+fixtures)
                   searxng.mjs · voice-setup.mjs (`npm run voice`)
                   voice/worker.py (the long-lived speech process)
                   gguf/split_omni_gguf.py (single-file omni GGUF → text + mmproj)
                   aios-launch.sh + aios.desktop + aios.svg (desktop shortcut)
                   aios.service (systemd unit)
```

`npm run check` bundles the frontend and parse-checks the server — run it after
hacking on AIOS (or let the Agent run it after hacking on itself).
`npm run audit` exercises every subsystem against a throwaway data dir.
`npm run toolcheck` goes one level lower and **runs every tool on the agent's belt**
against a fixture project, git repo and vault — the only way to notice a tool that
has quietly rotted, since a broken one looks exactly like a working one until
something calls it. Results are classified (`pass` / `env` / `skip`), so tools that
need the internet, a model, or credentials this box lacks are reported rather than
failed; only a real break exits non-zero. It borrows the machine's providers so the
model-backed tools are genuinely exercised — `--no-model` audits the offline surface
alone, and a bare word filters by group (`npm run toolcheck -- vault`).
`npm run vendor` rebuilds `web/vendor/` from npm packages.

## Starting it

**Simplest — a desktop shortcut.** `scripts/aios.desktop` (installed to your app
menu and `~/Desktop`) runs `scripts/aios-launch.sh`. A double-click is a **restart
button**: it kills whatever is on :7777 (by port owner, not by pidfile), starts a
fresh server so code changes take effect, waits until *that* process is the one
holding the port, opens your browser — and then resets the Tailscale HTTPS
front-end in front of it, so away-from-home access comes back with the hub rather
than needing a separate trip to Settings. Every step reports itself with a desktop
notification. Right-click for **Start** (never kills), **Open in browser** (no
start), **Reset remote access only**, and **Stop**. To (re)install after moving the
project:

```
desktop-file-install --dir=$HOME/.local/share/applications scripts/aios.desktop
cp scripts/aios.desktop ~/Desktop/ && chmod +x ~/Desktop/aios.desktop
gio set ~/Desktop/aios.desktop metadata::trusted true   # Cinnamon/Nemo: trust it
```

The launcher forces brew's `node` onto PATH (desktop launchers start with a bare
one) and daemonizes the server (PID in `aios.pid`, logs in `aios.log`), so it keeps
running after you close the launcher. The paths inside `aios.desktop` and
`aios-launch.sh` are absolute — edit them if the project moves.

The Tailscale step never escalates and never fails the restart. `tailscale up` and
`tailscale serve` run as the operator (`sudo tailscale set --operator=$USER`, once);
anything needing root is reported with the exact command rather than run, and a
Tailscale that is missing, logged out or wedged just means the hub comes up on
localhost and the LAN as usual. It finishes by checking that `https://<host>.ts.net/`
really answers — deliberately **not** an `/api` route, because only `/api` is behind
the token and a request arriving through `serve` is classified `tailnet`, not
loopback: probing it would 401 *and* burn a failed attempt against this machine's own
tailnet IP on every restart, and the per-IP backoff refuses a locked-out caller even
with the right token. `AIOS_NO_TUNNEL=1` skips the whole step; `AIOS_NO_OPEN=1` skips
the browser.

**Always-on — a systemd user service.** Start on login, restart on crash:

```
cp scripts/aios.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now aios
loginctl enable-linger $USER   # keep it up after logout
```

## Roadmap

The running backlog lives in [`Roadmap.md`](Roadmap.md) — 54 items with stable IDs,
each carrying the file to start from, plus a **Top 10 next** decision list at the top
and a §G recording what was deliberately cut and why. Currently on deck: structured
output via JSON-schema-constrained sampling, an MCP client (so the ~9,650 servers in
the registry become AIOS tools), a reranker for the vault, SQLite-aware backups, a
notification center, and global Ctrl+K search over your own data.
