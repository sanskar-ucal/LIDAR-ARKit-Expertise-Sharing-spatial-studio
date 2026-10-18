import RoomBridgeCore
import SwiftUI

/// The object library: prebuilt pieces the novice can propose, each with its CAD lesson.
struct LibrarySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Pick a piece, aim the dot at the floor or a wall, and place it. \(model.expertName) reviews every proposal in Blender and can adjust it. You'll see what they changed, in Blender keys.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(AppCatalog.shared.groups, id: \.name) { group in
                    Section(group.name) {
                        ForEach(group.kinds) { k in
                            Button {
                                dismiss()
                                model.beginPlacement(k.kind)
                            } label: {
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: k.icon).font(.title2).frame(width: 36).foregroundStyle(Theme.accent)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(k.label).font(.headline).foregroundStyle(.primary)
                                        Text(k.lesson).font(.caption).foregroundStyle(.secondary)
                                        Text(k.mount == .wall ? "Goes on a wall" : "Stands on the floor").font(.caption2).foregroundStyle(.tertiary)
                                    }
                                }
                            }
                            .disabled(!model.isConnected)
                        }
                    }
                }
                if !model.myProposals.isEmpty {
                    Section("Your proposals waiting for review") {
                        ForEach(model.myProposals) { o in
                            Button {
                                model.editingProposalId = o.id
                                dismiss()
                            } label: {
                                Label(o.name, systemImage: AppCatalog.kind(o.kind).icon)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Add an object")
            .toolbar { Button("Close") { dismiss() } }
        }
    }
}

/// Crosshair at the screen centre while placing; placement raycasts from this point.
struct Crosshair: View {
    var ready: Bool

    var body: some View {
        ZStack {
            Circle().stroke(.white, lineWidth: 3).frame(width: 26, height: 26).shadow(radius: 2)
            Circle().fill(ready ? Theme.good : Theme.warn).frame(width: 8, height: 8)
        }
        .allowsHitTesting(false)
    }
}

struct PlacementPanel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let kind = model.placingKind {
            let spec = AppCatalog.kind(kind)
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: spec.icon).foregroundStyle(Theme.accent)
                    Text("Place a \(spec.label.lowercased())").font(.headline)
                    Spacer()
                }
                Text(model.placementHint).font(.callout).foregroundStyle(model.placementReady ? Theme.good : .secondary)
                Text(spec.lesson).font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Cancel") { model.cancelPlacement() }.buttonStyle(.bordered)
                    Button {
                        model.confirmPlacement()
                    } label: {
                        Label("Place & propose", systemImage: "plus.circle.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.placementReady || !model.isConnected)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        }
    }
}

/// Edit your own proposal while it waits for the expert. Every change is narrated in Blender keys.
struct ProposalPanel: View {
    @Environment(AppModel.self) private var model
    @State private var renaming = false
    @State private var newName = ""

    var body: some View {
        if let o = model.editingProposal {
            let spec = AppCatalog.kind(o.kind)
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: spec.icon).foregroundStyle(Theme.accent)
                    Text(o.name).font(.headline)
                    Spacer()
                    Text("Waiting for \(model.expertName)").font(.caption).foregroundStyle(Theme.warn)
                    Button { model.editingProposalId = nil } label: { Image(systemName: "chevron.down.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    Button { model.editProposal(.moveToCrosshair) } label: { Label("Move to dot", systemImage: "scope") }
                    Button { model.editProposal(.rotate(degrees: 15)) } label: { Label("15°", systemImage: "rotate.left") }
                    Button { model.editProposal(.rotate(degrees: -15)) } label: { Label("15°", systemImage: "rotate.right") }
                    Button { model.editProposal(.rotate(degrees: 90)) } label: { Text("90°") }
                }
                .buttonStyle(.bordered).font(.callout)
                sizeRow(spec.round ? "Diameter" : "Width", axis: 0, value: o.dimensions.x, hidden: false)
                sizeRow("Depth", axis: 2, value: o.dimensions.z, hidden: spec.round)
                sizeRow("Height", axis: 1, value: o.dimensions.y, hidden: false)
                if o.kind == .block {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(proposalColors, id: \.self) { hex in
                                Circle().fill(Color(uiColor: UIColor(hex: hex) ?? .gray)).frame(width: 26, height: 26)
                                    .overlay(Circle().stroke(o.color == hex ? Theme.ink : .clear, lineWidth: 2))
                                    .onTapGesture { model.editProposal(.color(hex)) }
                            }
                        }
                    }
                    Button { newName = o.name; renaming = true } label: { Label("Name your design", systemImage: "pencil") }
                        .font(.callout)
                }
                HStack {
                    Text(spec.lesson).font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    Button(role: .destructive) { model.withdrawProposal() } label: { Label("Withdraw", systemImage: "trash") }
                        .font(.callout)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .alert("Name your design", isPresented: $renaming) {
                TextField("Name", text: $newName)
                Button("Save") { model.editProposal(.rename(newName)) }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    @ViewBuilder private func sizeRow(_ label: String, axis: Int, value: Double, hidden: Bool) -> some View {
        if !hidden {
            HStack {
                Text(label).font(.callout).frame(width: 72, alignment: .leading)
                Text(String(format: "%.2f m", value)).font(.callout.monospacedDigit())
                Spacer()
                Button { model.editProposal(.resize(axis: axis, by: -0.05)) } label: { Image(systemName: "minus") }
                Button { model.editProposal(.resize(axis: axis, by: 0.05)) } label: { Image(systemName: "plus") }
            }
            .buttonStyle(.bordered)
        }
    }
}

/// Quick access to pending proposals when nothing else is on screen.
struct ProposalsStrip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if !model.myProposals.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    Text("Your proposals:").font(.caption.weight(.semibold))
                    ForEach(model.myProposals) { o in
                        Button { model.editingProposalId = o.id } label: {
                            Label(o.name, systemImage: AppCatalog.kind(o.kind).icon).font(.caption)
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
    }
}
