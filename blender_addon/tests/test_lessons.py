import math
import unittest

from roombridge import lessons

TABLE = {"id": "t1", "kind": "table", "name": "Table 1", "position": [1.0, 0.0, -2.0], "rotation": [0, 0, 0, 1],
         "dimensions": [1.2, 0.75, 0.8]}
PILLAR = {"id": "p1", "kind": "pillar", "name": "Pillar", "position": [0.0, 0.0, 0.0], "rotation": [0, 0, 0, 1],
          "dimensions": [0.3, 2.4, 0.3]}


class Lessons(unittest.TestCase):
    def test_move_demo_uses_blender_axes(self):
        x = lessons.build("move", TABLE, axis="X", distance=0.5)
        self.assertEqual(x["demo"]["to"]["position"], [1.5, 0.0, -2.0])
        self.assertIn("red X axis", x["text"])
        y = lessons.build("move", TABLE, axis="Y", distance=0.5)  # Blender +Y is canonical -Z (forward)
        self.assertEqual(y["demo"]["to"]["position"], [1.0, 0.0, -2.5])
        z = lessons.build("move", TABLE, axis="Z", distance=0.25)
        self.assertEqual(z["demo"]["to"]["position"], [1.0, 0.25, -2.0])
        self.assertEqual(x["objectId"], "t1")
        self.assertEqual(x["demo"]["from"]["position"], TABLE["position"])

    def test_rotate_demo_turns_about_vertical(self):
        r = lessons.build("rotate", TABLE, angle=90)
        q = r["demo"]["to"]["rotation"]
        self.assertAlmostEqual(q[1], math.sqrt(0.5), places=6)
        self.assertAlmostEqual(q[3], math.sqrt(0.5), places=6)
        self.assertIn("90°", r["text"])

    def test_scale_demo_keeps_round_kinds_round(self):
        s = lessons.build("scale", TABLE, axis="Z", factor=1.2)
        self.assertEqual(s["demo"]["to"]["dimensions"], [1.2, 0.9, 0.8])
        self.assertIn("taller", s["text"])
        p = lessons.build("scale", PILLAR, axis="X", factor=2)
        self.assertEqual(p["demo"]["to"]["dimensions"], [0.6, 2.4, 0.6])

    def test_prompts_without_demo(self):
        scan = lessons.build("scan")
        self.assertIsNone(scan["demo"])
        self.assertIn("Scan the whole room", scan["text"])
        place = lessons.build("place", kind="couch")
        self.assertEqual(place["kind"], "couch")
        self.assertIn("couch", place["text"])
        self.assertEqual(lessons.build("custom", text="  Look at the corner ")["text"], "Look at the corner")
        self.assertEqual(lessons.build("scan", text="Scan near the window")["text"], "Scan near the window")

    def test_refuses_incomplete_prompts(self):
        with self.assertRaises(ValueError):
            lessons.build("move", None)
        with self.assertRaises(ValueError):
            lessons.build("custom", text="   ")
        with self.assertRaises(ValueError):
            lessons.build("dance")


if __name__ == "__main__":
    unittest.main()
