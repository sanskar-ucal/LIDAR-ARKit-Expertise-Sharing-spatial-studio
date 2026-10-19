import Foundation

/// The CAD skills RoomBridge teaches by narrating every edit in Blender terms.
public enum CADConcept: String, Codable, Sendable, CaseIterable {
    case add, move, axis, rotate, scale, delete, approve

    public var title: String {
        switch self {
        case .add: return "Adding objects"
        case .move: return "Moving (Grab)"
        case .axis: return "Locking to an axis"
        case .rotate: return "Rotating"
        case .scale: return "Scaling"
        case .delete: return "Deleting"
        case .approve: return "Expert review"
        }
    }

    /// One-line explanation shown the first time the novice meets the concept.
    public var tip: String {
        switch self {
        case .add: return "In Blender, Shift+A adds a new object at the 3D cursor."
        case .move: return "G (grab) moves the selected object; type a number to move an exact distance."
        case .axis: return "After G, press X, Y or Z to lock the move to the red, green or blue axis."
        case .rotate: return "R rotates; R Z spins an object around the vertical (blue) axis."
        case .scale: return "S scales; S X/Y/Z stretches one axis, Shift+Z scales everything except height."
        case .delete: return "X deletes the selected object."
        case .approve: return "Experts review a design before it is final, just like your proposals."
        }
    }
}

public struct NarrationStep: Equatable, Sendable {
    public var concept: CADConcept
    public var text: String
    public var shortcut: String
    public init(concept: CADConcept, text: String, shortcut: String) {
        self.concept = concept
        self.text = text
        self.shortcut = shortcut
    }
}

/// Explains a change between two object states in Blender terms (protocol/fixtures/narration.json).
/// Blender X = canonical x, Blender Y = canonical -z, Blender Z = canonical y (COORDINATES.md).
public enum Narrator {
    static let axisNames = ["X", "Y", "Z"]
    static let axisColors = ["red", "green", "blue"]
    static let axisDirections = ["left/right", "forward/back", "up/down"]
    static let sizeNames = ["width", "depth", "height"]

    public static func describe(name: String, before: ObjectPose, after: ObjectPose) -> [NarrationStep] {
        var steps: [NarrationStep] = []
        if let s = move(name, before.position, after.position) { steps.append(s) }
        if let s = rotate(name, before.rotation, after.rotation) { steps.append(s) }
        if let s = resize(name, before.dimensions, after.dimensions) { steps.append(s) }
        return steps
    }

    public static func added(name: String, blender: String) -> NarrationStep {
        NarrationStep(concept: .add, text: "added \(name)", shortcut: blender)
    }

    public static func deleted(name: String) -> NarrationStep {
        NarrationStep(concept: .delete, text: "deleted \(name)", shortcut: "X › Delete")
    }

    static func toBlender(_ v: Vec3) -> [Double] { [v.x, -v.z, v.y] }

    static func move(_ name: String, _ a: Vec3, _ b: Vec3) -> NarrationStep? {
        let d = b - a
        let mag = (d * d).sum().squareRoot()
        guard mag >= 0.01 else { return nil }
        let bl = toBlender(d)
        let biggest = bl.indices.max { abs(bl[$0]) < abs(bl[$1]) }!
        if abs(bl[biggest]) >= 0.9 * mag {
            return NarrationStep(
                concept: .axis,
                text: "moved \(name) \(length(abs(bl[biggest]))) along the \(axisColors[biggest]) \(axisNames[biggest]) axis (\(axisDirections[biggest]))",
                shortcut: "G \(axisNames[biggest]) \(num(bl[biggest]))")
        }
        let parts = bl.indices.filter { abs(bl[$0]) >= 0.01 }.map { "G \(axisNames[$0]) \(num(bl[$0]))" }
        return NarrationStep(concept: .move, text: "moved \(name) \(length(mag))", shortcut: parts.joined(separator: " · "))
    }

    /// Heading about the vertical axis, degrees. Canonical +Y and Blender +Z turn the same way.
    public static func yawDegrees(_ q: Quat) -> Double {
        atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)) * 180 / .pi
    }

    static func rotate(_ name: String, _ a: Quat, _ b: Quat) -> NarrationStep? {
        var delta = yawDegrees(b) - yawDegrees(a)
        while delta > 180 { delta -= 360 }
        while delta <= -180 { delta += 360 }
        guard abs(delta) >= 2 else { return nil }
        let r = Int(delta.rounded())
        return NarrationStep(concept: .rotate, text: "turned \(name) \(abs(r))°", shortcut: "R Z \(r)")
    }

    static func resize(_ name: String, _ a: Vec3, _ b: Vec3) -> NarrationStep? {
        // Blender X, Y, Z sizes are canonical width, depth, height.
        let before = [a.x, a.z, a.y]
        let after = [b.x, b.z, b.y]
        let ratio = before.indices.map { after[$0] / before[$0] }
        let changed = before.indices.filter { abs(ratio[$0] - 1) >= 0.01 && abs(after[$0] - before[$0]) >= 0.005 }
        guard !changed.isEmpty else { return nil }
        if changed.count == 3, ratio.max()! - ratio.min()! < 0.01 {
            return NarrationStep(concept: .scale, text: "scaled \(name) to \(Int((ratio[0] * 100).rounded()))%", shortcut: "S \(num(ratio[0]))")
        }
        let text = "resized \(name): " + changed.map { "\(sizeNames[$0]) \(m2(before[$0])) → \(m2(after[$0])) m" }.joined(separator: ", ")
        if changed == [0, 1], abs(ratio[0] - ratio[1]) < 0.01 {
            return NarrationStep(concept: .scale, text: text, shortcut: "S Shift+Z \(num(ratio[0]))")
        }
        return NarrationStep(concept: .scale, text: text, shortcut: changed.map { "S \(axisNames[$0]) \(num(ratio[$0]))" }.joined(separator: " · "))
    }

    /// A typed Blender value: at most two decimals, no trailing zeros.
    public static func num(_ v: Double) -> String {
        var s = String(format: "%.2f", v)
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return s == "-0" ? "0" : s
    }

    public static func length(_ m: Double) -> String {
        m < 1 ? "\(Int((m * 100).rounded())) cm" : String(format: "%.2f m", m)
    }

    static func m2(_ v: Double) -> String { String(format: "%.2f", v) }
}

/// Collects a stream of edits (Blender sends a drag as many small updates) and narrates each
/// gesture once the object has rested for `settle` seconds.
public struct EditNarrationBuffer: Sendable {
    public struct Gesture: Equatable, Sendable {
        public var objectId: String
        public var actor: String
        public var name: String
        public var steps: [NarrationStep]
    }

    struct Pending: Sendable {
        var actor: String
        var name: String
        var start: ObjectPose
        var latest: ObjectPose
        var lastChange: Double
    }

    var pending: [String: Pending] = [:]
    public var settle: Double

    public init(settle: Double = 0.8) { self.settle = settle }

    public mutating func record(objectId: String, actor: String, name: String, from previous: ObjectPose, to current: ObjectPose, now: Double) {
        if var p = pending[objectId], p.actor == actor {
            p.latest = current
            p.name = name
            p.lastChange = now
            pending[objectId] = p
        } else {
            pending[objectId] = Pending(actor: actor, name: name, start: previous, latest: current, lastChange: now)
        }
    }

    public mutating func drop(_ objectId: String) { pending[objectId] = nil }

    /// Gestures that have settled (or all of them with `force`), with their narration.
    public mutating func flush(now: Double, force: Bool = false) -> [Gesture] {
        var out: [Gesture] = []
        for (id, p) in pending where force || now - p.lastChange >= settle {
            pending[id] = nil
            let steps = Narrator.describe(name: p.name, before: p.start, after: p.latest)
            if !steps.isEmpty { out.append(Gesture(objectId: id, actor: p.actor, name: p.name, steps: steps)) }
        }
        return out.sorted { $0.objectId < $1.objectId }
    }
}
