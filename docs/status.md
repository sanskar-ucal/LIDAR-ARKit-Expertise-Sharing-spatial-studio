# Status

Last updated: 2026-10-11. Legend:

- **Implemented:** code exists and compiles or typechecks where a compiler was available.
- **Auto-tested:** covered by automated tests that pass (results below).
- **Manually verified:** a person exercised it by hand, with the conditions noted.
- **Awaiting device verification:** needs an iPhone, Xcode and/or Blender, which were not available in the build environment. These items have **not** been shown to work.

The build environment was a Mac with Node 20.17, Python 3, and the Swift 6 Command Line Tools: **no Xcode, no iOS SDK, no iPhone, no Blender**. So the iOS app target has never been compiled (its sources only pass `swiftc -parse`, a syntax check), and the add-on's `bpy` code has never run inside Blender.

## Feature status

| Area | Feature | Implemented | Auto-tested | Manually verified | Awaiting device verification |
| --- | --- | :-: | :-: | :-: | :-: |
| Server | Rooms, role tokens, capacity, host replacement, resume within 60 s | ✓ | ✓ | | |
| Server | Object create/update/delete, revisions and conflicts, de-duplication | ✓ | ✓ | | |
| Server | Origin epochs: reset, stale objects, stale-epoch rejection | ✓ | ✓ | | |
| Server | Guidance set/begin/attempt/approve/reset/cancel | ✓ | ✓ | | |
| Server | Comments (object-linked, kept after deletion), reactions | ✓ | ✓ | | |
| Server | Preview latest-frame relay, per-viewer backpressure, pause, late join | ✓ | ✓ | | |
| Server | Chunked scan upload, atomic commit, role-restricted download | ✓ | ✓ | | |
| Server | Rate limits, auth timeout, credential redaction in logs | ✓ | ✓ (auth limits) | | |
| Web | Join from link, token removed from address bar | ✓ | ✓ | ✓ desktop browser | |
| Web | Live preview canvas, stale/paused/offline/synthetic badges | ✓ | ✓ (decode stubbed) | ✓ desktop browser, synthetic frames | real phone frames |
| Web | Participants, object list, reactions, object-linked comments | ✓ | ✓ | ✓ desktop browser | |
| Web | Plan view and guidance captions | ✓ | ✓ (captions) | ✓ desktop browser, scripted guidance | |
| Web | Reconnect with resume | ✓ | ✓ | | |
| Blender | Network thread, WebSocket client, session, reconnect, fatal auth | ✓ | ✓ (live server) | | |
| Blender | Coordinate conversion, coalescing/echo suppression | ✓ | ✓ | | |
| Blender | Scan download and decoding | ✓ | ✓ (no `bpy`) | | mesh import in Blender |
| Blender | Panels, operators, primitives, sync of transforms, deletion | ✓ | | | ✓ |
| Blender | Ghost target, axis snapping, attempt object, approve/reset | ✓ | protocol path only | | ✓ |
| iOS core | Protocol encode/decode, coordinates, guidance maths, tolerance gate, backoff, rate controller, binary formats, mesh simplifier | ✓ | ✓ | | |
| iOS app | Start screen, room creation, control/preview sockets | ✓ (not compiled) | | | ✓ |
| iOS app | AR session, tracking states, rendering of objects, labels, markers | ✓ (not compiled) | | | ✓ |
| iOS app | LiDAR mesh capture, simplification, chunked upload | ✓ (not compiled) | encoder/simplifier only | | ✓ |
| iOS app | Preview broadcaster (snapshot, downscale, JPEG, adaptive rate) | ✓ (not compiled) | header format only | | ✓ |
| iOS app | Hold-to-move, haptics, Done/Reset, sample-room nudges | ✓ (not compiled) | maths only | | ✓ |
| iOS app | Invite sharing with QR, discussion, developer panel | ✓ (not compiled) | | | ✓ |
| Tooling | `dev.sh`, `package-addon.sh`, `gen-ios.sh`, synthetic frames | ✓ | | ✓ (dev.sh start/stop, zips built, gen-ios reports missing XcodeGen, synthetic stream) | `gen-ios.sh` with XcodeGen installed |

Cross-component compatibility is checked with shared fixtures in `protocol/fixtures/`: `coordinates.json` and `messages.json` (TypeScript, Python, Swift), and the binary `sample-room.rbsc` and `preview-frame.bin`, which the Swift encoder reproduces byte for byte and the server, web and Python decoders all read.

## Manual verification performed

- **Web viewer with synthetic frames (2026-10-11, desktop browser on the build Mac):** server started with `npm start`, `npm run synthetic-frames -w server -- --objects` streamed the synthetic frames, and the viewer link was opened in a browser. The token disappeared from the address bar. After joining: frames updated with the "SIMULATED — not a real camera" badge; participants showed host, expert and family roles; the three sample objects were listed; selecting the pillar showed "looking at Pillar"; a like and an object-linked comment appeared. A scripted expert then started a guidance step, and the caption read "Move along the red (left/right) axis toward the target, 60 cm" with the target on the plan view. This used synthetic data only and says nothing about the phone.

## Automated test results

Run on 2026-10-11 with Node 20.17.0, Python 3 and the Swift 6 Command Line Tools:

| Command | Result |
| --- | --- |
| `npm run test -w server` (vitest 4.1.11) | 5 files, **67 passed** |
| `npm run test -w web` (vitest 4.1.11) | 2 files, **13 passed** (includes an end-to-end test of the browser client against the real server) |
| `python3 -m unittest discover -s blender_addon/tests -t blender_addon` | **26 passed** (includes 6 end-to-end tests against the real server) |
| `cd ios/RoomBridgeCore && swift run rbcore-checks` | **54 passed, 0 failed** |
| `npm run typecheck` | server and web: no errors |
| `npm run build` | web bundle and server build succeed |
| `swiftc -parse` on `ios/RoomBridge/**/*.swift` | syntax OK (no type checking possible without the iOS SDK) |

To reproduce everything except the Swift checks: `npm ci && npm test`.

## Known limitations

- The iOS app has not been compiled. Expect a round of small compile fixes the first time it is built in Xcode.
- The room scan is a vertex-clustered approximation, capped at about 120k vertices and 200k triangles. It is a reference, not a measured model.
- The preview is a JPEG snapshot stream (about 5 fps by default), not real-time video, and it has no audio.
- Guidance moves along one axis at a time and does not rotate objects.
- Only object-level transforms sync from Blender; edit-mode changes, modifiers and materials stay local.
- No TLS: intended for a trusted local network.
- All state is in memory; restarting the server ends every room.
