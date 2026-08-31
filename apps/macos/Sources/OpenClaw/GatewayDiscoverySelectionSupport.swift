import CryptoKit
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
        self.applyRemoteSelection(
            gateway: gateway,
            state: state,
            routeBindingKey: GatewayDiscoveryPreferences.defaultRouteBindingKey())
    }

    static func applyRemoteSelection(
        gateway: GatewayDiscoveryModel.DiscoveredGateway,
        state: AppState,
        routeBindingKey: SymmetricKey?)
    {
        let previousRoute = Self.routeBinding(state: state)
        let previousRouteWasVerified = GatewayDiscoveryPreferences
            .preferredGatewayVerifiedForRoute(previousRoute, key: routeBindingKey)
        let preferredTransport = self.preferredTransport(for: gateway)
        if preferredTransport != state.remoteTransport {
            state.remoteTransport = preferredTransport
        }

        if preferredTransport == .direct {
            state.remoteUrl = GatewayDiscoveryHelpers.directUrl(for: gateway) ?? ""
        } else {
            state.remoteUrl = self.sshTunnelGatewayUrl(current: state.remoteUrl)
        }
        state.remoteTarget = GatewayDiscoveryHelpers.sshTarget(for: gateway) ?? ""
        MacNodeModeCoordinator.shared.setPreferredGatewayStableID(
            gateway.stableID,
            state: state,
            routeBindingKey: routeBindingKey)
        guard let selectedRoute = Self.routeBinding(state: state),
              selectedRoute != previousRoute || !previousRouteWasVerified
        else { return }
        // Selection establishes ownership before persistence. A failed atomic
        // save leaves routing unavailable; retry still removes both auth kinds.
        state.clearRemoteCredentialsForDiscoverySelection(routeBinding: selectedRoute)
    }

    private static func routeBinding(state: AppState) -> String? {
        GatewayDiscoveryPreferences.routeBinding(
            connectionMode: .remote,
            remoteTransport: state.remoteTransport,
            remoteURL: state.remoteUrl,
            remoteTarget: state.remoteTarget)
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
        for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> AppState.RemoteTransport
    {
        if self.shouldPreferDirectTransport(for: gateway) {
            return .direct
        }
        return .ssh
    }

    static func shouldPreferDirectTransport(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> Bool
    {
        // Bonjour TXT never decides routing. This fact is minted only by the
        // dedicated Tailscale Serve source and preserved through deduplication.
        guard gateway.supportsSecureDirectTransport,
              let url = GatewayDiscoveryHelpers.directUrl(for: gateway)
        else { return false }
        return url.hasPrefix("wss://")
    }
}
