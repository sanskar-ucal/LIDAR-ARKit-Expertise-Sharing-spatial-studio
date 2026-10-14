import Foundation

/// Synthetic "sample room" for the simulator and devices without LiDAR. It is always
/// flagged as synthetic on the wire and labelled in every UI. Not a substitute for a scan.
public enum SampleRoom {
    /// Floor (4 x 4 m at y = 0) and two walls meeting in a corner 2 m in front of the origin.
    public static func mesh() -> (vertices: [SIMD3<Float>], indices: [UInt32]) {
        var v: [SIMD3<Float>] = []
        var i: [UInt32] = []
        func quad(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>, _ d: SIMD3<Float>) {
            let base = UInt32(v.count)
            v += [a, b, c, d]
            i += [base, base + 1, base + 2, base, base + 2, base + 3]
        }
        quad([-2, 0, 1], [2, 0, 1], [2, 0, -3], [-2, 0, -3])            // floor, facing up
        quad([-2, 0, -3], [2, 0, -3], [2, 2.5, -3], [-2, 2.5, -3])        // back wall, facing +Z
        quad([-2, 0, 1], [-2, 0, -3], [-2, 2.5, -3], [-2, 2.5, 1])        // left wall, facing +X
        return (v, i)
    }
}
