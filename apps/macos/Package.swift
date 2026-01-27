// swift-tools-version: 6.2
// Package manifest for the Moltbot macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "Moltbot",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "MoltbotIPC", targets: ["MoltbotIPC"]),
        .library(name: "MoltbotDiscovery", targets: ["MoltbotDiscovery"]),
        .executable(name: "Moltbot", targets: ["Moltbot"]),
        .executable(name: "moltbot-mac", targets: ["MoltbotMacCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.1.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.8.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
        .package(url: "https://github.com/steipete/Peekaboo.git", branch: "main"),
        .package(path: "../shared/ClawdbotKit"),
        .package(path: "../../Swabble"),
    ],
    targets: [
        .target(
            name: "MoltbotIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "MoltbotDiscovery",
            dependencies: [
                .product(name: "MoltbotKit", package: "MoltbotKit"),
            ],
            path: "Sources/MoltbotDiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "Moltbot",
            dependencies: [
                "MoltbotIPC",
                "MoltbotDiscovery",
                .product(name: "MoltbotKit", package: "MoltbotKit"),
                .product(name: "MoltbotChatUI", package: "MoltbotKit"),
                .product(name: "MoltbotProtocol", package: "MoltbotKit"),
                .product(name: "SwabbleKit", package: "swabble"),
                .product(name: "MenuBarExtraAccess", package: "MenuBarExtraAccess"),
                .product(name: "Subprocess", package: "swift-subprocess"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "PeekabooBridge", package: "Peekaboo"),
                .product(name: "PeekabooAutomationKit", package: "Peekaboo"),
            ],
            exclude: [
                "Resources/Info.plist",
            ],
            resources: [
                .copy("Resources/Moltbot.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "MoltbotMacCLI",
            dependencies: [
                "MoltbotDiscovery",
                .product(name: "MoltbotKit", package: "MoltbotKit"),
                .product(name: "MoltbotProtocol", package: "MoltbotKit"),
            ],
            path: "Sources/MoltbotMacCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "MoltbotIPCTests",
            dependencies: [
                "MoltbotIPC",
                "Moltbot",
                "MoltbotDiscovery",
                .product(name: "MoltbotProtocol", package: "MoltbotKit"),
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
