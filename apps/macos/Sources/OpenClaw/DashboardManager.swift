import AppKit
import Foundation
import OpenClawKit
import OSLog

private let dashboardManagerLogger = Logger(subsystem: "ai.openclaw", category: "DashboardManager")

@MainActor
final class DashboardManager {
    static let shared = DashboardManager()

    private var controller: DashboardWindowController?
    private var endpointTask: Task<Void, Never>?
    private var updater: UpdaterProviding?
    private var displayedRouteRevision: UInt64?
    private let authTokenProvider: @Sendable (GatewayConnection.Config) async -> String?
    private let routeProbe: @Sendable () async -> Void
    private static let failureURL = URL(string: "about:blank")!

    private init(
        authTokenProvider: @escaping @Sendable (GatewayConnection.Config) async -> String? = { config in
            await GatewayConnection.shared.controlUiAutoAuthToken(config: config)
        },
        routeProbe: @escaping @Sendable () async -> Void = {
            _ = try? await GatewayConnection.shared.request(
                method: "health",
                params: nil,
                timeoutMs: 3000,
                retryTransportFailures: false)
        })
    {
        self.authTokenProvider = authTokenProvider
        self.routeProbe = routeProbe
    }

    func configure(updater: UpdaterProviding) {
        self.updater = updater
    }

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

    /// The remote SSH tunnel can be recreated on a new ephemeral local port while
    /// the dashboard stays open; without following endpoint changes the WebView
    /// keeps reconnecting to the dead old port forever (#100476).
    private func observeEndpointChanges() {
        guard self.endpointTask == nil else { return }
        self.endpointTask = Task { [weak self] in
            let stream = await GatewayEndpointStore.shared.subscribe()
            for await state in stream {
                guard let self else { return }
                await self.handleEndpointState(state)
            }
        }
    }

    func handleEndpointState(_ state: GatewayEndpointState) async {
        guard let controller, controller.isWindowOpen else { return }
        guard case let .ready(mode, url, token, password, routeRevision) = state else {
            self.replaceWithRouteFailure(controller)
            self.displayedRouteRevision = nil
            return
        }
        let config: GatewayConnection.Config = (url, token, password)
        let routeChanged = self.displayedRouteRevision.map { $0 != routeRevision }
            ?? (routeRevision > 0)
        var authToken = await self.authTokenProvider(config)
        if authToken == nil, password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty == nil {
            await self.routeProbe()
            authToken = await self.authTokenProvider(config)
        }
        guard let dashboardURL = try? GatewayEndpointStore.dashboardURL(
            for: config,
            mode: mode,
            authToken: authToken)
        else {
            return
        }
        let auth = DashboardWindowAuth(
            gatewayUrl: Self.websocketURLString(for: dashboardURL),
            token: authToken,
            password: password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)
        if routeChanged {
            self.displayedRouteRevision = routeRevision
            guard auth.hasCredential else {
                self.replaceWithRouteFailure(controller)
                return
            }
            self.replaceController(
                controller,
                url: dashboardURL,
                auth: auth,
                mode: mode)
            return
        }
        if dashboardURL == controller.currentURL {
            self.displayedRouteRevision = routeRevision
            controller.setUpdateBridgeEnabled(Self.updateBridgeEnabled(mode: mode))
            return
        }
        guard auth.hasCredential, controller.isWindowOpen else { return }
        dashboardManagerLogger.info(
            "dashboard endpoint changed; reloading url=\(dashboardLogString(for: dashboardURL), privacy: .public)")
        controller.update(url: dashboardURL, auth: auth, updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode))
        self.displayedRouteRevision = routeRevision
    }

    private func replaceController(
        _ current: DashboardWindowController,
        url: URL,
        auth: DashboardWindowAuth,
        mode: AppState.ConnectionMode)
    {
        current.closeDashboard()
        let replacement = DashboardWindowController(
            url: url,
            auth: auth,
            updater: self.updater,
            updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode))
        self.controller = replacement
        replacement.show(url: url, auth: auth)
    }

    private func replaceWithRouteFailure(_ current: DashboardWindowController) {
        current.closeDashboard()
        let replacement = DashboardWindowController(
            url: Self.failureURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            updater: self.updater,
            updateBridgeEnabled: false)
        self.controller = replacement
        replacement.showFailure(
            title: "Dashboard reconnecting",
            message: "The selected Gateway changed.",
            detail: "Waiting for a fresh authenticated connection.")
    }

    @discardableResult
    func showConfiguredWindowIfPossible() -> Bool {
        let mode = AppStateStore.shared.connectionMode
        guard let config = self.immediateDashboardConfig(mode: mode),
              let url = try? GatewayEndpointStore.dashboardURL(
                  for: config,
                  mode: mode,
                  authToken: config.token)
        else {
            return false
        }
        let auth = DashboardWindowAuth(
            gatewayUrl: Self.websocketURLString(for: url),
            token: config.token,
            password: config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)
        guard auth.hasCredential else {
            return false
        }
        if let controller {
            controller.show(url: url, auth: auth, updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode))
        } else {
            let controller = DashboardWindowController(
                url: url,
                auth: auth,
                updater: self.updater,
                updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode))
            self.controller = controller
            controller.show(url: url, auth: auth)
        }
        self.observeEndpointChanges()
        Task { _ = try? await ControlChannel.shared.health(timeout: 3) }
        return true
    }

    func show() async throws {
        let mode = AppStateStore.shared.connectionMode
        dashboardManagerLogger.info("dashboard show requested mode=\(String(describing: mode), privacy: .public)")
        let config = try await self.dashboardConfig(mode: mode)
        dashboardManagerLogger.info("dashboard config url=\(config.url.absoluteString, privacy: .public)")
        let token = await GatewayConnection.shared.controlUiAutoAuthToken(config: config)
        let url = try GatewayEndpointStore.dashboardURL(for: config, mode: mode, authToken: token)
        let auth = DashboardWindowAuth(
            gatewayUrl: Self.websocketURLString(for: url),
            token: token,
            password: config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)

        if let controller {
            dashboardManagerLogger.info("dashboard reuse window url=\(dashboardLogString(for: url), privacy: .public)")
            controller.show(url: url, auth: auth, updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode))
            self.observeEndpointChanges()
            return
        }

        dashboardManagerLogger.info("dashboard create window url=\(dashboardLogString(for: url), privacy: .public)")
        let controller = DashboardWindowController(
            url: url,
            auth: auth,
            updater: self.updater,
            updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode))
        self.controller = controller
        controller.show(url: url, auth: auth)
        self.observeEndpointChanges()

        // Refresh the cached hello payload without blocking window creation.
        Task { _ = try? await ControlChannel.shared.health(timeout: 3) }
    }

    func showFailure(_ error: Error) {
        let message = (error as NSError).localizedDescription
        dashboardManagerLogger.error("dashboard setup failed error=\(message, privacy: .public)")
        let controller = self.controller ?? DashboardWindowController(
            url: Self.failureURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            updater: self.updater,
            updateBridgeEnabled: Self.updateBridgeEnabled(mode: AppStateStore.shared.connectionMode))
        self.controller = controller
        // Keep observing while the failure page is up so a recovered tunnel
        // swaps the window back to the live dashboard.
        self.observeEndpointChanges()
        controller.showFailure(
            title: "Dashboard unavailable",
            message: message,
            detail: "Check Settings → Connection or use Debug → Reset Remote Tunnel, then try again.")
    }

    func close() {
        self.controller?.closeDashboard()
    }

    func navigateBack() {
        guard self.controller?.window?.isKeyWindow == true else { return }
        self.controller?.navigateBack()
    }

    func navigateForward() {
        guard self.controller?.window?.isKeyWindow == true else { return }
        self.controller?.navigateForward()
    }

    private static func websocketURLString(for dashboardURL: URL) -> String {
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

    private func dashboardConfig(mode: AppState.ConnectionMode) async throws -> GatewayConnection.Config {
        if let config = self.immediateDashboardConfig(mode: mode) {
            return config
        }

        return try await Task.detached(priority: .userInitiated) {
            await GatewayEndpointStore.shared.refresh()
            return try await GatewayEndpointStore.shared.requireConfig()
        }.value
    }

    private func immediateDashboardConfig(mode: AppState.ConnectionMode) -> GatewayConnection.Config? {
        let root = OpenClawConfigFile.loadDict()
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        if mode == .remote,
           resolution.transport == .direct,
           let url = resolution.directURL
        {
            return (
                url,
                GatewayRemoteConfig.resolveTokenString(root: root),
                GatewayRemoteConfig.resolvePasswordString(root: root))
        }

        if mode == .local {
            return GatewayEndpointStore.localConfig()
        }

        return nil
    }
}

#if DEBUG
extension DashboardManager {
    /// Test instances skip `observeEndpointChanges()` so the shared endpoint
    /// store cannot race test-driven `handleEndpointState` calls.
    static func _testMake(
        authTokenProvider: @escaping @Sendable (GatewayConnection.Config) async -> String? = { $0.token },
        routeProbe: @escaping @Sendable () async -> Void = {}) -> DashboardManager
    {
        DashboardManager(
            authTokenProvider: authTokenProvider,
            routeProbe: routeProbe)
    }

    func _testSetController(_ controller: DashboardWindowController?) {
        self.controller = controller
    }

    func _testController() -> DashboardWindowController? {
        self.controller
    }
}
#endif
