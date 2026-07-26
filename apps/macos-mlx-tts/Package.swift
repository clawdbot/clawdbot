// swift-tools-version: 6.2
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
        .package(url: "https://github.com/Blaizzy/mlx-audio-swift", exact: "0.1.3"),
        .package(path: "../shared/OpenClawMLXTTSProtocol"),
    ],
    targets: [
        .target(
            name: "OpenClawMLXTTSRuntime",
            dependencies: [
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
