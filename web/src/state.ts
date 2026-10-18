import { kindInfo } from "./catalog";
import { describe, poseOf, type Step } from "./narrator";
import type {
  Comment,
  Guidance,
  Lesson,
  ObjectPose,
  Participant,
  PreviewStatus,
  ProposalResolved,
  Reactions,
  Role,
  RoomInfo,
  ScanMeta,
  SceneObject,
  ServerMessage,
} from "./protocol";

export type Connection = "connecting" | "connected" | "reconnecting" | "failed" | "ended";

/** One narrated event: who did what, in Blender terms. */
export interface FeedItem {
  id: string;
  actorId: string;
  actor: string;
  objectId: string;
  steps: Step[];
  note: string | null;
  tone: "info" | "success" | "warning";
  /** Server time of the last change; consecutive edits of one gesture are merged. */
  at: number;
  /** Set on edit items so later updates of the same drag can be merged into one caption. */
  edit?: { name: string; before: ObjectPose; after: ObjectPose };
  /** Replaces "actor + first step" as the headline (prompts, voice notes); steps become details. */
  title?: string;
}

const MAX_FEED = 30;
const GESTURE_MERGE_MS = 1500;

export interface RoomState {
  connection: Connection;
  error: string | null;
  clientId: string | null;
  role: Role | null;
  room: RoomInfo | null;
  participants: Participant[];
  objects: SceneObject[];
  guidance: Guidance | null;
  lesson: Lesson | null;
  comments: Comment[];
  reactions: Record<string, Reactions>;
  scan: ScanMeta | null;
  preview: PreviewStatus | null;
  lastNotice: string | null;
  noticeSeq: number;
  feed: FeedItem[];
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
  lesson: null,
  comments: [],
  reactions: {},
  scan: null,
  preview: null,
  lastNotice: null,
  noticeSeq: 0,
  feed: [],
};

function actorName(s: RoomState, clientId: string): string {
  return s.participants.find((p) => p.clientId === clientId)?.displayName ?? (clientId === "server" ? "RoomBridge" : "Someone");
}

function pushFeed(feed: FeedItem[], item: FeedItem): FeedItem[] {
  return [item, ...feed].slice(0, MAX_FEED);
}

/** Feed entry for an object change, merging the many small updates of one Blender drag. */
function narrateUpdate(s: RoomState, m: ServerMessage, prev: SceneObject, o: SceneObject): FeedItem[] {
  // Approved guidance moves were made by the novice; proposal edits are summarised when decided.
  if (prev.proposal || o.proposal || s.guidance?.objectId === o.id || o.stale) return s.feed;
  const last = s.feed[0];
  const at = o.updatedAt;
  if (last?.edit && last.objectId === o.id && last.actorId === m.clientId && at - last.at < GESTURE_MERGE_MS) {
    const merged: FeedItem = { ...last, at, edit: { ...last.edit, name: o.name, after: poseOf(o) } };
    merged.steps = describe(o.name, merged.edit!.before, merged.edit!.after);
    return merged.steps.length ? [merged, ...s.feed.slice(1)] : s.feed.slice(1);
  }
  const steps = describe(o.name, poseOf(prev), poseOf(o));
  if (!steps.length) return s.feed;
  return pushFeed(s.feed, {
    id: m.messageId,
    actorId: m.clientId,
    actor: actorName(s, m.clientId),
    objectId: o.id,
    steps,
    note: null,
    tone: "info",
    at,
    edit: { name: o.name, before: poseOf(prev), after: poseOf(o) },
  });
}

/** The CAD steps a prompt teaches, in Blender keys. */
export function lessonSteps(l: Lesson, objects: SceneObject[]): Step[] {
  if (l.demo) return describe(objects.find((o) => o.id === l.objectId)?.name ?? "it", l.demo.from, l.demo.to);
  if (l.preset === "place" && l.kind) {
    const info = kindInfo(l.kind);
    return [{ concept: "add", text: `add a ${(info?.label ?? l.kind).toLowerCase()}`, shortcut: info?.blender ?? "" }];
  }
  return [];
}

function narrateLesson(s: RoomState, m: ServerMessage, l: Lesson | null): FeedItem[] {
  const prev = s.lesson;
  const host = s.room?.hostName ?? "The novice";
  if (l && l.state === "open" && prev?.id !== l.id) {
    return pushFeed(s.feed, {
      id: m.messageId,
      actorId: m.clientId,
      actor: l.byName,
      objectId: l.objectId ?? "",
      steps: lessonSteps(l, s.objects),
      note: null,
      tone: "info",
      at: l.createdAt,
      title: `${l.byName} asks ${host}: ${l.text}`,
    });
  }
  if (l && l.state === "done" && prev?.id === l.id && prev.state === "open") {
    return pushFeed(s.feed, {
      id: m.messageId,
      actorId: m.clientId,
      actor: host,
      objectId: l.objectId ?? "",
      steps: [],
      note: null,
      tone: "success",
      at: l.doneAt ?? Date.now(),
      title: `${host} finished: ${l.text}`,
    });
  }
  return s.feed;
}

function narrateResolution(s: RoomState, m: ServerMessage, r: ProposalResolved): FeedItem[] {
  const host = s.room?.hostName ?? "the novice";
  let steps: Step[];
  if (r.outcome === "rejected") {
    steps = [{ concept: "approve", text: `turned down ${host}’s ${r.objectName}`, shortcut: "" }];
  } else if (r.outcome === "adjusted" && r.after) {
    steps = [{ concept: "approve", text: `approved ${host}’s ${r.objectName} after adjusting it`, shortcut: "" }, ...describe("it", r.before, r.after)];
  } else {
    steps = [{ concept: "approve", text: `approved ${host}’s ${r.objectName}`, shortcut: "" }];
  }
  return pushFeed(s.feed, {
    id: m.messageId,
    actorId: m.clientId,
    actor: r.byName,
    objectId: r.objectId,
    steps,
    note: r.note,
    tone: r.outcome === "rejected" ? "warning" : "success",
    at: Date.now(),
  });
}

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
        lesson: p.lesson ?? null,
        comments: (p.comments as Comment[]).slice(-MAX_COMMENTS),
        reactions: p.reactions ?? {},
        scan: p.scan ?? null,
        preview: p.preview,
      };
      break;
    case "object.created":
    case "object.updated": {
      const o = p.object as SceneObject;
      const prev = s.objects.find((x) => x.id === o.id);
      const objects = prev ? s.objects.map((x) => (x.id === o.id ? o : x)) : [...s.objects, o];
      let feed = s.feed;
      if (prev) {
        feed = narrateUpdate(s, m, prev, o);
      } else if (!o.stale) {
        const info = kindInfo(o.kind);
        feed = pushFeed(s.feed, {
          id: m.messageId,
          actorId: m.clientId,
          actor: actorName(s, m.clientId),
          objectId: o.id,
          steps: [{ concept: "add", text: `${o.proposal ? "proposed" : "added"} ${o.name}`, shortcut: info?.blender ?? "" }],
          note: info?.lesson ?? null,
          tone: "info",
          at: o.updatedAt,
        });
      }
      next = { ...s, objects, feed };
      break;
    }
    case "object.deleted": {
      const { [p.id]: _gone, ...reactions } = s.reactions;
      const prev = s.objects.find((x) => x.id === p.id);
      // Rejected proposals are explained by proposal.resolved; withdrawn ones need no caption.
      const feed =
        prev && !prev.proposal
          ? pushFeed(s.feed, {
              id: m.messageId,
              actorId: m.clientId,
              actor: actorName(s, m.clientId),
              objectId: prev.id,
              steps: [{ concept: "delete", text: `deleted ${prev.name}`, shortcut: "X › Delete" }],
              note: null,
              tone: "info",
              at: Date.now(),
            })
          : s.feed;
      next = {
        ...s,
        objects: s.objects.filter((x) => x.id !== p.id),
        reactions,
        comments: s.comments.map((c) => (c.objectId === p.id ? { ...c, objectDeleted: true } : c)),
        feed,
      };
      break;
    }
    case "proposal.resolved":
      next = { ...s, feed: narrateResolution(s, m, p as ProposalResolved) };
      break;
    case "presence":
      next = { ...s, participants: p.participants };
      break;
    case "comment.added": {
      const c = p.comment as Comment;
      if (s.comments.some((x) => x.id === c.id)) {
        next = s;
        break;
      }
      const feed = c.voice
        ? pushFeed(s.feed, {
            id: m.messageId,
            actorId: c.authorId,
            actor: c.authorName,
            objectId: c.objectId ?? "",
            steps: [],
            note: null,
            tone: "info",
            at: c.createdAt,
            title: `🎤 ${c.authorName}: ${c.text}`,
          })
        : s.feed;
      next = { ...s, comments: [...s.comments, c].slice(-MAX_COMMENTS), feed };
      break;
    }
    case "lesson.state":
      next = { ...s, lesson: p.lesson ?? null, feed: narrateLesson(s, m, p.lesson ?? null) };
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
