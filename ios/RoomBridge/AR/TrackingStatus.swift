import ARKit

enum TrackingStatus: Equatable {
    case notAvailable
    case initializing
    case normal
    case limited(String)
    case interrupted
    case recovering
    case failed(String)
    case simulated

    init(_ state: ARCamera.TrackingState) {
        switch state {
        case .notAvailable: self = .notAvailable
        case .normal: self = .normal
        case .limited(let reason):
            switch reason {
            case .initializing: self = .initializing
            case .relocalizing: self = .recovering
            case .excessiveMotion: self = .limited("Moving too fast. Slow down.")
            case .insufficientFeatures: self = .limited("Not enough detail. Add light or aim at textured surfaces.")
            @unknown default: self = .limited("Tracking is limited.")
            }
        @unknown default: self = .limited("Tracking is limited.")
        }
    }

    /// Whether physical phone motion can be trusted for manipulation.
    var allowsManipulation: Bool { self == .normal }

    var title: String {
        switch self {
        case .notAvailable: return "AR not available"
        case .initializing: return "Starting AR… move the phone slowly"
        case .normal: return "Tracking normally"
        case .limited(let why): return "Tracking limited: \(why)"
        case .interrupted: return "AR interrupted"
        case .recovering: return "Recovering tracking… return to where you were"
        case .failed(let why): return "AR failed: \(why)"
        case .simulated: return "SAMPLE ROOM (simulated, no camera)"
        }
    }

    var isProblem: Bool {
        switch self {
        case .normal, .simulated: return false
        default: return true
        }
    }
}
