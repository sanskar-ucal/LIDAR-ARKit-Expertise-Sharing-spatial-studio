import Foundation

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ v: T) {
        var le = v.littleEndian
        Swift.withUnsafeBytes(of: &le) { append(contentsOf: $0) }
    }

    mutating func appendLE(_ v: Float) { appendLE(v.bitPattern) }
    mutating func appendLE(_ v: Double) { appendLE(v.bitPattern) }

    func readLE<T: FixedWidthInteger>(_: T.Type, at offset: Int) -> T {
        var v: T = 0
        _ = Swift.withUnsafeMutableBytes(of: &v) { copyBytes(to: $0, from: (startIndex + offset)..<(startIndex + offset + MemoryLayout<T>.size)) }
        return T(littleEndian: v)
    }
}

/// Preview frame: 24-byte little-endian header + JPEG (PROTOCOL.md, "Preview socket").
public struct PreviewFrameHeader: Equatable, Sendable {
    public enum Orientation: UInt8, Sendable { case portrait = 0, portraitUpsideDown = 1, landscapeLeft = 2, landscapeRight = 3 }
    public static let byteCount = 24
    public static let magic: [UInt8] = Array("RBPF".utf8)

    public var orientation: Orientation
    public var synthetic: Bool
    public var trackingLimited: Bool
    public var seq: UInt32
    public var width: UInt16
    public var height: UInt16
    public var captureTimeMs: Double

    public init(orientation: Orientation, synthetic: Bool, trackingLimited: Bool, seq: UInt32, width: UInt16, height: UInt16, captureTimeMs: Double) {
        self.orientation = orientation
        self.synthetic = synthetic
        self.trackingLimited = trackingLimited
        self.seq = seq
        self.width = width
        self.height = height
        self.captureTimeMs = captureTimeMs
    }

    public func encode(jpeg: Data) -> Data {
        var d = Data(capacity: Self.byteCount + jpeg.count)
        d.append(contentsOf: Self.magic)
        d.append(1)
        d.append(orientation.rawValue)
        d.appendLE(UInt16((synthetic ? 1 : 0) | (trackingLimited ? 2 : 0)))
        d.appendLE(seq)
        d.appendLE(width)
        d.appendLE(height)
        d.appendLE(captureTimeMs)
        d.append(jpeg)
        return d
    }

    public static func decode(_ d: Data) -> PreviewFrameHeader? {
        guard d.count > byteCount + 2, Array(d.prefix(4)) == magic, d[d.startIndex + 4] == 1,
              let o = Orientation(rawValue: d[d.startIndex + 5]) else { return nil }
        let flags = d.readLE(UInt16.self, at: 6)
        return PreviewFrameHeader(
            orientation: o, synthetic: flags & 1 != 0, trackingLimited: flags & 2 != 0,
            seq: d.readLE(UInt32.self, at: 8), width: d.readLE(UInt16.self, at: 12), height: d.readLE(UInt16.self, at: 14),
            captureTimeMs: Double(bitPattern: d.readLE(UInt64.self, at: 16)))
    }
}

/// RBSC room scan: canonical world-space vertices (anchor transforms already applied).
public enum ScanEncoding {
    public static let headerBytes = 20
    public static let maxVertices = 200_000
    public static let maxTriangles = 400_000
    public static let chunkBytes = 256 * 1024

    public static func encode(epoch: Int, vertices: [SIMD3<Float>], indices: [UInt32], synthetic: Bool) -> Data {
        precondition(indices.count % 3 == 0)
        var d = Data(capacity: headerBytes + vertices.count * 12 + indices.count * 4)
        d.append(contentsOf: Array("RBSC".utf8))
        d.appendLE(UInt16(1))
        d.appendLE(UInt16(synthetic ? 1 : 0))
        d.appendLE(UInt32(epoch))
        d.appendLE(UInt32(vertices.count))
        d.appendLE(UInt32(indices.count / 3))
        for v in vertices {
            d.appendLE(v.x)
            d.appendLE(v.y)
            d.appendLE(v.z)
        }
        for i in indices { d.appendLE(i) }
        return d
    }

    public static func chunks(_ d: Data) -> [Data] {
        stride(from: 0, to: d.count, by: chunkBytes).map { d.subdata(in: $0..<min($0 + chunkBytes, d.count)) }
    }
}
