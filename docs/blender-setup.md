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

- Objects in the **RoomBridge Design** collection that the add-on created: **Pillar**, **Partition**, **Picture** (a panel with a sample picture on its front face).
- Move (G), rotate (R) and scale (S) in Object Mode, and delete (X). Changes stream while you drag (about 7 updates per second) and settle 0.1 s after you stop.
- Pillars stay round: X and Y scale are kept equal.
- Not synced (local only): edit-mode mesh changes, modifiers, parenting, materials, animation, negative scale.

All network I/O happens on a background thread; every change to the Blender scene happens on the main thread via a 50 ms timer, so Blender stays responsive even when the network is slow.

## Coordinates

Canonical room space is the phone's ARKit world (Y up, metres). Blender is Z up, so the add-on maps `(x, y, z)` → `(x, −z, y)`: the floor is Blender's XY plane at Z = 0, and "in front of where the phone started" is +Y. Details: [protocol/COORDINATES.md](../protocol/COORDINATES.md).

## Room scan

When the phone sends a scan, it appears in the **RoomBridge Room Scan (reference)** collection, locked (not selectable) and approximate. **Re-import Scan** fetches it again. If the phone resets its AR origin, objects from the old origin are shown as wireframes and marked stale; place them where they belong in the new scan and press **Confirm Positions for New Scan**.

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

This includes an end-to-end test that starts the real server (needs `npm ci` first). The `bpy`-dependent modules (`sync`, `primitives`, `ui`) can only be exercised inside Blender; see [device-checklist.md](device-checklist.md).
