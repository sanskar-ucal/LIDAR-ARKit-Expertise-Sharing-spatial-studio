import Foundation
import RoomBridgeCore

/// protocol/catalog.json, bundled into the app by project.yml.
enum AppCatalog {
    static let shared: Catalog = {
        guard let url = Bundle.main.url(forResource: "catalog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let catalog = try? Catalog.decode(data) else {
            fatalError("catalog.json is missing from the app bundle; regenerate the project with scripts/gen-ios.sh")
        }
        return catalog
    }()

    static func kind(_ k: ObjectKind) -> Catalog.Kind {
        guard let spec = shared.kind(k) else { fatalError("catalog.json has no entry for \(k.rawValue)") }
        return spec
    }
}
