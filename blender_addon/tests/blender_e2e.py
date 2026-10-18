"""Runs the add-on inside real Blender (headless) against the real server.

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
        --python blender_addon/tests/blender_e2e.py

A scripted "phone" (host) creates the room and uploads the synthetic sample-room
scan; the add-on connects as the expert. Checks scan import, object create/move/
delete reaching the phone in canonical coordinates, a remote edit reaching
Blender, and a full guidance round trip. Exits non-zero on failure. Blender's
event loop does not run in --background mode, so the add-on's timer is pumped
by hand.
"""

import json
import math
import os
import pathlib
import re
import subprocess
import sys
import time
import traceback
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "blender_addon"))

import bpy  # noqa: E402

import roombridge  # noqa: E402
from roombridge import catalog, primitives, protocol, sync  # noqa: E402
from roombridge.ws_client import WebSocketClient  # noqa: E402

results = []


def check(cond, name):
    results.append((bool(cond), name))
    print(("PASS " if cond else "FAIL ") + name, flush=True)


def pump(until, timeout=6.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        sync.ctrl.dirty = True
        sync._tick()
        if until():
            return True
        time.sleep(0.05)
    return False


class Phone:
    """Minimal host client: receives everything, can send attempts."""

    def __init__(self, base, code, token):
        self.ws = WebSocketClient(base.replace("http", "ws") + "/ws/control")
        self.ws.connect()
        self.ws.send_text(json.dumps(protocol.envelope(
            "auth", {"roomCode": code, "token": token, "displayName": "Scripted phone", "clientKind": "test"}, "", "")))
        self.seen = []
        self.auth = self.wait(lambda m: m["type"] == "auth.ok")["payload"]

    def poll(self):
        while True:
            got = self.ws.recv(0.01)
            if not got:
                return
            self.seen.append(json.loads(got[1]))

    def wait(self, pred, timeout=6.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.poll()
            for m in self.seen:
                if pred(m):
                    self.seen.remove(m)
                    return m
            sync._tick() if sync.ctrl.session else None
            time.sleep(0.02)
        raise AssertionError("phone timed out")

    def send(self, t, payload, epoch=None):
        self.ws.send_text(json.dumps(protocol.envelope(t, payload, self.auth["roomId"], self.auth["clientId"], epoch)))


class FakeLayout:
    """Stands in for bpy.types.UILayout (headless Blender cannot draw), recording icons used."""

    def __init__(self, icons_used):
        self.icons_used = icons_used

    def __getattr__(self, name):
        def call(*_args, **kwargs):
            if "icon" in kwargs:
                self.icons_used.append(kwargs["icon"])
            return FakeLayout(self.icons_used)
        return call

    def __setattr__(self, name, value):
        object.__setattr__(self, name, value)


def draw_all_panels():
    from roombridge import ui
    used = []
    errors = []
    for cls in ui.CLASSES:
        if not issubclass(cls, bpy.types.Panel):
            continue
        if hasattr(cls, "poll") and not cls.poll(bpy.context):
            continue
        fake = type("P", (), {"layout": FakeLayout(used)})()
        try:
            cls.draw(fake, bpy.context)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{cls.__name__}: {exc!r}")
    valid = set(bpy.types.UILayout.bl_rna.functions["label"].parameters["icon"].enum_items.keys())
    return errors, sorted(set(i for i in used if i not in valid))


def close(a, b, tol=1e-4):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def main(base):
    req = urllib.request.Request(f"{base}/api/rooms", data=b'{"hostName":"Phone"}',
                                 headers={"content-type": "application/json"}, method="POST")
    room = json.loads(urllib.request.urlopen(req).read())
    phone = Phone(base, room["code"], room["hostToken"])

    # Phone uploads the synthetic sample room.
    data = (ROOT / "protocol/fixtures/sample-room.rbsc").read_bytes()
    auth = {"authorization": f"Bearer {room['hostToken']}"}
    root = f"{base}/api/rooms/{room['roomId']}/scan"

    def call(url, method, body, ctype="application/json"):
        r = urllib.request.Request(url, data=body, method=method, headers={**auth, "content-type": ctype})
        return json.loads(urllib.request.urlopen(r).read())

    begin = {"originEpoch": 1, "chunkCount": 1, "totalBytes": len(data), "vertexCount": 12, "triangleCount": 6, "synthetic": True}
    up = call(f"{root}/begin", "POST", json.dumps(begin).encode())["uploadId"]
    call(f"{root}/{up}/chunks/0", "PUT", data, "application/octet-stream")
    call(f"{root}/{up}/commit", "POST", b"")

    roombridge.register()
    check(hasattr(bpy.types.WindowManager, "roombridge"), "add-on registers in Blender " + bpy.app.version_string)

    wm = bpy.context.window_manager
    st = wm.roombridge
    # A browser-stripped link (no #t=) is rejected with an explanation, wherever it is pasted.
    stripped = room["expertLink"].split("#")[0]
    st.token = stripped
    check(st.token == "" and "no credential" in sync.ctrl.last_error, "stripped link in credential field explained")
    st.invite = stripped
    check(st.invite == "" and "no credential" in sync.ctrl.last_error, "stripped link in invite field explained")
    # Full invite pasted into the credential field still works.
    st.token = room["expertLink"]
    check(st.room_code == room["code"] and "/" not in st.token and sync.ctrl.last_error == "", "invite in credential field parsed")
    st.token = ""
    # Paste the invite exactly as the user would.
    wm.roombridge.invite = room["expertLink"]
    check(st.room_code == room["code"] and st.token and st.invite == "", "invite parsed and cleared from the field")
    sync.connect(st.server_url, st.room_code, st.token, "Blender expert")
    check(pump(lambda: sync.is_connected() and sync.ctrl.room), "connects as expert")

    check(pump(lambda: bpy.data.objects.get(primitives.SCAN_NAME) is not None), "room scan imported")
    scan_obj = bpy.data.objects.get(primitives.SCAN_NAME)
    if scan_obj:
        zs = [v.co.z for v in scan_obj.data.vertices]
        ys = [v.co.y for v in scan_obj.data.vertices]
        check(min(zs) == 0 and max(zs) == 2.5 and max(ys) == 3.0, "scan is Z-up with the back wall at +Y 3 m")
        check(scan_obj.hide_select, "scan is not selectable")
        check("simulated" in sync.ctrl.scan_status.lower(), "scan labelled simulated: " + sync.ctrl.scan_status)
        check(abs(sync.ctrl.floor_z) < 1e-6, "floor detected at Z 0 for the sample room")

    # Expert adds a pillar at Blender (1, 2, 0) -> canonical (1, 0, -2).
    pillar = sync.create_object("pillar", (1.0, 2.0, 0.0))
    created = phone.wait(lambda m: m["type"] == "object.created")
    o = created["payload"]["object"]
    check(o["kind"] == "pillar" and close(o["position"], [1, 0, -2]), f"pillar reaches phone at canonical {o['position']}")
    pid = o["id"]

    # Expert moves it (G X 0.5) and scales its height.
    pillar.location.x += 0.5
    pillar.scale.z = 3.0
    upd = phone.wait(lambda m: m["type"] == "object.updated" and close(m["payload"]["object"]["position"], [1.5, 0, -2])
                     and abs(m["payload"]["object"]["dimensions"][1] - 3.0) < 1e-4)
    check(upd is not None, "move + height change reach phone")

    for kind in ("partition", "panel"):
        sync.create_object(kind, (0.0, 3.0, 1.0 if kind == "panel" else 0.0))
        m = phone.wait(lambda m, k=kind: m["type"] == "object.created" and m["payload"]["object"]["kind"] == k)
        check(m is not None, f"{kind} reaches phone")

    # A second expert edit made elsewhere shows up in Blender.
    other = Phone(base, room["code"], room["expertToken"])
    oid = str(uuid.uuid4())
    other.send("object.create", {"object": {"id": oid, "kind": "partition", "name": "Remote partition",
                                            "position": [-1.0, 0.0, -1.0], "rotation": [0, 0, 0, 1],
                                            "dimensions": [1.0, 2.0, 0.1], "color": "#c9b79c", "textureRef": None}}, 1)
    check(pump(lambda: oid in sync._index()), "remote object appears in Blender")
    remote = sync._index().get(oid)
    if remote:
        check(close(remote.location, (-1.0, 1.0, 0.0)) and close(remote.scale, (1.0, 0.1, 2.0)),
              f"remote object placed at Blender {tuple(round(c, 3) for c in remote.location)} scale {tuple(round(c, 3) for c in remote.scale)}")
    other.ws.close()

    # Guidance: ghost 0.4 m along Blender X, begin, phone attempts, approve.
    ghost = sync.place_target_ghost(pillar)
    ghost.location.x += 0.4
    msg = sync.send_target(pillar, "AUTO", 0.05)
    check(msg.startswith("Target sent"), "send target: " + msg)
    g = phone.wait(lambda m: m["type"] == "guidance.state" and m["payload"]["guidance"]
                   and m["payload"]["guidance"]["state"] == "preview")["payload"]["guidance"]
    check(g["axis"] == "x" and close(g["target"]["position"], [1.9, 0, -2]), f"phone sees target on axis {g['axis']}")
    pump(lambda: sync.ctrl.guidance is not None)
    sync.guidance_command("guidance.begin")
    phone.wait(lambda m: m["type"] == "guidance.state" and m["payload"]["guidance"]["state"] == "active")
    phone.send("guidance.attempt", {"guidanceId": g["id"], "offset": 0.39, "seq": 1, "holding": True}, 1)
    check(pump(lambda: bpy.data.objects.get(primitives.ATTEMPT_NAME) is not None
               and abs(bpy.data.objects[primitives.ATTEMPT_NAME].location.x - 1.89) < 1e-3),
          "novice attempt object follows the phone in Blender")
    att = bpy.data.objects.get(primitives.ATTEMPT_NAME)
    check(att is not None and att.hide_select, "attempt object is not selectable")
    check(sync.ctrl.guidance and sync.ctrl.guidance["attempt"]["withinTolerance"], "Blender sees attempt within tolerance")
    sync.guidance_command("guidance.approve")
    moved = phone.wait(lambda m: m["type"] == "object.updated" and m["payload"]["object"]["id"] == pid)
    check(close(moved["payload"]["object"]["position"], [1.89, 0, -2]), "approve moves the pillar for the phone")
    check(pump(lambda: abs(pillar.location.x - 1.89) < 1e-3), "approved position applied in Blender")

    # Delete in Blender reaches the phone.
    bpy.data.objects.remove(pillar, do_unlink=True)
    dele = phone.wait(lambda m: m["type"] == "object.deleted")
    check(dele["payload"]["id"] == pid, "delete reaches phone")

    # Every catalog kind can be added from Blender and reaches the phone with its default size.
    icons = set(bpy.types.UILayout.bl_rna.functions["label"].parameters["icon"].enum_items.keys())
    bad_icons = [k["blenderIcon"] for k in catalog.DATA["kinds"] if k["blenderIcon"] not in icons]
    check(not bad_icons, f"catalog Blender icons exist {bad_icons}")
    for k in catalog.DATA["kinds"]:
        obj = sync.create_object(k["kind"], (2.0, 1.0, 0.0))
        m = phone.wait(lambda m, oid=obj["rb_id"]: m["type"] == "object.created" and m["payload"]["object"]["id"] == oid)
        o = m["payload"]["object"]
        want_y = k["height"] if k["origin"] == "center" else 0.0
        ok = close(o["dimensions"], k["dimensions"]) and abs(o["position"][1] - want_y) < 1e-4
        if k["kind"] not in primitives.LEGACY_KINDS:
            ok = ok and len(obj.data.materials) == len(catalog.tint_order(k["kind"])) and len(obj.data.vertices) >= 8 * len(k["parts"])
        check(ok, f"{k['kind']}: built from {len(k['parts'])} part(s), reaches phone at height {o['position'][1]:.2f}")
    table = next(o for o in bpy.data.objects if o.get("rb_kind") == "table")
    zs = [v.co.z for v in table.data.vertices]
    check(abs(min(zs)) < 1e-6 and abs(max(zs) - 1.0) < 1e-6, "table mesh spans the unit box (legs on the floor, top at 1)")

    # The novice proposes a couch from the phone; the expert adjusts and accepts it with a note.
    couch_id = str(uuid.uuid4())
    phone.send("object.propose", {"object": {"id": couch_id, "kind": "couch", "name": "Couch", "position": [0.5, 0.0, -2.5],
                                             "rotation": [0, 0, 0, 1], "dimensions": [2.0, 0.85, 0.9], "color": "#5b7c99",
                                             "textureRef": None}}, 1)
    check(pump(lambda: couch_id in sync._index()), "novice proposal appears in Blender")
    couch = sync._index().get(couch_id)
    if couch:
        check(couch.get("rb_proposal") and couch.show_wire and couch.show_name, "proposal is outlined and labelled")
        check(close(couch.location, (0.5, 2.5, 0.0)), "proposal placed where the novice put it")
        check([o["id"] for o in sync.pending_proposals()] == [couch_id], "proposal listed for review")
        check("proposed" in sync.ctrl.last_info, "expert is told: " + sync.ctrl.last_info)
        errors, bad = draw_all_panels()
        check(not errors and not bad, f"every panel draws (errors {errors}, unknown icons {bad})")
        couch.location.y += 0.3  # expert pushes it 30 cm further back (canonical -Z)
        pump(lambda: False, timeout=0.4)
        msg = sync.proposal_command("proposal.accept", couch_id, "Moved it back so the door can open")
        check(msg.startswith("Accepted"), msg)
        res = phone.wait(lambda m: m["type"] == "proposal.resolved" and m["payload"]["objectId"] == couch_id)["payload"]
        check(res["outcome"] == "adjusted" and close(res["after"]["position"], [0.5, 0, -2.8], 1e-3)
              and res["note"] == "Moved it back so the door can open", f"novice hears: {res['outcome']} by {res['byName']}")
        check(pump(lambda: not couch.get("rb_proposal")) and not couch.show_wire, "accepted proposal becomes a normal object")

    chair_id = str(uuid.uuid4())
    phone.send("object.propose", {"object": {"id": chair_id, "kind": "chair", "name": "Chair", "position": [1.0, 0.0, -1.0],
                                             "rotation": [0, 0, 0, 1], "dimensions": [0.45, 0.9, 0.5], "color": "#7a8b99",
                                             "textureRef": None}}, 1)
    check(pump(lambda: chair_id in sync.ctrl.server_objects), "second proposal arrives")
    sync.proposal_command("proposal.reject", chair_id, "It blocks the window")
    res = phone.wait(lambda m: m["type"] == "proposal.resolved" and m["payload"]["objectId"] == chair_id)["payload"]
    check(res["outcome"] == "rejected" and res["note"] == "It blocks the window", "rejection with a reason reaches the phone")
    check(pump(lambda: chair_id not in sync._index()), "rejected proposal removed in Blender")
    check(sync.ctrl.proposal_log and sync.ctrl.proposal_log[0]["outcome"] == "rejected", "Blender keeps a log of decisions")

    sync.disconnect()
    roombridge.unregister()
    check(not bpy.app.timers.is_registered(sync._tick), "disconnect removes the timer")
    phone.ws.close()


def run():
    tsx = ROOT / "node_modules" / ".bin" / "tsx"
    env = dict(os.environ, HOST="127.0.0.1", PORT="0", SERVE_WEB="0", LOG_LEVEL="info")
    proc = subprocess.Popen([str(tsx), "server/src/index.ts"], cwd=ROOT, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        base = None
        deadline = time.time() + 20
        while time.time() < deadline and base is None:
            m = re.search(r"listening on 127\.0\.0\.1:(\d+)", proc.stdout.readline())
            if m:
                base = f"http://127.0.0.1:{m.group(1)}"
        if base is None:
            raise RuntimeError("server did not start")
        main(base)
    except Exception:
        traceback.print_exc()
        results.append((False, "exception"))
    finally:
        proc.terminate()
        proc.wait(5)
    failed = [n for ok, n in results if not ok]
    print(f"\nBlender e2e: {len(results) - len(failed)} passed, {len(failed)} failed", flush=True)
    sys.exit(1 if failed else 0)


run()
