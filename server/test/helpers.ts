import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { startServer, type RunningServer } from "../src/app.js";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { setLogLevel } from "../src/log.js";
import type { CreatedRoom } from "../src/rooms.js";

setLogLevel("silent");

export const fixtures = {
  messages: JSON.parse(readFileSync(resolve(REPO_ROOT, "protocol/fixtures/messages.json"), "utf8")),
  coordinates: JSON.parse(readFileSync(resolve(REPO_ROOT, "protocol/fixtures/coordinates.json"), "utf8")),
};

export async function boot(): Promise<RunningServer & { base: string; ws: string }> {
  const s = await startServer(loadConfig({ host: "127.0.0.1", port: 0, serveWeb: false, publicUrl: "" }));
  return Object.assign(s, { base: `http://127.0.0.1:${s.port}`, ws: `ws://127.0.0.1:${s.port}` });
}

export async function createRoom(base: string, hostName = "Host"): Promise<CreatedRoom> {
  const res = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostName }),
  });
  if (res.status !== 201) throw new Error(`create failed ${res.status}`);
  return (await res.json()) as CreatedRoom;
}

type Msg = { type: string; payload: any; [k: string]: any };

export class TestClient {
  ws: WebSocket;
  inbox: Msg[] = [];
  clientId = "";
  roomId = "";
  role = "";
  previewTicket = "";
  originEpoch = 1;
  closed = false;
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];

  private constructor(url: string) {
    this.ws = new WebSocket(`${url}/ws/control`);
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Msg;
      if (typeof m.originEpoch === "number") this.originEpoch = m.originEpoch;
      this.inbox.push(m);
      for (const w of [...this.waiters]) {
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    this.ws.on("close", () => (this.closed = true));
  }

  static async join(
    url: string,
    code: string,
    token: string,
    name = "Tester",
    resumeClientId?: string,
  ): Promise<TestClient> {
    const c = new TestClient(url);
    await new Promise<void>((res, rej) => {
      c.ws.once("open", () => res());
      c.ws.once("error", rej);
    });
    c.ws.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "auth",
        roomId: "",
        clientId: "",
        messageId: randomUUID(),
        payload: { roomCode: code, token, displayName: name, clientKind: "test", ...(resumeClientId ? { resumeClientId } : {}) },
      }),
    );
    const first = await c.next((m) => m.type === "auth.ok" || m.type === "auth.error");
    if (first.type === "auth.error") c.authError = first;
    if (first.type === "auth.ok") {
      c.clientId = first.payload.clientId;
      c.roomId = first.payload.roomId;
      c.role = first.payload.role;
      c.previewTicket = first.payload.previewTicket;
      await c.next((m) => m.type === "scene.snapshot");
    }
    return c;
  }

  authError: Msg | undefined;

  next(pred: (m: Msg) => boolean, timeoutMs = 2000): Promise<Msg> {
    const found = this.inbox.find(pred);
    if (found) {
      this.inbox.splice(this.inbox.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          this.inbox.splice(this.inbox.indexOf(m), 1);
          resolve(m);
        },
      });
    });
  }

  /** Sends a message and resolves with its ack or error. */
  async request(type: string, payload: object, extra: Record<string, unknown> = {}): Promise<Msg> {
    const messageId = (extra.messageId as string) ?? randomUUID();
    this.send(type, payload, { ...extra, messageId });
    return this.next((m) => (m.type === "ack" || m.type === "error") && m.payload.ackOf === messageId);
  }

  send(type: string, payload: object, extra: Record<string, unknown> = {}): void {
    this.ws.send(
      JSON.stringify({
        protocolVersion: 1,
        type,
        roomId: this.roomId,
        clientId: this.clientId,
        messageId: randomUUID(),
        originEpoch: this.originEpoch,
        payload,
        ...extra,
      }),
    );
  }

  clear(): void {
    this.inbox = [];
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((r) => {
      this.ws.once("close", () => r());
      this.ws.close();
    });
  }
}

export function sampleObject(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    kind: "partition",
    name: "Partition",
    position: [0, 0, -2],
    rotation: [0, 0, 0, 1],
    dimensions: [1.2, 2, 0.1],
    color: "#d8cfc0",
    textureRef: null,
    ...over,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
