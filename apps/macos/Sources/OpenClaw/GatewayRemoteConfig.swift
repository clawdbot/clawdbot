import Foundation
import OpenClawKit
#if canImport(Darwin)
import Darwin
#endif

enum GatewayRemoteConfig {
    enum TokenValue: Equatable {
        case missing
        case plaintext(String)
        case unsupportedNonString

        var textFieldValue: String {
            switch self {
            case let .plaintext(token):
                token
            case .missing, .unsupportedNonString:
                ""
            }
        }

        var isUnsupportedNonString: Bool {
            if case .unsupportedNonString = self {
                return true
            }
            return false
        }
    }

    static func resolveTransport(root: [String: Any]) -> AppState.RemoteTransport {
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any],
              let raw = remote["transport"] as? String
        else {
            return .ssh
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed == AppState.RemoteTransport.direct.rawValue ? .direct : .ssh
    }

    static func resolveUrlString(root: [String: Any]) -> String? {
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any],
              let urlRaw = remote["url"] as? String
        else {
            return nil
        }
        let trimmed = urlRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func resolveTokenValue(root: [String: Any]) -> TokenValue {
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any],
              let tokenRaw = remote["token"]
        else {
            return .missing
        }
        guard let tokenString = tokenRaw as? String else {
            return .unsupportedNonString
        }
        let trimmed = tokenString.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? .missing : .plaintext(trimmed)
    }

    static func resolveTokenString(root: [String: Any]) -> String? {
        switch self.resolveTokenValue(root: root) {
        case let .plaintext(token):
            token
        case .missing, .unsupportedNonString:
            nil
        }
    }

    static func resolvePasswordString(root: [String: Any]) -> String? {
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any],
              let raw = remote["password"] as? String
        else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func resolveTLSFingerprint(root: [String: Any]) -> String? {
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any],
              let raw = remote["tlsFingerprint"] as? String
        else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func resolveGatewayUrl(root: [String: Any]) -> URL? {
        guard let raw = self.resolveUrlString(root: root) else { return nil }
        return self.normalizeGatewayUrl(raw)
    }

    static func resolveRemotePort(root: [String: Any]) -> Int? {
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any]
        else {
            return nil
        }
        let value = remote["remotePort"]
        let port: Int? = switch value {
        case let raw as Int:
            raw
        case let raw as NSNumber:
            raw.intValue
        case let raw as String:
            Int(raw.trimmingCharacters(in: .whitespacesAndNewlines))
        default:
            nil
        }
        guard let port, port > 0, port <= 65535 else { return nil }
        return port
    }

    static func normalizeGatewayUrlString(_ raw: String) -> String? {
        self.normalizeGatewayUrl(raw)?.absoluteString
    }

    static func normalizeGatewayUrl(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return nil }
        let scheme = url.scheme?.lowercased() ?? ""
        guard scheme == "ws" || scheme == "wss" else { return nil }
        let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !host.isEmpty else { return nil }
        if scheme == "ws",
           !LoopbackHost.isLoopbackHost(host),
           !self.isTrustedPlaintextRemoteHost(host)
        {
            return nil
        }
        if scheme == "ws", url.port == nil {
            guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                return url
            }
            components.port = 18789
            return components.url
        }
        return url
    }

    static func isTrustedPlaintextRemoteHost(_ host: String) -> Bool {
        let lower = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !lower.isEmpty else { return false }
        if lower == "localhost" || lower.hasSuffix(".local") || lower.hasSuffix(".ts.net") {
            return true
        }
        if self.isPrivateIPv6Literal(lower) {
            return true
        }
        guard let parts = self.ipv4Parts(lower) else { return false }
        switch (parts[0], parts[1]) {
        case (10, _), (192, 168), (169, 254):
            return true
        case (172, 16...31):
            return true
        case (100, 64...127):
            return true
        default:
            return false
        }
    }

    private static func ipv4Parts(_ value: String) -> [Int]? {
        let labels = value.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count == 4 else { return nil }
        var parts: [Int] = []
        parts.reserveCapacity(4)
        for label in labels {
            guard !label.isEmpty,
                  label.allSatisfy(\.isNumber),
                  let part = Int(label),
                  part >= 0,
                  part <= 255
            else {
                return nil
            }
            parts.append(part)
        }
        return parts
    }

    private static func isPrivateIPv6Literal(_ value: String) -> Bool {
        #if canImport(Darwin)
        var addr = in6_addr()
        guard value.withCString({ inet_pton(AF_INET6, $0, &addr) }) == 1 else {
            return false
        }
        return value.hasPrefix("fc") || value.hasPrefix("fd") || value.hasPrefix("fe80:")
        #else
        return false
        #endif
    }

    static func defaultPort(for url: URL) -> Int? {
        if let port = url.port { return port }
        let scheme = url.scheme?.lowercased() ?? ""
        switch scheme {
        case "wss":
            return 443
        case "ws":
            return 18789
        default:
            return nil
        }
    }
}
