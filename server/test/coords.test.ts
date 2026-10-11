import { describe, expect, it } from "vitest";
import {
  blenderScaleToDimensions,
  blenderToCanonical,
  canonicalToBlender,
  dimensionsToBlenderScale,
  quatBlenderToCanonical,
  quatCanonicalToBlender,
  rotate,
  type Quat,
  type Vec3,
} from "../src/geometry.js";
import { fixtures } from "./helpers.js";

const fx = fixtures.coordinates;
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

describe("coordinate contract (protocol/fixtures/coordinates.json)", () => {
  it.each(fx.points as any[])("point $name", (p: { canonical: Vec3; blender: Vec3 }) => {
    close(canonicalToBlender(p.canonical), p.blender);
    close(blenderToCanonical(p.blender), p.canonical);
  });

  it.each(fx.rotations as any[])("rotation $name", (r: { canonical: Quat; blender: Quat; rotatesCanonicalX: Vec3 }) => {
    close(quatCanonicalToBlender(r.canonical), r.blender);
    close(quatBlenderToCanonical(r.blender), r.canonical);
    close(rotate(r.canonical, [1, 0, 0]), r.rotatesCanonicalX);
    // Rotating in Blender space then converting equals converting then rotating.
    close(rotate(r.blender, canonicalToBlender([1, 0, 0])), canonicalToBlender(r.rotatesCanonicalX));
  });

  it.each(fx.objects as any[])("object $name", (o: any) => {
    close(canonicalToBlender(o.object.position), o.blender.location);
    close(quatCanonicalToBlender(o.object.rotation), o.blender.rotation);
    close(dimensionsToBlenderScale(o.object.dimensions), o.blender.scale);
    close(blenderScaleToDimensions(o.blender.scale), o.object.dimensions);
    if (o.canonicalFaceNormal) close(rotate(o.object.rotation, [0, 0, 1]), o.canonicalFaceNormal);
    if (o.canonicalBounds) {
      const [w, h, d] = o.object.dimensions;
      const p = o.object.position;
      // Base-origin primitives with identity rotation.
      close([p[0] - w / 2, p[1], p[2] - d / 2], o.canonicalBounds.min);
      close([p[0] + w / 2, p[1] + h, p[2] + d / 2], o.canonicalBounds.max);
    }
  });

  it("matrix in fixture equals the implemented mapping", () => {
    const m = fx.matrixCanonicalToBlenderColumnMajor as number[];
    for (const [i, e] of ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]).entries()) {
      close(canonicalToBlender(e), m.slice(i * 3, i * 3 + 3));
    }
  });

  it("round trip", () => {
    const rt = fx.roundTrip;
    close(canonicalToBlender(rt.canonicalPosition), rt.blenderPosition);
    close(quatCanonicalToBlender(rt.canonicalRotation), rt.blenderRotation);
    close(blenderToCanonical(canonicalToBlender(rt.canonicalPosition)), rt.canonicalPosition);
    close(quatBlenderToCanonical(quatCanonicalToBlender(rt.canonicalRotation)), rt.canonicalRotation);
  });
});
