import AppKit
import Foundation
import OpenClawKit

extension DashboardManager {
    static func websocketURLString(for dashboardURL: URL) -> String {
        guard var components = URLComponents(url: dashboardURL, resolvingAgainstBaseURL: false) else {
            return dashboardURL.absoluteString
        }
        switch components.scheme?.lowercased() {
        case "https":
            components.scheme = "wss"
        default:
            components.scheme = "ws"
        }
        components.queryItems = nil
        components.fragment = nil
        return components.url?.absoluteString ?? dashboardURL.absoluteString
    }

    static func notificationRoute(_ url: URL) -> URL? {
        // Retain only Gateway origin and mount. Authentication is supplied by
        // the current owner when a notification opens its session.
        guard let source = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var route = URLComponents()
        route.scheme = source.scheme
        route.host = source.host
        route.port = source.port
        route.path = source.path
        return route.url
    }
}

extension DashboardManager {
    func primaryEndpoint(
        mode: AppState.ConnectionMode) async throws -> GatewayConnection.EndpointSnapshot
    {
        #if DEBUG
        if let testPrimaryEndpointProvider {
            return try await testPrimaryEndpointProvider(mode)
        }
        #endif
        return try await Self.resolvePrimaryEndpoint(mode: mode)
    }

    func profileEndpoint(profileID: String) async throws -> GatewayConnection.EndpointSnapshot {
        #if DEBUG
        if let testProfileEndpointProvider {
            return try await testProfileEndpointProvider(profileID)
        }
        #endif
        return try await MacGatewayProfileStore.shared.endpoint(profileID: profileID)
    }

    static func gatewayConnection(for target: DashboardGatewayTarget) async -> GatewayConnection {
        switch target {
        case .primary: GatewayConnection.shared
        case let .profile(id): await MacGatewayConnectionFleet.shared.connection(profileID: id)
        }
    }

    func loadGatewayEntries() async throws -> [DashboardGatewayEntry] {
        #if DEBUG
        if let testGatewayEntriesProvider {
            return try await testGatewayEntriesProvider()
        }
        #endif
        return try await DashboardGatewayCatalog.loadEntries()
    }

    static func resolvePrimaryEndpoint(
        mode: AppState.ConnectionMode) async throws -> GatewayConnection.EndpointSnapshot
    {
        if let endpoint = self.immediateDashboardEndpoint(mode: mode) {
            return endpoint
        }
        return try await Task.detached(priority: .userInitiated) {
            await GatewayEndpointStore.shared.refresh()
            return try await GatewayEndpointStore.shared.requireEndpoint()
        }.value
    }

    static func immediateDashboardEndpoint(
        mode: AppState.ConnectionMode) -> GatewayConnection.EndpointSnapshot?
    {
        let root = OpenClawConfigFile.loadDict()
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        if mode == .remote,
           resolution.transport == .direct,
           let url = resolution.directURL
        {
            return GatewayConnection.EndpointSnapshot(
                config: (
                    url,
                    GatewayRemoteConfig.resolveTokenString(root: root),
                    GatewayRemoteConfig.resolvePasswordString(root: root)),
                tls: GatewayTLSRoute.resolve(
                    url: url,
                    connectionMode: mode,
                    configuredFingerprint: GatewayRemoteConfig.resolveTLSFingerprint(root: root)),
                routeAuthority: nil)
        }

        if mode == .local {
            let config = GatewayEndpointStore.localConfig()
            return GatewayConnection.EndpointSnapshot(
                config: config,
                tls: GatewayTLSRoute.resolve(
                    url: config.url,
                    connectionMode: mode,
                    configuredFingerprint: nil),
                routeAuthority: nil)
        }

        return nil
    }
}

extension DashboardManager {
    /// The card's native update path only makes sense when the app owns the
    /// local gateway and the post-relaunch repair is allowed to run; otherwise
    /// (external CLI, write-disabled launchd, extended-stable pin) the card
    /// must keep the direct gateway `update.run` flow, so no bridge is exposed.
    static func updateBridgeEnabled(mode: AppState.ConnectionMode) -> Bool {
        guard mode == .local else { return false }
        return CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: CLIInstallPrompter.launchAgentUsesManagedCLI(
                programArguments: GatewayLaunchAgentManager.launchdConfigSnapshot()?.programArguments ?? []),
            gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
            installPolicy: CLIInstallPolicy.storedPolicy(),
            launchAgentWriteDisabled: GatewayLaunchAgentManager.isLaunchAgentWriteDisabled())
    }
}

extension DashboardManager {
    static func showGatewayError(_ error: Error, message: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }
}

extension DashboardManager {
    func immediateWindowConfiguration()
        -> (AppState.ConnectionMode, URL, DashboardWindowAuth, GatewayTLSParams?)?
    {
        let mode = AppStateStore.shared.connectionMode
        guard mode == .local,
              let endpoint = Self.immediateDashboardEndpoint(mode: mode),
              let url = try? GatewayEndpointStore.dashboardURL(
                  for: endpoint.config,
                  mode: mode,
                  authToken: endpoint.config.token)
        else { return nil }
        let config = endpoint.config
        let auth = DashboardWindowAuth(
            gatewayUrl: Self.websocketURLString(for: url),
            token: config.token,
            password: (config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty))
        return auth.hasCredential ? (mode, url, auth, endpoint.tls?.params) : nil
    }
}

extension DashboardManager {
    func navigateBack() {
        guard let controller = frontmostDashboard()?.controller,
              controller.window?.isKeyWindow == true else { return }
        controller.navigateBack()
    }

    func navigateForward() {
        guard let controller = frontmostDashboard()?.controller,
              controller.window?.isKeyWindow == true else { return }
        controller.navigateForward()
    }

    func confirmSetPrimary(_ target: DashboardGatewayTarget) {
        self.presentSetPrimaryConfirmation(target, source: nil)
    }
}

extension DashboardManager {
    func presentSetPrimaryConfirmation(
        _ target: DashboardGatewayTarget,
        source: DashboardWindowController?)
    {
        guard case let .profile(profileID) = target,
              let entry = gatewayEntries.first(where: { $0.id == target.bridgeID }),
              entry.canPromote
        else {
            return
        }
        let alert = DashboardWindowController.makeSetPrimaryAlert(gatewayName: entry.name)
        let apply: (NSApplication.ModalResponse) -> Void = { [weak self, weak source] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            Task { @MainActor in
                do {
                    try await DashboardPrimaryGatewayAdapter(state: AppStateStore.shared).apply(profileID: profileID)
                    self.recordSelection(.primary)
                    if let source, self.target(for: source) != nil {
                        await self.switchTarget(.primary, in: source)?.value
                    } else {
                        await self.refreshGatewaySnapshots()
                    }
                } catch {
                    Self.showGatewayError(error, message: String(localized: "Could Not Set Primary Gateway"))
                }
            }
        }
        if let window = source?.window {
            alert.beginSheetModal(for: window, completionHandler: apply)
        } else {
            apply(alert.runModal())
        }
    }
}
