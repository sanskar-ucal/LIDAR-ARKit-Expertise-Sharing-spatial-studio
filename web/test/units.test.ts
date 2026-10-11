import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guidanceCaption, formatMeters } from "../src/captions";
import { parseFrame } from "../src/frame";
import { parseInvite, type Guidance, type SceneObject } from "../src/protocol";
import { yaw } from "../src/components/RoomPlan";
import { takeInviteFromLocation } from "../src/session";
import { initialState, reduce } from "../src/state";

const messages = JSON.parse(readFileSync(new URL("../../protocol/fixtures/messages.json", import.meta.url), "utf8"));

function frame(seq: number, flags: number, jpeg = [0xff, 0xd8, 0xff, 0xd9]): ArrayBuffer {
  const buf = new ArrayBuffer(24 + jpeg.length);
  const v = new DataView(buf);
  v.setUint32(0, 0x46504252, true);
  v.setUint8(4, 1);
  v.setUint8(5, 2);
  v.setUint16(6, flags, true);
  v.setUint32(8, seq, true);
  v.setUint16(12, 640, true);
  v.setUint16(14, 480, true);
  v.setFloat64(16, 1234.5, true);
  new Uint8Array(buf, 24).set(jpeg);
  return buf;
}

const obj: SceneObject = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "pillar",
  name: "Pillar",
  position: [0, 0, -2],
  rotation: [0, 0, 0, 1],
  dimensions: [0.3, 2.4, 0.3],
  color: "#2a8c94",
  textureRef: null,
  revision: 1,
  originEpoch: 1,
  stale: false,
  owner: "c_e",
  createdBy: "c_e",
  updatedAt: 0,
};

const guidance = (over: Partial<Guidance> = {}): Guidance => ({
  id: "g_1",
  objectId: obj.id,
  state: "active",
  axis: "y",
  tolerance: 0.05,
  start: { position: [0, 0, -2], rotation: [0, 0, 0, 1] },
  target: { position: [0, 0.34, -2], rotation: [0, 0, 0, 1] },
  attempt: null,
  ...over,
  originEpoch: 1,
});

describe("preview frame header", () => {
  it("parses flags, orientation and fields", () => {
    const p = parseFrame(frame(7, 3));
    expect(p?.header).toEqual({ orientation: 2, synthetic: true, trackingLimited: true, seq: 7, width: 640, height: 480, captureTimeMs: 1234.5 });
    expect(Array.from(p!.jpeg)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });
  it("parses the shared fixture produced by the iPhone encoder", () => {
    const bytes = readFileSync(new URL("../../protocol/fixtures/preview-frame.bin", import.meta.url));
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(parseFrame(ab)?.header).toEqual({ orientation: 3, synthetic: true, trackingLimited: true, seq: 42, width: 640, height: 360, captureTimeMs: 1234.5 });
  });
  it("rejects bad magic, version or non-JPEG payload", () => {
    const bad = frame(1, 0);
    new DataView(bad).setUint8(0, 0);
    expect(parseFrame(bad)).toBeNull();
    const ver = frame(1, 0);
    new DataView(ver).setUint8(4, 2);
    expect(parseFrame(ver)).toBeNull();
    expect(parseFrame(frame(1, 0, [0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(parseFrame(new ArrayBuffer(10))).toBeNull();
  });
});

describe("invite links", () => {
  it("reads code and token from the fragment", () => {
    expect(parseInvite("http://10.0.0.61:8787/r/abc234#t=tok_123456789")).toEqual({ code: "ABC234", token: "tok_123456789" });
    expect(parseInvite("http://10.0.0.61:8787/r/ABC234")).toBeNull();
    expect(parseInvite("not a url")).toBeNull();
  });

  it("strips the token from the address bar and keeps it per tab", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as unknown as Storage;
    let replaced = "";
    const history = { replaceState: (_s: unknown, _t: string, url: string) => (replaced = url) } as unknown as History;
    const loc = { href: "http://h:8787/r/ABC234#t=secret_token_1", pathname: "/r/ABC234" } as Location;
    expect(takeInviteFromLocation(loc, storage, history)).toEqual({ code: "ABC234", token: "secret_token_1" });
    expect(replaced).toBe("/r/ABC234");
    const reload = { href: "http://h:8787/r/ABC234", pathname: "/r/ABC234" } as Location;
    expect(takeInviteFromLocation(reload, storage, history)?.token).toBe("secret_token_1");
    const other = { href: "http://h:8787/r/ZZZ999", pathname: "/r/ZZZ999" } as Location;
    expect(takeInviteFromLocation(other, storage, history)).toBeNull();
  });
});

describe("state reducer", () => {
  it("applies the shared server fixtures", () => {
    let s = reduce(initialState, {
      protocolVersion: 1,
      type: "scene.snapshot",
      roomId: "r",
      clientId: "server",
      messageId: "m",
      sceneRevision: 3,
      payload: {
        room: { id: "r", code: "ABC234", hostName: "H", originEpoch: 1, sceneRevision: 3 },
        participants: [],
        objects: [],
        guidance: null,
        comments: [],
        reactions: {},
        scan: null,
        preview: { state: "paused", hostConnected: true, viewers: 1, targetFps: 0, width: 0 },
      },
    });
    for (const f of messages.server) s = reduce(s, f.message);
    expect(s.objects.map((o) => o.id)).toEqual(["6f1c1d1e-8a4b-4c39-9d43-2b7f3e0c9a11"]);
    expect(s.guidance?.attempt?.withinTolerance).toBe(true);
    expect(s.room?.sceneRevision).toBe(6);
    expect(guidanceCaption(s.guidance, s.objects)?.title).toBe("“Pillar 1” is on target");
  });

  it("marks comments on deleted objects instead of dropping them", () => {
    let s = { ...initialState, objects: [obj] };
    s = reduce(s, {
      protocolVersion: 1, type: "comment.added", roomId: "r", clientId: "server", messageId: "m1",
      payload: { comment: { id: "k1", objectId: obj.id, objectName: "Pillar", authorId: "a", authorName: "A", authorRole: "viewer", text: "hi", createdAt: 0, objectDeleted: false } },
    });
    s = reduce(s, { protocolVersion: 1, type: "object.deleted", roomId: "r", clientId: "server", messageId: "m2", payload: { id: obj.id } });
    expect(s.objects).toHaveLength(0);
    expect(s.comments[0]?.objectDeleted).toBe(true);
  });

  it("ignores unknown message types", () => {
    expect(reduce(initialState, { protocolVersion: 1, type: "future.thing", roomId: "", clientId: "", messageId: "", payload: {} })).toBe(initialState);
  });
});

describe("guidance captions", () => {
  it("narrates each state in plain language", () => {
    expect(guidanceCaption(null, [obj])).toBeNull();
    expect(guidanceCaption(guidance({ state: "preview" }), [obj])?.title).toContain("proposing");
    const active = guidanceCaption(guidance(), [obj]);
    expect(active?.title).toBe("Move along the blue (up/down) axis toward the target, 34 cm");
    const near = guidanceCaption(
      guidance({ attempt: { offset: 0.33, position: [0, 0.33, -2], distance: 0.01, withinTolerance: true, holding: false, seq: 3, updatedAt: 0 } }),
      [obj],
    );
    expect(near?.tone).toBe("success");
    expect(guidanceCaption(guidance({ state: "approved" }), [obj])?.title).toContain("Approved");
  });
  it("formats distances", () => {
    expect(formatMeters(0.344)).toBe("34 cm");
    expect(formatMeters(-1.5)).toBe("1.50 m");
  });
});

describe("plan view heading", () => {
  it("extracts yaw about the vertical axis", () => {
    const s = Math.SQRT1_2;
    expect(yaw([0, 0, 0, 1])).toBeCloseTo(0);
    expect(yaw([0, s, 0, s])).toBeCloseTo(Math.PI / 2);
  });
});
