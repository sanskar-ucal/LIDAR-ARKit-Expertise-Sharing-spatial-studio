// Protocol v1 types as seen by a browser participant (see protocol/PROTOCOL.md).

export const PROTOCOL_VERSION = 1;

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Role = "host" | "expert" | "viewer";
export type Axis = "x" | "y" | "z";
export type ObjectKind =
  | "pillar"
  | "partition"
  | "door"
  | "window"
  | "table"
  | "chair"
  | "couch"
  | "cabinet"
  | "lamp"
  | "tv"
  | "panel"
  | "block";

export interface ObjectPose {
  position: Vec3;
  rotation: Quat;
  dimensions: Vec3;
}

/** Present while a novice's object waits for the expert's decision. */
export interface ProposalInfo {
  byClientId: string;
  byName: string;
  proposedAt: number;
  novice: ObjectPose;
}

export interface ProposalResolved {
  objectId: string;
  objectName: string;
  kind: ObjectKind;
  outcome: "accepted" | "adjusted" | "rejected";
  byName: string;
  note: string | null;
  before: ObjectPose;
  after: ObjectPose | null;
}

export interface SceneObject {
  id: string;
  kind: ObjectKind;
  name: string;
  position: Vec3;
  rotation: Quat;
  dimensions: Vec3;
  color: string;
  textureRef: string | null;
  revision: number;
  originEpoch: number;
  stale: boolean;
  owner: string;
  createdBy: string;
  updatedAt: number;
  proposal?: ProposalInfo | null;
}

export interface Pose {
  position: Vec3;
  rotation: Quat;
}

export interface Attempt {
  offset: number;
  position: Vec3;
  distance: number;
  withinTolerance: boolean;
  holding: boolean;
  seq: number;
  updatedAt: number;
}

export interface Guidance {
  id: string;
  objectId: string;
  state: "preview" | "active" | "approved";
  axis: Axis;
  tolerance: number;
  start: Pose;
  target: Pose;
  attempt: Attempt | null;
  originEpoch: number;
}

export interface Participant {
  clientId: string;
  role: Role;
  displayName: string;
  clientKind: string;
  connected: boolean;
  selectedObjectId: string | null;
}

export interface Comment {
  id: string;
  objectId: string | null;
  objectName: string | null;
  authorId: string;
  authorName: string;
  authorRole: Role;
  text: string;
  createdAt: number;
  objectDeleted: boolean;
  /** Push-to-talk clip; `text` is its transcript or caption. */
  voice?: { clipId: string; durationMs: number; mime: string } | null;
}

/** An expert's teaching prompt, optionally with a "show me" demo on a real object. */
export interface Lesson {
  id: string;
  preset: "scan" | "move" | "rotate" | "scale" | "place" | "custom";
  text: string;
  objectId: string | null;
  kind: ObjectKind | null;
  demo: { from: ObjectPose; to: ObjectPose } | null;
  byName: string;
  state: "open" | "done";
  createdAt: number;
  doneAt: number | null;
  originEpoch: number;
}

export interface Reactions {
  like: string[];
  discuss: string[];
}

export interface ScanMeta {
  scanId: string;
  originEpoch: number;
  vertexCount: number;
  triangleCount: number;
  bytes: number;
  synthetic: boolean;
  committedAt: number;
}

export interface PreviewStatus {
  state: "live" | "paused" | "offline";
  hostConnected: boolean;
  viewers: number;
  targetFps: number;
  width: number;
}

export interface RoomInfo {
  id: string;
  code: string;
  hostName: string;
  originEpoch: number;
  sceneRevision: number;
}

export interface Snapshot {
  room: RoomInfo;
  participants: Participant[];
  objects: SceneObject[];
  guidance: Guidance | null;
  lesson?: Lesson | null;
  comments: Comment[];
  reactions: Record<string, Reactions>;
  scan: ScanMeta | null;
  preview: PreviewStatus;
}

export interface ServerMessage {
  protocolVersion: number;
  type: string;
  roomId: string;
  clientId: string;
  messageId: string;
  sceneRevision?: number;
  originEpoch?: number;
  ackOf?: string;
  payload: any;
}

let counter = 0;
export function messageId(): string {
  counter = (counter + 1) % 1e9;
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()).slice(2);
  return `w-${rand}-${counter}`.slice(0, 64);
}

export function envelope(type: string, payload: unknown, roomId: string, clientId: string): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, roomId, clientId, messageId: messageId(), payload });
}

export const AXIS_INFO: Record<Axis, { color: string; css: string; direction: string; unit: Vec3 }> = {
  x: { color: "red", css: "#db403d", direction: "left/right", unit: [1, 0, 0] },
  y: { color: "blue", css: "#3b6ecc", direction: "up/down", unit: [0, 1, 0] },
  z: { color: "green", css: "#59ad4a", direction: "forward/back", unit: [0, 0, 1] },
};

export const ROLE_LABEL: Record<Role, string> = {
  host: "Novice (phone)",
  expert: "Expert (Blender)",
  viewer: "Observer (learner)",
};

/** Parses an invite link `https://host/r/CODE#t=TOKEN` or the current location. */
export function parseInvite(input: string): { code: string; token: string } | null {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const m = /^\/r\/([A-Za-z0-9]{4,12})\/?$/.exec(url.pathname);
  const token = new URLSearchParams(url.hash.replace(/^#/, "")).get("t");
  if (!m || !token) return null;
  return { code: m[1]!.toUpperCase(), token };
}
