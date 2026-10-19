import CoreImage.CIFilterBuiltins
import SwiftUI

struct ShareView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        NavigationStack {
            List {
                if let link = model.viewerLink {
                    Section {
                        QRCodeView(text: link).frame(maxWidth: .infinity).padding(.vertical, 8)
                        Text(link).font(.footnote.monospaced()).textSelection(.enabled)
                        ShareLink(item: link) { Label("Share observer link", systemImage: "square.and.arrow.up") }
                    } header: {
                        Text("Observers (learners, view only)")
                    } footer: {
                        Text("Observers watch the preview, follow the CAD lessons, hear and read voice notes, and comment. They cannot edit.")
                    }
                }
                if let link = model.expertLink {
                    Section {
                        Text(link).font(.footnote.monospaced()).textSelection(.enabled)
                        Button {
                            UIPasteboard.general.string = link
                            copied = true
                        } label: {
                            Label(copied ? "Copied! Paste it into Blender" : "Copy expert invite",
                                  systemImage: copied ? "checkmark" : "doc.on.doc")
                        }
                        ShareLink(item: link) { Label("Share expert invite", systemImage: "square.and.arrow.up") }
                    } header: {
                        Text("Expert (can edit)")
                    } footer: {
                        Label("Anyone with this invite can add, move and delete objects. Copy it and paste it into the Blender add-on (Universal Clipboard works with the same Apple ID). Don't open it in a browser: the page removes the credential from the address bar. Only send it to your designer.",
                              systemImage: "exclamationmark.shield")
                            .foregroundStyle(Theme.warn)
                    }
                }
                if let code = model.room?.code {
                    Section("Room code") {
                        Text(code).font(.largeTitle.monospaced().bold())
                    }
                }
            }
            .navigationTitle("Invite")
            .toolbar { Button("Done") { dismiss() } }
        }
    }
}

struct QRCodeView: View {
    let text: String

    var body: some View {
        if let image = Self.make(text) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .frame(width: 220, height: 220)
                .accessibilityLabel("QR code for the viewer link")
        }
    }

    static func make(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
