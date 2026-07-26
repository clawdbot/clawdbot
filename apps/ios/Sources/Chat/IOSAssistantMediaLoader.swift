import Foundation
import OpenClawKit

struct IOSAssistantMediaLoader: Sendable {
    struct Connection: Sendable {
        let config: GatewayConnectConfig
        let storedOperatorToken: String?
        let customHeaders: [String: String]
    }

    typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    typealias RequestFactory = @Sendable (GatewayTLSParams, Int) -> Request
    typealias ConnectionProvider = @MainActor @Sendable () -> Connection?

    enum LoadError: Error, Equatable {
        case invalidSource
        case invalidResponse
        case requestFailed(statusCode: Int)
        case unsupportedMediaType
        case payloadTooLarge
    }

    static let maximumManagedImageBytes = 12 * 1024 * 1024
    static let maximumLegacyImageBytes = 10 * 1024 * 1024
    private static let managedImagePathPrefix = "/api/chat/media/outgoing/"
    private static let encodeURIComponentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    private let connectionProvider: ConnectionProvider
    private let requestFactory: RequestFactory

    init(connectionProvider: @escaping ConnectionProvider) {
        self.init(connectionProvider: connectionProvider) { tls, maximumBytes in
            let session = GatewayTLSPinningSession(params: tls)
            return {
                defer { session.finishTasksAndInvalidate() }
                return try await session.data(for: $0, maximumBytes: maximumBytes)
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

    func load(path: String) async throws -> Data {
        let imagePath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let connection = await self.connectionProvider() else { throw LoadError.invalidSource }
        let url: URL
        let maximumBytes: Int
        if imagePath.hasPrefix(Self.managedImagePathPrefix) {
            guard Self.isManagedImagePath(imagePath),
                  let managedURL = Self.managedImageURL(config: connection.config, path: imagePath)
            else { throw LoadError.invalidSource }
            url = managedURL
            maximumBytes = Self.maximumManagedImageBytes
        } else {
            guard Self.isLegacyMediaSource(imagePath),
                  let legacyURL = AuthenticatedControlUI.pageURL(
                      config: connection.config,
                      path: "/__openclaw__/assistant-media",
                      queryItems: [URLQueryItem(name: "source", value: imagePath)])
            else { throw LoadError.invalidSource }
            url = legacyURL
            maximumBytes = Self.maximumLegacyImageBytes
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        if url.scheme?.lowercased() == "https" {
            for (name, value) in GatewayCustomHeaders.sanitized(connection.customHeaders) {
                request.setValue(value, forHTTPHeaderField: name)
            }
        }
        if let bearerToken = Self.firstCredential(
            connection.config.token,
            connection.storedOperatorToken,
            connection.config.password)
        {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }

        let tls = connection.config.tls ?? GatewayTLSParams(
            required: false,
            expectedFingerprint: nil,
            allowTOFU: false,
            storeKey: nil)
        let performRequest = self.requestFactory(tls, maximumBytes)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await performRequest(request)
        } catch is GatewayBoundedDataError {
            throw LoadError.payloadTooLarge
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw LoadError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw LoadError.requestFailed(statusCode: httpResponse.statusCode)
        }
        guard httpResponse.mimeType?.lowercased().hasPrefix("image/") == true else {
            throw LoadError.unsupportedMediaType
        }
        guard data.count <= maximumBytes else {
            throw LoadError.payloadTooLarge
        }
        return data
    }

    private static func firstCredential(_ values: String?...) -> String? {
        values.lazy
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
    }

    private static func managedImageURL(config: GatewayConnectConfig, path: String) -> URL? {
        guard var components = URLComponents(url: config.url, resolvingAgainstBaseURL: false),
              components.host != nil
        else { return nil }
        switch components.scheme?.lowercased() {
        case "wss", "https":
            components.scheme = "https"
        case "ws", "http":
            components.scheme = "http"
        default:
            return nil
        }
        // Managed-image HTTP routes are mounted at the gateway origin, not
        // beneath the optional Control UI base path.
        components.percentEncodedPath = path
        components.percentEncodedQuery = nil
        components.fragment = nil
        return components.url
    }

    private static func isManagedImagePath(_ path: String) -> Bool {
        guard let components = URLComponents(string: path),
              components.scheme == nil,
              components.host == nil,
              components.query == nil,
              components.fragment == nil,
              components.percentEncodedPath == path
        else { return false }

        let segments = path.split(separator: "/", omittingEmptySubsequences: true)
        guard segments.count == 7 else { return false }
        let encodedSessionKey = String(segments[4])
        let decodedSessionKey = encodedSessionKey.removingPercentEncoding
        // Session keys can contain slashes, so require the gateway's exact
        // encodeURIComponent-style representation instead of banning %2F.
        let canonicalSessionKey = decodedSessionKey?.addingPercentEncoding(
            withAllowedCharacters: Self.encodeURIComponentAllowed)
        guard segments[0...3] == ["api", "chat", "media", "outgoing"],
              let decodedSessionKey,
              !decodedSessionKey.isEmpty,
              decodedSessionKey != ".",
              decodedSessionKey != "..",
              !decodedSessionKey.contains("\\"),
              canonicalSessionKey == encodedSessionKey,
              UUID(uuidString: String(segments[5])) != nil,
              segments[6] == "full"
        else { return false }
        return true
    }

    private static func isLegacyMediaSource(_ source: String) -> Bool {
        let lowercased = source.lowercased()
        return !source.isEmpty &&
            !lowercased.hasPrefix("http://") &&
            !lowercased.hasPrefix("https://") &&
            !lowercased.hasPrefix("data:")
    }
}
