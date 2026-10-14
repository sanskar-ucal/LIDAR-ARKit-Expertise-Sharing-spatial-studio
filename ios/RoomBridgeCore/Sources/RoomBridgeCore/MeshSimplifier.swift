import Foundation

/// Bounded room-proxy simplification by vertex clustering: vertices are snapped to a
/// voxel grid and merged per cell (averaged), triangles are remapped, and degenerate or
/// duplicate triangles are dropped. Coarse but predictable; the result is explicitly an
/// approximation of the room.
public enum MeshSimplifier {
    public struct Result: Sendable {
        public var vertices: [SIMD3<Float>]
        public var indices: [UInt32]
        public var cellSize: Float
    }

    private struct Cell: Hashable { let x, y, z: Int32 }

    public static func cluster(vertices: [SIMD3<Float>], indices: [UInt32], cellSize: Float) -> Result {
        var cellIndex: [Cell: UInt32] = [:]
        cellIndex.reserveCapacity(vertices.count / 2)
        var sums: [SIMD3<Float>] = []
        var counts: [Float] = []
        var remap = [UInt32](repeating: 0, count: vertices.count)
        let inv = 1 / cellSize
        for (i, v) in vertices.enumerated() {
            let c = Cell(x: Int32((v.x * inv).rounded(.down)), y: Int32((v.y * inv).rounded(.down)), z: Int32((v.z * inv).rounded(.down)))
            if let idx = cellIndex[c] {
                sums[Int(idx)] += v
                counts[Int(idx)] += 1
                remap[i] = idx
            } else {
                let idx = UInt32(sums.count)
                cellIndex[c] = idx
                sums.append(v)
                counts.append(1)
                remap[i] = idx
            }
        }
        let outVerts = zip(sums, counts).map { $0 / $1 }
        var seen = Set<SIMD3<UInt32>>()
        var outIdx: [UInt32] = []
        outIdx.reserveCapacity(indices.count / 2)
        var t = 0
        while t + 2 < indices.count {
            let a = remap[Int(indices[t])], b = remap[Int(indices[t + 1])], c = remap[Int(indices[t + 2])]
            t += 3
            if a == b || b == c || a == c { continue }
            // Canonical rotation keeps winding while detecting duplicates.
            let key: SIMD3<UInt32>
            if a < b && a < c { key = SIMD3(a, b, c) } else if b < c { key = SIMD3(b, c, a) } else { key = SIMD3(c, a, b) }
            if !seen.insert(key).inserted { continue }
            outIdx.append(contentsOf: [a, b, c])
        }
        return Result(vertices: outVerts, indices: outIdx, cellSize: cellSize)
    }

    /// Picks the finest cell size from `cellSizes` that fits the budget. If nothing fits, returns
    /// the coarsest result truncated to the budget.
    public static func fit(vertices: [SIMD3<Float>], indices: [UInt32], maxVertices: Int, maxTriangles: Int,
                           cellSizes: [Float] = [0.02, 0.03, 0.05, 0.08, 0.12, 0.2]) -> Result {
        if vertices.count <= maxVertices && indices.count / 3 <= maxTriangles {
            return Result(vertices: vertices, indices: indices, cellSize: 0)
        }
        var last = Result(vertices: [], indices: [], cellSize: 0)
        for size in cellSizes {
            last = cluster(vertices: vertices, indices: indices, cellSize: size)
            if last.vertices.count <= maxVertices && last.indices.count / 3 <= maxTriangles { return last }
        }
        // Still too large: keep only triangles whose vertices are all within the vertex budget.
        var idx: [UInt32] = []
        var t = 0
        let limit = UInt32(maxVertices)
        while t + 2 < last.indices.count && idx.count / 3 < maxTriangles {
            let tri = last.indices[t..<t + 3]
            if tri.allSatisfy({ $0 < limit }) { idx.append(contentsOf: tri) }
            t += 3
        }
        return Result(vertices: Array(last.vertices.prefix(maxVertices)), indices: idx, cellSize: last.cellSize)
    }
}
