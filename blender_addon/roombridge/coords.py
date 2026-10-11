"""Canonical (ARKit, Y-up) <-> Blender (Z-up) conversion.

Single source of truth: protocol/COORDINATES.md. Pure Python so it can be
unit-tested without Blender. Quaternions are [x, y, z, w] tuples here; convert
to mathutils' (w, x, y, z) order only at the bpy boundary.

    M (canonical -> Blender) = [[1,0,0],[0,0,-1],[0,1,0]]
    M^-1 = M^T
"""

from __future__ import annotations

import math
from typing import Sequence, Tuple

Vec3 = Tuple[float, float, float]
Quat = Tuple[float, float, float, float]

MATRIX_C2B = ((1.0, 0.0, 0.0), (0.0, 0.0, -1.0), (0.0, 1.0, 0.0))


def c2b(v: Sequence[float]) -> Vec3:
    return (float(v[0]), -float(v[2]), float(v[1]))


def b2c(v: Sequence[float]) -> Vec3:
    return (float(v[0]), float(v[2]), -float(v[1]))


def quat_c2b(q: Sequence[float]) -> Quat:
    return (float(q[0]), -float(q[2]), float(q[1]), float(q[3]))


def quat_b2c(q: Sequence[float]) -> Quat:
    return (float(q[0]), float(q[2]), -float(q[1]), float(q[3]))


def dims_to_blender_scale(d: Sequence[float]) -> Vec3:
    """Canonical dimensions [x, y(up), z] -> Blender object scale (x, y, z(up))."""
    return (float(d[0]), float(d[2]), float(d[1]))


def blender_scale_to_dims(s: Sequence[float]) -> Vec3:
    return (float(s[0]), float(s[2]), float(s[1]))


def normalize_quat(q: Sequence[float]) -> Quat:
    n = math.sqrt(sum(float(c) * float(c) for c in q))
    if n == 0:
        return (0.0, 0.0, 0.0, 1.0)
    x, y, z, w = (float(c) / n for c in q)
    # Canonical sign: keep w >= 0 so equal rotations compare equal.
    if w < 0:
        x, y, z, w = -x, -y, -z, -w
    return (x, y, z, w)


def rotate(q: Sequence[float], v: Sequence[float]) -> Vec3:
    x, y, z, w = q
    ux, uy, uz = x, y, z
    # t = 2 * cross(u, v)
    tx = 2 * (uy * v[2] - uz * v[1])
    ty = 2 * (uz * v[0] - ux * v[2])
    tz = 2 * (ux * v[1] - uy * v[0])
    return (
        v[0] + w * tx + (uy * tz - uz * ty),
        v[1] + w * ty + (uz * tx - ux * tz),
        v[2] + w * tz + (ux * ty - uy * tx),
    )


AXES = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}

# Blender axis the expert picks -> canonical axis name (same physical direction, up to sign).
BLENDER_AXIS_TO_CANONICAL = {"X": "x", "Y": "z", "Z": "y"}
CANONICAL_AXIS_TO_BLENDER = {"x": "X", "y": "Z", "z": "Y"}


def dominant_axis(delta: Sequence[float]) -> str:
    """Canonical axis with the largest absolute component."""
    i = max(range(3), key=lambda k: abs(delta[k]))
    return "xyz"[i]


def project_onto_axis(start: Sequence[float], axis: str, p: Sequence[float]) -> Tuple[float, Vec3, float]:
    """Return (signed offset, snapped point, perpendicular distance) for p on line start + axis*t."""
    a = AXES[axis]
    d = [p[i] - start[i] for i in range(3)]
    t = sum(d[i] * a[i] for i in range(3))
    snapped = tuple(start[i] + a[i] * t for i in range(3))
    perp = math.sqrt(sum((p[i] - snapped[i]) ** 2 for i in range(3)))
    return t, snapped, perp  # type: ignore[return-value]
