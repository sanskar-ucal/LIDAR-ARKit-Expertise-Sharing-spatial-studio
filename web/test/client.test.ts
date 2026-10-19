// End-to-end: the browser RoomClient against the real server, with a scripted host that
// streams synthetic frames. Node has no DOM, so WebSocket comes from `ws` and
// createImageBitmap is stubbed (decoding itself is the browser's job).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startServer } from "../../server/src/app";
import { loadConfig } from "../../server/src/config";
import { encodeFrame } from "../../server/src/frame";
import { setLogLevel } from "../../server/src/log";
import { RoomClient } from "../src/client";

setLogLevel("silent");
const g = globalThis as any;
g.WebSocket ??= WebSocket;
const decoded: number[] = [];
g.createImageBitmap = vi.fn(async (blob: Blob) => {
  decoded.push(blob.size);
  return { width: 4, height: 3, close() {} };
});

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";

beforeAll(async () => {
  server = await startServer(loadConfig({ host: "127.0.0.1", port: 0, serveWeb: false, publicUrl: "" }));
  base = `127.0.0.1:${server.port}`;
});
afterAll(async () => server.close());

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function hostSocket(code: string, token: string): Promise<{ ws: WebSocket; auth: any }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${base}/ws/control`);
    let auth: any;
    ws.on("open", () =>
      ws.send(JSON.stringify({ protocolVersion: 1, type: "auth", roomId: "", clientId: "", messageId: randomUUID(), payload: { roomCode: code, token, displayName: "Host", clientKind: "test" } })),
    );
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "auth.ok") auth = m.payload;
      if (m.type === "scene.snapshot" && auth) resolve({ ws, auth });
    });
  });
}

describe("RoomClient against the real server", () => {
  it("joins as a viewer, shows live frames, comments, and reconnects after a drop", async () => {
    const res = await fetch(`http://${base}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostName: "Host" }) });
    const room = await res.json();
    const host = await hostSocket(room.code, room.hostToken);
    const send = (type: string, payload: unknown) =>
      host.ws.send(JSON.stringify({ protocolVersion: 1, type, roomId: host.auth.roomId, clientId: host.auth.clientId, messageId: randomUUID(), payload }));

    const client = new RoomClient({ code: room.code, token: room.viewerToken, displayName: "Grandma", wsBase: `ws://${base}` });
    client.canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) } as any;
    client.start();
    await until(() => client.state.connection === "connected" && client.state.room !== null);
    expect(client.state.role).toBe("viewer");
    expect(client.state.participants.map((p) => p.displayName).sort()).toEqual(["Grandma", "Host"]);
    expect(JSON.stringify(client.state)).not.toContain(room.hostToken);
    expect(JSON.stringify(client.state)).not.toContain(room.expertToken);

    // Host goes live and sends synthetic frames.
    const preview = new WebSocket(`ws://${base}/ws/preview`);
    await new Promise<void>((r) => preview.on("open", () => r()));
    preview.send(JSON.stringify({ type: "preview.auth", ticket: host.auth.previewTicket }));
    await new Promise<void>((r) => preview.once("message", () => r()));
    send("preview.status", { state: "live", targetFps: 5, width: 4 });
    await until(() => client.previewSocket === "ready" && client.state.preview?.state === "live");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3]);
    for (let seq = 1; seq <= 3; seq++) {
      await new Promise((r) => setTimeout(r, 80)); // server caps the relay at 15 fps
      preview.send(encodeFrame({ orientation: 0, flags: 1, seq, width: 4, height: 3, captureTimeMs: Date.now() }, jpeg));
      await until(() => client.frame?.seq === seq);
    }
    expect(client.frame?.synthetic).toBe(true);
    expect(decoded.length).toBeGreaterThanOrEqual(3);

    // Viewer comments reach the room.
    expect(client.send("comment.add", { objectId: null, text: "Looks lovely" })).toBe(true);
    await until(() => client.state.comments.some((c) => c.text === "Looks lovely"));

    // Viewer cannot edit: the server rejects and the client surfaces a notice.
    client.send("object.delete", { id: "11111111-1111-4111-8111-111111111111" });
    await until(() => client.state.noticeSeq > 0);

    // Pausing is reflected for viewers.
    send("preview.status", { state: "paused", targetFps: 0, width: 0 });
    await until(() => client.state.preview?.state === "paused");

    // Drop the viewer's control socket from the server side; it must come back as the same participant.
    const before = client.state.clientId;
    (client as any).ws.close();
    await until(() => client.state.connection === "reconnecting", 2000);
    await until(() => client.state.connection === "connected", 5000);
    expect(client.state.clientId).toBe(before);
    expect(client.state.comments.some((c) => c.text === "Looks lovely")).toBe(true);

    client.stop();
    preview.close();
    host.ws.close();
  }, 15000);

  it("the expert's browser sends a voice note that an observer can play", async () => {
    const res = await fetch(`http://${base}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostName: "Host" }) });
    const room = await res.json();
    const expert = new RoomClient({ code: room.code, token: room.expertToken, displayName: "Sam", wsBase: `ws://${base}` });
    const viewer = new RoomClient({ code: room.code, token: room.viewerToken, displayName: "Observer", wsBase: `ws://${base}` });
    expert.start();
    viewer.start();
    await until(() => expert.state.room !== null && viewer.state.room !== null);
    const audio = new Blob([new Uint8Array([26, 69, 223, 163, 1, 2, 3])], { type: "audio/webm;codecs=opus" });
    const clipId = await expert.uploadVoice(audio);
    expect(expert.send("comment.add", { objectId: null, text: "Turn the chair to face the window", voice: { clipId, durationMs: 1500 } })).toBe(true);
    await until(() => viewer.state.comments.some((c) => c.voice?.clipId === clipId));
    expect(viewer.state.feed[0]?.title).toBe("🎤 Sam: Turn the chair to face the window");
    const blob = await viewer.fetchVoice(clipId);
    expect(blob.type).toBe("audio/webm");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([26, 69, 223, 163, 1, 2, 3]));
    // Observers listen and read, but cannot upload.
    await expect(viewer.uploadVoice(audio)).rejects.toThrow();
    expert.stop();
    viewer.stop();
  });

  it("reports a bad invite without retrying", async () => {
    const res = await fetch(`http://${base}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostName: "Host" }) });
    const room = await res.json();
    const client = new RoomClient({ code: room.code, token: "wrong-token-xxxxxxxx", displayName: "X", wsBase: `ws://${base}` });
    client.start();
    await until(() => client.state.connection === "failed");
    expect(client.state.error).toMatch(/not valid/);
    await new Promise((r) => setTimeout(r, 800));
    expect(client.state.connection).toBe("failed");
    client.stop();
  });
});
