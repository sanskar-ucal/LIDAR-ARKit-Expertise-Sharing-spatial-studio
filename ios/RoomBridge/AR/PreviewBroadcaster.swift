import RealityKit
import RoomBridgeCore
import UIKit

/// Low-frame-rate live preview: periodically snapshots the composited AR view (camera
/// image plus virtual objects), downscales, JPEG-encodes off the main thread and sends
/// the latest frame. One capture in flight at a time; if the network is slow we simply
/// skip frames instead of queueing them. Nothing is recorded or saved.
@MainActor
final class PreviewBroadcaster {
    private weak var arView: ARView?
    private let channel: PreviewChannel
    private let synthetic: Bool
    private var timer: Timer?
    private var busy = false
    private var seq: UInt32 = 0
    private(set) var rate = PreviewRateController()
    private(set) var sentFrames = 0
    private(set) var skippedFrames = 0
    private(set) var lastCost: TimeInterval = 0
    private(set) var lastBytes = 0
    var trackingLimited = false
    var isRunning: Bool { timer != nil }
    var onRateChange: ((Double, Int) -> Void)?
    private static let encodeQueue = DispatchQueue(label: "roombridge.preview.encode", qos: .userInitiated)

    init(arView: ARView, channel: PreviewChannel, synthetic: Bool) {
        self.arView = arView
        self.channel = channel
        self.synthetic = synthetic
    }

    func start() {
        guard timer == nil else { return }
        schedule()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func schedule() {
        timer?.invalidate()
        let t = Timer(timeInterval: rate.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func tick() {
        guard let arView, !busy else {
            skippedFrames += 1
            return
        }
        guard channel.isReady else {
            skippedFrames += 1
            return
        }
        busy = true
        let started = CACurrentMediaTime()
        let width = CGFloat(rate.width)
        let orientation = Self.orientation(of: arView)
        let captureMs = Date().timeIntervalSince1970 * 1000
        seq &+= 1
        let frameSeq = seq
        let flagsSynthetic = synthetic
        let flagsLimited = trackingLimited
        arView.snapshot(saveToHDR: false) { [weak self] image in
            guard let image else {
                Task { @MainActor in self?.busy = false }
                return
            }
            Self.encodeQueue.async {
                let encoded = Self.encode(image, width: width)
                Task { @MainActor in
                    guard let self else { return }
                    guard let (jpeg, size) = encoded else {
                        self.busy = false
                        return
                    }
                    let header = PreviewFrameHeader(
                        orientation: orientation, synthetic: flagsSynthetic, trackingLimited: flagsLimited,
                        seq: frameSeq, width: UInt16(size.width), height: UInt16(size.height), captureTimeMs: captureMs)
                    let frame = header.encode(jpeg: jpeg)
                    self.channel.send(frame: frame) { ok in
                        self.busy = false
                        let cost = CACurrentMediaTime() - started
                        self.lastCost = cost
                        if ok {
                            self.sentFrames += 1
                            self.lastBytes = frame.count
                        }
                        self.adapt(cost: cost)
                    }
                }
            }
        }
    }

    private func adapt(cost: TimeInterval) {
        let before = (rate.fps, rate.width)
        let thermal: Int
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: thermal = 0
        case .fair: thermal = 1
        case .serious: thermal = 2
        case .critical: thermal = 3
        @unknown default: thermal = 1
        }
        rate.record(frameCost: cost, thermalLevel: thermal, viewers: channel.viewers)
        if before.0 != rate.fps || before.1 != rate.width {
            if timer != nil { schedule() }
            onRateChange?(rate.fps, rate.width)
        }
    }

    nonisolated private static func encode(_ image: UIImage, width: CGFloat) -> (Data, CGSize)? {
        let src = image.size
        guard src.width > 0, src.height > 0 else { return nil }
        let scale = min(1, width / src.width)
        let size = CGSize(width: (src.width * scale).rounded(), height: (src.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let jpeg = small.jpegData(compressionQuality: 0.5) else { return nil }
        return (jpeg, size)
    }

    private static func orientation(of view: UIView) -> PreviewFrameHeader.Orientation {
        // The snapshot is already in interface orientation; this tells viewers how the phone is held.
        switch view.window?.windowScene?.effectiveGeometry.interfaceOrientation ?? .portrait {
        case .portraitUpsideDown: return .portraitUpsideDown
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        default: return .portrait
        }
    }
}

@MainActor
enum Haptics {
    private static let success = UINotificationFeedbackGenerator()
    private static let tap = UIImpactFeedbackGenerator(style: .light)

    static func prepare() {
        success.prepare()
        tap.prepare()
    }

    /// One distinct pulse when the attempt enters the target tolerance.
    static func onTarget() {
        success.notificationOccurred(.success)
        success.prepare()
    }

    static func light() {
        tap.impactOccurred()
    }

    static func approved() {
        success.notificationOccurred(.success)
        success.prepare()
    }

    static func rejected() {
        success.notificationOccurred(.warning)
        success.prepare()
    }
}
