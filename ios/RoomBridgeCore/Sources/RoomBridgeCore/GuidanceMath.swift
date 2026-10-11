import Foundation
import simd

/// Hold-to-move along one world axis. On press we capture the camera position and the
/// attempt's current offset; while held, the offset changes by the camera's displacement
/// projected on the axis. Rotation of the phone and sideways motion have no effect, and
/// nothing moves after release.
public struct AxisDrag: Sendable {
    public let axis: GuidanceAxis
    public let startCamera: SIMD3<Float>
    public let startOffset: Double
    public static let maxOffset = 10.0

    public init(axis: GuidanceAxis, startCamera: SIMD3<Float>, startOffset: Double) {
        self.axis = axis
        self.startCamera = startCamera
        self.startOffset = startOffset
    }

    public func offset(camera: SIMD3<Float>) -> Double {
        let d = SIMD3<Double>(camera - startCamera)
        let o = startOffset + simd_dot(d, axis.unit)
        return min(max(o, -Self.maxOffset), Self.maxOffset)
    }
}

public enum GuidanceMath {
    public static func attemptPosition(_ g: Guidance, offset: Double) -> Vec3 {
        g.start.position + g.axis.unit * offset
    }

    public static func distanceToTarget(_ g: Guidance, offset: Double) -> Double {
        simd_distance(attemptPosition(g, offset: offset), g.target.position)
    }

    /// Signed remaining travel along the axis (positive = move in +axis direction).
    public static func remaining(_ g: Guidance, offset: Double) -> Double {
        g.targetOffset - offset
    }
}

/// Fires once when entering the tolerance; must leave by `exitFactor * tolerance` before it
/// can fire again, and never more often than `minInterval`. Prevents buzzing every frame.
public struct ToleranceGate: Sendable {
    public var tolerance: Double
    public var exitFactor: Double
    public var minInterval: TimeInterval
    public private(set) var inside = false
    private var lastFire: TimeInterval = -.infinity

    public init(tolerance: Double, exitFactor: Double = 1.5, minInterval: TimeInterval = 0.8) {
        self.tolerance = tolerance
        self.exitFactor = exitFactor
        self.minInterval = minInterval
    }

    /// Returns true when a haptic pulse should fire now.
    public mutating func update(distance: Double, now: TimeInterval) -> Bool {
        if inside {
            if distance > tolerance * exitFactor { inside = false }
            return false
        }
        guard distance <= tolerance else { return false }
        inside = true
        guard now - lastFire >= minInterval else { return false }
        lastFire = now
        return true
    }

    public mutating func reset() {
        inside = false
    }
}

/// Exponential backoff for reconnects: 0.5 s doubling to 8 s.
public struct Backoff: Sendable {
    public private(set) var next: TimeInterval = 0.5
    public init() {}
    public mutating func fail() -> TimeInterval {
        let d = next
        next = min(next * 2, 8)
        return d
    }
    public mutating func succeed() { next = 0.5 }
}

/// Adapts preview frame rate and width to measured capture+send cost and thermal state.
/// Initial values (5 fps, 640 px) are tuning defaults, not promises.
public struct PreviewRateController: Sendable {
    public private(set) var fps: Double
    public private(set) var width: Int
    public let maxFps: Double
    public let minFps: Double = 1
    public let maxWidth: Int
    public let minWidth: Int = 320
    private var goodStreak = 0

    public init(fps: Double = 5, width: Int = 640, maxFps: Double = 8, maxWidth: Int = 640) {
        self.fps = fps
        self.width = width
        self.maxFps = maxFps
        self.maxWidth = maxWidth
    }

    public var interval: TimeInterval { 1 / fps }

    /// - Parameters:
    ///   - frameCost: seconds from capture start until the send completed.
    ///   - thermalLevel: 0 nominal, 1 fair, 2 serious, 3 critical.
    public mutating func record(frameCost: TimeInterval, thermalLevel: Int, viewers: Int) {
        if thermalLevel >= 2 || frameCost > interval * 1.2 {
            goodStreak = 0
            if fps > 2 { fps = max(minFps, fps - 1) } else if width > minWidth { width = max(minWidth, width - 160) } else { fps = minFps }
            return
        }
        if viewers == 0 {
            fps = minFps  // keep a fresh frame for late joiners, but cheaply
            return
        }
        goodStreak += 1
        if goodStreak >= 20 && frameCost < interval * 0.5 && thermalLevel == 0 {
            goodStreak = 0
            if width < maxWidth { width = min(maxWidth, width + 160) } else if fps < maxFps { fps += 1 }
        }
        if fps < 2 && viewers > 0 { fps = 2 }
    }
}
