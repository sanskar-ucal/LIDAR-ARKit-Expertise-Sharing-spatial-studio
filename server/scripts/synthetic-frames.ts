/**
 * Synthetic preview host for testing the web viewer without an iPhone.
 *
 * Creates its own room, joins as the host, and streams the pre-rendered frames in
 * ./synthetic-frames. Every frame carries the synthetic flag in its header and the
 * images themselves say "SYNTHETIC TEST FRAME", so this can never be mistaken for a
 * camera or LiDAR result. With --objects it also joins as an expert and adds a few
 * objects; with --propose the host proposes a table and a chair for the expert to review.
 *
 *   npm run synthetic-frames -w server -- --server http://127.0.0.1:8787 --fps 5 --objects --propose
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { encodeFrame } from "../src/frame.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const server = opt("server", "http://127.0.0.1:8787").replace(/\/+$/, "");
const fps = Math.min(15, Math.max(1, Number(opt("fps", "5"))));
const wsBase = server.replace(/^http/, "ws");
const frameDir = join(dirname(fileURLToPath(import.meta.url)), "synthetic-frames");
const frames = readdirSync(frameDir)
  .filter((f) => f.endsWith(".jpg"))
  .sort()
  .map((f) => readFileSync(join(frameDir, f)));
if (frames.length === 0) {
  console.error(`No frames in ${frameDir}. Run: swift scripts/gen-synthetic-frames.swift server/scripts/synthetic-frames`);
  process.exit(1);
}

interface Created {
  roomId: string;
  code: string;
  hostToken: string;
  expertToken: string;
  viewerLink: string;
  expertLink: string;
}

type Msg = { type: string; payload: any; originEpoch?: number };

function control(token: string, code: string, name: string): Promise<{ ws: WebSocket; auth: any; epoch: () => number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws/control`);
    let epoch = 1;
    let auth: any = null;
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          protocolVersion: 1,
          type: "auth",
          roomId: "",
          clientId: "",
          messageId: randomUUID(),
          payload: { roomCode: code, token, displayName: name, clientKind: "test" },
        }),
      ),
    );
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Msg;
      if (typeof m.originEpoch === "number") epoch = m.originEpoch;
      if (m.type === "auth.ok") auth = m.payload;
      if (m.type === "auth.error") reject(new Error(m.payload.message));
      if (m.type === "scene.snapshot" && auth) resolve({ ws, auth, epoch: () => epoch });
      if (m.type === "error") console.warn(`[${name}] server error: ${m.payload.code} ${m.payload.message}`);
      if (m.type === "room.ended") {
        console.log("Room ended.");
        process.exit(0);
      }
    });
    ws.on("error", reject);
  });
}

function send(ws: WebSocket, auth: any, type: string, payload: unknown, originEpoch?: number) {
  ws.send(
    JSON.stringify({
      protocolVersion: 1,
      type,
      roomId: auth.roomId,
      clientId: auth.clientId,
      messageId: randomUUID(),
      ...(originEpoch ? { originEpoch } : {}),
      payload,
    }),
  );
}

async function main() {
  const res = await fetch(`${server}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostName: "Synthetic test host" }),
  }).catch((e: Error) => {
    console.error(`Cannot reach ${server}: ${e.message}. Is the server running?`);
    process.exit(1);
  });
  if (res.status !== 201) {
    console.error(`Room creation failed: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const room = (await res.json()) as Created;
  console.log(`Room ${room.code} (SYNTHETIC preview, not a camera)`);
  console.log(`  Viewer link:  ${room.viewerLink}`);
  console.log(`  Expert invite (can edit; paste into Blender): ${room.expertLink}`);

  const host = await control(room.hostToken, room.code, "Synthetic test host");

  if (flag("objects")) {
    const expert = await control(room.expertToken, room.code, "Synthetic expert");
    const objects = [
      { kind: "pillar", name: "Pillar", position: [0.6, 0, -1.8], dimensions: [0.3, 2.4, 0.3], color: "#2a8c94" },
      { kind: "partition", name: "Partition", position: [-0.5, 0, -2], dimensions: [1.2, 1.8, 0.08], color: "#c9b79c" },
      { kind: "panel", name: "Picture panel", position: [0, 1.4, -2.9], dimensions: [0.8, 0.6, 0.03], color: "#ffffff", textureRef: "sample:picture" },
    ];
    for (const o of objects) {
      const object = { id: randomUUID(), rotation: [0, 0, 0, 1], textureRef: null, ...o };
      send(expert.ws, expert.auth, "object.create", { object }, expert.epoch());
    }
    console.log(`  Added ${objects.length} sample objects as "Synthetic expert".`);
  }

  if (flag("propose")) {
    // The scripted host proposes furniture, as a novice would from the phone's object library.
    const proposals = [
      { kind: "table", name: "Table 1", position: [0.8, 0, -1.2], dimensions: [1.2, 0.75, 0.8], color: "#a0764f" },
      { kind: "chair", name: "Chair 1", position: [0.8, 0, -0.5], rotation: [0, 1, 0, 0], dimensions: [0.45, 0.9, 0.5], color: "#7a8b99" },
    ];
    for (const o of proposals) {
      const object = { id: randomUUID(), rotation: [0, 0, 0, 1], textureRef: null, ...o };
      send(host.ws, host.auth, "object.propose", { object }, host.epoch());
    }
    console.log(`  Proposed ${proposals.length} objects as the host; review them in Blender under Novice Proposals.`);
  }

  const preview = new WebSocket(`${wsBase}/ws/preview`);
  await new Promise<void>((resolve, reject) => {
    preview.on("open", () => preview.send(JSON.stringify({ type: "preview.auth", ticket: host.auth.previewTicket })));
    preview.on("message", (d, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(String(d));
      if (m.type === "preview.ready") resolve();
      if (m.type === "preview.error") reject(new Error(`preview auth failed: ${m.code}`));
      if (m.type === "preview.stats") {
        process.stdout.write(`\r  viewers ${m.viewers}  accepted ${m.accepted}  dropped for slow viewers ${m.dropped}   `);
      }
    });
    preview.on("error", reject);
  });
  send(host.ws, host.auth, "preview.status", { state: "live", targetFps: fps, width: 480 });
  console.log(`  Streaming ${frames.length} looping synthetic frames at ${fps} fps. Ctrl-C ends the room.`);

  let seq = 0;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || preview.readyState !== WebSocket.OPEN) return;
    const jpeg = frames[seq % frames.length]!;
    seq += 1;
    const frame = encodeFrame({ orientation: 0, flags: 1, seq, width: 480, height: 360, captureTimeMs: Date.now() }, jpeg);
    inFlight = true;
    preview.send(frame, { binary: true }, () => (inFlight = false));
  }, 1000 / fps);

  const stop = () => {
    clearInterval(timer);
    send(host.ws, host.auth, "room.end", {});
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
