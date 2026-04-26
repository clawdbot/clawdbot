import Foundation
import OpenClawProtocol
import UniformTypeIdentifiers

actor MacNodeBrowserProxy {
    static let shared = MacNodeBrowserProxy()

    struct Endpoint {
        let baseURL: URL
        let token: String?
        let password: String?
    }

    private struct RequestParams: Decodable {
        let method: String?
        let path: String?
        let query: [String: OpenClawProtocol.AnyCodable]?
        let body: OpenClawProtocol.AnyCodable?
        let timeoutMs: Int?
        let profile: String?
    }

    private struct ProxyFilePayload {
        let path: String
        let base64: String
        let mimeType: String?

        func asJSON() -> [String: Any] {
            var json: [String: Any] = [
                "path": self.path,
                "base64": self.base64,
            ]
            if let mimeType = self.mimeType {
                json["mimeType"] = mimeType
            }
            return json
        }
    }

    private static let maxProxyFileBytes = 10 * 1024 * 1024
    private let endpointProvider: @Sendable () -> Endpoint
    private let performRequest: @Sendable (URLRequest) async throws -> (Data, URLResponse)

    init(
        session: URLSession = .shared,
        endpointProvider: (@Sendable () -> Endpoint)? = nil,
        performRequest: (@Sendable (URLRequest) async throws -> (Data, URLResponse))? = nil)
    {
        self.endpointProvider = endpointProvider ?? MacNodeBrowserProxy.defaultEndpoint
        self.performRequest = performRequest ?? { request in
            try await session.data(for: request)
        }
    }

    func request(paramsJSON: String?) async throws -> String {
        let params = try Self.decodeRequestParams(from: paramsJSON)
        let endpoint = self.endpointProvider()
        let request = try Self.makeRequest(params: params, endpoint: endpoint)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await self.performRequest(request)
        } catch {
            throw Self.unavailableError(endpoint: endpoint, cause: error)
        }
        let http = try Self.requireHTTPResponse(response)
        guard (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "MacNodeBrowserProxy", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: Self.httpErrorMessage(statusCode: http.statusCode, data: data),
            ])
        }

        let result = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        let files = try Self.loadProxyFiles(from: result)
        var payload: [String: Any] = ["result": result]
        if !files.isEmpty {
            payload["files"] = files.map { $0.asJSON() }
        }
        let payloadData = try JSONSerialization.data(withJSONObject: payload)
        guard let payloadJSON = String(data: payloadData, encoding: .utf8) else {
            throw NSError(domain: "MacNodeBrowserProxy", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "browser proxy returned invalid UTF-8",
            ])
        }
        return payloadJSON
    }

    private static func defaultEndpoint() -> Endpoint {
        let config = GatewayEndpointStore.localConfig()
        let controlPort = GatewayEnvironment.gatewayPort() + 2
        let baseURL = URL(string: "http://127.0.0.1:\(controlPort)")!
        return Endpoint(baseURL: baseURL, token: config.token, password: config.password)
    }

    private static func decodeRequestParams(from raw: String?) throws -> RequestParams {
        guard let raw else {
            throw NSError(domain: "MacNodeBrowserProxy", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: paramsJSON required",
            ])
        }
        return try JSONDecoder().decode(RequestParams.self, from: Data(raw.utf8))
    }

    private static func makeRequest(params: RequestParams, endpoint: Endpoint) throws -> URLRequest {
        let method = (params.method ?? "GET").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let path = (params.path ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else {
            throw NSError(domain: "MacNodeBrowserProxy", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: path required",
            ])
        }

        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        guard var components = URLComponents(
            url: endpoint.baseURL.appendingPathComponent(String(normalizedPath.dropFirst())),
            resolvingAgainstBaseURL: false)
        else {
            throw NSError(domain: "MacNodeBrowserProxy", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: invalid browser proxy URL",
            ])
        }

        var queryItems: [URLQueryItem] = []
        if let query = params.query {
            for key in query.keys.sorted() {
                let value = query[key]?.value
                guard value != nil, !(value is NSNull) else { continue }
                queryItems.append(URLQueryItem(name: key, value: Self.stringValue(for: value)))
            }
        }
        let profile = params.profile?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !profile.isEmpty, !queryItems.contains(where: { $0.name == "profile" }) {
            queryItems.append(URLQueryItem(name: "profile", value: profile))
        }
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }
        guard let url = components.url else {
            throw NSError(domain: "MacNodeBrowserProxy", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: invalid browser proxy URL",
            ])
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = params.timeoutMs.map { TimeInterval(max($0, 1)) / 1000 } ?? 5
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = endpoint.token?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        } else if let password = endpoint.password?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !password.isEmpty
        {
            request.setValue(password, forHTTPHeaderField: "x-openclaw-password")
        }

        if method != "GET", let body = params.body {
            request.httpBody = try JSONSerialization.data(
                withJSONObject: body.foundationValue,
                options: [.fragmentsAllowed])
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        return request
    }

    private static func requireHTTPResponse(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else {
            throw NSError(domain: "MacNodeBrowserProxy", code: 6, userInfo: [
                NSLocalizedDescriptionKey: "browser proxy returned a non-HTTP response",
            ])
        }
        return http
    }

    private static func unavailableError(endpoint: Endpoint, cause: Error) -> NSError {
        let url = endpoint.baseURL.absoluteString
        let message = """
        UNAVAILABLE: macOS app node could not reach the local browser control service at \(url). \
        In remote mode, browser control is owned by the CLI node-host; start `openclaw node start` \
        on this Mac and target that browser node. Underlying error: \(cause.localizedDescription)
        """
        return NSError(domain: "MacNodeBrowserProxy", code: 9, userInfo: [
            NSLocalizedDescriptionKey: message,
            NSUnderlyingErrorKey: cause,
        ])
    }

    private static func httpErrorMessage(statusCode: Int, data: Data) -> String {
        if let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any],
           let error = object["error"] as? String,
           !error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return error
        }
        if let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !text.isEmpty
        {
            return text
        }
        return "HTTP \(statusCode)"
    }

    private static func stringValue(for value: Any?) -> String? {
        guard let value else { return nil }
        if let string = value as? String { return string }
        if let bool = value as? Bool { return bool ? "true" : "false" }
        if let number = value as? NSNumber { return number.stringValue }
        return String(describing: value)
    }

    private static func loadProxyFiles(from result: Any) throws -> [ProxyFilePayload] {
        let paths = self.collectProxyPaths(from: result)
        return try paths.map(self.loadProxyFile)
    }

    private static func collectProxyPaths(from payload: Any) -> [String] {
        guard let object = payload as? [String: Any] else { return [] }

        var paths = Set<String>()
        if let path = object["path"] as? String, !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            paths.insert(path.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if let imagePath = object["imagePath"] as? String,
           !imagePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            paths.insert(imagePath.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if let download = object["download"] as? [String: Any],
           let path = download["path"] as? String,
           !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            paths.insert(path.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return paths.sorted()
    }

    private static func loadProxyFile(path: String) throws -> ProxyFilePayload {
        let url = URL(fileURLWithPath: path)
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else {
            throw NSError(domain: "MacNodeBrowserProxy", code: 7, userInfo: [
                NSLocalizedDescriptionKey: "browser proxy file not found: \(path)",
            ])
        }
        if let fileSize = values.fileSize, fileSize > Self.maxProxyFileBytes {
            throw NSError(domain: "MacNodeBrowserProxy", code: 8, userInfo: [
                NSLocalizedDescriptionKey: "browser proxy file exceeds 10MB: \(path)",
            ])
        }

        let data = try Data(contentsOf: url)
        let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
        return ProxyFilePayload(path: path, base64: data.base64EncodedString(), mimeType: mimeType)
    }
}
