import { LIMITS } from "./config.js";
import { distance, pointOnAxis, projectOntoAxis, type Axis, type Quat, type Vec3 } from "./geometry.js";
import { hashToken, randomId, tokenMatches } from "./ids.js";
import { log } from "./log.js";
import { PreviewHub } from "./preview.js";
import {
  EPOCH_BOUND,
  PERMISSIONS,
  PROTOCOL_VERSION,
  ProtocolError,
  validateDimensions,
  validatePosition,
  validateRotation,
  type ClientMessage,
  type LessonPreset,
  type ObjectInput,
  type ObjectKind,
  type Payload,
  type Role,
} from "./protocol.js";
import { WindowLimiter, BoundedSet } from "./ratelimit.js";
import type { ScanMeta, ScanStaging } from "./scan.js";

export interface Sink {
  send(msg: object): void;
  close(code: number, reason: string): void;
}

export type ClientKind = "ios" | "blender" | "web" | "test";

export interface Participant {
  clientId: string;
  role: Role;
  displayName: string;
  clientKind: ClientKind;
  connected: boolean;
  selectedObjectId: string | null;
  joinedAt: number;
  disconnectedAt: number | null;
}

interface ParticipantRecord extends Participant {
  sink: Sink | null;
  previewTicket: string | null;
}

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
  /** The novice's latest version, so the server can tell the novice what the expert changed. */
  novice: ObjectPose;
}

export interface SceneObject extends ObjectInput {
  revision: number;
  originEpoch: number;
  owner: "expert" | "host";
  createdBy: string;
  updatedAt: number;
  proposal: ProposalInfo | null;
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
  /** Push-to-talk clip; `text` is its transcript or a typed caption. */
  voice: { clipId: string; durationMs: number; mime: string } | null;
}

interface VoiceClip {
  data: Buffer;
  mime: string;
  role: Role;
  createdAt: number;
  attached: boolean;
}

export interface Lesson {
  id: string;
  preset: LessonPreset;
  text: string;
  objectId: string | null;
  kind: ObjectKind | null;
  /** A non-realistic "show me" animation: the phone loops a ghost of the object from `from` to `to`. */
  demo: { from: ObjectPose; to: ObjectPose } | null;
  byName: string;
  state: "open" | "done";
  createdAt: number;
  doneAt: number | null;
  originEpoch: number;
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

export interface HostPreview {
  state: "live" | "paused";
  targetFps: number;
  width: number;
}

const pose = (o: ObjectPose): ObjectPose => ({ position: [...o.position], rotation: [...o.rotation], dimensions: [...o.dimensions] });

/** True if the expert changed the novice's proposal noticeably (1 cm, 1 degree, 5 mm). */
function poseChanged(a: ObjectPose, b: ObjectPose): boolean {
  if (distance(a.position, b.position) > 0.01) return true;
  if (a.dimensions.some((v, i) => Math.abs(v - b.dimensions[i]!) > 0.005)) return true;
  const dot = Math.abs(a.rotation.reduce((s, v, i) => s + v * b.rotation[i]!, 0));
  return 2 * Math.acos(Math.min(1, dot)) > (1 * Math.PI) / 180;
}

const DEFAULT_TOLERANCE = 0.05;
const TARGET_ON_AXIS_TOLERANCE = 0.01;
const MAX_TARGET_DISTANCE = 10;

export interface RoomTokens {
  host: string;
  expert: string;
  viewer: string;
}

export class Room {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly preview: PreviewHub;
  originEpoch = 1;
  sceneRevision = 0;
  lastActivity: number;
  ended = false;
  scan: { meta: ScanMeta; data: Buffer } | null = null;
  staging: ScanStaging | null = null;
  onEnded: ((room: Room) => void) | null = null;
  /** Called when tickets change so the registry can index them. */
  onTicket: ((ticket: string, room: Room, clientId: string | null) => void) | null = null;

  private tokenHashes: Record<Role, Buffer>;
  private participants = new Map<string, ParticipantRecord>();
  private objects = new Map<string, SceneObject>();
  private comments: Comment[] = [];
  private reactions = new Map<string, { like: Set<string>; discuss: Set<string> }>();
  private guidance: Guidance | null = null;
  private lesson: Lesson | null = null;
  private voiceClips = new Map<string, VoiceClip>();
  private hostPreview: HostPreview = { state: "paused", targetFps: 0, width: 0 };
  private dedupe = new BoundedSet(LIMITS.dedupeEntries);
  private commentLimiter = new WindowLimiter(LIMITS.commentsPerWindow, LIMITS.commentWindowMs, 100);

  constructor(
    readonly id: string,
    readonly code: string,
    readonly hostName: string,
    tokens: RoomTokens,
    maxTtlMs: number,
    private now: () => number = Date.now,
  ) {
    this.tokenHashes = { host: hashToken(tokens.host), expert: hashToken(tokens.expert), viewer: hashToken(tokens.viewer) };
    this.createdAt = now();
    this.expiresAt = this.createdAt + maxTtlMs;
    this.lastActivity = this.createdAt;
    this.preview = new PreviewHub(now);
  }

  roleForToken(token: string): Role | null {
    for (const role of ["host", "expert", "viewer"] as const) {
      if (tokenMatches(token, this.tokenHashes[role])) return role;
    }
    return null;
  }

  // ---------------------------------------------------------------- membership

  attach(
    sink: Sink,
    role: Role,
    displayName: string,
    clientKind: ClientKind,
    resumeClientId?: string,
  ): { clientId: string; previewTicket: string } {
    if (this.ended) throw new ProtocolError("room_ended", "Room has ended");
    const now = this.now();
    let rec = resumeClientId ? this.participants.get(resumeClientId) : undefined;
    if (rec && rec.role !== role) rec = undefined;

    if (rec) {
      if (rec.sink) rec.sink.close(4002, "replaced by reconnect");
    } else {
      const connected = [...this.participants.values()].filter((p) => p.role === role && p.connected);
      if (role === "host") {
        for (const old of connected) {
          old.sink?.close(4002, "replaced by another host connection");
          this.dropParticipant(old.clientId);
        }
      } else if (connected.length >= (role === "expert" ? LIMITS.maxExperts : LIMITS.maxViewers)) {
        throw new ProtocolError("room_full", `This room already has the maximum number of ${role}s`);
      }
      rec = {
        clientId: randomId("c_"),
        role,
        displayName,
        clientKind,
        connected: false,
        selectedObjectId: null,
        joinedAt: now,
        disconnectedAt: null,
        sink: null,
        previewTicket: null,
      };
      this.participants.set(rec.clientId, rec);
    }

    if (rec.previewTicket) this.onTicket?.(rec.previewTicket, this, null);
    rec.previewTicket = randomId("t_", 18);
    this.onTicket?.(rec.previewTicket, this, rec.clientId);
    rec.sink = sink;
    rec.connected = true;
    rec.disconnectedAt = null;
    rec.displayName = displayName;
    rec.clientKind = clientKind;
    this.lastActivity = now;

    sink.send(
      this.envelope("auth.ok", rec.clientId, {
        clientId: rec.clientId,
        role,
        roomId: this.id,
        code: this.code,
        hostName: this.hostName,
        previewTicket: rec.previewTicket,
        limits: { controlMaxBytes: LIMITS.controlMaxBytes, previewMaxBytes: LIMITS.previewMaxBytes, previewMaxFps: LIMITS.previewMaxFps },
      }),
    );
    sink.send(this.envelope("scene.snapshot", "server", this.snapshotPayload()));
    this.broadcastPresence();
    if (role === "host") this.broadcastPreviewStatus();
    log.info("participant attached", { room: this.code, clientId: rec.clientId, role, clientKind });
    return { clientId: rec.clientId, previewTicket: rec.previewTicket };
  }

  detach(clientId: string, sink: Sink): void {
    const rec = this.participants.get(clientId);
    if (!rec || rec.sink !== sink) return;
    rec.sink = null;
    rec.connected = false;
    rec.disconnectedAt = this.now();
    rec.selectedObjectId = null;
    this.lastActivity = this.now();
    if (rec.role === "host" && this.guidance?.attempt?.holding) {
      this.guidance.attempt.holding = false;
      this.broadcastGuidance("server");
    }
    this.broadcastPresence();
    if (rec.role === "host") this.broadcastPreviewStatus();
  }

  private dropParticipant(clientId: string): void {
    const rec = this.participants.get(clientId);
    if (!rec) return;
    if (rec.previewTicket) this.onTicket?.(rec.previewTicket, this, null);
    this.preview.removeClient(clientId);
    this.participants.delete(clientId);
  }

  participantFor(clientId: string): Participant | undefined {
    return this.participants.get(clientId);
  }

  connectedCount(): number {
    let n = 0;
    for (const p of this.participants.values()) if (p.connected) n++;
    return n;
  }

  /** Remove long-disconnected participants. Returns true if the room should be destroyed. */
  sweep(idleTtlMs: number): boolean {
    const now = this.now();
    let changed = false;
    for (const p of [...this.participants.values()]) {
      if (!p.connected && p.disconnectedAt !== null && now - p.disconnectedAt > LIMITS.resumeGraceMs) {
        this.dropParticipant(p.clientId);
        changed = true;
      }
    }
    if (changed) this.broadcastPresence();
    if (this.staging && now - this.staging.createdAt > LIMITS.scanStagingTtlMs) this.staging = null;
    if (now >= this.expiresAt) return true;
    return this.connectedCount() === 0 && now - this.lastActivity > idleTtlMs;
  }

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    const msg = this.envelope("room.ended", "server", { reason });
    for (const p of this.participants.values()) {
      if (p.sink) {
        p.sink.send(msg);
        p.sink.close(4000, "room ended");
      }
      if (p.previewTicket) this.onTicket?.(p.previewTicket, this, null);
    }
    this.participants.clear();
    this.preview.closeAll("room ended");
    this.scan = null;
    this.staging = null;
    this.comments = [];
    this.objects.clear();
    this.voiceClips.clear();
    this.lesson = null;
    log.info("room ended", { room: this.code, reason });
    this.onEnded?.(this);
  }

  // ---------------------------------------------------------------- messages

  handle(clientId: string, msg: ClientMessage): void {
    const rec = this.participants.get(clientId);
    if (!rec || !rec.connected || !rec.sink) return;
    const sink = rec.sink;
    this.lastActivity = this.now();
    try {
      if (this.ended) throw new ProtocolError("room_ended", "Room has ended");
      if (msg.type === "auth") throw new ProtocolError("bad_request", "Already authenticated");
      if (msg.roomId !== this.id || msg.clientId !== clientId) {
        throw new ProtocolError("bad_request", "roomId/clientId do not match this connection");
      }
      if (!PERMISSIONS[msg.type].includes(rec.role)) {
        throw new ProtocolError("forbidden", `A ${rec.role} may not send ${msg.type}`);
      }
      if (msg.type === "ping") {
        sink.send(this.envelope("pong", "server", {}, { ackOf: msg.messageId }));
        return;
      }
      const key = `${clientId}:${msg.messageId}`;
      if (this.dedupe.has(key)) {
        sink.send(this.envelope("ack", "server", { ackOf: msg.messageId, duplicate: true }, { ackOf: msg.messageId }));
        return;
      }
      if (EPOCH_BOUND.has(msg.type) && msg.originEpoch !== this.originEpoch) {
        throw new ProtocolError("stale_epoch", `Message is for origin epoch ${msg.originEpoch}; current is ${this.originEpoch}`);
      }
      if (msg.type === "room.end") {
        sink.send(this.envelope("ack", "server", { ackOf: msg.messageId }, { ackOf: msg.messageId }));
        this.end("ended_by_host");
        return;
      }
      this.dispatch(rec, msg);
      this.dedupe.add(key);
      if (!this.ended && rec.sink) {
        rec.sink.send(this.envelope("ack", "server", { ackOf: msg.messageId }, { ackOf: msg.messageId }));
      }
    } catch (err) {
      if (!(err instanceof ProtocolError)) {
        log.error("unexpected error handling message", { type: msg.type, error: String(err) });
        err = new ProtocolError("bad_request", "Internal error");
      }
      const e = err as ProtocolError;
      sink.send(
        this.envelope(
          "error",
          "server",
          { ackOf: msg.messageId, code: e.code, message: e.message, ...(e.current !== undefined ? { current: e.current } : {}) },
          { ackOf: msg.messageId },
        ),
      );
    }
  }

  private dispatch(rec: ParticipantRecord, msg: ClientMessage): void {
    const p = msg.payload as never;
    switch (msg.type) {
      case "scene.request":
        rec.sink?.send(this.envelope("scene.snapshot", "server", this.snapshotPayload()));
        return;
      case "room.leave":
        rec.sink?.close(1000, "left");
        this.dropParticipant(rec.clientId);
        this.broadcastPresence();
        if (rec.role === "host") this.broadcastPreviewStatus();
        return;
      case "room.end":
        return this.end("ended_by_host");
      case "origin.reset":
        return this.resetOrigin(rec);
      case "object.create":
        return this.createObject(rec, p);
      case "object.propose":
        return this.proposeObject(rec, p);
      case "proposal.accept":
        return this.acceptProposal(rec, p);
      case "proposal.reject":
        return this.rejectProposal(rec, p);
      case "object.update":
        return this.updateObject(rec, p);
      case "object.delete":
        return this.deleteObject(rec, p);
      case "selection":
        return this.select(rec, p);
      case "comment.add":
        return this.addComment(rec, p);
      case "reaction.toggle":
        return this.toggleReaction(rec, p);
      case "guidance.set":
        return this.setGuidance(rec, p);
      case "guidance.begin":
        return this.beginGuidance(rec, p);
      case "guidance.attempt":
        return this.attempt(rec, p);
      case "guidance.approve":
        return this.approve(rec, p);
      case "guidance.reset":
        return this.resetAttempt(rec, p);
      case "guidance.cancel":
        return this.cancelGuidance(rec, p);
      case "preview.status":
        return this.setPreviewStatus(p);
      case "lesson.prompt":
        return this.promptLesson(rec, p);
      case "lesson.done":
        return this.lessonDone(rec, p);
      case "lesson.clear":
        return this.clearLesson(rec, p);
      default:
        throw new ProtocolError("bad_request", `Unhandled type ${msg.type}`);
    }
  }

  private resetOrigin(rec: ParticipantRecord): void {
    this.originEpoch += 1;
    this.sceneRevision += 1;
    this.scan = null;
    this.staging = null;
    this.guidance = null;
    if (this.lesson?.demo) this.lesson = null; // its demo poses belong to the old origin
    log.info("origin reset", { room: this.code, epoch: this.originEpoch });
    const snap = this.envelope("scene.snapshot", rec.clientId, this.snapshotPayload());
    this.broadcast(snap);
  }

  private createObject(rec: ParticipantRecord, p: Payload<"object.create">): void {
    this.insertObject(rec, p.object, null);
  }

  private proposeObject(rec: ParticipantRecord, p: Payload<"object.propose">): void {
    let pending = 0;
    for (const o of this.objects.values()) if (o.proposal) pending++;
    if (pending >= LIMITS.maxPendingProposals) {
      throw new ProtocolError("too_large", `At most ${LIMITS.maxPendingProposals} proposals can wait for the expert at once`);
    }
    const input = p.object;
    this.insertObject(rec, input, {
      byClientId: rec.clientId,
      byName: rec.displayName,
      proposedAt: this.now(),
      novice: pose({ ...input, rotation: validateRotation(input.rotation) }),
    });
    const l = this.lesson;
    if (l && l.state === "open" && l.preset === "place" && (l.kind === null || l.kind === input.kind)) this.completeLesson(rec.clientId);
  }

  private insertObject(rec: ParticipantRecord, input: ObjectInput, proposal: ProposalInfo | null): void {
    const id = input.id.toLowerCase();
    const existing = this.objects.get(id);
    if (existing) throw new ProtocolError("duplicate_object", "An object with this id already exists", this.serializeObject(existing));
    if (this.objects.size >= LIMITS.maxObjects) throw new ProtocolError("too_large", `At most ${LIMITS.maxObjects} objects`);
    validateDimensions(input.kind, input.dimensions);
    validatePosition(input.position);
    const obj: SceneObject = {
      ...input,
      id,
      rotation: validateRotation(input.rotation),
      revision: 1,
      originEpoch: this.originEpoch,
      owner: proposal ? "host" : "expert",
      createdBy: rec.clientId,
      updatedAt: this.now(),
      proposal,
    };
    this.objects.set(id, obj);
    this.sceneRevision += 1;
    this.broadcast(this.envelope("object.created", rec.clientId, { object: this.serializeObject(obj) }));
  }

  private updateObject(rec: ParticipantRecord, p: Payload<"object.update">): void {
    const id = p.id.toLowerCase();
    const obj = this.objects.get(id);
    if (!obj) throw new ProtocolError("not_found", "Object does not exist (it may have been deleted)");
    if (rec.role === "host" && !obj.proposal) {
      throw new ProtocolError("forbidden", "The expert owns this object; propose a new one instead");
    }
    if (p.baseRevision !== obj.revision) {
      throw new ProtocolError("stale_revision", `Object is at revision ${obj.revision}`, this.serializeObject(obj));
    }
    const next: SceneObject = { ...obj, ...p.patch };
    validateDimensions(next.kind, next.dimensions);
    validatePosition(next.position);
    next.rotation = validateRotation(next.rotation);
    next.revision = obj.revision + 1;
    next.originEpoch = this.originEpoch;
    next.updatedAt = this.now();
    if (next.proposal && rec.role === "host") next.proposal = { ...next.proposal, novice: pose(next) };
    this.objects.set(id, next);
    this.sceneRevision += 1;
    this.broadcast(this.envelope("object.updated", rec.clientId, { object: this.serializeObject(next) }));
  }

  private acceptProposal(rec: ParticipantRecord, p: Payload<"proposal.accept">): void {
    const obj = this.requireProposal(p.id);
    const proposal = obj.proposal!;
    const next: SceneObject = { ...obj, owner: "expert", proposal: null, revision: obj.revision + 1, updatedAt: this.now() };
    this.objects.set(obj.id, next);
    this.sceneRevision += 1;
    this.broadcast(this.envelope("object.updated", rec.clientId, { object: this.serializeObject(next) }));
    if (p.note) this.pushComment(rec, next, p.note);
    this.broadcastResolution(rec, obj, poseChanged(proposal.novice, next) ? "adjusted" : "accepted", p.note ?? null, pose(next));
  }

  private rejectProposal(rec: ParticipantRecord, p: Payload<"proposal.reject">): void {
    const obj = this.requireProposal(p.id);
    if (p.note) this.pushComment(rec, obj, p.note);
    this.deleteObject(rec, { id: obj.id }, p.note ?? null);
  }

  private requireProposal(id: string): SceneObject {
    const obj = this.objects.get(id.toLowerCase());
    if (!obj) throw new ProtocolError("not_found", "Object does not exist (it may have been withdrawn)");
    if (!obj.proposal) throw new ProtocolError("invalid_state", "This object is not a pending proposal");
    return obj;
  }

  private broadcastResolution(
    rec: ParticipantRecord,
    obj: SceneObject,
    outcome: "accepted" | "adjusted" | "rejected",
    note: string | null,
    after: ObjectPose | null,
  ): void {
    this.broadcast(
      this.envelope("proposal.resolved", rec.clientId, {
        objectId: obj.id,
        objectName: obj.name,
        kind: obj.kind,
        outcome,
        byName: rec.displayName,
        note,
        before: pose(obj.proposal!.novice),
        after,
      }),
    );
  }

  private deleteObject(rec: ParticipantRecord, p: Payload<"object.delete">, rejectionNote: string | null = null): void {
    const id = p.id.toLowerCase();
    const obj = this.objects.get(id);
    if (!obj) throw new ProtocolError("not_found", "Object does not exist");
    if (rec.role === "host" && !obj.proposal) {
      throw new ProtocolError("forbidden", "The expert owns this object; ask them to remove it");
    }
    this.objects.delete(id);
    for (const c of this.comments) if (c.objectId === id) c.objectDeleted = true;
    this.reactions.delete(id);
    let selectionChanged = false;
    for (const part of this.participants.values()) {
      if (part.selectedObjectId === id) {
        part.selectedObjectId = null;
        selectionChanged = true;
      }
    }
    this.sceneRevision += 1;
    this.broadcast(this.envelope("object.deleted", rec.clientId, { id }));
    if (this.guidance?.objectId === id) {
      this.guidance = null;
      this.broadcastGuidance(rec.clientId);
    }
    if (this.lesson?.objectId === id) {
      this.lesson = null;
      this.broadcastLesson(rec.clientId);
    }
    if (selectionChanged) this.broadcastPresence();
    // The expert deleting a proposal (or rejecting it) is a rejection the novice should hear about.
    if (obj.proposal && rec.role === "expert") this.broadcastResolution(rec, obj, "rejected", rejectionNote, null);
  }

  private select(rec: ParticipantRecord, p: Payload<"selection">): void {
    const id = p.objectId?.toLowerCase() ?? null;
    if (id && !this.objects.has(id)) throw new ProtocolError("not_found", "Object does not exist");
    rec.selectedObjectId = id;
    this.broadcastPresence();
  }

  private addComment(rec: ParticipantRecord, p: Payload<"comment.add">): void {
    if (!this.commentLimiter.allow(rec.clientId, this.now())) {
      throw new ProtocolError("rate_limited", "Too many comments; wait a few seconds");
    }
    const objectId = p.objectId?.toLowerCase() ?? null;
    const obj = objectId ? this.objects.get(objectId) : undefined;
    if (objectId && !obj) throw new ProtocolError("not_found", "That object no longer exists");
    let voice: Comment["voice"] = null;
    if (p.voice) {
      if (rec.role === "viewer") throw new ProtocolError("forbidden", "Observers can listen and read, but not send voice notes");
      const clip = this.voiceClips.get(p.voice.clipId);
      if (!clip || clip.attached || clip.role !== rec.role) throw new ProtocolError("not_found", "Unknown or already used voice clip");
      clip.attached = true;
      voice = { clipId: p.voice.clipId, durationMs: p.voice.durationMs, mime: clip.mime };
    }
    this.pushComment(rec, obj ?? null, p.text, voice);
  }

  // ---------------------------------------------------------------- voice clips

  /** Stores an uploaded push-to-talk clip until a comment.add attaches it. In memory only. */
  addVoiceClip(role: Role, mime: string, data: Buffer): string {
    const now = this.now();
    for (const [id, c] of this.voiceClips) {
      if (!c.attached && now - c.createdAt > LIMITS.voiceUnattachedTtlMs) this.voiceClips.delete(id);
    }
    while (this.voiceClips.size >= LIMITS.voiceMaxClips) {
      const oldest = this.voiceClips.keys().next().value!;
      this.voiceClips.delete(oldest);
    }
    const id = randomId("v_", 12);
    this.voiceClips.set(id, { data, mime, role, createdAt: now, attached: false });
    this.lastActivity = now;
    return id;
  }

  /** Attached clips can be played by everyone in the room. */
  getVoiceClip(id: string): { data: Buffer; mime: string } | null {
    const c = this.voiceClips.get(id);
    return c && c.attached ? { data: c.data, mime: c.mime } : null;
  }

  // ---------------------------------------------------------------- lessons

  private promptLesson(rec: ParticipantRecord, p: Payload<"lesson.prompt">): void {
    const objectId = p.objectId?.toLowerCase() ?? null;
    const obj = objectId ? this.objects.get(objectId) : undefined;
    if (objectId && !obj) throw new ProtocolError("not_found", "That object no longer exists");
    let demo: Lesson["demo"] = null;
    if (p.demo) {
      for (const d of [p.demo.from, p.demo.to]) {
        validatePosition(d.position);
        validateDimensions(obj?.kind ?? "block", d.dimensions);
      }
      demo = {
        from: { ...pose(p.demo.from), rotation: validateRotation(p.demo.from.rotation) },
        to: { ...pose(p.demo.to), rotation: validateRotation(p.demo.to.rotation) },
      };
    }
    this.lesson = {
      id: randomId("l_"),
      preset: p.preset,
      text: p.text,
      objectId,
      kind: p.kind ?? obj?.kind ?? null,
      demo,
      byName: rec.displayName,
      state: "open",
      createdAt: this.now(),
      doneAt: null,
      originEpoch: this.originEpoch,
    };
    this.broadcastLesson(rec.clientId);
  }

  private requireLesson(id: string): Lesson {
    if (!this.lesson || this.lesson.id !== id) throw new ProtocolError("not_found", "No such lesson");
    return this.lesson;
  }

  private lessonDone(rec: ParticipantRecord, p: Payload<"lesson.done">): void {
    this.requireLesson(p.lessonId);
    this.completeLesson(rec.clientId);
  }

  private completeLesson(by: string): void {
    if (!this.lesson || this.lesson.state === "done") return;
    this.lesson = { ...this.lesson, state: "done", doneAt: this.now() };
    this.broadcastLesson(by);
  }

  private clearLesson(rec: ParticipantRecord, p: Payload<"lesson.clear">): void {
    this.requireLesson(p.lessonId);
    this.lesson = null;
    this.broadcastLesson(rec.clientId);
  }

  private broadcastLesson(originClientId: string): void {
    this.broadcast(this.envelope("lesson.state", originClientId, { lesson: this.lesson }));
  }

  private pushComment(rec: ParticipantRecord, obj: SceneObject | null, text: string, voice: Comment["voice"] = null): void {
    const comment: Comment = {
      id: randomId("k_"),
      objectId: obj?.id ?? null,
      objectName: obj?.name ?? null,
      authorId: rec.clientId,
      authorName: rec.displayName,
      authorRole: rec.role,
      text,
      createdAt: this.now(),
      objectDeleted: false,
      voice,
    };
    this.comments.push(comment);
    if (this.comments.length > LIMITS.maxComments) this.comments.splice(0, this.comments.length - LIMITS.maxComments);
    this.broadcast(this.envelope("comment.added", rec.clientId, { comment }));
  }

  private toggleReaction(rec: ParticipantRecord, p: Payload<"reaction.toggle">): void {
    const id = p.objectId.toLowerCase();
    if (!this.objects.has(id)) throw new ProtocolError("not_found", "Object does not exist");
    let r = this.reactions.get(id);
    if (!r) this.reactions.set(id, (r = { like: new Set(), discuss: new Set() }));
    const set = r[p.kind];
    if (set.has(rec.clientId)) set.delete(rec.clientId);
    else set.add(rec.clientId);
    this.broadcast(this.envelope("reaction.updated", rec.clientId, { objectId: id, like: [...r.like], discuss: [...r.discuss] }));
  }

  // ---------------------------------------------------------------- guidance

  private requireGuidance(id: string): Guidance {
    if (!this.guidance || this.guidance.id !== id) throw new ProtocolError("not_found", "No such guidance exercise");
    return this.guidance;
  }

  private requireLiveObject(id: string): SceneObject {
    const obj = this.objects.get(id.toLowerCase());
    if (!obj) throw new ProtocolError("not_found", "Object does not exist");
    if (obj.proposal) throw new ProtocolError("invalid_state", "Accept the novice's proposal before guiding it");
    if (obj.originEpoch !== this.originEpoch) {
      throw new ProtocolError("stale_epoch", "Object is from a previous scan origin; re-place it first");
    }
    return obj;
  }

  private checkOnAxis(start: Vec3, axis: Axis, target: Vec3): Vec3 {
    const { offset, perpendicular } = projectOntoAxis(start, axis, target);
    if (perpendicular > TARGET_ON_AXIS_TOLERANCE) {
      throw new ProtocolError(
        "target_off_axis",
        `Target is ${(perpendicular * 100).toFixed(1)} cm off the ${axis.toUpperCase()} axis through the object`,
      );
    }
    if (Math.abs(offset) > MAX_TARGET_DISTANCE) throw new ProtocolError("bad_request", "Target is too far away");
    return pointOnAxis(start, axis, offset);
  }

  private setGuidance(rec: ParticipantRecord, p: Payload<"guidance.set">): void {
    const obj = this.requireLiveObject(p.objectId);
    validatePosition(p.targetPosition);
    const target = this.checkOnAxis(obj.position, p.axis, p.targetPosition);
    this.guidance = {
      id: randomId("g_"),
      objectId: obj.id,
      state: "preview",
      axis: p.axis,
      tolerance: p.tolerance ?? DEFAULT_TOLERANCE,
      start: { position: [...obj.position], rotation: [...obj.rotation] },
      target: { position: target, rotation: [...obj.rotation] },
      attempt: null,
      originEpoch: this.originEpoch,
    };
    this.sceneRevision += 1;
    this.broadcastGuidance(rec.clientId);
  }

  private beginGuidance(rec: ParticipantRecord, p: Payload<"guidance.begin">): void {
    const g = this.requireGuidance(p.guidanceId);
    const obj = this.requireLiveObject(g.objectId);
    g.target.position = this.checkOnAxis(obj.position, g.axis, g.target.position);
    g.start = { position: [...obj.position], rotation: [...obj.rotation] };
    g.target.rotation = [...obj.rotation];
    g.state = "active";
    g.attempt = this.makeAttempt(g, 0, false, 0);
    this.sceneRevision += 1;
    this.broadcastGuidance(rec.clientId);
  }

  private makeAttempt(g: Guidance, offset: number, holding: boolean, seq: number): Attempt {
    const position = pointOnAxis(g.start.position, g.axis, offset);
    const d = distance(position, g.target.position);
    return { offset, position, distance: d, withinTolerance: d <= g.tolerance, holding, seq, updatedAt: this.now() };
  }

  private attempt(rec: ParticipantRecord, p: Payload<"guidance.attempt">): void {
    const g = this.requireGuidance(p.guidanceId);
    if (g.state !== "active") throw new ProtocolError("invalid_state", "Guidance is not active");
    if (g.attempt && p.seq <= g.attempt.seq) return; // older or repeated sample: ignore
    g.attempt = this.makeAttempt(g, p.offset, p.holding, p.seq);
    this.broadcastGuidance(rec.clientId);
  }

  private approve(rec: ParticipantRecord, p: Payload<"guidance.approve">): void {
    const g = this.requireGuidance(p.guidanceId);
    if (g.state !== "active" || !g.attempt) throw new ProtocolError("invalid_state", "There is no attempt to approve");
    const obj = this.requireLiveObject(g.objectId);
    const next: SceneObject = {
      ...obj,
      position: [...g.attempt.position],
      revision: obj.revision + 1,
      updatedAt: this.now(),
    };
    this.objects.set(obj.id, next);
    g.state = "approved";
    g.attempt.holding = false;
    this.sceneRevision += 1;
    this.broadcast(this.envelope("object.updated", rec.clientId, { object: this.serializeObject(next) }));
    this.broadcastGuidance(rec.clientId);
  }

  private resetAttempt(rec: ParticipantRecord, p: Payload<"guidance.reset">): void {
    const g = this.requireGuidance(p.guidanceId);
    if (g.state !== "active") throw new ProtocolError("invalid_state", "Only an active exercise can be reset");
    g.attempt = this.makeAttempt(g, 0, false, g.attempt?.seq ?? 0);
    this.sceneRevision += 1;
    this.broadcastGuidance(rec.clientId);
  }

  private cancelGuidance(rec: ParticipantRecord, p: Payload<"guidance.cancel">): void {
    this.requireGuidance(p.guidanceId);
    this.guidance = null;
    this.sceneRevision += 1;
    this.broadcastGuidance(rec.clientId);
  }

  // ---------------------------------------------------------------- preview + scan

  private setPreviewStatus(p: Payload<"preview.status">): void {
    this.hostPreview = { state: p.state, targetFps: p.targetFps, width: p.width };
    this.preview.setPaused(p.state === "paused");
    this.broadcastPreviewStatus();
  }

  previewStatus(): object {
    const hostConnected = [...this.participants.values()].some((x) => x.role === "host" && x.connected);
    return {
      state: hostConnected ? this.hostPreview.state : "offline",
      hostConnected,
      viewers: this.preview.viewerCount,
      targetFps: this.hostPreview.targetFps,
      width: this.hostPreview.width,
    };
  }

  broadcastPreviewStatus(): void {
    this.broadcast(this.envelope("preview.status", "server", this.previewStatus()));
  }

  commitScan(meta: ScanMeta, data: Buffer): void {
    this.scan = { meta, data };
    this.staging = null;
    this.sceneRevision += 1;
    this.lastActivity = this.now();
    this.broadcast(this.envelope("scan.ready", "server", { scan: meta }));
    if (this.lesson?.state === "open" && this.lesson.preset === "scan") this.completeLesson("server");
  }

  // ---------------------------------------------------------------- output

  private serializeObject(o: SceneObject): object {
    return { ...o, stale: o.originEpoch !== this.originEpoch };
  }

  private publicParticipants(): Participant[] {
    return [...this.participants.values()].map(
      ({ clientId, role, displayName, clientKind, connected, selectedObjectId, joinedAt, disconnectedAt }) => ({
        clientId,
        role,
        displayName,
        clientKind,
        connected,
        selectedObjectId,
        joinedAt,
        disconnectedAt,
      }),
    );
  }

  snapshotPayload(): object {
    const reactions: Record<string, { like: string[]; discuss: string[] }> = {};
    for (const [id, r] of this.reactions) reactions[id] = { like: [...r.like], discuss: [...r.discuss] };
    return {
      room: {
        id: this.id,
        code: this.code,
        hostName: this.hostName,
        originEpoch: this.originEpoch,
        sceneRevision: this.sceneRevision,
        createdAt: this.createdAt,
        expiresAt: this.expiresAt,
      },
      participants: this.publicParticipants(),
      objects: [...this.objects.values()].map((o) => this.serializeObject(o)),
      guidance: this.guidance,
      lesson: this.lesson,
      comments: this.comments.slice(-LIMITS.snapshotComments),
      reactions,
      scan: this.scan?.meta ?? null,
      preview: this.previewStatus(),
    };
  }

  private broadcastPresence(): void {
    this.broadcast(this.envelope("presence", "server", { participants: this.publicParticipants() }));
  }

  private broadcastGuidance(originClientId: string): void {
    this.broadcast(this.envelope("guidance.state", originClientId, { guidance: this.guidance }));
  }

  private broadcast(msg: object): void {
    for (const p of this.participants.values()) p.sink?.send(msg);
  }

  envelope(type: string, clientId: string, payload: object, extra: Record<string, unknown> = {}): object {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type,
      roomId: this.id,
      clientId,
      messageId: randomId("s_", 6),
      sceneRevision: this.sceneRevision,
      originEpoch: this.originEpoch,
      ...extra,
      payload,
    };
  }

  // Test/diagnostic helpers
  objectCount(): number {
    return this.objects.size;
  }
  commentCount(): number {
    return this.comments.length;
  }
  getObject(id: string): SceneObject | undefined {
    return this.objects.get(id);
  }
  getGuidance(): Guidance | null {
    return this.guidance;
  }
}
