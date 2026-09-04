import Foundation

private func defaultGatewayPort(tls: Bool) -> Int {
    tls ? 443 : 18789
}

private func normalizeGatewayTLSFingerprint(_ value: String?) -> String? {
    guard var value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
        return nil
    }
    if value.lowercased().hasPrefix("sha256:") {
        value.removeFirst("sha256:".count)
    }
    value = value.replacingOccurrences(of: ":", with: "")
    guard value.count == 64, value.allSatisfy(\.isHexDigit) else { return nil }
    return value.lowercased()
}

private func isGatewaySetupExpiryValid(_ expiresAtMs: Int64?) -> Bool {
    guard let expiresAtMs else { return true }
    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    return expiresAtMs > nowMs
}

private func normalizeGatewayContextPath(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    let path = value.hasPrefix("/") ? value : "/\(value)"
    guard path != "/" else { return nil }
    // Keep valid escapes such as %2F and %FF intact because decoding them can
    // change segment boundaries or reject valid non-UTF-8 path octets.
    let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "%?#"))
    var encoded = ""
    var index = path.startIndex
    while index < path.endIndex {
        if path[index] == "%" {
            let first = path.index(after: index)
            if first < path.endIndex {
                let second = path.index(after: first)
                if second < path.endIndex,
                   path[first].isHexDigit,
                   path[second].isHexDigit
                {
                    let end = path.index(after: second)
                    encoded.append(contentsOf: path[index..<end])
                    index = end
                    continue
                }
            }
            encoded.append("%25")
            index = path.index(after: index)
            continue
        }
        let nextPercent = path[index...].firstIndex(of: "%") ?? path.endIndex
        guard let segment = String(path[index..<nextPercent])
            .addingPercentEncoding(withAllowedCharacters: allowed)
        else { return nil }
        encoded.append(segment)
        index = nextPercent
    }
    return encoded
}

extension Character {
    fileprivate var isHexDigit: Bool {
        guard self.unicodeScalars.count == 1, let value = self.unicodeScalars.first?.value else {
            return false
        }
        return (48...57).contains(value) ||
            (65...70).contains(value) ||
            (97...102).contains(value)
    }
}

public enum DeepLinkRoute: Sendable, Equatable {
    case agent(AgentDeepLink)
    case gateway(GatewayConnectDeepLink)
    case dashboard
}

public struct GatewayConnectDeepLink: Codable, Sendable, Equatable {
    private static let maximumSetupEndpoints = 8
    private static let pairingSetupURLPrefix = "oc-pair://"

    private enum CodingKeys: String, CodingKey {
        case host
        case port
        case tls
        case contextPath
        case tlsFingerprintSha256
        case expiresAtMs
        case bootstrapToken
        case token
        case password
        case fallbackEndpoints
    }

    private struct SetupPayload: Decodable {
        let url: String?
        let urls: [String]?
        let host: String?
        let port: Int?
        let tls: Bool?
        let tlsFingerprint: String?
        let expiresAtMs: Int64?
        let bootstrapToken: String?
        let token: String?
        let password: String?
    }

    public let host: String
    public let port: Int
    public let tls: Bool
    public let contextPath: String?
    public let tlsFingerprintSha256: String?
    public let expiresAtMs: Int64?
    public let bootstrapToken: String?
    public let token: String?
    public let password: String?
    public let fallbackEndpoints: [GatewayConnectEndpoint]
    private var hasInvalidTLSFingerprint = false

    public init(
        host: String,
        port: Int,
        tls: Bool,
        contextPath: String? = nil,
        tlsFingerprintSha256: String? = nil,
        expiresAtMs: Int64? = nil,
        bootstrapToken: String?,
        token: String?,
        password: String?,
        fallbackEndpoints: [GatewayConnectEndpoint] = [])
    {
        self.host = host
        self.port = port
        self.tls = tls
        self.contextPath = normalizeGatewayContextPath(contextPath)
        let normalizedTLSFingerprint = normalizeGatewayTLSFingerprint(tlsFingerprintSha256)
        self.tlsFingerprintSha256 = normalizedTLSFingerprint
        self.hasInvalidTLSFingerprint = tlsFingerprintSha256 != nil && normalizedTLSFingerprint == nil
        self.expiresAtMs = expiresAtMs
        self.bootstrapToken = bootstrapToken
        self.token = token
        self.password = password
        self.fallbackEndpoints = fallbackEndpoints
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.host = try container.decode(String.self, forKey: .host)
        self.port = try container.decode(Int.self, forKey: .port)
        self.tls = try container.decode(Bool.self, forKey: .tls)
        self.contextPath = try normalizeGatewayContextPath(
            container.decodeIfPresent(String.self, forKey: .contextPath))
        let rawTLSFingerprint = try container.decodeIfPresent(String.self, forKey: .tlsFingerprintSha256)
        let tlsFingerprintSha256 = normalizeGatewayTLSFingerprint(rawTLSFingerprint)
        if rawTLSFingerprint != nil, tlsFingerprintSha256 == nil {
            throw DecodingError.dataCorruptedError(
                forKey: .tlsFingerprintSha256,
                in: container,
                debugDescription: "Expected a SHA-256 certificate fingerprint.")
        }
        if !self.tls, tlsFingerprintSha256 != nil {
            throw DecodingError.dataCorruptedError(
                forKey: .tlsFingerprintSha256,
                in: container,
                debugDescription: "A certificate fingerprint requires TLS.")
        }
        self.tlsFingerprintSha256 = tlsFingerprintSha256
        self.expiresAtMs = try container.decodeIfPresent(Int64.self, forKey: .expiresAtMs)
        if !isGatewaySetupExpiryValid(self.expiresAtMs) {
            throw DecodingError.dataCorruptedError(
                forKey: .expiresAtMs,
                in: container,
                debugDescription: "The gateway setup payload has expired.")
        }
        self.bootstrapToken = try container.decodeIfPresent(String.self, forKey: .bootstrapToken)
        self.token = try container.decodeIfPresent(String.self, forKey: .token)
        self.password = try container.decodeIfPresent(String.self, forKey: .password)
        self.fallbackEndpoints = try container.decodeIfPresent(
            [GatewayConnectEndpoint].self,
            forKey: .fallbackEndpoints) ?? []
    }

    public var websocketURL: URL? {
        self.connectionEndpoints.first?.websocketURL
    }

    public var isValidEndpoint: Bool {
        guard !self.hasInvalidTLSFingerprint,
              isGatewaySetupExpiryValid(self.expiresAtMs),
              (1...65535).contains(self.port),
              self.websocketURL?.host != nil
        else { return false }
        return (self.tls || self.tlsFingerprintSha256 == nil) &&
            (self.tls || LoopbackHost.isLocalNetworkHost(self.host))
    }

    public var connectionEndpoints: [GatewayConnectEndpoint] {
        [.init(host: self.host, port: self.port, tls: self.tls, contextPath: self.contextPath)] +
            self.fallbackEndpoints
    }

    public func selectingEndpoint(_ endpoint: GatewayConnectEndpoint) -> GatewayConnectDeepLink {
        // A setup pin proves only the primary direct endpoint. Proxy fallbacks must use
        // their own system trust instead of inheriting a certificate identity they do not own.
        let tlsFingerprintSha256 = endpoint == self.connectionEndpoints.first
            ? self.tlsFingerprintSha256
            : nil
        return .init(
            host: endpoint.host,
            port: endpoint.port,
            tls: endpoint.tls,
            contextPath: endpoint.contextPath,
            tlsFingerprintSha256: tlsFingerprintSha256,
            expiresAtMs: self.expiresAtMs,
            bootstrapToken: self.bootstrapToken,
            token: self.token,
            password: self.password)
    }

    /// Parse a gateway setup input from the QR/scanner/manual entry surfaces.
    ///
    /// Accepted inputs are:
    /// - device-pair setup code (base64url-encoded JSON)
    /// - raw setup JSON
    /// - a copied message containing a `Setup code:` line
    /// - an `openclaw://gateway?...` deep link
    /// - a raw `ws://` or `wss://` gateway URL
    public static func fromSetupInput(_ input: String) -> GatewayConnectDeepLink? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let link = fromSetupCode(trimmed) {
            return link
        }
        if let url = URL(string: trimmed),
           let route = DeepLinkParser.parse(url),
           case let .gateway(link) = route
        {
            return link
        }
        return self.fromGatewayURLString(
            trimmed,
            tlsFingerprintSha256: nil,
            bootstrapToken: nil,
            token: nil,
            password: nil)
    }

    /// Parse a gateway setup payload from a device-pair setup code or copied setup text.
    ///
    /// Accepted inputs are:
    /// - base64url-encoded setup JSON
    /// - raw setup JSON
    /// - copied text/message content containing one or more extractable setup-code candidates
    ///
    /// Accepted payload shapes are:
    /// - `{url, urls?, tlsFingerprint?, expiresAtMs?, bootstrapToken?, token?, password?}`
    /// - `{host, port?, tls?, tlsFingerprint?, expiresAtMs?, bootstrapToken?, token?, password?}`
    ///
    /// URL-based payloads provide the primary gateway WebSocket URL via `url`, with optional
    /// ordered candidates in `urls`. Host-based payloads provide `host` plus optional `port`
    /// and `tls`. In both cases, the optional `tlsFingerprint`, `expiresAtMs`, `bootstrapToken`,
    /// `token`, and `password` fields are also supported.
    public static func fromSetupCode(_ code: String) -> GatewayConnectDeepLink? {
        var trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.range(
            of: self.pairingSetupURLPrefix,
            options: [.anchored, .caseInsensitive]) != nil
        {
            trimmed = String(trimmed.dropFirst(self.pairingSetupURLPrefix.count))
        }
        if let link = decodeSetupPayload(from: Data(trimmed.utf8)) {
            return link
        }
        if let data = decodeBase64Url(trimmed),
           let link = decodeSetupPayload(from: data)
        {
            return link
        }
        for candidate in self.setupCodeCandidates(in: trimmed) where candidate != trimmed {
            if let data = decodeBase64Url(candidate),
               let link = decodeSetupPayload(from: data)
            {
                return link
            }
        }
        return nil
    }

    private static func decodeSetupPayload(from data: Data) -> GatewayConnectDeepLink? {
        guard let payload = try? JSONDecoder().decode(SetupPayload.self, from: data) else { return nil }
        guard isGatewaySetupExpiryValid(payload.expiresAtMs) else { return nil }
        let tlsFingerprintSha256 = normalizeGatewayTLSFingerprint(payload.tlsFingerprint)
        if payload.tlsFingerprint != nil, tlsFingerprintSha256 == nil {
            return nil
        }
        var urlCandidates = payload.url.map { [$0] } ?? []
        for candidate in payload.urls ?? [] {
            guard urlCandidates.count < self.maximumSetupEndpoints else { break }
            if !urlCandidates.contains(candidate) {
                urlCandidates.append(candidate)
            }
        }
        var seenURLs = Set<String>()
        let links = urlCandidates.enumerated().compactMap { index, rawURL -> GatewayConnectDeepLink? in
            let url = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !url.isEmpty, seenURLs.insert(url).inserted else { return nil }
            return self.fromGatewayURLString(
                url,
                tlsFingerprintSha256: index == 0 ? tlsFingerprintSha256 : nil,
                expiresAtMs: payload.expiresAtMs,
                bootstrapToken: payload.bootstrapToken,
                token: payload.token,
                password: payload.password)
        }
        if let primary = links.first {
            let fallbacks = links.dropFirst().map {
                GatewayConnectEndpoint(
                    host: $0.host,
                    port: $0.port,
                    tls: $0.tls,
                    contextPath: $0.contextPath)
            }
            return GatewayConnectDeepLink(
                host: primary.host,
                port: primary.port,
                tls: primary.tls,
                contextPath: primary.contextPath,
                tlsFingerprintSha256: primary.tlsFingerprintSha256,
                expiresAtMs: primary.expiresAtMs,
                bootstrapToken: primary.bootstrapToken,
                token: primary.token,
                password: primary.password,
                fallbackEndpoints: fallbacks)
        }
        guard let host = payload.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty
        else {
            return nil
        }
        let tls = payload.tls ?? true
        if !tls, tlsFingerprintSha256 != nil {
            return nil
        }
        if !tls, !LoopbackHost.isLocalNetworkHost(host) {
            return nil
        }
        return GatewayConnectDeepLink.validated(
            host: host,
            port: payload.port ?? defaultGatewayPort(tls: tls),
            tls: tls,
            tlsFingerprintSha256: tlsFingerprintSha256,
            expiresAtMs: payload.expiresAtMs,
            bootstrapToken: payload.bootstrapToken,
            token: payload.token,
            password: payload.password)
    }

    private static func fromGatewayURLString(
        _ urlString: String,
        tlsFingerprintSha256: String?,
        expiresAtMs: Int64? = nil,
        bootstrapToken: String?,
        token: String?,
        password: String?) -> GatewayConnectDeepLink?
    {
        guard let parsed = URLComponents(string: urlString),
              let hostname = parsed.host, !hostname.isEmpty,
              parsed.user == nil,
              parsed.password == nil,
              parsed.query == nil,
              parsed.fragment == nil
        else { return nil }

        let scheme = (parsed.scheme ?? "ws").lowercased()
        guard scheme == "ws" || scheme == "wss" || scheme == "http" || scheme == "https" else {
            return nil
        }
        let tls = scheme == "wss" || scheme == "https"
        if !tls, tlsFingerprintSha256 != nil {
            return nil
        }
        if !tls, !LoopbackHost.isLocalNetworkHost(hostname) {
            return nil
        }
        return GatewayConnectDeepLink.validated(
            host: hostname,
            port: parsed.port ?? defaultGatewayPort(tls: tls),
            tls: tls,
            contextPath: parsed.percentEncodedPath,
            tlsFingerprintSha256: tlsFingerprintSha256,
            expiresAtMs: expiresAtMs,
            bootstrapToken: bootstrapToken,
            token: token,
            password: password)
    }

    fileprivate static func validated(
        host: String,
        port: Int,
        tls: Bool,
        contextPath: String? = nil,
        tlsFingerprintSha256: String? = nil,
        expiresAtMs: Int64? = nil,
        bootstrapToken: String?,
        token: String?,
        password: String?) -> GatewayConnectDeepLink?
    {
        let link = GatewayConnectDeepLink(
            host: host,
            port: port,
            tls: tls,
            contextPath: contextPath,
            tlsFingerprintSha256: tlsFingerprintSha256,
            expiresAtMs: expiresAtMs,
            bootstrapToken: bootstrapToken,
            token: token,
            password: password)
        return link.isValidEndpoint ? link : nil
    }

    private static func decodeBase64Url(_ input: String) -> Data? {
        var base64 = input
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64.append(contentsOf: String(repeating: "=", count: 4 - remainder))
        }
        return Data(base64Encoded: base64)
    }

    private static func setupCodeCandidates(in input: String) -> [String] {
        let surroundingPunctuation = CharacterSet(charactersIn: "`'\"“”‘’()[]{}<>.,;:")
        return input
            .components(separatedBy: .whitespacesAndNewlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines.union(surroundingPunctuation)) }
            .filter { candidate in
                guard candidate.count >= 24 else { return false }
                return candidate.allSatisfy { ch in
                    ch.isLetter || ch.isNumber || ch == "-" || ch == "_" || ch == "="
                }
            }
    }
}

public struct GatewayConnectEndpoint: Codable, Sendable, Equatable {
    private enum CodingKeys: String, CodingKey {
        case host
        case port
        case tls
        case contextPath
    }

    public let host: String
    public let port: Int
    public let tls: Bool
    public let contextPath: String?

    public init(host: String, port: Int, tls: Bool, contextPath: String? = nil) {
        self.host = host
        self.port = port
        self.tls = tls
        self.contextPath = normalizeGatewayContextPath(contextPath)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.host = try container.decode(String.self, forKey: .host)
        self.port = try container.decode(Int.self, forKey: .port)
        self.tls = try container.decode(Bool.self, forKey: .tls)
        self.contextPath = try normalizeGatewayContextPath(
            container.decodeIfPresent(String.self, forKey: .contextPath))
    }

    public var websocketURL: URL? {
        guard (1...65535).contains(self.port) else { return nil }
        var components = URLComponents()
        components.scheme = self.tls ? "wss" : "ws"
        components.host = self.host
        components.port = self.port
        components.percentEncodedPath = self.contextPath ?? ""
        return components.url
    }
}

public struct AgentDeepLink: Codable, Sendable, Equatable {
    public let message: String
    public let sessionKey: String?
    public let thinking: String?
    public let deliver: Bool
    public let to: String?
    public let channel: String?
    public let timeoutSeconds: Int?
    public let key: String?

    public init(
        message: String,
        sessionKey: String?,
        thinking: String?,
        deliver: Bool,
        to: String?,
        channel: String?,
        timeoutSeconds: Int?,
        key: String?)
    {
        self.message = message
        self.sessionKey = sessionKey
        self.thinking = thinking
        self.deliver = deliver
        self.to = to
        self.channel = channel
        self.timeoutSeconds = timeoutSeconds
        self.key = key
    }
}

public enum DeepLinkParser {
    public static func parse(_ url: URL) -> DeepLinkRoute? {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "openclaw" || scheme == "openclaw-debug"
        else {
            return nil
        }
        guard let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }

        let query = (comps.queryItems ?? []).reduce(into: [String: String]()) { dict, item in
            guard let value = item.value else { return }
            dict[item.name] = value
        }

        switch host {
        case "agent":
            guard let message = query["message"],
                  !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                return nil
            }
            let deliver = (query["deliver"] as NSString?)?.boolValue ?? false
            let timeoutSeconds = query["timeoutSeconds"].flatMap { Int($0) }.flatMap { $0 >= 0 ? $0 : nil }
            return .agent(
                .init(
                    message: message,
                    sessionKey: query["sessionKey"],
                    thinking: query["thinking"],
                    deliver: deliver,
                    to: query["to"],
                    channel: query["channel"],
                    timeoutSeconds: timeoutSeconds,
                    key: query["key"]))

        case "gateway":
            guard let hostParam = query["host"],
                  !hostParam.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                return nil
            }
            let tls = (query["tls"] as NSString?)?.boolValue ?? false
            let port: Int
            if let rawPort = query["port"] {
                guard let parsedPort = Int(rawPort) else { return nil }
                port = parsedPort
            } else {
                port = defaultGatewayPort(tls: tls)
            }
            if !tls, !LoopbackHost.isLocalNetworkHost(hostParam) {
                return nil
            }
            guard let link = GatewayConnectDeepLink.validated(
                host: hostParam,
                port: port,
                tls: tls,
                bootstrapToken: nil,
                token: query["token"],
                password: query["password"])
            else {
                return nil
            }
            return .gateway(link)

        case "dashboard":
            return .dashboard

        default:
            return nil
        }
    }
}
