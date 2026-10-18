import { parseFrame, type FrameHeader } from "./frame";
import { envelope, PROTOCOL_VERSION, type ServerMessage } from "./protocol";
import { initialState, reduce, type RoomState } from "./state";

export interface FrameInfo extends FrameHeader {
  receivedAt: number;
  bytes: number;
}

export interface PreviewStats {
  received: number;
  decoded: number;
  skipped: number;
  decodeErrors: number;
  lastDecodeMs: number;
}

export interface ClientOptions {
  code: string;
  token: string;
  displayName: string;
  /** e.g. "ws://10.0.0.61:8787"; defaults to the page origin. */
  wsBase?: string;
}

type Listener = () => void;

/**
 * Control + preview sockets for one browser participant. Reconnects with exponential
 * backoff (0.5 s to 8 s) and resumes the same participant within the server's grace
 * window. The server always sends a full snapshot after (re)auth, so no local queue of
 * scene state is kept.
 */
export class RoomClient {
  state: RoomState = initialState;
  frame: FrameInfo | null = null;
  previewSocket: "idle" | "connecting" | "ready" | "closed" = "idle";
  stats: PreviewStats = { received: 0, decoded: 0, skipped: 0, decodeErrors: 0, lastDecodeMs: 0 };
  canvas: HTMLCanvasElement | null = null;

  private opts: ClientOptions;
  private ws: WebSocket | null = null;
  private pws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stopped = false;
  private backoff = 500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private previewRetry: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private resumeClientId: string | null = null;
  private decoding = false;
  private pending: { header: FrameHeader; jpeg: Uint8Array; bytes: number } | null = null;
  private lastSeq = -1;
  private ticket: string | null = null;

  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  private get wsBase(): string {
    if (this.opts.wsBase) return this.opts.wsBase;
    const { protocol, host } = window.location;
    return `${protocol === "https:" ? "wss" : "ws"}://${host}`;
  }

  private get httpBase(): string {
    return this.wsBase.replace(/^ws/, "http");
  }

  /** Downloads a voice note (the token goes in a header, never in the URL). */
  async fetchVoice(clipId: string): Promise<Blob> {
    const roomId = this.state.room?.id;
    if (!roomId) throw new Error("Not in a room");
    const res = await fetch(`${this.httpBase}/api/rooms/${roomId}/voice/${encodeURIComponent(clipId)}`, {
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    if (!res.ok) throw new Error(res.status === 404 ? "This voice note has expired" : `HTTP ${res.status}`);
    return res.blob();
  }

  /** Uploads a push-to-talk clip (expert only) and returns the id to attach to comment.add. */
  async uploadVoice(audio: Blob): Promise<string> {
    const roomId = this.state.room?.id;
    if (!roomId) throw new Error("Not in a room");
    const res = await fetch(`${this.httpBase}/api/rooms/${roomId}/voice`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": audio.type.split(";")[0] || "audio/webm" },
      body: audio,
    });
    const body = (await res.json().catch(() => ({}))) as { clipId?: string; error?: { message?: string } };
    if (!res.ok || !body.clipId) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    return body.clipId;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.previewRetry) clearTimeout(this.previewRetry);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.send("room.leave", {});
    this.ws?.close(1000, "leave");
    this.pws?.close(1000, "leave");
    this.ws = null;
    this.pws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`${this.wsBase}/ws/control`);
    this.ws = ws;
    if (this.state.connection !== "connecting") this.state = { ...this.state, connection: "reconnecting" };
    this.emit();
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          type: "auth",
          roomId: "",
          clientId: "",
          messageId: `w-auth-${Date.now()}`,
          payload: {
            roomCode: this.opts.code,
            token: this.opts.token,
            displayName: this.opts.displayName,
            clientKind: "web",
            ...(this.resumeClientId ? { resumeClientId: this.resumeClientId } : {}),
          },
        }),
      );
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws || typeof ev.data !== "string") return;
      let m: ServerMessage;
      try {
        m = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (m.protocolVersion !== PROTOCOL_VERSION) {
        this.state = { ...this.state, connection: "failed", error: "This viewer is out of date (protocol mismatch). Reload the page." };
        this.stopped = true;
        ws.close();
        this.emit();
        return;
      }
      this.state = reduce(this.state, m);
      if (m.type === "auth.ok") {
        this.backoff = 500;
        this.resumeClientId = m.payload.clientId;
        this.ticket = m.payload.previewTicket;
        this.openPreview();
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send("ping", {}), 10_000);
      }
      if (m.type === "auth.error" || m.type === "room.ended") {
        this.stopped = true;
        this.closePreview();
      }
      if (m.type === "room.ended") this.frame = null;
      this.emit();
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.closePreview();
      if (this.stopped) {
        this.emit();
        return;
      }
      this.state = { ...this.state, connection: "reconnecting" };
      this.emit();
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 8000);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  send(type: string, payload: unknown): boolean {
    const ws = this.ws;
    const { room, clientId, connection } = this.state;
    if (!ws || ws.readyState !== WebSocket.OPEN || !room || !clientId || connection !== "connected") return false;
    ws.send(envelope(type, payload, room.id, clientId));
    return true;
  }

  // Preview -----------------------------------------------------------------

  private closePreview(): void {
    if (this.previewRetry) clearTimeout(this.previewRetry);
    const p = this.pws;
    this.pws = null;
    p?.close();
    this.previewSocket = "closed";
  }

  private openPreview(): void {
    this.closePreview();
    const ticket = this.ticket;
    if (!ticket) return;
    const pws = new WebSocket(`${this.wsBase}/ws/preview`);
    pws.binaryType = "arraybuffer";
    this.pws = pws;
    this.lastSeq = -1;
    this.previewSocket = "connecting";
    pws.onopen = () => pws.send(JSON.stringify({ type: "preview.auth", ticket }));
    pws.onmessage = (ev) => {
      if (pws !== this.pws) return;
      if (typeof ev.data === "string") {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "preview.ready") {
            this.previewSocket = "ready";
            this.emit();
          }
        } catch {
          /* ignore */
        }
        return;
      }
      this.onFrame(ev.data as ArrayBuffer);
    };
    pws.onclose = () => {
      if (pws !== this.pws) return;
      this.previewSocket = "closed";
      this.emit();
      // The control socket is still up: retry the preview with the same ticket.
      if (!this.stopped && this.state.connection === "connected") {
        this.previewRetry = setTimeout(() => this.state.connection === "connected" && this.openPreview(), 2000);
      }
    };
  }

  private onFrame(buf: ArrayBuffer): void {
    const parsed = parseFrame(buf);
    this.stats.received += 1;
    // A big backwards jump means the phone restarted broadcasting; anything else is out of order.
    const restarted = parsed !== null && this.lastSeq - parsed.header.seq > 100;
    if (!parsed || (parsed.header.seq <= this.lastSeq && !restarted)) {
      this.stats.skipped += 1;
      return;
    }
    this.lastSeq = parsed.header.seq;
    if (this.pending) this.stats.skipped += 1;
    // Keep only the newest frame while a decode is running.
    this.pending = { ...parsed, bytes: buf.byteLength };
    if (!this.decoding) void this.drain();
  }

  private async drain(): Promise<void> {
    this.decoding = true;
    while (this.pending) {
      const { header, jpeg, bytes } = this.pending;
      this.pending = null;
      const t0 = performance.now();
      try {
        const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
        try {
          const c = this.canvas;
          if (c) {
            if (c.width !== bitmap.width || c.height !== bitmap.height) {
              c.width = bitmap.width;
              c.height = bitmap.height;
            }
            c.getContext("2d")?.drawImage(bitmap, 0, 0);
          }
        } finally {
          bitmap.close();
        }
        this.stats.decoded += 1;
        this.stats.lastDecodeMs = performance.now() - t0;
        this.frame = { ...header, receivedAt: Date.now(), bytes };
        this.emit();
      } catch {
        this.stats.decodeErrors += 1;
      }
    }
    this.decoding = false;
  }
}
