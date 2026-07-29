import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite("iOS managed media artifact loader")
struct IOSMediaArtifactLoaderTests {
    @Test @MainActor func `loads ticketed image with proxy headers and without a gateway bearer`() async throws {
        let gatewayURL = try #require(URL(string: "wss://gateway.example"))
        let config = Self.config(url: gatewayURL)
        let loader = IOSMediaArtifactLoader(
            connectionProvider: {
                IOSMediaArtifactLoader.Connection(
                    config: config,
                    gatewayID: config.effectiveStableID,
                    customHeaders: ["X-Proxy-Token": "proxy"])
            },
            requestFactory: { _, maximumBytes in
                #expect(maximumBytes == 12 * 1024 * 1024)
                return { request in
                    #expect(request.url?.absoluteString == Self.ticketedAbsoluteURL)
                    #expect(request.value(forHTTPHeaderField: "Accept") == "image/*")
                    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                    #expect(request.value(forHTTPHeaderField: "X-Proxy-Token") == "proxy")
                    return try Self.response(for: request, mimeType: "image/png", data: Data([1, 2, 3]))
                }
            })

        let loaded = try await loader.load(
            response: Self.downloadResult(mimeType: nil),
            kind: .image,
            expectedGatewayID: config.effectiveStableID)

        guard case let .data(media) = loaded else {
            Issue.record("image should be buffered")
            return
        }
        #expect(media.data == Data([1, 2, 3]))
        #expect(media.mimeType == "image/png")
    }

    @Test @MainActor func `returns direct video stream when route needs no pinned session`() async throws {
        let config = try Self.config(url: #require(URL(string: "wss://gateway.example")))
        let loader = IOSMediaArtifactLoader(
            connectionProvider: {
                IOSMediaArtifactLoader.Connection(
                    config: config,
                    gatewayID: config.effectiveStableID,
                    customHeaders: [:])
            },
            requestFactory: { _, _ in
                Issue.record("direct video must not be downloaded")
                return { _ in throw CancellationError() }
            })

        let loaded = try await loader.load(
            response: Self.downloadResult(mimeType: "video/mp4", sizeBytes: 4096),
            kind: .video,
            expectedGatewayID: config.effectiveStableID)

        guard case let .stream(stream) = loaded else {
            Issue.record("video should use the ticketed stream URL")
            return
        }
        #expect(stream.url.absoluteString == Self.ticketedAbsoluteURL)
        #expect(stream.mimeType == "video/mp4")
        #expect(stream.sizeBytes == 4096)
    }

    @Test @MainActor func `buffers pinned video with the bounded TLS request`() async throws {
        let tls = GatewayTLSParams(
            required: true,
            expectedFingerprint: "sha256:fixture",
            allowTOFU: false,
            storeKey: "fixture")
        let config = try Self.config(
            url: #require(URL(string: "wss://gateway.example")),
            tls: tls)
        let loader = IOSMediaArtifactLoader(
            connectionProvider: {
                IOSMediaArtifactLoader.Connection(
                    config: config,
                    gatewayID: config.effectiveStableID,
                    customHeaders: [:])
            },
            requestFactory: { receivedTLS, maximumBytes in
                #expect(receivedTLS == tls)
                #expect(maximumBytes == 16 * 1024 * 1024)
                return { request in
                    #expect(request.value(forHTTPHeaderField: "Accept") == "video/*")
                    return try Self.response(for: request, mimeType: "video/mp4", data: Data([4, 5, 6]))
                }
            })

        let loaded = try await loader.load(
            response: Self.downloadResult(mimeType: "video/mp4"),
            kind: .video,
            expectedGatewayID: config.effectiveStableID)

        guard case let .data(media) = loaded else {
            Issue.record("pinned video should be downloaded before AVPlayer")
            return
        }
        #expect(media.data == Data([4, 5, 6]))
    }

    @Test @MainActor func `buffers video when optional summary MIME is absent`() async throws {
        let config = try Self.config(url: #require(URL(string: "wss://gateway.example")))
        let loader = IOSMediaArtifactLoader(
            connectionProvider: {
                IOSMediaArtifactLoader.Connection(
                    config: config,
                    gatewayID: config.effectiveStableID,
                    customHeaders: [:])
            },
            requestFactory: { _, maximumBytes in
                #expect(maximumBytes == 16 * 1024 * 1024)
                return { request in
                    try Self.response(for: request, mimeType: "video/mp4", data: Data([7, 8, 9]))
                }
            })

        let loaded = try await loader.load(
            response: Self.downloadResult(mimeType: nil),
            kind: .video,
            expectedGatewayID: config.effectiveStableID)

        guard case let .data(media) = loaded else {
            Issue.record("untyped video should use the validated download path")
            return
        }
        #expect(media.data == Data([7, 8, 9]))
        #expect(media.mimeType == "video/mp4")
    }

    @Test @MainActor func `rejects absolute and unticketed paths before fetching`() async {
        let config = Self.config()
        let loader = IOSMediaArtifactLoader(
            connectionProvider: {
                IOSMediaArtifactLoader.Connection(
                    config: config,
                    gatewayID: config.effectiveStableID,
                    customHeaders: [:])
            },
            requestFactory: { _, _ in
                Issue.record("invalid paths must not reach the network")
                return { _ in throw CancellationError() }
            })

        await #expect(throws: IOSMediaArtifactLoader.LoadError.invalidSource) {
            try await loader.load(
                response: Self.downloadResult(
                    mimeType: "image/png",
                    url: "https://example.com/image.png?mediaTicket=ticket"),
                kind: .image,
                expectedGatewayID: config.effectiveStableID)
        }
        await #expect(throws: IOSMediaArtifactLoader.LoadError.invalidSource) {
            try await loader.load(
                response: Self.downloadResult(
                    mimeType: "image/png",
                    url: "/api/chat/media/outgoing/main/id/full"),
                kind: .image,
                expectedGatewayID: config.effectiveStableID)
        }
    }

    private static let ticketedPath =
        "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full?mediaTicket=ticket"
    private static let ticketedAbsoluteURL = "https://gateway.example\(ticketedPath)"

    private static func downloadResult(
        mimeType: String?,
        sizeBytes: Int? = nil,
        url: String = ticketedPath) -> ArtifactsDownloadResult
    {
        ArtifactsDownloadResult(
            artifact: ArtifactSummary(
                id: "artifact",
                type: "media",
                title: "Attachment",
                mimetype: mimeType,
                sizebytes: sizeBytes,
                download: ["mode": AnyCodable("url")]),
            url: url)
    }

    private static func response(
        for request: URLRequest,
        mimeType: String,
        data: Data) throws -> (Data, URLResponse)
    {
        let responseURL = try #require(request.url)
        let response = try #require(HTTPURLResponse(
            url: responseURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": mimeType]))
        return (data, response)
    }

    private static func config(
        url: URL = URL(string: "ws://127.0.0.1:18789")!,
        tls: GatewayTLSParams? = nil) -> GatewayConnectConfig
    {
        GatewayConnectConfig(
            url: url,
            stableID: "manual|127.0.0.1|18789",
            tls: tls,
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
