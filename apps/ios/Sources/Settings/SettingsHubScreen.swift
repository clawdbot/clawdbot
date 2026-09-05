import OpenClawKit
import SwiftUI

struct SettingsHubScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(AppAppearanceModel.self) private var appearanceModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Binding var navigationPath: [SettingsRoute]
    var headerSidebarAction: OpenClawSidebarHeaderAction?
    var onRouteChange: ((SettingsRoute?) -> Void)?
    var onApprovalNotificationsRoute: ((String) -> Void)?

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
            let url = AuthenticatedControlUI.pageURL(config: config, path: "settings", queryItems: [])
        {
            SettingsDashboardRoot(
                appModel: self.appModel,
                appearanceModel: self.appearanceModel,
                gatewayController: self.gatewayController,
                url: url,
                config: config,
                openPanel: self.openPanel)
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
                usesOfflineFallback: true,
                registersNavigationDestinations: false,
                headerSidebarAction: self.headerSidebarAction,
                navigateToRoute: self.push)
        }
    }

    private func nativeScreen(route: SettingsRoute) -> some View {
        SettingsProTab(
            directRoute: route,
            registersNavigationDestinations: false,
            navigateToRoute: self.push,
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

private struct SettingsDashboardRoot: View {
    @State private var bridge: IOSDeviceSettingsBridge
    let url: URL
    let config: GatewayConnectConfig?

    init(
        appModel: NodeAppModel,
        appearanceModel: AppAppearanceModel,
        gatewayController: GatewayConnectionController,
        url: URL,
        config: GatewayConnectConfig?,
        openPanel: @escaping (DeviceSettingsPanel) -> Void)
    {
        self.url = url
        self.config = config
        self._bridge = State(initialValue: IOSDeviceSettingsBridge(
            appModel: appModel,
            appearanceModel: appearanceModel,
            gatewayController: gatewayController,
            openPanel: openPanel))
    }

    var body: some View {
        let storedOperatorToken = AuthenticatedControlUI.storedOperatorToken(config: self.config)
        AuthenticatedControlUIWebView(
            url: self.url,
            authScript: AuthenticatedControlUI.authUserScript(
                config: self.config,
                pageURL: self.url,
                storedOperatorToken: storedOperatorToken,
                usesNativeNavigationChrome: true),
            tls: self.config?.tls,
            deviceSettingsBridge: self.bridge,
            usesNativeEmbed: true)
            .id(AuthenticatedControlUI.webContentIdentity(
                config: self.config,
                storedOperatorToken: storedOperatorToken))
            .accessibilityIdentifier("SettingsHub.Dashboard")
    }
}
