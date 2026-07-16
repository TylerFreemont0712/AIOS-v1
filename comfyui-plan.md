# ComfyUI × AIOS — Integration Game-Plan

*Written 2026-07-11 after surveying this machine and the MCP ecosystem. Companion to
`Suggestions.md`; graduates to Roadmap when a phase starts.*

---

## 1. What's on this machine (surveyed)

| Thing | Finding |
|---|---|
| ComfyUI | `~/comfyui/ComfyUI`, **v0.25.0**, custom nodes installed (kjnodes, rgthree, frame-interpolation, custom-scripts) + LoRA-Manager config |
| Checkpoints | **None yet** — `models/checkpoints/` and `models/diffusion_models/` are empty placeholders. Nothing can generate until Phase 0. |
| GPU | RTX 3070 Ti Laptop, **8 GB VRAM** |
| VRAM today | **~6.5 GB used by `ornith-9b`** (llama-server: Q5_K_M, 32k ctx, q8 KV cache, `-ngl auto`) |
| LLM management | PyQt6 GUI launcher (`~/ai/llama-launcher/server_launcher.py`) spawns llama-server as a child; presets in `~/.config/ai-server-launcher/` |
| Small models on disk | `Qwen3.5-4B.Q8_0`, `Opus4.7-…Distill.4B-Q8_0`, `gemma-4-E4B Q5` — viable CPU-only tool-callers **already downloaded** |
| ComfyUI API | Native HTTP+WS on `:8188` — `POST /prompt`, `WS /ws` progress, `GET /history/{id}`, `GET /view` (images), **`POST /free`** (unload models / free VRAM), `GET /system_stats` |

**The core conflict is real and confirmed**: 6.5 GB (LLM) + any modern checkpoint (SD1.5 ≈ 3-4 GB,
SDXL ≈ 7-9 GB working set) > 8 GB. They cannot run at once. Everything below is designed
around that.

## 2. VRAM strategy — three options, one recommendation

### Option A (recommended): "Studio mode" — swap the LLM to a tiny CPU model
Exactly the idea you proposed. When generating images, AIOS's LLM needs are small
(tool-call routing, prompt expansion, triage) — a 4B **running CPU-only (`-ngl 0`) uses
zero VRAM** and is fine at those jobs. You already own the weights (`Qwen3.5-4B.Q8_0`);
for snappier tool calls, one download of **Qwen3.5-1.7B Q8 (~1.8 GB)** would be even better.

- AIOS gains two **LLM profiles**: `big` (current ornith-9b command line) and `tiny`
  (`llama-server --model Qwen3.5-4B.Q8_0.gguf -ngl 0 --ctx-size 8192 --port 8080 --alias tiny`).
- A **Studio toggle** (topbar or the future Studio app) stops one profile and starts the
  other via a pidfile-disciplined script (`scripts/llm-profile.sh big|tiny|status`), the
  same pattern as `aios-launch.sh`. Model refs keep working because AIOS's
  `resolveModel()` already falls back to *whatever the provider actually serves*.
- Exiting Studio mode swaps back — and AIOS calls ComfyUI `POST /free` first so the swap
  never double-books VRAM.
- **One decision needed from you**: this replaces the PyQt launcher as the thing that owns
  llama.cpp (keep the GUI for manual/Whisper/MusicGen use — just don't run both managers
  at once). If you'd rather keep the GUI in charge, Studio mode degrades to a notification:
  "switch your launcher to the CPU preset."

### Option B: `llama-swap` proxy (most seamless, one more moving part)
A small proxy that owns port 8080 and loads/unloads llama-server instances **per requested
model name** with idle TTL. AIOS would point model roles at it: agent/chat use `ornith-9b`
(loads big), Studio-mode tasks use `tiny` (big TTLs out → VRAM frees itself). No toggle at
all — the first image job effectively evicts the big model. Worth adopting later if Option
A's manual toggle annoys you.

### Option C: fully manual (works today, zero code)
Stop llama in the GUI launcher → run ComfyUI in its own browser window → restart llama
after. The plan's Phase 1 still helps (status chip shows who holds the GPU).

**ComfyUI-side hygiene regardless of option**: launch with default VRAM mode (it already
loads/unloads per job), and have the AIOS connector call `POST /free {unload_models:true,
free_memory:true}` after each job batch so VRAM returns promptly.

## 3. MCP server — research results

- **Official Comfy MCP / Comfy Cloud MCP** (launched 2026-06-29): 10 generation tools, 30+
  partner providers, *API-key cloud generation, no local GPU involved*. Not a fit for the
  local-first goal — but a fine complement if you ever want cloud models without VRAM math.
- **`artokun/comfyui-mcp`** — the strongest local option: MCP server + **Claude Code
  plugin**, 108 tools / 29 skills (Flux, WAN, Qwen-Image…), authors and runs workflows,
  edits the live graph in natural language, manages models & custom nodes. Local/LAN.
- **`joenorton/comfyui-mcp-server`** — lightweight Python MCP wrapping local workflow
  submission; minimal but simple.

**Where MCP fits vs. AIOS-native**: AIOS's agent doesn't speak MCP — it has its own tool
registry, and ComfyUI's plain HTTP API is simple enough that a native `server/comfy.js`
connector (Phase 1) is *less* machinery than embedding an MCP client. The MCP play is for
**Claude Code**: installing `artokun/comfyui-mcp` gives the Claude sessions that build AIOS
direct ComfyUI control (build workflows, test generations) — recommended as a dev tool,
independent of the AIOS integration.

Sources: [Comfy MCP announcement](https://comfyui-wiki.com/en/news/2026-06-30-comfy-mcp-agent-integration) ·
[Comfy Cloud MCP docs](https://docs.comfy.org/agent-tools/cloud) · [comfy.org/mcp](https://comfy.org/mcp/) ·
[artokun/comfyui-mcp](https://github.com/artokun/comfyui-mcp) ·
[joenorton/comfyui-mcp-server](https://github.com/joenorton/comfyui-mcp-server)

## 4. Build phases

### Phase 0 — models (blocker, ~30 min of downloads)
`models/checkpoints/` is empty. For 8 GB with the LLM swapped out:
- **SD 1.5 family** (~2-4 GB): fastest, fine for icons/concepts; runs even with modest headroom.
- **SDXL-Lightning / Turbo** (~7 GB): much better quality, 4-8 steps so it's quick; needs
  the full GPU → Studio mode required.
- Later: **FLUX schnell GGUF** quantizations fit 8 GB with offload but are slow — optional.
Grab one SD1.5 + one SDXL-Lightning checkpoint to start; LoRA manager is already installed.

### Phase 1 — `server/comfy.js` connector + Studio mode (the core, ~an evening)
- Config `comfy: { url: 'http://127.0.0.1:8188', autoFree: true }` + service probe
  (`GET /system_stats` → chip shows up/down + VRAM free).
- `generate({ prompt, negative, checkpoint, width, height, steps, seed, count })` →
  fills a **workflow template** (API-format JSON for txt2img; templates checked into
  `server/comfy-workflows/`), `POST /prompt`, follows `WS /ws?clientId=` progress events,
  fetches results via `/history` + `/view`, saves copies under `data/comfy/`, then
  `POST /free`.
- `server/gpu.js`: `nvidia-smi --query-gpu=memory.used,memory.total` wrapper → the **VRAM
  guard**: generation requests check headroom first and (Option A) offer/perform the LLM
  profile swap; `scripts/llm-profile.sh` ships in this phase.

### Phase 2 — Studio app (the "different window", ~an evening)
`web/js/apps/comfy.js`: prompt box + preset row (checkpoint / size / steps / batch) →
live progress bar (WS) → output gallery (click = full size, save-to-vault button).
A header link **opens full ComfyUI in a new tab** for node-graph work — AIOS is the
launcher/simple-workflow layer. Dock icon, Home card, palette entry, Settings tab.

### Phase 3 — agent + planner hooks (small)
- Agent tools `comfy_generate` / `comfy_status` (group `apps`), gated on the service being
  up; generation results land in the transcript as image attachments (upload plumbing exists).
- The suggest/triage-style calls automatically use the tiny model while Studio mode is on
  (model roles from `Suggestions.md` #5 make this clean — worth doing first or together).

### Phase 4 — optional extras
- Install `artokun/comfyui-mcp` for Claude Code sessions (dev tooling).
- img2img / upscale / LoRA-pick templates; wildcard prompt expansion via the tiny LLM.
- Discord "render finished" ping through the existing notify plumbing.

## 5. Workflow menu — what your 8 GB / 3070 Ti can actually do
*(added 2026-07-11 after the first live render; ✅ = installed and working today)*

### Installed now
- ✅ **AIOS Anime txt2img** — SDXL-Lightning base, 4 steps (~10 s). The Studio quick menu.
- ✅ **AIOS Anime v2 — Animagine XL 4.0** at its official settings (euler_a · cfg 5 ·
  28 steps, quality tags at the END; ~40 s) — **calibrated live**: the Lightning LoRA on
  Animagine renders characters well but *shreds busy backgrounds*, so quality mode is the
  default and the LoRA is an explicit ⚡ opt-in (Studio speed select / bypassed node in the
  workflow). Hi-res is **pixel-space** (decode → 4x-AnimeSharp → ×1.5 → 0.45-denoise
  repaint) — latent upscales turn to mush under few-step models.
- ✅ **AIOS Upscale 4x (AnimeSharp)** — any render → 4096², seconds.

### Comfortable next additions (each ≤ an evening, all fit 8 GB)
- **Hi-res fix (2-pass)**: 1024 base → latent upscale ×1.5 → low-denoise second pass.
  The single biggest quality jump for landscapes/detail. Pure built-in nodes.
- **img2img / style remix**: photo → anime (or sketch → finished) at denoise 0.5-0.7.
- **Inpainting**: mask + repaint a region (fix hands, swap outfits). Built-in nodes.
- **More anime checkpoints** (pick per taste, all ~6.9 GB SDXL class, Lightning-LoRA
  compatible): **Illustrious XL** / **NoobAI-XL** (modern danbooru powerhouses),
  **Pony Diffusion V6** (needs its score_9 tag ritual; civitai login to download).
- **ControlNet (SDXL)**: pose/lineart-guided generation — control-lora variants are
  ~700 MB each and run fine with Comfy's offload.
- **Face detailer**: the Impact Pack custom node auto-fixes small faces in wide shots.

### The ceiling (works, with patience)
- **AnimateDiff (SD1.5)** — short anime loops/GIFs, ~512², very much within 8 GB. Needs an
  SD1.5 anime checkpoint (~2 GB) + motion module (~1.7 GB) + the AnimateDiff-Evolved node.
- **LTX-Video 2B** — real text-to-video, quantized fits 8 GB; seconds-long clips, minutes
  of compute. Your `comfyui-frame-interpolation` node (RIFE) already smooths the output.
- **WAN 2.1 1.3B t2v** — you already have its uMT5 text encoder on disk (it's sitting in
  `models/loras/` and belongs in `models/text_encoders/`); add the 1.3B GGUF and it runs.
- **FLUX schnell GGUF (Q4)** — best prompt-following available, ~10-20 s/img with offload;
  not anime-native (pair with an anime LoRA).
- Out of reach on 8 GB: SDXL finetune *training*, FLUX dev fp16, WAN 14B, HunyuanVideo.

## 6. Open questions (answer whenever)
1. **Which direction first** — SD1.5 speed or SDXL-Lightning quality? (Decides Phase 0 downloads.)
2. **Option A vs C**: is AIOS allowed to own llama.cpp start/stop (retiring the GUI for the
   text model), or should Studio mode stay advisory?
3. Want the tiny **Qwen3.5-1.7B** download for snappier Studio-mode tool calls, or start
   with the 4B you already have?
