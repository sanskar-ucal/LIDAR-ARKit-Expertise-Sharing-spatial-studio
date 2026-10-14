"""Outbound edit coalescing and echo suppression. Pure Python (no bpy).

Rules (see protocol/PROTOCOL.md, "Ordering and ownership"):

* At most one create/update is in flight per object. Further local edits are
  coalesced; when the server confirms, the newest local state is sent with the
  fresh base revision. While dragging, an update goes out at most every
  STREAM_INTERVAL; once the object rests for SETTLE_DELAY the final transform is
  always published.
* Our own broadcast echoes only advance the known revision. They are never
  re-applied to Blender, so the object does not jitter under the mouse.
* Changes made by someone else (for example the server applying an approved
  novice attempt) are applied locally unless we have unsent local edits, in
  which case the expert, who owns the object, wins on the next send.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

SETTLE_DELAY = 0.10
STREAM_INTERVAL = 0.15
IN_FLIGHT_TIMEOUT = 3.0

State = Dict[str, Any]  # canonical object fields (name, position, rotation, dimensions, color, textureRef)

FIELDS = ("name", "position", "rotation", "dimensions", "color", "textureRef")


def _round(v: Any) -> Any:
    if isinstance(v, (list, tuple)):
        return tuple(round(float(c), 5) for c in v)
    return v


def signature(state: State) -> Tuple:
    out = []
    for k in FIELDS:
        v = state.get(k)
        if k == "rotation" and v is not None and float(v[3]) < 0:
            v = [-float(c) for c in v]  # q and -q are the same rotation
        out.append(_round(v))
    return tuple(out)


@dataclass
class Tracked:
    id: str
    kind: str
    revision: int = 0  # 0 = not yet confirmed by the server
    server_sig: Tuple = ()
    local: Optional[State] = None
    local_sig: Tuple = ()
    last_change: float = 0.0
    last_sent: float = 0.0
    in_flight: Optional[str] = None  # messageId
    in_flight_kind: str = ""
    in_flight_since: float = 0.0
    sent_sig: Tuple = ()


class SyncTracker:
    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self.clock = clock
        self.objects: Dict[str, Tracked] = {}
        self.by_message: Dict[str, str] = {}

    # ---------------------------------------------------------------- server -> local

    def reset_from_snapshot(self, objects: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[str], List[str]]:
        """Adopt a snapshot. Returns (objects to apply locally, ids to delete locally, ids with local edits to re-send)."""
        incoming = {o["id"]: o for o in objects}
        to_apply, to_delete, to_resend = [], [], []
        for oid, t in list(self.objects.items()):
            if oid not in incoming:
                if t.revision == 0 and t.local is not None:
                    # Created locally while offline: keep and create it again.
                    t.in_flight = None
                    to_resend.append(oid)
                else:
                    to_delete.append(oid)
                    del self.objects[oid]
        for oid, o in incoming.items():
            t = self.objects.get(oid)
            sig = signature(o)
            if t is None:
                t = self.objects[oid] = Tracked(id=oid, kind=o["kind"])
                to_apply.append(o)
            else:
                local_dirty = t.local is not None and t.local_sig != t.server_sig
                if local_dirty and o["revision"] == t.revision:
                    to_resend.append(oid)  # we edited while offline; nobody else touched it
                elif sig != t.local_sig:
                    to_apply.append(o)
            t.revision = o["revision"]
            t.server_sig = sig
            t.in_flight = None
            if oid not in to_resend:
                t.local_sig = sig
                t.local = {k: o[k] for k in FIELDS}
        self.by_message.clear()
        return to_apply, to_delete, to_resend

    def on_server_object(self, obj: Dict[str, Any], from_me: bool) -> bool:
        """Record a created/updated broadcast. Returns True if Blender should apply it."""
        t = self.objects.get(obj["id"])
        sig = signature(obj)
        if t is None:
            self.objects[obj["id"]] = Tracked(id=obj["id"], kind=obj["kind"], revision=obj["revision"],
                                              server_sig=sig, local_sig=sig, local={k: obj[k] for k in FIELDS})
            return True
        if obj["revision"] < t.revision:
            return False
        t.revision = obj["revision"]
        t.server_sig = sig
        if from_me:
            return False
        if t.local is not None and t.local_sig != sig and t.in_flight is None and self.clock() - t.last_change < SETTLE_DELAY * 3:
            # The expert is actively moving this object; their next update wins.
            return False
        t.local_sig = sig
        t.local = {k: obj[k] for k in FIELDS}
        return True

    def on_server_delete(self, oid: str) -> None:
        self.objects.pop(oid, None)

    def on_ack(self, message_id: str) -> None:
        oid = self.by_message.pop(message_id, None)
        t = self.objects.get(oid) if oid else None
        if t and t.in_flight == message_id:
            t.in_flight = None

    def on_error(self, message_id: str, code: str, current: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Handle a rejected edit. Returns a server object to apply locally, if any."""
        oid = self.by_message.pop(message_id, None)
        t = self.objects.get(oid) if oid else None
        if not t:
            return None
        t.in_flight = None
        if code in ("stale_revision", "duplicate_object") and current:
            t.revision = current["revision"]
            t.server_sig = signature(current)
            # Our local edit is still newer: it will be re-sent against the fresh revision.
            return None
        if code == "not_found":
            self.objects.pop(oid, None)
            return None
        # Validation errors: revert to the last server state.
        if t.revision > 0 and t.local is not None:
            t.local_sig = t.server_sig
        return {"id": oid, "revert": True}

    # ---------------------------------------------------------------- local -> server

    def track_new(self, oid: str, kind: str, state: State) -> None:
        self.objects[oid] = Tracked(id=oid, kind=kind, local=dict(state), local_sig=signature(state),
                                    last_change=self.clock())

    def local_state(self, oid: str, state: State) -> None:
        t = self.objects.get(oid)
        if t is None:
            return
        sig = signature(state)
        if sig != t.local_sig:
            t.local = dict(state)
            t.local_sig = sig
            t.last_change = self.clock()

    def due(self) -> List[Tuple[str, str, Dict[str, Any]]]:
        """Messages to send now: list of (object id, type, payload-without-ids)."""
        now = self.clock()
        out = []
        for t in self.objects.values():
            if t.in_flight and now - t.in_flight_since < IN_FLIGHT_TIMEOUT:
                continue
            if t.local is None:
                continue
            if t.revision == 0:
                out.append((t.id, "object.create", {"object": {"id": t.id, "kind": t.kind, **t.local}}))
                continue
            if t.local_sig == t.server_sig:
                continue
            settled = now - t.last_change >= SETTLE_DELAY
            streaming = now - t.last_sent >= STREAM_INTERVAL
            if not (settled or streaming):
                continue
            patch = {k: t.local[k] for i, k in enumerate(FIELDS) if t.local_sig[i] != t.server_sig[i]} if t.server_sig else dict(t.local)
            if not patch:
                continue
            out.append((t.id, "object.update", {"id": t.id, "baseRevision": t.revision, "patch": patch}))
        return out

    def mark_sent(self, oid: str, message_id: str, kind: str) -> None:
        t = self.objects.get(oid)
        if not t:
            return
        t.in_flight = message_id
        t.in_flight_kind = kind
        t.in_flight_since = self.clock()
        t.last_sent = t.in_flight_since
        t.sent_sig = t.local_sig
        self.by_message[message_id] = oid

    def forget(self, oid: str) -> None:
        self.objects.pop(oid, None)
