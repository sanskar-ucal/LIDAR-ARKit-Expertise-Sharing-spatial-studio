"""RoomBridge sidebar panel, operators and properties."""

from __future__ import annotations

import ipaddress
import re
import socket
import time
from urllib.parse import urlsplit

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, PointerProperty, StringProperty

from . import coords, protocol, sync

ROLE_LABEL = {"host": "Host (phone)", "expert": "Expert", "viewer": "Family"}


def _addon_prefs():
    addon = bpy.context.preferences.addons.get(__package__)
    return addon.preferences if addon else None


NO_CREDENTIAL = ("That link has no credential (#t=…). Opening it in a browser removes it; "
                 "tap Copy expert invite on the phone and paste here.")


def _apply_invite(self, text: str) -> bool:
    parsed = protocol.parse_invite(text)
    if parsed:
        self.server_url = parsed["server"]
        self.room_code = parsed["code"]
        self.token = parsed["token"]
        sync.ctrl.last_error = ""
        return True
    if "/r/" in text:
        sync.ctrl.last_error = NO_CREDENTIAL
    return False


def _on_invite(self, _context):
    if self.invite and (_apply_invite(self, self.invite) or "/r/" in self.invite):
        self.invite = ""  # do not leave the credential on screen


def _on_token(self, _context):
    # A full invite pasted into the credential field (or a field-crossing paste) still works.
    if "/r/" in self.token or "://" in self.token:
        text = self.token
        if not _apply_invite(self, text):
            self.token = ""


def _on_room_code(self, _context):
    if "/r/" in self.room_code:
        text = self.room_code
        if not _apply_invite(self, text):
            m = re.search(r"/r/([A-Za-z0-9]{4,12})", text)
            self.room_code = m.group(1).upper() if m else ""


class RBSettings(bpy.types.PropertyGroup):
    # Stored on the WindowManager: runtime only, never saved into the .blend file.
    invite: StringProperty(name="Expert invite", description="Paste the expert invite link from the phone", update=_on_invite)
    server_url: StringProperty(name="Server", default="http://127.0.0.1:8787")
    room_code: StringProperty(name="Room code", update=_on_room_code)
    token: StringProperty(name="Expert credential", subtype="PASSWORD", update=_on_token)
    display_name: StringProperty(name="Your name", default="Expert")
    axis: EnumProperty(
        name="Axis",
        items=[
            ("AUTO", "Auto", "Use the axis with the largest movement from the object to the target"),
            ("X", "X (red, left/right)", ""),
            ("Y", "Y (green, forward/back)", ""),
            ("Z", "Z (blue, up/down)", ""),
        ],
        default="AUTO",
    )
    tolerance: FloatProperty(name="Tolerance", default=0.05, min=0.01, max=0.5, unit="LENGTH", precision=3)
    status_message: StringProperty(default="")


class RBPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__
    default_server: StringProperty(name="Default server URL", default="http://127.0.0.1:8787")
    default_name: StringProperty(name="Default display name", default="Expert")

    def draw(self, _context):
        self.layout.prop(self, "default_server")
        self.layout.prop(self, "default_name")


def _settings(context) -> RBSettings:
    return context.window_manager.roombridge


def _is_private_host(url: str) -> bool:
    host = urlsplit(url).hostname or ""
    if host in ("localhost",) or host.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or _is_own_address(ip)


def _is_own_address(ip) -> bool:
    # The server usually runs on this Mac; on an IPv6-only hotspot its address is a global IPv6 one.
    # Binding succeeds only for addresses assigned to this machine; nothing is sent.
    family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_DGRAM) as s:
            s.bind((str(ip), 0))
        return True
    except OSError:
        return False


# ---------------------------------------------------------------------- operators

class ROOMBRIDGE_OT_connect(bpy.types.Operator):
    bl_idname = "roombridge.connect"
    bl_label = "Connect"
    bl_description = "Join the room as the expert"

    def execute(self, context):
        st = _settings(context)
        if not (st.server_url and st.room_code and st.token):
            self.report({"ERROR"}, "Server, room code and expert credential are required")
            return {"CANCELLED"}
        if not getattr(bpy.app, "online_access", True) and not _is_private_host(st.server_url):
            self.report({"ERROR"}, "Online access is disabled (Preferences > System > Network). Only local servers are allowed.")
            return {"CANCELLED"}
        try:
            sync.connect(st.server_url, st.room_code, st.token, st.display_name)
        except ValueError as exc:
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}
        prefs = _addon_prefs()
        if prefs:
            prefs.default_server = st.server_url
            prefs.default_name = st.display_name
        return {"FINISHED"}


class ROOMBRIDGE_OT_disconnect(bpy.types.Operator):
    bl_idname = "roombridge.disconnect"
    bl_label = "Disconnect"

    def execute(self, _context):
        sync.disconnect()
        return {"FINISHED"}


class ROOMBRIDGE_OT_add_object(bpy.types.Operator):
    bl_idname = "roombridge.add_object"
    bl_label = "Add RoomBridge object"
    bl_options = {"REGISTER", "UNDO"}
    kind: EnumProperty(items=[("pillar", "Pillar", ""), ("partition", "Partition", ""), ("panel", "Picture Panel", "")])

    @classmethod
    def poll(cls, _context):
        return sync.is_connected() and bool(sync.ctrl.room)

    def execute(self, context):
        obj = sync.create_object(self.kind, context.scene.cursor.location)
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        return {"FINISHED"}


def _design_for(context):
    obj = context.active_object
    if obj is None:
        return None
    if "rb_id" in obj:
        return obj
    if "rb_target_of" in obj:
        return sync._index().get(obj["rb_target_of"])
    return None


class ROOMBRIDGE_OT_place_target(bpy.types.Operator):
    bl_idname = "roombridge.place_target"
    bl_label = "Place Target Ghost"
    bl_description = "Create a ghost copy of the selected object; move it (G + axis) to where the novice should place it"

    @classmethod
    def poll(cls, context):
        return sync.is_connected() and _design_for(context) is not None

    def execute(self, context):
        design = _design_for(context)
        ghost = sync.place_target_ghost(design)
        for o in context.selected_objects:
            o.select_set(False)
        ghost.select_set(True)
        context.view_layer.objects.active = ghost
        self.report({"INFO"}, "Move the ghost along one axis (e.g. G X), then press Send Target")
        return {"FINISHED"}


class ROOMBRIDGE_OT_send_target(bpy.types.Operator):
    bl_idname = "roombridge.send_target"
    bl_label = "Send Target"

    @classmethod
    def poll(cls, context):
        return sync.is_connected() and sync.target_ghost() is not None

    def execute(self, context):
        ghost = sync.target_ghost()
        design = sync._index().get(ghost.get("rb_target_of", ""))
        if design is None:
            self.report({"ERROR"}, "The ghost's design object no longer exists")
            return {"CANCELLED"}
        st = _settings(context)
        msg = sync.send_target(design, st.axis, st.tolerance)
        st.status_message = msg
        self.report({"INFO"}, msg)
        return {"FINISHED"}


class ROOMBRIDGE_OT_guidance(bpy.types.Operator):
    bl_idname = "roombridge.guidance"
    bl_label = "Guidance"
    action: EnumProperty(items=[("guidance.begin", "Begin", ""), ("guidance.approve", "Approve", ""),
                                ("guidance.reset", "Reset", ""), ("guidance.cancel", "Cancel", "")])

    @classmethod
    def poll(cls, _context):
        return sync.is_connected() and sync.ctrl.guidance is not None

    def execute(self, context):
        msg = sync.guidance_command(self.action)
        _settings(context).status_message = msg
        return {"FINISHED"}


class ROOMBRIDGE_OT_reimport_scan(bpy.types.Operator):
    bl_idname = "roombridge.reimport_scan"
    bl_label = "Re-import Scan"

    @classmethod
    def poll(cls, _context):
        return sync.is_connected() and sync.ctrl.scan_meta is not None

    def execute(self, _context):
        sync.reimport_scan()
        return {"FINISHED"}


class ROOMBRIDGE_OT_replace_stale(bpy.types.Operator):
    bl_idname = "roombridge.replace_stale"
    bl_label = "Confirm Positions for New Scan"
    bl_description = "After an AR reset, move stale objects to the right places in the new scan, then confirm"

    @classmethod
    def poll(cls, _context):
        return sync.is_connected() and any(o.get("stale") for o in sync.ctrl.server_objects.values())

    def execute(self, _context):
        n = sync.replace_stale_objects()
        self.report({"INFO"}, f"Re-placed {n} object(s)")
        return {"FINISHED"}


# ---------------------------------------------------------------------- panels

class _Base:
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "RoomBridge"


class ROOMBRIDGE_PT_design(_Base, bpy.types.Panel):
    bl_label = "Design Objects"
    bl_parent_id = "ROOMBRIDGE_PT_main"

    @classmethod
    def poll(cls, _context):
        return sync.ctrl.session is not None

    def draw(self, _context):
        c = sync.ctrl
        layout = self.layout
        layout.label(text="Structure & Openings:")
        row = layout.row(align=True)
        row.operator("roombridge.add_object", text="Pillar", icon="MESH_CYLINDER").kind = "pillar"
        row.operator("roombridge.add_object", text="Partition", icon="MESH_CUBE").kind = "partition"
        row.operator("roombridge.add_object", text="Doorway", icon="MESH_GRID").kind = "doorway"
        row.operator("roombridge.add_object", text="Window", icon="MESH_UVSPHERE").kind = "window"
        layout.label(text="Furniture:")
        row = layout.row(align=True)
        row.operator("roombridge.add_object", text="Table", icon="MESH_TABLE").kind = "table"
        row.operator("roombridge.add_object", text="Chair", icon="CHAIR_SET").kind = "chair"
        row.operator("roombridge.add_object", text="Couch", icon="OUTLINER_OB_GROUP_INSTANCE").kind = "couch"
        row.operator("roombridge.add_object", text="Cabinet", icon="MESH_CUBE").kind = "cabinet"
        layout.label(text="Electronics & Decor:")
        row = layout.row(align=True)
        row.operator("roombridge.add_object", text="TV", icon="TV").kind = "tv"
        row.operator("roombridge.add_object", text="Picture", icon="IMAGE_PLANE").kind = "panel"
        row.operator("roombridge.add_object", text="Light", icon="LIGHT_DATA").kind = "light"
        row.operator("roombridge.add_object", text="Lamp", icon="LIGHT_POINT").kind = "lamp"
        layout.label(text="Edit with Move (G), Rotate (R), Scale (S). Delete (X) syncs.")
        col = layout.column(align=True)
        for o in sorted(c.server_objects.values(), key=lambda o: o["name"]):
            r = c.reactions.get(o["id"], {})
            likes, discuss = len(r.get("like", [])), len(r.get("discuss", []))
            n_comments = sum(1 for k in c.comments if k.get("objectId") == o["id"])
            extra = f"  {likes} like" if likes else ""
            extra += f"  {discuss} discuss" if discuss else ""
            extra += f"  {n_comments} comment(s)" if n_comments else ""
            col.label(text=f"{o['name']}  r{o['revision']}{'  STALE' if o.get('stale') else ''}{extra}")
        box = layout.box()
        box.label(text="Not synced (local only):", icon="INFO")
        box.label(text="mesh/edit-mode edits, modifiers, parenting,")
        box.label(text="materials, animation, negative scale.")

class ROOMBRIDGE_PT_people(_Base, bpy.types.Panel):
    bl_label = "Participants"
    bl_parent_id = "ROOMBRIDGE_PT_main"

    @classmethod
    def poll(cls, _context):
        return sync.ctrl.session is not None

    def draw(self, _context):
        c = sync.ctrl
        col = self.layout.column(align=True)
        for p in c.participants:
            state = "" if p["connected"] else "  (disconnected)"
            col.label(text=f"{p['displayName']} — {ROLE_LABEL.get(p['role'], p['role'])}{state}",
                      icon="USER" if p["connected"] else "GHOST_DISABLED")
        prev = c.preview
        if prev:
            col.separator()
            col.label(text=f"Phone preview: {prev.get('state', '?')} · {prev.get('viewers', 0)} watching",
                      icon="REC" if prev.get("state") == "live" else "PAUSE")


class ROOMBRIDGE_PT_room(_Base, bpy.types.Panel):
    bl_label = "Room Scan"
    bl_parent_id = "ROOMBRIDGE_PT_main"

    @classmethod
    def poll(cls, _context):
        return sync.ctrl.session is not None

    def draw(self, _context):
        c = sync.ctrl
        col = self.layout.column()
        col.label(text=c.scan_status, icon="MESH_GRID")
        col.label(text="Scan is an approximate, locked reference.")
        col.operator("roombridge.reimport_scan", icon="IMPORT")
        stale = [o for o in c.server_objects.values() if o.get("stale")]
        if stale:
            col.label(text=f"{len(stale)} object(s) from a previous AR origin (shown as wire)", icon="ERROR")
            col.operator("roombridge.replace_stale", icon="CHECKMARK")
        if c.foreign_objects:
            col.label(text=f"{c.foreign_objects} RoomBridge object(s) from another room are ignored", icon="INFO")


class ROOMBRIDGE_PT_design(_Base, bpy.types.Panel):
    bl_label = "Design Objects"
    bl_parent_id = "ROOMBRIDGE_PT_main"

    @classmethod
    def poll(cls, _context):
        return sync.ctrl.session is not None

    def draw(self, _context):
        c = sync.ctrl
        layout = self.layout
        row = layout.row(align=True)
        row.operator("roombridge.add_object", text="Pillar", icon="MESH_CYLINDER").kind = "pillar"
        row.operator("roombridge.add_object", text="Partition", icon="MESH_CUBE").kind = "partition"
        row.operator("roombridge.add_object", text="Picture", icon="IMAGE_PLANE").kind = "panel"
        layout.label(text="Edit with Move (G), Rotate (R), Scale (S). Delete (X) syncs.")
        col = layout.column(align=True)
        for o in sorted(c.server_objects.values(), key=lambda o: o["name"]):
            r = c.reactions.get(o["id"], {})
            likes, discuss = len(r.get("like", [])), len(r.get("discuss", []))
            n_comments = sum(1 for k in c.comments if k.get("objectId") == o["id"])
            extra = f"  {likes} like" if likes else ""
            extra += f"  {discuss} discuss" if discuss else ""
            extra += f"  {n_comments} comment(s)" if n_comments else ""
            col.label(text=f"{o['name']}  r{o['revision']}{'  STALE' if o.get('stale') else ''}{extra}")
        box = layout.box()
        box.label(text="Not synced (local only):", icon="INFO")
        box.label(text="mesh/edit-mode edits, modifiers, parenting,")
        box.label(text="materials, animation, negative scale.")


class ROOMBRIDGE_PT_guidance(_Base, bpy.types.Panel):
    bl_label = "Guide the Novice"
    bl_parent_id = "ROOMBRIDGE_PT_main"

    @classmethod
    def poll(cls, _context):
        return sync.ctrl.session is not None

    def draw(self, context):
        st = _settings(context)
        c = sync.ctrl
        layout = self.layout
        col = layout.column(align=True)
        col.operator("roombridge.place_target", icon="GHOST_ENABLED")
        col.prop(st, "axis")
        col.prop(st, "tolerance")
        col.operator("roombridge.send_target", icon="EXPORT")
        g = c.guidance
        if g is None:
            layout.label(text="No exercise. Select an object, place a ghost, move it along one axis.")
            return
        obj = c.server_objects.get(g["objectId"], {})
        box = layout.box()
        axis_b = coords.CANONICAL_AXIS_TO_BLENDER[g["axis"]]
        box.label(text=f"{obj.get('name', '?')}: {g['state'].upper()} along {axis_b}, ±{g['tolerance'] * 100:.0f} cm")
        a = g.get("attempt")
        if a:
            moving = "moving now" if a["holding"] else "released"
            ok = "WITHIN TOLERANCE" if a["withinTolerance"] else f"{a['distance'] * 100:.1f} cm from target"
            box.label(text=f"Novice attempt: {ok} ({moving})", icon="CHECKMARK" if a["withinTolerance"] else "ORIENTATION_GIMBAL")
        row = layout.row(align=True)
        row.operator("roombridge.guidance", text="Begin", icon="PLAY").action = "guidance.begin"
        row.operator("roombridge.guidance", text="Approve", icon="CHECKMARK").action = "guidance.approve"
        row = layout.row(align=True)
        row.operator("roombridge.guidance", text="Reset Attempt", icon="LOOP_BACK").action = "guidance.reset"
        row.operator("roombridge.guidance", text="Cancel", icon="X").action = "guidance.cancel"
        if st.status_message:
            layout.label(text=st.status_message)


class ROOMBRIDGE_PT_discussion(_Base, bpy.types.Panel):
    bl_label = "Discussion"
    bl_parent_id = "ROOMBRIDGE_PT_main"

    @classmethod
    def poll(cls, _context):
        return sync.ctrl.session is not None

    def draw(self, _context):
        c = sync.ctrl
        col = self.layout.column(align=True)
        if not c.comments:
            col.label(text="No comments yet")
        for k in c.comments[-8:]:
            about = ""
            if k.get("objectName"):
                about = f" on {k['objectName']}" + (" (deleted)" if k.get("objectDeleted") else "")
            col.label(text=f"{k['authorName']}{about}:", icon="COMMUNITY")
            col.label(text=f"   {k['text'][:80]}")


class ROOMBRIDGE_PT_debug(_Base, bpy.types.Panel):
    bl_label = "Developer"
    bl_parent_id = "ROOMBRIDGE_PT_main"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, _context):
        c = sync.ctrl
        s = c.session
        col = self.layout.column(align=True)
        col.label(text=f"clientId {s.client_id if s else '-'}")
        col.label(text=f"roomId {c.room.get('id', '-')}")
        col.label(text=f"sceneRevision {c.room.get('sceneRevision', '-')}, epoch {c.origin_epoch}")
        col.label(text=f"tracked {len(c.tracker.objects)}, in flight {sum(1 for t in c.tracker.objects.values() if t.in_flight)}")
        col.label(text=f"reconnects {s.reconnects if s else 0}, timer {bpy.app.timers.is_registered(sync._tick)}")
        col.label(text=f"credential {protocol.redact(s._token) if s else '-'}")


CLASSES = (
    RBSettings,
    RBPreferences,
    ROOMBRIDGE_OT_connect,
    ROOMBRIDGE_OT_disconnect,
    ROOMBRIDGE_OT_add_object,
    ROOMBRIDGE_OT_place_target,
    ROOMBRIDGE_OT_send_target,
    ROOMBRIDGE_OT_guidance,
    ROOMBRIDGE_OT_reimport_scan,
    ROOMBRIDGE_OT_replace_stale,
    ROOMBRIDGE_PT_main,
    ROOMBRIDGE_PT_people,
    ROOMBRIDGE_PT_room,
    ROOMBRIDGE_PT_design,
    ROOMBRIDGE_PT_guidance,
    ROOMBRIDGE_PT_discussion,
    ROOMBRIDGE_PT_debug,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.WindowManager.roombridge = PointerProperty(type=RBSettings)
    # Seed defaults from preferences once the WM exists.
    def seed():
        prefs = _addon_prefs()
        wm = bpy.context.window_manager
        if prefs and wm and hasattr(wm, "roombridge"):
            wm.roombridge.server_url = prefs.default_server
            wm.roombridge.display_name = prefs.default_name
        return None
    bpy.app.timers.register(seed, first_interval=0.5)


def unregister():
    sync.disconnect()
    del bpy.types.WindowManager.roombridge
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)

