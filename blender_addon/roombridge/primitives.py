"""Blender-side meshes, materials and collections. Main thread only."""

from __future__ import annotations

import math

import bmesh
import bpy

DESIGN_COLLECTION = "RoomBridge Design"
SCAN_COLLECTION = "RoomBridge Room Scan (reference)"
GUIDE_COLLECTION = "RoomBridge Guidance"

SAMPLE_IMAGE = "RB Sample Picture"
TARGET_NAME = "RB TARGET (ghost)"
ATTEMPT_NAME = "RB NOVICE ATTEMPT"
SCAN_NAME = "RB Room Scan (approximate)"

DEFAULT_COLORS = {"pillar": "#c9b79c", "partition": "#d8cfc0", "panel": "#ffffff", "doorway": "#8b5a2b", "window": "#add8e6", "table": "#8b4513", "chair": "#654321", "light": "#ffffe0", "lamp": "#fffacd", "tv": "#1c1c1c", "couch": "#4a3b32", "cabinet": "#5c4033"}
DEFAULT_DIMENSIONS = {"pillar": (0.3, 2.4, 0.3), "partition": (1.2, 2.0, 0.1), "panel": (0.8, 0.6, 0.03), "doorway": (0.9, 2.1, 0.15), "window": (1.0, 1.2, 0.15), "table": (1.2, 0.75, 0.8), "chair": (0.5, 0.5, 0.9), "light": (0.2, 0.2, 0.1), "lamp": (0.3, 0.3, 1.5), "tv": (1.2, 0.7, 0.1), "couch": (2.0, 0.9, 0.85), "cabinet": (0.9, 0.45, 1.8)}
DEFAULT_NAMES = {"pillar": "Pillar", "partition": "Partition", "panel": "Picture Panel", "doorway": "Doorway", "window": "Window", "table": "Table", "chair": "Chair", "light": "Light Fixture", "lamp": "Floor Lamp", "tv": "Television", "couch": "Couch", "cabinet": "Cabinet"}


def ensure_collection(name: str, selectable: bool = True) -> bpy.types.Collection:
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
    root = bpy.context.scene.collection
    if root.children.get(coll.name) is None:
        root.children.link(coll)
    coll.hide_select = not selectable
    return coll


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear_rgba(hex_color: str, alpha: float = 1.0):
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), alpha)


def unit_mesh(kind: str, name: str) -> bpy.types.Mesh:
    """1 m unit primitive; object.scale then equals the physical dimensions (see COORDINATES.md)."""
    bm = bmesh.new()
    try:
        if kind == "pillar":
            bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=32, radius1=0.5, radius2=0.5, depth=1.0)
            bmesh.ops.translate(bm, verts=bm.verts, vec=(0.0, 0.0, 0.5))  # origin at base centre
        elif kind in ("partition", "doorway", "window", "table", "chair", "couch", "cabinet", "lamp"):
            bmesh.ops.create_cube(bm, size=1.0)
            bmesh.ops.translate(bm, verts=bm.verts, vec=(0.0, 0.0, 0.5))  # origin at bottom centre
        else:
            bmesh.ops.create_cube(bm, size=1.0)  # panel: origin at centre
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
    finally:
        bm.free()
    if kind == "panel":
        uv = mesh.uv_layers.new(name="UVMap")
        for poly in mesh.polygons:
            # Blender local -Y is canonical local +Z, the picture side.
            if poly.normal.y < -0.9:
                poly.material_index = 1
                for li in poly.loop_indices:
                    co = mesh.vertices[mesh.loops[li].vertex_index].co
                    uv.data[li].uv = (co.x + 0.5, co.z + 0.5)
    return mesh


def color_material(name: str, hex_color: str) -> bpy.types.Material:
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    rgba = hex_to_linear_rgba(hex_color)
    mat.diffuse_color = rgba
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = rgba
    return mat


def sample_image() -> bpy.types.Image:
    """Procedural landscape. The sun sits top-right so a flipped or rotated picture is obvious."""
    img = bpy.data.images.get(SAMPLE_IMAGE)
    if img is not None:
        return img
    w, h = 256, 192
    img = bpy.data.images.new(SAMPLE_IMAGE, width=w, height=h, alpha=False)
    px = [0.0] * (w * h * 4)
    sun_x, sun_y, sun_r = 0.78 * w, 0.75 * h, 0.09 * h
    for y in range(h):  # row 0 is the bottom of the image in Blender
        fy = y / (h - 1)
        sky = (0.95 - 0.35 * fy, 0.75 - 0.15 * fy, 0.55 + 0.35 * fy)
        for x in range(w):
            fx = x / (w - 1)
            hill = 0.28 + 0.08 * math.sin(fx * 6.2) + 0.04 * math.sin(fx * 17.0)
            if fy < hill:
                c = (0.25, 0.42 + 0.2 * fy, 0.32)
            elif (x - sun_x) ** 2 + (y - sun_y) ** 2 < sun_r ** 2:
                c = (1.0, 0.85, 0.35)
            else:
                c = sky
            i = (y * w + x) * 4
            px[i] = srgb_to_linear(c[0])
            px[i + 1] = srgb_to_linear(c[1])
            px[i + 2] = srgb_to_linear(c[2])
            px[i + 3] = 1.0
    img.pixels.foreach_set(px)
    img.pack()
    return img


def picture_material() -> bpy.types.Material:
    name = "RB Picture"
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = sample_image()
    tex.location = (-300, 300)
    if bsdf is not None:
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    mat.diffuse_color = (0.8, 0.7, 0.5, 1.0)
    return mat


def apply_materials(obj: bpy.types.Object, kind: str, hex_color: str, texture_ref) -> None:
    mesh = obj.data
    base = color_material(f"RB {obj.get('rb_id', obj.name)[:8]} color", hex_color)
    mats = [base]
    if kind == "panel":
        mats.append(picture_material() if texture_ref == "sample:picture" else base)
    while len(mesh.materials) < len(mats):
        mesh.materials.append(None)
    for i, m in enumerate(mats):
        mesh.materials[i] = m


def ghost_material(name: str, hex_color: str, alpha: float) -> bpy.types.Material:
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    rgba = hex_to_linear_rgba(hex_color, alpha)
    mat.diffuse_color = rgba
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = rgba
        if "Alpha" in bsdf.inputs:
            bsdf.inputs["Alpha"].default_value = alpha
    # Eevee Next (4.2+) uses surface_render_method; older versions blend_method.
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "BLENDED"
    elif hasattr(mat, "blend_method"):
        mat.blend_method = "BLEND"
    return mat


def remove_object(obj: bpy.types.Object) -> None:
    mesh = obj.data if obj.type == "MESH" else None
    bpy.data.objects.remove(obj, do_unlink=True)
    if mesh is not None and mesh.users == 0:
        bpy.data.meshes.remove(mesh)
