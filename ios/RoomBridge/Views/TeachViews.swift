import RoomBridgeCore
import SwiftUI

/// The expert's current prompt: what to do, the Blender keys it teaches, and a "Show me"
/// ghost demo in AR.
struct LessonCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let l = model.lesson {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 10) {
                    icon(l)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(l.byName) asks").font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
                        Text(l.text).font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        if let s = model.lessonSteps.first, !s.shortcut.isEmpty { ShortcutLine(step: s) }
                    }
                    Spacer(minLength: 0)
                    Button { model.lessonCollapsed = true } label: { Image(systemName: "chevron.down.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
                if l.state == .done {
                    Label("Done — \(l.byName) has been told", systemImage: "checkmark.seal.fill").foregroundStyle(Theme.good).font(.callout)
                } else {
                    actions(l)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.accent.opacity(0.5), lineWidth: 1.5))
        }
    }

    @ViewBuilder private func actions(_ l: Lesson) -> some View {
        HStack(spacing: 8) {
            if l.demo != nil {
                Button { model.toggleDemo() } label: {
                    Label(model.showingDemo ? "Stop" : "Show me", systemImage: model.showingDemo ? "stop.fill" : "play.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.lessonObject == nil)
            }
            switch l.preset {
            case .place:
                Button { model.startLessonPlacement() } label: { Label("Open library", systemImage: "plus.square.on.square") }
                    .buttonStyle(.borderedProminent)
            case .scan:
                Text("Tap Send room when you're done; it completes automatically.").font(.caption).foregroundStyle(.secondary)
            default:
                EmptyView()
            }
            Spacer()
            if l.preset != .scan && l.preset != .place {
                Button { model.markLessonDone() } label: { Label("Got it", systemImage: "checkmark") }
                    .buttonStyle(.bordered)
                    .disabled(!model.isConnected)
            }
        }
        if l.demo != nil && model.lessonObject == nil {
            Text("The object for this demo is hidden (old AR origin).").font(.caption).foregroundStyle(Theme.warn)
        } else if model.showingDemo {
            Text("The teal ghost shows what the keys do. Watch it loop, then try it on your own piece.").font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func icon(_ l: Lesson) -> some View {
        switch l.preset {
        case .scan: ScanSweep()
        case .move: Image(systemName: "arrow.left.and.right").font(.title2).foregroundStyle(Theme.accent)
        case .rotate: Image(systemName: "rotate.right").font(.title2).foregroundStyle(Theme.accent)
        case .scale: Image(systemName: "arrow.up.left.and.arrow.down.right").font(.title2).foregroundStyle(Theme.accent)
        case .place: Image(systemName: l.kind.map { AppCatalog.kind($0).icon } ?? "plus.square").font(.title2).foregroundStyle(Theme.accent)
        case .custom: Image(systemName: "graduationcap").font(.title2).foregroundStyle(Theme.accent)
        }
    }
}

/// A phone sweeping left and right: how to scan a room, in two seconds.
struct ScanSweep: View {
    var body: some View {
        TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            Image(systemName: "iphone.gen3.radiowaves.left.and.right")
                .font(.title2)
                .foregroundStyle(Theme.accent)
                .rotationEffect(.degrees(sin(t * 2) * 30))
                .offset(x: sin(t * 2) * 6)
        }
        .frame(width: 36, height: 36)
    }
}

/// Collapsed prompt, so it does not cover the room.
struct LessonChip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let l = model.lesson, model.lessonCollapsed {
            Button { model.lessonCollapsed = false } label: {
                Label(l.state == .done ? "Done: \(l.text)" : "\(l.byName)'s task: \(l.text)",
                      systemImage: l.state == .done ? "checkmark.seal" : "graduationcap.fill")
                    .lineLimit(1).font(.caption.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .tint(l.state == .done ? Theme.good : Theme.accent)
        }
    }
}

/// Hold to talk; release to send to the expert and observers (with an on-device transcript).
struct TalkButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if model.recording, let started = model.recordingStarted {
                TimelineView(.periodic(from: started, by: 0.5)) { ctx in
                    Text("● Recording \(Int(ctx.date.timeIntervalSince(started)))s · release to send")
                        .font(.caption.weight(.semibold)).padding(6)
                        .background(Theme.bad, in: Capsule()).foregroundStyle(.white)
                }
            } else if let status = model.voiceStatus {
                Text(status).font(.caption).padding(6).background(.regularMaterial, in: Capsule())
            }
            Image(systemName: model.recording ? "mic.fill" : "mic")
                .font(.title2.weight(.semibold))
                .frame(width: 58, height: 58)
                .background(model.recording ? Theme.bad : Theme.accent, in: Circle())
                .foregroundStyle(.white)
                .shadow(radius: 3)
                .opacity(model.isConnected && model.voiceStatus == nil ? 1 : 0.5)
                .contentShape(Circle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { _ in model.beginTalk() }
                        .onEnded { _ in model.endTalk() }
                )
                .accessibilityLabel("Hold to record a voice note for everyone in the room")
                .accessibilityAddTraits(.isButton)
        }
    }
}
