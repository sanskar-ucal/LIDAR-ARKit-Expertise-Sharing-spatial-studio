# RoomBridge

RoomBridge connects three people around one room:

- **Novice (iPhone with LiDAR):** scans the room, optionally shares a low-frame-rate live preview, physically moves design objects into place with a hold-to-move gesture and haptic confirmation, and **learns CAD while doing it**: every edit is explained with the Blender keys that would do it (for example "moved Table 1 50 cm along the red X axis: `G X 0.5`"), and the novice can propose furniture from an object library for the expert to review.
- **Expert (Blender):** gets the room scan as a locked reference mesh, places structure and furniture (pillars, partitions, doorways, windows, tables, chairs, couches, cabinets, lamps, TVs, pictures, custom blocks), reviews the novice's proposals (adjust, then accept or reject with a note), and guides the novice by setting a target on one axis and approving the result.
- **Observers (any browser, learners):** other novices or family who watch the preview, see the objects on a plan view, follow the expert's prompts, the guidance captions and the CAD lesson feed, hear and read every voice note, and leave likes and object-linked comments.

The expert stays in the loop at every stage: they prompt the novice ("scan the whole room", "place a chair") and play quick "show me" ghost demos of CAD operations in the novice's room; the novice watches the expert work (narrated), practises a constrained move (guidance), then proposes their own pieces, and every proposal is reviewed by the expert, whose changes are explained back. Expert and novice can also send push-to-talk voice notes; everyone hears them and reads the transcript.

A small Node.js server on your Mac relays everything over the local Wi-Fi network. Nothing is deployed publicly, nothing is recorded, and scans live only in server memory while a room is open.

CPSC 581, Group Project 2.

## Repository layout

| Path | What it is |
| --- | --- |
| `server/` | TypeScript HTTP + WebSocket room server (rooms, roles, revisions, preview relay, scan upload) |
| `web/` | React + TypeScript browser viewer for observers (and the expert's push-to-talk companion) |
| `blender_addon/roombridge/` | Blender 4.2+ add-on (expert) |
| `ios/RoomBridge/` | SwiftUI + ARKit + RealityKit iPhone app (novice) |
| `ios/RoomBridgeCore/` | Platform-independent Swift package: protocol types, guidance maths, binary formats, mesh simplifier |
| `protocol/` | Protocol v1 spec, coordinate contract, and shared fixtures used by every component's tests |
| `scripts/` | Dev runner, add-on packager, Xcode project generator, synthetic frame generator |
| `docs/` | Setup guides, architecture, troubleshooting, status table, manual device checklist |

## Prerequisites

| For | You need |
| --- | --- |
| Server + web viewer | macOS (or any OS) with **Node.js 20.17+** (`nvm use` reads `.nvmrc`) |
| Expert | **Blender 4.2 or newer** |
| Novice | **Xcode 16+**, **XcodeGen** (`brew install xcodegen`), an **iPhone with LiDAR** (iPhone 12 Pro or newer Pro model) on **iOS 18+**, and an Apple ID for signing |
| Running tests | Python 3.9+ (standard library only) and Swift 6 toolchain (Command Line Tools are enough for the core checks) |

The phone, the Mac running Blender, and observers' browsers must be on the **same Wi-Fi network** (or reach the Mac by IP).

## Quick start

```bash
# 1. Install pinned dependencies (uses package-lock.json)
npm ci

# 2. Build the viewer and the server, then start the server on port 8787
npm run build
npm start
```

The server prints the address other devices must use, for example:

```
RoomBridge server listening on [::]:8787
  Same-Wi-Fi URL for the iPhone / Blender / browsers: http://10.0.0.61:8787
```

Use that address everywhere below (`10.0.0.61` is just an example; yours will differ). **Do not use `localhost` on the iPhone**: there it means the phone itself.

### Start order

1. **Server** on the Mac: `npm start` (above).
2. **iPhone app:** enter `http://10.0.0.61:8787` and your name, tap **Create room (LiDAR scan)**. Allow camera and local network access when asked. See [docs/ios-setup.md](docs/ios-setup.md) to build and install the app.
3. **Invite people** from the phone (**More › Invite people**):
   - *Expert invite* → paste into the Blender add-on's **Invite** field and press **Connect** ([docs/blender-setup.md](docs/blender-setup.md)). This link grants editing rights; only send it to the designer.
   - *Viewer link / QR code* → observers open it in a browser and enters their name.
4. **Scan:** walk slowly around the area, then tap **Send room**. The expert sees the mesh appear in Blender in the `RoomBridge Room Scan (reference)` collection.
5. **Preview (optional):** tap **Share preview** on the phone. It is off by default.
6. **Design:** the expert adds objects from the RoomBridge sidebar's **Design Objects** library; they appear in AR on the phone and on the observers' plan view, and the phone narrates each edit as a CAD lesson (tap the toast or the graduation-cap button for the **Learn** sheet and the CAD skills checklist).
7. **Propose:** the novice taps **＋ (Add object)**, picks a piece, aims the dot at the floor or a wall, and taps **Place & propose**. They can move it to the dot, turn it and resize it while it waits (a custom block can also be recoloured and named). The expert reviews it under **Novice Proposals** in Blender: adjust, then **Accept** or **Reject** with an optional note. The phone buzzes and explains what the expert changed.
8. **Teach:** in Blender's **Teach** panel the expert sends a prompt: *Scan the room*, *Place a piece*, a custom task, or a show-me demo (*move*, *rotate*, *scale*) on the selected object. The phone shows a card; **Show me** loops a teal ghost of the object doing it, with the Blender keys. Scan and place prompts complete themselves; others with **Got it**.
9. **Talk:** the novice holds the **mic** button on the phone; the clip is transcribed on the iPhone and sent with its text. The expert talks from a browser on the Mac: open the expert invite at `http://localhost:8787/...` (browsers only allow the microphone on localhost or HTTPS), hold **Hold to talk**, then check or type the text. Everyone hears the note (new ones play automatically) and reads it in the chat and the lesson feed.
10. **Guide:** the expert selects an object, **Place Target Ghost**, moves the ghost along one axis, **Send Target**, **Begin**. The novice holds **Hold to move** and walks the phone along the coloured line; the phone buzzes once when within tolerance. The novice taps **Done: ask the expert to check**, and the expert presses **Approve** (or **Reset Attempt**).

### Without an iPhone

- **Sample room mode** (iOS Simulator or an iPhone without LiDAR): on the start screen tap **Sample room (simulated, no camera)**. It uses a synthetic floor and two walls, labelled as simulated on every screen and flagged `synthetic` on the wire.
- **Synthetic preview host** (no phone at all): with the server running,

  ```bash
  npm run synthetic-frames -w server -- --server http://127.0.0.1:8787 --fps 5 --objects --teach --propose
  ```

  creates a room, prints a viewer link and an expert invite, streams pre-rendered frames that say **SYNTHETIC TEST FRAME** (also flagged synthetic in each frame header), with `--objects` adds a pillar, a partition and a picture as an expert (`--teach` also sends a show-me prompt), and with `--propose` proposes a table and a chair as the host so you can try the Blender review panel. Ctrl-C ends the room.

Neither mode is evidence that the LiDAR or device path works; see [docs/status.md](docs/status.md).

## Development

```bash
npm run dev          # server with auto-restart on :8787 + Vite viewer with hot reload on :5173
npm test             # server (vitest) + web (vitest) + Blender add-on (python unittest, includes a live-server test)
npm run typecheck    # tsc for server and web
(cd ios/RoomBridgeCore && swift run rbcore-checks)   # Swift core checks against the shared fixtures
bash scripts/package-addon.sh                       # build/roombridge-extension.zip and build/roombridge-addon.zip
bash scripts/gen-ios.sh                             # generate ios/RoomBridge.xcodeproj (needs XcodeGen)
```

`npm run dev` builds the viewer once so invite links (which point at port 8787) work, and also runs Vite on port 5173 for editing the viewer.

## Documentation

- [docs/ios-setup.md](docs/ios-setup.md): build, sign, and run the iPhone app
- [docs/blender-setup.md](docs/blender-setup.md): install and use the add-on
- [docs/architecture.md](docs/architecture.md): components, data flow, design decisions
- [docs/troubleshooting.md](docs/troubleshooting.md): common failures and fixes
- [docs/status.md](docs/status.md): what is implemented, automatically tested, manually verified, or still awaiting device verification, with the latest test results
- [docs/device-checklist.md](docs/device-checklist.md): manual checklist to run on a real iPhone + Blender + browser
- [protocol/PROTOCOL.md](protocol/PROTOCOL.md) and [protocol/COORDINATES.md](protocol/COORDINATES.md): wire protocol and coordinate contract

## Future work

- **Live two-way voice:** push-to-talk notes were chosen over a call so the teaching stays embodied and readable; a real call would need WebRTC (echo cancellation, jitter buffers), which this prototype does not use.
- **Several novices with their own phones:** each phone has its own AR coordinate frame, so this needs shared world anchors or per-phone alignment. Today other learners join as observers.
- **Speech-to-text for the expert's browser:** browser speech recognition sends audio to a cloud service, so the expert types or checks the text instead.
- **Richer custom design:** combining parts on the phone, beyond a single resizable box.

## Privacy and safety

- Invite tokens are random 144-bit secrets carried in the URL fragment (`#t=…`), which browsers never send to the server in HTTP requests. The viewer removes the token from the address bar after reading it and keeps it only in that tab's session storage.
- The server stores only SHA-256 hashes of tokens, never sends one role's credentials to another role, and redacts tokens and tickets in logs and diagnostics.
- Preview frames are relayed in memory only (latest frame, never queued or stored). Room scans exist only in server memory until the room ends or expires. Nothing is written to disk.
- The preview is off until the phone user turns it on, and a red **LIVE** badge shows while it is on.
- Voice notes are recorded only while the talk button is held, with a red recording indicator. The phone transcribes them on the device only (if on-device recognition is unavailable the note is sent without text); the browser does no speech recognition. Clips live in server memory, at most 40 per room, and are deleted with the room.
- The server is meant for a trusted local network. It speaks plain HTTP/WS; put it behind a TLS reverse proxy before exposing it anywhere else.
