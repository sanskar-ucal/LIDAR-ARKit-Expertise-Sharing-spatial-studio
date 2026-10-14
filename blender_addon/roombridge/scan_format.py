"""RBSC room-scan decoding (see protocol/PROTOCOL.md). Pure Python."""

from __future__ import annotations

import array
import struct
import sys
from typing import List, NamedTuple, Tuple

from .coords import c2b

MAGIC = b"RBSC"
HEADER = struct.Struct("<4sHHIII")


class Scan(NamedTuple):
    origin_epoch: int
    synthetic: bool
    vertices: List[Tuple[float, float, float]]  # canonical world, metres
    triangles: List[Tuple[int, int, int]]


def decode(buf: bytes) -> Scan:
    if len(buf) < HEADER.size:
        raise ValueError("scan too short")
    magic, version, flags, epoch, v, t = HEADER.unpack_from(buf, 0)
    if magic != MAGIC or version != 1:
        raise ValueError("not an RBSC v1 scan")
    expected = HEADER.size + v * 12 + t * 12
    if len(buf) != expected:
        raise ValueError(f"scan length {len(buf)} != expected {expected}")
    floats = array.array("f")
    floats.frombytes(buf[HEADER.size:HEADER.size + v * 12])
    ints = array.array("I")
    if ints.itemsize != 4:
        ints = array.array("L")
    ints.frombytes(buf[HEADER.size + v * 12:])
    if sys.byteorder != "little":
        floats.byteswap()
        ints.byteswap()
    verts = [(floats[i], floats[i + 1], floats[i + 2]) for i in range(0, len(floats), 3)]
    tris = [(ints[i], ints[i + 1], ints[i + 2]) for i in range(0, len(ints), 3)]
    for tri in tris:
        if max(tri) >= v:
            raise ValueError("triangle index out of range")
    return Scan(epoch, bool(flags & 1), verts, tris)


def to_blender(scan: Scan) -> List[Tuple[float, float, float]]:
    """Convert canonical vertices to Blender world coordinates. Anchor transforms were applied on the phone."""
    return [c2b(v) for v in scan.vertices]


def encode(epoch: int, vertices, triangles, synthetic: bool = False) -> bytes:
    out = bytearray(HEADER.pack(MAGIC, 1, 1 if synthetic else 0, epoch, len(vertices), len(triangles)))
    for v in vertices:
        out += struct.pack("<3f", *v)
    for t in triangles:
        out += struct.pack("<3I", *t)
    return bytes(out)
