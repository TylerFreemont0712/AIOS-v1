# ComfyUI × AIOS — current state

*Originally a pre-implementation game-plan (2026-07-11). Phases 0-3 shipped, so it was rewritten
on **2026-07-27** as a state-of-the-integration doc — a plan that still says "nothing can
generate yet" months after Studio started rendering is worse than no plan. Forward-looking items
live in `Roadmap.md`; this file records **what exists, what was decided, and what the hardware
can actually do**, because that's the part that isn't obvious from the code.*

---

## 1. What shipped

The Studio app is the ComfyUI cockpit. `server/comfy.js` (≈550 lines) owns the connector;
`web/js/apps/studio.js` is the UI.

| Phase | Status |
|---|---|
| 0 — models | ✅ Checkpoints downloaded (see §2) |
| 1 — `server/comfy.js` connector + VRAM guard | ✅ `POST /prompt`, WS progress, `/history` + `/view`, copies saved to `data/comfy/`, `POST /free` after jobs |
| 2 — Studio app | ✅ txt2img / img2img / 4× upscale, sampling plans, hi-res, LLM prompt generator, gallery + full-size viewer, ↗ link to raw ComfyUI |
| 3 — agent + lifecycle hooks | ✅ `comfy_generate`/`comfy_status` tools; AIOS starts/stops ComfyUI itself; renders land in transcripts |
| 4 — extras | ◻️ Partly — see §5 |

**18 renders produced** through the pipeline so far (`data/comfy/jobs.json`).

## 2. Inventory — ✅ verified on this machine 2026-07-27

| Thing | Finding |
|---|---|
| ComfyUI | `/mnt/projects/comfyui/ComfyUI` (moved off the home partition 2026-07-21), started by AIOS with `--enable-manager` |
| GPU | RTX 3070 Ti Laptop, **8 GB VRAM** |
| Checkpoints | **animagine-xl-4.0**, **sdxl_lightning_4step** |
| Diffusion models | **dasiwaAnima_obsidianArchivesV2**, **DasiwaLTX23_goldenlace V3** |
| LoRAs | 11, incl. `sdxl_lightning_4step_lora` and **`ltx-2.3-22b-distilled-lora-384`** |
| Upscalers | `4x-AnimeSharp.pth` |
| Text encoders | 4, incl. `ltx-2.3_text_projection_bf16`, `qwen306BBaseAnima`, a gemma-3-12b encoder |
| ControlNet | **empty** — the one obvious missing capability class |
| Custom nodes | kjnodes, rgthree, custom-scripts, frame-interpolation (RIFE), lora-manager, **ComfyUI-LTXVideo**, **VideoHelperSuite**, DaSiWa-Nodes |

**The core conflict, still true:** a 6.5 GB LLM + an SDXL working set (7-9 GB) does not fit in
8 GB. Everything below is designed around that.

## 3. Decisions made (the open questions, answered)

- **Who owns llama.cpp?** AIOS does (approved 2026-07-11). The PyQt launcher is kept only for
  Whisper/MusicGen and is now legacy — `Roadmap.md` **A1** tracks retiring the AIOS-side plumbing.
- **VRAM strategy — evolved past the original Option A.** The plan proposed swapping the LLM to a
  tiny CPU-only profile during generation. Reality was better served by **stopping llama-server
  outright** (`llmctl.suspendForGpu()` / `resumeAfterGpu()`): a llama-server process holds its
  CUDA context and cuBLAS workspace even at `-ngl 0`, a few hundred MB an SDXL checkpoint would
  rather have — and on an 8 GB card that margin decides whether a generation fits. What was
  serving is remembered in a file (not a module variable) so an AIOS restart mid-session still
  restores the right model.
- **`llama-swap` proxy (old Option B)** — not adopted. `comfy.autoSwap` + `autoFree` cover it
  without a second process owning port 8080.
- **A tiny model for Studio-mode tool calls** — yes, and it's `Qwen3.5-2B-UD-Q8_K_XL`, GPU-resident
  (CPU-only threw away the speed that makes a small model worth having).
- **MCP for ComfyUI** — the 2026-07 conclusion was that a native connector is less machinery than
  an MCP client, *for ComfyUI specifically*. That was right then. It is now the wrong conclusion
  in general: see `Roadmap.md` **D2** — the adapter is written once and every later integration
  becomes configuration. Installing `artokun/comfyui-mcp` for **Claude Code** sessions remains a
  good dev-tooling idea, independent of AIOS.

## 4. What the 8 GB card can actually do
*(✅ = installed and working today)*

**Working now**
- ✅ **Anime txt2img** — SDXL-Lightning base, 4 steps (~10 s). The Studio quick menu.
- ✅ **Animagine XL 4.0** at official settings (euler_a · cfg 5 · 28 steps, quality tags at the
  END; ~40 s). **Calibrated live**: the Lightning LoRA renders characters well but *shreds busy
  backgrounds*, so quality mode is the default and the LoRA is an explicit ⚡ opt-in. Hi-res is
  **pixel-space** (decode → 4x-AnimeSharp → ×1.5 → 0.45-denoise repaint) — latent upscales turn
  to mush under few-step models.
- ✅ **Upscale 4×** (AnimeSharp) — any render → 4096², seconds.
- ✅ **img2img / style remix** at denoise 0.5-0.7.

**Installed but not wired into Studio** — the gap worth closing first
- **LTX-Video 2.3** (distilled 22B LoRA + text projection + the LTXVideo and VideoHelperSuite
  nodes are all on disk). `server/comfy.js` exposes only `txt2imgWorkflow`, `img2imgWorkflow` and
  `upscaleWorkflow`, so none of this is reachable from AIOS — you have to open raw ComfyUI.
  Tracked as `Roadmap.md` **D17**. RIFE (frame-interpolation) is already there to smooth output.

**Comfortable next additions** (each ≤ an evening, all fit 8 GB)
- **ControlNet (SDXL)** — pose/lineart-guided generation. `models/controlnet/` is empty;
  control-lora variants are ~700 MB each and run fine with Comfy's offload.
- **Inpainting** — mask + repaint a region (fix hands, swap outfits). Built-in nodes.
- **Face detailer** — the Impact Pack node auto-fixes small faces in wide shots.
- **More anime checkpoints** — Illustrious XL / NoobAI-XL (modern danbooru powerhouses), Pony
  Diffusion V6 (needs its score_9 tag ritual).

**The ceiling** — works with patience: AnimateDiff (SD1.5) short loops; FLUX schnell GGUF Q4
(best prompt-following, ~10-20 s/img with offload, not anime-native — pair with an anime LoRA).
**Out of reach on 8 GB:** SDXL finetune *training*, FLUX dev fp16, WAN 14B, HunyuanVideo.

## 5. Remaining work

Everything forward-looking now lives in `Roadmap.md` so there is one backlog, not two:

- **D17** — video + ControlNet + inpaint workflows in Studio (the LTX models are already here).
- **A1** — retire the PyQt launcher plumbing.
- **C1** — "render finished" through the notification center (replaces the old Phase-4 Discord ping).
- **C7** — Studio on a phone screen (it overflows today).
