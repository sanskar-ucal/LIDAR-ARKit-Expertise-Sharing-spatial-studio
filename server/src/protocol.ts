import { z } from "zod";
import type { Axis, Quat, Vec3 } from "./geometry.js";

export const PROTOCOL_VERSION = 1;

export type Role = "host" | "expert" | "viewer";
export type ObjectKind = "pillar" | "partition" | "panel";

export type ErrorCode =
  | "bad_request"
  | "unsupported_protocol"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "room_full"
  | "rate_limited"
  | "stale_revision"
  | "stale_epoch"
  | "duplicate_object"
  | "invalid_dimensions"
  | "target_off_axis"
  | "invalid_state"
  | "too_large"
  | "room_ended";

export class ProtocolError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public current?: unknown,
  ) {
    super(message);
  }
}

const finite = z.number().refine(Number.isFinite, "must be finite");
const vec3 = z.tuple([finite, finite, finite]);
const quat = z.tuple([finite, finite, finite, finite]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortId = z.string().min(1).max(64);

export const objectInputSchema = z.strictObject({
  id: z.string().regex(UUID_RE, "must be a UUID"),
  kind: z.enum(["pillar", "partition", "panel"]),
  name: z.string().trim().min(1).max(60),
  position: vec3,
  rotation: quat,
  dimensions: vec3,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  textureRef: z.union([z.null(), z.literal("sample:picture")]),
});
export type ObjectInput = z.infer<typeof objectInputSchema>;

const objectPatchSchema = objectInputSchema.omit({ id: true, kind: true }).partial().strict();
export type ObjectPatch = z.infer<typeof objectPatchSchema>;

const axis = z.enum(["x", "y", "z"]);

const payloadSchemas = {
  auth: z.strictObject({
    roomCode: z.string().min(1).max(64),
    token: z.string().min(8).max(128),
    displayName: z.string().trim().min(1).max(40),
    clientKind: z.enum(["ios", "blender", "web", "test"]),
    resumeClientId: shortId.optional(),
  }),
  ping: z.object({}),
  "scene.request": z.object({}),
  "room.leave": z.object({}),
  "room.end": z.object({}),
  "origin.reset": z.strictObject({ reason: z.string().max(120).optional() }),
  "object.create": z.strictObject({ object: objectInputSchema }),
  "object.update": z.strictObject({
    id: z.string().regex(UUID_RE),
    baseRevision: z.number().int().min(1),
    patch: objectPatchSchema,
  }),
  "object.delete": z.strictObject({ id: z.string().regex(UUID_RE) }),
  selection: z.strictObject({ objectId: z.union([z.null(), z.string().regex(UUID_RE)]) }),
  "comment.add": z.strictObject({
    objectId: z.union([z.null(), z.string().regex(UUID_RE)]),
    text: z.string().trim().min(1).max(500),
  }),
  "reaction.toggle": z.strictObject({
    objectId: z.string().regex(UUID_RE),
    kind: z.enum(["like", "discuss"]),
  }),
  "guidance.set": z.strictObject({
    objectId: z.string().regex(UUID_RE),
    axis,
    targetPosition: vec3,
    tolerance: z.number().min(0.01).max(0.5).optional(),
  }),
  "guidance.begin": z.strictObject({ guidanceId: shortId }),
  "guidance.attempt": z.strictObject({
    guidanceId: shortId,
    offset: z.number().min(-10).max(10),
    seq: z.number().int().min(0),
    holding: z.boolean(),
  }),
  "guidance.approve": z.strictObject({ guidanceId: shortId }),
  "guidance.reset": z.strictObject({ guidanceId: shortId }),
  "guidance.cancel": z.strictObject({ guidanceId: shortId }),
  "preview.status": z.strictObject({
    state: z.enum(["live", "paused"]),
    targetFps: z.number().min(0).max(30),
    width: z.number().int().min(0).max(4096),
  }),
} as const;

export type ClientType = keyof typeof payloadSchemas;
export type Payload<T extends ClientType> = z.infer<(typeof payloadSchemas)[T]>;

/** Messages whose geometry is only meaningful in the current AR origin epoch. */
export const EPOCH_BOUND: ReadonlySet<ClientType> = new Set<ClientType>([
  "object.create",
  "object.update",
  "guidance.set",
  "guidance.begin",
  "guidance.attempt",
]);

export const PERMISSIONS: Record<ClientType, readonly Role[]> = {
  auth: ["host", "expert", "viewer"],
  ping: ["host", "expert", "viewer"],
  "scene.request": ["host", "expert", "viewer"],
  "room.leave": ["host", "expert", "viewer"],
  selection: ["host", "expert", "viewer"],
  "comment.add": ["host", "expert", "viewer"],
  "reaction.toggle": ["host", "expert", "viewer"],
  "room.end": ["host"],
  "origin.reset": ["host"],
  "preview.status": ["host"],
  "guidance.attempt": ["host"],
  "guidance.reset": ["host", "expert"],
  "object.create": ["expert"],
  "object.update": ["expert"],
  "object.delete": ["expert"],
  "guidance.set": ["expert"],
  "guidance.begin": ["expert"],
  "guidance.approve": ["expert"],
  "guidance.cancel": ["expert"],
};

const envelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.string().min(1).max(40),
  roomId: z.string().max(64),
  clientId: z.string().max(64),
  messageId: shortId,
  sceneRevision: z.number().int().min(0).optional(),
  originEpoch: z.number().int().min(1).optional(),
  payload: z.record(z.string(), z.unknown()),
});

export interface ClientMessage<T extends ClientType = ClientType> {
  protocolVersion: 1;
  type: T;
  roomId: string;
  clientId: string;
  messageId: string;
  sceneRevision?: number;
  originEpoch?: number;
  payload: Payload<T>;
}

function describe(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** Validates the envelope and payload shape. Semantic checks (dimensions etc.) happen in validateObject*. */
export function parseClientMessage(raw: unknown): ClientMessage {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new ProtocolError("bad_request", "Message is not valid JSON");
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProtocolError("bad_request", "Message must be a JSON object");
  }
  const version = (raw as Record<string, unknown>).protocolVersion;
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError("unsupported_protocol", `Expected protocolVersion ${PROTOCOL_VERSION}`);
  }
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) throw new ProtocolError("bad_request", describe(env.error));
  const type = env.data.type as ClientType;
  const schema = payloadSchemas[type];
  if (!Object.prototype.hasOwnProperty.call(payloadSchemas, type) || !schema) {
    throw new ProtocolError("bad_request", `Unknown message type '${env.data.type}'`);
  }
  if (EPOCH_BOUND.has(type) && env.data.originEpoch === undefined) {
    throw new ProtocolError("bad_request", `${type} requires originEpoch`);
  }
  const payload = (schema as z.ZodType).safeParse(env.data.payload);
  if (!payload.success) throw new ProtocolError("bad_request", describe(payload.error));
  return { ...env.data, type, payload: payload.data } as ClientMessage;
}

export const DIM_MIN = 0.01;
export const DIM_MAX = 20;
export const POS_MAX = 100;
const PILLAR_ROUND_TOLERANCE = 0.001;

export function validateDimensions(kind: ObjectKind, d: Vec3): void {
  for (const v of d) {
    if (!(v >= DIM_MIN && v <= DIM_MAX)) {
      throw new ProtocolError("invalid_dimensions", `Each dimension must be between ${DIM_MIN} and ${DIM_MAX} m`);
    }
  }
  if (kind === "pillar" && Math.abs(d[0] - d[2]) > PILLAR_ROUND_TOLERANCE) {
    throw new ProtocolError("invalid_dimensions", "Pillar must be round: dimensions[0] (diameter) must equal dimensions[2]");
  }
}

export function validatePosition(p: Vec3): void {
  if (p.some((v) => Math.abs(v) > POS_MAX)) {
    throw new ProtocolError("bad_request", `Position components must be within ±${POS_MAX} m`);
  }
}

export function validateRotation(q: Quat): Quat {
  const n = Math.hypot(...q);
  if (!(n > 0.9 && n < 1.1)) throw new ProtocolError("bad_request", "Rotation must be a unit quaternion [x,y,z,w]");
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export type { Axis, Quat, Vec3 };
