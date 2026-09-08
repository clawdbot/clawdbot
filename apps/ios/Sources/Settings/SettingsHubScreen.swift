import OpenClawKit
import SwiftUI

struct SettingsHubScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(AppAppearanceModel.self) private var appearanceModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @State private var embedCompatibility = DashboardEmbedCompatibility()
    @Binding var navigationPath: [SettingsRoute]
    var headerSidebarAction: OpenClawSidebarHeaderAction?
    var onRouteChange: ((SettingsRoute?) -> Void)?
    var onApprovalNotificationsRoute: ((String?) -> Void)?

    var body: some View {
        NavigationStack(path: self.$navigationPath) {
            self.root
                .navigationDestination(for: SettingsRoute.self) { route in
                    self.nativeScreen(route: route)
                }
        }
    }

    @ViewBuilder private var root: some View {
        let config = self.appModel.activeGatewayConnectConfig
        if Self.usesDashboard(
            isOperatorConnected: self.appModel.isOperatorGatewayConnected,
            hasOperatorAdminScope: self.appModel.hasOperatorAdminScope,
            isDemoMode: self.appModel.isAppleReviewDemoModeEnabled,
            isScreenshotMode: ProcessInfo.processInfo.arguments.contains("--openclaw-screenshot-mode")),
            let url = AuthenticatedControlUI.pageURL(
                config: config,
                path: DashboardRouteMap.settingsPath,
                queryItems: [])
        {
            EmbeddedDashboardContent(
                appModel: self.appModel,
                appearanceModel: self.appearanceModel,
                gatewayController: self.gatewayController,
                url: url,
                config: config,
                openPanel: self.openPanel,
                embedCompatibility: self.embedCompatibility,
                openGateway: { self.push(.gateway) })
                .navigationTitle("Settings")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if let headerSidebarAction {
                        OpenClawSidebarToolbarItem(action: headerSidebarAction, placement: .topBarLeading)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            self.push(.gateway)
                        } label: {
                            Text("Gateway")
                                .font(OpenClawType.subheadSemiBold)
                        }
                        .accessibilityIdentifier("SettingsHub.Gateway")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            self.push(.approvals)
                        } label: {
                            HStack(spacing: 4) {
                                Label {
                                    Text("Approvals")
                                        .font(OpenClawType.subheadSemiBold)
                                } icon: {
                                    Image(systemName: "checkmark.shield")
                                }
                                .labelStyle(.iconOnly)
                                if self.appModel.pendingExecApprovalCount > 0 {
                                    Text(self.appModel.pendingExecApprovalCount.formatted())
                                        .font(OpenClawType.captionSemiBold)
                                        .padding(.horizontal, 5)
                                        .background(OpenClawBrand.warn.opacity(0.2), in: Capsule())
                                }
                            }
                        }
                        .accessibilityLabel("Approvals")
                        .accessibilityValue(self.appModel.pendingExecApprovalCount.formatted())
                        .accessibilityIdentifier("SettingsHub.Approvals")
                    }
                }
        } else {
            SettingsProTab(
                registersNavigationDestinations: false,
                headerSidebarAction: self.headerSidebarAction,
                onApprovalNotificationsRoute: self.onApprovalNotificationsRoute)
        }
    }

    private func nativeScreen(route: SettingsRoute) -> some View {
        SettingsProTab(
            directRoute: route,
            registersNavigationDestinations: false,
            onRouteChange: self.onRouteChange,
            onApprovalNotificationsRoute: self.onApprovalNotificationsRoute)
    }

    private func push(_ route: SettingsRoute) {
        self.navigationPath.append(route)
    }

    private func openPanel(_ panel: DeviceSettingsPanel) {
        guard let route = Self.route(for: panel) else { return }
        self.push(route)
    }

    static func usesDashboard(
        isOperatorConnected: Bool,
        hasOperatorAdminScope: Bool,
        isDemoMode: Bool,
        isScreenshotMode: Bool) -> Bool
    {
        isOperatorConnected && hasOperatorAdminScope && !isDemoMode && !isScreenshotMode
    }

    static func route(for panel: DeviceSettingsPanel) -> SettingsRoute? {
        switch panel {
        case .connection, .gateways: .gateway
        case .watch: .appleWatch
        case .diagnostics: .diagnostics
        case .licenses: .licenses
        case .about: .about
        case .quickChatShortcut, .microphoneTest, .browserImport, .debug: nil
        }
    }
}

struct EmbeddedDashboardContent: View {
    @State private var bridge: IOSDeviceSettingsBridge
    let embedCompatibility: DashboardEmbedCompatibility?
    let url: URL
    let config: GatewayConnectConfig?
    let openGateway: (() -> Void)?

    init(
        appModel: NodeAppModel,
        appearanceModel: AppAppearanceModel,
        gatewayController: GatewayConnectionController,
        url: URL,
        config: GatewayConnectConfig?,
        openPanel: @escaping (DeviceSettingsPanel) -> Void,
        embedCompatibility: DashboardEmbedCompatibility? = nil,
        openGateway: (() -> Void)? = nil)
    {
        self.url = url
        self.config = config
        self.openGateway = openGateway
        self.embedCompatibility = embedCompatibility
        self._bridge = State(initialValue: IOSDeviceSettingsBridge(
            appModel: appModel,
            appearanceModel: appearanceModel,
            gatewayController: gatewayController,
            openPanel: openPanel,
            onStatusRequest: { [weak embedCompatibility] in
                embedCompatibility?.didReceiveStatusRequest()
            }))
    }

    var body: some View {
        let storedOperatorToken = AuthenticatedControlUI.storedOperatorToken(config: self.config)
        VStack(spacing: 0) {
            self.gatewayUpgradeBanner
            AuthenticatedControlUIWebView(
                url: self.url,
                authScript: AuthenticatedControlUI.authUserScript(
                    config: self.config,
                    pageURL: self.url,
                    storedOperatorToken: storedOperatorToken,
                    usesNativeNavigationChrome: true),
                tls: self.config?.tls,
                deviceSettingsBridge: self.bridge,
                usesNativeEmbed: true,
                embedCompatibility: self.embedCompatibility)
                .id(AuthenticatedControlUI.webContentIdentity(
                    config: self.config,
                    storedOperatorToken: storedOperatorToken))
                .accessibilityIdentifier("SettingsHub.Dashboard")
        }
    }

    @ViewBuilder private var gatewayUpgradeBanner: some View {
        if let openGateway, self.embedCompatibility?.needsGatewayUpgrade == true {
            VStack(alignment: .leading, spacing: 8) {
                Text("This Gateway's Dashboard is older than the app; update the Gateway to manage app settings here")
                    .font(OpenClawType.footnote)
                    .accessibilityIdentifier("SettingsHub.GatewayUpgradeWarning")
                Button(action: openGateway) {
                    Text("Open Gateway")
                        .font(OpenClawType.subheadSemiBold)
                }
                .accessibilityIdentifier("SettingsHub.UpgradeGateway")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(OpenClawBrand.warn.opacity(0.12))
        }
    }
}
