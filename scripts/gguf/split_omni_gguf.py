#!/usr/bin/env python3
"""Split a single-file "omni" GGUF into a text model + an mmproj projector.

Why this exists
---------------
Some GGUF publishers (TurboQuants repacks, a few community "any-to-any" builds)
ship the language model *and* its vision/audio towers inside one .gguf.
llama.cpp does not support that layout: `llama_model_load` creates only the text
tensors and then fails the directory check in `done_getting_tensors`:

    error loading model: done_getting_tensors: wrong number of tensors;
    expected 2131, got 720

Upstream expects the towers in a sibling file with `general.architecture=clip`,
passed via `--mmproj`. This script performs that separation losslessly: tensor
payloads are copied byte-for-byte (no requantisation) and the `<arch>.vision.*`
/ `<arch>.audio.*` metadata is translated to the `clip.*` keys that
tools/mtmd/clip.cpp actually reads.

Usage
-----
    python3 split_omni_gguf.py --src model.gguf                  # writes both files
    python3 split_omni_gguf.py --src model.gguf --dry-run        # show the plan only
    python3 split_omni_gguf.py --src model.gguf --text-only      # skip the mmproj

Then:
    llama-server --model model-text.gguf --mmproj mmproj-model.gguf
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gguf_io import (  # noqa: E402
    KV, GGUFWriter, T_ARRAY, T_BOOL, T_FLOAT32, T_STRING, T_UINT32,
    align_up, read_gguf, type_name,
)

# Tensor namespaces that belong to the multimodal projector, not the text model.
MM_PREFIXES = ("v.", "a.", "mm.")

# Within the projector, which namespace belongs to which modality. `mm.a.*` is
# the audio embedder and `mm.*` (everything else) is the vision embedder.
def modality_of(name: str) -> str:
    if name.startswith("a.") or name.startswith("mm.a."):
        return "audio"
    return "vision"

# clip.cpp hard-requires these; a repack that renamed keys under the model arch
# prefix usually loses them, so we supply defaults.
DEFAULT_IMAGE_SIZE = 224
DEFAULT_NUM_MEL_BINS = 128
# SigLIP normalisation, which every Gemma 3 / Gemma 4 vision tower uses.
DEFAULT_IMAGE_MEAN = [0.5, 0.5, 0.5]
DEFAULT_IMAGE_STD = [0.5, 0.5, 0.5]


def human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024 or unit == "TiB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} TiB"


def is_mm(name: str) -> bool:
    return name.startswith(MM_PREFIXES)


# Tensors clip.cpp fetches WITHOUT the `required=false` flag, i.e. loading dies
# if they are missing. Keyed by the projector type we would declare.
REQUIRED_TENSORS: dict[str, tuple[str, ...]] = {
    "gemma4v":  ("mm.input_projection.weight",),
    "gemma4uv": ("mm.input_projection.weight",
                 "v.patch_norm.1.weight", "v.patch_norm.2.weight", "v.patch_norm.3.weight"),
    "gemma4a":  ("a.input_projection.weight", "a.conv1d.0.weight", "a.conv1d.1.weight"),
    "gemma4ua": ("mm.a.input_projection.weight",),
}


def missing_required(projector: str, names: set[str]) -> list[str]:
    return [t for t in REQUIRED_TENSORS.get(projector, ()) if t not in names]


def pick_projector_types(names: list[str]) -> tuple[str | None, str | None]:
    """Choose clip projector types from the tensor layout.

    A tower with its own transformer blocks (`v.blk.*` / `a.blk.*`) is the
    standalone variant; one with only embeddings and norms reuses the language
    model's blocks and is the "unified" variant.
    """
    has_v = any(n.startswith("v.") for n in names)
    has_a = any(n.startswith("a.") for n in names)
    v_blocks = any(n.startswith("v.blk.") for n in names)
    a_blocks = any(n.startswith("a.blk.") for n in names)
    vision = ("gemma4v" if v_blocks else "gemma4uv") if has_v else None
    audio = ("gemma4a" if a_blocks else "gemma4ua") if has_a else None
    return vision, audio


def build_text_kv(src, arch: str) -> list[KV]:
    """Everything except the projector's hyperparameters."""
    drop_prefixes = (f"{arch}.vision.", f"{arch}.audio.", "clip.")
    return [e for e in src.kv if not e.key.startswith(drop_prefixes)]


def build_mmproj_kv(src, arch: str, names: list[str], args) -> list[KV]:
    vision_proj, audio_proj = pick_projector_types(names)
    if not vision_proj and not audio_proj:
        raise SystemExit("no v.*/a.*/mm.* tensors found — nothing to put in an mmproj")

    kv: list[KV] = [
        KV("general.architecture", T_STRING, "clip"),
        KV("general.type", T_STRING, "mmproj"),
    ]
    name = src.get("general.name")
    if name:
        kv.append(KV("general.name", T_STRING, str(name)))
    for key in ("general.file_type", "general.quantization_version"):
        entry = src.kv_index.get(key)
        if entry is not None:
            kv.append(KV(entry.key, entry.type, entry.value, entry.elem_type))

    n_embd_text = src.get(f"{arch}.embedding_length")
    if n_embd_text is None:
        raise SystemExit(f"missing {arch}.embedding_length — cannot derive clip projection_dim")

    # Translate <arch>.vision.* / <arch>.audio.* verbatim into clip.*, skipping
    # any tower that is not going into this file.
    translated: set[str] = set()
    active = [m for m, on in (("vision", vision_proj), ("audio", audio_proj)) if on]
    for entry in src.kv:
        for modality in active:
            prefix = f"{arch}.{modality}."
            if entry.key.startswith(prefix):
                new_key = f"clip.{modality}.{entry.key[len(prefix):]}"
                kv.append(KV(new_key, entry.type, entry.value, entry.elem_type))
                translated.add(new_key)

    def ensure(key: str, vtype: int, value, elem_type=None) -> None:
        if key not in translated:
            kv.append(KV(key, vtype, value, elem_type))
            translated.add(key)

    if vision_proj:
        kv.append(KV("clip.has_vision_encoder", T_BOOL, True))
        ensure("clip.vision.projector_type", T_STRING, vision_proj)
        ensure("clip.vision.projection_dim", T_UINT32, int(n_embd_text))
        ensure("clip.vision.image_size", T_UINT32, int(args.image_size))
        ensure("clip.vision.image_mean", T_ARRAY, list(args.image_mean), T_FLOAT32)
        ensure("clip.vision.image_std", T_ARRAY, list(args.image_std), T_FLOAT32)
    if audio_proj:
        kv.append(KV("clip.has_audio_encoder", T_BOOL, True))
        ensure("clip.audio.projector_type", T_STRING, audio_proj)
        ensure("clip.audio.projection_dim", T_UINT32, int(n_embd_text))
        ensure("clip.audio.num_mel_bins", T_UINT32, int(args.num_mel_bins))

    # clip.cpp reads block_count/head_count/feed_forward_length unconditionally
    # for whichever encoders are present; zero is a legal "unified" value.
    for modality, present in (("vision", vision_proj), ("audio", audio_proj)):
        if not present:
            continue
        for suffix in ("block_count", "feed_forward_length", "embedding_length",
                       "attention.head_count"):
            ensure(f"clip.{modality}.{suffix}", T_UINT32, 0)

    return kv


def report(label: str, kv: list[KV], tensors: list, total: int) -> None:
    print(f"\n=== {label} ===")
    print(f"  tensors: {len(tensors)}   payload: {human(total)}   kv: {len(kv)}")
    interesting = [e for e in kv if not e.key.startswith("tokenizer.ggml.token")]
    for entry in interesting:
        if entry.key.startswith(("clip.", "general.architecture", "general.type")):
            print(f"    {entry.describe()}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="the combined .gguf to split")
    ap.add_argument("--out-dir", default=None, help="defaults to the source directory")
    ap.add_argument("--text-out", default=None, help="text model filename")
    ap.add_argument("--mmproj-out", default=None, help="mmproj filename")
    ap.add_argument("--text-only", action="store_true", help="write only the text model")
    ap.add_argument("--mmproj-only", action="store_true", help="write only the mmproj")
    ap.add_argument("--dry-run", action="store_true", help="describe the split without writing")
    ap.add_argument("--force", action="store_true", help="overwrite existing outputs")
    ap.add_argument(
        "--modalities", default="auto", choices=("auto", "both", "vision", "audio"),
        help="which towers to put in the mmproj. 'auto' (default) keeps every tower "
             "whose required tensors are actually present, so a repack with an "
             "incomplete audio encoder still yields a working vision mmproj.",
    )
    ap.add_argument("--image-size", type=int, default=DEFAULT_IMAGE_SIZE)
    ap.add_argument("--num-mel-bins", type=int, default=DEFAULT_NUM_MEL_BINS)
    ap.add_argument("--image-mean", type=float, nargs=3, default=DEFAULT_IMAGE_MEAN)
    ap.add_argument("--image-std", type=float, nargs=3, default=DEFAULT_IMAGE_STD)
    args = ap.parse_args()

    src = read_gguf(args.src)
    arch = src.arch
    if not arch:
        return err("source has no general.architecture")
    if arch == "clip":
        return err("source is already an mmproj (general.architecture=clip)")

    all_mm = [t for t in src.tensors if is_mm(t.name)]
    text_tensors = [t for t in src.tensors if not is_mm(t.name)]
    if not all_mm:
        return err(
            f"{args.src} contains no v.*/a.*/mm.* tensors — it is already a plain "
            f"text model and needs no splitting."
        )

    print(f"source: {args.src}")
    print(f"  arch={arch}  gguf v{src.version}  alignment={src.alignment}")
    print(f"  {len(src.tensors)} tensors ({len(text_tensors)} text, {len(all_mm)} multimodal)")

    all_names = {t.name for t in all_mm}
    vision_proj, audio_proj = pick_projector_types(list(all_names))
    print(f"  detected projector: vision={vision_proj or '-'}  audio={audio_proj or '-'}")

    # Decide which towers survive into the mmproj.
    keep = {"vision": bool(vision_proj), "audio": bool(audio_proj)}
    if args.modalities in ("vision", "audio"):
        for modality in keep:
            keep[modality] = keep[modality] and modality == args.modalities
    for modality, projector in (("vision", vision_proj), ("audio", audio_proj)):
        if not keep[modality] or not projector:
            continue
        gaps = missing_required(projector, all_names)
        if not gaps:
            continue
        detail = ", ".join(gaps)
        if args.modalities == "auto":
            keep[modality] = False
            print(f"  ! dropping the {modality} tower: {projector} requires {detail}, "
                  f"which this file does not contain")
        else:
            print(f"  ! WARNING: {projector} requires {detail}, which is missing — "
                  f"clip_init will fail to load the {modality} tower")
    if not any(keep.values()):
        return err("no complete projector tower found — nothing usable to write as an mmproj")

    mm_tensors = [t for t in all_mm if keep[modality_of(t.name)]]
    if not keep["vision"]:
        vision_proj = None
    if not keep["audio"]:
        audio_proj = None
    kept = [m for m, on in keep.items() if on]
    print(f"  mmproj will contain: {', '.join(kept)} ({len(mm_tensors)} tensors)")
    kinds = sorted({type_name(t.ggml_type) for t in src.tensors})
    print(f"  tensor types: {', '.join(kinds)}")

    out_dir = args.out_dir or os.path.dirname(os.path.abspath(args.src))
    stem = os.path.basename(args.src)
    if stem.endswith(".gguf"):
        stem = stem[:-5]
    text_path = os.path.join(out_dir, args.text_out or f"{stem}-text.gguf")
    mmproj_path = os.path.join(out_dir, args.mmproj_out or f"mmproj-{stem}.gguf")

    writer = GGUFWriter(src.alignment)
    src_offsets = {t.name: t.offset for t in src.tensors}

    jobs = []
    if not args.mmproj_only:
        planned = writer.plan(text_tensors)
        kv = build_text_kv(src, arch)
        jobs.append(("text model", text_path, kv, planned))
    if not args.text_only:
        planned = writer.plan(mm_tensors)
        kv = build_mmproj_kv(src, arch, [t.name for t in mm_tensors], args)
        jobs.append(("mmproj", mmproj_path, kv, planned))

    for label, path, kv, planned in jobs:
        total = sum(t.nbytes for t in planned)
        report(f"{label} → {os.path.basename(path)}", kv, planned, total)

    if args.dry_run:
        print("\n(dry run — nothing written)")
        return 0

    free = shutil.disk_usage(out_dir).free
    need = sum(sum(t.nbytes for t in planned) for _, _, _, planned in jobs)
    need = align_up(need, 1 << 20) + (16 << 20)
    if free < need:
        return err(f"need ~{human(need)} free in {out_dir} but only {human(free)} available")

    for label, path, kv, planned in jobs:
        if os.path.exists(path) and not args.force:
            return err(f"{path} already exists (use --force to overwrite)")

    for label, path, kv, planned in jobs:
        total = sum(t.nbytes for t in planned)
        print(f"\nwriting {path} ({human(total)}) …")
        tmp = path + ".part"
        state = {"pct": -1}

        def progress(done: int, tot: int, state=state) -> None:
            pct = int(done * 100 / tot) if tot else 100
            if pct != state["pct"] and pct % 5 == 0:
                state["pct"] = pct
                print(f"\r  {pct:3d}%  {human(done)}/{human(tot)}", end="", flush=True)

        try:
            writer.write(tmp, kv, planned, args.src, src.data_start, src_offsets, progress)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        os.replace(tmp, path)
        print(f"\r  100%  {human(total)} — done" + " " * 20)

    print("\nVerifying outputs re-parse cleanly …")
    for label, path, _, planned in jobs:
        check = read_gguf(path)
        if len(check.tensors) != len(planned):
            return err(f"{path}: wrote {len(planned)} tensors but re-read {len(check.tensors)}")
        print(f"  ok  {os.path.basename(path)}  arch={check.arch}  tensors={len(check.tensors)}")

    if len(jobs) == 2:
        print("\nRun it with:")
        print(f"  llama-server --model {text_path} \\\n               --mmproj {mmproj_path}")
    return 0


def err(msg: str) -> int:
    print(f"error: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
