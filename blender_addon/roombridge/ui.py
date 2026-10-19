"""RoomBridge sidebar panel, operators and properties."""

from __future__ import annotations

import ipaddress
import re
import socket
import time
from urllib.parse import urlsplit

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, PointerProperty, StringProperty

from . import catalog, coords, lessons, protocol, sync

ROLE_LABEL = {"host": "Novice (phone)", "expert": "Expert", "viewer": "Observer"}


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
    proposal_note: StringProperty(name="Note", description="Optional feedback sent to the novice with Accept or Reject", maxlen=300)
    lesson_preset: EnumProperty(
        name="Prompt",
        items=[
            ("scan", "Scan the room", "Ask the novice to scan the whole room (completes when the scan arrives)"),
            ("place", "Place a piece", "Ask the novice to propose a piece from the phone's library (completes when they do)"),
            ("move", "Show: move (G)", "Loop a ghost of the selected object moving along one axis on the phone"),
            ("rotate", "Show: rotate (R Z)", "Loop a ghost of the selected object turning on the phone"),
            ("scale", "Show: scale (S)", "Loop a ghost of the selected object growing along one axis on the phone"),
            ("custom", "Custom task", "Your own instruction"),
        ],
        default="scan",
    )
    lesson_axis: EnumProperty(name="Axis", items=[("X", "X (red)", ""), ("Y", "Y (green)", ""), ("Z", "Z (blue)", "")], default="X")
    lesson_distance: FloatProperty(name="Distance", default=0.5, min=-5, max=5, unit="LENGTH", precision=2)
    lesson_angle: FloatProperty(name="Angle (°)", default=90, min=-180, max=180, precision=0)
    lesson_factor: FloatProperty(name="Factor", default=1.25, min=0.2, max=4, precision=2)
    lesson_kind: EnumProperty(name="Piece", items=[(k["kind"], k["label"], "") for k in catalog.DATA["kinds"]], default="chair")
    lesson_text: StringProperty(name="Text", description="Leave empty for a ready-made instruction", maxlen=200)


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
    kind: EnumProperty(items=[(k["kind"], k["label"], k["lesson"]) for k in catalog.DATA["kinds"]])

    @classmethod
    def poll(cls, _context):
        return sync.is_connected() and bool(sync.ctrl.room)

    @classmethod
    def description(cls, _context, properties):
        k = catalog.get(properties.kind)
        return f"Add a {k['label'].lower()} at the 3D cursor. {k['lesson']}"

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
    if "rb_target_of" in obj:
        obj = sync._index().get(obj["rb_target_of"])
    if obj is None or "rb_id" not in obj:
        return None
    if (sync.ctrl.server_objects.get(obj["rb_id"]) or {}).get("proposal"):
        return None  # accept the novice's proposal before guiding it
    return obj


PROPOSAL_ACTIONS = [
    ("proposal.accept", "Accept", "Keep it, including any changes you made to it, and tell the novice"),
    ("proposal.reject", "Reject", "Remove it and tell the novice why (use the note)"),
]


class ROOMBRIDGE_OT_proposal(bpy.types.Operator):
    bl_idname = "roombridge.proposal"
    bl_label = "Review Proposal"
    action: EnumProperty(items=PROPOSAL_ACTIONS)
    object_id: StringProperty()

    @classmethod
    def poll(cls, _context):
        return sync.is_connected()

    @classmethod
    def description(cls, _context, properties):
        return {a: d for a, _label, d in PROPOSAL_ACTIONS}[properties.action]

    def execute(self, context):
        st = _settings(context)
        msg = sync.proposal_command(self.action, self.object_id, st.proposal_note)
        st.proposal_note = ""
        st.status_message = msg
        self.report({"INFO"}, msg)
        return {"FINISHED"}


class ROOMBRIDGE_OT_send_lesson(bpy.types.Operator):
    bl_idname = "roombridge.send_lesson"
    bl_label = "Send Prompt"
    bl_description = "Show this prompt on the novice's phone; demos loop a ghost of the selected object"

    @classmethod
    def poll(cls, _context):
        return sync.is_connected()

    def execute(self, context):
        st = _settings(context)
        design = _design_for(context) if st.lesson_preset in lessons.NEEDS_OBJECT else None
        msg = sync.send_lesson(st.lesson_preset, design, axis=st.lesson_axis, distance=st.lesson_distance,
                               angle=st.lesson_angle, factor=st.lesson_factor, kind=st.lesson_kind, text=st.lesson_text)
        st.status_message = msg
        self.report({"INFO"} if msg.startswith("Prompt sent") else {"WARNING"}, msg)
        return {"FINISHED"}


class ROOMBRIDGE_OT_clear_lesson(bpy.types.Operator):
    bl_idname = "roombridge.clear_lesson"
    bl_label = "Clear Prompt"

    @classmethod
    def poll(cls, _context):
        return sync.is_connected() and sync.ctrl.lesson is not None

    def execute(self, context):
        _settings(context).status_message = sync.clear_lesson()
        return {"FINISHED"}


class ROOMBRIDGE_OT_select_object(bpy.types.Operator):
    bl_idname = "roombridge.select_object"
    bl_label = "Select"
    bl_description = "Select this object so you can inspect or adjust it (G, R, S) before deciding"
    object_id: StringProperty()

    def execute(self, context):
        obj = sync._index().get(self.object_id)
        if obj is None:
            return {"CANCELLED"}
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        return {"FINISHED"}


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


class ROOMBRIDGE_PT_main(_Base, bpy.types.Panel):
    bl_label = "RoomBridge"
    bl_idname = "ROOMBRIDGE_PT_main"

    def draw(self, context):
        layout = self.layout
        st = _settings(context)
        c = sync.ctrl
        connected = sync.is_connected()
        icon = "CHECKMARK" if connected else ("ERROR" if c.status.startswith("Error") else "TIME" if c.session else "UNLINKED")
        box = layout.box()
        box.label(text=c.status, icon=icon)
        if c.last_sync:
            box.label(text=f"Last sync {max(0, int(time.time() - c.last_sync))} s ago")
        if c.session is None:
            col = layout.column(align=True)
            col.prop(st, "invite", text="Invite", icon="PASTEDOWN")
            col.separator()
            col.prop(st, "server_url")
            col.prop(st, "room_code")
            col.prop(st, "token")
            col.prop(st, "display_name")
            layout.operator("roombridge.connect", icon="LINKED")
        else:
            row = layout.row()
            row.label(text=f"Room {c.room.get('code', st.room_code)}  ·  origin epoch {c.origin_epoch}")
            layout.operator("roombridge.disconnect", icon="UNLINKED")
        if c.last_error:
            layout.label(text=c.last_error[:90], icon="INFO")
        if c.last_info:
            layout.label(text=c.last_info[:90], icon="LIGHT")


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
            col.label(text=f"{p['displayName']}: {ROLE_LABEL.get(p['role'], p['role'])}{state}",
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
        for group, kinds in catalog.groups():
            layout.label(text=group)
            grid = layout.grid_flow(row_major=True, columns=3, even_columns=True, align=True)
            for k in kinds:
                grid.operator("roombridge.add_object", text=k["label"], icon=k["blenderIcon"]).kind = k["kind"]
        layout.label(text="Edit with Move (G), Rotate (R), Scale (S). Delete (X) syncs.")
        layout.label(text="The phone narrates each edit to the novice as a CAD lesson.", icon="INFO")
        col = layout.column(align=True)
        for o in sorted(c.server_objects.values(), key=lambda o: o["name"]):
            r = c.reactions.get(o["id"], {})
            likes, discuss = len(r.get("like", [])), len(r.get("discuss", []))
            n_comments = sum(1 for k in c.comments if k.get("objectId") == o["id"])
            extra = f"  {likes} like" if likes else ""
            extra += f"  {discuss} discuss" if discuss else ""
            extra += f"  {n_comments} comment(s)" if n_comments else ""
            proposed = "  PROPOSAL" if o.get("proposal") else ""
            col.label(text=f"{o['name']}  r{o['revision']}{'  STALE' if o.get('stale') else ''}{proposed}{extra}")
        box = layout.box()
        box.label(text="Not synced (local only):", icon="INFO")
        box.label(text="mesh/edit-mode edits, modifiers, parenting,")
        box.label(text="materials, animation, negative scale.")


OUTCOME_LABEL = {"accepted": ("Accepted", "CHECKMARK"), "adjusted": ("Accepted with your changes", "MODIFIER"),
                 "rejected": ("Rejected", "X")}


class ROOMBRIDGE_PT_proposals(_Base, bpy.types.Panel):
    bl_label = "Novice Proposals"
    bl_parent_id = "ROOMBRIDGE_PT_main"

    @classmethod
    def poll(cls, _context):
        return sync.ctrl.session is not None

    def draw(self, context):
        st = _settings(context)
        c = sync.ctrl
        layout = self.layout
        pending = sync.pending_proposals()
        if not pending:
            layout.label(text="Nothing to review. The novice can place objects from the phone.")
        else:
            layout.label(text="Select one, adjust it (G/R/S) if needed, then decide:")
            layout.prop(st, "proposal_note", text="Note", icon="TEXT")
        for o in pending:
            box = layout.box()
            box.label(text=f"{o['proposal']['byName']}: {o['name']} ({catalog.get(o['kind'])['label']})", icon="USER")
            row = box.row(align=True)
            op = row.operator("roombridge.select_object", text="Select", icon="RESTRICT_SELECT_OFF")
            op.object_id = o["id"]
            op = row.operator("roombridge.proposal", text="Accept", icon="CHECKMARK")
            op.action, op.object_id = "proposal.accept", o["id"]
            op = row.operator("roombridge.proposal", text="Reject", icon="X")
            op.action, op.object_id = "proposal.reject", o["id"]
        if c.proposal_log:
            col = layout.column(align=True)
            col.label(text="Recent decisions:")
            for r in c.proposal_log[:4]:
                label, icon = OUTCOME_LABEL.get(r["outcome"], (r["outcome"], "DOT"))
                col.label(text=f"{label}: {r['objectName']}" + (f": “{r['note'][:40]}”" if r.get("note") else ""), icon=icon)


LESSON_STATE = {"open": ("Waiting for the novice", "TIME"), "done": ("Novice says done", "CHECKMARK")}


class ROOMBRIDGE_PT_teach(_Base, bpy.types.Panel):
    bl_label = "Teach (Prompts & Show Me)"
    bl_parent_id = "ROOMBRIDGE_PT_main"

    @classmethod
    def poll(cls, _context):
        return sync.ctrl.session is not None

    def draw(self, context):
        st = _settings(context)
        c = sync.ctrl
        layout = self.layout
        col = layout.column(align=True)
        col.prop(st, "lesson_preset")
        if st.lesson_preset in lessons.NEEDS_OBJECT:
            design = _design_for(context)
            col.label(text=f"Demonstrate on: {design.name}" if design else "Select a design object to demonstrate on",
                      icon="OBJECT_DATA" if design else "ERROR")
            col.prop(st, "lesson_axis")
            if st.lesson_preset == "move":
                col.prop(st, "lesson_distance")
            elif st.lesson_preset == "rotate":
                col.label(text="Turns around Z (blue, vertical)")
                col.prop(st, "lesson_angle")
            else:
                col.prop(st, "lesson_factor")
        elif st.lesson_preset == "place":
            col.prop(st, "lesson_kind")
        col.prop(st, "lesson_text")
        layout.operator("roombridge.send_lesson", icon="PLAY")
        lesson = c.lesson
        if lesson is None:
            layout.label(text="No prompt on the phone.")
            return
        box = layout.box()
        label, icon = LESSON_STATE.get(lesson["state"], (lesson["state"], "DOT"))
        box.label(text=f"{label}:", icon=icon)
        box.label(text=f"“{lesson['text'][:70]}”")
        if lesson.get("demo"):
            box.label(text="The phone loops a ghost demo when the novice taps Show me.", icon="GHOST_ENABLED")
        layout.operator("roombridge.clear_lesson", icon="X")


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
            voice = k.get("voice")
            spoken = f" (voice note, {voice['durationMs'] / 1000:.0f} s)" if voice else ""
            col.label(text=f"{k['authorName']}{about}{spoken}:", icon="PLAY_SOUND" if voice else "COMMUNITY")
            col.label(text=f"   {k['text'][:80]}")
        col.separator()
        col.label(text="To talk: open the expert invite in a browser on this Mac", icon="INFO")
        col.label(text="(use localhost) and hold the mic button.")


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
    ROOMBRIDGE_OT_proposal,
    ROOMBRIDGE_OT_send_lesson,
    ROOMBRIDGE_OT_clear_lesson,
    ROOMBRIDGE_OT_select_object,
    ROOMBRIDGE_PT_main,
    ROOMBRIDGE_PT_people,
    ROOMBRIDGE_PT_room,
    ROOMBRIDGE_PT_design,
    ROOMBRIDGE_PT_proposals,
    ROOMBRIDGE_PT_teach,
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

