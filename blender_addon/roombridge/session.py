"""Network worker for the Blender client. Never touches bpy.

A daemon thread owns the WebSocket. The main thread talks to it only through
two bounded queues; Blender data is changed exclusively from a bpy.app.timers
callback on the main thread (see sync.py).
"""

from __future__ import annotations

import json
import queue
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

from . import protocol
from .ws_client import ConnectionClosed, WebSocketClient, WebSocketError

OUTBOX_MAX = 500
INBOX_MAX = 2000


def http_to_ws(server_url: str) -> str:
    parts = urlsplit(server_url.strip().rstrip("/"))
    if parts.scheme not in ("http", "https"):
        raise ValueError("Server URL must start with http:// or https://")
    scheme = "wss" if parts.scheme == "https" else "ws"
    return f"{scheme}://{parts.netloc}"


class RoomSession:
    """Connection lifecycle: connecting -> connected -> (reconnecting -> connected)* -> stopped."""

    def __init__(self, server_url: str, room_code: str, token: str, display_name: str):
        self.server_url = server_url.strip().rstrip("/")
        self.ws_url = http_to_ws(self.server_url) + "/ws/control"
        self.room_code = room_code.strip().upper()
        self._token = token.strip()
        self.display_name = display_name.strip() or "Expert"
        self.inbox: "queue.Queue[Dict[str, Any]]" = queue.Queue(INBOX_MAX)
        self.outbox: "queue.Queue[Dict[str, Any]]" = queue.Queue(OUTBOX_MAX)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.client_id = ""
        self.room_id = ""
        self.role = ""
        self.status = "idle"
        self.status_detail = ""
        self.fatal_error = ""
        self.connected_at = 0.0
        self.reconnects = 0

    # ------------------------------------------------------------------ main-thread API

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="RoomBridgeNetwork", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        t = self._thread
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(timeout)
        self._thread = None
        self.status = "stopped"

    @property
    def alive(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def send(self, msg_type: str, payload: Dict[str, Any], origin_epoch: Optional[int] = None,
             message_id: Optional[str] = None) -> Optional[str]:
        """Queue a message; returns its messageId, or None if not connected / queue full."""
        if self.status != "connected":
            return None
        env = protocol.envelope(msg_type, payload, self.room_id, self.client_id, origin_epoch, message_id)
        try:
            self.outbox.put_nowait(env)
        except queue.Full:
            return None
        return env["messageId"]

    def fetch_scan_async(self) -> None:
        """Download the committed room scan on a worker thread; result arrives in inbox as 'local.scan'."""
        url = f"{self.server_url}/api/rooms/{self.room_id}/scan"

        def work() -> None:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self._token}"})
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = resp.read(9 * 1024 * 1024)
                self._post({"type": "local.scan", "payload": {"data": data}})
            except (urllib.error.URLError, OSError, ValueError) as exc:
                self._post({"type": "local.scan_error", "payload": {"message": str(exc)}})

        threading.Thread(target=work, name="RoomBridgeScanFetch", daemon=True).start()

    # ------------------------------------------------------------------ worker

    def _post(self, msg: Dict[str, Any]) -> None:
        try:
            self.inbox.put_nowait(msg)
        except queue.Full:
            # The main thread fell far behind; dropping is safe because the next
            # reconnect/scene.request delivers a full snapshot.
            pass

    def _set_status(self, status: str, detail: str = "") -> None:
        self.status = status
        self.status_detail = detail
        self._post({"type": "local.status", "payload": {"status": status, "detail": detail}})

    def _auth_message(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "roomCode": self.room_code,
            "token": self._token,
            "displayName": self.display_name,
            "clientKind": "blender",
        }
        if self.client_id:
            payload["resumeClientId"] = self.client_id
        return protocol.envelope("auth", payload, "", "")

    def _run(self) -> None:
        backoff = 0.5
        while not self._stop.is_set():
            ws = WebSocketClient(self.ws_url, timeout=5.0)
            try:
                self._set_status("connecting" if not self.reconnects else "reconnecting")
                ws.connect()
                ws.send_text(json.dumps(self._auth_message()))
                if not self._await_auth(ws):
                    return  # fatal (bad credential); do not retry
                backoff = 0.5
                self._pump(ws)
            except (OSError, WebSocketError, ConnectionClosed, ValueError) as exc:
                if self._stop.is_set():
                    break
                self._set_status("reconnecting", str(exc))
            finally:
                ws.close()
            # Never replay edits queued while disconnected: the snapshot after
            # reconnect is the source of truth, and sync.py re-diffs local changes.
            self._drain_outbox()
            if self._stop.is_set():
                break
            self.reconnects += 1
            self._stop.wait(backoff)
            backoff = min(backoff * 2, 8.0)
        if self.status not in ("ended", "error"):
            self._set_status("stopped")

    def _drain_outbox(self) -> None:
        while True:
            try:
                self.outbox.get_nowait()
            except queue.Empty:
                return

    def _await_auth(self, ws: WebSocketClient) -> bool:
        deadline = time.monotonic() + 6.0
        while time.monotonic() < deadline and not self._stop.is_set():
            got = ws.recv(0.2)
            if not got:
                continue
            msg = json.loads(got[1].decode("utf-8"))
            if msg.get("type") == "auth.ok":
                p = msg["payload"]
                self.client_id, self.room_id, self.role = p["clientId"], p["roomId"], p["role"]
                if self.role != "expert":
                    self.fatal_error = (f"That is the {'family (view-only)' if self.role == 'viewer' else self.role} link. "
                                        "Copy the link under 'Expert (can edit)' on the phone instead.")
                    self._set_status("error", self.fatal_error)
                    self._stop.set()
                    return False
                self.connected_at = time.time()
                self._post(msg)
                self._set_status("connected")
                return True
            if msg.get("type") == "auth.error":
                self.fatal_error = msg.get("payload", {}).get("message", "Authentication failed")
                self._set_status("error", self.fatal_error)
                self._stop.set()
                return False
        raise WebSocketError("Timed out waiting for authentication")

    def _pump(self, ws: WebSocketClient) -> None:
        last_ping = time.monotonic()
        while not self._stop.is_set():
            for _ in range(100):
                try:
                    env = self.outbox.get_nowait()
                except queue.Empty:
                    break
                ws.send_text(json.dumps(env, separators=(",", ":")))
            if time.monotonic() - last_ping > 10:
                ws.send_text(json.dumps(protocol.envelope("ping", {}, self.room_id, self.client_id)))
                last_ping = time.monotonic()
            got = ws.recv(0.03)
            while got:
                opcode, data = got
                if opcode == 0x1:
                    try:
                        msg = protocol.validate_server_message(json.loads(data.decode("utf-8")))
                    except (ValueError, protocol.ValidationError) as exc:
                        self._post({"type": "local.warning", "payload": {"message": f"Ignored invalid message: {exc}"}})
                    else:
                        if msg["type"] == "room.ended":
                            self._post(msg)
                            self._stop.set()
                            self._set_status("ended", "The host ended the room")
                            return
                        self._post(msg)
                got = ws.recv(0)
