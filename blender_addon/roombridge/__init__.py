"""RoomBridge: expert-side Blender client.

Connects to a RoomBridge room as the expert, shows the novice's approximate
room scan, and synchronises pillars, partitions and picture panels plus
one-axis guidance exercises with the novice's iPhone.
"""

bl_info = {
    "name": "RoomBridge",
    "author": "CPSC 581 RoomBridge team",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "3D Viewport > Sidebar (N) > RoomBridge",
    "description": "Guide a remote novice's AR room edits from Blender",
    "category": "3D View",
}

if "bpy" in locals():
    # Script reload (F3 > Reload Scripts): drop old timers/handlers/sockets before re-importing.
    import importlib

    if "sync" in locals():
        try:
            sync.disconnect()  # noqa: F821
        except Exception:
            pass
    for _name in ("coords", "catalog", "lessons", "protocol", "ws_client", "session", "tracker", "scan_format", "primitives", "sync", "ui"):
        if _name in locals():
            importlib.reload(locals()[_name])

from . import catalog, coords, lessons, protocol, scan_format, session, tracker, ws_client  # noqa: E402,F401

try:
    import bpy  # noqa: E402,F401
except ImportError:  # imported by the plain-Python unit tests
    bpy = None

if bpy is not None:
    from . import primitives, sync, ui  # noqa: E402,F401


def register():
    ui.register()


def unregister():
    ui.unregister()
