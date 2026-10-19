import RoomBridgeCore
import SwiftUI

/// Blender keys shown as little keycaps, e.g. "G X 0.5" -> [G] [X] 0.5.
struct Keycaps: View {
    let shortcut: String

    var body: some View {
        let groups = shortcut.components(separatedBy: " · ")
        HStack(spacing: 6) {
            ForEach(Array(groups.enumerated()), id: \.offset) { i, group in
                if i > 0 { Text("then").font(.caption2).foregroundStyle(.secondary) }
                HStack(spacing: 3) {
                    ForEach(Array(group.split(separator: " ").enumerated()), id: \.offset) { _, token in
                        let t = String(token)
                        if Self.isKey(t) {
                            Text(t)
                                .font(.caption.monospaced().weight(.bold))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(RoundedRectangle(cornerRadius: 5).fill(Color(white: 0.97)))
                                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color(white: 0.7)))
                                .foregroundStyle(Theme.ink)
                        } else {
                            Text(t).font(.caption.monospaced())
                        }
                    }
                }
            }
        }
    }

    /// Single letters and modifier combos are keys; numbers and words are typed values.
    static func isKey(_ t: String) -> Bool {
        if t.count == 1, t.first!.isLetter { return true }
        return t.contains("+") && !t.hasPrefix("+")
    }
}

struct LearnToast: View {
    @Environment(AppModel.self) private var model
    let item: LearnItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Image(systemName: icon).foregroundStyle(tint)
                Text(item.headline).font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button { model.dismissToast() } label: { Image(systemName: "xmark").font(.caption.bold()) }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
            }
            if let first = item.leadStep, !first.shortcut.isEmpty { ShortcutLine(step: first) }
            ForEach(Array(item.details.enumerated()), id: \.offset) { _, s in
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title == nil ? "then \(s.text)" : s.text).font(.caption)
                    if !s.shortcut.isEmpty { ShortcutLine(step: s) }
                }
            }
            if let note = item.note { Text(note).font(.caption).italic().foregroundStyle(.secondary) }
            ForEach(item.newConcepts, id: \.self) { c in
                Label("New skill: \(c.title). \(c.tip)", systemImage: "graduationcap.fill")
                    .font(.caption).foregroundStyle(Theme.accent)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(tint.opacity(0.6), lineWidth: 1.5))
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var tint: Color {
        switch item.tone {
        case .info: return Theme.accent
        case .success: return Theme.good
        case .warning: return Theme.warn
        }
    }

    private var icon: String {
        switch item.tone {
        case .info: return item.actor == "You" ? "hand.point.up.left.fill" : (item.title?.hasPrefix("🎤") == true ? "mic.fill" : "cube.transparent")
        case .success: return "checkmark.seal.fill"
        case .warning: return "arrow.uturn.backward.circle.fill"
        }
    }
}

struct ShortcutLine: View {
    let step: NarrationStep

    var body: some View {
        HStack(spacing: 6) {
            Text("In Blender:").font(.caption2).foregroundStyle(.secondary)
            if step.concept == .add {
                Text(step.shortcut).font(.caption.monospaced())
            } else {
                Keycaps(shortcut: step.shortcut)
            }
        }
    }
}

struct LearnSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(CADConcept.allCases, id: \.self) { c in
                        let seen = model.skillsSeen.contains(c)
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: seen ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(seen ? Theme.good : .secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.title).font(.subheadline.weight(.semibold))
                                Text(c.tip).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("CAD skills: \(model.skillsSeen.count) of \(CADConcept.allCases.count)")
                } footer: {
                    Text("Every edit the expert makes in Blender, and every edit you make here, is explained with the Blender keys that would do it.")
                }
                Section("What happened") {
                    if model.learnFeed.isEmpty {
                        Text("Nothing yet. Ask the expert to add something, or add an object yourself with ＋.").foregroundStyle(.secondary)
                    }
                    ForEach(model.learnFeed) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.headline).font(.callout)
                            if let s = item.leadStep, !s.shortcut.isEmpty { ShortcutLine(step: s) }
                            ForEach(Array(item.details.enumerated()), id: \.offset) { _, s in
                                Text(item.title == nil ? "then \(s.text)" : s.text).font(.caption)
                                if !s.shortcut.isEmpty { ShortcutLine(step: s) }
                            }
                            if let note = item.note { Text(note).font(.caption).italic().foregroundStyle(.secondary) }
                            Text(item.date, style: .time).font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            .navigationTitle("Learn")
            .toolbar { Button("Done") { dismiss() } }
        }
    }
}
