import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite("iOS managed image artifact loader")
struct IOSImageArtifactLoaderTests {
    @Test @MainActor func `loads ticketed image with proxy headers and without a gateway bearer`() async throws {
        let gatewayURL = try #require(URL(string: "wss://gateway.example"))
        let config = Self.config(url: gatewayURL)
        let loader = IOSImageArtifactLoader(
            connectionProvider: {
                IOSImageArtifactLoader.Connection(
                    config: config,
                    gatewayID: config.effectiveStableID,
                    customHeaders: ["X-Proxy-Token": "proxy"])
            },
            requestFactory: { _, maximumBytes in
                #expect(maximumBytes == 12 * 1024 * 1024)
                return { request in
                    #expect(request.url?.absoluteString ==
                        "https://gateway.example/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full?mediaTicket=ticket")
                    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                    #expect(request.value(forHTTPHeaderField: "X-Proxy-Token") == "proxy")
                    let responseURL = try #require(request.url)
                    let response = try #require(HTTPURLResponse(
                        url: responseURL,
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: ["Content-Type": "image/png"]))
                    return (Data([1, 2, 3]), response)
                }
            })

        let loaded = try await loader.load(
            ticketedPath:
            "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full?mediaTicket=ticket",
            expectedGatewayID: config.effectiveStableID)

        #expect(loaded.data == Data([1, 2, 3]))
        #expect(loaded.mimeType == "image/png")
    }

    @Test @MainActor func `rejects absolute and unticketed paths before fetching`() async {
        let config = Self.config()
        let loader = IOSImageArtifactLoader(
            connectionProvider: {
                IOSImageArtifactLoader.Connection(
                    config: config,
                    gatewayID: config.effectiveStableID,
                    customHeaders: [:])
            },
            requestFactory: { _, _ in
                Issue.record("invalid paths must not reach the network")
                return { _ in throw CancellationError() }
            })

        await #expect(throws: IOSImageArtifactLoader.LoadError.invalidSource) {
            try await loader.load(
                ticketedPath: "https://example.com/image.png?mediaTicket=ticket",
                expectedGatewayID: config.effectiveStableID)
        }
        await #expect(throws: IOSImageArtifactLoader.LoadError.invalidSource) {
            try await loader.load(
                ticketedPath:
                "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full",
                expectedGatewayID: config.effectiveStableID)
        }
    }

    private static func config(
        url: URL = URL(string: "ws://127.0.0.1:18789")!) -> GatewayConnectConfig
    {
        GatewayConnectConfig(
            url: url,
            stableID: "manual|127.0.0.1|18789",
            tls: nil,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Phone"))
    }
}
