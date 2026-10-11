import json
import math
import pathlib
import unittest

from roombridge import coords

ROOT = pathlib.Path(__file__).resolve().parents[2]
FX = json.loads((ROOT / "protocol/fixtures/coordinates.json").read_text())


def close(test, a, b, places=6):
    test.assertEqual(len(a), len(b))
    for x, y in zip(a, b):
        test.assertAlmostEqual(x, y, places=places)


class CoordinateFixtures(unittest.TestCase):
    def test_points(self):
        for p in FX["points"]:
            with self.subTest(p["name"]):
                close(self, coords.c2b(p["canonical"]), p["blender"])
                close(self, coords.b2c(p["blender"]), p["canonical"])

    def test_rotations(self):
        for r in FX["rotations"]:
            with self.subTest(r["name"]):
                close(self, coords.quat_c2b(r["canonical"]), r["blender"])
                close(self, coords.quat_b2c(r["blender"]), r["canonical"])
                close(self, coords.rotate(r["canonical"], (1, 0, 0)), r["rotatesCanonicalX"])
                close(self, coords.rotate(r["blender"], coords.c2b((1, 0, 0))), coords.c2b(r["rotatesCanonicalX"]))

    def test_objects(self):
        for o in FX["objects"]:
            with self.subTest(o["name"]):
                obj, b = o["object"], o["blender"]
                close(self, coords.c2b(obj["position"]), b["location"])
                close(self, coords.quat_c2b(obj["rotation"]), b["rotation"])
                close(self, coords.dims_to_blender_scale(obj["dimensions"]), b["scale"])
                close(self, coords.blender_scale_to_dims(b["scale"]), obj["dimensions"])

    def test_matrix_columns(self):
        m = FX["matrixCanonicalToBlenderColumnMajor"]
        for i, e in enumerate(((1, 0, 0), (0, 1, 0), (0, 0, 1))):
            close(self, coords.c2b(e), m[i * 3:i * 3 + 3])
        # The documented matrix (row-major tuple) agrees with the function.
        for i, e in enumerate(((1, 0, 0), (0, 1, 0), (0, 0, 1))):
            col = [coords.MATRIX_C2B[r][i] for r in range(3)]
            close(self, coords.c2b(e), col)

    def test_round_trip(self):
        rt = FX["roundTrip"]
        close(self, coords.c2b(rt["canonicalPosition"]), rt["blenderPosition"])
        close(self, coords.quat_c2b(rt["canonicalRotation"]), rt["blenderRotation"])
        close(self, coords.b2c(coords.c2b(rt["canonicalPosition"])), rt["canonicalPosition"])
        close(self, coords.quat_b2c(coords.quat_c2b(rt["canonicalRotation"])), rt["canonicalRotation"])

    def test_axis_projection(self):
        offset, snapped, perp = coords.project_onto_axis((0, 0, -2), "x", (0.6, 0.004, -2))
        self.assertAlmostEqual(offset, 0.6)
        close(self, snapped, (0.6, 0, -2))
        self.assertAlmostEqual(perp, 0.004)
        self.assertEqual(coords.dominant_axis((0.1, -0.5, 0.2)), "y")
        # Blender axis names map to the same physical direction in canonical space.
        for b_axis, c_axis in coords.BLENDER_AXIS_TO_CANONICAL.items():
            unit_b = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}[b_axis]
            c = coords.b2c(unit_b)
            self.assertAlmostEqual(abs(c["xyz".index(c_axis)]), 1.0)

    def test_normalize_quat_sign(self):
        q = coords.normalize_quat((0, -math.sqrt(0.5), 0, -math.sqrt(0.5)))
        self.assertGreaterEqual(q[3], 0)


if __name__ == "__main__":
    unittest.main()
