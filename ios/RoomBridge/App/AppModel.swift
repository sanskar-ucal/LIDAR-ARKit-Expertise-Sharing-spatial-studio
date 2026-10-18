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

    // MARK: Object library, proposals and learning
    private(set) var placingKind: ObjectKind?
    private(set) var placementReady = false
    private(set) var placementHint = ""
    var editingProposalId: String?
    private(set) var learnFeed: [LearnItem] = []
    private(set) var toast: LearnItem?
    private(set) var skillsSeen: Set<CADConcept> = []
    @ObservationIgnored private var narration = EditNarrationBuffer(settle: 0.8)
    @ObservationIgnored private var narrationTimer: Timer?
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var placementPose: ARSessionController.Placement?
    /// Local edits to the novice's own proposals that the server has not confirmed yet.
    @ObservationIgnored private var drafts: [String: SceneObject] = [:]
    @ObservationIgnored private var proposalInFlight: [String: String] = [:]  // objectId -> messageId
    @ObservationIgnored private var proposalDirty: Set<String> = []

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
    /// Only the host can propose, so every pending proposal is the novice's own.
    var myProposals: [SceneObject] { objects.filter { $0.proposal != nil && !$0.stale }.map { drafts[$0.id] ?? $0 } }
    var editingProposal: SceneObject? {
        guard let id = editingProposalId, let o = objects.first(where: { $0.id == id }), o.proposal != nil else { return nil }
        return drafts[id] ?? o
    }
    var expertName: String { participants.first { $0.role == .expert && $0.connected }?.displayName ?? "The expert" }
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
        narrationTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.narrationTick() }
        }
    }

    private func resetRoomState() {
        room = nil; participants = []; objects = []; guidance = nil; comments = []; reactions = [:]
        scan = nil; previewStatus = nil; scanPhase = .idle; scanFrozen = false; broadcasting = false
        awaitingOriginReset = false; pendingOriginReset = false; lastError = nil; selectedObjectId = nil
        localOffset = 0; holding = false; onTarget = false; attemptSeq = 0; guidanceKey = ""; drag = nil
        clientId = nil
        placingKind = nil; placementReady = false; placementPose = nil; editingProposalId = nil
        learnFeed = []; toast = nil; skillsSeen = []; narration = EditNarrationBuffer(settle: 0.8)
        drafts = [:]; proposalInFlight = [:]; proposalDirty = []
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
        narrationTimer?.invalidate(); narrationTimer = nil
        toastTask?.cancel(); toastTask = nil
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
            for id in drafts.keys where !objects.contains(where: { $0.id == id && $0.proposal != nil }) { drafts[id] = nil }
            if let id = editingProposalId, !objects.contains(where: { $0.id == id && $0.proposal != nil }) { editingProposalId = nil }
            proposalInFlight = [:]
            proposalDirty = []
        case .objectUpserted(let o):
            upsert(o, from: header.clientId)
        case .objectDeleted(let id):
            removeObject(id, from: header.clientId)
        case .proposalResolved(let r):
            resolved(r)
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
            if !proposalAcked(e.ackOf, error: e) { lastError = "\(e.message) (\(e.code))" }
        case .ack(let messageId):
            proposalAcked(messageId, error: nil)
        case .roomEnded(let reason):
            lastError = "Room ended: \(reason)"
            broadcaster?.stop()
            preview.shutdown()
            broadcasting = false
        case .authError(let e):
            lastError = e.message
        case .pong, .unknown:
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
        if placingKind != nil { updatePlacement() }
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
        for o in objects { decor[o.id] = .init(mineProposal: o.proposal != nil, editing: o.id == editingProposalId) }
        for c in comments { if let id = c.objectId { decor[id]?.commentCount += 1 } }
        for p in participants where p.connected && p.clientId != clientId {
            if let id = p.selectedObjectId { decor[id]?.selectedBy.append(p.displayName) }
        }
        ar.renderer.sync(objects: objects.map { drafts[$0.id] ?? $0 }, decor: decor, guidance: guidance)
        ar.renderer.updateAttempt(guidance: guidance, object: guidedObject, offset: localOffset, holding: holding)
    }
}

// MARK: - Object library, proposals and CAD narration

extension AppModel {
    private func name(of clientId: String) -> String {
        participants.first { $0.clientId == clientId }?.displayName ?? "The expert"
    }

    private func upsert(_ o: SceneObject, from sender: String) {
        let previous = objects.first { $0.id == o.id }
        let mine = sender == clientId
        if let i = objects.firstIndex(where: { $0.id == o.id }) { objects[i] = o } else { objects.append(o) }
        if let draft = drafts[o.id] {
            if !mine {
                drafts[o.id] = nil  // the expert changed our proposal: theirs wins
            } else if proposalInFlight[o.id] == nil && !proposalDirty.contains(o.id) && Self.samePose(draft.pose, o.pose) {
                drafts[o.id] = nil
            }
        }
        guard !mine, !o.stale else { return }
        if let previous {
            // The expert's adjustments to our own proposal are explained when they decide on it, and an
            // approved guidance move was made by the novice, not the expert.
            if previous.proposal == nil && guidance?.objectId != o.id {
                narration.record(objectId: o.id, actor: name(of: sender), name: o.name, from: previous.pose, to: o.pose, now: CACurrentMediaTime())
            }
        } else if o.proposal == nil {
            push(LearnItem(actor: name(of: sender), steps: [Narrator.added(name: o.name, blender: AppCatalog.kind(o.kind).blender)],
                           note: AppCatalog.kind(o.kind).lesson, tone: .info))
        }
    }

    private func removeObject(_ id: String, from sender: String) {
        let previous = objects.first { $0.id == id }
        objects.removeAll { $0.id == id }
        if selectedObjectId == id { selectedObjectId = nil }
        if editingProposalId == id { editingProposalId = nil }
        drafts[id] = nil
        narration.drop(id)
        // A rejected proposal is explained by proposal.resolved instead.
        if let previous, previous.proposal == nil, sender != clientId {
            push(LearnItem(actor: name(of: sender), steps: [Narrator.deleted(name: previous.name)], tone: .info))
        }
    }

    private func resolved(_ r: ProposalResolved) {
        if editingProposalId == r.objectId { editingProposalId = nil }
        narration.drop(r.objectId)
        drafts[r.objectId] = nil
        var steps: [NarrationStep]
        let tone: LearnItem.Tone
        switch r.outcome {
        case .accepted:
            steps = [NarrationStep(concept: .approve, text: "approved your \(r.objectName) ✓", shortcut: "")]
            tone = .success
            Haptics.approved()
        case .adjusted:
            steps = [NarrationStep(concept: .approve, text: "approved your \(r.objectName) after adjusting it", shortcut: "")]
            if let after = r.after { steps += Narrator.describe(name: "it", before: r.before, after: after) }
            tone = .success
            Haptics.approved()
        case .rejected:
            steps = [NarrationStep(concept: .approve, text: "removed your \(r.objectName)", shortcut: "")]
            tone = .warning
            Haptics.rejected()
        }
        push(LearnItem(actor: r.byName, steps: steps, note: r.note, tone: tone))
    }

    private func narrationTick() {
        if placingKind != nil && sampleMode { updatePlacement() }  // no AR frames in the sample room
        for g in narration.flush(now: CACurrentMediaTime()) {
            push(LearnItem(actor: g.actor, steps: g.steps, tone: .info))
        }
    }

    private func push(_ item: LearnItem) {
        var item = item
        let concepts = item.steps.map(\.concept)
        item.newConcepts = concepts.filter { !skillsSeen.contains($0) }.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
        skillsSeen.formUnion(concepts)
        learnFeed.insert(item, at: 0)
        if learnFeed.count > 40 { learnFeed.removeLast(learnFeed.count - 40) }
        toast = item
        if item.actor != "You" && item.tone == .info { Haptics.light() }
        toastTask?.cancel()
        let id = item.id
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(item.newConcepts.isEmpty ? 6 : 9))
            if !Task.isCancelled, self?.toast?.id == id { self?.toast = nil }
        }
    }

    func dismissToast() { toast = nil }

    private static func samePose(_ a: ObjectPose, _ b: ObjectPose) -> Bool {
        let eps = 1e-4
        return simd_length(a.position - b.position) < eps && simd_length(a.dimensions - b.dimensions) < eps
            && abs(abs(simd_dot(a.rotation, b.rotation)) - 1) < eps
    }

    // MARK: Placement

    func beginPlacement(_ kind: ObjectKind) {
        guard isConnected, !awaitingOriginReset else { return }
        placingKind = kind
        editingProposalId = nil
        placementReady = false
        updatePlacement()
    }

    func cancelPlacement() {
        placingKind = nil
        placementPose = nil
        ar?.renderer.showPlacement(nil, label: "")
    }

    private func updatePlacement() {
        guard let kind = placingKind, let ar else { return }
        let spec = AppCatalog.kind(kind)
        let pose = (sampleMode || tracking.allowsManipulation) ? ar.placement(for: spec, dimensions: spec.dimensions) : nil
        placementPose = pose
        placementReady = pose != nil
        placementHint = pose == nil
            ? (spec.mount == .wall ? "Aim the dot at a wall" : "Aim the dot at the floor")
            : "Tap Place to propose it to \(expertName)"
        guard let pose else {
            ar.renderer.showPlacement(nil, label: "")
            return
        }
        let preview = SceneObject(local: input(for: spec, at: pose, id: "placement-preview", name: spec.label), epoch: epoch)
        ar.renderer.showPlacement(preview, label: "\(spec.label)\npreview")
    }

    private func input(for spec: Catalog.Kind, at pose: ARSessionController.Placement, id: String, name: String) -> ObjectInput {
        ObjectInput(id: id, kind: spec.kind, name: name, position: pose.position, rotation: pose.rotation, dimensions: spec.dimensions,
                    color: spec.color, textureRef: spec.kind == .panel ? "sample:picture" : nil)
    }

    func confirmPlacement() {
        guard let kind = placingKind, let pose = placementPose else { return }
        let spec = AppCatalog.kind(kind)
        let n = objects.filter { $0.kind == kind }.count + 1
        let name = "\(spec.label) \(n)"
        let id = UUID().uuidString.lowercased()
        guard control?.send("object.propose", ProposePayload(object: input(for: spec, at: pose, id: id, name: name)), originEpoch: epoch) != nil else {
            lastError = "Not connected: the proposal was not sent"
            return
        }
        cancelPlacement()
        editingProposalId = id
        push(LearnItem(actor: "You", steps: [Narrator.added(name: name, blender: spec.blender)], note: spec.lesson, tone: .info))
    }

    // MARK: Editing the novice's own proposals

    func editProposal(_ edit: ProposalEdit) {
        guard let current = editingProposal, let ar else { return }
        var o = current
        let spec = AppCatalog.kind(o.kind)
        switch edit {
        case .moveToCrosshair:
            guard let p = ar.placement(for: spec, dimensions: o.dimensions) else {
                lastError = spec.mount == .wall ? "Aim the phone at a wall to move it there" : "Aim the phone at the floor to move it there"
                return
            }
            o.position = p.position
            if spec.mount == .wall { o.rotation = p.rotation }
        case .rotate(let degrees):
            let turn = simd_quatd(angle: degrees * .pi / 180, axis: Vec3(0, 1, 0))
            let q = simd_normalize(turn * simd_quatd(vector: o.rotation))
            o.rotation = q.vector
        case .resize(let axis, let delta):
            var d = o.dimensions
            d[axis] = min(max(d[axis] + delta, 0.05), 6)
            if spec.round && axis != 1 { d.x = d[axis]; d.z = d[axis] }
            o.dimensions = d
        case .color(let hex):
            o.color = hex
        case .rename(let text):
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return }
            o.name = String(t.prefix(60))
        }
        guard o != current else { return }
        drafts[o.id] = o
        if case .color = edit {} else if case .rename = edit {} else {
            narration.record(objectId: o.id, actor: "You", name: o.name, from: current.pose, to: o.pose, now: CACurrentMediaTime())
        }
        sendProposalUpdate(o.id)
        renderScene()
    }

    private func sendProposalUpdate(_ id: String) {
        if proposalInFlight[id] != nil {
            proposalDirty.insert(id)  // coalesce: send the newest state once the server confirms
            return
        }
        guard let draft = drafts[id], let server = objects.first(where: { $0.id == id }) else { return }
        let patch = ObjectUpdatePayload.Patch(name: draft.name, position: draft.position, rotation: draft.rotation,
                                              dimensions: draft.dimensions, color: draft.color)
        proposalDirty.remove(id)
        if let mid = control?.send("object.update", ObjectUpdatePayload(id: id, baseRevision: server.revision, patch: patch), originEpoch: epoch) {
            proposalInFlight[id] = mid
        }
    }

    /// Returns true if the message was one of our proposal edits.
    @discardableResult
    private func proposalAcked(_ messageId: String?, error: ServerError?) -> Bool {
        guard let messageId, let id = proposalInFlight.first(where: { $0.value == messageId })?.key else { return false }
        proposalInFlight[id] = nil
        if let error, error.code != "stale_revision" {
            drafts[id] = nil  // refused: show the server's version again
            lastError = error.message
            renderScene()
            return true
        }
        if proposalDirty.contains(id) || error != nil { sendProposalUpdate(id) }
        return true
    }

    func withdrawProposal() {
        guard let o = editingProposal else { return }
        control?.send("object.delete", ObjectIdPayload(id: o.id))
        editingProposalId = nil
        push(LearnItem(actor: "You", steps: [Narrator.deleted(name: o.name)], tone: .info))
    }
}
