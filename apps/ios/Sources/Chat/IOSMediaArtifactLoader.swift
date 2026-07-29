import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

struct IOSMediaArtifactLoader: Sendable {
    struct Connection: Sendable {
        let config: GatewayConnectConfig
        let gatewayID: String
        let customHeaders: [String: String]
    }

    enum LoadError: Error, Equatable {
        case invalidSource
        case invalidResponse
        case requestFailed(statusCode: Int)
        case unsupportedMediaType
        case payloadTooLarge
    }

    typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    typealias RequestFactory = @Sendable (GatewayTLSParams, Int) -> Request
    typealias ConnectionProvider = @MainActor @Sendable () -> Connection?

    static let maximumImageBytes = 12 * 1024 * 1024
    static let maximumAudioBytes = 16 * 1024 * 1024
    static let maximumVideoBytes = 16 * 1024 * 1024
    private static let managedMediaPathPrefix = "/api/chat/media/outgoing/"
    private let connectionProvider: ConnectionProvider
    private let requestFactory: RequestFactory

    init(connectionProvider: @escaping ConnectionProvider) {
        self.init(connectionProvider: connectionProvider) { tls, maximumBytes in
            let session = GatewayTLSPinningSession(params: tls)
            return { request in
                defer { session.finishTasksAndInvalidate() }
                return try await session.data(for: request, maximumBytes: maximumBytes)
            }
        }
    }

    init(
        connectionProvider: @escaping ConnectionProvider,
        requestFactory: @escaping RequestFactory)
    {
        self.connectionProvider = connectionProvider
        self.requestFactory = requestFactory
    }

    func load(
        response: ArtifactsDownloadResult,
        kind: OpenClawChatMediaKind,
        playback: OpenClawChatPlaybackMode? = nil,
        expectedGatewayID: String) async throws -> OpenClawChatLoadedMedia
    {
        let maximumBytes = Self.maximumBytes(for: kind)
        let declaredMIME = response.artifact.mimetype?.lowercased()
        if playback != .transcode,
           let encoded = response.data?.trimmingCharacters(in: .whitespacesAndNewlines),
           !encoded.isEmpty
        {
            guard response.encoding == "base64",
                  let declaredMIME,
                  declaredMIME.hasPrefix(kind.mimeTypePrefix),
                  let data = Data(base64Encoded: encoded)
            else { throw LoadError.invalidResponse }
            guard data.count <= maximumBytes else { throw LoadError.payloadTooLarge }
            return .data(OpenClawChatMediaData(data: data, mimeType: declaredMIME))
        }

        let path = response.url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let connection = await self.connectionProvider(),
              connection.gatewayID == expectedGatewayID,
              let sourceURL = Self.managedMediaURL(config: connection.config, path: path),
              let url = Self.playbackURL(sourceURL, mode: playback)
        else { throw LoadError.invalidSource }

        let headers = url.scheme?.lowercased() == "https"
            ? GatewayCustomHeaders.sanitized(connection.customHeaders)
            : [:]
        // AVPlayer cannot use the app's pinned TLS delegate or immutable proxy
        // headers. Those routes take the bounded authenticated download path.
        let canStreamDirectly = kind == .video &&
            url.scheme?.lowercased() == "https" &&
            connection.config.tls == nil &&
            headers.isEmpty &&
            declaredMIME?.hasPrefix(kind.mimeTypePrefix) == true
        if canStreamDirectly, playback != .transcode, let declaredMIME {
            return .stream(OpenClawChatMediaStream(
                url: url,
                mimeType: declaredMIME,
                sizeBytes: response.artifact.sizebytes))
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = kind == .video ? 60 : 20
        request.setValue("\(kind.rawValue)/*", forHTTPHeaderField: "Accept")
        if canStreamDirectly {
            request.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        }
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let tls = connection.config.tls ?? GatewayTLSParams(
            required: false,
            expectedFingerprint: nil,
            allowTOFU: false,
            storeKey: nil)
        let data: Data
        let urlResponse: URLResponse
        do {
            (data, urlResponse) = try await self.requestFactory(tls, maximumBytes)(request)
        } catch is GatewayBoundedDataError {
            throw LoadError.payloadTooLarge
        }
        guard let http = urlResponse as? HTTPURLResponse else { throw LoadError.invalidResponse }
        if http.statusCode == 202 {
            return .preparing
        }
        guard (200..<300).contains(http.statusCode) else {
            throw LoadError.requestFailed(statusCode: http.statusCode)
        }
        guard let mimeType = http.mimeType?.lowercased(),
              mimeType.hasPrefix(kind.mimeTypePrefix)
        else { throw LoadError.unsupportedMediaType }
        if canStreamDirectly {
            return .stream(OpenClawChatMediaStream(
                url: url,
                mimeType: mimeType,
                sizeBytes: response.artifact.sizebytes))
        }
        guard data.count <= maximumBytes else { throw LoadError.payloadTooLarge }
        return .data(OpenClawChatMediaData(data: data, mimeType: mimeType))
    }

    private static func maximumBytes(for kind: OpenClawChatMediaKind) -> Int {
        switch kind {
        case .image: self.maximumImageBytes
        case .audio: self.maximumAudioBytes
        case .video: self.maximumVideoBytes
        }
    }

    private static func managedMediaURL(config: GatewayConnectConfig, path: String) -> URL? {
        guard path.hasPrefix(self.managedMediaPathPrefix),
              let relative = URLComponents(string: path),
              relative.scheme == nil,
              relative.host == nil,
              relative.fragment == nil,
              relative.percentEncodedPath.hasPrefix(Self.managedMediaPathPrefix),
              relative.queryItems?.contains(where: {
                  $0.name == "mediaTicket" && $0.value?.isEmpty == false
              }) == true,
              var base = URLComponents(url: config.url, resolvingAgainstBaseURL: false),
              base.host != nil
        else { return nil }
        switch base.scheme?.lowercased() {
        case "wss", "https": base.scheme = "https"
        case "ws", "http": base.scheme = "http"
        default: return nil
        }
        base.percentEncodedPath = relative.percentEncodedPath
        base.percentEncodedQuery = relative.percentEncodedQuery
        base.fragment = nil
        return base.url
    }

    private static func playbackURL(_ url: URL, mode: OpenClawChatPlaybackMode?) -> URL? {
        guard mode == .transcode else { return url }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "playback" }
        queryItems.append(URLQueryItem(name: "playback", value: "1"))
        components.queryItems = queryItems
        return components.url
    }
}
