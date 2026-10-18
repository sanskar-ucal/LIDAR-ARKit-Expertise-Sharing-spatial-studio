"""Main-thread synchronisation between Blender and a RoomBridge room.

Threading rule: everything in this module runs on Blender's main thread, from
operators, a bpy.app.timers callback, or bpy.app.handlers. Network I/O happens
in session.RoomSession's worker thread and reaches us only through its queue.
"""

from __future__ import annotations

import queue
import time
import traceback
from typing import Any, Dict, List, Optional

import bpy

from . import catalog, coords, lessons, primitives, protocol, scan_format
from .session import RoomSession
from .tracker import SyncTracker

TICK = 0.05
FULL_SCAN_INTERVAL = 1.0
MAX_MESSAGES_PER_TICK = 200


class Controller:
    def __init__(self) -> None:
        self.session: Optional[RoomSession] = None
        self.tracker = SyncTracker()
        self.server_objects: Dict[str, Dict[str, Any]] = {}
        self.participants: List[Dict[str, Any]] = []
        self.comments: List[Dict[str, Any]] = []
        self.reactions: Dict[str, Dict[str, List[str]]] = {}
        self.guidance: Optional[Dict[str, Any]] = None
        self.preview: Dict[str, Any] = {}
        self.room: Dict[str, Any] = {}
        self.origin_epoch = 1
        self.scan_meta: Optional[Dict[str, Any]] = None
        self.imported_scan_id = ""
        self.scan_status = "No scan yet"
        self.status = "Disconnected"
        self.last_error = ""
        self.last_sync = 0.0
        self.dirty = True
        self.last_full_scan = 0.0
        self.applying = False
        self.last_target_sig: Any = None
        self.approving_object = ""
        self.last_info = ""
        self.proposal_log: List[Dict[str, Any]] = []
        self.lesson: Optional[Dict[str, Any]] = None
        self.floor_z = 0.0
        self.foreign_objects = 0

    def reset(self) -> None:
        self.__init__()


ctrl = Controller()


# ---------------------------------------------------------------------- lifecycle

def connect(server_url: str, room_code: str, token: str, display_name: str) -> None:
    disconnect()
    ctrl.reset()
    ctrl.session = RoomSession(server_url, room_code, token, display_name)
    ctrl.session.start()
    ctrl.status = "Connecting…"
    _register_handlers()
    if not bpy.app.timers.is_registered(_tick):
        bpy.app.timers.register(_tick, first_interval=TICK, persistent=True)


def disconnect() -> None:
    if ctrl.session is not None:
        try:
            if ctrl.session.status == "connected":
                ctrl.session.send("room.leave", {})
                time.sleep(0.05)
        finally:
            ctrl.session.stop()
    ctrl.session = None
    if bpy.app.timers.is_registered(_tick):
        bpy.app.timers.unregister(_tick)
    _unregister_handlers()
    _remove_attempt_object()
    ctrl.status = "Disconnected"
    _redraw()


def is_connected() -> bool:
    return ctrl.session is not None and ctrl.session.status == "connected"


def _on_depsgraph(scene, depsgraph) -> None:
    if ctrl.applying or ctrl.session is None:
        return
    for upd in depsgraph.updates:
        idb = upd.id
        if isinstance(idb, bpy.types.Object):
            if "rb_id" in idb or "rb_target_of" in idb:
                ctrl.dirty = True
                return
        elif isinstance(idb, (bpy.types.Scene, bpy.types.Collection)):
            ctrl.dirty = True  # objects may have been deleted or duplicated
            return


def _on_load_pre(*_args) -> None:
    disconnect()


def _our_handler(fn) -> bool:
    return getattr(fn, "__module__", "") == __name__


def _register_handlers() -> None:
    _unregister_handlers()
    bpy.app.handlers.depsgraph_update_post.append(_on_depsgraph)
    bpy.app.handlers.load_pre.append(_on_load_pre)


def _unregister_handlers() -> None:
    # Remove by module name so handlers from a previous (reloaded) copy of this module are removed too.
    for handlers in (bpy.app.handlers.depsgraph_update_post, bpy.app.handlers.load_pre):
        stale = [h for h in handlers
                 if _our_handler(h)
                 or (getattr(h, "__name__", "") in ("_on_depsgraph", "_on_load_pre")
                     and "roombridge" in getattr(h, "__module__", ""))]
        for fn in stale:
            handlers.remove(fn)


def _redraw() -> None:
    wm = bpy.context.window_manager
    if wm is None:
        return
    for window in wm.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


# ---------------------------------------------------------------------- tick

def _tick() -> Optional[float]:
    s = ctrl.session
    if s is None:
        return None
    try:
        changed = _drain_inbox(s)
        if is_connected() and ctrl.room:
            now = time.monotonic()
            if ctrl.dirty or now - ctrl.last_full_scan > FULL_SCAN_INTERVAL:
                ctrl.dirty = False
                ctrl.last_full_scan = now
                _scan_local_changes()
            _flush()
        if changed:
            _redraw()
    except Exception:  # never let an exception unregister the timer silently
        ctrl.last_error = traceback.format_exc(limit=2).strip().splitlines()[-1]
        traceback.print_exc()
    if not s.alive and s.status in ("error", "ended", "stopped"):
        ctrl.status = {"error": "Error: " + (s.fatal_error or s.status_detail), "ended": "Room ended by host"}.get(s.status, "Disconnected")
        ctrl.session = None
        _unregister_handlers()
        _remove_attempt_object()
        _redraw()
        return None
    return TICK


def _drain_inbox(s: RoomSession) -> bool:
    changed = False
    for _ in range(MAX_MESSAGES_PER_TICK):
        try:
            msg = s.inbox.get_nowait()
        except queue.Empty:
            break
        changed = True
        try:
            _handle(s, msg)
        except Exception as exc:
            ctrl.last_error = f"{msg.get('type')}: {exc}"
            traceback.print_exc()
    return changed


def _handle(s: RoomSession, msg: Dict[str, Any]) -> None:
    t = msg["type"]
    p = msg.get("payload", {})
    if t == "local.status":
        st = p["status"]
        ctrl.status = {"connecting": "Connecting…", "reconnecting": "Reconnecting…", "connected": "Connected",
                       "error": "Error", "ended": "Room ended", "stopped": "Disconnected"}.get(st, st)
        if p.get("detail"):
            ctrl.last_error = p["detail"]
        return
    if t in ("local.warning",):
        ctrl.last_error = p.get("message", "")
        return
    if t == "local.scan":
        _import_scan(p["data"])
        return
    if t == "local.scan_error":
        ctrl.scan_status = f"Scan download failed: {p.get('message')}"
        return
    if "originEpoch" in msg and isinstance(msg["originEpoch"], int):
        ctrl.origin_epoch = msg["originEpoch"]
    ctrl.last_sync = time.time()
    from_me = msg.get("clientId") == s.client_id

    if t == "scene.snapshot":
        _apply_snapshot(s, p)
    elif t in ("object.created", "object.updated"):
        o = p["object"]
        ctrl.server_objects[o["id"]] = o
        if from_me and t == "object.updated" and o["id"] == ctrl.approving_object:
            # Approval moves the object server-side; it is not an echo of a local edit.
            ctrl.approving_object = ""
            from_me = False
        if t == "object.created" and o.get("proposal") and not from_me:
            ctrl.last_info = f"{o['proposal']['byName']} proposed “{o['name']}”. Review it under Novice Proposals."
        if ctrl.tracker.on_server_object(o, from_me):
            _apply_object(o)
        else:
            _set_stale_display(o)
    elif t == "proposal.resolved":
        ctrl.proposal_log.insert(0, p)
        del ctrl.proposal_log[6:]
    elif t == "object.deleted":
        oid = p["id"]
        ctrl.server_objects.pop(oid, None)
        ctrl.tracker.on_server_delete(oid)
        obj = _index().get(oid)
        if obj is not None:
            _guarded(lambda: primitives.remove_object(obj))
        for c in ctrl.comments:
            if c.get("objectId") == oid:
                c["objectDeleted"] = True
    elif t == "presence":
        ctrl.participants = p["participants"]
    elif t == "comment.added":
        ctrl.comments.append(p["comment"])
        del ctrl.comments[:-50]
    elif t == "reaction.updated":
        ctrl.reactions[p["objectId"]] = {"like": p["like"], "discuss": p["discuss"]}
    elif t == "guidance.state":
        ctrl.guidance = p["guidance"]
        _sync_guidance_objects()
    elif t == "lesson.state":
        prev = ctrl.lesson
        ctrl.lesson = p.get("lesson")
        if ctrl.lesson and ctrl.lesson["state"] == "done" and (not prev or prev.get("state") != "done"):
            ctrl.last_info = f"The novice finished: “{ctrl.lesson['text'][:60]}”"
    elif t == "scan.ready":
        ctrl.scan_meta = p["scan"]
        _maybe_fetch_scan(s)
    elif t == "preview.status":
        ctrl.preview = p
    elif t == "ack":
        ctrl.tracker.on_ack(p.get("ackOf", ""))
    elif t == "error":
        code = p.get("code", "")
        ctrl.last_error = f"{code}: {p.get('message', '')}"
        result = ctrl.tracker.on_error(p.get("ackOf", ""), code, p.get("current"))
        if p.get("current"):
            ctrl.server_objects[p["current"]["id"]] = p["current"]
        if result and result.get("revert"):
            o = ctrl.server_objects.get(result["id"])
            if o:
                _apply_object(o)
    elif t == "room.ended":
        ctrl.status = "Room ended by host"


def _apply_snapshot(s: RoomSession, p: Dict[str, Any]) -> None:
    room = p["room"]
    epoch_changed = bool(ctrl.room) and room["originEpoch"] != ctrl.room.get("originEpoch")
    ctrl.room = room
    ctrl.origin_epoch = room["originEpoch"]
    ctrl.participants = p["participants"]
    ctrl.comments = list(p["comments"])[-50:]
    ctrl.reactions = p.get("reactions", {})
    ctrl.preview = p.get("preview", {})
    ctrl.server_objects = {o["id"]: o for o in p["objects"]}
    to_apply, to_delete, _resend = ctrl.tracker.reset_from_snapshot(p["objects"])
    index = _index()
    for oid in to_delete:
        obj = index.get(oid)
        if obj is not None:
            _guarded(lambda obj=obj: primitives.remove_object(obj))
    # Objects tagged for this room that the server no longer has were deleted while we were away.
    known = set(ctrl.server_objects) | set(ctrl.tracker.objects)
    foreign = 0
    for oid, obj in list(_index().items()):
        if oid in known:
            continue
        if obj.get("rb_room") == room["id"]:
            _guarded(lambda obj=obj: primitives.remove_object(obj))
        else:
            foreign += 1
    ctrl.foreign_objects = foreign
    for o in to_apply:
        _apply_object(o)
    for o in p["objects"]:
        _set_stale_display(o)
    ctrl.guidance = p.get("guidance")
    ctrl.lesson = p.get("lesson")
    ctrl.last_target_sig = None
    _sync_guidance_objects()
    ctrl.scan_meta = p.get("scan")
    if epoch_changed or ctrl.scan_meta is None:
        _remove_scan_object()
        ctrl.imported_scan_id = ""
        ctrl.scan_status = "AR origin was reset; waiting for a new scan" if epoch_changed else "No scan yet"
    _maybe_fetch_scan(s)


# ---------------------------------------------------------------------- Blender objects

def _guarded(fn):
    ctrl.applying = True
    try:
        return fn()
    finally:
        ctrl.applying = False


def _index() -> Dict[str, bpy.types.Object]:
    """rb_id -> object. Duplicated objects (Shift+D copies custom properties) get a fresh id."""
    out: Dict[str, bpy.types.Object] = {}
    scene = bpy.context.scene
    for obj in scene.objects:
        oid = obj.get("rb_id")
        if not oid:
            continue
        if oid in out:
            tracked = ctrl.tracker.objects.get(oid)
            keep = out[oid]
            if tracked and tracked.local and obj.name == tracked.local.get("name"):
                keep, obj = obj, keep
            out[oid] = keep
            _adopt_duplicate(obj)
            out[obj["rb_id"]] = obj
            continue
        out[oid] = obj
    return out


def _adopt_duplicate(obj: bpy.types.Object) -> None:
    if ctrl.room:
        new_id = protocol.new_object_id()
        obj["rb_id"] = new_id
        obj["rb_room"] = ctrl.room.get("id", "")
        if obj.data is not None and obj.data.users > 1:
            obj.data = obj.data.copy()
        state = read_state(obj)
        if state is not None:
            ctrl.tracker.track_new(new_id, obj["rb_kind"], state)


def read_state(obj: bpy.types.Object) -> Optional[Dict[str, Any]]:
    """Canonical object state from a Blender object, or None if its transform is unsupported."""
    kind = obj.get("rb_kind")
    if kind not in protocol.KINDS:
        return None
    sx, sy, sz = obj.scale
    if min(sx, sy, sz) <= 0:
        raise protocol.ValidationError("negative or zero scale is not supported; use positive dimensions")
    if kind in catalog.ROUND_KINDS and abs(sx - sy) > 1e-4:
        # Keep round kinds round: take whichever horizontal axis the expert just changed.
        prev = ctrl.server_objects.get(obj.get("rb_id", ""), {}).get("dimensions", [sx])[0]
        d = sx if abs(sx - prev) > abs(sy - prev) else sy
        _guarded(lambda: setattr(obj, "scale", (d, d, sz)))
        sx = sy = d
        ctrl.last_error = f"A {catalog.get(kind)['label'].lower()} stays round: diameter applied to both X and Y."
    # matrix_world is only refreshed on depsgraph evaluation; matrix_basis reflects
    # location/rotation/scale immediately (e.g. right after create or apply).
    matrix = obj.matrix_basis if obj.parent is None else obj.parent.matrix_world @ obj.matrix_parent_inverse @ obj.matrix_basis
    loc, rot, _scale = matrix.decompose()
    q = coords.normalize_quat(coords.quat_b2c((rot.x, rot.y, rot.z, rot.w)))
    return {
        "name": obj.name[:60],
        "position": list(coords.b2c(loc)),
        "rotation": list(q),
        "dimensions": list(coords.blender_scale_to_dims((sx, sy, sz))),
        "color": obj.get("rb_color", primitives.DEFAULT_COLORS[kind]),
        "textureRef": obj.get("rb_texture") or None,
    }


def _apply_object(o: Dict[str, Any]) -> None:
    def work():
        index = _index()
        obj = index.get(o["id"])
        if obj is None:
            mesh = primitives.unit_mesh(o["kind"], o["name"])
            obj = bpy.data.objects.new(o["name"], mesh)
            primitives.ensure_collection(primitives.DESIGN_COLLECTION).objects.link(obj)
            obj["rb_id"] = o["id"]
            obj["rb_kind"] = o["kind"]
        obj["rb_room"] = ctrl.room.get("id", "")
        obj["rb_color"] = o["color"]
        obj["rb_texture"] = o.get("textureRef") or ""
        if obj.name != o["name"]:
            obj.name = o["name"]
        obj.rotation_mode = "QUATERNION"
        obj.location = coords.c2b(o["position"])
        x, y, z, w = coords.quat_c2b(o["rotation"])
        obj.rotation_quaternion = (w, x, y, z)
        obj.scale = coords.dims_to_blender_scale(o["dimensions"])
        primitives.apply_materials(obj, o["kind"], o["color"], o.get("textureRef"))
        _set_stale_display(o, obj)
        state = read_state(obj)
        if state is not None:
            ctrl.tracker.local_state(o["id"], state)
            t = ctrl.tracker.objects.get(o["id"])
            if t is not None:
                t.server_sig = t.local_sig  # Blender's float32 rounding is not a local edit
                t.last_change = 0.0

    _guarded(work)


def _set_stale_display(o: Dict[str, Any], obj: Optional[bpy.types.Object] = None) -> None:
    obj = obj or _index().get(o["id"])
    if obj is None:
        return
    stale = bool(o.get("stale"))
    if bool(obj.get("rb_stale", False)) != stale:
        obj["rb_stale"] = stale
        obj.display_type = "WIRE" if stale else "TEXTURED"
    proposed = o.get("proposal") is not None
    if bool(obj.get("rb_proposal", False)) != proposed:
        # A novice's proposal: outlined and labelled until the expert accepts or rejects it.
        obj["rb_proposal"] = proposed
        obj.show_wire = proposed
        obj.show_name = proposed
        obj.show_in_front = proposed


def create_object(kind: str, location_b) -> bpy.types.Object:
    """Operator entry point: create locally and queue object.create."""
    oid = protocol.new_object_id()
    dims = primitives.DEFAULT_DIMENSIONS[kind]
    n = 1 + sum(1 for o in bpy.context.scene.objects if o.get("rb_kind") == kind)
    name = f"{primitives.DEFAULT_NAMES[kind]} {n}"
    mesh = primitives.unit_mesh(kind, name)
    obj = bpy.data.objects.new(name, mesh)
    primitives.ensure_collection(primitives.DESIGN_COLLECTION).objects.link(obj)
    obj["rb_id"] = oid
    obj["rb_kind"] = kind
    obj["rb_room"] = ctrl.room.get("id", "")
    obj["rb_color"] = primitives.DEFAULT_COLORS[kind]
    obj["rb_texture"] = "sample:picture" if kind == "panel" else ""
    obj.rotation_mode = "QUATERNION"
    loc = list(location_b)
    spec = catalog.get(kind)
    if spec["origin"] == "center":
        loc[2] = max(loc[2], ctrl.floor_z + spec["height"])  # wall items (pictures, TVs, windows) at their usual height
    else:
        loc[2] = ctrl.floor_z  # floor-standing objects sit on the scanned floor
    obj.location = loc
    obj.scale = coords.dims_to_blender_scale(dims)
    primitives.apply_materials(obj, kind, obj["rb_color"], obj["rb_texture"] or None)
    state = read_state(obj)
    ctrl.tracker.track_new(oid, kind, state)
    ctrl.dirty = True
    return obj


def _scan_local_changes() -> None:
    index = _index()
    room_id = ctrl.room.get("id", "")
    for oid, obj in index.items():
        if obj.get("rb_room") not in ("", room_id):
            continue
        if oid not in ctrl.tracker.objects:
            continue
        try:
            state = read_state(obj)
        except protocol.ValidationError as exc:
            ctrl.last_error = str(exc)
            server = ctrl.server_objects.get(oid)
            if server:
                _apply_object(server)
            continue
        if state is not None:
            ctrl.tracker.local_state(oid, state)
    # Deletions: tracked objects that disappeared from the scene.
    for oid, t in list(ctrl.tracker.objects.items()):
        if oid in index:
            continue
        if t.revision > 0 and ctrl.session is not None:
            mid = ctrl.session.send("object.delete", {"id": oid})
            if mid:
                ctrl.tracker.forget(oid)
        else:
            ctrl.tracker.forget(oid)


def _flush() -> None:
    s = ctrl.session
    if s is None:
        return
    for oid, msg_type, payload in ctrl.tracker.due():
        try:
            if msg_type == "object.create":
                protocol.validate_object_input(payload["object"])
            else:
                kind = ctrl.tracker.objects[oid].kind
                dims = payload["patch"].get("dimensions")
                if dims is not None:
                    protocol.validate_dimensions(kind, dims)
        except protocol.ValidationError as exc:
            ctrl.last_error = f"Not sent: {exc}"
            server = ctrl.server_objects.get(oid)
            if server:
                _apply_object(server)
            continue
        mid = s.send(msg_type, payload, origin_epoch=ctrl.origin_epoch)
        if mid:
            ctrl.tracker.mark_sent(oid, mid, msg_type)


def replace_stale_objects() -> int:
    """Confirm current Blender poses of stale objects as valid for the new AR origin."""
    s = ctrl.session
    if s is None:
        return 0
    index = _index()
    n = 0
    for oid, o in ctrl.server_objects.items():
        obj = index.get(oid)
        if not o.get("stale") or obj is None:
            continue
        state = read_state(obj)
        mid = s.send("object.update", {"id": oid, "baseRevision": o["revision"],
                                       "patch": {"position": state["position"], "rotation": state["rotation"]}},
                     origin_epoch=ctrl.origin_epoch)
        if mid:
            ctrl.tracker.mark_sent(oid, mid, "object.update")
            n += 1
    return n


# ---------------------------------------------------------------------- scan

def _maybe_fetch_scan(s: RoomSession) -> None:
    meta = ctrl.scan_meta
    if not meta or meta["scanId"] == ctrl.imported_scan_id:
        return
    if meta["originEpoch"] != ctrl.origin_epoch:
        return
    ctrl.scan_status = f"Downloading scan ({meta['bytes'] // 1024} KiB)…"
    s.fetch_scan_async()


def reimport_scan() -> None:
    ctrl.imported_scan_id = ""
    if ctrl.session is not None:
        _maybe_fetch_scan(ctrl.session)


def _remove_scan_object() -> None:
    obj = bpy.data.objects.get(primitives.SCAN_NAME)
    if obj is not None:
        _guarded(lambda: primitives.remove_object(obj))


def _import_scan(data: bytes) -> None:
    try:
        scan = scan_format.decode(data)
    except ValueError as exc:
        ctrl.scan_status = f"Invalid scan: {exc}"
        return
    if scan.origin_epoch != ctrl.origin_epoch:
        ctrl.scan_status = "Ignored a scan from an old AR origin"
        return

    def work():
        _remove_scan_object()
        mesh = bpy.data.meshes.new(primitives.SCAN_NAME)
        mesh.from_pydata(scan_format.to_blender(scan), [], scan.triangles)
        mesh.validate(clean_customdata=False)
        mesh.update()
        obj = bpy.data.objects.new(primitives.SCAN_NAME, mesh)
        coll = primitives.ensure_collection(primitives.SCAN_COLLECTION, selectable=False)
        coll.objects.link(obj)
        obj["rb_scan_epoch"] = scan.origin_epoch
        obj.hide_select = True
        obj.lock_location = (True, True, True)
        obj.lock_rotation = (True, True, True)
        obj.lock_scale = (True, True, True)
        mesh.materials.append(primitives.ghost_material("RB Scan", "#9aa3a8", 0.55))
        obj.show_wire = True

    _guarded(work)
    meta = ctrl.scan_meta or {}
    ctrl.imported_scan_id = meta.get("scanId", "")
    floor = scan_format.estimate_floor_y(scan)
    ctrl.floor_z = floor if floor is not None else 0.0
    label = "SAMPLE ROOM (simulated) " if scan.synthetic else ""
    floor_note = f", floor at Z {ctrl.floor_z:+.2f} m" if floor is not None else ", floor not found"
    ctrl.scan_status = f"{label}Scan imported: {len(scan.vertices)} vertices, {len(scan.triangles)} triangles (approximate){floor_note}"


# ---------------------------------------------------------------------- guidance

def _remove_attempt_object() -> None:
    obj = bpy.data.objects.get(primitives.ATTEMPT_NAME)
    if obj is not None:
        _guarded(lambda: primitives.remove_object(obj))


def target_ghost() -> Optional[bpy.types.Object]:
    return bpy.data.objects.get(primitives.TARGET_NAME)


def place_target_ghost(design_obj: bpy.types.Object) -> bpy.types.Object:
    """Create (or move) the expert's ghost target, a wireframe twin of the design object."""
    def work():
        ghost = target_ghost()
        if ghost is None or ghost.get("rb_target_of") != design_obj.get("rb_id"):
            if ghost is not None:
                primitives.remove_object(ghost)
            mesh = design_obj.data.copy()
            ghost = bpy.data.objects.new(primitives.TARGET_NAME, mesh)
            primitives.ensure_collection(primitives.GUIDE_COLLECTION).objects.link(ghost)
            mesh.materials.clear()
            mesh.materials.append(primitives.ghost_material("RB Target", "#2fa4a9", 0.35))
        ghost["rb_target_of"] = design_obj["rb_id"]
        ghost.display_type = "WIRE"
        ghost.show_in_front = True
        ghost.show_name = True
        ghost.rotation_mode = "QUATERNION"
        ghost.matrix_basis = design_obj.matrix_basis.copy()
        return ghost

    return _guarded(work)


def _sync_guidance_objects() -> None:
    g = ctrl.guidance
    if g is None:
        _remove_attempt_object()
        return
    design = _index().get(g["objectId"])
    # Ghost target follows the server only when the server's target changed.
    sig = (g["id"], tuple(round(c, 4) for c in g["target"]["position"]))
    if sig != ctrl.last_target_sig and design is not None:
        ctrl.last_target_sig = sig
        ghost = place_target_ghost(design)
        _guarded(lambda: setattr(ghost, "location", coords.c2b(g["target"]["position"])))
    attempt = g.get("attempt")
    if attempt is None or g["state"] == "preview" or design is None:
        _remove_attempt_object()
        return

    def work():
        obj = bpy.data.objects.get(primitives.ATTEMPT_NAME)
        if obj is None or obj.get("rb_attempt_of") != g["objectId"]:
            if obj is not None:
                primitives.remove_object(obj)
            mesh = design.data.copy()
            mesh.materials.clear()
            mesh.materials.append(primitives.ghost_material("RB Attempt", "#e8892b", 0.6))
            obj = bpy.data.objects.new(primitives.ATTEMPT_NAME, mesh)
            primitives.ensure_collection(primitives.GUIDE_COLLECTION).objects.link(obj)
            obj["rb_attempt_of"] = g["objectId"]
            obj.hide_select = True  # the novice owns the attempt; the expert cannot drag it
            obj.show_name = True
            obj.show_wire = True
            obj.show_in_front = True
            obj.rotation_mode = "QUATERNION"
        obj.matrix_basis = design.matrix_basis.copy()
        obj.location = coords.c2b(attempt["position"])

    _guarded(work)


def send_target(design_obj: bpy.types.Object, axis_choice: str, tolerance: float) -> str:
    s = ctrl.session
    ghost = target_ghost()
    if s is None or ghost is None:
        return "Place a target ghost first"
    oid = design_obj["rb_id"]
    server = ctrl.server_objects.get(oid)
    if server is None:
        return "Object is not synced yet"
    start = server["position"]
    target_c = coords.b2c(ghost.matrix_basis.translation)
    delta = [target_c[i] - start[i] for i in range(3)]
    axis = coords.dominant_axis(delta) if axis_choice == "AUTO" else coords.BLENDER_AXIS_TO_CANONICAL[axis_choice]
    _offset, snapped, perp = coords.project_onto_axis(start, axis, target_c)
    note = ""
    if perp > 0.001:
        _guarded(lambda: setattr(ghost, "location", coords.c2b(snapped)))
        note = f" (snapped {perp * 100:.1f} cm onto the {coords.CANONICAL_AXIS_TO_BLENDER[axis]} axis)"
    s.send("guidance.set", {"objectId": oid, "axis": axis, "targetPosition": list(snapped), "tolerance": tolerance},
           origin_epoch=ctrl.origin_epoch)
    return "Target sent" + note


def pending_proposals() -> List[Dict[str, Any]]:
    return sorted((o for o in ctrl.server_objects.values() if o.get("proposal")), key=lambda o: o["proposal"]["proposedAt"])


def proposal_command(msg_type: str, oid: str, note: str = "") -> str:
    """Accept or reject a novice's proposal. Local edits to it are sent first, so the
    novice is told about the expert's adjustment."""
    s = ctrl.session
    o = ctrl.server_objects.get(oid)
    if s is None or o is None or not o.get("proposal"):
        return "That proposal is no longer pending"
    t = ctrl.tracker.objects.get(oid)
    if t is not None:
        t.last_change -= 1.0  # treat any recent drag as settled so it is published now
    _scan_local_changes()
    _flush()
    payload: Dict[str, Any] = {"id": oid}
    if note.strip():
        payload["note"] = note.strip()[:300]
    s.send(msg_type, payload)
    verb = "Accepted" if msg_type == "proposal.accept" else "Rejected"
    return f"{verb} {o['proposal']['byName']}’s “{o['name']}”"


def send_lesson(preset: str, design_obj: Optional[bpy.types.Object], **options: Any) -> str:
    """Send a teaching prompt; move/rotate/scale demonstrate on the selected design object."""
    s = ctrl.session
    if s is None:
        return "Not connected"
    obj = None
    if design_obj is not None and "rb_id" in design_obj:
        obj = ctrl.server_objects.get(design_obj["rb_id"])
    try:
        payload = lessons.build(preset, obj, **options)
    except ValueError as exc:
        return str(exc)
    s.send("lesson.prompt", payload, origin_epoch=ctrl.origin_epoch)
    return f"Prompt sent: {payload['text'][:60]}"


def clear_lesson() -> str:
    s = ctrl.session
    if s is None or ctrl.lesson is None:
        return "No prompt to clear"
    s.send("lesson.clear", {"lessonId": ctrl.lesson["id"]})
    return "Prompt cleared"


def guidance_command(msg_type: str) -> str:
    s = ctrl.session
    g = ctrl.guidance
    if s is None or g is None:
        return "No guidance exercise"
    mid = s.send(msg_type, {"guidanceId": g["id"]}, origin_epoch=ctrl.origin_epoch if msg_type in protocol.EPOCH_BOUND else None)
    if mid and msg_type == "guidance.approve":
        ctrl.approving_object = g["objectId"]
    return {"guidance.begin": "Exercise started", "guidance.approve": "Attempt approved",
            "guidance.reset": "Attempt reset", "guidance.cancel": "Guidance cancelled"}.get(msg_type, "Sent")
