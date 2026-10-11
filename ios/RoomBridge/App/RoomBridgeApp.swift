import SwiftUI

@main
struct RoomBridgeApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                switch model.phase {
                case .start: StartView()
                case .room: RoomView()
                }
            }
            .environment(model)
            .tint(Theme.accent)
            .onChange(of: scenePhase) { _, p in model.scenePhaseChanged(p) }
        }
    }
}
