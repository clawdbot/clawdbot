import Foundation
import OpenClawChatUI
import OpenClawKit

struct IOSImageArtifactLoader: Sendable {
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
    private static let managedImagePathPrefix = "/api/chat/media/outgoing/"
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
        ticketedPath rawPath: String,
        expectedGatewayID: String) async throws -> OpenClawChatLoadedImage
    {
        let path = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let connection = await self.connectionProvider(),
              connection.gatewayID == expectedGatewayID,
              let url = Self.managedImageURL(config: connection.config, path: path)
        else { throw LoadError.invalidSource }

        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        if url.scheme?.lowercased() == "https" {
            for (name, value) in GatewayCustomHeaders.sanitized(connection.customHeaders) {
                request.setValue(value, forHTTPHeaderField: name)
            }
        }
        let tls = connection.config.tls ?? GatewayTLSParams(
            required: false,
            expectedFingerprint: nil,
            allowTOFU: false,
            storeKey: nil)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await self.requestFactory(tls, Self.maximumImageBytes)(request)
        } catch is GatewayBoundedDataError {
            throw LoadError.payloadTooLarge
        }
        guard let http = response as? HTTPURLResponse else { throw LoadError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw LoadError.requestFailed(statusCode: http.statusCode)
        }
        guard let mimeType = http.mimeType?.lowercased(), mimeType.hasPrefix("image/") else {
            throw LoadError.unsupportedMediaType
        }
        guard data.count <= Self.maximumImageBytes else { throw LoadError.payloadTooLarge }
        return OpenClawChatLoadedImage(data: data, mimeType: mimeType)
    }

    private static func managedImageURL(config: GatewayConnectConfig, path: String) -> URL? {
        guard path.hasPrefix(self.managedImagePathPrefix),
              let relative = URLComponents(string: path),
              relative.scheme == nil,
              relative.host == nil,
              relative.fragment == nil,
              relative.percentEncodedPath.hasPrefix(Self.managedImagePathPrefix),
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
}
