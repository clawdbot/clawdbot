import AppKit
import Foundation
import OpenClawDiscovery

@MainActor
enum GatewayDiscoverySelectionSupport {
    static func requestSetupCode(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 24))
        field.placeholderString = "Paste the setup code from this Gateway"
        field.setAccessibilityLabel("Gateway setup code")

        let alert = NSAlert()
        alert.messageText = "Authenticate \(gateway.displayName)"
        alert.informativeText =
            "Bonjour can locate a Gateway, but cannot prove its identity. " +
            "On that Gateway, open Control UI → Settings → Devices → Pair device, keep Full access, " +
            "and create a setup code. " +
            "OpenClaw will verify its TLS certificate before sending the one-time bootstrap credential."
        alert.alertStyle = .informational
        alert.accessoryView = field
        alert.addButton(withTitle: "Authenticate")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        return field.stringValue
    }

    static func presentError(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "Could Not Authenticate Gateway"
        alert.informativeText = error.localizedDescription
        alert.alertStyle = .warning
        alert.runModal()
    }

    @discardableResult
    static func applyAuthenticatedSelection(
        stableID: String,
        route: AuthenticatedGatewayRoute,
        state: AppState) -> Bool
    {
        let routeURL = route.url.absoluteString
        guard GatewayDiscoveryPreferences.tlsDeviceAuthGatewayID(route.tlsFingerprint) != nil else { return false }
        let previousState = (
            mode: state.connectionMode,
            transport: state.remoteTransport,
            url: state.remoteUrl)
        let previousPreference = (
            stableID: GatewayDiscoveryPreferences.preferredStableID(),
            routeBinding: GatewayDiscoveryPreferences.preferredRouteBinding(),
            tlsFingerprint: GatewayDiscoveryPreferences.authenticatedTLSFingerprint())
        let previousTLSFingerprint = GatewayRemoteConfig.resolveTLSFingerprint(
            root: OpenClawConfigFile.loadDict())

        // Publish trust before the route can become observable. Endpoint resolution
        // then withholds route-external config/environment auth throughout the handoff.
        GatewayDiscoveryPreferences.setAuthenticatedPreferredGateway(
            stableID: stableID,
            tlsFingerprint: route.tlsFingerprint)
        state.remoteTransport = .direct
        state.remoteUrl = routeURL
        state.connectionMode = .remote

        guard state.syncGatewayConfigNow(remoteTLSFingerprint: route.tlsFingerprint) else {
            state.connectionMode = previousState.mode
            state.remoteTransport = previousState.transport
            state.remoteUrl = previousState.url
            if let stableID = previousPreference.stableID,
               let fingerprint = previousPreference.tlsFingerprint
            {
                GatewayDiscoveryPreferences.setAuthenticatedPreferredGateway(
                    stableID: stableID,
                    tlsFingerprint: fingerprint)
            } else {
                GatewayDiscoveryPreferences.setPreferredStableID(
                    previousPreference.stableID,
                    routeBinding: previousPreference.routeBinding)
            }
            _ = state.syncGatewayConfigNow(remoteTLSFingerprint: previousTLSFingerprint)
            return false
        }
        MacNodeModeCoordinator.shared.refresh()
        return true
    }
}
