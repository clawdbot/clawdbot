import Foundation
import OpenClawDiscovery
import OpenClawKit

@MainActor
enum GatewayDiscoverySelectionSupport {
    private static let defaultSshTunnelGatewayUrl = "ws://127.0.0.1:18789"

    static func applyRemoteSelection(
        gateway: GatewayDiscoveryModel.DiscoveredGateway,
        currentRouteIsDiscoveryOwned: Bool,
        state: AppState)
    {
        let preferredTransport = self.preferredTransport(
            for: gateway,
            current: state.remoteTransport,
            currentRouteIsDiscoveryOwned: currentRouteIsDiscoveryOwned)
        if preferredTransport != state.remoteTransport {
            state.remoteTransport = preferredTransport
        }

        if preferredTransport == .direct {
            state.remoteUrl = GatewayDiscoveryHelpers.directUrl(for: gateway) ?? ""
        } else {
            state.remoteUrl = self.sshTunnelGatewayUrl(current: state.remoteUrl)
        }
        state.remoteTarget = GatewayDiscoveryHelpers.sshTarget(for: gateway) ?? ""
    }

    static func sshTunnelGatewayUrl(current: String) -> String {
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
        current: AppState.RemoteTransport,
        currentRouteIsDiscoveryOwned: Bool = false) -> AppState.RemoteTransport
    {
        if self.shouldPreferDirectTransport(for: gateway) {
            return .direct
        }
        // A discovery-owned route must be recomputed for every selected gateway. Otherwise a
        // previous automatic Direct choice can leak into an unrelated plaintext LAN selection.
        if currentRouteIsDiscoveryOwned {
            return .ssh
        }
        return current
    }

    static func shouldPreferDirectTransport(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> Bool
    {
        guard GatewayDiscoveryHelpers.directUrl(for: gateway) != nil else { return false }
        // Only the internal Tailscale Serve probe establishes direct-route authority. Bonjour
        // stable ids cannot enter this namespace, so unauthenticated TXT flags remain hints.
        return gateway.stableID.hasPrefix("tailscale-serve|")
    }
}
