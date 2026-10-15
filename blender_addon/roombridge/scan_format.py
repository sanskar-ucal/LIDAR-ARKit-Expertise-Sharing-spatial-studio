"""RBSC room-scan decoding (see protocol/PROTOCOL.md). Pure Python."""

from __future__ import annotations

import array
import math
import struct
import sys
from typing import Dict, List, NamedTuple, Optional, Tuple

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


def estimate_floor_y(scan: Scan, bin_size: float = 0.05, min_area: float = 0.25) -> Optional[float]:
    """Canonical height of the floor: the lowest horizontal surface with a substantial area.

    ARKit's origin is where the phone started (about chest height), so the floor is
    usually around y = -1.2, not 0. Returns None if the scan has no large horizontal area.
    """
    bins: Dict[int, List[float]] = {}  # bin -> [area, area * y]
    vs = scan.vertices
    for a, b, c in scan.triangles:
        ax, ay, az = vs[a]
        ux, uy, uz = vs[b][0] - ax, vs[b][1] - ay, vs[b][2] - az
        wx, wy, wz = vs[c][0] - ax, vs[c][1] - ay, vs[c][2] - az
        nx, ny, nz = uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx
        length = math.sqrt(nx * nx + ny * ny + nz * nz)
        if length == 0 or abs(ny) / length < 0.9:
            continue
        area = length / 2
        y = (ay + vs[b][1] + vs[c][1]) / 3
        acc = bins.setdefault(math.floor(y / bin_size), [0.0, 0.0])
        acc[0] += area
        acc[1] += area * y
    if not bins:
        return None
    biggest = max(acc[0] for acc in bins.values())
    threshold = min(min_area, biggest * 0.5)
    for key in sorted(bins):
        area, weighted = bins[key]
        if area >= threshold:
            return weighted / area
    return None


def encode(epoch: int, vertices, triangles, synthetic: bool = False) -> bytes:
    out = bytearray(HEADER.pack(MAGIC, 1, 1 if synthetic else 0, epoch, len(vertices), len(triangles)))
    for v in vertices:
        out += struct.pack("<3f", *v)
    for t in triangles:
        out += struct.pack("<3I", *t)
    return bytes(out)
