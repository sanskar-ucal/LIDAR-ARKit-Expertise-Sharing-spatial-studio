import unittest

from roombridge.tracker import SETTLE_DELAY, STREAM_INTERVAL, SyncTracker


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


def state(x=0.0, name="Partition 1"):
    return {"name": name, "position": [x, 0, -2], "rotation": [0, 0, 0, 1], "dimensions": [1, 2, 0.1],
            "color": "#d8cfc0", "textureRef": None}


def server(oid, rev, **kw):
    return {"id": oid, "kind": "partition", "revision": rev, "originEpoch": 1, "stale": False, **state(**kw)}


class TrackerTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.t = SyncTracker(self.clock)

    def test_create_then_coalesced_updates_one_in_flight(self):
        self.t.track_new("a", "partition", state())
        due = self.t.due()
        self.assertEqual([d[1] for d in due], ["object.create"])
        self.t.mark_sent("a", "m1", "object.create")
        self.assertEqual(self.t.due(), [])  # create in flight
        self.t.on_server_object(server("a", 1), from_me=True)
        self.t.on_ack("m1")
        # Drag: many local changes; first goes out after STREAM_INTERVAL, others wait for the ack.
        for i in range(10):
            self.clock.t += 0.02
            self.t.local_state("a", state(x=0.1 * (i + 1)))
        self.clock.t += STREAM_INTERVAL
        due = self.t.due()
        self.assertEqual(len(due), 1)
        self.assertEqual(due[0][2]["baseRevision"], 1)
        self.t.mark_sent("a", "m2", "object.update")
        self.clock.t += 0.05
        self.t.local_state("a", state(x=2.0))
        self.assertEqual(self.t.due(), [])  # still in flight
        self.t.on_server_object(server("a", 2, x=1.0), from_me=True)
        self.t.on_ack("m2")
        self.clock.t += SETTLE_DELAY + 0.01
        due = self.t.due()
        self.assertEqual(due[0][2], {"id": "a", "baseRevision": 2, "patch": {"position": [2.0, 0, -2]}})

    def test_own_echo_is_not_reapplied_but_remote_change_is(self):
        self.t.reset_from_snapshot([server("a", 1)])
        self.assertFalse(self.t.on_server_object(server("a", 2, x=0.5), from_me=True))
        self.assertTrue(self.t.on_server_object(server("a", 3, x=0.9), from_me=False))
        self.assertFalse(self.t.on_server_object(server("a", 2, x=0.1), from_me=False))  # older revision

    def test_stale_revision_resends_newer_local_edit_with_fresh_base(self):
        self.t.reset_from_snapshot([server("a", 1)])
        self.t.local_state("a", state(x=0.3))
        self.clock.t += SETTLE_DELAY + 0.01
        (oid, kind, payload), = self.t.due()
        self.t.mark_sent(oid, "m1", kind)
        self.t.on_error("m1", "stale_revision", server("a", 5, x=0.8))
        self.clock.t += STREAM_INTERVAL
        (_, _, payload2), = self.t.due()
        self.assertEqual(payload2["baseRevision"], 5)
        self.assertEqual(payload2["patch"]["position"], [0.3, 0, -2])

    def test_snapshot_after_reconnect_resends_offline_edits_and_drops_deleted(self):
        self.t.reset_from_snapshot([server("a", 1), server("b", 1)])
        self.t.local_state("a", state(x=0.4))  # edited while offline
        self.t.track_new("c", "partition", state())  # created while offline
        to_apply, to_delete, resend = self.t.reset_from_snapshot([server("a", 1)])
        self.assertEqual(to_delete, ["b"])
        self.assertIn("a", resend)
        self.assertIn("c", resend)
        types = sorted(d[1] for d in (self.clock.__setattr__("t", self.clock.t + 1) or self.t.due()))
        self.assertEqual(types, ["object.create", "object.update"])

    def test_quaternion_sign_does_not_cause_echo(self):
        self.t.reset_from_snapshot([server("a", 1)])
        s = state()
        s["rotation"] = [0, 0, 0, -1]
        self.t.local_state("a", s)
        self.clock.t += 1
        self.assertEqual(self.t.due(), [])


if __name__ == "__main__":
    unittest.main()
