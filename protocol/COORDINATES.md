# RoomBridge coordinate contract (v1)

Every client converts at its own boundary. Nobody guesses axis swaps
independently: the matrix below is the single source of truth, and
`protocol/fixtures/coordinates.json` is checked by the TypeScript, Python and
Swift test suites.

## Canonical room space

* Units: **meters**.
* Handedness: **right-handed**, **Y up**.
* Axes are exactly the ARKit world frame of the scanning phone's current AR
  session: +X right, +Y up (gravity-aligned), -Z "forward" from where the
  session started. The origin is wherever ARKit placed it when the session
  started.
* The origin is only meaningful within one **origin epoch** (`originEpoch`,
  integer starting at 1). Resetting the AR session (or relaunching the app)
  increments the epoch on the server. Geometry or poses tagged with an older
  epoch are rejected (`stale_epoch`); objects created in an older epoch are kept
  but flagged as stale and hidden on the phone until the expert re-places them.

## Wire formats

| Item | Format |
| --- | --- |
| Position | `[x, y, z]` meters, canonical world |
| Orientation | unit quaternion **`[x, y, z, w]`** (scalar last), canonical world |
| 4x4 matrix (when used) | 16 numbers, **column-major** (same memory order as `simd_float4x4` and glTF) |
| Dimensions | `[sx, sy, sz]` meters, **final physical size** along the object's local X/Y/Z. Always positive. |

Object scale is never sent. On the phone every entity has scale 1 and the mesh is
generated at the final size. In Blender the base mesh is a 1 m unit primitive and
`object.scale` *is* the dimension (mapped to Blender local axes below), so scale
is applied exactly once on each side.

## Canonical <-> Blender

Blender is right-handed **Z up** (+X right, +Y "into the screen" in front view,
+Z up). The conversion is a proper rotation of +90 degrees about X:

```
           | 1  0  0 |                     | 1  0  0 |
M (c->b) = | 0  0 -1 |    M^-1 = M^T (b->c) = | 0  0  1 |
           | 0  1  0 |                     | 0 -1  0 |

b = M c      =>  (bx, by, bz) = ( cx, -cz,  cy)
c = M^T b    =>  (cx, cy, cz) = ( bx,  bz, -by)
```

`det(M) = +1`, so handedness is preserved and no mirroring happens.

* **Rotations:** `R_b = M R_c M^T`. For quaternions this rotates the vector
  part: `q_b = (cx, -cz, cy, w)` and `q_c = (bx, bz, -by, w)` (all `[x,y,z,w]`).
  Blender's `mathutils.Quaternion` is constructed as `(w, x, y, z)`; reorder at
  that call site only.
* **Local axes:** because `R_b = M R_c M^T`, an object with identity rotation in
  canonical space has identity rotation in Blender. Its canonical local axes map
  to Blender local axes the same way as world axes: local +Y (up) -> Blender
  local +Z, local +Z (front) -> Blender local -Y.
* **Dimensions -> Blender scale:** `scale_b = (sx, sz, sy)` and back
  `dims_c = (scale_b.x, scale_b.z, scale_b.y)`. Dimensions are a size, not a
  direction, so there is no sign change.
* Negative or zero Blender scale is **rejected** by the add-on (the object is
  reverted to the last synced state and an error is shown).
* Matrices: `T_b = diag(M,1) * T_c * diag(M^T,1)`.

## Supported primitives

All origins and local axes are in canonical terms.

| Kind | Mesh | Dimensions | Origin / pivot |
| --- | --- | --- | --- |
| `pillar` | vertical cylinder, axis = local +Y | `[diameter, height, diameter]`; X and Z must be equal (1 mm tolerance) | center of the **base** disc |
| `partition` | cuboid | `[width, height, depth]` | center of the **bottom** face |
| `panel` (picture panel) | thin cuboid; picture on the local **+Z** face | `[width, height, thickness]` | **geometric center** |
| `door`, `table`, `chair`, `couch`, `cabinet`, `lamp`, `block` | parts from [catalog.json](catalog.json) | `[width, height, depth]` (lamp: round like a pillar) | center of the **bottom** |
| `window`, `tv` | parts from [catalog.json](catalog.json); front is local **+Z** | `[width, height, depth]` | **geometric center** |

Catalog parts are given in the unit box of their kind (x, z in [-0.5, 0.5]; y in [0, 1] for
a bottom origin or [-0.5, 0.5] for a centre origin) and scaled by the object's dimensions, so
every client builds the same shape. The front of every object (chair seat, couch, TV screen)
faces local +Z.

Allowed dimension range per axis: 0.01 m to 20 m. Allowed position range:
|coordinate| <= 100 m.

In Blender the corresponding unit meshes are: pillar = cylinder of diameter 1
and height 1 with its base at z = 0; partition = 1 m cube with its bottom at
z = 0; panel = 1 m cube centred at the origin whose picture face is local -Y
(which is canonical local +Z).

## Room scan geometry

ARKit returns each `ARMeshAnchor`'s vertices in **anchor-local** coordinates.
The phone multiplies every vertex by that anchor's `transform` **once** and
uploads canonical world-space vertices. Neither the server nor Blender applies
any anchor transform. Blender converts each vertex with `M` and nothing else.
The scan is tagged with its `originEpoch`.

The scan is an approximate proxy: ARKit's reconstruction is coarse, and the
phone further simplifies it with vertex clustering so that it stays under the
upload budget. It is not a survey-accurate model.

## Guidance axis

Guidance axes are canonical world axes `"x" | "y" | "z"`. Display colours follow
Blender's axis colours for the *same physical direction*:

| Canonical | Blender | Colour | Caption |
| --- | --- | --- | --- |
| `x` | X | red | left / right |
| `y` | Z | blue | up / down |
| `z` | -Y | green | forward / back |
