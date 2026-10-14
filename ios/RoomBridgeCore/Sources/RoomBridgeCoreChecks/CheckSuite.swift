import Foundation
import RoomBridgeCore
import simd

/// Fixture-driven checks of the Swift core against protocol/fixtures. Shared by the
/// `rbcore-checks` executable (Command Line Tools) and the XCTest target (Xcode).
public final class CheckSuite {
    public private(set) var passed = 0
    public private(set) var failures: [String] = []
    private let fixturesDir: URL

    public init(fixturesDir: URL) {
        self.fixturesDir = fixturesDir
    }

    public static func locateFixtures(from file: String = #filePath) -> URL {
        // ios/RoomBridgeCore/Sources/RoomBridgeCoreChecks/CheckSuite.swift -> repo root
        var url = URL(fileURLWithPath: file)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("protocol/fixtures")
    }

    private func check(_ cond: Bool, _ name: String) {
        if cond { passed += 1 } else { failures.append(name) }
    }

    private func close(_ a: [Double], _ b: [Double], _ name: String, tol: Double = 1e-6) {
        check(a.count == b.count && zip(a, b).allSatisfy { abs($0 - $1) <= tol }, "\(name): \(a) != \(b)")
    }

    private func json(_ name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: fixturesDir.appendingPathComponent(name))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    private func v3(_ a: Any?) -> Vec3 { let d = a as! [Double]; return Vec3(d[0], d[1], d[2]) }
    private func q4(_ a: Any?) -> Quat { let d = a as! [Double]; return Quat(d[0], d[1], d[2], d[3]) }
    private func arr(_ v: Vec3) -> [Double] { [v.x, v.y, v.z] }
    private func arr(_ q: Quat) -> [Double] { [q.x, q.y, q.z, q.w] }

    public func runAll() throws {
        try coordinates()
        try messages()
        frames()
        scan()
        guidance()
        simplifier()
    }

    func coordinates() throws {
        let fx = try json("coordinates.json")
        for p in fx["points"] as! [[String: Any]] {
            let name = p["name"] as! String
            close(arr(Coordinates.canonicalToBlender(v3(p["canonical"]))), p["blender"] as! [Double], "point \(name) c2b")
            close(arr(Coordinates.blenderToCanonical(v3(p["blender"]))), p["canonical"] as! [Double], "point \(name) b2c")
        }
        for r in fx["rotations"] as! [[String: Any]] {
            let name = r["name"] as! String
            close(arr(Coordinates.quatCanonicalToBlender(q4(r["canonical"]))), r["blender"] as! [Double], "rotation \(name)")
            close(arr(Coordinates.rotate(q4(r["canonical"]), Vec3(1, 0, 0))), r["rotatesCanonicalX"] as! [Double], "rotation \(name) acts")
        }
        for o in fx["objects"] as! [[String: Any]] {
            let obj = o["object"] as! [String: Any]
            let b = o["blender"] as! [String: Any]
            let name = o["name"] as! String
            close(arr(Coordinates.canonicalToBlender(v3(obj["position"]))), b["location"] as! [Double], "object \(name) location")
            close(arr(Coordinates.dimensionsToBlenderScale(v3(obj["dimensions"]))), b["scale"] as! [Double], "object \(name) scale")
            if let n = o["canonicalFaceNormal"] {
                close(arr(Coordinates.rotate(q4(obj["rotation"]), Vec3(0, 0, 1))), n as! [Double], "object \(name) face normal")
            }
        }
        let rt = fx["roundTrip"] as! [String: Any]
        let p = v3(rt["canonicalPosition"])
        let q = q4(rt["canonicalRotation"])
        close(arr(Coordinates.blenderToCanonical(Coordinates.canonicalToBlender(p))), arr(p), "round trip position")
        close(arr(Coordinates.quatBlenderToCanonical(Coordinates.quatCanonicalToBlender(q))), arr(q), "round trip rotation")
        // Anchor transform applied exactly once.
        var t = matrix_identity_float4x4
        t.columns.3 = SIMD4<Float>(1, 0, -2, 1)
        let w = Coordinates.anchorToWorld(SIMD3<Float>(0.5, 0, 0), t)
        close([Double(w.x), Double(w.y), Double(w.z)], [1.5, 0, -2], "anchor-local vertex to world")
    }

    func messages() throws {
        let fx = try json("messages.json")
        for s in fx["server"] as! [[String: Any]] {
            let data = try JSONSerialization.data(withJSONObject: s["message"]!)
            do {
                let (h, ev) = try ServerMessageDecoder.decode(data)
                switch (h.type, ev) {
                case ("object.updated", .objectUpserted(let o)):
                    check(o.kind == .pillar && o.revision == 2 && o.position == Vec3(1.2, 0, -1), "decode object.updated fields")
                case ("guidance.state", .guidance(let g?)):
                    check(g.axis == .x && g.attempt?.withinTolerance == true, "decode guidance.state fields")
                    check(abs(g.targetOffset - 0.4) < 1e-9, "guidance target offset")
                default:
                    check(false, "unexpected decode for \(s["name"]!)")
                }
            } catch {
                check(false, "decode \(s["name"]!): \(error)")
            }
        }
        // Wrong protocol version is refused.
        let bad = #"{"protocolVersion":2,"type":"pong","roomId":"","clientId":"","messageId":"x","payload":{}}"#
        check((try? ServerMessageDecoder.decode(Data(bad.utf8))) == nil, "reject protocol v2")
        // Outgoing envelope shape matches the shared fixture for guidance.attempt.
        let fixture = (fx["validClient"] as! [[String: Any]]).first { ($0["name"] as! String) == "guidance.attempt" }!["message"] as! [String: Any]
        let (_, data) = try MessageEncoder.encode(
            type: "guidance.attempt", payload: AttemptPayload(guidanceId: "g_abc", offset: 0.37, seq: 12, holding: true),
            roomId: "r_test", clientId: "c_host", originEpoch: 1, messageId: "m-6")
        let ours = try JSONSerialization.jsonObject(with: data) as! NSDictionary
        check(ours.isEqual(to: fixture), "encoded guidance.attempt equals fixture")
        let (_, sel) = try MessageEncoder.encode(type: "selection", payload: SelectionPayload(objectId: nil), roomId: "r", clientId: "c", originEpoch: 1)
        let selJSON = String(decoding: sel, as: UTF8.self)
        check(selJSON.contains(#""objectId":null"#), "selection encodes explicit null")
        check(!selJSON.contains("originEpoch"), "non-geometry messages omit originEpoch")
    }

    func frames() {
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 1, 0xFF, 0xD9])
        let h = PreviewFrameHeader(orientation: .landscapeRight, synthetic: true, trackingLimited: false, seq: 42, width: 640, height: 360, captureTimeMs: 1234.5)
        let d = h.encode(jpeg: jpeg)
        check(d.count == 24 + jpeg.count, "frame size")
        check(PreviewFrameHeader.decode(d) == h, "frame header round trip")
        check(d[24] == 0xFF && d[25] == 0xD8, "jpeg follows header")
        // Byte-for-byte against the shared fixture (also read by the server, web and Python tests).
        let fixture = try? Data(contentsOf: fixturesDir.appendingPathComponent("preview-frame.bin"))
        let expected = PreviewFrameHeader(orientation: .landscapeRight, synthetic: true, trackingLimited: true, seq: 42, width: 640, height: 360, captureTimeMs: 1234.5)
        check(fixture == expected.encode(jpeg: jpeg), "frame encoding equals preview-frame.bin")
    }

    func scan() {
        let room = SampleRoom.mesh()
        let d = ScanEncoding.encode(epoch: 3, vertices: room.vertices, indices: room.indices, synthetic: true)
        check(d.count == 20 + room.vertices.count * 12 + room.indices.count * 4, "scan size")
        check(Array(d.prefix(4)) == Array("RBSC".utf8), "scan magic")
        let fixture = try? Data(contentsOf: fixturesDir.appendingPathComponent("sample-room.rbsc"))
        let epoch1 = ScanEncoding.encode(epoch: 1, vertices: room.vertices, indices: room.indices, synthetic: true)
        check(fixture == epoch1, "sample room encoding equals sample-room.rbsc")
        let big = Data(count: ScanEncoding.chunkBytes * 2 + 10)
        let chunks = ScanEncoding.chunks(big)
        check(chunks.count == 3 && chunks.map(\.count).reduce(0, +) == big.count, "scan chunking")
    }

    func guidance() {
        let drag = AxisDrag(axis: .x, startCamera: SIMD3<Float>(0, 1.5, 0), startOffset: 0.1)
        check(abs(drag.offset(camera: SIMD3<Float>(0.25, 1.5, 0)) - 0.35) < 1e-6, "drag projects along axis")
        check(abs(drag.offset(camera: SIMD3<Float>(0, 2.5, -3)) - 0.1) < 1e-6, "perpendicular motion ignored")
        var gate = ToleranceGate(tolerance: 0.05)
        var pulses = 0
        let samples: [Double] = [0.3, 0.1, 0.049, 0.04, 0.06, 0.07, 0.03, 0.08, 0.04]
        for (i, d) in samples.enumerated() where gate.update(distance: d, now: Double(i)) { pulses += 1 }
        check(pulses == 2, "tolerance gate hysteresis (got \(pulses))")
        var fast = ToleranceGate(tolerance: 0.05)
        _ = fast.update(distance: 0.01, now: 0)
        _ = fast.update(distance: 0.2, now: 0.1)
        check(!fast.update(distance: 0.01, now: 0.2), "tolerance gate debounce")
        var rate = PreviewRateController()
        rate.record(frameCost: 0.5, thermalLevel: 0, viewers: 3)
        check(rate.fps < 5, "rate drops when frames are slow")
        var hot = PreviewRateController()
        hot.record(frameCost: 0.01, thermalLevel: 2, viewers: 3)
        check(hot.fps < 5, "rate drops when thermal state is serious")
        var b = Backoff()
        let delays = (0..<6).map { _ in b.fail() }
        check(delays == [0.5, 1, 2, 4, 8, 8], "backoff sequence")
    }

    func simplifier() {
        // Dense 1 m floor grid: 101 x 101 vertices.
        var v: [SIMD3<Float>] = []
        var idx: [UInt32] = []
        let n = 101
        for z in 0..<n { for x in 0..<n { v.append(SIMD3(Float(x) / 100, 0, -Float(z) / 100)) } }
        for z in 0..<(n - 1) {
            for x in 0..<(n - 1) {
                let a = UInt32(z * n + x), b = a + 1, c = a + UInt32(n), d = c + 1
                idx += [a, b, d, a, d, c]
            }
        }
        let r = MeshSimplifier.fit(vertices: v, indices: idx, maxVertices: 2000, maxTriangles: 4000)
        check(r.vertices.count <= 2000 && r.indices.count / 3 <= 4000, "simplifier respects budget")
        check(r.indices.allSatisfy { Int($0) < r.vertices.count }, "simplifier indices valid")
        let minX = r.vertices.map(\.x).min() ?? 0, maxX = r.vertices.map(\.x).max() ?? 0
        check(minX < 0.05 && maxX > 0.95, "simplifier preserves extent")
        check(r.vertices.allSatisfy { $0.y == 0 }, "simplifier keeps planar floor planar")
    }
}
