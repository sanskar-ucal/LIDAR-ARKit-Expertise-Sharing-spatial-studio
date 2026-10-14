"""RoomBridge protocol v1 helpers for the Blender client. See protocol/PROTOCOL.md."""

from __future__ import annotations

import math
import re
import uuid
from typing import Any, Dict, Optional

PROTOCOL_VERSION = 1
KINDS = ("pillar", "partition", "panel")
TEXTURES = (None, "sample:picture")
DIM_MIN, DIM_MAX = 0.01, 20.0
POS_MAX = 100.0
EPOCH_BOUND = {"object.create", "object.update", "guidance.set", "guidance.begin", "guidance.attempt"}

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class ValidationError(ValueError):
    pass


def new_message_id() -> str:
    return "m-" + uuid.uuid4().hex


def new_object_id() -> str:
    return str(uuid.uuid4())


def envelope(msg_type: str, payload: Dict[str, Any], room_id: str, client_id: str,
             origin_epoch: Optional[int] = None, message_id: Optional[str] = None) -> Dict[str, Any]:
    env: Dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "type": msg_type,
        "roomId": room_id,
        "clientId": client_id,
        "messageId": message_id or new_message_id(),
        "payload": payload,
    }
    if msg_type in EPOCH_BOUND:
        if origin_epoch is None:
            raise ValidationError(f"{msg_type} requires originEpoch")
        env["originEpoch"] = int(origin_epoch)
    return env


def _vec(v: Any, n: int, name: str) -> None:
    if not isinstance(v, (list, tuple)) or len(v) != n:
        raise ValidationError(f"{name} must have {n} numbers")
    for c in v:
        if isinstance(c, bool) or not isinstance(c, (int, float)) or not math.isfinite(c):
            raise ValidationError(f"{name} must contain finite numbers")


def validate_object_input(o: Dict[str, Any]) -> None:
    """Mirror of the server's object checks, so the add-on can refuse bad edits before sending."""
    if not isinstance(o, dict):
        raise ValidationError("object must be a dict")
    if not isinstance(o.get("id"), str) or not _UUID_RE.match(o["id"]):
        raise ValidationError("id must be a UUID")
    if o.get("kind") not in KINDS:
        raise ValidationError("unsupported kind")
    name = o.get("name")
    if not isinstance(name, str) or not (1 <= len(name.strip()) <= 60):
        raise ValidationError("name must be 1..60 characters")
    _vec(o.get("position"), 3, "position")
    _vec(o.get("rotation"), 4, "rotation")
    _vec(o.get("dimensions"), 3, "dimensions")
    if any(abs(c) > POS_MAX for c in o["position"]):
        raise ValidationError("position out of range")
    validate_dimensions(o["kind"], o["dimensions"])
    if not isinstance(o.get("color"), str) or not _COLOR_RE.match(o["color"]):
        raise ValidationError("color must be #RRGGBB")
    if o.get("textureRef") not in TEXTURES:
        raise ValidationError("unsupported textureRef")


def validate_dimensions(kind: str, d) -> None:
    for c in d:
        if not (DIM_MIN <= c <= DIM_MAX):
            raise ValidationError(f"dimensions must be between {DIM_MIN} and {DIM_MAX} m (got {c:.3f})")
    if kind == "pillar" and abs(d[0] - d[2]) > 0.001:
        raise ValidationError("pillars must be round (equal X and Y scale in Blender)")


def validate_scene_object(o: Dict[str, Any]) -> None:
    validate_object_input({k: o.get(k) for k in ("id", "kind", "name", "position", "rotation", "dimensions", "color", "textureRef")})
    for k in ("revision", "originEpoch"):
        if not isinstance(o.get(k), int) or o[k] < 1:
            raise ValidationError(f"{k} must be a positive integer")
    if not isinstance(o.get("stale"), bool):
        raise ValidationError("stale must be bool")


def validate_server_message(m: Any) -> Dict[str, Any]:
    if not isinstance(m, dict):
        raise ValidationError("message must be an object")
    if m.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValidationError("unsupported protocol version")
    if not isinstance(m.get("type"), str) or not isinstance(m.get("payload"), dict):
        raise ValidationError("message needs type and payload")
    t = m["type"]
    p = m["payload"]
    if t in ("object.created", "object.updated"):
        validate_scene_object(p.get("object"))
    elif t == "scene.snapshot":
        for o in p.get("objects", []):
            validate_scene_object(o)
    elif t == "guidance.state":
        g = p.get("guidance")
        if g is not None:
            if g.get("axis") not in ("x", "y", "z") or g.get("state") not in ("preview", "active", "approved"):
                raise ValidationError("bad guidance")
            _vec(g["target"]["position"], 3, "target.position")
            _vec(g["start"]["position"], 3, "start.position")
    return m


def parse_invite(text: str) -> Optional[Dict[str, str]]:
    """Parse an expert invite link http(s)://host[:port]/r/CODE#t=TOKEN."""
    m = re.match(r"^\s*(https?://[^/\s]+)/r/([A-Za-z0-9]{4,12})#t=([A-Za-z0-9_\-]{8,128})\s*$", text or "")
    if not m:
        return None
    return {"server": m.group(1), "code": m.group(2).upper(), "token": m.group(3)}


def redact(token: str) -> str:
    return (token[:3] + "…") if token else ""
