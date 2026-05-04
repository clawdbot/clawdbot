import Foundation

public enum DeepLinkRoute: Sendable, Equatable {
    case agent(AgentDeepLink)
    case gateway(GatewayConnectDeepLink)
}

public struct GatewayConnectDeepLink: Codable, Sendable, Equatable {
    private struct SetupPayload: Decodable {
        let url: String?
        let host: String?
        let port: Int?
        let tls: Bool?
        let bootstrapToken: String?
        let token: String?
        let password: String?
    }

    public let host: String
    public let port: Int
    public let tls: Bool
    public let bootstrapToken: String?
    public let token: String?
    public let password: String?

    public init(host: String, port: Int, tls: Bool, bootstrapToken: String?, token: String?, password: String?) {
        self.host = host
        self.port = port
        self.tls = tls
        self.bootstrapToken = bootstrapToken
        self.token = token
        self.password = password
    }

    public var websocketURL: URL? {
        let scheme = self.tls ? "wss" : "ws"
        return URL(string: "\(scheme)://\(self.host):\(self.port)")
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
        return fromGatewayURLString(
            trimmed,
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
    /// - `{url, bootstrapToken?, token?, password?}`
    /// - `{host, port?, tls?, bootstrapToken?, token?, password?}`
    ///
    /// URL-based payloads provide the gateway WebSocket URL via `url`. Host-based payloads
    /// provide `host` plus optional `port` and `tls`. In both cases, the optional
    /// `bootstrapToken`, `token`, and `password` fields are also supported.
    public static func fromSetupCode(_ code: String) -> GatewayConnectDeepLink? {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let link = decodeSetupPayload(from: Data(trimmed.utf8)) {
            return link
        }
        if let data = decodeBase64Url(trimmed),
           let link = decodeSetupPayload(from: data)
        {
            return link
        }
        for candidate in setupCodeCandidates(in: trimmed) where candidate != trimmed {
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
        if let urlString = payload.url?.trimmingCharacters(in: .whitespacesAndNewlines),
           !urlString.isEmpty
        {
            return fromGatewayURLString(
                urlString,
                bootstrapToken: payload.bootstrapToken,
                token: payload.token,
                password: payload.password)
        }
        guard let host = payload.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty
        else {
            return nil
        }
        let tls = payload.tls ?? true
        if !tls, !LoopbackHost.isLoopbackHost(host) {
            return nil
        }
        return GatewayConnectDeepLink(
            host: host,
            port: payload.port ?? (tls ? 443 : 18789),
            tls: tls,
            bootstrapToken: payload.bootstrapToken,
            token: payload.token,
            password: payload.password)
    }

    private static func fromGatewayURLString(
        _ urlString: String,
        bootstrapToken: String?,
        token: String?,
        password: String?) -> GatewayConnectDeepLink?
    {
        guard let parsed = URLComponents(string: urlString),
              let hostname = parsed.host, !hostname.isEmpty
        else { return nil }

        let scheme = (parsed.scheme ?? "ws").lowercased()
        guard scheme == "ws" || scheme == "wss" || scheme == "http" || scheme == "https" else {
            return nil
        }
        let tls = scheme == "wss" || scheme == "https"
        if !tls, !LoopbackHost.isLoopbackHost(hostname) {
            return nil
        }
        return GatewayConnectDeepLink(
            host: hostname,
            port: parsed.port ?? (tls ? 443 : 18789),
            tls: tls,
            bootstrapToken: bootstrapToken,
            token: token,
            password: password)
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
              scheme == "openclaw"
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
            let port = query["port"].flatMap { Int($0) } ?? 18789
            let tls = (query["tls"] as NSString?)?.boolValue ?? false
            if !tls, !LoopbackHost.isLoopbackHost(hostParam) {
                return nil
            }
            return .gateway(
                .init(
                    host: hostParam,
                    port: port,
                    tls: tls,
                    bootstrapToken: nil,
                    token: query["token"],
                    password: query["password"]))

        default:
            return nil
        }
    }
}
