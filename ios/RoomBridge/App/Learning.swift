import Foundation
import RoomBridgeCore

/// One entry in the novice's learning feed: what someone did, explained in Blender terms.
struct LearnItem: Identifiable, Equatable {
    enum Tone { case info, success, warning }

    let id = UUID()
    var actor: String
    var steps: [NarrationStep]
    var note: String?
    var tone: Tone
    /// Concepts met for the first time; their tips are shown with this item.
    var newConcepts: [CADConcept] = []
    var date = Date()
    /// Overrides the headline (prompts and voice notes); then every step is a detail line.
    var title: String? = nil

    var headline: String {
        if let title { return title }
        guard let first = steps.first else { return actor }
        return "\(actor) \(first.text)"
    }

    var leadStep: NarrationStep? { title == nil ? steps.first : nil }

    var details: [NarrationStep] { title == nil ? Array(steps.dropFirst()) : steps }
}

enum ProposalEdit {
    case moveToCrosshair
    case rotate(degrees: Double)
    /// Axis is canonical: 0 width, 1 height, 2 depth.
    case resize(axis: Int, by: Double)
    case color(String)
    case rename(String)
}

let proposalColors = ["#b48ead", "#a0764f", "#5b7c99", "#7a8b99", "#d9cbb4", "#c9b79c", "#e0dbd0", "#3f6f5a", "#c0504d", "#2f2f33"]
