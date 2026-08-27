// swift-tools-version: 6.3

import PackageDescription

let package = Package(
    name: "OpenClawMLXTTSProtocol",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "OpenClawMLXTTSProtocol", targets: ["OpenClawMLXTTSProtocol"]),
    ],
    targets: [
        .target(name: "OpenClawMLXTTSProtocol"),
        .testTarget(
            name: "OpenClawMLXTTSProtocolTests",
            dependencies: ["OpenClawMLXTTSProtocol"]),
    ])
