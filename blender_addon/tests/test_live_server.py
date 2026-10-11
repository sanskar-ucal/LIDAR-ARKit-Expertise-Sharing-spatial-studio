"""End-to-end check of the add-on's network stack against the real TypeScript server.

Spawns `server/src/index.ts` with tsx on a random port. Skipped when the
server's node_modules are not installed. Uses no bpy: it exercises
ws_client.py and session.py exactly as Blender would, from a worker thread.
"""

import json
import os
import pathlib
import queue
import re
import shutil
import subprocess
import time
import unittest
import urllib.request
import uuid

from roombridge import protocol
from roombridge.session import RoomSession
from roombridge.ws_client import WebSocketClient

ROOT = pathlib.Path(__file__).resolve().parents[2]
TSX = ROOT / "node_modules" / ".bin" / "tsx"


def wait_for(inbox: "queue.Queue", pred, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            m = inbox.get(timeout=0.1)
        except queue.Empty:
            continue
        if pred(m):
            return m
    raise AssertionError("timed out waiting for message")


class RawClient:
    def __init__(self, base, code, token, name):
        self.ws = WebSocketClient(base.replace("http", "ws") + "/ws/control")
        self.ws.connect()
        self.ws.send_text(json.dumps(protocol.envelope("auth", {"roomCode": code, "token": token, "displayName": name, "clientKind": "test"}, "", "")))
        self.auth = self.next(lambda m: m["type"] in ("auth.ok", "auth.error"))

    def next(self, pred, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            got = self.ws.recv(0.1)
            if got:
                m = json.loads(got[1])
                if pred(m):
                    return m
        raise AssertionError("timed out")

    def close(self):
        self.ws.close()


@unittest.skipUnless(TSX.exists() and shutil.which("node"), "server dependencies not installed (run npm install)")
class LiveServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = dict(os.environ, HOST="127.0.0.1", PORT="0", SERVE_WEB="0", LOG_LEVEL="info")
        cls.proc = subprocess.Popen([str(TSX), "server/src/index.ts"], cwd=ROOT, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + 20
        cls.base = None
        while time.time() < deadline:
            line = cls.proc.stdout.readline()
            m = re.search(r"listening on 127\.0\.0\.1:(\d+)", line)
            if m:
                cls.base = f"http://127.0.0.1:{m.group(1)}"
                break
        if not cls.base:
            cls.proc.kill()
            raise RuntimeError("server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        cls.proc.stdout.close()

    def create_room(self):
        req = urllib.request.Request(f"{self.base}/api/rooms", data=json.dumps({"hostName": "Host"}).encode(),
                                     headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())

    def test_expert_edit_reaches_host_in_canonical_coordinates(self):
        room = self.create_room()
        host = RawClient(self.base, room["code"], room["hostToken"], "Host")
        self.assertEqual(host.auth["type"], "auth.ok")
        s = RoomSession(self.base, room["code"], room["expertToken"], "Expert")
        s.start()
        try:
            wait_for(s.inbox, lambda m: m["type"] == "scene.snapshot")
            self.assertEqual(s.role, "expert")
            oid = str(uuid.uuid4())
            obj = {"id": oid, "kind": "partition", "name": "Partition 1", "position": [0.0, 0.0, -2.0],
                   "rotation": [0.0, 0.0, 0.0, 1.0], "dimensions": [1.0, 1.0, 1.0], "color": "#d8cfc0", "textureRef": None}
            mid = s.send("object.create", {"object": obj}, origin_epoch=1)
            ack = wait_for(s.inbox, lambda m: m["type"] in ("ack", "error") and m["payload"].get("ackOf") == mid)
            self.assertEqual(ack["type"], "ack")
            created = host.next(lambda m: m["type"] == "object.created")
            self.assertEqual(created["payload"]["object"]["position"], [0, 0, -2])
            self.assertEqual(created["payload"]["object"]["dimensions"], [1, 1, 1])
            # Update streams through and gets the next revision.
            s.send("object.update", {"id": oid, "baseRevision": 1, "patch": {"position": [0.5, 0.0, -2.0]}}, origin_epoch=1)
            upd = host.next(lambda m: m["type"] == "object.updated")
            self.assertEqual(upd["payload"]["object"]["revision"], 2)
        finally:
            s.stop()
            host.close()

    def _host_send(self, host, msg_type, payload, epoch=None):
        a = host.auth["payload"]
        env = protocol.envelope(msg_type, payload, a["roomId"], a["clientId"], epoch)
        host.ws.send_text(json.dumps(env))
        return env["messageId"]

    def test_guidance_round_trip_moves_object_only_on_approval(self):
        room = self.create_room()
        host = RawClient(self.base, room["code"], room["hostToken"], "Host")
        s = RoomSession(self.base, room["code"], room["expertToken"], "Expert")
        s.start()
        try:
            wait_for(s.inbox, lambda m: m["type"] == "scene.snapshot")
            oid = str(uuid.uuid4())
            obj = {"id": oid, "kind": "pillar", "name": "Pillar", "position": [0.0, 0.0, -2.0],
                   "rotation": [0.0, 0.0, 0.0, 1.0], "dimensions": [0.3, 2.4, 0.3], "color": "#2a8c94", "textureRef": None}
            s.send("object.create", {"object": obj}, origin_epoch=1)
            host.next(lambda m: m["type"] == "object.created")
            # Blender "Send target" for 0.4 m along canonical +X (Blender X).
            s.send("guidance.set", {"objectId": oid, "axis": "x", "targetPosition": [0.4, 0.0, -2.0]}, origin_epoch=1)
            g = wait_for(s.inbox, lambda m: m["type"] == "guidance.state" and m["payload"]["guidance"])["payload"]["guidance"]
            s.send("guidance.begin", {"guidanceId": g["id"]}, origin_epoch=1)
            host.next(lambda m: m["type"] == "guidance.state" and m["payload"]["guidance"]["state"] == "active")
            # Phone holds and moves; the expert sees the attempt the server computed.
            self._host_send(host, "guidance.attempt", {"guidanceId": g["id"], "offset": 0.38, "seq": 1, "holding": True}, 1)
            att = wait_for(s.inbox, lambda m: m["type"] == "guidance.state" and (m["payload"]["guidance"].get("attempt") or {}).get("seq") == 1)
            attempt = att["payload"]["guidance"]["attempt"]
            self.assertTrue(attempt["withinTolerance"])
            self.assertAlmostEqual(attempt["position"][0], 0.38)
            # The design object itself has not moved yet.
            self._host_send(host, "scene.request", {})
            snap = host.next(lambda m: m["type"] == "scene.snapshot")
            self.assertEqual(snap["payload"]["objects"][0]["position"], [0, 0, -2])
            s.send("guidance.approve", {"guidanceId": g["id"]})
            # Approval adopts where the novice physically placed it (within tolerance), per PROTOCOL.md.
            moved = host.next(lambda m: m["type"] == "object.updated")
            self.assertAlmostEqual(moved["payload"]["object"]["position"][0], 0.38)
        finally:
            s.stop()
            host.close()

    def test_expert_downloads_committed_scan(self):
        room = self.create_room()
        s = RoomSession(self.base, room["code"], room["expertToken"], "Expert")
        s.start()
        try:
            wait_for(s.inbox, lambda m: m["type"] == "scene.snapshot")
            data = (ROOT / "protocol/fixtures/sample-room.rbsc").read_bytes()
            auth = {"authorization": f"Bearer {room['hostToken']}"}
            root = f"{self.base}/api/rooms/{room['roomId']}/scan"

            def call(url, method, body=None, ctype="application/json"):
                req = urllib.request.Request(url, data=body, method=method, headers={**auth, "content-type": ctype})
                with urllib.request.urlopen(req) as r:
                    return json.loads(r.read())

            begin = {"originEpoch": 1, "chunkCount": 1, "totalBytes": len(data), "vertexCount": 12, "triangleCount": 6, "synthetic": True}
            up = call(f"{root}/begin", "POST", json.dumps(begin).encode())["uploadId"]
            call(f"{root}/{up}/chunks/0", "PUT", data, "application/octet-stream")
            call(f"{root}/{up}/commit", "POST", b"")
            ready = wait_for(s.inbox, lambda m: m["type"] == "scan.ready")
            self.assertTrue(ready["payload"]["scan"]["synthetic"])
            s.fetch_scan_async()
            got = wait_for(s.inbox, lambda m: m["type"] in ("local.scan", "local.scan_error"))
            self.assertEqual(got["type"], "local.scan")
            self.assertEqual(got["payload"]["data"], data)
        finally:
            s.stop()

    def test_viewer_invite_cannot_become_expert(self):
        room = self.create_room()
        s = RoomSession(self.base, room["code"], room["viewerToken"], "Not an expert")
        s.start()
        wait_for(s.inbox, lambda m: m["type"] == "local.status" and m["payload"]["status"] == "error")
        self.assertIn("viewer", s.fatal_error)
        s.stop()

    def test_bad_credential_is_fatal_and_not_retried(self):
        room = self.create_room()
        s = RoomSession(self.base, room["code"], "wrong-token-123456", "X")
        s.start()
        wait_for(s.inbox, lambda m: m["type"] == "local.status" and m["payload"]["status"] == "error")
        time.sleep(0.3)
        self.assertFalse(s.alive)
        self.assertEqual(s.reconnects, 0)

    def test_repeated_connect_disconnect_does_not_leak_participants(self):
        room = self.create_room()
        host = RawClient(self.base, room["code"], room["hostToken"], "Host")
        for _ in range(5):
            s = RoomSession(self.base, room["code"], room["expertToken"], "Expert")
            s.start()
            wait_for(s.inbox, lambda m: m["type"] == "scene.snapshot")
            s.send("room.leave", {})
            time.sleep(0.15)
            s.stop()
        time.sleep(0.3)
        host.ws.send_text(json.dumps(protocol.envelope("scene.request", {}, host.auth["payload"]["roomId"], host.auth["payload"]["clientId"])))
        snap = host.next(lambda m: m["type"] == "scene.snapshot")
        experts = [p for p in snap["payload"]["participants"] if p["role"] == "expert"]
        self.assertEqual(experts, [])
        host.close()


if __name__ == "__main__":
    unittest.main()
