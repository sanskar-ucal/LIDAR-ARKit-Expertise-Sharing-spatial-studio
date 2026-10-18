import Foundation

/// The shared object catalog (protocol/catalog.json): how each kind is built from simple
/// parts, its default size and colour, where a novice places it, and its CAD lesson.
public struct Catalog: Decodable, Sendable {
    public struct Part: Decodable, Equatable, Sendable {
        public enum Shape: String, Decodable, Sendable { case box, cylinder, sphere }
        public var shape: Shape
        /// Centre and size in the unit box, canonical local axes (+Y up, +Z front).
        public var center: Vec3
        public var size: Vec3
        public var tint: String
    }

    public struct Kind: Decodable, Equatable, Sendable, Identifiable {
        public enum Origin: String, Decodable, Sendable { case bottom, center }
        public enum Mount: String, Decodable, Sendable { case floor, wall }
        public var kind: ObjectKind
        public var label: String
        public var group: String
        public var icon: String
        public var origin: Origin
        public var mount: Mount
        /// Default height of the origin above the floor.
        public var height: Double
        public var dimensions: Vec3
        public var color: String
        public var round: Bool
        public var parts: [Part]
        public var lesson: String
        public var blender: String
        public var id: ObjectKind { kind }

        /// Height of the top of the object above its origin.
        public func top(_ dimensions: Vec3) -> Double { origin == .center ? dimensions.y / 2 : dimensions.y }
    }

    public var version: Int
    public var kinds: [Kind]

    public static func decode(_ data: Data) throws -> Catalog {
        try JSONDecoder().decode(Catalog.self, from: data)
    }

    public func kind(_ k: ObjectKind) -> Kind? { kinds.first { $0.kind == k } }

    /// Kinds grouped in catalog order.
    public var groups: [(name: String, kinds: [Kind])] {
        var out: [(name: String, kinds: [Kind])] = []
        for k in kinds {
            if out.last?.name == k.group { out[out.count - 1].kinds.append(k) } else { out.append((k.group, [k])) }
        }
        return out
    }

    /// '#rrggbb' for a part tint: 'base', 'dark' (x 0.55), 'light' (halfway to white) or a fixed colour.
    public static func tintHex(_ tint: String, base: String) -> String {
        if tint.hasPrefix("#") { return tint }
        let h = base.hasPrefix("#") ? String(base.dropFirst()) : base
        guard h.count == 6, let v = Int(h, radix: 16) else { return base }
        var rgb = [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF].map(Double.init)
        switch tint {
        case "dark": rgb = rgb.map { ($0 * 0.55).rounded() }
        case "light": rgb = rgb.map { ($0 + (255 - $0) * 0.5).rounded() }
        default: break
        }
        return String(format: "#%02x%02x%02x", Int(rgb[0]), Int(rgb[1]), Int(rgb[2]))
    }
}
