"""Expert teaching prompts ("lessons") with show-me demos. Pure Python (no bpy).

A demo is two poses of a real object; the phone loops a ghost between them so the
novice sees what a CAD operation does before trying it. Axes and amounts are given
in Blender terms (what the expert would type) and converted to canonical space.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional

from . import catalog, coords

PRESETS = ("scan", "place", "move", "rotate", "scale", "custom")
NEEDS_OBJECT = ("move", "rotate", "scale")
AXIS_COLOR = {"X": "red", "Y": "green", "Z": "blue"}
SCALE_WORD = {"X": "wider", "Y": "deeper", "Z": "taller"}


def _qmul(a, b):
    """Hamilton product of [x, y, z, w] quaternions."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def _fmt_m(m: float) -> str:
    return f"{round(abs(m) * 100)} cm" if abs(m) < 1 else f"{abs(m):.2f} m"


def build(preset: str, obj: Optional[Dict[str, Any]] = None, axis: str = "X", distance: float = 0.5,
          angle: float = 90.0, factor: float = 1.25, kind: str = "chair", text: str = "") -> Dict[str, Any]:
    """lesson.prompt payload. `obj` is the server object to demonstrate on (for move/rotate/scale)."""
    if preset not in PRESETS:
        raise ValueError("unknown lesson preset")
    payload: Dict[str, Any] = {"preset": preset, "objectId": None, "demo": None}
    default = ""
    if preset == "scan":
        default = "Scan the whole room: walk slowly and point the phone at the floor, every wall and the corners"
    elif preset == "place":
        payload["kind"] = kind
        label = catalog.get(kind)["label"].lower()
        default = f"Place a {label} where you think it should go. I'll review it."
    elif preset in NEEDS_OBJECT:
        if obj is None:
            raise ValueError("select a design object to demonstrate on")
        frm = {"position": list(obj["position"]), "rotation": list(obj["rotation"]), "dimensions": list(obj["dimensions"])}
        to = {k: list(v) for k, v in frm.items()}
        name = obj["name"]
        if preset == "move":
            delta_b = {"X": (distance, 0.0, 0.0), "Y": (0.0, distance, 0.0), "Z": (0.0, 0.0, distance)}[axis]
            delta_c = coords.b2c(delta_b)
            to["position"] = [frm["position"][i] + delta_c[i] for i in range(3)]
            default = f"Watch how {name} moves {_fmt_m(distance)} along the {AXIS_COLOR[axis]} {axis} axis (G {axis})"
        elif preset == "rotate":
            half = math.radians(angle) / 2
            turn = (0.0, math.sin(half), 0.0, math.cos(half))  # Blender Z is canonical Y
            to["rotation"] = list(coords.normalize_quat(_qmul(turn, frm["rotation"])))
            default = f"Watch how {name} turns {round(angle)}° (R Z), then try turning your own piece"
        else:
            idx = {"X": [0], "Y": [2], "Z": [1]}[axis]
            if obj["kind"] in catalog.ROUND_KINDS and axis in ("X", "Y"):
                idx = [0, 2]
            for i in idx:
                to["dimensions"][i] = round(frm["dimensions"][i] * factor, 4)
            default = f"Watch how {name} gets {factor:g}× {SCALE_WORD[axis]} (S {axis}), then try resizing your own piece"
        payload.update({"objectId": obj["id"], "kind": obj["kind"], "demo": {"from": frm, "to": to}})
    payload["text"] = (text.strip() or default)[:200]
    if not payload["text"]:
        raise ValueError("type what you want the novice to do")
    return payload
