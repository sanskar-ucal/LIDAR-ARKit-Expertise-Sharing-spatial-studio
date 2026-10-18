import RealityKit
import RoomBridgeCore
import SwiftUI

struct ARViewContainer: UIViewRepresentable {
    let arView: ARView
    func makeUIView(context: Context) -> ARView { arView }
    func updateUIView(_ uiView: ARView, context: Context) {}
}

struct RoomView: View {
    @Environment(AppModel.self) private var model
    @State private var showShare = false
    @State private var showDiscussion = false
    @State private var showLibrary = false
    @State private var showLearn = false
    @State private var confirmEnd = false
    @State private var confirmReset = false

    var body: some View {
        ZStack {
            if let ar = model.ar {
                ARViewContainer(arView: ar.arView).ignoresSafeArea()
            }
            if model.placingKind != nil {
                Crosshair(ready: model.placementReady)
            }
            VStack(spacing: 8) {
                StatusBar()
                if let item = model.toast {
                    LearnToast(item: item).onTapGesture { showLearn = true }
                }
                Spacer()
                if model.placingKind != nil {
                    PlacementPanel()
                } else if model.guidance != nil {
                    GuidancePanel()
                } else if model.editingProposal != nil {
                    ProposalPanel()
                } else {
                    ProposalsStrip()
                    ScanPanel()
                }
                ControlBar(showShare: $showShare, showDiscussion: $showDiscussion, showLibrary: $showLibrary, showLearn: $showLearn,
                           confirmEnd: $confirmEnd, confirmReset: $confirmReset)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .animation(.easeInOut(duration: 0.25), value: model.toast?.id)
        }
        .sheet(isPresented: $showShare) { ShareView() }
        .sheet(isPresented: $showDiscussion) { DiscussionView() }
        .sheet(isPresented: $showLibrary) { LibrarySheet() }
        .sheet(isPresented: $showLearn) { LearnSheet() }
        .sheet(isPresented: Binding(get: { model.showDeveloper }, set: { model.showDeveloper = $0 })) { DeveloperPanel() }
        .confirmationDialog("Leave the room?", isPresented: $confirmEnd, titleVisibility: .visible) {
            Button("End room for everyone", role: .destructive) { model.leave(end: true) }
            Button("Leave (room stays open until it expires)") { model.leave(end: false) }
        }
        .confirmationDialog("Reset the AR origin?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset origin", role: .destructive) { model.resetOrigin() }
        } message: {
            Text("Use this if the virtual objects drifted. The room scan is discarded and existing objects become “stale” until the expert re-places them.")
        }
    }
}

struct StatusBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                connectionPill
                if let room = model.room {
                    Pill(text: "Room \(room.code)", color: Theme.ink.opacity(0.75), systemImage: "house")
                }
                Spacer()
                if model.broadcasting {
                    Pill(text: "LIVE · \(model.previewViewers) watching", color: Theme.bad, systemImage: "dot.radiowaves.left.and.right")
                }
            }
            HStack(spacing: 6) {
                Pill(text: model.tracking.title, color: model.tracking.isProblem ? Theme.warn : Theme.good.opacity(0.85),
                     systemImage: model.sampleMode ? "cube.transparent" : "arkit")
                Spacer()
            }
            if model.awaitingOriginReset {
                Pill(text: "Resetting AR origin… waiting for the server", color: Theme.warn, systemImage: "arrow.triangle.2.circlepath")
            }
            if model.staleCount > 0 {
                Pill(text: "\(model.staleCount) object(s) from an old AR origin are hidden until the expert re-places them",
                     color: Theme.warn, systemImage: "exclamationmark.triangle")
            }
            if let err = model.lastError {
                Pill(text: err, color: Theme.bad.opacity(0.85), systemImage: "exclamationmark.circle")
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder private var connectionPill: some View {
        switch model.connection {
        case .connected: Pill(text: "Connected", color: Theme.good, systemImage: "wifi")
        case .connecting, .idle: Pill(text: "Connecting…", color: Theme.warn, systemImage: "wifi")
        case .reconnecting: Pill(text: "Reconnecting…", color: Theme.warn, systemImage: "wifi.exclamationmark")
        case .failed(let why): Pill(text: "Can’t join: \(why)", color: Theme.bad, systemImage: "wifi.slash")
        case .ended: Pill(text: "Room ended", color: Theme.bad, systemImage: "xmark.circle")
        }
    }
}

struct ScanPanel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch model.scanPhase {
            case .idle:
                if model.sampleMode {
                    Text("Sample room: “Send room” uploads a synthetic floor and two walls (flagged as simulated).")
                } else if AppModel.deviceHasLiDAR {
                    Text("Walk slowly around the area and point at the floor and walls. Mesh: \(model.scanStats.meshAnchors) pieces, \(model.scanStats.faces) triangles.")
                } else {
                    Text("No LiDAR on this iPhone: room scanning is unavailable. Objects and the live preview still work.")
                }
            case .processing:
                HStack { ProgressView(); Text("Simplifying the room mesh…") }
            case .uploading(let p):
                ProgressView(value: p) { Text("Sending room scan… \(Int(p * 100))%") }
            case .done(let meta):
                Label("Room sent: \(meta.vertexCount) points, \(meta.triangleCount) triangles\(meta.synthetic ? " (SIMULATED)" : ""). The expert can now import it in Blender.",
                      systemImage: "checkmark.circle.fill").foregroundStyle(Theme.good)
            case .failed(let why):
                Label(why, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Theme.bad)
            }
        }
        .font(.callout)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

struct GuidancePanel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let g = model.guidance, let obj = model.guidedObject {
            VStack(alignment: .leading, spacing: 10) {
                switch g.state {
                case .preview:
                    Text("The expert is preparing a move for “\(obj.name)”. The translucent copy shows the target.")
                case .approved:
                    Label("The expert approved “\(obj.name)” in its new place.", systemImage: "checkmark.seal.fill")
                        .foregroundStyle(Theme.good)
                case .active:
                    activeBody(g, obj)
                }
            }
            .font(.callout)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        }
    }

    @ViewBuilder private func activeBody(_ g: Guidance, _ obj: SceneObject) -> some View {
        let remaining = GuidanceMath.remaining(g, offset: model.localOffset)
        let distance = GuidanceMath.distanceToTarget(g, offset: model.localOffset)
        HStack(spacing: 8) {
            Circle().fill(Theme.axisColor(g.axis)).frame(width: 14, height: 14)
            Text("Move “\(obj.name)” along the \(g.axis.colorName) line (\(g.axis.directionName))").font(.callout.weight(.semibold))
        }
        HStack {
            if model.onTarget {
                Label("On target", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.good).font(.title3.bold())
            } else {
                Text(String(format: "%.0f cm to go", distance * 100)).font(.title3.bold().monospacedDigit())
                Image(systemName: remaining >= 0 ? "arrow.forward" : "arrow.backward").foregroundStyle(Theme.axisColor(g.axis))
            }
            Spacer()
            Button("Reset") { model.resetAttempt() }.buttonStyle(.bordered)
        }
        if model.sampleMode {
            HStack {
                Button { model.nudge(-0.05) } label: { Label("−5 cm", systemImage: "minus") }.buttonStyle(.bordered)
                Button { model.nudge(0.05) } label: { Label("+5 cm", systemImage: "plus") }.buttonStyle(.bordered)
                Spacer()
                Text("Simulated motion").font(.caption).foregroundStyle(.secondary)
            }
            .disabled(!model.canManipulate)
        } else {
            HoldToMoveButton()
            Text("Press and hold, then walk the phone along the line. Let go to stop. Turning the phone does nothing.")
                .font(.caption).foregroundStyle(.secondary)
        }
        Button { model.reportDone() } label: {
            Label("Done — ask the expert to check", systemImage: "hand.thumbsup")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!model.isConnected)
    }
}

struct HoldToMoveButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let enabled = model.canManipulate
        Text(model.holding ? "Moving… let go to stop" : enabled ? "Hold to move" : "Waiting for steady tracking")
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(model.holding ? Theme.warn : (enabled ? Theme.accent : Color.gray), in: RoundedRectangle(cornerRadius: 16))
            .foregroundStyle(.white)
            .contentShape(RoundedRectangle(cornerRadius: 16))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in if !model.holding { model.beginHold() } }
                    .onEnded { _ in model.endHold(send: true) }
            )
            .accessibilityLabel("Hold to move the object along the guide line")
            .accessibilityAddTraits(.isButton)
    }
}

struct ControlBar: View {
    @Environment(AppModel.self) private var model
    @Binding var showShare: Bool
    @Binding var showDiscussion: Bool
    @Binding var showLibrary: Bool
    @Binding var showLearn: Bool
    @Binding var confirmEnd: Bool
    @Binding var confirmReset: Bool

    private var scanBusy: Bool {
        switch model.scanPhase {
        case .processing, .uploading: return true
        default: return false
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            Button { model.captureScan() } label: { Label("Send room", systemImage: "square.and.arrow.up.on.square") }
                .disabled(scanBusy || !model.isConnected || model.awaitingOriginReset || (!model.sampleMode && !AppModel.deviceHasLiDAR))
            Button { model.toggleBroadcast() } label: {
                Label(model.broadcasting ? "Stop preview" : "Share preview", systemImage: model.broadcasting ? "video.slash" : "video")
            }
            .tint(model.broadcasting ? Theme.bad : Theme.accent)
            Button { model.cancelPlacement(); showLibrary = true } label: { Label("Add object", systemImage: "plus.square.on.square") }
                .disabled(!model.isConnected || model.awaitingOriginReset)
            Button { showLearn = true } label: {
                Label("Learn", systemImage: "graduationcap")
            }
            Button { showDiscussion = true } label: {
                Label("Chat", systemImage: "bubble.left.and.bubble.right")
            }
            Menu {
                Button { showShare = true } label: { Label("Invite people", systemImage: "qrcode") }
                Button { confirmReset = true } label: { Label("Reset AR origin", systemImage: "arrow.triangle.2.circlepath") }
                    .disabled(model.sampleMode)
                Button { model.showDeveloper = true } label: { Label("Developer panel", systemImage: "wrench.and.screwdriver") }
                Button(role: .destructive) { confirmEnd = true } label: { Label("Leave room", systemImage: "door.left.hand.open") }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
        }
        .labelStyle(.iconOnly)
        .font(.title2)
        .buttonStyle(.bordered)
        .padding(10)
        .background(.regularMaterial, in: Capsule())
    }
}
