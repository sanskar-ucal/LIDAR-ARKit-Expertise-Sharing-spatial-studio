"""Minimal RFC 6455 WebSocket client using only the Python standard library.

Blender bundles no WebSocket package and installing pip packages into
Blender's Python is fragile, so this client implements exactly what RoomBridge
needs: text/binary messages, fragmentation, ping/pong and close, over ws:// or
wss:// (TLS with certificate verification). It is not thread-safe; a single
worker thread owns each instance.
"""

from __future__ import annotations

import base64
import hashlib
import os
import select
import socket
import ssl
import struct
from typing import Optional, Tuple
from urllib.parse import urlsplit

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class WebSocketError(Exception):
    pass


class ConnectionClosed(WebSocketError):
    def __init__(self, code: int = 1006, reason: str = ""):
        super().__init__(f"closed ({code}) {reason}".strip())
        self.code = code
        self.reason = reason


class WebSocketClient:
    def __init__(self, url: str, timeout: float = 5.0, max_message: int = 1 << 20):
        parts = urlsplit(url)
        if parts.scheme not in ("ws", "wss"):
            raise WebSocketError("URL must start with ws:// or wss://")
        self.secure = parts.scheme == "wss"
        self.host = parts.hostname or ""
        self.port = parts.port or (443 if self.secure else 80)
        self.path = (parts.path or "/") + (("?" + parts.query) if parts.query else "")
        self.timeout = timeout
        self.max_message = max_message
        self.sock: Optional[socket.socket] = None
        self._buf = bytearray()
        self.closed = True

    # ------------------------------------------------------------------ connect

    def connect(self) -> None:
        raw = socket.create_connection((self.host, self.port), timeout=self.timeout)
        raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        if self.secure:
            ctx = ssl.create_default_context()
            raw = ctx.wrap_socket(raw, server_hostname=self.host)
        self.sock = raw
        key = base64.b64encode(os.urandom(16)).decode()
        host_header = self.host if self.port in (80, 443) else f"{self.host}:{self.port}"
        if ":" in self.host and not self.host.startswith("["):
            host_header = f"[{self.host}]:{self.port}"
        request = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "User-Agent: RoomBridge-Blender/0.1\r\n"
            "\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        head = self._read_http_head()
        lines = head.split("\r\n")
        if not lines or " 101 " not in lines[0] + " ":
            raise WebSocketError(f"Handshake failed: {lines[0] if lines else 'no response'}")
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        expected = base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()
        if headers.get("sec-websocket-accept") != expected:
            raise WebSocketError("Handshake failed: bad Sec-WebSocket-Accept")
        self.closed = False

    def _read_http_head(self) -> str:
        assert self.sock is not None
        while b"\r\n\r\n" not in self._buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WebSocketError("Connection closed during handshake")
            self._buf += chunk
            if len(self._buf) > 16384:
                raise WebSocketError("Handshake response too large")
        idx = self._buf.index(b"\r\n\r\n")
        head = bytes(self._buf[:idx]).decode("iso-8859-1")
        del self._buf[: idx + 4]
        return head

    # ------------------------------------------------------------------ send

    def send_text(self, text: str) -> None:
        self._send_frame(OP_TEXT, text.encode("utf-8"))

    def send_binary(self, data: bytes) -> None:
        self._send_frame(OP_BINARY, data)

    def ping(self, data: bytes = b"") -> None:
        self._send_frame(OP_PING, data)

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self.sock is None or self.closed:
            raise ConnectionClosed(1006, "not connected")
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload)) if n < 4096 else _mask_fast(payload, mask)
        self.sock.sendall(bytes(header) + masked)

    # ------------------------------------------------------------------ receive

    def _readable(self, timeout: float) -> bool:
        assert self.sock is not None
        if self._buf:
            return True
        if isinstance(self.sock, ssl.SSLSocket) and self.sock.pending():
            return True
        r, _, _ = select.select([self.sock], [], [], timeout)
        return bool(r)

    def _fill(self, n: int) -> None:
        assert self.sock is not None
        while len(self._buf) < n:
            try:
                chunk = self.sock.recv(max(4096, n - len(self._buf)))
            except socket.timeout as exc:
                raise WebSocketError("Timed out reading frame") from exc
            if not chunk:
                self.closed = True
                raise ConnectionClosed(1006, "connection lost")
            self._buf += chunk

    def _take(self, n: int) -> bytes:
        self._fill(n)
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def _read_frame(self) -> Tuple[bool, int, bytes]:
        b0, b1 = self._take(2)
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        n = b1 & 0x7F
        if n == 126:
            (n,) = struct.unpack("!H", self._take(2))
        elif n == 127:
            (n,) = struct.unpack("!Q", self._take(8))
        if n > self.max_message:
            raise WebSocketError("Frame too large")
        mask = self._take(4) if masked else None
        data = self._take(n)
        if mask:
            data = _mask_fast(data, mask)
        return fin, opcode, data

    def recv(self, timeout: float) -> Optional[Tuple[int, bytes]]:
        """Return (opcode, data) for the next complete data message, or None on timeout."""
        if self.sock is None or self.closed:
            raise ConnectionClosed(1006, "not connected")
        if not self._readable(timeout):
            return None
        message = bytearray()
        msg_opcode: Optional[int] = None
        while True:
            fin, opcode, data = self._read_frame()
            if opcode == OP_PING:
                self._send_frame(OP_PONG, data)
            elif opcode == OP_PONG:
                pass
            elif opcode == OP_CLOSE:
                code = struct.unpack("!H", data[:2])[0] if len(data) >= 2 else 1005
                reason = data[2:].decode("utf-8", "replace")
                try:
                    self._send_frame(OP_CLOSE, data[:2])
                except Exception:
                    pass
                self.closed = True
                raise ConnectionClosed(code, reason)
            else:
                if opcode != OP_CONT:
                    msg_opcode = opcode
                message += data
                if len(message) > self.max_message:
                    raise WebSocketError("Message too large")
                if fin:
                    return (msg_opcode or OP_TEXT), bytes(message)
            if msg_opcode is None and not self._readable(0):
                return None

    def close(self, code: int = 1000, reason: str = "") -> None:
        if self.sock is None:
            return
        try:
            if not self.closed:
                self._send_frame(OP_CLOSE, struct.pack("!H", code) + reason.encode("utf-8")[:120])
        except Exception:
            pass
        self.closed = True
        try:
            self.sock.close()
        finally:
            self.sock = None
            self._buf.clear()


def _mask_fast(data: bytes, mask: bytes) -> bytes:
    if not data:
        return b""
    n = len(data)
    key = int.from_bytes((mask * (n // 4 + 1))[:n], "big")
    return (int.from_bytes(data, "big") ^ key).to_bytes(n, "big")
