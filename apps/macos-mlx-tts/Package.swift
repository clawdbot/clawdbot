// swift-tools-version: 6.3
// Isolated MLX TTS helper package. Keep this out of apps/macos/Package.swift so
// normal macOS app tests do not compile the full MLX audio stack.

import PackageDescription

let package = Package(
    name: "OpenClawMLXTTS",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "openclaw-mlx-tts", targets: ["OpenClawMLXTTSHelper"]),
    ],
    dependencies: [
        // Progressive Fish chunks and cancellation from upstream PR #237.
        .package(
            url: "https://github.com/Blaizzy/mlx-audio-swift",
            revision: "2de211cf80ada19a75f291e491430e2af8e4befe"),
        .package(path: "../shared/OpenClawMLXTTSProtocol"),
    ],
    targets: [
        .target(
            name: "OpenClawMLXTTSRuntime",
            dependencies: [
                .product(name: "MLXAudioCore", package: "mlx-audio-swift"),
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
                .product(name: "OpenClawMLXTTSProtocol", package: "OpenClawMLXTTSProtocol"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "OpenClawMLXTTSHelper",
            dependencies: [
                "OpenClawMLXTTSRuntime",
                .product(name: "OpenClawMLXTTSProtocol", package: "OpenClawMLXTTSProtocol"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "OpenClawMLXTTSRuntimeTests",
            dependencies: [
                "OpenClawMLXTTSRuntime",
                .product(name: "OpenClawMLXTTSProtocol", package: "OpenClawMLXTTSProtocol"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
    ])
