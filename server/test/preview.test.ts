import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { encodeFrame, parseFrameHeader } from "../src/frame.js";
import { PreviewHub, type FrameSocket } from "../src/preview.js";
import { boot, createRoom, sleep, TestClient } from "./helpers.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const frame = (seq: number, flags = 0) =>
  encodeFrame({ orientation: 0, flags, seq, width: 640, height: 480, captureTimeMs: 0 }, JPEG);

class FakeSocket implements FrameSocket {
  bufferedAmount = 0;
  sent: Buffer[] = [];
  pending: ((err?: Error) => void)[] = [];
  autoComplete = true;
  closed = false;
  send(data: Buffer, cb: (err?: Error) => void) {
    this.sent.push(data);
    if (this.autoComplete) cb();
    else this.pending.push(cb);
  }
  sendText() {}
  close() {
    this.closed = true;
  }
  drain() {
    const cbs = this.pending.splice(0);
    cbs.forEach((cb) => cb());
  }
}

describe("frame header", () => {
  it("round-trips and rejects non-JPEG payloads", () => {
    const h = parseFrameHeader(frame(7, 1))!;
    expect(h).toMatchObject({ seq: 7, width: 640, height: 480, flags: 1, version: 1 });
    const bad = frame(1);
    bad[24] = 0;
    expect(parseFrameHeader(bad)).toBeNull();
  });
});

describe("PreviewHub backpressure", () => {
  let t = 0;
  const now = () => t;
  let hub: PreviewHub;
  let host: FakeSocket;
  beforeEach(() => {
    t = 1000;
    hub = new PreviewHub(now);
    host = new FakeSocket();
    hub.setHost(host, "c_host");
    hub.setPaused(false);
  });

  it("a slow viewer never queues more than one frame and receives the newest after draining", () => {
    const fast = new FakeSocket();
    const slow = new FakeSocket();
    slow.autoComplete = false;
    hub.addViewer(fast, "c_fast");
    hub.addViewer(slow, "c_slow");
    for (let seq = 1; seq <= 10; seq++) {
      t += 100;
      expect(hub.acceptFrame(host, frame(seq))).toBe("accepted");
    }
    expect(fast.sent).toHaveLength(10);
    expect(slow.sent).toHaveLength(1); // only the first frame is in flight
    slow.drain();
    expect(slow.sent).toHaveLength(2);
    expect(parseFrameHeader(slow.sent[1]!)!.seq).toBe(10); // skipped straight to the newest
    expect(hub.stats().dropped).toBeGreaterThanOrEqual(9);
  });

  it("drops frames for a viewer whose socket buffer is full", () => {
    const v = new FakeSocket();
    v.bufferedAmount = 10 * 1024 * 1024;
    hub.addViewer(v, "c_v");
    t += 100;
    hub.acceptFrame(host, frame(1));
    expect(v.sent).toHaveLength(0);
  });

  it("refuses frames while paused, clears the latest frame, and enforces order and rate", () => {
    t += 100;
    expect(hub.acceptFrame(host, frame(1))).toBe("accepted");
    hub.setPaused(true);
    t += 100;
    expect(hub.acceptFrame(host, frame(2))).toBe("paused");
    const late = new FakeSocket();
    hub.addViewer(late, "c_late");
    expect(late.sent).toHaveLength(0); // nothing stale from before the pause
    hub.setPaused(false);
    t += 100;
    expect(hub.acceptFrame(host, frame(1))).toBe("out_of_order");
    expect(hub.acceptFrame(host, frame(3))).toBe("accepted");
    t += 10;
    expect(hub.acceptFrame(host, frame(4))).toBe("rate_limited");
  });

  it("late joiners get the latest frame only if it is fresh", () => {
    t += 100;
    hub.acceptFrame(host, frame(1));
    const a = new FakeSocket();
    hub.addViewer(a, "c_a");
    expect(a.sent).toHaveLength(1);
    t += 10_000;
    const b = new FakeSocket();
    hub.addViewer(b, "c_b");
    expect(b.sent).toHaveLength(0);
  });

  it("only the registered host can publish", () => {
    const impostor = new FakeSocket();
    t += 100;
    expect(hub.acceptFrame(impostor, frame(1))).toBe("malformed");
  });
});

describe("preview over real sockets", () => {
  let srv: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => (srv = await boot()));
  afterEach(async () => srv.close());

  async function previewSocket(ticket: string): Promise<{ ws: WebSocket; frames: Buffer[]; texts: any[] }> {
    const ws = new WebSocket(`${srv.ws}/ws/preview`);
    const frames: Buffer[] = [];
    const texts: any[] = [];
    ws.on("message", (d, isBinary) => (isBinary ? frames.push(d as Buffer) : texts.push(JSON.parse(String(d)))));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "preview.auth", ticket }));
    await new Promise<void>((r) => {
      const iv = setInterval(() => {
        if (texts.length) {
          clearInterval(iv);
          r();
        }
      }, 5);
    });
    return { ws, frames, texts };
  }

  it("relays host frames to three viewers, and stops after pause", async () => {
    const room = await createRoom(srv.base);
    const host = await TestClient.join(srv.ws, room.code, room.hostToken, "Host");
    const viewers = await Promise.all(["A", "B", "C"].map((n) => TestClient.join(srv.ws, room.code, room.viewerToken, n)));
    await host.request("preview.status", { state: "live", targetFps: 5, width: 640 });
    const hp = await previewSocket(host.previewTicket);
    expect(hp.texts[0]).toMatchObject({ type: "preview.ready", role: "host" });
    const vps = await Promise.all(viewers.map((v) => previewSocket(v.previewTicket)));
    for (let seq = 1; seq <= 3; seq++) {
      hp.ws.send(frame(seq));
      await sleep(80);
    }
    await sleep(100);
    for (const vp of vps) {
      expect(vp.frames.length).toBe(3);
      expect(parseFrameHeader(vp.frames.at(-1)!)!.seq).toBe(3);
    }
    await host.request("preview.status", { state: "paused", targetFps: 0, width: 640 });
    hp.ws.send(frame(4));
    await sleep(150);
    for (const vp of vps) expect(vp.frames.length).toBe(3);
    // A viewer token cannot publish frames.
    vps[0]!.ws.send(frame(99));
    await sleep(50);
    expect(vps[1]!.frames.length).toBe(3);
    for (const s of [hp, ...vps]) s.ws.close();
    await Promise.all([host, ...viewers].map((c) => c.close()));
  });

  it("rejects an invalid preview ticket", async () => {
    const ws = new WebSocket(`${srv.ws}/ws/preview`);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "preview.auth", ticket: "t_forged" }));
    const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
    expect(code).toBe(4001);
  });

  it("a slow preview viewer does not delay control messages", async () => {
    const room = await createRoom(srv.base);
    const host = await TestClient.join(srv.ws, room.code, room.hostToken, "Host");
    const viewer = await TestClient.join(srv.ws, room.code, room.viewerToken, "Slow");
    await host.request("preview.status", { state: "live", targetFps: 15, width: 640 });
    const hp = await previewSocket(host.previewTicket);
    const vp = await previewSocket(viewer.previewTicket);
    // Stop reading on the viewer's preview socket so its TCP window fills up.
    (vp.ws as any)._socket.pause();
    const big = encodeFrame(
      { orientation: 0, flags: 0, seq: 0, width: 640, height: 480, captureTimeMs: 0 },
      Buffer.concat([JPEG, Buffer.alloc(400 * 1024)]),
    );
    for (let seq = 1; seq <= 20; seq++) {
      big.writeUInt32LE(seq, 8);
      hp.ws.send(Buffer.from(big));
      await sleep(70);
    }
    const started = Date.now();
    const r = await viewer.request("comment.add", { objectId: null, text: "still responsive" });
    expect(r.type).toBe("ack");
    expect(Date.now() - started).toBeLessThan(500);
    const stats = srv.rooms.get(room.code)!.preview.stats();
    expect(stats.dropped).toBeGreaterThan(0);
    hp.ws.close();
    vp.ws.terminate();
    await host.close();
    await viewer.close();
  }, 10_000);
});
