// Explains a change between two object states in Blender terms. Must produce exactly the
// steps in protocol/fixtures/narration.json (the iOS app implements the same rules).
// Blender X = canonical x, Blender Y = canonical -z, Blender Z = canonical y.
import type { ObjectPose, Quat, Vec3 } from "./protocol";

export type Concept = "add" | "move" | "axis" | "rotate" | "scale" | "delete" | "approve";

export interface Step {
  concept: Concept;
  text: string;
  shortcut: string;
}

const AXIS = ["X", "Y", "Z"] as const;
const COLOR = ["red", "green", "blue"] as const;
const DIRECTION = ["left/right", "forward/back", "up/down"] as const;
const SIZE = ["width", "depth", "height"] as const;

/** A typed Blender value: at most two decimals, no trailing zeros. */
export function num(v: number): string {
  const s = Number(v.toFixed(2)).toString();
  return s === "-0" ? "0" : s;
}

export function length(m: number): string {
  return m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`;
}

/** Heading about the vertical axis, degrees. */
export function yawDegrees(q: Quat): number {
  const [x, y, z, w] = q;
  return (Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x)) * 180) / Math.PI;
}

function move(name: string, a: Vec3, b: Vec3): Step | null {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const mag = Math.hypot(d[0]!, d[1]!, d[2]!);
  if (mag < 0.01) return null;
  const bl = [d[0]!, -d[2]!, d[1]!];
  let big = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(bl[i]!) > Math.abs(bl[big]!)) big = i;
  if (Math.abs(bl[big]!) >= 0.9 * mag) {
    return {
      concept: "axis",
      text: `moved ${name} ${length(Math.abs(bl[big]!))} along the ${COLOR[big]} ${AXIS[big]} axis (${DIRECTION[big]})`,
      shortcut: `G ${AXIS[big]} ${num(bl[big]!)}`,
    };
  }
  const parts = [0, 1, 2].filter((i) => Math.abs(bl[i]!) >= 0.01).map((i) => `G ${AXIS[i]} ${num(bl[i]!)}`);
  return { concept: "move", text: `moved ${name} ${length(mag)}`, shortcut: parts.join(" · ") };
}

function rotate(name: string, a: Quat, b: Quat): Step | null {
  let delta = yawDegrees(b) - yawDegrees(a);
  while (delta > 180) delta -= 360;
  while (delta <= -180) delta += 360;
  if (Math.abs(delta) < 2) return null;
  const r = Math.round(delta);
  return { concept: "rotate", text: `turned ${name} ${Math.abs(r)}°`, shortcut: `R Z ${r}` };
}

function resize(name: string, a: Vec3, b: Vec3): Step | null {
  const before = [a[0], a[2], a[1]];
  const after = [b[0], b[2], b[1]];
  const ratio = before.map((v, i) => after[i]! / v);
  const changed = [0, 1, 2].filter((i) => Math.abs(ratio[i]! - 1) >= 0.01 && Math.abs(after[i]! - before[i]!) >= 0.005);
  if (changed.length === 0) return null;
  if (changed.length === 3 && Math.max(...ratio) - Math.min(...ratio) < 0.01) {
    return { concept: "scale", text: `scaled ${name} to ${Math.round(ratio[0]! * 100)}%`, shortcut: `S ${num(ratio[0]!)}` };
  }
  const text = `resized ${name}: ` + changed.map((i) => `${SIZE[i]} ${before[i]!.toFixed(2)} → ${after[i]!.toFixed(2)} m`).join(", ");
  if (changed.length === 2 && changed[0] === 0 && changed[1] === 1 && Math.abs(ratio[0]! - ratio[1]!) < 0.01) {
    return { concept: "scale", text, shortcut: `S Shift+Z ${num(ratio[0]!)}` };
  }
  return { concept: "scale", text, shortcut: changed.map((i) => `S ${AXIS[i]} ${num(ratio[i]!)}`).join(" · ") };
}

export function describe(name: string, before: ObjectPose, after: ObjectPose): Step[] {
  return [move(name, before.position, after.position), rotate(name, before.rotation, after.rotation), resize(name, before.dimensions, after.dimensions)].filter(
    (s): s is Step => s !== null,
  );
}

export function poseOf(o: ObjectPose): ObjectPose {
  return { position: o.position, rotation: o.rotation, dimensions: o.dimensions };
}
