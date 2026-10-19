# Blender add-on setup

The add-on is in `blender_addon/roombridge/`. It uses only Blender's bundled Python and the standard library (a small RFC 6455 WebSocket client), so there is nothing to `pip install`.

## Install (Blender 4.2+)

```bash
bash scripts/package-addon.sh
```

This writes two zips to `build/`:

- `roombridge-extension.zip` (recommended for Blender 4.2+): **Edit › Preferences › Get Extensions › ⌄ (top right) › Install from Disk…**
- `roombridge-addon.zip` (legacy add-on format): **Edit › Preferences › Add-ons › ⌄ › Install from Disk…**, then tick **RoomBridge**.

Blender 4.2+ has an **Allow Online Access** switch (**Edit › Preferences › System › Network**). The add-on respects it: with online access off it still connects to local-network servers (private IPs such as 10.x, 192.168.x, 172.16–31.x, `.local` names and `localhost`), which is the intended setup, but refuses any other address with a message.

For development you can instead symlink the folder into Blender's add-ons directory, for example on macOS:

```bash
ln -s "$PWD/blender_addon/roombridge" "$HOME/Library/Application Support/Blender/4.2/scripts/addons/roombridge"
```

## Connect

1. In the 3D Viewport press **N** and open the **RoomBridge** tab.
2. Paste the **expert invite** from the phone into **Invite**. Server URL, room code and credential fill in automatically and the invite field clears itself.
3. Enter your display name and press **Connect**.

The credential is stored on the window manager, so it is not saved into your `.blend` file. If you paste a viewer link instead of an expert invite, the add-on refuses it and does not retry.

## What syncs

- Objects in the **RoomBridge Design** collection that the add-on created, from the **Design Objects** library: Structure (Pillar, Partition, Doorway, Window), Furniture (Table, Chair, Couch, Cabinet), Lighting & decor (Lamp, TV, Picture) and Custom (Custom block). Each is built from simple boxes, cylinders and spheres defined in [protocol/catalog.json](../protocol/catalog.json), so the phone shows exactly the same shape. Hover a button to see its CAD lesson. Wall items (window, TV, picture) start at their usual height; everything else stands on the detected floor.
- Move (G), rotate (R) and scale (S) in Object Mode, and delete (X). Changes stream while you drag (about 7 updates per second) and settle 0.1 s after you stop. The phone narrates each finished edit to the novice in Blender terms ("moved Table 1 50 cm along the red X axis: G X 0.5").
- Pillars and lamps stay round: X and Y scale are kept equal.
- Not synced (local only): edit-mode mesh changes, modifiers, parenting, materials, animation, negative scale.

All network I/O happens on a background thread; every change to the Blender scene happens on the main thread via a 50 ms timer, so Blender stays responsive even when the network is slow.

## Coordinates

Canonical room space is the phone's ARKit world (Y up, metres). Blender is Z up, so the add-on maps `(x, y, z)` → `(x, −z, y)`: the origin is where the phone was when AR started (about chest height), and "in front of where the phone started" is +Y. The real floor is usually around Z = −1.2; the add-on detects it from the scan (shown in the Room Scan panel) and stands new pillars and partitions on it. Details: [protocol/COORDINATES.md](../protocol/COORDINATES.md).

## Room scan

When the phone sends a scan, it appears in the **RoomBridge Room Scan (reference)** collection, locked (not selectable) and approximate. **Re-import Scan** fetches it again. If the phone resets its AR origin, objects from the old origin are shown as wireframes and marked stale; place them where they belong in the new scan and press **Confirm Positions for New Scan**.

## Review the novice's proposals

The novice can place pieces from the phone's object library. They arrive outlined and labelled (wireframe overlay, name shown in front) and are listed under **Novice Proposals**, with a notice in the main panel.

1. **Select** a proposal to inspect it. Adjust it with G, R or S if it needs fixing; the novice sees it move.
2. Optionally type a **Note** (for example "Moved it back so the door can open").
3. **Accept** keeps it, including your changes, and it becomes a normal design object. **Reject** removes it. Deleting a proposal with X also counts as a rejection.

The novice's phone confirms with a haptic and explains what you changed in Blender keys, together with your note. Accept a proposal before using it in a guidance exercise.

## Teach with prompts and "show me" demos

The **Teach (Prompts & Show Me)** panel sends one prompt at a time to the phone:

- **Scan the room**: completes by itself when the phone sends a scan.
- **Place a piece** (choose which): completes when the novice proposes that piece.
- **Show: move / rotate / scale**: select a design object, pick the axis and the distance, angle or factor. The phone loops a teal ghost of that object doing the operation (it is a demonstration only; the object itself does not change), with the Blender keys, e.g. **G X 0.5**. The novice taps **Got it**.
- **Custom task**: your own text.

Leave **Text** empty for a ready-made instruction. The panel shows whether the novice has finished; **Clear Prompt** removes it.

## Voice notes

Blender cannot record audio, so talk from a browser on the same Mac: open the expert invite as `http://localhost:8787/r/CODE#t=…` (browsers only allow the microphone on localhost or HTTPS; the page offers a localhost link if you opened the LAN address). Hold **Hold to talk**, release, type or check the text everyone will read, and **Send voice note**. The novice's phone plays it straight away. The novice's voice notes (transcribed on the phone) appear in Blender's **Discussion** panel and play in that browser tab.

## Guide the novice

1. Select a design object and press **Place Target Ghost**: a wireframe twin `RB TARGET (ghost)` appears.
2. Move the ghost along **one** axis to where the object should go. Choose **Axis** (Auto picks the axis you moved most along) and **Tolerance**.
3. **Send Target**. If the ghost was off the axis line it is snapped onto it, and the panel says by how much.
4. **Begin**. The phone shows the target, the coloured axis line, and a hold-to-move button.
5. While the novice moves, the orange `RB NOVICE ATTEMPT` object follows their position (it is not selectable; the novice owns it), and the panel shows the distance and whether it is within tolerance.
6. **Approve** moves the real object to where the novice placed it. **Reset Attempt** sends the attempt back to the start. **Cancel** ends the exercise.

## Discussion

The **Discussion** panel shows the latest comments, including which object each refers to. Like/discuss counts appear next to each object in **Design Objects**.

## Tests without Blender

The pure-Python modules (`coords`, `protocol`, `tracker`, `scan_format`, `ws_client`, `session`) import without `bpy`:

```bash
python3 -m unittest discover -s blender_addon/tests -t blender_addon
```

This includes an end-to-end test that starts the real server (needs `npm ci` first).

The `bpy`-dependent modules (`sync`, `primitives`, `ui`) are exercised headless inside real Blender against the real server, with a scripted phone:

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python blender_addon/tests/blender_e2e.py
```

It covers connecting from an invite, scan import, every catalog kind, transform sync, guidance, proposals (accept with an adjustment and a note, reject), a show-me prompt that the phone completes, a voice note from the phone, and drawing every panel against a stand-in layout. Real panel drawing and clicking still need the GUI; see [device-checklist.md](device-checklist.md).
