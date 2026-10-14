import type { Comment, Guidance, Participant, PreviewStatus, Reactions, Role, RoomInfo, ScanMeta, SceneObject, ServerMessage } from "./protocol";

export type Connection = "connecting" | "connected" | "reconnecting" | "failed" | "ended";

export interface RoomState {
  connection: Connection;
  error: string | null;
  clientId: string | null;
  role: Role | null;
  room: RoomInfo | null;
  participants: Participant[];
  objects: SceneObject[];
  guidance: Guidance | null;
  comments: Comment[];
  reactions: Record<string, Reactions>;
  scan: ScanMeta | null;
  preview: PreviewStatus | null;
  lastNotice: string | null;
  noticeSeq: number;
}

export const initialState: RoomState = {
  connection: "connecting",
  error: null,
  clientId: null,
  role: null,
  room: null,
  participants: [],
  objects: [],
  guidance: null,
  comments: [],
  reactions: {},
  scan: null,
  preview: null,
  lastNotice: null,
  noticeSeq: 0,
};

const MAX_COMMENTS = 500;

/** Pure reducer for control-channel messages. A snapshot always replaces everything. */
export function reduce(s: RoomState, m: ServerMessage): RoomState {
  const p = m.payload ?? {};
  let next: RoomState;
  switch (m.type) {
    case "auth.ok":
      next = { ...s, clientId: p.clientId, role: p.role, connection: "connected", error: null };
      break;
    case "auth.error":
      next = { ...s, connection: "failed", error: p.message ?? "Could not join" };
      break;
    case "scene.snapshot":
      next = {
        ...s,
        room: p.room,
        participants: p.participants,
        objects: p.objects,
        guidance: p.guidance ?? null,
        comments: (p.comments as Comment[]).slice(-MAX_COMMENTS),
        reactions: p.reactions ?? {},
        scan: p.scan ?? null,
        preview: p.preview,
      };
      break;
    case "object.created":
    case "object.updated": {
      const o = p.object as SceneObject;
      const i = s.objects.findIndex((x) => x.id === o.id);
      const objects = i >= 0 ? s.objects.map((x) => (x.id === o.id ? o : x)) : [...s.objects, o];
      next = { ...s, objects };
      break;
    }
    case "object.deleted": {
      const { [p.id]: _gone, ...reactions } = s.reactions;
      next = {
        ...s,
        objects: s.objects.filter((x) => x.id !== p.id),
        reactions,
        comments: s.comments.map((c) => (c.objectId === p.id ? { ...c, objectDeleted: true } : c)),
      };
      break;
    }
    case "presence":
      next = { ...s, participants: p.participants };
      break;
    case "comment.added":
      next = s.comments.some((c) => c.id === p.comment.id) ? s : { ...s, comments: [...s.comments, p.comment].slice(-MAX_COMMENTS) };
      break;
    case "reaction.updated":
      next = { ...s, reactions: { ...s.reactions, [p.objectId]: { like: p.like, discuss: p.discuss } } };
      break;
    case "guidance.state":
      next = { ...s, guidance: p.guidance ?? null };
      break;
    case "scan.ready":
      next = { ...s, scan: p.scan };
      break;
    case "preview.status":
      next = { ...s, preview: p as PreviewStatus };
      break;
    case "room.ended":
      next = { ...s, connection: "ended", error: `The room has ended (${p.reason ?? "closed"}).` };
      break;
    case "error":
      next = { ...s, lastNotice: p.message ?? "Something went wrong", noticeSeq: s.noticeSeq + 1 };
      break;
    default:
      return s;
  }
  if (typeof m.sceneRevision === "number" && next.room && next.room.sceneRevision !== m.sceneRevision) {
    next = { ...next, room: { ...next.room, sceneRevision: m.sceneRevision } };
  }
  return next;
}
