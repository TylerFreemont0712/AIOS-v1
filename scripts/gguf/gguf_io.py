"""Minimal, dependency-free GGUF v2/v3 reader + writer.

Only what AIOS needs: read the metadata block and tensor directory, copy tensor
bytes verbatim, and write new files. No numpy, no gguf-py, no torch — this runs
on a bare `python3` so it can be shelled out to from the Node server.

Deliberately *not* quantisation-aware: tensor payloads are moved as opaque
byte ranges, so any present or future ggml type passes through untouched.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Any, BinaryIO

GGUF_MAGIC = b"GGUF"
DEFAULT_ALIGNMENT = 32

# GGUF metadata value types.
(
    T_UINT8, T_INT8, T_UINT16, T_INT16, T_UINT32, T_INT32,
    T_FLOAT32, T_BOOL, T_STRING, T_ARRAY, T_UINT64, T_INT64, T_FLOAT64,
) = range(13)

_SCALAR_FMT = {
    T_UINT8: "<B", T_INT8: "<b", T_UINT16: "<H", T_INT16: "<h",
    T_UINT32: "<I", T_INT32: "<i", T_FLOAT32: "<f", T_BOOL: "<?",
    T_UINT64: "<Q", T_INT64: "<q", T_FLOAT64: "<d",
}
_SCALAR_SIZE = {t: struct.calcsize(f) for t, f in _SCALAR_FMT.items()}

TYPE_NAMES = {
    T_UINT8: "u8", T_INT8: "i8", T_UINT16: "u16", T_INT16: "i16",
    T_UINT32: "u32", T_INT32: "i32", T_FLOAT32: "f32", T_BOOL: "bool",
    T_STRING: "str", T_ARRAY: "arr", T_UINT64: "u64", T_INT64: "i64",
    T_FLOAT64: "f64",
}

# ggml tensor types, as (block_size, type_size). Used only to cross-check the
# sizes we derive from the tensor directory — a mismatch means our understanding
# of the file is wrong and we refuse to write rather than emit a corrupt model.
GGML_TYPES: dict[int, tuple[str, int, int]] = {
    0:  ("F32",     1,   4),
    1:  ("F16",     1,   2),
    2:  ("Q4_0",    32,  18),
    3:  ("Q4_1",    32,  20),
    6:  ("Q5_0",    32,  22),
    7:  ("Q5_1",    32,  24),
    8:  ("Q8_0",    32,  34),
    9:  ("Q8_1",    32,  40),
    10: ("Q2_K",    256, 84),
    11: ("Q3_K",    256, 110),
    12: ("Q4_K",    256, 144),
    13: ("Q5_K",    256, 176),
    14: ("Q6_K",    256, 210),
    15: ("Q8_K",    256, 292),
    16: ("IQ2_XXS", 256, 66),
    17: ("IQ2_XS",  256, 74),
    18: ("IQ3_XXS", 256, 98),
    19: ("IQ1_S",   256, 50),
    20: ("IQ4_NL",  32,  18),
    21: ("IQ3_S",   256, 110),
    22: ("IQ2_S",   256, 82),
    23: ("IQ4_XS",  256, 136),
    24: ("I8",      1,   1),
    25: ("I16",     1,   2),
    26: ("I32",     1,   4),
    27: ("I64",     1,   8),
    28: ("F64",     1,   8),
    29: ("IQ1_M",   256, 56),
    30: ("BF16",    1,   2),
    34: ("TQ1_0",   256, 54),
    35: ("TQ2_0",   256, 66),
    39: ("MXFP4",   32,  17),
}


def type_name(ggml_type: int) -> str:
    return GGML_TYPES.get(ggml_type, (f"type{ggml_type}", 0, 0))[0]


def align_up(value: int, alignment: int) -> int:
    rem = value % alignment
    return value if rem == 0 else value + alignment - rem


@dataclass
class KV:
    """One metadata entry. `elem_type` is set only for arrays."""
    key: str
    type: int
    value: Any
    elem_type: int | None = None

    def describe(self, limit: int = 90) -> str:
        if self.type == T_ARRAY:
            body = f"[{TYPE_NAMES.get(self.elem_type, '?')} x{len(self.value)}]"
            if self.value:
                body += " " + repr(self.value[:3])
        else:
            body = repr(self.value)
        if len(body) > limit:
            body = body[:limit] + "…"
        return f"{self.key} = {body}"


@dataclass
class TensorInfo:
    name: str
    dims: list[int]
    ggml_type: int
    offset: int          # relative to the start of the data section
    nbytes: int = 0      # filled in by the reader

    @property
    def elements(self) -> int:
        n = 1
        for d in self.dims:
            n *= d
        return n

    def computed_nbytes(self) -> int | None:
        """Size implied by dims + ggml type, or None for an unknown type."""
        spec = GGML_TYPES.get(self.ggml_type)
        if spec is None:
            return None
        _, blck, tsize = spec
        if self.elements % blck:
            return None
        return self.elements // blck * tsize


@dataclass
class GGUFFile:
    path: str
    version: int
    alignment: int
    kv: list[KV]
    tensors: list[TensorInfo]
    data_start: int
    file_size: int
    kv_index: dict[str, KV] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        entry = self.kv_index.get(key)
        return default if entry is None else entry.value

    def has(self, key: str) -> bool:
        return key in self.kv_index

    @property
    def arch(self) -> str:
        return self.get("general.architecture", "")


def _read_exact(f: BinaryIO, n: int) -> bytes:
    buf = f.read(n)
    if len(buf) != n:
        raise ValueError(f"unexpected EOF: wanted {n} bytes, got {len(buf)}")
    return buf


def _read_str(f: BinaryIO) -> str:
    (n,) = struct.unpack("<Q", _read_exact(f, 8))
    if n > (1 << 30):
        raise ValueError(f"implausible string length {n} — file is not a valid GGUF")
    return _read_exact(f, n).decode("utf-8", "replace")


def _read_value(f: BinaryIO, vtype: int) -> tuple[Any, int | None]:
    if vtype == T_STRING:
        return _read_str(f), None
    if vtype == T_ARRAY:
        (elem_type,) = struct.unpack("<I", _read_exact(f, 4))
        (count,) = struct.unpack("<Q", _read_exact(f, 8))
        if elem_type == T_STRING:
            return [_read_str(f) for _ in range(count)], elem_type
        if elem_type == T_ARRAY:
            raise ValueError("nested arrays are not supported by GGUF")
        fmt = _SCALAR_FMT.get(elem_type)
        if fmt is None:
            raise ValueError(f"unknown array element type {elem_type}")
        size = _SCALAR_SIZE[elem_type]
        raw = _read_exact(f, size * count)
        return list(struct.unpack("<" + fmt[1] * count, raw)), elem_type
    fmt = _SCALAR_FMT.get(vtype)
    if fmt is None:
        raise ValueError(f"unknown metadata value type {vtype}")
    (val,) = struct.unpack(fmt, _read_exact(f, _SCALAR_SIZE[vtype]))
    return val, None


def read_gguf(path: str) -> GGUFFile:
    """Parse the header, metadata and tensor directory. Does not read payloads."""
    import os

    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if _read_exact(f, 4) != GGUF_MAGIC:
            raise ValueError(f"{path}: not a GGUF file (bad magic)")
        (version,) = struct.unpack("<I", _read_exact(f, 4))
        if version not in (2, 3):
            raise ValueError(f"{path}: unsupported GGUF version {version}")
        (n_tensors,) = struct.unpack("<Q", _read_exact(f, 8))
        (n_kv,) = struct.unpack("<Q", _read_exact(f, 8))

        kv: list[KV] = []
        for _ in range(n_kv):
            key = _read_str(f)
            (vtype,) = struct.unpack("<I", _read_exact(f, 4))
            value, elem_type = _read_value(f, vtype)
            kv.append(KV(key, vtype, value, elem_type))

        tensors: list[TensorInfo] = []
        for _ in range(n_tensors):
            name = _read_str(f)
            (n_dims,) = struct.unpack("<I", _read_exact(f, 4))
            dims = list(struct.unpack(f"<{n_dims}Q", _read_exact(f, 8 * n_dims)))
            (ggml_type,) = struct.unpack("<I", _read_exact(f, 4))
            (offset,) = struct.unpack("<Q", _read_exact(f, 8))
            tensors.append(TensorInfo(name, dims, ggml_type, offset))

        index = {entry.key: entry for entry in kv}
        alignment = index["general.alignment"].value if "general.alignment" in index else DEFAULT_ALIGNMENT
        if alignment <= 0 or alignment & (alignment - 1):
            raise ValueError(f"{path}: general.alignment must be a power of two, got {alignment}")
        data_start = align_up(f.tell(), alignment)

    _fill_sizes(tensors, data_start, size, path)
    return GGUFFile(path, version, alignment, kv, tensors, data_start, size, index)


def _fill_sizes(tensors: list[TensorInfo], data_start: int, file_size: int, path: str) -> None:
    """Set `nbytes` from dims+type, cross-checked against the offset directory.

    The directory gives an authoritative upper bound (the gap to the next
    tensor). If the type-derived size exceeds that gap, our type table is wrong
    for this file and we must not proceed.
    """
    by_offset = sorted(tensors, key=lambda t: t.offset)
    data_len = file_size - data_start
    for i, tensor in enumerate(by_offset):
        gap_end = by_offset[i + 1].offset if i + 1 < len(by_offset) else data_len
        gap = gap_end - tensor.offset
        computed = tensor.computed_nbytes()
        if computed is None:
            # Unknown ggml type: fall back to the directory gap. Safe, may
            # include alignment padding.
            tensor.nbytes = gap
            continue
        if computed > gap:
            raise ValueError(
                f"{path}: tensor {tensor.name!r} ({type_name(tensor.ggml_type)}, dims={tensor.dims}) "
                f"needs {computed} bytes but only {gap} are available before the next tensor. "
                f"The ggml type table in gguf_io.py is out of date for this file."
            )
        tensor.nbytes = computed


class GGUFWriter:
    """Streaming GGUF v3 writer.

    Usage: build the KV list and the (TensorInfo, source) plan up front, then
    call `write`. Tensor payloads are streamed from the source file handle so
    memory use stays flat regardless of model size.
    """

    def __init__(self, alignment: int = DEFAULT_ALIGNMENT) -> None:
        self.alignment = alignment

    @staticmethod
    def _enc_str(text: str) -> bytes:
        raw = text.encode("utf-8")
        return struct.pack("<Q", len(raw)) + raw

    @classmethod
    def _enc_value(cls, entry: KV) -> bytes:
        if entry.type == T_STRING:
            return cls._enc_str(entry.value)
        if entry.type == T_ARRAY:
            elem_type = entry.elem_type
            if elem_type is None:
                raise ValueError(f"array KV {entry.key!r} is missing elem_type")
            head = struct.pack("<I", elem_type) + struct.pack("<Q", len(entry.value))
            if elem_type == T_STRING:
                return head + b"".join(cls._enc_str(v) for v in entry.value)
            fmt = _SCALAR_FMT[elem_type]
            return head + struct.pack("<" + fmt[1] * len(entry.value), *entry.value)
        return struct.pack(_SCALAR_FMT[entry.type], entry.value)

    def _metadata_block(self, kv: list[KV], tensors: list[TensorInfo]) -> bytes:
        out = bytearray()
        out += GGUF_MAGIC
        out += struct.pack("<I", 3)
        out += struct.pack("<Q", len(tensors))
        out += struct.pack("<Q", len(kv))
        for entry in kv:
            out += self._enc_str(entry.key)
            out += struct.pack("<I", entry.type)
            out += self._enc_value(entry)
        for tensor in tensors:
            out += self._enc_str(tensor.name)
            out += struct.pack("<I", len(tensor.dims))
            out += struct.pack(f"<{len(tensor.dims)}Q", *tensor.dims)
            out += struct.pack("<I", tensor.ggml_type)
            out += struct.pack("<Q", tensor.offset)
        return bytes(out)

    def plan(self, tensors: list[TensorInfo]) -> list[TensorInfo]:
        """Return copies of `tensors` with offsets renumbered densely."""
        out: list[TensorInfo] = []
        cursor = 0
        for tensor in tensors:
            cursor = align_up(cursor, self.alignment)
            out.append(TensorInfo(tensor.name, list(tensor.dims), tensor.ggml_type, cursor, tensor.nbytes))
            cursor += tensor.nbytes
        return out

    def write(
        self,
        out_path: str,
        kv: list[KV],
        tensors: list[TensorInfo],
        src_path: str,
        src_data_start: int,
        src_offsets: dict[str, int],
        progress=None,
        chunk_size: int = 8 << 20,
    ) -> int:
        """Write `out_path`. `tensors` must already come from `plan()`."""
        header = self._metadata_block(kv, tensors)
        pad = align_up(len(header), self.alignment) - len(header)
        total = sum(t.nbytes for t in tensors)
        written = 0
        with open(src_path, "rb") as src, open(out_path, "wb") as dst:
            dst.write(header)
            dst.write(b"\0" * pad)
            for tensor in tensors:
                # Pad up to this tensor's planned offset.
                here = dst.tell() - (len(header) + pad)
                if here < tensor.offset:
                    dst.write(b"\0" * (tensor.offset - here))
                src.seek(src_data_start + src_offsets[tensor.name])
                remaining = tensor.nbytes
                while remaining:
                    chunk = src.read(min(chunk_size, remaining))
                    if not chunk:
                        raise ValueError(f"unexpected EOF reading {tensor.name!r} from {src_path}")
                    dst.write(chunk)
                    remaining -= len(chunk)
                    written += len(chunk)
                    if progress:
                        progress(written, total)
        return written
