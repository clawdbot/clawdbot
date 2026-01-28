import MoltbotDiscovery
import Foundation

enum GatewayDiscoveryHelpers {
    static func sshTarget(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        let host = self.sanitizedTailnetHost(gateway.tailnetDns) ?? gateway.lanHost
        guard let host = self.trimmed(host), !host.isEmpty else { return nil }
        let user = NSUserName()
        var target = "\(user)@\(host)"
        if gateway.sshPort != 22 {
            target += ":\(gateway.sshPort)"
        }
        return target
    }

    static func directUrl(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        self.directGatewayUrl(
            tailnetDns: gateway.tailnetDns,
            lanHost: gateway.lanHost,
            gatewayPort: gateway.gatewayPort)
    }

    static func directGatewayUrl(
        tailnetDns: String?,
        lanHost: String?,
        gatewayPort: Int?) -> String?
    {
        if let tailnetDns = self.sanitizedTailnetHost(tailnetDns) {
            return "wss://\(tailnetDns)"
        }
        guard let lanHost = self.trimmed(lanHost), !lanHost.isEmpty else { return nil }
        let port = gatewayPort ?? 18789
        return "ws://\(lanHost):\(port)"
    }

    static func sanitizedTailnetHost(_ host: String?) -> String? {
        guard let host = self.trimmed(host), !host.isEmpty else { return nil }
        if host.hasSuffix(".internal.") || host.hasSuffix(".internal") {
            return nil
        }
        return host
    }

    private static func trimmed(_ value: String?) -> String? {
        value?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
