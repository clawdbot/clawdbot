// swift-tools-version: 6.2
// Package manifest for the Clawdbot macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "Clawdbot",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "ClawdbotIPC", targets: ["ClawdbotIPC"]),
        .library(name: "ClawdbotDiscovery", targets: ["ClawdbotDiscovery"]),
        .executable(name: "Clawdbot", targets: ["Clawdbot"]),
        .executable(name: "clawdbot-mac-discovery", targets: ["ClawdbotDiscoveryCLI"]),
        .executable(name: "clawdbot-mac-wizard", targets: ["ClawdbotWizardCLI"]),
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
            name: "ClawdbotProtocol",
            dependencies: [],
            path: "Sources/ClawdbotProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "ClawdbotIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "ClawdbotDiscovery",
            dependencies: [
                .product(name: "ClawdbotKit", package: "ClawdbotKit"),
            ],
            path: "Sources/ClawdbotDiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "Clawdbot",
            dependencies: [
                "ClawdbotIPC",
                "ClawdbotDiscovery",
                "ClawdbotProtocol",
                .product(name: "ClawdbotKit", package: "ClawdbotKit"),
                .product(name: "ClawdbotChatUI", package: "ClawdbotKit"),
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
                .copy("Resources/Clawdbot.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "ClawdbotDiscoveryCLI",
            dependencies: [
                "ClawdbotDiscovery",
            ],
            path: "Sources/ClawdbotDiscoveryCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "ClawdbotWizardCLI",
            dependencies: [
                "ClawdbotProtocol",
            ],
            path: "Sources/ClawdbotWizardCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "ClawdbotIPCTests",
            dependencies: [
                "ClawdbotIPC",
                "Clawdbot",
                "ClawdbotDiscovery",
                "ClawdbotProtocol",
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
