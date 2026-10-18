import RoomBridgeCore
import SwiftUI

struct DiscussionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            List {
                Section("People") {
                    ForEach(model.participants) { p in
                        HStack {
                            Circle().fill(p.connected ? Theme.good : Color.gray).frame(width: 8, height: 8)
                            Text(p.displayName + (p.clientId == model.clientId ? " (you)" : ""))
                            Spacer()
                            Text(Theme.roleLabel(p.role)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Objects") {
                    if model.objects.isEmpty {
                        Text("No objects yet. The expert adds them in Blender, or propose one with ＋.").foregroundStyle(.secondary)
                    }
                    ForEach(model.objects) { o in
                        objectRow(o)
                    }
                }
                Section(model.selectedObject.map { "Comments on “\($0.name)”" } ?? "All comments") {
                    let list = model.comments(for: model.selectedObjectId)
                    if list.isEmpty { Text("No comments yet.").foregroundStyle(.secondary) }
                    ForEach(list) { c in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(c.authorName).font(.caption.bold())
                                Text(Theme.roleLabel(c.authorRole)).font(.caption2).foregroundStyle(.secondary)
                                if let name = c.objectName, model.selectedObjectId == nil {
                                    Text("on \(name)\(c.objectDeleted ? " (deleted)" : "")").font(.caption2).foregroundStyle(Theme.accent)
                                }
                            }
                            if let v = c.voice {
                                Button { model.play(c) } label: {
                                    Label(model.playingClipId == v.clipId ? "Stop" : "Play voice note (\(max(1, v.durationMs / 1000)) s)",
                                          systemImage: model.playingClipId == v.clipId ? "stop.circle.fill" : "play.circle.fill")
                                        .font(.callout)
                                }
                                .buttonStyle(.borderless)
                            }
                            Text(c.voice != nil ? "🎤 \(c.text)" : c.text)
                        }
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                HStack {
                    TextField(model.selectedObject.map { "Comment on \($0.name)…" } ?? "Message everyone…", text: $draft)
                        .textFieldStyle(.roundedBorder)
                        .submitLabel(.send)
                        .onSubmit(send)
                    Button("Send", action: send).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || !model.isConnected)
                }
                .padding()
                .background(.bar)
            }
            .navigationTitle("Discussion")
            .toolbar { Button("Done") { dismiss() } }
        }
    }

    private func send() {
        model.addComment(draft, objectId: model.selectedObjectId)
        draft = ""
    }

    @ViewBuilder private func objectRow(_ o: SceneObject) -> some View {
        let r = model.reactions[o.id] ?? Reactions()
        let mine = model.clientId ?? ""
        let selected = model.selectedObjectId == o.id
        HStack {
            Button {
                model.select(selected ? nil : o.id)
            } label: {
                VStack(alignment: .leading) {
                    Text(o.name + (o.stale ? " (stale)" : "")).font(.body.weight(selected ? .bold : .regular))
                    Text(AppCatalog.kind(o.kind).label + (o.proposal != nil ? " · your proposal" : "")).font(.caption).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            Spacer()
            Button { model.toggleReaction("like", objectId: o.id) } label: {
                Label("\(r.like.count)", systemImage: r.like.contains(mine) ? "heart.fill" : "heart")
            }
            .buttonStyle(.borderless)
            Button { model.toggleReaction("discuss", objectId: o.id) } label: {
                Label("\(r.discuss.count)", systemImage: r.discuss.contains(mine) ? "questionmark.bubble.fill" : "questionmark.bubble")
            }
            .buttonStyle(.borderless)
        }
        .listRowBackground(selected ? Theme.accent.opacity(0.12) : nil)
    }
}
