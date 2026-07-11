import OpenClawDiscovery
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
            cliPath: "/usr/local/bin/openclaw",
            stableID: "gateway-1",
            debugID: "gateway-1",
            isLocal: false)
        discovery.gateways = [gateway]

        let view = OnboardingView(
            state: state,
            permissionMonitor: PermissionMonitor.shared,
            discoveryModel: discovery)
        view.localGatewayProbe = LocalGatewayProbe(
            port: GatewayEnvironment.gatewayPort(),
            pid: 123,
            command: "openclaw-gateway",
            expected: true)
        view.showAdvancedConnection = true
        view.preferredGatewayID = gateway.stableID
        view.cliInstalled = true
        view.cliInstallLocation = "/usr/local/bin/openclaw"
        view.cliStatus = "Installed"
        view.state.connectionMode = .local
        let contentHeight = view.contentHeight(for: OnboardingView.windowHeight)
        _ = view.welcomePage()
        _ = view.connectionPage()
        _ = view.aiSetupPage(contentHeight: contentHeight)
        _ = view.permissionsPage(contentHeight: contentHeight)
        _ = view.cliPage()
        _ = view.readyPage()

        view.selectLocalGateway()
        view.selectRemoteGateway(gateway)
        view.selectUnconfiguredGateway()

        view.state.connectionMode = .remote
        _ = view.connectionPage()

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
