import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite("iOS managed media artifact loader")
struct IOSMediaArtifactLoaderTests {
    @Test(arguments: Self.gatewayRoutes)
    @MainActor func `loads ticketed image with proxy headers and without a gateway bearer`(
        route: (gateway: String, media: String)) async throws
    {
        let gatewayURL = try #require(URL(string: route.gateway))
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
                    #expect(request.url?.absoluteString == route.media + Self.ticketedPath)
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

    @Test(arguments: Self.gatewayRoutes)
    @MainActor func `returns direct video stream when route needs no pinned session`(
        route: (gateway: String, media: String)) async throws
    {
        let config = try Self.config(url: #require(URL(string: route.gateway)))
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
        #expect(stream.url.absoluteString == route.media + Self.ticketedPath)
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

    @Test(arguments: Self.gatewayRoutes)
    @MainActor func `requests playback rendition for buffered audio`(
        route: (gateway: String, media: String)) async throws
    {
        let config = try Self.config(url: #require(URL(string: route.gateway)))
        let loader = IOSMediaArtifactLoader(
            connectionProvider: {
                IOSMediaArtifactLoader.Connection(
                    config: config,
                    gatewayID: config.effectiveStableID,
                    customHeaders: [:])
            },
            requestFactory: { _, _ in
                { request in
                    #expect(request.url?.absoluteString == route.media + Self.ticketedPath + "&playback=1")
                    #expect(request.value(forHTTPHeaderField: "Range") == nil)
                    return try Self.response(
                        for: request,
                        mimeType: "audio/mp4",
                        data: Data([10, 11, 12]))
                }
            })

        let loaded = try await loader.load(
            response: Self.downloadResult(mimeType: "audio/x-caf"),
            kind: .audio,
            playback: .transcode,
            expectedGatewayID: config.effectiveStableID)

        guard case let .data(media) = loaded else {
            Issue.record("audio rendition should be buffered")
            return
        }
        #expect(media.data == Data([10, 11, 12]))
        #expect(media.mimeType == "audio/mp4")
    }

    @Test @MainActor func `transcode playback bypasses inline bytes for ticketed rendition`() async throws {
        let config = try Self.config(url: #require(URL(string: "wss://gateway.example")))
        let loader = IOSMediaArtifactLoader(
            connectionProvider: {
                IOSMediaArtifactLoader.Connection(
                    config: config,
                    gatewayID: config.effectiveStableID,
                    customHeaders: [:])
            },
            requestFactory: { _, _ in
                { request in
                    #expect(request.url?.absoluteString == Self.ticketedPlaybackAbsoluteURL)
                    return try Self.response(
                        for: request,
                        mimeType: "audio/mp4",
                        data: Data([20, 21, 22]))
                }
            })

        let loaded = try await loader.load(
            response: Self.downloadResult(
                mimeType: "audio/x-caf",
                inlineData: Data([99, 98, 97])),
            kind: .audio,
            playback: .transcode,
            expectedGatewayID: config.effectiveStableID)

        guard case let .data(media) = loaded else {
            Issue.record("transcode playback should fetch the ticketed rendition")
            return
        }
        #expect(media.data == Data([20, 21, 22]))
        #expect(media.mimeType == "audio/mp4")
    }

    @Test @MainActor func `native playback retains inline byte fast path`() async throws {
        let config = Self.config()
        let loader = IOSMediaArtifactLoader(
            connectionProvider: {
                IOSMediaArtifactLoader.Connection(
                    config: config,
                    gatewayID: config.effectiveStableID,
                    customHeaders: [:])
            },
            requestFactory: { _, _ in
                Issue.record("native inline bytes must not reach the URL path")
                return { _ in throw CancellationError() }
            })

        let loaded = try await loader.load(
            response: Self.downloadResult(
                mimeType: "audio/mpeg",
                inlineData: Data([30, 31, 32])),
            kind: .audio,
            playback: .native,
            expectedGatewayID: config.effectiveStableID)

        guard case let .data(media) = loaded else {
            Issue.record("native playback should retain inline bytes")
            return
        }
        #expect(media.data == Data([30, 31, 32]))
        #expect(media.mimeType == "audio/mpeg")
    }

    @Test @MainActor func `returns preparing for a pending streamed video rendition`() async throws {
        let config = try Self.config(url: #require(URL(string: "wss://gateway.example")))
        let loader = IOSMediaArtifactLoader(
            connectionProvider: {
                IOSMediaArtifactLoader.Connection(
                    config: config,
                    gatewayID: config.effectiveStableID,
                    customHeaders: [:])
            },
            requestFactory: { _, _ in
                { request in
                    #expect(request.url?.absoluteString == Self.ticketedPlaybackAbsoluteURL)
                    #expect(request.value(forHTTPHeaderField: "Range") == "bytes=0-0")
                    return try Self.response(
                        for: request,
                        statusCode: 202,
                        mimeType: "application/json",
                        data: Data(#"{"status":"preparing"}"#.utf8))
                }
            })

        let loaded = try await loader.load(
            response: Self.downloadResult(mimeType: "video/x-matroska"),
            kind: .video,
            playback: .transcode,
            expectedGatewayID: config.effectiveStableID)

        guard case .preparing = loaded else {
            Issue.record("pending rendition should remain in preparing state")
            return
        }
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

    private static let gatewayRoutes = [
        (gateway: "wss://gateway.example", media: "https://gateway.example"),
        (gateway: "wss://gateway.example/", media: "https://gateway.example"),
        (
            gateway: "wss://gateway.example:8443/tenant%20gateway/gw",
            media: "https://gateway.example:8443/tenant%20gateway/gw"),
        (
            gateway: "wss://gateway.example/tenant%2Fgateway//gw/",
            media: "https://gateway.example/tenant%2Fgateway//gw/"),
        (gateway: "wss://gateway.example/tenant%FFgateway/gw", media: "https://gateway.example/tenant%FFgateway/gw"),
    ]
    private static let ticketedPath =
        "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full?mediaTicket=ticket"
    private static let ticketedAbsoluteURL = "https://gateway.example\(ticketedPath)"
    private static let ticketedPlaybackAbsoluteURL = "\(ticketedAbsoluteURL)&playback=1"

    private static func downloadResult(
        mimeType: String?,
        sizeBytes: Int? = nil,
        inlineData: Data? = nil,
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
            encoding: inlineData == nil ? nil : "base64",
            data: inlineData?.base64EncodedString(),
            url: url)
    }

    private static func response(
        for request: URLRequest,
        statusCode: Int = 200,
        mimeType: String,
        data: Data) throws -> (Data, URLResponse)
    {
        let responseURL = try #require(request.url)
        let response = try #require(HTTPURLResponse(
            url: responseURL,
            statusCode: statusCode,
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
