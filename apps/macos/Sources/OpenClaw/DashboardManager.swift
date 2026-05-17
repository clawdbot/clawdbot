import AppKit
import Foundation
import OpenClawKit
import OSLog

private let dashboardManagerLogger = Logger(subsystem: "ai.openclaw", category: "DashboardManager")

@MainActor
final class DashboardManager {
    static let shared = DashboardManager()

    private var controller: DashboardWindowController?

    private init() {}

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
            controller.show(url: url, auth: auth)
        } else {
            let controller = DashboardWindowController(url: url, auth: auth)
            self.controller = controller
            controller.show(url: url, auth: auth)
        }
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
            dashboardManagerLogger.info("dashboard reuse window url=\(url.absoluteString, privacy: .public)")
            controller.show(url: url, auth: auth)
            return
        }

        dashboardManagerLogger.info("dashboard create window url=\(url.absoluteString, privacy: .public)")
        let controller = DashboardWindowController(url: url, auth: auth)
        self.controller = controller
        controller.show(url: url, auth: auth)

        // Refresh the cached hello payload without blocking window creation.
        Task { _ = try? await ControlChannel.shared.health(timeout: 3) }
    }

    func close() {
        self.controller?.closeDashboard()
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
        if mode == .remote,
           GatewayRemoteConfig.resolveTransport(root: root) == .direct,
           let url = GatewayRemoteConfig.resolveGatewayUrl(root: root)
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
