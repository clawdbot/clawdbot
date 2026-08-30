import Foundation
import Network

public enum GatewayEndpointID {
    public static func stableID(_ endpoint: NWEndpoint) -> String {
        switch endpoint {
        case let .service(name, type, domain, _):
            // Keep stable across encoded/decoded differences (e.g. \032 for spaces).
            let normalizedName = Self.normalizeServiceNameForID(name)
            return "\(type)|\(domain)|\(normalizedName)"
        default:
            return String(describing: endpoint)
        }
    }

    public static func prettyDescription(_ endpoint: NWEndpoint) -> String {
        BonjourEscapes.decode(String(describing: endpoint))
    }

    private static func normalizeServiceNameForID(_ rawName: String) -> String {
        let decoded = BonjourEscapes.decode(rawName)
        let normalized = decoded.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return normalized.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
