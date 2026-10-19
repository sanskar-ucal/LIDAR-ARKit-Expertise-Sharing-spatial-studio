import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import type { CreatedRoom } from "../src/rooms.js";
import { boot, createRoom, sampleObject, TestClient } from "./helpers.js";

let srv: Awaited<ReturnType<typeof boot>>;
let room: CreatedRoom;
const clients: TestClient[] = [];

async function join(token: string, name: string) {
  const c = await TestClient.join(srv.ws, room.code, token, name);
  clients.push(c);
  return c;
}

beforeEach(async () => {
  srv = await boot();
  room = await createRoom(srv.base, "Maya");
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await srv.close();
});

const pose = (x: number) => ({ position: [x, 0, -2], rotation: [0, 0, 0, 1], dimensions: [1.2, 0.75, 0.8] });

describe("lessons (expert prompts with show-me demos)", () => {
  it("the expert prompts with a demo, everyone sees it, and the novice marks it done", async () => {
    const host = await join(room.hostToken, "Maya");
    const expert = await join(room.expertToken, "Sam");
    const viewer = await join(room.viewerToken, "Observer");
    const t = sampleObject({ kind: "table", dimensions: [1.2, 0.75, 0.8] });
    await expert.request("object.create", { object: t });
    const r = await expert.request("lesson.prompt", { preset: "move", text: "Watch how the table moves along X", objectId: t.id, demo: { from: pose(0), to: pose(0.5) } });
    expect(r.type).toBe("ack");
    const seen = await viewer.next((m) => m.type === "lesson.state" && m.payload.lesson);
    expect(seen.payload.lesson).toMatchObject({ preset: "move", kind: "table", byName: "Sam", state: "open", demo: { to: { position: [0.5, 0, -2] } } });
    const id = seen.payload.lesson.id;
    expect((await host.request("lesson.done", { lessonId: id })).type).toBe("ack");
    const done = await expert.next((m) => m.type === "lesson.state" && m.payload.lesson?.state === "done");
    expect(done.payload.lesson.doneAt).toBeGreaterThan(0);
    expect((await expert.request("lesson.clear", { lessonId: id })).type).toBe("ack");
    await viewer.next((m) => m.type === "lesson.state" && m.payload.lesson === null);
  });

  it("only the expert prompts and only the novice completes", async () => {
    const host = await join(room.hostToken, "Maya");
    const viewer = await join(room.viewerToken, "Observer");
    expect((await host.request("lesson.prompt", { preset: "custom", text: "hi" })).payload.code).toBe("forbidden");
    expect((await viewer.request("lesson.prompt", { preset: "custom", text: "hi" })).payload.code).toBe("forbidden");
    const expert = await join(room.expertToken, "Sam");
    await expert.request("lesson.prompt", { preset: "custom", text: "Look at the corner" });
    const id = srv.rooms.get(room.code)!.snapshotPayload() as any;
    expect((await expert.request("lesson.done", { lessonId: id.lesson.id })).payload.code).toBe("forbidden");
  });

  it("scan and place prompts complete themselves when the novice does it", async () => {
    const host = await join(room.hostToken, "Maya");
    const expert = await join(room.expertToken, "Sam");
    await expert.request("lesson.prompt", { preset: "place", text: "Place a chair", kind: "chair" });
    await host.request("object.propose", { object: sampleObject({ kind: "table", dimensions: [1.2, 0.75, 0.8] }) });
    expect((srv.rooms.get(room.code)!.snapshotPayload() as any).lesson.state).toBe("open");
    await host.request("object.propose", { object: sampleObject({ kind: "chair", dimensions: [0.45, 0.9, 0.5] }) });
    await expert.next((m) => m.type === "lesson.state" && m.payload.lesson?.state === "done");

    await expert.request("lesson.prompt", { preset: "scan", text: "Scan the whole room" });
    const data = readFileSync(resolve(REPO_ROOT, "protocol/fixtures/sample-room.rbsc"));
    const auth = { authorization: `Bearer ${room.hostToken}` };
    const root = `${srv.base}/api/rooms/${room.roomId}/scan`;
    const begin = await fetch(`${root}/begin`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ originEpoch: 1, chunkCount: 1, totalBytes: data.length, vertexCount: 12, triangleCount: 6, synthetic: true }),
    });
    const { uploadId } = (await begin.json()) as { uploadId: string };
    await fetch(`${root}/${uploadId}/chunks/0`, { method: "PUT", headers: auth, body: data });
    await fetch(`${root}/${uploadId}/commit`, { method: "POST", headers: auth });
    const done = await expert.next((m) => m.type === "lesson.state" && m.payload.lesson?.preset === "scan" && m.payload.lesson.state === "done");
    expect(done.payload.lesson.doneAt).toBeGreaterThan(0);
  });

  it("validates demos and drops the lesson when its object is deleted", async () => {
    const expert = await join(room.expertToken, "Sam");
    const t = sampleObject();
    await expert.request("object.create", { object: t });
    const bad = await expert.request("lesson.prompt", { preset: "scale", text: "x", objectId: t.id, demo: { from: pose(0), to: { ...pose(0), dimensions: [1, -1, 1] } } });
    expect(bad.payload.code).toBe("invalid_dimensions");
    expect((await expert.request("lesson.prompt", { preset: "move", text: "x", objectId: "6f1c1d1e-8a4b-4c39-9d43-2b7f3e0c9a99" })).payload.code).toBe("not_found");
    await expert.request("lesson.prompt", { preset: "rotate", text: "Turn it", objectId: t.id, demo: { from: pose(0), to: { ...pose(0), rotation: [0, 0.7071, 0, 0.7071] } } });
    await expert.request("object.delete", { id: t.id });
    await expert.next((m) => m.type === "lesson.state" && m.payload.lesson === null);
  });

  it("late joiners get the current lesson in the snapshot", async () => {
    const expert = await join(room.expertToken, "Sam");
    await expert.request("lesson.prompt", { preset: "scan", text: "Scan the whole room" });
    expect((srv.rooms.get(room.code)!.snapshotPayload() as any).lesson.text).toBe("Scan the whole room");
  });
});

describe("push-to-talk voice notes", () => {
  async function upload(token: string, body: Uint8Array, type = "audio/mp4") {
    return fetch(`${srv.base}/api/rooms/${room.roomId}/voice`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": type },
      body: new Blob([body as Uint8Array<ArrayBuffer>]),
    });
  }
  const clip = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]);

  it("the expert records, attaches it to a chat message, and everyone can play it", async () => {
    const expert = await join(room.expertToken, "Sam");
    const viewer = await join(room.viewerToken, "Observer");
    const res = await upload(room.expertToken, clip);
    expect(res.status).toBe(201);
    const { clipId } = (await res.json()) as { clipId: string };
    // Not playable until it is attached to a message.
    const early = await fetch(`${srv.base}/api/rooms/${room.roomId}/voice/${clipId}`, { headers: { authorization: `Bearer ${room.viewerToken}` } });
    expect(early.status).toBe(404);
    const r = await expert.request("comment.add", { objectId: null, text: "Put the couch against that wall", voice: { clipId, durationMs: 2400 } });
    expect(r.type).toBe("ack");
    const c = await viewer.next((m) => m.type === "comment.added");
    expect(c.payload.comment).toMatchObject({ authorName: "Sam", text: "Put the couch against that wall", voice: { clipId, durationMs: 2400, mime: "audio/mp4" } });
    const play = await fetch(`${srv.base}/api/rooms/${room.roomId}/voice/${clipId}`, { headers: { authorization: `Bearer ${room.viewerToken}` } });
    expect(play.status).toBe(200);
    expect(play.headers.get("content-type")).toBe("audio/mp4");
    expect(new Uint8Array(await play.arrayBuffer())).toEqual(clip);
    // A clip can only be attached once.
    expect((await expert.request("comment.add", { objectId: null, text: "again", voice: { clipId, durationMs: 2400 } })).payload.code).toBe("not_found");
  });

  it("observers listen and read but cannot send voice notes", async () => {
    expect((await upload(room.viewerToken, clip)).status).toBe(403);
    const host = await join(room.hostToken, "Maya");
    const { clipId } = (await (await upload(room.hostToken, clip, "audio/webm")).json()) as { clipId: string };
    const viewer = await join(room.viewerToken, "Observer");
    expect((await viewer.request("comment.add", { objectId: null, text: "mine", voice: { clipId, durationMs: 900 } })).payload.code).toBe("forbidden");
    // The expert cannot attach the novice's clip either.
    const expert = await join(room.expertToken, "Sam");
    expect((await expert.request("comment.add", { objectId: null, text: "x", voice: { clipId, durationMs: 900 } })).payload.code).toBe("not_found");
    expect((await host.request("comment.add", { objectId: null, text: "(voice note)", voice: { clipId, durationMs: 900 } })).type).toBe("ack");
  });

  it("rejects unknown audio types, empty clips and anonymous uploads", async () => {
    expect((await upload(room.hostToken, clip, "video/mp4")).status).toBe(400);
    expect((await upload(room.hostToken, new Uint8Array())).status).toBe(400);
    const anon = await fetch(`${srv.base}/api/rooms/${room.roomId}/voice`, { method: "POST", headers: { "content-type": "audio/mp4" }, body: new Blob([clip]) });
    expect(anon.status).toBe(401);
  });
});
