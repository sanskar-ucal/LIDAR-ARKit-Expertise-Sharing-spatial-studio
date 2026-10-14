# Troubleshooting

## Connecting

**The phone says "Can't reach the server".**
- Use the Mac's Wi-Fi IP address that the server prints (`http://10.0.0.61:8787`-style), not `localhost` or `127.0.0.1`.
- Phone and Mac must be on the same Wi-Fi. Guest networks and some campus networks (for example eduroam) isolate devices from each other. A phone hotspot with the Mac joined to it works as a fallback.
- Allow **Local Network** for RoomBridge: Settings › Privacy & Security › Local Network.
- macOS firewall: System Settings › Network › Firewall. Allow incoming connections for `node`, or turn the firewall off temporarily.
- Check from another device's browser: `http://<mac-ip>:8787/api/health` should return `{"ok":true,…}`.

**`EADDRINUSE` when starting the server.** Something already uses port 8787 (often a previous server). Stop it, or start on another port: `PORT=8788 npm start`.

**The server prints no "Same-Wi-Fi URL" line.** The Mac has no non-loopback IPv4 address; join a network first.

**Blender says "Online access is disabled".** You are connecting to a non-local address while Blender's **Allow Online Access** is off. Use the Mac's LAN IP, or enable online access in Preferences › System › Network.

**"Room code or invitation is not valid".** The room ended or expired (30 minutes idle, 12 hours maximum by default, and server restarts end all rooms), or the link was cut off when copying. Create a new room on the phone and share fresh links.

**Blender rejects the invite as a viewer link.** You pasted the family link. Use the **expert invite** from the phone's Invite screen.

**"Too many join attempts".** The server rate-limits joining (30 attempts per minute per IP, and 10 failed attempts per minute). Wait a minute.

**A second expert or viewer can't join.** Rooms allow 2 experts and 8 viewers. A new phone (host) connection replaces the previous one.

## Preview

**Viewers see "Preview paused".** The phone user hasn't tapped **Share preview**, or the app is in the background (iOS stops the camera there).

**"Frozen N s — connection slow".** No new frame for over 2 seconds. Usually Wi-Fi congestion; the phone lowers resolution and frame rate automatically. The control channel (objects, comments, guidance) keeps working.

**"SIMULATED — not a real camera".** The frames come from Sample room mode or the synthetic test script. This is expected in those modes.

**Preview looks blurry or low frame rate.** By design: 640 px and about 5 fps to start, adapted down under load or heat. It's a preview, not a video call.

## Scanning

**"No room mesh yet".** Move slowly and point at the floor and walls for a few seconds; the developer panel shows the live mesh anchor and triangle counts.

**"This iPhone has no LiDAR".** Scanning needs a LiDAR iPhone. Everything else still works.

**"The AR origin changed during upload".** An origin reset happened while the scan was uploading, so the server refused it. Scan again.

**Scan appears rotated or offset in Blender.** It shouldn't: both the scan and objects are in the phone's world frame. If AR tracking was reset, objects from before are marked stale; place them again and press **Confirm Positions for New Scan**.

## AR and guidance

**Virtual objects drift or jump.** Tracking is limited (low light, featureless walls, fast motion). Slow down and add light. If it doesn't recover, use **More › Reset AR origin** and scan again.

**"Hold to move" is grey ("Waiting for steady tracking").** Moving is disabled unless tracking is normal, so the object can't be moved based on bad data.

**Holding the button doesn't move the object.** Only walking the phone along the coloured line moves it. Rotating the phone or stepping sideways does nothing, by design.

**No haptic pulse.** It fires once when you enter the tolerance and again only after you leave it by 1.5 × the tolerance. Check that the phone isn't in Low Power Mode and that System Haptics are on (Settings › Sounds & Haptics).

## Blender

**Edits in Blender don't reach the phone.** Only objects in the **RoomBridge Design** collection created with the add-on sync, and only object-level transforms (move, rotate, scale, delete). Check the Developer panel's "in flight" count and the status line.

**Scan import fails with "Not an RBSC scan" or a size error.** The scan was replaced or the room ended; press **Re-import Scan**.

**Reloading the add-on.** Disable and re-enable it (or restart Blender). The add-on disconnects cleanly on unregister.

## Development

**`npm ci` fails on Node < 20.17.** Use Node 20.17 or newer (`nvm install 20 && nvm use`).

**`swift test` says "no such module XCTest".** Command Line Tools don't include XCTest. Use `swift run rbcore-checks`, or install Xcode.

**`scripts/gen-ios.sh` says XcodeGen is not installed.** Run `brew install xcodegen` yourself; the script never installs software.
