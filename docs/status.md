# Status

Last updated: 2026-10-17. Legend:

- **Implemented:** code exists and compiles or typechecks where a compiler was available.
- **Auto-tested:** covered by automated tests that pass (results below).
- **Manually verified:** a person exercised it by hand, with the conditions noted.
- **Awaiting device verification:** needs an iPhone, Xcode and/or Blender, which were not available in the build environment. These items have **not** been shown to work.

The build environment was a Mac with Node 20.17, Python 3, and the Swift 6 Command Line Tools: **no Xcode, no iOS SDK, no iPhone, no Blender**. Later on 2026-10-11 Xcode 27.0 was installed and the iOS app **compiled successfully** for a generic iOS device (unsigned build). It has not yet run on an iPhone. On 2026-10-13 Blender 5.2.2 LTS was installed; `blender_addon/tests/blender_e2e.py` runs the add-on headless inside Blender against the real server with a scripted phone (22 checks pass; it found and fixed two sync bugs). The panels have not been exercised in the GUI. Since then the team has run the app on an iPhone, connected Blender as the expert and imported a real LiDAR scan into Blender, but the steps of [device-checklist.md](device-checklist.md) have not been formally recorded yet, so the rows below still say "awaiting".

On 2026-10-17 the object library, novice proposals and CAD narration ("learn CAD while doing") were added across all components. They are covered by the automated tests below (server, Python, headless Blender with 53 checks, Swift core, web) and the iOS app compiles; they have **not** been tried on the iPhone yet.

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
| Server | Object catalog kinds and round-kind validation | ✓ | ✓ | | |
| Server | Novice proposals: propose, edit/withdraw own, accept (adjusted detection), reject with note, limits, permissions | ✓ | ✓ | | |
| Web | Join from link, token removed from address bar | ✓ | ✓ | ✓ desktop browser | |
| Web | Live preview canvas, stale/paused/offline/synthetic badges | ✓ | ✓ (decode stubbed) | ✓ desktop browser, synthetic frames | real phone frames |
| Web | Participants, object list, reactions, object-linked comments | ✓ | ✓ | ✓ desktop browser | |
| Web | Plan view and guidance captions | ✓ | ✓ (captions) | ✓ desktop browser, scripted guidance | |
| Web | Reconnect with resume | ✓ | ✓ | | |
| Web | CAD lesson feed (shared narration rules, drag merging), proposal tags, catalog footprints | ✓ | ✓ | | |
| Blender | Network thread, WebSocket client, session, reconnect, fatal auth | ✓ | ✓ (live server) | | |
| Blender | Coordinate conversion, coalescing/echo suppression | ✓ | ✓ | | |
| Blender | Scan download, decoding and mesh import | ✓ | ✓ (headless Blender 5.2.2) | | |
| Blender | Registration, invite parsing, primitives, sync of transforms, deletion | ✓ | ✓ (headless Blender 5.2.2) | | |
| Blender | Ghost target, axis snapping, attempt object, approve | ✓ | ✓ (headless Blender 5.2.2) | | |
| Blender | Object library: every catalog kind built from its parts, placement height | ✓ | ✓ (headless Blender 5.2.2) | | |
| Blender | Novice Proposals panel: outline, notice, adjust + accept with note, reject, decision log | ✓ | ✓ (headless Blender 5.2.2) | | |
| Blender | Panel drawing and buttons in the GUI | ✓ | draw code only (stand-in layout, icon names checked) | | ✓ |
| iOS core | Protocol encode/decode, coordinates, guidance maths, tolerance gate, backoff, rate controller, binary formats, mesh simplifier | ✓ | ✓ | | |
| iOS core | Catalog decoding, CAD narrator (shared fixture), drag-settle buffer, proposal messages | ✓ | ✓ | | |
| iOS app | Furniture rendering from catalog parts, proposal styling, placement preview | ✓ | | | ✓ |
| iOS app | Object library, crosshair placement on floor/wall, proposal editor, withdraw | ✓ | | | ✓ |
| iOS app | Learning toasts, Learn sheet with CAD skills, approve/reject haptics | ✓ | narration rules only | | ✓ |
| iOS app | Start screen, room creation, control/preview sockets | ✓ | | | ✓ |
| iOS app | AR session, tracking states, rendering of objects, labels, markers | ✓ | | | ✓ |
| iOS app | LiDAR mesh capture, simplification, chunked upload | ✓ | encoder/simplifier only | | ✓ |
| iOS app | Preview broadcaster (snapshot, downscale, JPEG, adaptive rate) | ✓ | header format only | | ✓ |
| iOS app | Hold-to-move, haptics, Done/Reset, sample-room nudges | ✓ | maths only | | ✓ |
| iOS app | Invite sharing with QR, discussion, developer panel | ✓ | | | ✓ |
| Tooling | `dev.sh`, `package-addon.sh`, `gen-ios.sh`, synthetic frames | ✓ | | ✓ (dev.sh start/stop, zips built, gen-ios reports missing XcodeGen, synthetic stream) | `gen-ios.sh` with XcodeGen installed |

Cross-component compatibility is checked with shared fixtures in `protocol/fixtures/`: `coordinates.json` and `messages.json` (TypeScript, Python, Swift), `narration.json` (Swift and TypeScript produce identical CAD captions), the object catalog `protocol/catalog.json` (read by all four components), and the binary `sample-room.rbsc` and `preview-frame.bin`, which the Swift encoder reproduces byte for byte and the server, web and Python decoders all read.

## Manual verification performed

- **Web viewer with synthetic frames (2026-10-11, desktop browser on the build Mac):** server started with `npm start`, `npm run synthetic-frames -w server -- --objects` streamed the synthetic frames, and the viewer link was opened in a browser. The token disappeared from the address bar. After joining: frames updated with the "SIMULATED — not a real camera" badge; participants showed host, expert and family roles; the three sample objects were listed; selecting the pillar showed "looking at Pillar"; a like and an object-linked comment appeared. A scripted expert then started a guidance step, and the caption read "Move along the red (left/right) axis toward the target, 60 cm" with the target on the plan view. This used synthetic data only and says nothing about the phone.

## Automated test results

Run on 2026-10-17 with Node 20.17.0, Python 3 and the Swift 6 Command Line Tools:

| Command | Result |
| --- | --- |
| `npm run test -w server` (vitest 4.1.11) | 7 files, **82 passed** |
| `npm run test -w web` (vitest 4.1.11) | 3 files, **30 passed** (includes an end-to-end test of the browser client against the real server and the shared narration fixture) |
| `python3 -m unittest discover -s blender_addon/tests -t blender_addon` | **31 passed** (includes 6 end-to-end tests against the real server) |
| `cd ios/RoomBridgeCore && swift run rbcore-checks` | **81 passed, 0 failed** |
| `Blender --background --factory-startup --python blender_addon/tests/blender_e2e.py` (Blender 5.2.2 LTS) | **53 passed, 0 failed** |
| `npm run typecheck` | server and web: no errors |
| `npm run build` | web bundle and server build succeed |
| `xcodebuild -scheme RoomBridge -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build` (Xcode 27.0) | **BUILD SUCCEEDED** (1 deprecation warning) |

To reproduce everything except the Swift checks: `npm ci && npm test`.

## Known limitations

- The iOS app compiles but has not yet run on a device.
- The room scan is a vertex-clustered approximation, capped at about 120k vertices and 200k triangles. It is a reference, not a measured model.
- The preview is a JPEG snapshot stream (about 5 fps by default), not real-time video, and it has no audio.
- Guidance moves along one axis at a time and does not rotate objects.
- Furniture pieces are simple block models built from boxes, cylinders and spheres, not detailed models. Custom design on the phone is limited to a single box (size, colour, name); combining parts is done by the expert in Blender.
- Novice proposals can be moved to the crosshair, turned and resized from the phone; there is no free drag gesture.
- Expert adjustments to a pending proposal are explained when the expert accepts it, not while they drag.
- Only object-level transforms sync from Blender; edit-mode changes, modifiers and materials stay local.
- No TLS: intended for a trusted local network.
- All state is in memory; restarting the server ends every room.
