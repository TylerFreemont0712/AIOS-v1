#!/usr/bin/env python3
"""
AIOS voice worker — the one process that owns the speech models.

Why a long-lived worker instead of a subprocess per request: loading Kokoro costs
~0.9s and faster-whisper ~0.6s, plus the Silero VAD on the first transcription.
Paying that on every utterance would put a second and a half in front of every
sentence, which is exactly the latency that makes a voice assistant feel dead.
The models are loaded lazily (first stt / first tts) and can be dropped again with
`unload`, so a box that never speaks never pays for the memory either.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
Requests carry an `id` which is echoed back; server/voice.js matches them up.

    {"id":"1","op":"ping"}
    {"id":"2","op":"stt","path":"/tmp/a.webm","language":"ja"}
    {"id":"3","op":"tts","text":"Hello.","voice":"af_heart","out":"/tmp/b.wav"}
    {"id":"4","op":"voices"}
    {"id":"5","op":"load","stt":true,"tts":true}
    {"id":"6","op":"unload"}

Audio never travels through this pipe. Node writes the recording to a temp file and
passes the path; TTS writes a WAV where Node asked and returns the path. Base64 on
stdin would double every payload and, worse, make the line protocol dependent on
buffer sizes we don't control.

STDOUT DISCIPLINE: onnxruntime, ctranslate2 and their dependencies all print to
stdout when they feel like it, and a single stray line corrupts the protocol. fd 1 is
therefore duplicated to a private handle at import time and then pointed at stderr,
so anything that prints normally lands in the AIOS log and only this module's
`reply()` can reach the real stdout.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import sys
import time
import wave

# --- stdout discipline (must happen before any noisy import) ---
_PROTO = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)

import numpy as np  # noqa: E402  (after the fd dance on purpose)


def reply(obj: dict) -> None:
    _PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTO.flush()


def log(msg: str) -> None:
    print(f"[voice-worker] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- speech to text

class STT:
    """
    Two models, deliberately.

    `model` is the accurate one and produces the text that is acted on. `fast` is a
    smaller one used ONLY for the live partials shown while you are still speaking —
    those are re-decoded roughly once a second over the whole utterance-so-far, and
    doing that with the accurate model would cost more per pass than the interval
    between passes. Partials are feedback, not a result: they are never sent to the
    language model and never reach the ledger.
    """

    def __init__(self, args):
        self.args = args
        self.model = None
        self.fast = None

    def load(self):
        if self.model is not None:
            return
        from faster_whisper import WhisperModel
        t0 = time.time()
        self.model = WhisperModel(
            self.args.stt_model,
            device=self.args.stt_device,
            compute_type=self.args.stt_compute,
            cpu_threads=self.args.stt_threads,
        )
        log(f"stt loaded in {time.time() - t0:.2f}s ({self.args.stt_model}, "
            f"{self.args.stt_device}/{self.args.stt_compute})")

    def load_fast(self):
        """The partials model. Falls back to the main one when none is configured."""
        if self.fast is not None:
            return self.fast
        if not self.args.stt_partial_model:
            self.load()
            self.fast = self.model
            return self.fast
        from faster_whisper import WhisperModel
        t0 = time.time()
        try:
            self.fast = WhisperModel(
                self.args.stt_partial_model,
                device=self.args.stt_device,
                compute_type=self.args.stt_compute,
                # Partials run alongside everything else; leaving them a couple of
                # cores keeps them from starving the final pass they precede.
                cpu_threads=max(2, self.args.stt_threads // 2),
            )
            log(f"stt(partial) loaded in {time.time() - t0:.2f}s ({self.args.stt_partial_model})")
        except Exception as e:
            log(f"partial model unavailable ({e}); using the main model for partials")
            self.load()
            self.fast = self.model
        return self.fast

    def transcribe(self, req: dict) -> dict:
        fast = bool(req.get("fast"))
        model = self.load_fast() if fast else (self.load() or self.model)
        path = req.get("path") or ""
        if not os.path.isfile(path):
            raise FileNotFoundError(f"audio file not found: {path}")

        # language: '' / None means auto-detect. Auto is shaky on very short clips,
        # which is why the setting exists at all.
        lang = (req.get("language") or "").strip() or None
        # initial_prompt biases the decoder towards words it would otherwise mangle
        # (product names, "AIOS", the user's categories). Kept short on purpose:
        # whisper will happily start *quoting* a long prompt back at you.
        prompt = (req.get("prompt") or "").strip()[:400] or None

        t0 = time.time()
        segments, info = model.transcribe(
            path,
            language=lang,
            task="transcribe",
            # A partial is redrawn a second later anyway, so it buys nothing from a
            # wider beam; the accurate pass at the end is where that matters.
            beam_size=1 if fast else int(req.get("beamSize") or self.args.stt_beam),
            # Silero VAD strips the silence around the utterance. Without it whisper
            # reliably hallucinates filler ("Thank you for watching.") into a quiet
            # clip, which in a hands-free loop then gets *sent* as a message.
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            # Each utterance is independent; carrying the previous text forward is
            # what makes whisper loop the same phrase forever when it mishears once.
            condition_on_previous_text=False,
            initial_prompt=prompt,
        )
        parts, segs = [], []
        for s in segments:  # generator: transcription actually happens here
            parts.append(s.text)
            segs.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()})
        text = "".join(parts).strip()
        return {
            "text": text,
            "partial": fast,
            "language": info.language,
            "languageProb": round(float(info.language_probability or 0), 3),
            "duration": round(float(info.duration or 0), 2),
            "segments": segs,
            "ms": int((time.time() - t0) * 1000),
        }

    def unload(self):
        self.model = None
        self.fast = None


# ------------------------------------------------------------- live streaming ASR

class Stream:
    """
    A streaming transducer, for the words that appear WHILE you are still talking.

    Whisper cannot do this and it is not a tuning problem: it is a sequence-to-sequence
    model over a fixed 30-second window, so it decodes the padding as well as the
    speech. Measured on this box, `small` on CPU: 0.83s of audio costs 1786ms, 9.71s
    costs 2163ms — 11.7x the audio for 1.21x the time. Short dictation is its worst
    case, and re-running it every second over the whole utterance-so-far (which is what
    the old partials did) is quadratic work for a result that keeps changing.

    A Zipformer transducer is the other shape of ASR: it consumes audio in small chunks,
    carries its own state, and emits tokens as it goes. Measured here at RTF ~0.065 on
    four CPU threads — a 100ms chunk costs about 7ms, so this can run continuously
    without competing with anything.

    It is DELIBERATELY not the final answer. On the same clips it produced "THREE
    THOUSAND JANET LAWSON" for "three thousand yen at Lawson" and 気に for 今日は, and
    it emits no punctuation and upper-case English. It is the live feedback and the
    endpoint detector; `STT.transcribe` still produces the text that is acted on. That
    split is the whole design: feel from this, accuracy from whisper.
    """

    # A zipformer decodes in fixed chunks, so the samples left over in the final
    # partial chunk are never formed into one and the last word or two is simply
    # never emitted. Measured on this box: "...AT LAWSON ON LUN" where the sentence
    # was "...at Lawson on lunch today". Half a second of silence flushes them.
    TAIL_PAD_SEC = 0.5

    def __init__(self, args):
        self.args = args
        self.rec = None
        self.streams = {}          # sid -> {"s": OnlineStream, "done": [...], "rate": int}

    def load(self):
        if self.rec is not None:
            return self.rec
        import sherpa_onnx
        d = self.args.stream_model
        if not d or not os.path.isdir(d):
            raise RuntimeError(f"no streaming model at {d!r}")
        enc, dec, joi, tok = _stream_parts(d)

        # Contextual biasing needs a decoder that has beams to score against, so
        # hotwords are only available under modified_beam_search. Measured here:
        # the same 32 clips go 22.3% -> 20.9% WER with the ledger's merchants as
        # hotwords, "FAMILY MARCH" becomes "FAMILY MART", and the first word lands
        # 130ms sooner. It costs RTF 0.086 -> 0.111, which on a budget of 200ms a
        # chunk is not a number anyone can feel.
        method = self.args.stream_decoding or "greedy_search"
        extra = {}
        if method == "modified_beam_search":
            vocab = _bpe_vocab(d)
            extra = dict(
                max_active_paths=max(1, self.args.stream_beam),
                hotwords_score=float(self.args.stream_hotwords_score),
                # Without the BPE vocabulary sherpa can only tokenize hotwords as
                # whole CJK characters, which silently drops every Latin one.
                modeling_unit="cjkchar+bpe" if vocab else "cjkchar",
                bpe_vocab=vocab,
            )

        t0 = time.time()
        self.rec = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=tok, encoder=enc, decoder=dec, joiner=joi,
            num_threads=max(1, self.args.stream_threads),
            sample_rate=16000, feature_dim=80,
            enable_endpoint_detection=True,
            # rule1 fires on a long silence with nothing decoded (you never spoke);
            # rule2 on trailing silence AFTER something was decoded — the one that
            # ends a normal sentence; rule3 caps a monologue.
            rule1_min_trailing_silence=self.args.stream_rule1,
            rule2_min_trailing_silence=self.args.stream_rule2,
            rule3_min_utterance_length=self.args.stream_rule3,
            decoding_method=method,
            provider=self.args.stream_provider,
            **extra,
        )
        log(f"stream loaded in {time.time() - t0:.2f}s ({os.path.basename(d)}, "
            f"{self.args.stream_provider}/{self.args.stream_threads}t, {method})")
        return self.rec

    def _open(self, rec, hotwords: str):
        """
        One utterance's decode state.

        `done` is the point of this dict. The endpointer fires on trailing silence,
        which in normal speech happens in the MIDDLE of a turn — a thinking pause is
        exactly the case the recorder's silence window is tuned to survive. Resetting
        the recogniser there is right (the next sentence must not inherit the last
        one's state) but the text it decoded is not disposable: without keeping it,
        the live line on screen wiped "I SPENT 3200 YEN AT LAWSON ON LUNCH TODAY" and
        replaced it with whatever came after the pause.
        """
        s = None
        if hotwords:
            # Hotwords are rejected outright by a recogniser built without a
            # beam-search decoder. Live text is feedback; it must never be the thing
            # that fails.
            try:
                s = rec.create_stream(hotwords)
            except Exception as e:
                log(f"hotwords not applied ({e})")
        return {"s": s if s is not None else rec.create_stream(), "done": [], "rate": 16000}

    def start(self, req: dict) -> dict:
        rec = self.load()
        sid = str(req.get("stream") or "")
        if not sid:
            raise ValueError("stream id required")
        # Restarting an id drops the old state rather than resuming it: a new
        # utterance must not inherit half of the previous one.
        self.streams[sid] = self._open(rec, str(req.get("hotwords") or ""))
        return {"stream": sid, "hotwords": bool(req.get("hotwords"))}

    def feed(self, req: dict) -> dict:
        """One chunk of mono int16, base64. Returns the hypothesis so far."""
        rec = self.load()
        sid = str(req.get("stream") or "")
        st = self.streams.get(sid)
        if st is None:
            st = self._open(rec, str(req.get("hotwords") or ""))
            self.streams[sid] = st
        # The browser sends whatever rate its AudioContext runs at and sherpa
        # resamples properly in C++. Doing it in JS with a box filter cost 3.2 points
        # of WER, and a hand-rolled resampler is not a thing worth owning.
        rate = int(req.get("rate") or 16000)
        if rate < 8000 or rate > 192000:
            raise ValueError(f"implausible sample rate {rate}")
        st["rate"] = rate
        s = st["s"]
        raw = base64.b64decode(req.get("pcm") or "")
        if raw:
            pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            s.accept_waveform(rate, pcm)
        while rec.is_ready(s):
            rec.decode_stream(s)
        endpoint = rec.is_endpoint(s)
        text = rec.get_result(s)
        if endpoint:
            # Commit BEFORE the reset, so the sentence that just ended survives it.
            if text.strip():
                st["done"].append(text.strip())
            rec.reset(s)
            text = ""
        return {"stream": sid, "text": _join(st["done"], text),
                "endpoint": bool(endpoint), "segments": len(st["done"])}

    def end(self, req: dict) -> dict:
        """Flush the tail and let the stream go."""
        sid = str(req.get("stream") or "")
        st = self.streams.pop(sid, None)
        if st is None or self.rec is None:
            return {"stream": sid, "text": ""}
        rec, s = self.rec, st["s"]
        rate = st.get("rate") or 16000
        try:
            s.accept_waveform(rate, np.zeros(int(self.TAIL_PAD_SEC * rate), dtype=np.float32))
        except Exception as e:      # a stream already finished is not worth an error
            log(f"tail flush skipped: {e}")
        s.input_finished()
        while rec.is_ready(s):
            rec.decode_stream(s)
        return {"stream": sid, "text": _join(st["done"], rec.get_result(s))}

    def unload(self):
        self.streams.clear()
        self.rec = None


def _join(done: list, current: str) -> str:
    """
    Committed segments plus the one being decoded.

    Japanese runs its sentences together, so a space between two CJK characters is
    not a separator, it is a typo. Same rule the sentence splitter uses next door.
    """
    parts = [p for p in ([*done, (current or "").strip()]) if p]
    out = ""
    for p in parts:
        if out and not (_is_cjk(out[-1]) and _is_cjk(p[0])):
            out += " "
        out += p
    return out


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return 0x3040 <= o <= 0x30ff or 0x3400 <= o <= 0x9fff or 0xff00 <= o <= 0xff9f


def _bpe_vocab(d: str) -> str:
    """
    The BPE vocabulary sherpa needs to turn a hotword into tokens, derived once.

    The model ships `bpe.model` (a sentencepiece protobuf) and sherpa wants
    `bpe.vocab` (piece + score per line). The official recipe is to load the former
    with the `sentencepiece` package — a 1.3MB wheel, a C++ build and a new
    dependency in the voice venv, to read two fields out of a file. The protobuf
    wire format is self-describing enough to do it directly: ModelProto has repeated
    SentencePiece pieces = 1, each with string piece = 1 and float score = 2.

    Derived beside the model because that is what it belongs to, and cached: it is
    16,000 lines and identical on every run. Returning "" is a supported outcome —
    the caller falls back to CJK-only hotwords.
    """
    model, vocab = os.path.join(d, "bpe.model"), os.path.join(d, "bpe.vocab")
    if os.path.exists(vocab):
        return vocab
    if not os.path.exists(model):
        return ""
    try:
        pieces = _sp_pieces(open(model, "rb").read())
        if not pieces:
            return ""
        tmp = vocab + f".{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for piece, score in pieces:
                f.write(f"{piece} {score}\n")
        os.replace(tmp, vocab)      # atomic, so a second worker cannot read a half file
        log(f"derived {os.path.basename(vocab)} ({len(pieces)} pieces)")
        return vocab
    except Exception as e:
        log(f"could not derive bpe.vocab ({e}); hotwords limited to CJK")
        return ""


def _sp_pieces(buf: bytes):
    """Read (piece, score) out of a sentencepiece model without sentencepiece."""
    def fields(b):
        i = 0
        while i < len(b):
            key = 0
            shift = 0
            while True:                                   # varint
                x = b[i]; i += 1
                key |= (x & 0x7F) << shift
                if not x & 0x80:
                    break
                shift += 7
            fn, wire = key >> 3, key & 7
            if wire == 2:                                 # length-delimited
                n = 0; shift = 0
                while True:
                    x = b[i]; i += 1
                    n |= (x & 0x7F) << shift
                    if not x & 0x80:
                        break
                    shift += 7
                yield fn, b[i:i + n]; i += n
            elif wire == 0:                               # varint
                while b[i] & 0x80:
                    i += 1
                i += 1
                yield fn, None
            elif wire == 5:                               # 32-bit float
                yield fn, struct.unpack("<f", b[i:i + 4])[0]; i += 4
            elif wire == 1:                               # 64-bit
                i += 8; yield fn, None
            else:
                raise ValueError(f"protobuf wire type {wire}")

    out = []
    for fn, val in fields(buf):
        if fn != 1 or not isinstance(val, (bytes, bytearray)):
            continue
        piece, score = None, 0.0
        for f2, v2 in fields(val):
            if f2 == 1 and isinstance(v2, (bytes, bytearray)):
                piece = v2.decode("utf-8")
            elif f2 == 2 and isinstance(v2, float):
                score = v2
        if piece:
            out.append((piece, score))
    return out


def _stream_parts(d: str):
    """
    Resolve a sherpa-onnx model directory to its four files.

    Named by training epoch and averaging (encoder-epoch-75-avg-11-chunk-16-left-128),
    which differs per release, so they are discovered rather than configured — and the
    int8 encoder is preferred where both exist, because it is a third of the size for
    no measurable accuracy cost on this task.
    """
    names = os.listdir(d)
    def pick(prefix):
        cands = [n for n in names if n.startswith(prefix) and n.endswith(".onnx")]
        if not cands:
            raise RuntimeError(f"no {prefix}*.onnx in {d}")
        cands.sort(key=lambda n: (".int8." not in n, len(n)))
        return os.path.join(d, cands[0])
    tok = os.path.join(d, "tokens.txt")
    if not os.path.exists(tok):
        raise RuntimeError(f"no tokens.txt in {d}")
    return pick("encoder-"), pick("decoder-"), pick("joiner-"), tok


# ---------------------------------------------------------------- text to speech

class TTS:
    """
    Kokoro, plus the grapheme→phoneme front end each language actually needs.

    espeak-ng handles the European languages fine, but its Japanese is unusable: it
    does not read kanji, it reads *about* them. "今月の食費" comes back phonemized as
    "Chinese letter, Chinese letter, Chinese letter", which synthesizes to 17 seconds
    of gibberish for a 20-character sentence. misaki — the G2P Kokoro was trained
    against — turns the same text into real kana phonemes, which are then fed to the
    model directly with is_phonemes=True. Same story for Mandarin.

    misaki is optional: without it, ja/zh fall back to espeak and say so, rather than
    failing. Every other language goes straight through espeak as before.
    """

    def __init__(self, args):
        self.args = args
        self.kokoro = None
        self._voices = None
        self._g2p = {}          # lang family -> callable(text) -> phonemes, or None

    def load(self):
        if self.kokoro is not None:
            return
        t0 = time.time()
        # espeak-ng is the grapheme→phoneme front end. espeakng-loader ships the
        # compiled library and its data as a wheel, so this works without an
        # apt-installed espeak — pointing phonemizer at it is the whole setup.
        try:
            import espeakng_loader
            from phonemizer.backend.espeak.wrapper import EspeakWrapper
            EspeakWrapper.set_library(espeakng_loader.get_library_path())
            EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        except Exception as e:  # a system espeak may still satisfy phonemizer
            log(f"espeakng-loader unavailable ({e}); falling back to system espeak")

        from kokoro_onnx import Kokoro
        self.kokoro = Kokoro(self.args.tts_model, self.args.tts_voices)
        self._voices = sorted(self.kokoro.get_voices())
        log(f"tts loaded in {time.time() - t0:.2f}s ({os.path.basename(self.args.tts_model)}, "
            f"{len(self._voices)} voices)")

    def voices(self) -> list[str]:
        self.load()
        return list(self._voices or [])

    def _phonemizer(self, family: str):
        """misaki's G2P for 'ja' or 'zh', loaded once. None when unavailable."""
        if family in self._g2p:
            return self._g2p[family]
        fn = None
        try:
            t0 = time.time()
            if family == "ja":
                from misaki import ja
                g = ja.JAG2P()
            else:
                from misaki import zh
                g = zh.ZHG2P()
            fn = lambda text: g(text)[0]  # noqa: E731 — (phonemes, tokens)
            log(f"misaki {family} g2p loaded in {time.time() - t0:.2f}s")
        except Exception as e:
            log(f"misaki {family} unavailable ({type(e).__name__}: {e}); falling back to espeak")
        self._g2p[family] = fn
        return fn

    @staticmethod
    def _family(lang: str) -> str | None:
        lang = (lang or "").lower()
        if lang.startswith("ja"):
            return "ja"
        if lang.startswith(("zh", "cmn", "yue")):
            return "zh"
        return None

    def _style(self, spec: str, blend: float):
        """
        The voice to speak with — possibly one that does not ship with the model.

        Kokoro addresses a voice by a style VECTOR, not a name, so two of them can be
        mixed: 0.6 of Heart plus 0.4 of Emma is a real third voice, consistent across
        utterances, and not one of the 54. That is the only way to get a voice nobody
        else has out of a fixed model, and it costs one array operation.
        """
        names = [n.strip() for n in str(spec).split("+") if n.strip()]
        for n in names:
            if n not in (self._voices or []):
                raise ValueError(f"unknown voice '{n}'")
        if not names:
            raise ValueError("no voice given")
        if len(names) == 1:
            return names[0], names[0]
        w = min(1.0, max(0.0, float(blend if blend is not None else 0.5)))
        a = np.asarray(self.kokoro.get_voice_style(names[0]), dtype=np.float32)
        b = np.asarray(self.kokoro.get_voice_style(names[1]), dtype=np.float32)
        if a.shape != b.shape:
            raise ValueError("those two voices cannot be blended")
        return (a * w + b * (1.0 - w)), f"{names[0]}+{names[1]}@{w:.2f}"

    def speak(self, req: dict) -> dict:
        self.load()
        text = (req.get("text") or "").strip()
        if not text:
            raise ValueError("nothing to say")
        text = text[:2000]

        voice, voice_label = self._style(req.get("voice") or self.args.tts_voice, req.get("blend"))
        # kokoro asserts on anything outside this band rather than clamping.
        speed = min(2.0, max(0.5, float(req.get("speed") or 1.0)))

        # Pitch without a phase vocoder: generate slightly slower or faster, then
        # declare a different sample rate in the WAV header. Resampling shifts pitch
        # and tempo together, and pre-compensating the speed cancels most of the tempo
        # half — APPROXIMATELY, because the model's own rate control is not linear, so
        # a lower pitch still reads a little quicker. Close enough that it sounds like
        # a different speaker rather than a tape running slow, which is the point.
        pitch = min(1.5, max(0.7, float(req.get("pitch") or 1.0)))
        if pitch != 1.0:
            speed = min(2.0, max(0.5, speed / pitch))
        lang = (req.get("lang") or self.args.tts_lang).strip() or "en-us"
        out = req.get("out") or ""
        if not out:
            raise ValueError("no output path")

        t0 = time.time()
        g2p_used = ""
        family = self._family(lang)
        phonemes = None
        if family:
            fn = self._phonemizer(family)
            if fn:
                try:
                    phonemes = fn(text)
                    g2p_used = "misaki:" + family
                except Exception as e:
                    log(f"misaki {family} failed on this text ({type(e).__name__}: {e}); using espeak")

        try:
            if phonemes:
                samples, rate = self.kokoro.create(phonemes, voice=voice, speed=speed, is_phonemes=True)
            else:
                samples, rate = self.kokoro.create(text, voice=voice, speed=speed, lang=lang)
                g2p_used = "espeak:" + lang
        except Exception as e:
            # Any language the installed espeak cannot handle lands here. English is
            # always available, and a voice that speaks is better than a voice that
            # 500s — the caller is told which language actually ran.
            if lang == "en-us" and not phonemes:
                raise
            log(f"lang '{lang}' failed ({e}); retrying as en-us")
            lang = "en-us"
            g2p_used = "espeak:en-us"
            samples, rate = self.kokoro.create(text, voice=voice, speed=speed, lang=lang)

        pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767).astype("<i2")
        out_rate = int(round(rate * pitch))
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(out_rate)
            w.writeframes(pcm.tobytes())

        return {
            "path": out, "sampleRate": out_rate, "voice": voice_label, "pitch": pitch, "lang": lang,
            "g2p": g2p_used,
            # Against the rate it will actually be PLAYED at, not the rate it was
            # generated at — with a pitch shift those differ, and this figure is what
            # the client uses to reason about how long the clip runs for.
            "seconds": round(len(pcm) / float(out_rate), 2),
            "bytes": os.path.getsize(out),
            "ms": int((time.time() - t0) * 1000),
        }

    def unload(self):
        self.kokoro = None
        self._voices = None
        self._g2p = {}


# ---------------------------------------------------------------------- dispatch

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--stt-model", default="")
    p.add_argument("--stt-partial-model", default="")
    p.add_argument("--stt-device", default="cpu")
    p.add_argument("--stt-compute", default="int8")
    p.add_argument("--stt-threads", type=int, default=8)
    p.add_argument("--stt-beam", type=int, default=1)
    # The streaming transducer behind the live words. Empty = feature off, and the
    # partials fall back to re-running the small whisper as before.
    p.add_argument("--stream-model", default="")
    p.add_argument("--stream-threads", type=int, default=4)
    p.add_argument("--stream-provider", default="cpu")
    # greedy_search is cheaper; modified_beam_search is what hotwords need and is
    # 130ms quicker to its first word. See Stream.load for the measurements.
    p.add_argument("--stream-decoding", default="greedy_search")
    p.add_argument("--stream-beam", type=int, default=4)
    p.add_argument("--stream-hotwords-score", type=float, default=2.0)
    p.add_argument("--stream-rule1", type=float, default=2.4)
    p.add_argument("--stream-rule2", type=float, default=0.8)
    p.add_argument("--stream-rule3", type=float, default=300.0)
    p.add_argument("--tts-model", default="")
    p.add_argument("--tts-voices", default="")
    p.add_argument("--tts-voice", default="af_heart")
    p.add_argument("--tts-lang", default="en-us")
    args = p.parse_args()

    stt, tts, stream = STT(args), TTS(args), Stream(args)
    reply({"t": "ready", "pid": os.getpid(), "python": sys.version.split()[0]})

    # readline() rather than `for line in sys.stdin`: iteration is allowed to read
    # ahead, and a request sitting in a buffer waiting for the *next* one to arrive
    # is a deadlock in a request/response protocol.
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            reply({"id": None, "ok": False, "error": f"bad request: {e}"})
            continue

        rid, op = req.get("id"), req.get("op")
        try:
            if op == "ping":
                out = {"stt": stt.model is not None, "tts": tts.kokoro is not None,
                       "stream": stream.rec is not None, "pid": os.getpid()}
            elif op == "stt":
                out = stt.transcribe(req)
            elif op == "tts":
                out = tts.speak(req)
            elif op == "stream.start":
                out = stream.start(req)
            elif op == "stream.feed":
                out = stream.feed(req)
            elif op == "stream.end":
                out = stream.end(req)
            elif op == "voices":
                out = {"voices": tts.voices()}
            elif op == "load":
                if req.get("stt"):
                    stt.load()
                if req.get("partial"):
                    stt.load_fast()
                if req.get("tts"):
                    tts.load()
                if req.get("stream"):
                    stream.load()
                out = {"stt": stt.model is not None, "tts": tts.kokoro is not None,
                       "stream": stream.rec is not None}
            elif op == "unload":
                stt.unload()
                tts.unload()
                stream.unload()
                out = {"unloaded": True}
            elif op == "exit":
                reply({"id": rid, "ok": True, "bye": True})
                return 0
            else:
                raise ValueError(f"unknown op '{op}'")
            reply({"id": rid, "ok": True, **out})
        except Exception as e:
            reply({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"})

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
