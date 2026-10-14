import SwiftUI

/// Diagnostics only. Never shows tokens or tickets.
struct DeveloperPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Mode") {
                    row("Data source", model.sampleMode ? "SIMULATED sample room" : "Live ARKit camera")
                    row("LiDAR mesh", AppModel.deviceHasLiDAR ? "supported" : "not supported")
                    row("Tracking", model.tracking.title)
                }
                Section("Room") {
                    row("Code", model.room?.code ?? "–")
                    row("Origin epoch", "\(model.epoch)")
                    row("Scene revision", "\(model.room?.sceneRevision ?? 0)")
                    row("Objects", "\(model.objects.count) (\(model.staleCount) stale)")
                    row("Connection", "\(model.connection)")
                }
                Section("Scan") {
                    row("Live mesh", "\(model.scanStats.meshAnchors) anchors, \(model.scanStats.vertices) vertices, \(model.scanStats.faces) faces")
                    if let s = model.scan {
                        row("Committed", "\(s.vertexCount) v / \(s.triangleCount) t, \(s.bytes / 1024) KiB\(s.synthetic ? ", SIMULATED" : "")")
                    } else {
                        row("Committed", "none")
                    }
                }
                Section("Preview") {
                    row("Broadcasting", model.broadcasting ? "yes" : "no (off by default)")
                    row("Target", String(format: "%.0f fps @ %d px", model.previewFps, model.previewWidth))
                    row("Frames sent / skipped", "\(model.previewSent) / \(model.previewSkipped)")
                    row("Last frame", "\(model.previewLastBytes / 1024) KiB, \(Int(model.previewLastCostMs)) ms capture→sent")
                    row("Viewers", "\(model.previewViewers)")
                }
                Section("Guidance") {
                    row("State", model.guidance?.state.rawValue ?? "none")
                    row("Local offset", String(format: "%.3f m", model.localOffset))
                    row("Attempts sent", "\(model.attemptsSent)")
                }
            }
            .font(.callout)
            .navigationTitle("Developer")
            .toolbar { Button("Done") { dismiss() } }
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top) {
            Text(k).foregroundStyle(.secondary)
            Spacer()
            Text(v).multilineTextAlignment(.trailing).monospacedDigit()
        }
    }
}
