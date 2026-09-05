import Foundation

public enum GatewayPluginSurfaceURL {
    static func resolveHTTPURL(
        raw: String,
        against activeGatewayURL: URL?,
        relativeToGatewayContext: Bool = false) -> URL?
    {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let absolute = URL(string: trimmed),
           let scheme = absolute.scheme?.lowercased()
        {
            return scheme == "http" || scheme == "https" ? absolute : nil
        }
        if relativeToGatewayContext {
            guard let activeGatewayURL,
                  var gateway = URLComponents(url: activeGatewayURL, resolvingAgainstBaseURL: false),
                  let scheme = gateway.scheme?.lowercased(), scheme == "ws" || scheme == "wss",
                  gateway.host != nil, gateway.user == nil, gateway.password == nil,
                  let reference = URLComponents(string: trimmed), reference.host == nil,
                  !reference.path.isEmpty,
                  !reference.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." })
            else { return nil }
            // Setup endpoints name a Gateway mount; arbitrary WebSocket paths do not.
            // Explicit callers keep encoded namespace bytes and never deduplicate prefixes.
            gateway.scheme = scheme == "wss" ? "https" : "http"
            gateway.percentEncodedPath += (gateway.percentEncodedPath.hasSuffix("/") ? "" : "/") +
                reference.percentEncodedPath.drop(while: { $0 == "/" })
            gateway.percentEncodedQuery = reference.percentEncodedQuery
            gateway.percentEncodedFragment = reference.percentEncodedFragment
            return gateway.url
        }
        guard let canonical = canonicalize(raw: trimmed, against: activeGatewayURL),
              let url = URL(string: canonical),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return nil }
        return url
    }

    public static func canonicalize(raw: String?, against activeGatewayURL: URL?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        guard var parsed = URLComponents(string: trimmed) else { return trimmed }

        let parsedHost = parsed.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let parsedIsLoopback = !parsedHost.isEmpty && LoopbackHost.isLoopback(parsedHost)

        if !parsedHost.isEmpty, !parsedIsLoopback {
            guard let activeGatewayURL else { return trimmed }
            let isTLS = activeGatewayURL.scheme?.lowercased() == "wss"
            guard isTLS else { return trimmed }
            parsed.scheme = "https"
            if parsed.port == nil {
                let tlsPort = activeGatewayURL.port ?? 443
                parsed.port = (tlsPort == 443) ? nil : tlsPort
            }
            return parsed.string ?? trimmed
        }

        guard let activeGatewayURL,
              let fallbackHost = activeGatewayURL.host,
              !LoopbackHost.isLoopback(fallbackHost)
        else { return trimmed }
        let isTLS = activeGatewayURL.scheme?.lowercased() == "wss"
        parsed.scheme = isTLS ? "https" : "http"
        parsed.host = fallbackHost
        let fallbackPort = activeGatewayURL.port ?? (isTLS ? 443 : 80)
        parsed.port = ((isTLS && fallbackPort == 443) || (!isTLS && fallbackPort == 80)) ? nil : fallbackPort
        return parsed.string ?? trimmed
    }

    static func tlsFingerprintForSurface(
        _ fingerprint: String?,
        surfaceURL: String,
        gatewayURL: URL?) -> String?
    {
        guard let fingerprint,
              let gatewayURL,
              gatewayURL.scheme?.lowercased() == "wss",
              let surface = URLComponents(string: surfaceURL),
              surface.scheme?.lowercased() == "https",
              self.normalizedEndpointHost(surface.host) == self.normalizedEndpointHost(gatewayURL.host),
              (surface.port ?? 443) == (gatewayURL.port ?? 443)
        else { return nil }
        return fingerprint
    }

    private static func normalizedEndpointHost(_ raw: String?) -> String? {
        let host = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let normalized = host.hasSuffix(".") ? String(host.dropLast()) : host
        return normalized.isEmpty ? nil : normalized
    }
}
