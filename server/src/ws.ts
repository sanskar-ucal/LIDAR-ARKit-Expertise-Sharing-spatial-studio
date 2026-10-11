import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { LIMITS, type Config } from "./config.js";
import { clientIp } from "./http.js";
import { log } from "./log.js";
import type { FrameSocket } from "./preview.js";
import { PROTOCOL_VERSION, ProtocolError, parseClientMessage, type ClientMessage, type Payload } from "./protocol.js";
import { TokenBucket, WindowLimiter } from "./ratelimit.js";
import type { Room, Sink } from "./room.js";
import type { RoomRegistry } from "./rooms.js";

type Alive = WebSocket & { isAlive?: boolean };

function errorEnvelope(type: string, code: string, message: string, ackOf?: string): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type,
    roomId: "",
    clientId: "server",
    messageId: `s_${Date.now().toString(36)}`,
    ...(ackOf ? { ackOf } : {}),
    payload: { code, message, ...(ackOf ? { ackOf } : {}) },
  });
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function rawToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
}

export function attachWebSockets(server: Server, config: Config, rooms: RoomRegistry): { close(): void } {
  const control = new WebSocketServer({ noServer: true, maxPayload: LIMITS.controlMaxBytes });
  const preview = new WebSocketServer({ noServer: true, maxPayload: LIMITS.previewMaxBytes });
  const authLimiter = new WindowLimiter(30, 60_000);
  const authFailLimiter = new WindowLimiter(10, 60_000);

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const target = path === "/ws/control" ? control : path === "/ws/preview" ? preview : null;
    if (!target) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
  });

  control.on("connection", (ws: Alive, req: IncomingMessage) => {
    const ip = clientIp(req, config);
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    let session: { room: Room; clientId: string; sink: Sink } | null = null;
    const bucket = new TokenBucket(LIMITS.msgRatePerSec, LIMITS.msgBurst);
    const authTimer = setTimeout(() => {
      if (!session) {
        ws.send(errorEnvelope("auth.error", "unauthorized", "Authentication timed out"));
        ws.close(4001, "auth timeout");
      }
    }, LIMITS.authTimeoutMs);

    const sink: Sink = {
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close: (code, reason) => ws.close(code, reason),
    };

    ws.on("message", (data, isBinary) => {
      if (!bucket.take()) {
        ws.send(errorEnvelope("error", "rate_limited", "Slow down"));
        return;
      }
      if (isBinary) {
        ws.send(errorEnvelope("error", "bad_request", "Control channel accepts JSON text only"));
        return;
      }
      let msg: ClientMessage;
      try {
        msg = parseClientMessage(rawToString(data));
      } catch (err) {
        const e = err instanceof ProtocolError ? err : new ProtocolError("bad_request", "Invalid message");
        ws.send(errorEnvelope(session ? "error" : "auth.error", e.code, e.message));
        if (!session) ws.close(4001, "bad auth");
        return;
      }

      if (session) {
        session.room.handle(session.clientId, msg);
        return;
      }

      if (msg.type !== "auth") {
        ws.send(errorEnvelope("auth.error", "unauthorized", "First message must be auth"));
        ws.close(4001, "unauthenticated");
        return;
      }
      if (!authLimiter.allow(ip) || authFailLimiter.exceeded(ip)) {
        ws.send(errorEnvelope("auth.error", "rate_limited", "Too many join attempts; wait a minute"));
        ws.close(4001, "rate limited");
        return;
      }
      const p = msg.payload as Payload<"auth">;
      const room = rooms.get(p.roomCode.trim());
      const role = room && !room.ended ? room.roleForToken(p.token) : null;
      if (!room || !role) {
        authFailLimiter.allow(ip);
        log.warn("auth failed", { ip, code: p.roomCode });
        ws.send(errorEnvelope("auth.error", "unauthorized", "Room code or invitation is not valid", msg.messageId));
        ws.close(4001, "unauthorized");
        return;
      }
      try {
        const { clientId } = room.attach(sink, role, p.displayName, p.clientKind, p.resumeClientId);
        session = { room, clientId, sink };
        clearTimeout(authTimer);
      } catch (err) {
        const e = err instanceof ProtocolError ? err : new ProtocolError("bad_request", "Join failed");
        ws.send(errorEnvelope("auth.error", e.code, e.message, msg.messageId));
        ws.close(4001, e.code);
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (session) session.room.detach(session.clientId, session.sink);
      session = null;
    });
    ws.on("error", (err) => log.debug("control socket error", { error: String(err) }));
  });

  preview.on("connection", (ws: Alive) => {
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    let bound: { room: Room; role: string } | null = null;
    const fsock: FrameSocket = {
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      send: (data, cb) => {
        if (ws.readyState !== WebSocket.OPEN) return cb(new Error("closed"));
        ws.send(data, { binary: true }, (err) => cb(err ?? undefined));
      },
      sendText: (text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close: (code, reason) => ws.close(code, reason),
    };
    const authTimer = setTimeout(() => !bound && ws.close(4001, "auth timeout"), LIMITS.authTimeoutMs);

    ws.on("message", (data, isBinary) => {
      if (bound) {
        if (!isBinary) return;
        if (bound.role !== "host") return;
        bound.room.preview.acceptFrame(fsock, rawToBuffer(data));
        return;
      }
      if (isBinary) return ws.close(4001, "unauthenticated");
      let ticket = "";
      try {
        const m = JSON.parse(rawToString(data));
        if (m?.type === "preview.auth" && typeof m.ticket === "string") ticket = m.ticket;
      } catch {
        /* fallthrough */
      }
      const entry = ticket ? rooms.byTicket(ticket) : undefined;
      const participant = entry?.room.participantFor(entry.clientId);
      if (!entry || !participant || !participant.connected || entry.room.ended) {
        ws.send(JSON.stringify({ type: "preview.error", code: "unauthorized" }));
        return ws.close(4001, "unauthorized");
      }
      clearTimeout(authTimer);
      bound = { room: entry.room, role: participant.role };
      if (participant.role === "host") entry.room.preview.setHost(fsock, entry.clientId);
      else entry.room.preview.addViewer(fsock, entry.clientId);
      ws.send(JSON.stringify({ type: "preview.ready", role: participant.role === "host" ? "host" : "viewer" }));
      entry.room.broadcastPreviewStatus();
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (bound) {
        bound.room.preview.removeSocket(fsock);
        if (!bound.room.ended) bound.room.broadcastPreviewStatus();
      }
      bound = null;
    });
    ws.on("error", (err) => log.debug("preview socket error", { error: String(err) }));
  });

  const heartbeat = setInterval(() => {
    for (const wss of [control, preview]) {
      for (const ws of wss.clients as Set<Alive>) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, LIMITS.heartbeatMs);

  const stats = setInterval(() => {
    for (const room of rooms.all()) room.preview.sendStatsToHost();
  }, 2_000);

  return {
    close() {
      clearInterval(heartbeat);
      clearInterval(stats);
      for (const wss of [control, preview]) {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
      }
    },
  };
}
