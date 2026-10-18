import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { OBJECT_KINDS, ProtocolError, ROUND_KINDS, validateDimensions } from "../src/protocol.js";

const catalog = JSON.parse(readFileSync(resolve(REPO_ROOT, "protocol/catalog.json"), "utf8"));

describe("object catalog", () => {
  it("lists exactly the kinds the server accepts, in the same order", () => {
    expect(catalog.kinds.map((k: any) => k.kind)).toEqual([...OBJECT_KINDS]);
  });

  it("agrees on which kinds are round", () => {
    expect(catalog.kinds.filter((k: any) => k.round).map((k: any) => k.kind)).toEqual([...ROUND_KINDS]);
  });

  it("every default size is valid and every part fits the unit box", () => {
    for (const k of catalog.kinds) {
      expect(() => validateDimensions(k.kind, k.dimensions), k.kind).not.toThrow();
      expect(["bottom", "center"]).toContain(k.origin);
      expect(["floor", "wall"]).toContain(k.mount);
      expect(k.parts.length).toBeGreaterThan(0);
      const yMin = k.origin === "bottom" ? 0 : -0.5;
      for (const p of k.parts) {
        expect(["box", "cylinder", "sphere"]).toContain(p.shape);
        expect(p.tint).toMatch(/^(base|dark|light|#[0-9a-f]{6})$/);
        // Parts may poke out a little (sills, knobs) but stay near their unit box.
        for (let i = 0; i < 3; i++) {
          const lo = i === 1 ? yMin : -0.5;
          expect(p.center[i] - p.size[i] / 2, `${k.kind} part min`).toBeGreaterThanOrEqual(lo - 0.6);
          expect(p.center[i] + p.size[i] / 2, `${k.kind} part max`).toBeLessThanOrEqual(lo + 1.6);
        }
      }
      expect(k.lesson.length).toBeGreaterThan(10);
      expect(k.blender.length).toBeGreaterThan(5);
    }
  });

  it("round kinds reject elliptical sizes", () => {
    expect(() => validateDimensions("lamp", [0.4, 1.6, 0.6])).toThrowError(ProtocolError);
    expect(() => validateDimensions("table", [1.2, 0.75, 0.8])).not.toThrow();
  });
});
