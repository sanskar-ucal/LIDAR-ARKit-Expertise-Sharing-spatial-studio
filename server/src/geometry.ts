export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // [x, y, z, w]
export type Axis = "x" | "y" | "z";

export const AXIS_VECTORS: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export function normalizeQuat(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotate v by unit quaternion q ([x,y,z,w]). */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const u: Vec3 = [x, y, z];
  const uv = cross(u, v);
  const uuv = cross(u, uv);
  return add(v, add(scale(uv, 2 * w), scale(uuv, 2)));
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Position on the guidance line start + axis * offset. */
export function pointOnAxis(start: Vec3, axis: Axis, offset: number): Vec3 {
  return add(start, scale(AXIS_VECTORS[axis], offset));
}

/** Signed offset of p along axis from start, and its perpendicular distance from the line. */
export function projectOntoAxis(start: Vec3, axis: Axis, p: Vec3): { offset: number; perpendicular: number } {
  const d = sub(p, start);
  const offset = dot(d, AXIS_VECTORS[axis]);
  return { offset, perpendicular: distance(p, pointOnAxis(start, axis, offset)) };
}

// Canonical (Y-up, ARKit) <-> Blender (Z-up). See protocol/COORDINATES.md.
export const canonicalToBlender = (c: Vec3): Vec3 => [c[0], -c[2], c[1]];
export const blenderToCanonical = (b: Vec3): Vec3 => [b[0], b[2], -b[1]];
export const quatCanonicalToBlender = (q: Quat): Quat => [q[0], -q[2], q[1], q[3]];
export const quatBlenderToCanonical = (q: Quat): Quat => [q[0], q[2], -q[1], q[3]];
export const dimensionsToBlenderScale = (d: Vec3): Vec3 => [d[0], d[2], d[1]];
export const blenderScaleToDimensions = (s: Vec3): Vec3 => [s[0], s[2], s[1]];
