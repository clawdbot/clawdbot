import MoltbotDiscovery
import SwiftUI

#if DEBUG
@MainActor
extension OnboardingView {
    static func exerciseForTesting() {
        let state = AppState(preview: true)
        let discovery = GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName)
        discovery.statusText = "Searching..."
        let gateway = GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Test Gateway",
            lanHost: "gateway.local",
            tailnetDns: "gateway.ts.net",
            sshPort: 2222,
            gatewayPort: 18789,
            cliPath: "/usr/local/bin/moltbot",
            stableID: "gateway-1",
            debugID: "gateway-1",
            isLocal: false)
        discovery.gateways = [gateway]

        let view = OnboardingView(
            state: state,
            permissionMonitor: PermissionMonitor.shared,
            discoveryModel: discovery)
        view.needsBootstrap = true
        view.localGatewayProbe = LocalGatewayProbe(
            port: GatewayEnvironment.gatewayPort(),
            pid: 123,
            command: "moltbot-gateway",
            expected: true)
        view.showAdvancedConnection = true
        view.preferredGatewayID = gateway.stableID
        view.cliInstalled = true
        view.cliInstallLocation = "/usr/local/bin/moltbot"
        view.cliStatus = "Installed"
        view.workspacePath = "/tmp/moltbot"
        view.workspaceStatus = "Saved workspace"
        view.anthropicAuthPKCE = AnthropicOAuth.PKCE(verifier: "verifier", challenge: "challenge")
        view.anthropicAuthCode = "code#state"
        view.anthropicAuthStatus = "Connected"
        view.anthropicAuthDetectedStatus = .connected(expiresAtMs: 1_700_000_000_000)
        view.anthropicAuthConnected = true
        view.anthropicAuthAutoDetectClipboard = false
        view.anthropicAuthAutoConnectClipboard = false

        view.state.connectionMode = .local
        _ = view.welcomePage()
        _ = view.connectionPage()
        _ = view.anthropicAuthPage()
        _ = view.wizardPage()
        _ = view.permissionsPage()
        _ = view.cliPage()
        _ = view.workspacePage()
        _ = view.onboardingChatPage()
        _ = view.readyPage()

        view.selectLocalGateway()
        view.selectRemoteGateway(gateway)
        view.selectUnconfiguredGateway()

        view.state.connectionMode = .remote
        _ = view.connectionPage()
        _ = view.workspacePage()

        view.state.connectionMode = .unconfigured
        _ = view.connectionPage()

        view.currentPage = 0
        view.handleNext()
        view.handleBack()

        _ = view.onboardingPage { Text("Test") }
        _ = view.onboardingCard { Text("Card") }
        _ = view.featureRow(title: "Feature", subtitle: "Subtitle", systemImage: "sparkles")
        _ = view.featureActionRow(
            title: "Action",
            subtitle: "Action subtitle",
            systemImage: "gearshape",
            buttonTitle: "Action",
            action: {})
        _ = view.gatewaySubtitle(for: gateway)
        _ = view.isSelectedGateway(gateway)
    }
}
#endif
