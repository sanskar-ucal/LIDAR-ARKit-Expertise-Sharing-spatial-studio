import { readFileSync } from "node:fs";
import { describe as suite, expect, it } from "vitest";
import { CATALOG } from "../src/catalog";
import { describe, num } from "../src/narrator";
import type { SceneObject, ServerMessage } from "../src/protocol";
import { initialState, reduce } from "../src/state";

const fx = JSON.parse(readFileSync(new URL("../../protocol/fixtures/narration.json", import.meta.url), "utf8"));

suite("CAD narration (shared fixture)", () => {
  it.each(fx.cases as any[])("$name", (c: any) => {
    expect(describe(c.object, c.before, c.after)).toEqual(c.steps);
  });

  it("formats typed values like Blender input", () => {
    expect([num(0.5), num(-0.4), num(1), num(1.3333), num(-0.001)]).toEqual(["0.5", "-0.4", "1", "1.33", "0"]);
  });

  it("the catalog lists every kind with a lesson", () => {
    expect(CATALOG.map((k) => k.kind)).toContain("couch");
    for (const k of CATALOG) expect(k.lesson.length).toBeGreaterThan(10);
  });
});

suite("learning feed", () => {
  const table: SceneObject = {
    id: "22222222-2222-4222-8222-222222222222",
    kind: "table",
    name: "Table 1",
    position: [0, 0, -2],
    rotation: [0, 0, 0, 1],
    dimensions: [1.2, 0.75, 0.8],
    color: "#a0764f",
    textureRef: null,
    revision: 1,
    originEpoch: 1,
    stale: false,
    owner: "expert",
    createdBy: "c_e",
    updatedAt: 1000,
    proposal: null,
  };
  const msg = (type: string, payload: any, clientId = "c_e"): ServerMessage => ({
    protocolVersion: 1,
    type,
    roomId: "r",
    clientId,
    messageId: `m${Math.random()}`,
    payload,
  });
  const withExpert = { ...initialState, participants: [{ clientId: "c_e", role: "expert" as const, displayName: "Sam", clientKind: "blender", connected: true, selectedObjectId: null }] };

  it("narrates an added object with its lesson", () => {
    const s = reduce(withExpert, msg("object.created", { object: table }));
    expect(s.feed[0]).toMatchObject({ actor: "Sam", steps: [{ concept: "add", text: "added Table 1" }] });
    expect(s.feed[0]?.note).toMatch(/five boxes/);
  });

  it("merges the small updates of one drag into one caption", () => {
    let s = reduce(withExpert, msg("object.created", { object: table }));
    for (let i = 1; i <= 5; i++) {
      s = reduce(s, msg("object.updated", { object: { ...table, position: [i * 0.1, 0, -2], revision: 1 + i, updatedAt: 1000 + i * 150 } }));
    }
    expect(s.feed).toHaveLength(2);
    expect(s.feed[0]?.steps).toEqual([{ concept: "axis", text: "moved Table 1 50 cm along the red X axis (left/right)", shortcut: "G X 0.5" }]);
    // A later, separate edit starts a new caption.
    s = reduce(s, msg("object.updated", { object: { ...table, position: [0.5, 0, -2], dimensions: [1.2, 0.9, 0.8], revision: 7, updatedAt: 9000 } }));
    expect(s.feed[0]?.steps[0]?.shortcut).toBe("S Z 1.2");
  });

  it("does not narrate the novice's own proposal edits or deletions of proposals", () => {
    const proposal = { ...table, proposal: { byClientId: "c_h", byName: "Maya", proposedAt: 0, novice: { position: table.position, rotation: table.rotation, dimensions: table.dimensions } } };
    let s = reduce(withExpert, msg("object.created", { object: proposal }, "c_h"));
    expect(s.feed[0]?.steps[0]?.text).toBe("proposed Table 1");
    s = reduce(s, msg("object.updated", { object: { ...proposal, position: [1, 0, -2], updatedAt: 1200 } }, "c_h"));
    expect(s.feed).toHaveLength(1);
    s = reduce(s, msg("object.deleted", { id: table.id }, "c_h"));
    expect(s.feed).toHaveLength(1);
  });
});
