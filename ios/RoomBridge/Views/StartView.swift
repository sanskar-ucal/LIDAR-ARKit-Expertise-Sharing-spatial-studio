import SwiftUI

struct StartView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("RoomBridge").font(.largeTitle.bold())
                        Text("Scan your room, share a live preview, and let an expert place objects that you then move into place.")
                            .foregroundStyle(.secondary)
                    }
                    .listRowBackground(Color.clear)
                }
                Section("You") {
                    TextField("Your name", text: $model.hostName)
                        .textContentType(.name)
                }
                Section {
                    TextField("http://10.0.0.61:8787", text: $model.serverText)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server on your Mac")
                } footer: {
                    Text("Use the Mac’s Wi-Fi IP address that the server prints when it starts. “localhost” does not work from the phone.")
                }
                if let err = model.startError {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Theme.bad)
                    }
                }
                Section {
                    Button {
                        Task { await model.createRoom(sample: false) }
                    } label: {
                        Label(AppModel.deviceHasLiDAR ? "Create room (LiDAR scan)" : "Create room (AR, no LiDAR scan)", systemImage: "camera.viewfinder")
                    }
                    .disabled(model.creating || !AppModel.deviceSupportsAR)
                    Button {
                        Task { await model.createRoom(sample: true) }
                    } label: {
                        Label("Sample room (simulated, no camera)", systemImage: "cube.transparent")
                    }
                    .disabled(model.creating)
                } footer: {
                    if !AppModel.deviceSupportsAR {
                        Text("AR is not available on this device (or this is the Simulator). Sample room mode uses a synthetic room that is labelled as simulated everywhere.")
                    } else if !AppModel.deviceHasLiDAR {
                        Text("This iPhone has no LiDAR. You can use AR and the live preview, but room scanning needs a LiDAR device.")
                    } else {
                        Text("Nothing is recorded. The camera preview is only shared when you turn it on.")
                    }
                }
                if model.creating {
                    Section { HStack { ProgressView(); Text("Creating room…") } }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.warm)
        }
        .environment(\.colorScheme, .light)  // the warm background is light; Dark Mode text would vanish on it
    }
}
