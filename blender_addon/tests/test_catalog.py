import json
import pathlib
import unittest

from roombridge import catalog, protocol

ROOT = pathlib.Path(__file__).resolve().parents[2]


class Catalog(unittest.TestCase):
    def test_reads_the_shared_catalog(self):
        shared = json.loads((ROOT / "protocol/catalog.json").read_text())
        self.assertEqual(catalog.DATA, shared)
        self.assertEqual(protocol.KINDS, tuple(k["kind"] for k in shared["kinds"]))
        self.assertIn("couch", protocol.KINDS)

    def test_round_kinds_must_stay_round(self):
        self.assertEqual(catalog.ROUND_KINDS, {"pillar", "lamp"})
        with self.assertRaises(protocol.ValidationError):
            protocol.validate_dimensions("lamp", [0.4, 1.6, 0.5])
        protocol.validate_dimensions("table", [1.2, 0.75, 0.8])

    def test_tints(self):
        self.assertEqual(catalog.tint_order("table"), ["base", "dark"])
        self.assertEqual(catalog.tint_order("door"), ["base", "dark", "#c9a227"])
        self.assertEqual(catalog.tint_hex("dark", "#a0764f"), "#58412b")
        self.assertEqual(catalog.tint_hex("light", "#000000"), "#808080")
        self.assertEqual(catalog.tint_hex("#123456", "#ffffff"), "#123456")

    def test_groups_keep_catalog_order(self):
        names = [g for g, _ in catalog.groups()]
        self.assertEqual(names, ["Structure", "Furniture", "Lighting & decor", "Custom"])
        self.assertEqual(sum(len(ks) for _, ks in catalog.groups()), len(catalog.KINDS))


if __name__ == "__main__":
    unittest.main()
