# Manual device checklist

Run this on real hardware before relying on the app: a LiDAR iPhone (iOS 18+), a Mac with Blender 4.2+, and at least one other browser device (a second phone or laptop), all on the same Wi-Fi. Record the date, devices, iOS and Blender versions, and the result of each step. When a step passes, update the matching row in [status.md](status.md) from "Awaiting device verification" to "Manually verified", noting the conditions. If a step fails, write down what happened instead of marking it passed.

Setup: `npm ci && npm run build && npm start` on the Mac. Note the printed `http://<mac-ip>:8787`.

## A. Build and launch

- [ ] A1. `bash scripts/gen-ios.sh` generates the project; it builds in Xcode with no errors (record any compile fixes needed).
- [ ] A2. The app launches on the iPhone; the start screen shows "Create room (LiDAR scan)".
- [ ] A3. Entering `http://localhost:8787` shows the explanation that localhost is the phone itself.
- [ ] A4. With the correct Mac IP, **Create room** asks for Camera and Local Network permission, then opens the AR view with "Connected".

## B. Invites and roles

- [ ] B1. The Invite sheet shows a QR code; scanning it on the second device opens the viewer join page, and the token disappears from the address bar after loading.
- [ ] B2. The family member joins and appears on the phone (Chat › People) as Family.
- [ ] B3. Pasting the **viewer** link into Blender is refused; pasting the **expert** invite connects as Expert.
- [ ] B4. Saving the `.blend` file and reopening it: no credential is stored (the token field is empty).

## C. Scan

- [ ] C1. Walking the room shows the mesh overlay; the developer panel counts mesh anchors and faces.
- [ ] C2. **Send room** shows progress, then "Room sent: N points, M triangles" with **no** "SIMULATED" label.
- [ ] C3. Blender shows the mesh in `RoomBridge Room Scan (reference)`, not selectable, with the detected floor height shown in the Room Scan panel (new pillars stand on the real floor) and the area in front of the phone's starting position on +Y. Record the time from tapping Send to the mesh appearing.
- [ ] C4. A known distance (for example a 1 m tape on the floor) measures about 1 m in Blender. Record the error.

## D. Objects

- [ ] D1. Adding a Pillar, Partition and Picture in Blender: each appears in AR at the matching place within about a second, with labels and sizes.
- [ ] D2. Moving (G) a pillar in Blender moves it smoothly in AR while dragging, and it settles at the final position.
- [ ] D3. The picture panel's image is upright and not mirrored on the phone (the sun is at the top right), and faces the same way as in Blender.
- [ ] D4. Rotating (R) a partition 90° about Blender Z rotates it the same way in AR.
- [ ] D5. Deleting (X) an object in Blender removes it on the phone and in the browser; its comments stay, marked "(deleted)".
- [ ] D6. The family viewer's plan view matches the layout seen in AR.

## E. Preview

- [ ] E1. Before tapping **Share preview**, the browser shows "Preview paused".
- [ ] E2. After tapping it, the browser shows the camera image with the virtual objects composited in, with no "SIMULATED" badge. Record the frame rate in the browser's Developer details and the visible lag (for example by waving a hand).
- [ ] E3. With two or three browsers watching, the phone stays responsive and AR content does not stutter. Record the phone's thermal state (developer panel) after 5 minutes.
- [ ] E4. Turning Wi-Fi off on one viewer shows "Frozen…" there while the others continue; turning it back on reconnects.
- [ ] E5. Sending the app to the background shows "Preview paused" to viewers; returning resumes it.

## F. Guidance

- [ ] F1. In Blender: select the pillar, **Place Target Ghost**, move the ghost about 0.5 m along X, **Send Target**. The phone shows the translucent TARGET and a red line; the browser caption describes the move.
- [ ] F2. **Begin**: the phone shows "Hold to move". Rotating the phone while holding does not move the attempt; walking along the line does.
- [ ] F3. Exactly one haptic pulse when the attempt gets within tolerance; no buzzing while you stay inside it.
- [ ] F4. Blender's orange attempt object follows the phone's attempt, and the panel shows the distance and "WITHIN TOLERANCE".
- [ ] F5. **Done — ask the expert to check** posts a comment linked to the object.
- [ ] F6. **Reset Attempt** in Blender sends the phone's attempt back to the start, including while the button is held.
- [ ] F7. **Approve** moves the real object to the attempt position everywhere; the ghost disappears on the phone.
- [ ] F8. Covering the camera while holding (tracking becomes limited) stops the hold, with a message.
- [ ] F9. Repeat F1 to F7 on the Y (up/down) and Z (forward/back) axes.

## G. Robustness

- [ ] G1. Restarting Blender's connection (Disconnect, Connect) restores all objects without duplicates.
- [ ] G2. Turning the phone's Wi-Fi off for 10 s and on again: "Reconnecting…", then "Connected", and the scene is intact.
- [ ] G3. **More › Reset AR origin**: objects are hidden on the phone and shown as stale (wireframe) in Blender; after a new scan and **Confirm Positions for New Scan**, they reappear in AR.
- [ ] G4. **Leave room › End room for everyone**: the viewer and Blender both report that the room ended.

## H. Sample room mode (Simulator or non-LiDAR iPhone)

- [ ] H1. **Sample room** shows the synthetic floor and walls with "SAMPLE ROOM (simulated, no camera)".
- [ ] H2. **Send room** uploads a scan labelled as simulated in the app, in the browser's Developer details, and in Blender's Room Scan panel ("SAMPLE ROOM (simulated)").
- [ ] H3. The preview shows the "SIMULATED — not a real camera" badge in the browser.
- [ ] H4. During guidance, the ±5 cm buttons move the attempt and trigger the on-target state.
