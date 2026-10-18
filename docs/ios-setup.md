# iPhone app setup

The app lives in `ios/RoomBridge/` (SwiftUI, ARKit, RealityKit) and depends on the local Swift package `ios/RoomBridgeCore/`. The Xcode project is generated from `ios/project.yml`, so there is no `.xcodeproj` in git.

## Requirements

- Xcode 16 or newer (iOS 18 SDK). The app uses `MeshResource.generateCylinder`, `generateCone` and `BillboardComponent`, which need iOS 18.
- XcodeGen: `brew install xcodegen`.
- An iPhone on iOS 18+. **Room scanning needs LiDAR** (iPhone 12 Pro or later Pro models). Without LiDAR the app still runs AR, objects and the live preview, but **Send room** is disabled. The Simulator can only run **Sample room** mode.
- A free Apple ID is enough for personal device installs (apps signed this way expire after 7 days).

## Build and run

```bash
bash scripts/gen-ios.sh
```

The first run copies `ios/Config/Signing.xcconfig.example` to `ios/Config/Signing.xcconfig` (git-ignored). Edit it:

```
DEVELOPMENT_TEAM = <your 10-character Team ID>
PRODUCT_BUNDLE_IDENTIFIER = com.<yourname>.roombridge
```

Find the Team ID in Xcode › Settings › Accounts (select your team) or on developer.apple.com › Membership. With a personal team the bundle identifier must be unique to you.

Then:

1. Re-run `bash scripts/gen-ios.sh` if you changed `project.yml`.
2. Open `ios/RoomBridge.xcodeproj`.
3. Connect the iPhone by cable, unlock it, and trust the Mac. Enable **Developer Mode** on the phone (Settings › Privacy & Security › Developer Mode) if asked.
4. Choose the **RoomBridge** scheme and your iPhone, then **Run** (⌘R).
5. First launch with a personal team: on the phone, Settings › General › VPN & Device Management › trust your developer certificate.

## First use

1. Start the server on the Mac (`npm run build && npm start`) and note the printed `http://<mac-ip>:8787` address.
2. In the app, enter that address (for example `http://10.0.0.61:8787`) and your name.
3. Tap **Create room (LiDAR scan)**. Allow **Camera** and **Local Network** when iOS asks. If you declined Local Network by accident: Settings › Privacy & Security › Local Network › RoomBridge. The first time you hold the **mic** button, iOS also asks for **Microphone** and **Speech Recognition**; transcription runs on the iPhone only, and if your language has no on-device model the note is sent as audio without text.
4. Use the bottom bar:
   - **QR icon (Invite):** viewer QR code and link, the expert invite (grants editing; send only to the designer), and the room code.
   - **Send room:** simplifies the current LiDAR mesh (up to about 120k vertices / 200k triangles) and uploads it. After a successful upload the mesh overlay is hidden and the scan is frozen.
   - **Share preview / Stop preview:** the low-frame-rate live preview (off by default). Starts around 5 fps at 640 px wide and adapts to network speed and phone temperature.
   - **Chat:** participants, the object list with likes/discuss reactions, and comments (object-linked when an object is selected).
   - **More:** **Reset AR origin** (use if virtual objects drifted badly; discards the scan and marks objects stale until the expert re-places them), **Developer panel**, **Leave room**.
5. When the expert starts a guidance step, the panel shows the axis colour and distance. Press and hold **Hold to move**, walk the phone along the coloured line, and let go. Turning the phone does nothing; only movement along the line counts. One haptic pulse means you are within tolerance. Then tap **Done — ask the expert to check**.

## Notes

- ATS: the app talks plain HTTP/WS to the Mac at whatever address the user types. `NSAllowsLocalNetworking` turned out not to cover IPv6 addresses (an iPhone hotspot on an IPv6-only carrier gives the Mac only IPv6), so `Info.plist` sets `NSAllowsArbitraryLoads`. This is acceptable for a local prototype; a deployed version should use HTTPS/WSS and drop the exception.
- Backgrounding the app pauses the camera and the preview; viewers see "Preview paused". When you return, the app reconnects and resumes.
- Without Xcode you can still verify the shared logic:

  ```bash
  cd ios/RoomBridgeCore && swift run rbcore-checks
  ```

  With Xcode, `swift test` (or the RoomBridgeCoreTests target) runs the same checks through XCTest.
