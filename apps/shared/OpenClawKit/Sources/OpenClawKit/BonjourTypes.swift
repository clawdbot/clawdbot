import Foundation

public enum OpenClawBonjour {
    // v0: internal-only, subject to rename.
    public static let gatewayServiceType = "_openclaw-gw._tcp"
    public static let gatewayServiceDomain = "local."
    public static var wideAreaGatewayServiceDomain: String? {
        let env = ProcessInfo.processInfo.environment
        return resolveWideAreaDomain(env["OPENCLAW_WIDE_AREA_DOMAIN"])
    }

    public static var gatewayServiceDomains: [String] {
        var domains = [gatewayServiceDomain]
        if let wideArea = wideAreaGatewayServiceDomain {
            domains.append(wideArea)
        }
        return domains
    }

    private static func resolveWideAreaDomain(_ raw: String?) -> String? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        let normalized = self.normalizeServiceDomain(trimmed)
        return normalized == self.gatewayServiceDomain ? nil : normalized
    }

    public static func normalizeServiceDomain(_ raw: String?) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return self.gatewayServiceDomain
        }

        let lower = trimmed.lowercased()
        if lower == "local" || lower == "local." {
            return self.gatewayServiceDomain
        }

        return lower.hasSuffix(".") ? lower : (lower + ".")
    }
}
