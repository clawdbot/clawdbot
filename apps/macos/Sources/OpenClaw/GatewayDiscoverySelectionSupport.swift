import Foundation
import OpenClawDiscovery
import OpenClawKit

@MainActor
enum GatewayDiscoverySelectionSupport {
    private static let defaultSshTunnelGatewayUrl = "ws://127.0.0.1:18789"

    static func applyRemoteSelection(
        gateway: GatewayDiscoveryModel.DiscoveredGateway,
        state: AppState)
    {
        let preferredTransport = self.preferredTransport(
            for: gateway,
            current: state.remoteTransport)
        if preferredTransport != state.remoteTransport {
            state.remoteTransport = preferredTransport
        }

        if preferredTransport == .direct {
            state.remoteUrl = GatewayDiscoveryHelpers.directUrl(for: gateway) ?? ""
        } else {
            state.remoteUrl = self.sshTunnelGatewayUrl(current: state.remoteUrl)
        }
        state.remoteTarget = GatewayDiscoveryHelpers.sshTarget(for: gateway) ?? ""

        if preferredTransport == .direct {
            if let endpoint = GatewayDiscoveryHelpers.serviceEndpoint(for: gateway) {
                OpenClawConfigFile.setRemoteGatewayUrl(
                    host: endpoint.host,
                    port: endpoint.port)
            } else {
                OpenClawConfigFile.clearRemoteGatewayUrl()
            }
        } else {
            OpenClawConfigFile.setRemoteGatewayUrlString(state.remoteUrl)
        }
    }

    private static func sshTunnelGatewayUrl(current: String) -> String {
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty,
              LoopbackHost.isLoopbackHost(host)
        else {
            return self.defaultSshTunnelGatewayUrl
        }

        return "ws://127.0.0.1:\(url.port ?? 18789)"
    }

    static func preferredTransport(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway,
        current: AppState.RemoteTransport) -> AppState.RemoteTransport
    {
        if self.shouldPreferDirectTransport(for: gateway) {
            return .direct
        }
        return current
    }

    static func shouldPreferDirectTransport(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> Bool
    {
        guard GatewayDiscoveryHelpers.directUrl(for: gateway) != nil else { return false }
        if gateway.stableID.hasPrefix("tailscale-serve|") {
            return true
        }
        guard let host = GatewayDiscoveryHelpers.resolvedServiceHost(for: gateway)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        else {
            return false
        }
        return host.hasSuffix(".ts.net")
    }
}
