import json
import pathlib
import unittest

from roombridge import protocol, scan_format

ROOT = pathlib.Path(__file__).resolve().parents[2]
FX = json.loads((ROOT / "protocol/fixtures/messages.json").read_text())


class ProtocolFixtures(unittest.TestCase):
    def test_valid_object_payloads_pass_local_validation(self):
        for case in FX["validClient"]:
            m = case["message"]
            if m["type"] == "object.create":
                with self.subTest(case["name"]):
                    protocol.validate_object_input(m["payload"]["object"])

    def test_invalid_dimension_fixtures_are_refused_before_sending(self):
        for case in FX["invalidClient"]:
            m = case["message"]
            if m["type"] == "object.create":
                with self.subTest(case["name"]), self.assertRaises(protocol.ValidationError):
                    protocol.validate_object_input(m["payload"]["object"])

    def test_server_messages_decode(self):
        for case in FX["server"]:
            with self.subTest(case["name"]):
                protocol.validate_server_message(case["message"])

    def test_envelope_requires_epoch_for_geometry(self):
        with self.assertRaises(protocol.ValidationError):
            protocol.envelope("object.update", {}, "r", "c")
        env = protocol.envelope("object.update", {}, "r", "c", origin_epoch=3)
        self.assertEqual(env["originEpoch"], 3)
        self.assertEqual(env["protocolVersion"], 1)

    def test_parse_invite(self):
        p = protocol.parse_invite("http://10.0.0.61:8787/r/K7M3QX#t=abcDEF123_-xyz")
        self.assertEqual(p, {"server": "http://10.0.0.61:8787", "code": "K7M3QX", "token": "abcDEF123_-xyz"})
        self.assertIsNone(protocol.parse_invite("http://10.0.0.61:8787/r/K7M3QX"))


class ScanFormat(unittest.TestCase):
    def test_round_trip_and_conversion(self):
        verts = [(-0.5, 0.0, -1.5), (0.5, 0.0, -1.5), (0.5, 0.0, -0.5)]
        buf = scan_format.encode(2, verts, [(0, 2, 1)], synthetic=True)
        scan = scan_format.decode(buf)
        self.assertEqual(scan.origin_epoch, 2)
        self.assertTrue(scan.synthetic)
        self.assertEqual(scan.triangles, [(0, 2, 1)])
        # Floor at canonical y=0 lands on Blender z=0; "in front" (-Z) becomes +Y.
        b = scan_format.to_blender(scan)
        self.assertEqual(b[0], (-0.5, 1.5, 0.0))

    def test_shared_sample_room_fixture(self):
        # Same bytes the iPhone's Swift encoder produces for the synthetic sample room.
        scan = scan_format.decode((ROOT / "protocol/fixtures/sample-room.rbsc").read_bytes())
        self.assertTrue(scan.synthetic)
        self.assertEqual((scan.origin_epoch, len(scan.vertices), len(scan.triangles)), (1, 12, 6))
        b = scan_format.to_blender(scan)
        # Back wall at canonical z = -3 is 3 m in front: Blender +Y, standing up along +Z.
        self.assertEqual(b[6], (2.0, 3.0, 2.5))
        self.assertTrue(all(z >= 0 for _, _, z in b))

    def test_rejects_bad_scans(self):
        good = scan_format.encode(1, [(0, 0, 0)] * 3, [(0, 1, 2)])
        with self.assertRaises(ValueError):
            scan_format.decode(good[:-4])
        with self.assertRaises(ValueError):
            scan_format.decode(scan_format.encode(1, [(0, 0, 0)] * 3, [(0, 1, 5)]))


if __name__ == "__main__":
    unittest.main()
