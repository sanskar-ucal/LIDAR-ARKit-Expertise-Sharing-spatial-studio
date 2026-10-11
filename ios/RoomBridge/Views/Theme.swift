import RoomBridgeCore
import SwiftUI

enum Theme {
    static let accent = Color(red: 0.16, green: 0.55, blue: 0.58)
    static let warm = Color(red: 0.97, green: 0.95, blue: 0.91)
    static let ink = Color(red: 0.16, green: 0.15, blue: 0.14)
    static let good = Color(red: 0.24, green: 0.61, blue: 0.37)
    static let warn = Color(red: 0.85, green: 0.55, blue: 0.15)
    static let bad = Color(red: 0.78, green: 0.25, blue: 0.22)

    static func axisColor(_ a: GuidanceAxis) -> Color {
        switch a {
        case .x: return Color(red: 0.86, green: 0.25, blue: 0.24)
        case .y: return Color(red: 0.23, green: 0.43, blue: 0.80)
        case .z: return Color(red: 0.35, green: 0.68, blue: 0.29)
        }
    }

    static func roleLabel(_ r: Role) -> String {
        switch r {
        case .host: return "Novice (phone)"
        case .expert: return "Expert (Blender)"
        case .viewer: return "Family (viewer)"
        }
    }
}

struct Pill: View {
    var text: String
    var color: Color
    var systemImage: String?

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage) }
            Text(text).lineLimit(2)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(color.opacity(0.9), in: Capsule())
        .foregroundStyle(.white)
    }
}
