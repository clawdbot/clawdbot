import Foundation
import OpenClawDiscovery

enum GatewayDiscoveryHelpers {
    static func resolvedServiceHost(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String?
    {
        self.resolvedServiceHost(gateway.serviceHost)
    }

    static func resolvedServiceHost(_ host: String?) -> String? {
        guard let host = self.trimmed(host), !host.isEmpty else { return nil }
        return host
    }

    static func serviceEndpoint(
        serviceHost: String?,
        servicePort: Int?) -> (host: String, port: Int)?
    {
        guard let host = self.resolvedServiceHost(serviceHost) else { return nil }
        guard let port = servicePort, port > 0, port <= 65535 else { return nil }
        return (host, port)
    }

    static func sshTarget(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        guard let host = self.resolvedServiceHost(for: gateway) else { return nil }
        let user = NSUserName()
        var target = "\(user)@\(host)"
        if gateway.sshPort != 22 {
            target += ":\(gateway.sshPort)"
        }
        return target
    }

    static func directUrl(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        self.directGatewayUrl(
            serviceHost: gateway.serviceHost,
            servicePort: gateway.servicePort,
            gatewayTls: gateway.gatewayTls)
    }

    static func directGatewayUrl(
        serviceHost: String?,
        servicePort: Int?,
        gatewayTls: Bool = false) -> String?
    {
        // Security: do not route using unauthenticated TXT hints (tailnetDns/lanHost/gatewayPort).
        // Prefer the resolved service endpoint (SRV + A/AAAA).
        guard let endpoint = self.serviceEndpoint(serviceHost: serviceHost, servicePort: servicePort) else {
            return nil
        }
        let scheme: String
        if gatewayTls {
            scheme = "wss"
        } else if self.isLoopbackHost(endpoint.host)
            || GatewayRemoteConfig.isTrustedPlaintextRemoteHost(endpoint.host)
        {
            scheme = "ws"
        } else {
            return nil
        }
        let portSuffix = scheme == "wss" && endpoint.port == 443 ? "" : ":\(endpoint.port)"
        return "\(scheme)://\(endpoint.host)\(portSuffix)"
    }

    private static func trimmed(_ value: String?) -> String? {
        value?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isLoopbackHost(_ rawHost: String) -> Bool {
        let host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !host.isEmpty else { return false }
        if host == "localhost" || host == "::1" || host == "0:0:0:0:0:0:0:1" {
            return true
        }
        if host.hasPrefix("::ffff:127.") {
            return true
        }
        return host.hasPrefix("127.")
    }
}
