import { LIMITS } from "./config.js";
import { parseFrameHeader } from "./frame.js";

/** The subset of a `ws` WebSocket the hub needs; lets tests drive backpressure deterministically. */
export interface FrameSocket {
  readonly bufferedAmount: number;
  send(data: Buffer, cb: (err?: Error) => void): void;
  sendText(text: string): void;
  close(code: number, reason: string): void;
}

interface ViewerState {
  clientId: string;
  busy: boolean;
  lastSentSeq: number;
  dropped: number;
}

interface LatestFrame {
  seq: number;
  data: Buffer;
  receivedAt: number;
}

export type FrameVerdict = "accepted" | "paused" | "malformed" | "rate_limited" | "out_of_order" | "too_large";

/**
 * Latest-frame relay. Each viewer has at most one frame in flight; frames that
 * arrive while a viewer is busy are dropped for that viewer and it receives the
 * newest frame once it drains. Nothing is ever queued per viewer.
 */
export class PreviewHub {
  private host: { sock: FrameSocket; clientId: string } | null = null;
  private viewers = new Map<FrameSocket, ViewerState>();
  private latest: LatestFrame | null = null;
  private paused = true;
  private lastSeq = -1;
  private lastAcceptedAt = -Infinity;
  totalAccepted = 0;
  totalDroppedForViewers = 0;
  totalRejected = 0;

  constructor(private now: () => number = Date.now) {}

  get viewerCount(): number {
    return this.viewers.size;
  }

  get hostConnected(): boolean {
    return this.host !== null;
  }

  setHost(sock: FrameSocket, clientId: string): void {
    if (this.host && this.host.sock !== sock) this.host.sock.close(4002, "replaced");
    this.host = { sock, clientId };
    this.lastSeq = -1;
  }

  removeSocket(sock: FrameSocket): void {
    if (this.host?.sock === sock) {
      this.host = null;
      this.latest = null;
    }
    this.viewers.delete(sock);
  }

  /** Disconnect every preview socket belonging to `clientId` (used when a participant leaves). */
  removeClient(clientId: string): void {
    if (this.host?.clientId === clientId) {
      this.host.sock.close(4000, "left");
      this.host = null;
      this.latest = null;
    }
    for (const [sock, v] of this.viewers) {
      if (v.clientId === clientId) {
        sock.close(4000, "left");
        this.viewers.delete(sock);
      }
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.latest = null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  addViewer(sock: FrameSocket, clientId: string): void {
    const state: ViewerState = { clientId, busy: false, lastSentSeq: -1, dropped: 0 };
    this.viewers.set(sock, state);
    const latest = this.latest;
    if (latest && this.now() - latest.receivedAt <= LIMITS.previewLateJoinMaxAgeMs) this.trySend(sock, state);
  }

  acceptFrame(sender: FrameSocket, data: Buffer): FrameVerdict {
    if (!this.host || this.host.sock !== sender) return this.reject("malformed");
    if (data.length > LIMITS.previewMaxBytes) return this.reject("too_large");
    if (this.paused) return this.reject("paused");
    const header = parseFrameHeader(data);
    if (!header) return this.reject("malformed");
    if (header.seq <= this.lastSeq) return this.reject("out_of_order");
    const now = this.now();
    // Allow small jitter below the nominal minimum interval.
    if (now - this.lastAcceptedAt < (1000 / LIMITS.previewMaxFps) * 0.9) return this.reject("rate_limited");
    this.lastSeq = header.seq;
    this.lastAcceptedAt = now;
    this.latest = { seq: header.seq, data, receivedAt: now };
    this.totalAccepted += 1;
    for (const [sock, state] of this.viewers) this.trySend(sock, state);
    return "accepted";
  }

  private reject(v: FrameVerdict): FrameVerdict {
    this.totalRejected += 1;
    return v;
  }

  private trySend(sock: FrameSocket, state: ViewerState): void {
    const frame = this.latest;
    if (!frame || frame.seq <= state.lastSentSeq) return;
    if (state.busy || sock.bufferedAmount > LIMITS.previewViewerBufferBytes) {
      state.dropped += 1;
      this.totalDroppedForViewers += 1;
      return;
    }
    state.busy = true;
    state.lastSentSeq = frame.seq;
    sock.send(frame.data, (err) => {
      state.busy = false;
      if (err) {
        this.viewers.delete(sock);
        return;
      }
      // If newer frames arrived while this one was in flight, send the newest now.
      if (this.viewers.has(sock)) this.trySend(sock, state);
    });
  }

  stats(): { viewers: number; dropped: number; accepted: number } {
    return { viewers: this.viewers.size, dropped: this.totalDroppedForViewers, accepted: this.totalAccepted };
  }

  sendStatsToHost(): void {
    if (!this.host) return;
    this.host.sock.sendText(JSON.stringify({ type: "preview.stats", ...this.stats() }));
  }

  closeAll(reason: string): void {
    this.host?.sock.close(4000, reason);
    for (const sock of this.viewers.keys()) sock.close(4000, reason);
    this.host = null;
    this.viewers.clear();
    this.latest = null;
  }
}
