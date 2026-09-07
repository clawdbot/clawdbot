import Foundation

/// Operator-defined HTTP headers attached to every gateway-bound request so gateways fronted
/// by authenticating reverse proxies (Cloudflare Access-style service tokens) stay reachable.
/// Header values are credentials: persist them in the platform secure store and never log them.
public enum GatewayCustomHeaders {
    /// Connection-management headers the WebSocket upgrade owns. Operator overrides here would
    /// corrupt the handshake or smuggle conflicting transport state past URLSession.
    private static let reservedNames: Set<String> = [
        "connection", "content-length", "host", "proxy-connection", "upgrade",
    ]
    private static let reservedPrefix = "sec-websocket-"
    private static let tokenPunctuation = Set("!#$%&'*+-.^_`|~".utf8)

    public static func isReservedName(_ name: String) -> Bool {
        let normalized = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return self.reservedNames.contains(normalized) || normalized.hasPrefix(self.reservedPrefix)
    }

    /// Drops entries that cannot travel as a single well-formed header: empty, reserved, or
    /// non-token names, and values with control characters (request-splitting guard).
    public static func sanitized(_ headers: [String: String]) -> [String: String] {
        var result: [String: String] = [:]
        for (name, value) in headers {
            let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedName.isEmpty,
                  !self.isReservedName(trimmedName),
                  self.isValidName(trimmedName),
                  !self.containsControlCharacters(value)
            else { continue }
            result[trimmedName] = value
        }
        return result
    }

    private static func isValidName(_ name: String) -> Bool {
        name.utf8.allSatisfy { byte in
            switch byte {
            case 48...57, 65...90, 97...122:
                true
            default:
                self.tokenPunctuation.contains(byte)
            }
        }
    }

    private static func containsControlCharacters(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0.properties.generalCategory == .control }
    }
}
