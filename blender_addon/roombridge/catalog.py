"""Object catalog shared by every client (protocol/catalog.json). Pure Python.

The packaged add-on carries its own copy of catalog.json (scripts/package-addon.sh);
a source checkout reads the one in protocol/.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any, Dict, List, Tuple

_HERE = pathlib.Path(__file__).resolve().parent


def _load() -> Dict[str, Any]:
    for path in (_HERE / "catalog.json", _HERE.parents[1] / "protocol" / "catalog.json"):
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    raise FileNotFoundError("catalog.json not found next to the add-on or in protocol/")


DATA = _load()
KINDS: Tuple[str, ...] = tuple(k["kind"] for k in DATA["kinds"])
BY_KIND: Dict[str, Dict[str, Any]] = {k["kind"]: k for k in DATA["kinds"]}
ROUND_KINDS = frozenset(k["kind"] for k in DATA["kinds"] if k["round"])


def get(kind: str) -> Dict[str, Any]:
    return BY_KIND[kind]


def groups() -> List[Tuple[str, List[Dict[str, Any]]]]:
    out: List[Tuple[str, List[Dict[str, Any]]]] = []
    for k in DATA["kinds"]:
        if not out or out[-1][0] != k["group"]:
            out.append((k["group"], []))
        out[-1][1].append(k)
    return out


def tint_order(kind: str) -> List[str]:
    """Distinct tints of a kind's parts, 'base' first. A part's material slot is its index here."""
    order = ["base"]
    for p in BY_KIND[kind]["parts"]:
        if p["tint"] not in order:
            order.append(p["tint"])
    return order


def tint_hex(tint: str, base_hex: str) -> str:
    if tint.startswith("#"):
        return tint
    h = base_hex.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    if tint == "dark":
        r, g, b = (round(c * 0.55) for c in (r, g, b))
    elif tint == "light":
        r, g, b = (round(c + (255 - c) * 0.5) for c in (r, g, b))
    return f"#{r:02x}{g:02x}{b:02x}"
