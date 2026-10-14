# Architecture

```
            same Wi-Fi / LAN
 ┌───────────────┐   HTTP  /api/rooms, /api/rooms/:id/scan/*      ┌──────────────────────┐
 │ iPhone (host) │ ─────────────────────────────────────────────▶ │                      │
 │ SwiftUI       │   WS /ws/control  (JSON, protocol v1)          │  Room server (Node)  │
 │ ARKit         │ ◀────────────────────────────────────────────▶ │  - rooms + roles     │
 │ RealityKit    │   WS /ws/preview  (binary JPEG frames)         │  - scene authority   │
 └───────────────┘ ─────────────────────────────────────────────▶ │  - preview relay     │
                                                                  │  - scan staging      │
 ┌───────────────┐   WS /ws/control, GET scan                     │  - serves web/dist   │
 │ Blender       │ ◀────────────────────────────────────────────▶ │                      │
 │ (expert)      │                                                └──────────────────────┘
 └───────────────┘                                                     ▲            │
                                                                       │ WS control │ WS preview
 ┌───────────────┐                                                     │            ▼
 │ Browser       │ ◀───────────────────────────────────────────────────┘   latest frame only
 │ (family)      │
 └───────────────┘
```

## Responsibilities

| Component | Owns |
| --- | --- |
| iPhone | The **coordinate frame** (ARKit world origin), the LiDAR scan, the preview camera, and the physical attempt offset during guidance. Renders everything locally against its own tracking, so network delay never makes AR content swim. |
| Server | The **shared scene**: object list with per-object revisions, guidance state, comments, reactions, participants, scan metadata and bytes. Validates every message, enforces roles, and relays preview frames. Keeps everything in memory. |
| Blender | **Authoring**: creating and editing objects, setting guidance targets, approving. Treats the scan as a locked reference. |
| Browser | **Watching and discussing**: preview, plan view, captions, comments, reactions. Cannot edit. |

## Key decisions

**One canonical space.** All positions on the wire are in the phone's ARKit world frame (Y up, right-handed, metres). Only Blender converts, at its edge, with a single matrix (`(x, y, z)` → `(x, −z, y)`). The same conversion is checked against `protocol/fixtures/coordinates.json` in TypeScript, Python and Swift tests.

**Origin epochs.** Resetting AR tracking on the phone invalidates every coordinate. The phone sends `origin.reset`; the server increments `originEpoch`, discards the scan and guidance, marks objects `stale`, and sends everyone a fresh snapshot. Geometry messages carry the epoch they were computed in, and the server rejects ones from an old epoch (`stale_epoch`). A stale object becomes live again when the expert repositions it.

**Server-authoritative revisions.** Each object has a revision; edits name the `baseRevision` they were based on. Conflicting edits are rejected with the current object so the client can rebase. Every message has a `clientId:messageId` used for de-duplication (bounded memory). After any reconnect the server sends a full `scene.snapshot` before anything else, so clients never need to replay queues.

**Roles from tokens.** Each room has three random tokens (host, expert, viewer). The role comes from which token you present, not from anything the client claims. Capacity is 1 host (a new host connection replaces the old), 2 experts, 8 viewers. A participant that drops can resume within 60 s with the same role.

**Preview as a separate socket.** The control socket carries small JSON messages that must never wait behind video. The preview socket carries binary frames: a 24-byte header (`RBPF`, flags for *synthetic* and *tracking limited*, sequence number, size, capture time) and a JPEG. The phone has at most one frame in flight and skips captures rather than queueing. The server keeps only the latest frame, sends at most one frame at a time per viewer, drops frames for viewers whose socket buffer is over 256 KiB, and caps the relay at 15 fps. A slow viewer therefore cannot delay other viewers or the control channel (covered by tests). It is a *low-frame-rate live preview*, not video calling: there is no WebRTC, no audio, and no recording.

**Composited snapshots.** The phone captures `ARView.snapshot` (camera image plus virtual objects), downscales it off the main thread and encodes JPEG at quality 0.5. It starts around 5 fps at 640 px and adapts to the measured capture-to-send time, the number of viewers, and the thermal state.

**Scan upload over HTTP.** The simplified mesh (canonical world-space float32 vertices plus uint32 triangle indices, the `RBSC` format) is uploaded in chunks of 256 KiB or less (at most 64 chunks, 8 MiB) and committed atomically: the server validates the whole buffer (header, counts, finite coordinates, index range, epoch) before anyone can see it, then broadcasts `scan.ready`. Only host and expert tokens may download it.

**Blender threading.** `bpy` is not thread-safe. The add-on's WebSocket client runs on a daemon thread and talks to Blender only through two queues. A `bpy.app.timers` callback (every 50 ms) applies incoming messages on the main thread. The depsgraph handler only sets a dirty flag. Outgoing edits are coalesced per object (one in flight, streaming at about 7 Hz while dragging and settling 0.1 s after you stop), and echoes of our own edits are suppressed by sender id.

**Guidance.** The expert proposes a target on one axis (`guidance.set`, state `preview`) and starts the exercise (`guidance.begin`, `active`). The phone captures the camera position when the user presses **Hold to move** and projects later camera motion onto the axis, so only translation along the line moves the attempt. The phone shows its local attempt immediately and sends `guidance.attempt` (offset, sequence number, holding flag) at most 15 times per second; the server computes the attempt position, distance and `withinTolerance` and broadcasts them. A hysteresis gate fires a single haptic pulse when the attempt enters tolerance. **Approve** copies the attempt position into the object; **Reset** returns the attempt to the start.

## Source map

- Server: `server/src/room.ts` (room state machine), `ws.ts` (sockets, auth, rate limits), `preview.ts` (latest-frame relay), `scan.ts` (upload staging and validation), `http.ts` (REST and static files), `protocol.ts` (zod schemas and permissions).
- Web: `web/src/client.ts` (sockets, reconnect, frame decoding), `state.ts` (pure reducer), `captions.ts`, `components/`.
- Blender: `session.py` (network thread), `ws_client.py`, `tracker.py` (coalescing and echo suppression), `sync.py` (main-thread scene application), `ui.py`, `primitives.py`.
- iOS: `App/AppModel.swift` (session state and flows), `Net/` (HTTP, control and preview sockets), `AR/` (session, renderer, broadcaster, mesh capture), `Views/`. Pure logic lives in `RoomBridgeCore`.
