import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { parseFrameHeader } from "../src/frame.js";
import { encodeScan, validateScanBuffer } from "../src/scan.js";
import { boot, createRoom, TestClient } from "./helpers.js";

let srv: Awaited<ReturnType<typeof boot>>;
beforeEach(async () => (srv = await boot()));
afterEach(async () => srv.close());

// One-metre floor square at y = 0 in front of the origin.
const VERTS = [-0.5, 0, -1.5, 0.5, 0, -1.5, 0.5, 0, -0.5, -0.5, 0, -0.5];
const IDX = [0, 2, 1, 0, 3, 2];

async function upload(base: string, roomId: string, token: string, buf: Buffer, epoch = 1, opts: { skipChunk?: number; corrupt?: boolean } = {}) {
  const chunkSize = 40;
  const chunkCount = Math.ceil(buf.length / chunkSize);
  const auth = { authorization: `Bearer ${token}` };
  const begin = await fetch(`${base}/api/rooms/${roomId}/scan/begin`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ originEpoch: epoch, chunkCount, totalBytes: buf.length, vertexCount: VERTS.length / 3, triangleCount: IDX.length / 3, synthetic: false }),
  });
  if (begin.status !== 201) return { status: begin.status, body: await begin.json() };
  const { uploadId } = (await begin.json()) as { uploadId: string };
  for (let i = 0; i < chunkCount; i++) {
    if (i === opts.skipChunk) continue;
    const res = await fetch(`${base}/api/rooms/${roomId}/scan/${uploadId}/chunks/${i}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body: new Uint8Array(buf.subarray(i * chunkSize, (i + 1) * chunkSize)),
    });
    expect(res.status).toBe(200);
  }
  const commit = await fetch(`${base}/api/rooms/${roomId}/scan/${uploadId}/commit`, { method: "POST", headers: auth });
  return { status: commit.status, body: await commit.json() };
}

describe("scan upload", () => {
  it("commits atomically, broadcasts scan.ready, and serves bytes to host/expert only", async () => {
    const room = await createRoom(srv.base);
    const expert = await TestClient.join(srv.ws, room.code, room.expertToken, "Expert");
    const buf = encodeScan(1, VERTS, IDX);
    const r = await upload(srv.base, room.roomId, room.hostToken, buf);
    expect(r.status).toBe(200);
    const ready = await expert.next((m) => m.type === "scan.ready");
    expect(ready.payload.scan).toMatchObject({ vertexCount: 4, triangleCount: 2, originEpoch: 1 });
    const get = await fetch(`${srv.base}/api/rooms/${room.roomId}/scan`, { headers: { authorization: `Bearer ${room.expertToken}` } });
    expect(Buffer.from(await get.arrayBuffer()).equals(buf)).toBe(true);
    const denied = await fetch(`${srv.base}/api/rooms/${room.roomId}/scan`, { headers: { authorization: `Bearer ${room.viewerToken}` } });
    expect(denied.status).toBe(403);
    await expert.close();
  });

  it("never exposes a partial upload", async () => {
    const room = await createRoom(srv.base);
    const r = await upload(srv.base, room.roomId, room.hostToken, encodeScan(1, VERTS, IDX), 1, { skipChunk: 1 });
    expect(r.status).toBe(400);
    expect(srv.rooms.get(room.code)!.scan).toBeNull();
  });

  it("rejects out-of-range indices and stale epochs", async () => {
    const room = await createRoom(srv.base);
    const bad = encodeScan(1, VERTS, [0, 1, 9, 0, 3, 2]);
    expect((await upload(srv.base, room.roomId, room.hostToken, bad)).status).toBe(400);
    const stale = await upload(srv.base, room.roomId, room.hostToken, encodeScan(1, VERTS, IDX), 2);
    expect(stale.status).toBe(409);
    expect(srv.rooms.get(room.code)!.scan).toBeNull();
  });

  it("only the host may upload", async () => {
    const room = await createRoom(srv.base);
    const r = await upload(srv.base, room.roomId, room.expertToken, encodeScan(1, VERTS, IDX));
    expect(r.status).toBe(403);
  });

  it("an origin reset during upload invalidates it", async () => {
    const room = await createRoom(srv.base);
    const host = await TestClient.join(srv.ws, room.code, room.hostToken, "Host");
    const buf = encodeScan(1, VERTS, IDX);
    const auth = { authorization: `Bearer ${room.hostToken}` };
    const begin = await fetch(`${srv.base}/api/rooms/${room.roomId}/scan/begin`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ originEpoch: 1, chunkCount: 1, totalBytes: buf.length, vertexCount: 4, triangleCount: 2, synthetic: false }),
    });
    const { uploadId } = (await begin.json()) as { uploadId: string };
    await fetch(`${srv.base}/api/rooms/${room.roomId}/scan/${uploadId}/chunks/0`, { method: "PUT", headers: auth, body: new Uint8Array(buf) });
    await host.request("origin.reset", {});
    const commit = await fetch(`${srv.base}/api/rooms/${room.roomId}/scan/${uploadId}/commit`, { method: "POST", headers: auth });
    expect(commit.status).toBe(404);
    expect(srv.rooms.get(room.code)!.scan).toBeNull();
    await host.close();
  });
});

describe("shared binary fixtures (also checked by Swift, web and Python)", () => {
  const fx = (name: string) => readFileSync(resolve(REPO_ROOT, "protocol/fixtures", name));

  it("accepts the iPhone's sample-room scan bytes", () => {
    const buf = fx("sample-room.rbsc");
    expect(() =>
      validateScanBuffer(buf, { originEpoch: 1, chunkCount: 1, totalBytes: buf.length, vertexCount: 12, triangleCount: 6, synthetic: true }),
    ).not.toThrow();
    expect(() =>
      validateScanBuffer(buf, { originEpoch: 1, chunkCount: 1, totalBytes: buf.length, vertexCount: 12, triangleCount: 6, synthetic: false }),
    ).toThrow();
  });

  it("parses the preview frame header fixture", () => {
    expect(parseFrameHeader(fx("preview-frame.bin"))).toEqual({
      version: 1, orientation: 3, flags: 3, seq: 42, width: 640, height: 360, captureTimeMs: 1234.5,
    });
  });
});
