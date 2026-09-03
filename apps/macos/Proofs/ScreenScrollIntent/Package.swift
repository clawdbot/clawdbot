// swift-tools-version: 6.3
// Temporary dependency-contract proof; remove this package before landing.
import PackageDescription

let package = Package(
    name: "ScreenScrollIntentProof",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(
            url: "https://github.com/openclaw/Peekaboo.git",
            revision: "8d5e638e6ac9e93fae7d8dcb2ac0a0f01f3d49ec"),
        .package(url: "https://github.com/openclaw/AXorcist.git", exact: "0.1.8"),
    ],
    targets: [
        .testTarget(
            name: "ScreenScrollIntentProofTests",
            dependencies: [
                .product(name: "PeekabooAutomationKit", package: "Peekaboo"),
                .product(name: "PeekabooFoundation", package: "Peekaboo"),
                .product(name: "AXorcist", package: "AXorcist"),
            ]),
    ])
