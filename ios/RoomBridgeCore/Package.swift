// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "RoomBridgeCore",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [
        .library(name: "RoomBridgeCore", targets: ["RoomBridgeCore"]),
        .executable(name: "rbcore-checks", targets: ["RoomBridgeCoreCheckRunner"]),
    ],
    targets: [
        // Platform-independent logic shared by the iOS app: protocol models,
        // coordinate math, guidance math, binary formats, mesh simplification.
        .target(name: "RoomBridgeCore"),
        // Fixture-driven checks. Runnable with `swift run rbcore-checks` even
        // where XCTest is unavailable (Command Line Tools only).
        .target(name: "RoomBridgeCoreChecks", dependencies: ["RoomBridgeCore"]),
        .executableTarget(name: "RoomBridgeCoreCheckRunner", dependencies: ["RoomBridgeCoreChecks"]),
        .testTarget(name: "RoomBridgeCoreTests", dependencies: ["RoomBridgeCoreChecks"]),
    ],
    swiftLanguageModes: [.v5]
)
