import Foundation
import simd

/// The phone *is* canonical space (ARKit world, Y-up, metres), so the app itself needs
/// no axis conversion. These functions exist to verify the shared fixtures and keep
/// the Swift side honest about the same contract Blender uses (COORDINATES.md).
public enum Coordinates {
    public static func canonicalToBlender(_ c: Vec3) -> Vec3 { Vec3(c.x, -c.z, c.y) }
    public static func blenderToCanonical(_ b: Vec3) -> Vec3 { Vec3(b.x, b.z, -b.y) }
    public static func quatCanonicalToBlender(_ q: Quat) -> Quat { Quat(q.x, -q.z, q.y, q.w) }
    public static func quatBlenderToCanonical(_ q: Quat) -> Quat { Quat(q.x, q.z, -q.y, q.w) }
    public static func dimensionsToBlenderScale(_ d: Vec3) -> Vec3 { Vec3(d.x, d.z, d.y) }

    /// Wire quaternion [x, y, z, w] -> simd.
    public static func simdQuat(_ q: Quat) -> simd_quatd { simd_quatd(ix: q.x, iy: q.y, iz: q.z, r: q.w) }
    public static func simdQuatf(_ q: Quat) -> simd_quatf {
        simd_quatf(ix: Float(q.x), iy: Float(q.y), iz: Float(q.z), r: Float(q.w)).normalized
    }

    public static func rotate(_ q: Quat, _ v: Vec3) -> Vec3 { simdQuat(q).act(v) }

    /// Mesh-anchor-local vertex -> canonical world. Applied exactly once, on the phone.
    public static func anchorToWorld(_ v: SIMD3<Float>, _ anchorTransform: simd_float4x4) -> SIMD3<Float> {
        let w = anchorTransform * SIMD4<Float>(v, 1)
        return SIMD3<Float>(w.x, w.y, w.z)
    }
}
