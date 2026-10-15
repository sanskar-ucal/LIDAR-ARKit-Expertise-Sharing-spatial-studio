import ARKit
import Observation
import RoomBridgeCore
import SwiftUI

/// The host (novice) side of a RoomBridge room. The phone is the coordinate authority:
/// it owns the AR world origin, the room scan, and the physical hold-to-move attempt.
/// The server owns the shared scene; we render whatever the latest snapshot says.
@MainActor
@Observable
final class AppModel {
    enum Phase { case start, room }

    enum ScanPhase: Equatable {
        case idle
        case processing
        case uploading(Double)
        case done(ScanMeta)
        case failed(String)
    }

    // MARK: Start screen
    var phase: Phase = .start
    var serverText: String = UserDefaults.standard.string(forKey: "serverURL") ?? "http://10.0.0.61:8787"
    var hostName: String = UserDefaults.standard.string(forKey: "hostName") ?? "Novice"
    var startError: String?
    var creating = false

    // MARK: Room
    private(set) var created: CreatedRoom?
    private(set) var sampleMode = false
    private(set) var connection: ControlChannel.State = .idle
    private(set) var clientId: String?
    private(set) var room: RoomInfo?
    private(set) var participants: [Participant] = []
    private(set) var objects: [SceneObject] = []
    private(set) var guidance: Guidance?
    private(set) var comments: [Comment] = []
    private(set) var reactions: [String: Reactions] = [:]
    private(set) var scan: ScanMeta?
    private(set) var previewStatus: PreviewStatus?
    private(set) var tracking: TrackingStatus = .initializing
    private(set) var scanStats = ScanStats()
    private(set) var scanPhase: ScanPhase = .idle
    private(set) var scanFrozen = false
    private(set) var broadcasting = false
    private(set) var awaitingOriginReset = false
    private(set) var lastError: String?
    var selectedObjectId: String?
    var showDeveloper = false

    // MARK: Guidance (local, immediate)
    private(set) var localOffset: Double = 0
    private(set) var holding = false
    private(set) var onTarget = false
    private(set) var attemptsSent = 0

    // MARK: Developer diagnostics
    private(set) var previewFps: Double = 0
    private(set) var previewWidth: Int = 0
    private(set) var previewSent = 0
    private(set) var previewSkipped = 0
    private(set) var previewViewers = 0
    private(set) var previewLastBytes = 0
    private(set) var previewLastCostMs = 0.0

    @ObservationIgnored private var api: RoomAPI?
    @ObservationIgnored private var control: ControlChannel?
    @ObservationIgnored private let preview = PreviewChannel()
    @ObservationIgnored private(set) var ar: ARSessionController?
    @ObservationIgnored private var broadcaster: PreviewBroadcaster?
    @ObservationIgnored private var previewTicket: String?
    @ObservationIgnored private var drag: AxisDrag?
    @ObservationIgnored private var gate = ToleranceGate(tolerance: 0.05)
    @ObservationIgnored private var attemptSeq = 0
    @ObservationIgnored private var lastAttemptSentAt: TimeInterval = 0
    @ObservationIgnored private var lastAttemptOffsetSent: Double = .nan
    @ObservationIgnored private var guidanceKey = ""
    @ObservationIgnored private var pendingOriginReset = false
    @ObservationIgnored private var resetFromEpoch = 0
    @ObservationIgnored private var diagTimer: Timer?

    static var deviceSupportsAR: Bool { ARSessionController.supportsWorldTracking }
    static var deviceHasLiDAR: Bool { ARSessionController.supportsLiDARMesh }

    var epoch: Int { room?.originEpoch ?? 1 }
    var isConnected: Bool { connection == .connected }
    var guidedObject: SceneObject? { guidance.flatMap { g in objects.first { $0.id == g.objectId } } }
    var selectedObject: SceneObject? { selectedObjectId.flatMap { id in objects.first { $0.id == id } } }
    var staleCount: Int { objects.filter(\.stale).count }
    var viewerLink: String? { created?.viewerLink }
    var expertLink: String? { created?.expertLink }
    var canManipulate: Bool {
        guard let g = guidance, g.state == .active, isConnected, !awaitingOriginReset else { return false }
        return sampleMode || tracking.allowsManipulation
    }

    // MARK: - Room lifecycle

    func createRoom(sample: Bool) async {
        startError = nil
        let name = hostName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            startError = "Enter your name so others know who is hosting."
            return
        }
        if !sample && !Self.deviceSupportsAR {
            startError = "This device can’t run AR world tracking. Use “Sample room” instead."
            return
        }
        do {
            let base = try RoomAPI.parseServerURL(serverText)
            UserDefaults.standard.set(base.absoluteString, forKey: "serverURL")
            UserDefaults.standard.set(name, forKey: "hostName")
            creating = true
            defer { creating = false }
            let api = RoomAPI(base: base)
            let created = try await api.createRoom(hostName: name)
            enter(created: created, api: api, sample: sample, name: name)
        } catch let e as APIError {
            startError = e.message
        } catch let e as URLError {
            startError = Self.explain(e)
        } catch {
            startError = error.localizedDescription
        }
    }

    static func explain(_ e: URLError) -> String {
        switch e.code {
        case .cannotConnectToHost, .cannotFindHost, .timedOut, .networkConnectionLost:
            return "Can’t reach the server. Check that it is running on your Mac, that the phone is on the same Wi-Fi, and that you used the Mac’s IP (not localhost). Also allow Local Network access for RoomBridge in Settings › Privacy."
        case .notConnectedToInternet:
            return "The phone is not on a network. Join the same Wi-Fi as the Mac."
        case .appTransportSecurityRequiresSecureConnection:
            return "iOS blocked plain HTTP for this address. Use the exact address the server prints on the Mac."
        default:
            return e.localizedDescription
        }
    }

    private func enter(created: CreatedRoom, api: RoomAPI, sample: Bool, name: String) {
        self.created = created
        self.api = api
        sampleMode = sample
        resetRoomState()
        let ar = ARSessionController(sampleMode: sample)
        ar.onFrame = { [weak self] t in self?.onFrame(t) }
        ar.onTracking = { [weak self] s in self?.onTracking(s) }
        ar.onScanStats = { [weak self] s in self?.scanStats = s }
        self.ar = ar
        let b = PreviewBroadcaster(arView: ar.arView, channel: preview, synthetic: sample)
        b.onRateChange = { [weak self] fps, width in self?.sendPreviewStatus(fps: fps, width: width) }
        broadcaster = b
        let control = ControlChannel(webSocketBase: api.webSocketBase, roomCode: created.code, token: created.hostToken, displayName: name)
        control.onState = { [weak self] s in self?.connection = s }
        control.onEvent = { [weak self] h, e in self?.handle(h, e) }
        self.control = control
        phase = .room
        ar.start()
        if sample { tracking = .simulated }
        control.start()
        Haptics.prepare()
        diagTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshDiagnostics() }
        }
    }

    private func resetRoomState() {
        room = nil; participants = []; objects = []; guidance = nil; comments = []; reactions = [:]
        scan = nil; previewStatus = nil; scanPhase = .idle; scanFrozen = false; broadcasting = false
        awaitingOriginReset = false; pendingOriginReset = false; lastError = nil; selectedObjectId = nil
        localOffset = 0; holding = false; onTarget = false; attemptSeq = 0; guidanceKey = ""; drag = nil
        clientId = nil
    }

    /// Leaves the room locally. The host's room stays open until it expires or is ended.
    func leave(end: Bool) {
        let sent = control?.send(end ? "room.end" : "room.leave", EmptyPayload()) != nil
        broadcaster?.stop()
        Task {
            // Give the socket a moment to flush the message before closing it.
            if sent { try? await Task.sleep(for: .milliseconds(300)) }
            self.teardown()
        }
    }

    private func teardown() {
        diagTimer?.invalidate(); diagTimer = nil
        broadcaster?.stop(); broadcaster = nil
        preview.shutdown()
        control?.stop(); control = nil
        ar?.pause(); ar = nil
        created = nil
        connection = .idle
        phase = .start
    }

    func scenePhaseChanged(_ p: ScenePhase) {
        guard phase == .room else { return }
        switch p {
        case .background:
            // iOS suspends the camera in the background; tell viewers the preview is paused.
            if broadcasting { broadcaster?.stop(); sendPreviewStatus(paused: true) }
            endHold(send: true)
        case .active:
            control?.reconnectNow()
            if broadcasting { broadcaster?.start(); sendPreviewStatus() }
        default: break
        }
    }

    // MARK: - Server events

    private func handle(_ header: Header, _ event: ServerEvent) {
        switch event {
        case .authOK(let ok):
            clientId = ok.clientId
            previewTicket = ok.previewTicket
            if let api { preview.connect(webSocketBase: api.webSocketBase, ticket: ok.previewTicket) }
            if pendingOriginReset {
                pendingOriginReset = false
                control?.send("origin.reset", OriginResetPayload(reason: "AR tracking was reset on the phone"))
            }
            sendPreviewStatus(paused: !broadcasting)
        case .snapshot(let s):
            room = s.room
            participants = s.participants
            objects = s.objects
            comments = s.comments
            reactions = s.reactions
            scan = s.scan
            previewStatus = s.preview
            applyGuidance(s.guidance)
            if awaitingOriginReset && s.room.originEpoch > resetFromEpoch {
                awaitingOriginReset = false
                scanFrozen = false
                scanPhase = .idle
                ar?.setScanVisualization(true)
            }
            if let sel = selectedObjectId, !objects.contains(where: { $0.id == sel }) { selectedObjectId = nil }
        case .objectUpserted(let o):
            if let i = objects.firstIndex(where: { $0.id == o.id }) { objects[i] = o } else { objects.append(o) }
        case .objectDeleted(let id):
            objects.removeAll { $0.id == id }
            if selectedObjectId == id { selectedObjectId = nil }
        case .presence(let p):
            participants = p
        case .commentAdded(let c):
            if !comments.contains(where: { $0.id == c.id }) { comments.append(c) }
        case .reactionUpdated(let id, let r):
            reactions[id] = r
        case .guidance(let g):
            applyGuidance(g)
        case .scanReady(let meta):
            scan = meta
        case .previewStatus(let p):
            previewStatus = p
        case .error(let e):
            lastError = "\(e.message) (\(e.code))"
        case .roomEnded(let reason):
            lastError = "Room ended: \(reason)"
            broadcaster?.stop()
            preview.shutdown()
            broadcasting = false
        case .authError(let e):
            lastError = e.message
        case .ack, .pong, .unknown:
            break
        }
        if let s = header.sceneRevision, var r = room { r.sceneRevision = s; room = r }
        renderScene()
    }

    private func applyGuidance(_ g: Guidance?) {
        let key = g.map { "\($0.id)|\($0.state.rawValue)" } ?? ""
        let previous = guidance
        guidance = g
        guard let g else {
            endHold(send: false)
            localOffset = 0
            guidanceKey = ""
            onTarget = false
            return
        }
        gate.tolerance = g.tolerance
        if let a = g.attempt { attemptSeq = max(attemptSeq, a.seq) }
        if key != guidanceKey {
            // New guidance or state change: adopt the server's attempt and stop any hold.
            guidanceKey = key
            if g.state != .active { endHold(send: false) }
            if previous?.id != g.id || g.state != .active {
                localOffset = g.attempt?.offset ?? 0
                gate.reset()
            }
        } else if let a = g.attempt, !a.holding, a.seq >= attemptSeq, abs(a.offset - localOffset) > 1e-6, !holding {
            // Reset by the expert (offset back to zero, same seq) or a reconnect snapshot.
            localOffset = a.offset
            gate.reset()
        } else if let a = g.attempt, holding, !a.holding, a.offset == 0, abs(localOffset) > 1e-6 {
            // Expert pressed "reset" mid-hold (the server keeps the last seq it saw, which may
            // be behind ours, so match on the reset shape instead).
            drag = nil
            holding = false
            localOffset = a.offset
            gate.reset()
        }
        updateOnTarget(haptic: false)
    }

    // MARK: - AR callbacks

    private func onTracking(_ s: TrackingStatus) {
        tracking = sampleMode ? .simulated : s
        broadcaster?.trackingLimited = s.isProblem
        if holding && !(sampleMode || s.allowsManipulation) {
            // Never move the design object on unreliable tracking.
            endHold(send: true)
            lastError = "Hold stopped: \(s.title)"
        }
    }

    private func onFrame(_ camera: simd_float4x4) {
        guard holding, let drag, let g = guidance, g.state == .active else { return }
        let pos = SIMD3<Float>(camera.columns.3.x, camera.columns.3.y, camera.columns.3.z)
        localOffset = drag.offset(camera: pos)
        updateOnTarget(haptic: true)
        let now = CACurrentMediaTime()
        if now - lastAttemptSentAt >= 1.0 / 15.0 && abs(localOffset - lastAttemptOffsetSent) > 0.0005 {
            sendAttempt(holding: true)
        }
        ar?.renderer.updateAttempt(guidance: guidance, object: guidedObject, offset: localOffset, holding: holding)
    }

    private func updateOnTarget(haptic: Bool) {
        guard let g = guidance, g.state == .active else {
            onTarget = false
            return
        }
        let d = GuidanceMath.distanceToTarget(g, offset: localOffset)
        onTarget = d <= g.tolerance
        if gate.update(distance: d, now: CACurrentMediaTime()) && haptic { Haptics.onTarget() }
    }

    // MARK: - Hold-to-move

    func beginHold() {
        guard !holding, canManipulate, let g = guidance, let ar else { return }
        let t = ar.cameraTransform
        drag = AxisDrag(axis: g.axis, startCamera: SIMD3<Float>(t.columns.3.x, t.columns.3.y, t.columns.3.z), startOffset: localOffset)
        holding = true
        Haptics.light()
        sendAttempt(holding: true)
    }

    func endHold(send: Bool) {
        guard holding else { return }
        holding = false
        drag = nil
        if send { sendAttempt(holding: false) }
        renderScene()
    }

    /// Sample mode stand-in for physical motion: move the attempt in 5 cm steps.
    func nudge(_ delta: Double) {
        guard canManipulate else { return }
        localOffset = min(max(localOffset + delta, -AxisDrag.maxOffset), AxisDrag.maxOffset)
        updateOnTarget(haptic: true)
        sendAttempt(holding: false)
        renderScene()
    }

    private func sendAttempt(holding: Bool) {
        guard let g = guidance, g.state == .active else { return }
        attemptSeq += 1
        let payload = AttemptPayload(guidanceId: g.id, offset: localOffset, seq: attemptSeq, holding: holding)
        if control?.send("guidance.attempt", payload, originEpoch: epoch) != nil {
            attemptsSent += 1
            lastAttemptSentAt = CACurrentMediaTime()
            lastAttemptOffsetSent = localOffset
        }
    }

    func resetAttempt() {
        guard let g = guidance, g.state == .active else { return }
        endHold(send: false)
        control?.send("guidance.reset", GuidanceIdPayload(guidanceId: g.id))
    }

    /// Lets the expert know the novice thinks it is in place; the expert approves in Blender.
    func reportDone() {
        guard let o = guidedObject else { return }
        endHold(send: true)
        let d = guidance.map { GuidanceMath.distanceToTarget($0, offset: localOffset) } ?? 0
        let text = String(format: "Done moving “%@” — please check. (%.0f cm from target on my phone)", o.name, d * 100)
        control?.send("comment.add", CommentPayload(objectId: o.id, text: text))
    }

    // MARK: - Room scan

    func captureScan() {
        guard let api, let created, let ar, isConnected, !awaitingOriginReset else { return }
        switch scanPhase {
        case .processing, .uploading: return
        default: break
        }
        let epochAtStart = epoch
        let synthetic = sampleMode
        let anchors = sampleMode ? [] : ar.meshAnchors()
        if !sampleMode && anchors.isEmpty {
            scanPhase = .failed(Self.deviceHasLiDAR
                ? "No room mesh yet. Walk slowly and point the phone at the floor and walls."
                : "This iPhone has no LiDAR, so it can’t scan. Use “Sample room” mode to test the flow.")
            return
        }
        scanPhase = .processing
        Task {
            let result = await Task.detached(priority: .userInitiated) { () -> (Data, Int, Int) in
                let raw = synthetic ? SampleRoom.mesh() : MeshCapture.collect(anchors)
                let fitted = MeshSimplifier.fit(vertices: raw.vertices, indices: raw.indices, maxVertices: 120_000, maxTriangles: 200_000)
                let data = ScanEncoding.encode(epoch: epochAtStart, vertices: fitted.vertices, indices: fitted.indices, synthetic: synthetic)
                return (data, fitted.vertices.count, fitted.indices.count / 3)
            }.value
            guard self.epoch == epochAtStart, !self.awaitingOriginReset else {
                self.scanPhase = .failed("The AR origin changed while processing. Scan again.")
                return
            }
            guard result.1 >= 3, result.2 >= 1 else {
                self.scanPhase = .failed("The mesh is empty. Keep scanning a little longer.")
                return
            }
            self.scanPhase = .uploading(0)
            do {
                let meta = try await api.uploadScan(
                    roomId: created.roomId, hostToken: created.hostToken, epoch: epochAtStart, scan: result.0,
                    vertexCount: result.1, triangleCount: result.2, synthetic: synthetic,
                    progress: { [weak self] p in self?.scanPhase = .uploading(p) })
                self.scan = meta
                self.scanPhase = .done(meta)
                self.scanFrozen = true
                self.ar?.setScanVisualization(false)
            } catch let e as APIError {
                self.scanPhase = .failed(e.code == "stale_epoch" ? "The AR origin changed during upload. Scan again." : e.message)
            } catch {
                self.scanPhase = .failed(error.localizedDescription)
            }
        }
    }

    /// Restarts AR tracking with a new world origin. Everything placed in the old origin is
    /// meaningless now, so the server marks objects stale and drops the scan and guidance.
    func resetOrigin() {
        endHold(send: false)
        ar?.resetOrigin()
        resetFromEpoch = epoch
        awaitingOriginReset = true
        scanFrozen = false
        scanPhase = .idle
        if control?.send("origin.reset", OriginResetPayload(reason: "Host reset the AR origin")) == nil {
            pendingOriginReset = true
        }
    }

    // MARK: - Preview broadcast

    func toggleBroadcast() {
        guard let broadcaster else { return }
        broadcasting.toggle()
        if broadcasting { broadcaster.start() } else { broadcaster.stop() }
        sendPreviewStatus()
    }

    private func sendPreviewStatus(fps: Double? = nil, width: Int? = nil, paused: Bool? = nil) {
        let rate = broadcaster?.rate
        let isPaused = paused ?? !broadcasting
        control?.send("preview.status", PreviewStatusPayload(
            state: isPaused ? "paused" : "live", targetFps: fps ?? rate?.fps ?? 0, width: width ?? rate?.width ?? 0))
    }

    private func refreshDiagnostics() {
        guard let b = broadcaster else { return }
        previewFps = b.rate.fps
        previewWidth = b.rate.width
        previewSent = b.sentFrames
        previewSkipped = b.skippedFrames
        previewViewers = preview.viewers
        previewLastBytes = b.lastBytes
        previewLastCostMs = b.lastCost * 1000
    }

    // MARK: - Discussion

    func select(_ id: String?) {
        selectedObjectId = id
        control?.send("selection", SelectionPayload(objectId: id))
        renderScene()
    }

    func addComment(_ text: String, objectId: String?) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        control?.send("comment.add", CommentPayload(objectId: objectId, text: String(t.prefix(500))))
    }

    func toggleReaction(_ kind: String, objectId: String) {
        control?.send("reaction.toggle", ReactionPayload(objectId: objectId, kind: kind))
    }

    func comments(for objectId: String?) -> [Comment] {
        guard let objectId else { return comments }
        return comments.filter { $0.objectId == objectId }
    }

    func participantName(_ id: String) -> String {
        participants.first { $0.clientId == id }?.displayName ?? "someone"
    }

    // MARK: - Rendering

    private func renderScene() {
        guard let ar else { return }
        var decor: [String: SceneRenderer.ObjectDecor] = [:]
        for o in objects { decor[o.id] = .init() }
        for c in comments { if let id = c.objectId { decor[id]?.commentCount += 1 } }
        for p in participants where p.connected && p.clientId != clientId {
            if let id = p.selectedObjectId { decor[id]?.selectedBy.append(p.displayName) }
        }
        ar.renderer.sync(objects: objects, decor: decor, guidance: guidance)
        ar.renderer.updateAttempt(guidance: guidance, object: guidedObject, offset: localOffset, holding: holding)
    }
}
