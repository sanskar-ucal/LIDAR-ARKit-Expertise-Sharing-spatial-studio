import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const table = () => sampleObject({ kind: "table", name: "Table", dimensions: [1.2, 0.75, 0.8], color: "#a0764f" });

describe("novice proposals", () => {
  it("the novice proposes, edits and withdraws; viewers cannot propose", async () => {
    const host = await join(room.hostToken, "Maya");
    const expert = await join(room.expertToken, "Sam");
    const t = table();
    expect((await host.request("object.propose", { object: t })).type).toBe("ack");
    const created = await expert.next((m) => m.type === "object.created");
    expect(created.payload.object).toMatchObject({ kind: "table", owner: "host", proposal: { byName: "Maya" } });

    expect((await host.request("object.update", { id: t.id, baseRevision: 1, patch: { position: [0.5, 0, -2] } })).type).toBe("ack");
    const upd = await expert.next((m) => m.type === "object.updated");
    expect(upd.payload.object.proposal.novice.position).toEqual([0.5, 0, -2]);

    expect((await host.request("object.delete", { id: t.id })).type).toBe("ack");
    await expert.next((m) => m.type === "object.deleted" && m.payload.id === t.id);
    // A withdrawal is not a rejection.
    expect(expert.inbox.some((m) => m.type === "proposal.resolved")).toBe(false);

    const viewer = await join(room.viewerToken, "Mum");
    expect((await viewer.request("object.propose", { object: table() })).payload.code).toBe("forbidden");
  });

  it("the novice cannot touch the expert's objects or guide a proposal", async () => {
    const host = await join(room.hostToken, "Maya");
    const expert = await join(room.expertToken, "Sam");
    const mine = sampleObject();
    await expert.request("object.create", { object: mine });
    expect((await host.request("object.update", { id: mine.id, baseRevision: 1, patch: { name: "X" } })).payload.code).toBe("forbidden");
    expect((await host.request("object.delete", { id: mine.id })).payload.code).toBe("forbidden");
    const t = table();
    await host.request("object.propose", { object: t });
    const g = await expert.request("guidance.set", { objectId: t.id, axis: "x", targetPosition: [0.5, 0, -2] });
    expect(g.payload.code).toBe("invalid_state");
  });

  it("accepting unchanged tells everyone it was accepted, and the expert now owns it", async () => {
    const host = await join(room.hostToken, "Maya");
    const expert = await join(room.expertToken, "Sam");
    const t = table();
    await host.request("object.propose", { object: t });
    expect((await expert.request("proposal.accept", { id: t.id })).type).toBe("ack");
    const res = await host.next((m) => m.type === "proposal.resolved");
    expect(res.payload).toMatchObject({ objectId: t.id, outcome: "accepted", byName: "Sam", note: null, after: { position: t.position } });
    const obj = srv.rooms.get(room.code)!.getObject(t.id)!;
    expect(obj.proposal).toBeNull();
    expect(obj.owner).toBe("expert");
    // Now it is the expert's object: the novice can no longer edit it.
    expect((await host.request("object.update", { id: t.id, baseRevision: obj.revision, patch: { name: "Y" } })).payload.code).toBe("forbidden");
    expect((await expert.request("proposal.accept", { id: t.id })).payload.code).toBe("invalid_state");
  });

  it("an expert adjustment before accepting is reported with the before/after poses and the note", async () => {
    const host = await join(room.hostToken, "Maya");
    const expert = await join(room.expertToken, "Sam");
    const t = table();
    await host.request("object.propose", { object: t });
    await expert.request("object.update", { id: t.id, baseRevision: 1, patch: { position: [0, 0, -2.3] } });
    await expert.request("proposal.accept", { id: t.id, note: "Moved it off the walkway" });
    const res = await host.next((m) => m.type === "proposal.resolved");
    expect(res.payload.outcome).toBe("adjusted");
    expect(res.payload.before.position).toEqual([0, 0, -2]);
    expect(res.payload.after.position).toEqual([0, 0, -2.3]);
    const c = await host.next((m) => m.type === "comment.added");
    expect(c.payload.comment).toMatchObject({ objectId: t.id, authorRole: "expert", text: "Moved it off the walkway" });
  });

  it("rejecting (or deleting) a proposal removes it and explains why", async () => {
    const host = await join(room.hostToken, "Maya");
    const expert = await join(room.expertToken, "Sam");
    const a = table();
    await host.request("object.propose", { object: a });
    await expert.request("proposal.reject", { id: a.id, note: "Too big for this corner" });
    await host.next((m) => m.type === "object.deleted" && m.payload.id === a.id);
    const res = await host.next((m) => m.type === "proposal.resolved");
    expect(res.payload).toMatchObject({ outcome: "rejected", note: "Too big for this corner", after: null });
    const c = await host.next((m) => m.type === "comment.added");
    expect(c.payload.comment.objectId).toBe(a.id);

    const b = table();
    await host.request("object.propose", { object: b });
    await expert.request("object.delete", { id: b.id });
    const res2 = await host.next((m) => m.type === "proposal.resolved" && m.payload.objectId === b.id);
    expect(res2.payload).toMatchObject({ outcome: "rejected", note: null });
  });

  it("limits how many proposals can wait at once", async () => {
    const host = await join(room.hostToken, "Maya");
    for (let i = 0; i < 12; i++) expect((await host.request("object.propose", { object: table() })).type).toBe("ack");
    expect((await host.request("object.propose", { object: table() })).payload.code).toBe("too_large");
  });

  it("late joiners see pending proposals in the snapshot", async () => {
    const host = await join(room.hostToken, "Maya");
    const t = table();
    await host.request("object.propose", { object: t });
    const late = new Promise<any>((resolve) => {
      void TestClient.join(srv.ws, room.code, room.expertToken, "Late").then((c) => {
        clients.push(c);
        resolve(srv.rooms.get(room.code)!.snapshotPayload());
      });
    });
    const snap = await late;
    expect(snap.objects[0].proposal.byName).toBe("Maya");
  });
});
