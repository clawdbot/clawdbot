// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "MoltbotKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "MoltbotProtocol", targets: ["MoltbotProtocol"]),
        .library(name: "MoltbotKit", targets: ["MoltbotKit"]),
        .library(name: "MoltbotChatUI", targets: ["MoltbotChatUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/steipete/ElevenLabsKit", exact: "0.1.0"),
        .package(url: "https://github.com/gonzalezreal/textual", exact: "0.3.1"),
    ],
    targets: [
        .target(
            name: "MoltbotProtocol",
            path: "Sources/MoltbotProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "MoltbotKit",
            dependencies: [
                "MoltbotProtocol",
                .product(name: "ElevenLabsKit", package: "ElevenLabsKit"),
            ],
            path: "Sources/MoltbotKit",
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "MoltbotChatUI",
            dependencies: [
                "MoltbotKit",
                .product(
                    name: "Textual",
                    package: "textual",
                    condition: .when(platforms: [.macOS, .iOS])),
            ],
            path: "Sources/MoltbotChatUI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "MoltbotKitTests",
            dependencies: ["MoltbotKit", "MoltbotChatUI"],
            path: "Tests/MoltbotKitTests",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
