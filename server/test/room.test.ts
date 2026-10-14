import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreatedRoom } from "../src/rooms.js";
import { boot, createRoom, sampleObject, sleep, TestClient } from "./helpers.js";

let srv: Awaited<ReturnType<typeof boot>>;
let room: CreatedRoom;
const clients: TestClient[] = [];

async function join(token: string, name: string, resume?: string) {
  const c = await TestClient.join(srv.ws, room.code, token, name, resume);
  clients.push(c);
  return c;
}

beforeEach(async () => {
  srv = await boot();
  room = await createRoom(srv.base, "Sanskar");
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await srv.close();
});

describe("credentials and roles", () => {
  it("creating a room yields three distinct tokens and links that only carry the token in the fragment", () => {
    expect(new Set([room.hostToken, room.expertToken, room.viewerToken]).size).toBe(3);
    expect(room.viewerLink).toMatch(new RegExp(`/r/${room.code}#t=${room.viewerToken}$`));
    expect(room.viewerLink).not.toContain(room.expertToken);
  });

  it("assigns the role from the token, not from the client", async () => {
    const v = await join(room.viewerToken, "Mum");
    const e = await join(room.expertToken, "Expert");
    const h = await join(room.hostToken, "Host");
    expect([v.role, e.role, h.role]).toEqual(["viewer", "expert", "host"]);
  });

  it("rejects a bad token and a code without a token", async () => {
    const bad = await join("x".repeat(24), "Intruder");
    expect(bad.authError?.payload.code).toBe("unauthorized");
    const wrongRoom = await TestClient.join(srv.ws, "ZZZZZZ", room.viewerToken, "Lost");
    clients.push(wrongRoom);
    expect(wrongRoom.authError?.payload.code).toBe("unauthorized");
  });

  it("a viewer cannot create, update, delete or run guidance", async () => {
    const e = await join(room.expertToken, "Expert");
    const obj = sampleObject();
    expect((await e.request("object.create", { object: obj })).type).toBe("ack");
    const v = await join(room.viewerToken, "Mum");
    for (const [type, payload] of [
      ["object.create", { object: sampleObject() }],
      ["object.update", { id: obj.id, baseRevision: 1, patch: { position: [5, 0, 0] } }],
      ["object.delete", { id: obj.id }],
      ["guidance.set", { objectId: obj.id, axis: "x", targetPosition: [1, 0, -2] }],
      ["room.end", {}],
      ["origin.reset", {}],
    ] as const) {
      const r = await v.request(type, payload);
      expect(r.type, type).toBe("error");
      expect(r.payload.code).toBe("forbidden");
    }
    const host = await join(room.hostToken, "Host");
    const r = await host.request("object.update", { id: obj.id, baseRevision: 1, patch: { position: [5, 0, 0] } });
    expect(r.payload.code).toBe("forbidden");
    expect(srv.rooms.get(room.code)!.getObject(obj.id)!.position).toEqual([0, 0, -2]);
  });

  it("rejects spoofed clientId / roomId in the envelope", async () => {
    const e = await join(room.expertToken, "Expert");
    const r = await e.request("object.create", { object: sampleObject() }, { clientId: "c_someoneelse" });
    expect(r.payload.code).toBe("bad_request");
  });

  it("enforces viewer capacity", async () => {
    for (let i = 0; i < 8; i++) await join(room.viewerToken, `V${i}`);
    const extra = await join(room.viewerToken, "V9");
    expect(extra.authError?.payload.code).toBe("room_full");
  });
});

describe("scene consistency", () => {
  it("broadcasts create/update/delete in order to every participant", async () => {
    const e = await join(room.expertToken, "Expert");
    const h = await join(room.hostToken, "Host");
    const v = await join(room.viewerToken, "Dad");
    const obj = sampleObject({ kind: "pillar", dimensions: [0.3, 2.5, 0.3] });
    await e.request("object.create", { object: obj });
    for (const c of [h, v]) {
      const m = await c.next((m) => m.type === "object.created");
      expect(m.payload.object).toMatchObject({ id: obj.id, revision: 1, stale: false, owner: "expert" });
    }
    await e.request("object.update", { id: obj.id, baseRevision: 1, patch: { position: [1, 0, -1] } });
    const upd = await h.next((m) => m.type === "object.updated");
    expect(upd.payload.object.position).toEqual([1, 0, -1]);
    expect(upd.payload.object.revision).toBe(2);
    await e.request("object.delete", { id: obj.id });
    await v.next((m) => m.type === "object.deleted" && m.payload.id === obj.id);
    expect(srv.rooms.get(room.code)!.objectCount()).toBe(0);
  });

  it("rejects stale revisions and returns the current object", async () => {
    const e = await join(room.expertToken, "Expert");
    const obj = sampleObject();
    await e.request("object.create", { object: obj });
    await e.request("object.update", { id: obj.id, baseRevision: 1, patch: { name: "A" } });
    const r = await e.request("object.update", { id: obj.id, baseRevision: 1, patch: { name: "B" } });
    expect(r.payload.code).toBe("stale_revision");
    expect(r.payload.current).toMatchObject({ name: "A", revision: 2 });
  });

  it("repeated messageIds do not duplicate objects or comments", async () => {
    const e = await join(room.expertToken, "Expert");
    const obj = sampleObject();
    const messageId = randomUUID();
    expect((await e.request("object.create", { object: obj }, { messageId })).type).toBe("ack");
    const again = await e.request("object.create", { object: obj }, { messageId });
    expect(again.type).toBe("ack");
    expect(again.payload.duplicate).toBe(true);
    const cid = randomUUID();
    await e.request("comment.add", { objectId: obj.id, text: "hi" }, { messageId: cid });
    await e.request("comment.add", { objectId: obj.id, text: "hi" }, { messageId: cid });
    const r = srv.rooms.get(room.code)!;
    expect(r.objectCount()).toBe(1);
    expect(r.commentCount()).toBe(1);
    // A new messageId with an existing object id is an explicit duplicate_object error.
    expect((await e.request("object.create", { object: obj })).payload.code).toBe("duplicate_object");
  });

  it("deleting an object keeps its comments, flagged as referring to a deleted object", async () => {
    const e = await join(room.expertToken, "Expert");
    const v = await join(room.viewerToken, "Mum");
    const obj = sampleObject({ name: "Divider" });
    await e.request("object.create", { object: obj });
    await v.request("selection", { objectId: obj.id });
    await v.request("comment.add", { objectId: obj.id, text: "Could this partition be shorter?" });
    const added = await e.next((m) => m.type === "comment.added");
    expect(added.payload.comment).toMatchObject({ objectId: obj.id, objectName: "Divider", authorRole: "viewer" });
    await e.request("object.delete", { id: obj.id });
    expect((await v.request("comment.add", { objectId: obj.id, text: "late" })).payload.code).toBe("not_found");
    const late = await join(room.viewerToken, "Late");
    const snap = await late.request("scene.request", {}).then(() => late.next((m) => m.type === "scene.snapshot"));
    expect(snap.payload.comments).toHaveLength(1);
    expect(snap.payload.comments[0].objectDeleted).toBe(true);
    expect(snap.payload.participants.find((p: any) => p.displayName === "Mum").selectedObjectId).toBeNull();
  });

  it("rate-limits comments", async () => {
    const v = await join(room.viewerToken, "Spammy");
    const results = [];
    for (let i = 0; i < 7; i++) results.push((await v.request("comment.add", { objectId: null, text: `c${i}` })).type);
    expect(results.filter((t) => t === "error").length).toBe(2);
  });
});

describe("reconnect and late join", () => {
  it("late joiners get the full current scene, guidance and recent comments", async () => {
    const e = await join(room.expertToken, "Expert");
    const obj = sampleObject();
    await e.request("object.create", { object: obj });
    await e.request("comment.add", { objectId: obj.id, text: "first" });
    await e.request("guidance.set", { objectId: obj.id, axis: "x", targetPosition: [0.5, 0, -2] });
    const late = new Promise<any>(async (resolve) => {
      const c = await join(room.viewerToken, "Late");
      resolve(c);
    });
    const c = (await late) as TestClient;
    await c.request("scene.request", {});
    const snap = await c.next((m) => m.type === "scene.snapshot");
    expect(snap.payload.objects).toHaveLength(1);
    expect(snap.payload.guidance).toMatchObject({ objectId: obj.id, state: "preview", axis: "x" });
    expect(snap.payload.comments[0].text).toBe("first");
    expect(JSON.stringify(snap)).not.toContain(room.expertToken);
    expect(JSON.stringify(snap)).not.toContain(room.hostToken);
  });

  it("resuming keeps the client id and does not create a duplicate participant", async () => {
    const v = await join(room.viewerToken, "Gran");
    const id = v.clientId;
    await v.close();
    await sleep(50);
    const again = await join(room.viewerToken, "Gran", id);
    expect(again.clientId).toBe(id);
    const snap = await again.request("scene.request", {}).then(() => again.next((m) => m.type === "scene.snapshot"));
    expect(snap.payload.participants.filter((p: any) => p.displayName === "Gran")).toHaveLength(1);
  });

  it("a viewer cannot resume an expert identity", async () => {
    const e = await join(room.expertToken, "Expert");
    const eid = e.clientId;
    await e.close();
    await sleep(30);
    const v = await join(room.viewerToken, "Sneaky", eid);
    expect(v.role).toBe("viewer");
    expect(v.clientId).not.toBe(eid);
  });

  it("host disconnect is visible to viewers as preview offline", async () => {
    const h = await join(room.hostToken, "Host");
    const v = await join(room.viewerToken, "Mum");
    await h.request("preview.status", { state: "live", targetFps: 5, width: 640 });
    await v.next((m) => m.type === "preview.status" && m.payload.state === "live");
    await h.close();
    const st = await v.next((m) => m.type === "preview.status" && m.payload.state === "offline");
    expect(st.payload.hostConnected).toBe(false);
  });

  it("ending the room notifies and disconnects everyone", async () => {
    const h = await join(room.hostToken, "Host");
    const v = await join(room.viewerToken, "Mum");
    expect((await h.request("room.end", {})).type).toBe("ack");
    await v.next((m) => m.type === "room.ended");
    await sleep(50);
    expect(v.closed).toBe(true);
    expect(srv.rooms.get(room.code)).toBeUndefined();
  });
});

describe("guidance and ownership", () => {
  async function setup() {
    const e = await join(room.expertToken, "Expert");
    const h = await join(room.hostToken, "Host");
    const obj = sampleObject({ position: [0, 0, -2] });
    await e.request("object.create", { object: obj });
    return { e, h, obj };
  }

  it("runs set -> begin -> attempt -> approve with server-computed positions", async () => {
    const { e, h, obj } = await setup();
    expect((await e.request("guidance.set", { objectId: obj.id, axis: "x", targetPosition: [0.6, 0, -2], tolerance: 0.05 })).type).toBe("ack");
    const g = (await h.next((m) => m.type === "guidance.state")).payload.guidance;
    expect(g.state).toBe("preview");
    // Host cannot move the attempt before the exercise starts.
    expect((await h.request("guidance.attempt", { guidanceId: g.id, offset: 0.1, seq: 1, holding: true })).payload.code).toBe("invalid_state");
    await e.request("guidance.begin", { guidanceId: g.id });
    h.clear();
    await h.request("guidance.attempt", { guidanceId: g.id, offset: 0.3, seq: 1, holding: true });
    let st = (await e.next((m) => m.type === "guidance.state" && m.payload.guidance?.attempt?.seq === 1)).payload.guidance;
    expect(st.attempt.position).toEqual([0.3, 0, -2]);
    expect(st.attempt.distance).toBeCloseTo(0.3, 6);
    expect(st.attempt.withinTolerance).toBe(false);
    // Out-of-order sample ignored.
    await h.request("guidance.attempt", { guidanceId: g.id, offset: 5, seq: 1, holding: true });
    await h.request("guidance.attempt", { guidanceId: g.id, offset: 0.58, seq: 2, holding: false });
    st = (await e.next((m) => m.type === "guidance.state" && m.payload.guidance?.attempt?.seq === 2)).payload.guidance;
    expect(st.attempt.withinTolerance).toBe(true);
    // The design object itself has not moved: host only controls the attempt.
    expect(srv.rooms.get(room.code)!.getObject(obj.id)!.position).toEqual([0, 0, -2]);
    // Host cannot approve its own attempt.
    expect((await h.request("guidance.approve", { guidanceId: g.id })).payload.code).toBe("forbidden");
    await e.request("guidance.approve", { guidanceId: g.id });
    const upd = await h.next((m) => m.type === "object.updated");
    expect(upd.payload.object.position[0]).toBeCloseTo(0.58, 6);
    expect(upd.payload.object.revision).toBe(2);
  });

  it("rejects targets that are not along the chosen axis", async () => {
    const { e, obj } = await setup();
    const r = await e.request("guidance.set", { objectId: obj.id, axis: "x", targetPosition: [0.5, 0.3, -2] });
    expect(r.payload.code).toBe("target_off_axis");
  });

  it("expert edits during guidance do not fight the attempt, and cancel removes it", async () => {
    const { e, h, obj } = await setup();
    await e.request("guidance.set", { objectId: obj.id, axis: "y", targetPosition: [0, 0.5, -2] });
    const g = (await h.next((m) => m.type === "guidance.state")).payload.guidance;
    await e.request("guidance.begin", { guidanceId: g.id });
    await h.request("guidance.attempt", { guidanceId: g.id, offset: 0.2, seq: 1, holding: true });
    expect((await e.request("object.update", { id: obj.id, baseRevision: 1, patch: { name: "Renamed" } })).type).toBe("ack");
    const live = srv.rooms.get(room.code)!.getGuidance()!;
    expect(live.attempt!.offset).toBe(0.2);
    await e.request("guidance.cancel", { guidanceId: g.id });
    expect(srv.rooms.get(room.code)!.getGuidance()).toBeNull();
    expect((await h.request("guidance.attempt", { guidanceId: g.id, offset: 0.3, seq: 2, holding: true })).payload.code).toBe("not_found");
  });

  it("reset returns the attempt to the start", async () => {
    const { e, h, obj } = await setup();
    await e.request("guidance.set", { objectId: obj.id, axis: "z", targetPosition: [0, 0, -1.5] });
    const g = (await h.next((m) => m.type === "guidance.state")).payload.guidance;
    await e.request("guidance.begin", { guidanceId: g.id });
    await h.request("guidance.attempt", { guidanceId: g.id, offset: 0.4, seq: 1, holding: false });
    await h.request("guidance.reset", { guidanceId: g.id });
    const live = srv.rooms.get(room.code)!.getGuidance()!;
    expect(live.attempt!.offset).toBe(0);
    expect((await h.request("guidance.attempt", { guidanceId: g.id, offset: 0.1, seq: 2, holding: true })).type).toBe("ack");
    expect(srv.rooms.get(room.code)!.getGuidance()!.attempt!.offset).toBe(0.1);
  });

  it("deleting the guided object cancels guidance", async () => {
    const { e, h, obj } = await setup();
    await e.request("guidance.set", { objectId: obj.id, axis: "x", targetPosition: [1, 0, -2] });
    await e.request("object.delete", { id: obj.id });
    await h.next((m) => m.type === "guidance.state" && m.payload.guidance === null);
  });
});

describe("origin epochs", () => {
  it("origin reset rejects stale geometry, marks objects stale and clears the scan", async () => {
    const e = await join(room.expertToken, "Expert");
    const h = await join(room.hostToken, "Host");
    const obj = sampleObject();
    await e.request("object.create", { object: obj });
    await h.request("origin.reset", { reason: "test" });
    const snap = await e.next((m) => m.type === "scene.snapshot" && m.payload.room.originEpoch === 2);
    expect(snap.payload.objects[0].stale).toBe(true);
    expect(snap.payload.scan).toBeNull();
    const stale = await e.request("object.update", { id: obj.id, baseRevision: 1, patch: { position: [0, 0, -1] } }, { originEpoch: 1 });
    expect(stale.payload.code).toBe("stale_epoch");
    // Guidance on a stale object is refused until the expert re-places it.
    expect((await e.request("guidance.set", { objectId: obj.id, axis: "x", targetPosition: [1, 0, -2] })).payload.code).toBe("stale_epoch");
    const fresh = await e.request("object.update", { id: obj.id, baseRevision: 1, patch: { position: [0, 0, -1] } }, { originEpoch: 2 });
    expect(fresh.type).toBe("ack");
    const upd = await h.next((m) => m.type === "object.updated");
    expect(upd.payload.object.stale).toBe(false);
  });
});
