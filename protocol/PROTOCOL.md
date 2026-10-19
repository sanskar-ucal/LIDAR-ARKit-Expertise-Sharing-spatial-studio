# RoomBridge protocol v1

`protocolVersion = 1`. Coordinates follow [COORDINATES.md](COORDINATES.md).
Shared fixtures: [`fixtures/messages.json`](fixtures/messages.json),
[`fixtures/coordinates.json`](fixtures/coordinates.json). The JSON Schema in
[`schema/roombridge.schema.json`](schema/roombridge.schema.json) documents the
envelope and object shapes. The authoritative validators are
`server/src/protocol.ts` (zod), `blender_addon/roombridge/protocol.py` and
`ios/RoomBridgeCore/Sources/RoomBridgeCore/Protocol.swift`.

## Transports

| Channel | Purpose | Limits |
| --- | --- | --- |
| `POST /api/rooms` | create a room | 10 per IP per 10 min |
| `WS /ws/control` | JSON text messages: auth, scene, comments, guidance, presence | 64 KiB per message, 40 msg/s sustained (burst 80) per connection |
| `WS /ws/preview` | binary JPEG preview frames (host -> server -> viewers) | 512 KiB per frame, max 15 frames/s accepted from host |
| `POST/PUT/GET /api/rooms/:roomId/scan...` | chunked room-scan upload/download | 256 KiB per chunk, 64 chunks, 8 MiB total |

Control and preview traffic use **separate sockets**. A slow viewer only ever has
at most one preview frame in flight; newer frames replace older ones and stale
frames are dropped, so the control socket is never stuck behind video.

## Rooms and credentials

`POST /api/rooms` body `{ "hostName": "Sanskar" }` returns:

```json
{
  "roomId": "r_Q0x...", "code": "K7M3QX",
  "hostToken": "...", "expertToken": "...", "viewerToken": "...",
  "viewerLink": "http://10.0.0.61:8787/r/K7M3QX#t=<viewerToken>",
  "expertLink": "http://10.0.0.61:8787/r/K7M3QX#t=<expertToken>",
  "expiresAt": 1760000000000
}
```

* Tokens are 144-bit random values. The **role is derived from which token is
  presented**, never from a client-supplied field.
* The 6-character code identifies a room but grants nothing by itself.
* Tokens are placed in the URL **fragment** (`#t=`), which browsers never send
  to the server, so they do not appear in HTTP logs.
* Capacity: 1 host connection (a new host connection replaces the old one),
  2 expert connections (Blender + optional browser companion), 8 viewers.
* Rooms expire after 30 minutes with nobody connected, after 12 hours in total,
  or immediately when the host ends them. Scans and frames are kept only in
  memory and are deleted with the room.

## Envelope

Every control message (both directions) is a JSON object:

```json
{
  "protocolVersion": 1,
  "type": "object.update",
  "roomId": "r_Q0x...",
  "clientId": "c_abc...",
  "messageId": "m-7f3e...",
  "sceneRevision": 12,
  "originEpoch": 1,
  "payload": { }
}
```

* `messageId`: unique per sender (UUID recommended), 1 to 64 characters. The
  server keeps a bounded LRU of the last 1000 `(clientId, messageId)` pairs per
  room. A repeated message gets `ack` with `duplicate: true` and has **no
  effect**, so retries never duplicate objects or comments.
* `roomId` / `clientId`: empty string in `auth` (not known yet). After
  `auth.ok` they must match the values assigned by the server.
* `sceneRevision`: on server messages, the room's scene revision after the
  change. Clients may omit it.
* `originEpoch`: **required** on messages that carry geometry (`object.create`,
  `object.propose`, `object.update`, `guidance.set`, `guidance.begin`, `guidance.attempt`,
  `lesson.prompt`). If it is
  not the room's current epoch, the server replies `error` `stale_epoch`.
* Every client message except `ping` is answered with either
  `ack { ackOf }` or `error { ackOf, code, message }`.

## Ordering and ownership

* The server is authoritative. It holds a monotonic `sceneRevision` per room,
  bumped on each scene change (objects, guidance lifecycle, scan, epoch), and a
  per-object `revision`. Client clocks are never used for ordering; timestamps
  in payloads are informational and server-assigned.
* `object.update` must carry `baseRevision` equal to the object's current
  revision, otherwise it fails with `stale_revision`, and the error payload
  includes the current object. Blender therefore keeps at most one update in
  flight per object and coalesces newer edits into the next one.
* **Design objects belong to the expert.** Viewers can never change the scene.
  The host never edits an expert's object directly. During guidance, the host
  controls only a separate **attempt**, which is a signed scalar offset along
  the guidance axis. The server computes the attempt position. Approval is
  applied by the server, which writes the attempt pose into the object and
  bumps its revision. Cancel or reset discard the attempt. The expert and the
  novice never write to the same field, so there is no tug-of-war.
* **The novice can propose.** `object.propose` creates an object with
  `owner: "host"` and a `proposal` record. While it is pending, the host may
  `object.update` or `object.delete` (withdraw) it, and the expert may adjust it
  with `object.update`. The expert then sends `proposal.accept` (the object
  becomes an ordinary expert-owned object) or `proposal.reject` (it is deleted;
  `object.delete` by the expert counts as a rejection). Either way everyone
  receives `proposal.resolved`, which carries the novice's last version and the
  final one so clients can explain what the expert changed. An optional `note`
  is also posted as an expert comment on the object. Proposals cannot be
  guided until accepted. At most 12 proposals can wait at once.

| Message | host | expert | viewer |
| --- | :-: | :-: | :-: |
| `object.create` | | yes | |
| `object.update` / `object.delete` | own pending proposals | yes | |
| `object.propose` | yes | | |
| `proposal.accept` / `proposal.reject` | | yes | |
| `lesson.prompt` / `lesson.clear` | | yes | |
| `lesson.done` | yes | | |
| `comment.add` with `voice` (and `POST .../voice`) | yes | yes | |
| `guidance.set` / `guidance.begin` / `guidance.approve` / `guidance.cancel` | | yes | |
| `guidance.reset` | yes | yes | |
| `guidance.attempt` | yes | | |
| `preview.status`, `origin.reset`, `room.end` | yes | | |
| `selection`, `comment.add`, `reaction.toggle`, `scene.request`, `room.leave`, `ping` | yes | yes | yes |

Forbidden messages get `error` `forbidden`.

## Client -> server messages

| type | payload |
| --- | --- |
| `auth` | `{ roomCode, token, displayName (1-40), clientKind: "ios"\|"blender"\|"web"\|"test", resumeClientId? }` |
| `ping` | `{}` -> `pong` |
| `scene.request` | `{}` -> `scene.snapshot` |
| `room.leave` | `{}` |
| `room.end` | `{}` (host) |
| `origin.reset` | `{ reason? }` (host). Bumps epoch, discards scan and guidance, marks objects stale, then broadcasts a snapshot. |
| `object.create` | `{ object: ObjectInput }` |
| `object.update` | `{ id, baseRevision, patch: Partial<ObjectInput without id/kind> }` |
| `object.delete` | `{ id }` |
| `object.propose` | `{ object: ObjectInput }` (host) |
| `proposal.accept` / `proposal.reject` | `{ id, note? (1-300) }` (expert) |
| `selection` | `{ objectId: string \| null }` |
| `comment.add` | `{ objectId: string \| null, text (1-500), voice?: { clipId, durationMs (1-60000) } }` (5 per 10 s per client) |
| `lesson.prompt` | `{ preset: "scan"\|"move"\|"rotate"\|"scale"\|"place"\|"custom", text (1-200), objectId?, kind?, demo?: { from: ObjectPose, to: ObjectPose } }` (expert) |
| `lesson.done` / `lesson.clear` | `{ lessonId }` (host / expert) |
| `reaction.toggle` | `{ objectId, kind: "like" \| "discuss" }` |
| `guidance.set` | `{ objectId, axis: "x"\|"y"\|"z", targetPosition: Vec3, tolerance? (0.01-0.5, default 0.05) }` |
| `guidance.begin` | `{ guidanceId }` |
| `guidance.attempt` | `{ guidanceId, offset (meters, \|offset\| <= 10), seq (int, increasing), holding: bool }` |
| `guidance.approve` | `{ guidanceId }` |
| `guidance.reset` | `{ guidanceId }` |
| `guidance.cancel` | `{ guidanceId }` |
| `preview.status` | `{ state: "live" \| "paused", targetFps, width }` (host) |

`ObjectInput = { id (UUID), kind, name (1-60), position: Vec3, rotation: Quat [x,y,z,w], dimensions: Vec3, color: "#RRGGBB", textureRef: null | "sample:picture" }`

`kind` is one of the kinds in [`catalog.json`](catalog.json): `pillar`, `partition`, `door`,
`window`, `table`, `chair`, `couch`, `cabinet`, `lamp`, `tv`, `panel` (picture), `block`
(the novice's custom box). Round kinds (`pillar`, `lamp`) need `dimensions[0] == dimensions[2]`.
The catalog also defines how every client builds each kind from boxes, cylinders and
spheres, its default size and colour, where it is placed (floor or wall), and its CAD lesson.

## Server -> client messages

| type | payload |
| --- | --- |
| `auth.ok` | `{ clientId, role, roomId, code, hostName, previewTicket, limits }` (always followed by `scene.snapshot`) |
| `auth.error` | `{ code, message }`, after which the socket is closed |
| `scene.snapshot` | `{ room, participants, objects, guidance, lesson, comments (last 100), reactions, scan, preview }` |
| `presence` | `{ participants }` |
| `object.created` / `object.updated` | `{ object: SceneObject }` |
| `object.deleted` | `{ id }` (comments keep `objectDeleted: true`) |
| `comment.added` | `{ comment }` |
| `reaction.updated` | `{ objectId, like: clientId[], discuss: clientId[] }` |
| `guidance.state` | `{ guidance: Guidance \| null }` |
| `lesson.state` | `{ lesson: Lesson \| null }` |
| `proposal.resolved` | `{ objectId, objectName, kind, outcome: "accepted"\|"adjusted"\|"rejected", byName, note, before: ObjectPose, after: ObjectPose \| null }` |
| `scan.ready` | `{ scan: ScanMeta }` |
| `preview.status` | `{ state: "live"\|"paused"\|"offline", hostConnected, viewers, targetFps, width }` |
| `room.ended` | `{ reason }`, after which sockets are closed |
| `ack` | `{ ackOf, duplicate? }` |
| `error` | `{ ackOf?, code, message, current? }` |
| `pong` | `{}` |

`SceneObject = ObjectInput + { revision, originEpoch, stale (originEpoch < room epoch), owner: "expert"|"host", createdBy, updatedAt, proposal: null | { byClientId, byName, proposedAt, novice: ObjectPose } }`

`ObjectPose = { position, rotation, dimensions }`. `outcome` is `adjusted` when the expert
moved, turned or resized the proposal (by more than 1 cm, 1 degree or 5 mm) before accepting.

### Lessons (expert prompts with "show me" demos)

`Lesson = { id, preset, text, objectId, kind, demo: null | { from: ObjectPose, to: ObjectPose }, byName, state: "open"|"done", createdAt, doneAt, originEpoch }`

One prompt is active at a time; a new `lesson.prompt` replaces it. `move`, `rotate` and
`scale` prompts carry a demo: two poses of a real object, which the phone loops as a
translucent ghost (not a physical simulation) and explains in Blender keys with the
narration rules below. The server completes a prompt itself when the novice does the task:
`scan` when a scan is committed, `place` when the host proposes an object of `kind` (or any
kind if `kind` is null). Other prompts are completed by the host's `lesson.done`. Deleting
the prompt's object or resetting the AR origin (for prompts with a demo) clears it. The
current lesson is part of `scene.snapshot`.

### Voice notes (push-to-talk)

1. The host or expert uploads a clip: `POST /api/rooms/:roomId/voice` with
   `Authorization: Bearer <token>` and `Content-Type` one of `audio/mp4`, `audio/m4a`,
   `audio/x-m4a`, `audio/aac`, `audio/webm`, `audio/ogg`, `audio/mpeg`; at most 1 MiB.
   The response is `{ clipId }`.
2. It attaches the clip to a chat message: `comment.add { objectId, text, voice: { clipId, durationMs } }`.
   `text` is the transcript (made on the phone with on-device speech recognition) or a
   caption typed by the expert, or `"(voice note)"`. A clip can be attached once, only by
   the role that uploaded it; observers cannot send voice notes.
3. Everyone, observers included, receives `comment.added` with
   `comment.voice = { clipId, durationMs, mime }` and plays it with
   `GET /api/rooms/:roomId/voice/:clipId` (any room token). Unattached clips are not
   playable and expire after 2 minutes; a room keeps at most 40 clips, in memory only, and
   deletes them when it ends.

### Learning captions

Clients explain every change in Blender terms so the novice learns the CAD operation
behind it. The rules are fixed by [`fixtures/narration.json`](fixtures/narration.json),
which the iOS app and the web viewer both pass:

* A move is converted to Blender axes (X = x, Y = -z, Z = y). If one axis carries at least
  90% of it, it is "moved NAME 50 cm along the red X axis (left/right)" with `G X 0.5`;
  otherwise "moved NAME 50 cm" with one `G` per axis.
* A heading change of at least 2 degrees is "turned NAME 90°" with `R Z 90`.
* A size change of at least 1% (and 5 mm) is `S 1.5` when uniform, `S Shift+Z r` when only
  the footprint changes, otherwise one `S X/Y/Z r` per axis.
* Values are typed the way Blender accepts them: at most two decimals, no trailing zeros.

A Blender drag arrives as many small updates; clients narrate a gesture once it has
rested (the phone waits 0.8 s; the web viewer merges updates less than 1.5 s apart).

`Guidance = { id, objectId, state: "preview"|"active"|"approved", axis, tolerance, start: {position, rotation}, target: {position, rotation}, attempt: null | {offset, position, distance, withinTolerance, holding, seq, updatedAt}, originEpoch }`

The guidance lifecycle maps onto the start/update/finish/reset operations
like this:

* `guidance.set` creates or replaces the ghost target. The state is `preview`,
  in which the expert can still demonstrate.
* `guidance.begin` captures the object's current pose as `start` and moves to
  the `active` state. The target must lie on the line `start + axis * t`, within
  1 cm, otherwise the server replies `target_off_axis`.
* `guidance.attempt` updates the attempt. The phone sends at most 15 per second,
  plus a final `holding:false` on release.
* `guidance.approve` copies the attempt position into the object, which then
  broadcasts as `object.updated`. The guidance moves to `approved`.
* `guidance.reset` sets the attempt back to offset 0 and the state back to
  `active`.
* `guidance.cancel` removes the guidance. Deleting the object cancels it too.

Error codes: `bad_request`, `unsupported_protocol`, `unauthorized`, `forbidden`,
`not_found`, `room_full`, `rate_limited`, `stale_revision`, `stale_epoch`,
`duplicate_object`, `invalid_dimensions`, `target_off_axis`, `invalid_state`,
`too_large`, `room_ended`.

## Reconnect and late join

1. The client reconnects with backoff (0.5 s doubling to 8 s) and sends `auth`
   with `resumeClientId`.
2. The server reuses the identity when the earlier client had the same role
   and disconnected less than 60 s ago.
3. The server always sends a fresh `scene.snapshot` immediately after
   `auth.ok`. Clients **replace** their state with it and only then resume
   applying incremental messages.
4. If a client sees `sceneRevision` jump by more than one, it sends
   `scene.request`.
5. Late joiners get the current scene, the active guidance, the last 100
   comments and, through the preview socket, the latest frame if it is less
   than 3 s old.

## Preview socket

1. Connect `WS /ws/preview`.
2. The first message must be text:
   `{"type":"preview.auth","ticket":"<previewTicket from auth.ok>"}`. The server
   replies `{"type":"preview.ready","role":"host"|"viewer"}`.
3. The host sends binary frames. Viewers and experts receive them.
4. The server sends the host `{"type":"preview.stats","viewers":n,"dropped":n}`
   about every 2 s.

Binary frame = 24-byte little-endian header followed by a JPEG:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | magic `RBPF` (0x52 0x42 0x50 0x46) |
| 4 | 1 | version = 1 |
| 5 | 1 | orientation of the captured interface: 0 portrait, 1 portraitUpsideDown, 2 landscapeLeft, 3 landscapeRight. The JPEG is already upright as displayed. |
| 6 | 2 | flags: bit0 = synthetic sample room, bit1 = tracking limited |
| 8 | 4 | sequence number (uint32, increasing) |
| 12 | 2 | width in pixels |
| 14 | 2 | height in pixels |
| 16 | 8 | host capture time (float64 ms, informational only) |
| 24 | ... | JPEG bytes (must start with FF D8) |

The server enforces these rules on frames:

* It drops frames while the host has preview `paused`. It also clears the
  latest frame on pause, so nothing stale is shown to late joiners.
* It drops frames that are malformed, oversized, arrive faster than 15 frames
  per second, or carry a sequence number at or below the last one accepted.
* It forwards a frame to a viewer only if that viewer has no frame still in
  flight and its `bufferedAmount` is under 256 KiB. Otherwise the frame is
  dropped for that viewer, and the latest frame is sent when the viewer
  drains.

## Scan upload

The host is authenticated with `Authorization: Bearer <hostToken>`.

1. `POST /api/rooms/:roomId/scan/begin` with
   `{ originEpoch, chunkCount, totalBytes, vertexCount, triangleCount, synthetic }`.
   The response is `{ uploadId }`. Starting a new upload replaces any previous
   staging upload.
2. `PUT /api/rooms/:roomId/scan/:uploadId/chunks/:index` with a binary body of
   at most 256 KiB.
3. `POST /api/rooms/:roomId/scan/:uploadId/commit`. The server checks that
   every chunk is present, that the byte total matches, that the header,
   counts and epoch match, that every vertex is finite and within 50 m, and
   that every index is in range. Only then does it replace the room scan,
   bump `sceneRevision` and broadcast `scan.ready`. A partial or invalid upload
   is never visible. Staging uploads expire after 2 minutes.

The host or expert downloads the result with
`GET /api/rooms/:roomId/scan` (`Authorization: Bearer <hostToken | expertToken>`).
Viewers are denied, to keep the home geometry private.

Scan binary (`RBSC`, little-endian):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | magic `RBSC` |
| 4 | 2 | version = 1 |
| 6 | 2 | flags: bit0 = synthetic |
| 8 | 4 | originEpoch |
| 12 | 4 | vertexCount (at most 200 000) |
| 16 | 4 | triangleCount (at most 400 000) |
| 20 | 12 * vertexCount | float32 x,y,z, canonical world (anchor transforms already applied) |
| ... | 12 * triangleCount | uint32 i0,i1,i2 (counter-clockwise when seen from the front) |

`ScanMeta = { scanId, originEpoch, vertexCount, triangleCount, bytes, synthetic, committedAt }`
