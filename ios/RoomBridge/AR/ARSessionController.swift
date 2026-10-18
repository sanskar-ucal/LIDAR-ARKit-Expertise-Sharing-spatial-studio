import ARKit
import RealityKit
import RoomBridgeCore
import UIKit

struct ScanStats: Equatable {
    var meshAnchors = 0
    var vertices = 0
    var faces = 0
}

/// Owns the RealityKit ARView and the ARKit session. The phone renders all virtual
/// content locally against its own tracking, so network latency never affects the
/// smoothness of the AR view.
@MainActor
final class ARSessionController: NSObject, ARSessionDelegate {
    let arView: ARView
    let sampleMode: Bool
    let renderer: SceneRenderer
    private(set) var cameraTransform = matrix_identity_float4x4
    var onFrame: ((simd_float4x4) -> Void)?
    var onTracking: ((TrackingStatus) -> Void)?
    var onScanStats: ((ScanStats) -> Void)?
    private var lastStatsAt: TimeInterval = 0
    private var sampleCamera: PerspectiveCamera?

    static var supportsWorldTracking: Bool { ARWorldTrackingConfiguration.isSupported }
    static var supportsLiDARMesh: Bool { ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) }

    init(sampleMode: Bool) {
        self.sampleMode = sampleMode
        if sampleMode {
            arView = ARView(frame: .zero, cameraMode: .nonAR, automaticallyConfigureSession: false)
        } else {
            arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
        }
        renderer = SceneRenderer(arView: arView)
        super.init()
        if sampleMode {
            setUpSampleRoom()
        } else {
            arView.session.delegate = self
        }
    }

    private func makeConfiguration() -> ARWorldTrackingConfiguration {
        let c = ARWorldTrackingConfiguration()
        c.planeDetection = [.horizontal, .vertical]
        c.environmentTexturing = .automatic
        if Self.supportsLiDARMesh { c.sceneReconstruction = .mesh }
        return c
    }

    func start() {
        guard !sampleMode else {
            onTracking?(.simulated)
            return
        }
        arView.session.run(makeConfiguration())
        setScanVisualization(true)
    }

    /// Re-establishes the world origin. Callers must bump the room's origin epoch.
    func resetOrigin() {
        guard !sampleMode else { return }
        arView.session.run(makeConfiguration(), options: [.resetTracking, .removeExistingAnchors])
        setScanVisualization(true)
    }

    func pause() {
        if !sampleMode { arView.session.pause() }
    }

    func setScanVisualization(_ on: Bool) {
        guard !sampleMode else { return }
        if on { arView.debugOptions.insert(.showSceneUnderstanding) } else { arView.debugOptions.remove(.showSceneUnderstanding) }
    }

    func meshAnchors() -> [ARMeshAnchor] {
        arView.session.currentFrame?.anchors.compactMap { $0 as? ARMeshAnchor } ?? []
    }

    struct Placement {
        var position: Vec3
        var rotation: Quat
    }

    /// Where a new object would go if placed at the screen centre: on the floor, or against a
    /// wall facing out, always turned so its front faces the phone. Nil if no surface is found.
    func placement(for spec: Catalog.Kind, dimensions: Vec3) -> Placement? {
        let cam = SIMD3<Float>(cameraTransform.columns.3.x, cameraTransform.columns.3.y, cameraTransform.columns.3.z)
        if sampleMode {
            // The sample room has its floor at y = 0 and no tracking; place 1.8 m ahead of the camera.
            let fwd = -SIMD3<Float>(cameraTransform.columns.2.x, 0, cameraTransform.columns.2.z)
            let dir = simd_length(fwd) > 1e-3 ? simd_normalize(fwd) : SIMD3<Float>(0, 0, -1)
            var p = cam + dir * 1.8
            p.y = spec.origin == .center ? Float(spec.height) : 0
            return Placement(position: Vec3(p), rotation: Self.facing(from: p, toward: cam))
        }
        let center = CGPoint(x: arView.bounds.midX, y: arView.bounds.midY)
        let alignment: ARRaycastQuery.TargetAlignment = spec.mount == .wall ? .vertical : .horizontal
        guard let hit = arView.raycast(from: center, allowing: .estimatedPlane, alignment: alignment).first else { return nil }
        let t = hit.worldTransform
        let point = SIMD3<Float>(t.columns.3.x, t.columns.3.y, t.columns.3.z)
        if spec.mount == .floor {
            return Placement(position: Vec3(point), rotation: Self.facing(from: point, toward: cam))
        }
        // Wall: the hit's Y axis is the surface normal; make it point back toward the phone.
        var normal = SIMD3<Float>(t.columns.1.x, 0, t.columns.1.z)
        if simd_length(normal) < 0.5 { normal = SIMD3<Float>(cam.x - point.x, 0, cam.z - point.z) }
        normal = simd_normalize(normal)
        if simd_dot(normal, cam - point) < 0 { normal = -normal }
        var p = point + normal * Float(dimensions.z / 2)
        if spec.origin == .bottom { p.y = floorHeight(below: point) ?? (cam.y - 1.4) }  // doorways stand on the floor
        let yaw = atan2(normal.x, normal.z)
        return Placement(position: Vec3(p), rotation: Quat(0, Double(sin(yaw / 2)), 0, Double(cos(yaw / 2))))
    }

    /// Height of the floor under a point, from ARKit's plane estimate.
    private func floorHeight(below point: SIMD3<Float>) -> Float? {
        let query = ARRaycastQuery(origin: point + SIMD3<Float>(0, 0.05, 0), direction: SIMD3<Float>(0, -1, 0),
                                   allowing: .estimatedPlane, alignment: .horizontal)
        guard let hit = arView.session.raycast(query).first else { return nil }
        return hit.worldTransform.columns.3.y
    }

    /// Yaw-only rotation whose local +Z (the object's front) points from `p` toward `target`.
    private static func facing(from p: SIMD3<Float>, toward target: SIMD3<Float>) -> Quat {
        let yaw = atan2(target.x - p.x, target.z - p.z)
        return Quat(0, Double(sin(yaw / 2)), 0, Double(cos(yaw / 2)))
    }

    // MARK: ARSessionDelegate (ARKit calls these on the main queue)

    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let transform = frame.camera.transform
        let timestamp = frame.timestamp
        var stats: ScanStats?
        MainActor.assumeIsolated {
            if timestamp - lastStatsAt > 0.5 {
                lastStatsAt = timestamp
                var s = ScanStats()
                for case let mesh as ARMeshAnchor in frame.anchors {
                    s.meshAnchors += 1
                    s.vertices += mesh.geometry.vertices.count
                    s.faces += mesh.geometry.faces.count
                }
                stats = s
            }
            cameraTransform = transform
            onFrame?(transform)
            if let stats { onScanStats?(stats) }
        }
    }

    nonisolated func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        let status = TrackingStatus(camera.trackingState)
        MainActor.assumeIsolated { onTracking?(status) }
    }

    nonisolated func sessionWasInterrupted(_ session: ARSession) {
        MainActor.assumeIsolated { onTracking?(.interrupted) }
    }

    nonisolated func sessionInterruptionEnded(_ session: ARSession) {
        MainActor.assumeIsolated { onTracking?(.recovering) }
    }

    nonisolated func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { true }

    nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
        let message = error.localizedDescription
        MainActor.assumeIsolated { onTracking?(.failed(message)) }
    }

    // MARK: Sample room (simulator / no LiDAR)

    private func setUpSampleRoom() {
        arView.environment.background = .color(UIColor(red: 0.93, green: 0.91, blue: 0.87, alpha: 1))
        let anchor = AnchorEntity(world: .zero)
        let room = SampleRoom.mesh()
        var descriptor = MeshDescriptor(name: "sample-room")
        descriptor.positions = MeshBuffers.Positions(room.vertices)
        descriptor.primitives = .triangles(room.indices)
        if let mesh = try? MeshResource.generate(from: [descriptor]) {
            let material = SimpleMaterial(color: UIColor(white: 0.82, alpha: 1), roughness: 0.9, isMetallic: false)
            anchor.addChild(ModelEntity(mesh: mesh, materials: [material]))
        }
        let light = DirectionalLight()
        light.light.intensity = 2500
        light.look(at: [0, 0, -1.5], from: [1.5, 3, 1], relativeTo: nil)
        anchor.addChild(light)
        let camera = PerspectiveCamera()
        camera.look(at: [0, 0.9, -1.6], from: [0.4, 1.6, 1.4], relativeTo: nil)
        anchor.addChild(camera)
        sampleCamera = camera
        arView.scene.addAnchor(anchor)
        cameraTransform = camera.transformMatrix(relativeTo: nil)
    }
}

/// Converts ARKit mesh anchors to one canonical world-space triangle soup.
enum MeshCapture {
    static func collect(_ anchors: [ARMeshAnchor]) -> (vertices: [SIMD3<Float>], indices: [UInt32]) {
        var vertices: [SIMD3<Float>] = []
        var indices: [UInt32] = []
        for anchor in anchors {
            let geometry = anchor.geometry
            let source = geometry.vertices
            guard source.format == .float3 else { continue }
            let base = UInt32(vertices.count)
            let vptr = UnsafeRawPointer(source.buffer.contents())
            vertices.reserveCapacity(vertices.count + source.count)
            for i in 0..<source.count {
                let p = vptr.advanced(by: source.offset + source.stride * i)
                let local = SIMD3<Float>(p.load(as: Float.self), p.load(fromByteOffset: 4, as: Float.self), p.load(fromByteOffset: 8, as: Float.self))
                // Anchor-local -> world, exactly once.
                vertices.append(Coordinates.anchorToWorld(local, anchor.transform))
            }
            let faces = geometry.faces
            guard faces.indexCountPerPrimitive == 3 else { continue }
            let fptr = UnsafeRawPointer(faces.buffer.contents())
            let n = faces.count * 3
            indices.reserveCapacity(indices.count + n)
            for k in 0..<n {
                let idx: UInt32 = faces.bytesPerIndex == 4
                    ? fptr.load(fromByteOffset: k * 4, as: UInt32.self)
                    : UInt32(fptr.load(fromByteOffset: k * 2, as: UInt16.self))
                indices.append(base + idx)
            }
        }
        return (vertices, indices)
    }
}
