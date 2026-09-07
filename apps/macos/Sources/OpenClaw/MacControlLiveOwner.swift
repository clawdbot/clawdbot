import Foundation
import OpenClawIPC
import OpenClawKit

@MainActor
final class MacControlLiveOwner: MacControlOwner {
    func status() async throws -> MacControlStatus {
        let primary = try await self.primaryStatus()
        let gateways = try await self.gateways()
        return MacControlStatus(
            primary: primary,
            gateways: gateways,
            app: MacControlAppStatus(
                version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
                build: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
                profile: AppProfile.current.name ?? "default"))
    }

    func primaryStatus() async throws -> MacControlPrimaryStatus {
        let tunnel = await RemoteTunnelManager.shared.controlTunnelStatus()
        let endpoint = await GatewayEndpointStore.shared.currentState()
        let summary = await GatewayConnection.shared.connectionSummary()
        let state = AppStateStore.shared
        let mode = state.connectionMode
        let url: String = if case let .ready(_, endpointURL, _, _, _) = endpoint {
            endpointURL.absoluteString
        } else if mode == .remote {
            state.remoteUrl
        } else {
            mode == .local ? "ws://127.0.0.1:\(GatewayEnvironment.gatewayPort())" : ""
        }
        let connection = Self.primaryConnectionStatus(
            mode: mode,
            paused: state.isPaused,
            channelState: ControlChannel.shared.state,
            gatewayVersion: summary.gatewayVersion)
        return MacControlPrimaryStatus(
            mode: mode.rawValue,
            transport: mode == .remote ? state.remoteTransport.rawValue : nil,
            sshTarget: mode == .remote && state.remoteTransport == .ssh ? state.remoteTarget : nil,
            url: url,
            remotePort: mode == .remote && state.remoteTransport == .ssh
                ? GatewayRemoteConfig.resolveRemotePort(root: OpenClawConfigFile.loadDict()) : nil,
            tunnel: MacControlTunnelStatus(running: tunnel.running, localPort: tunnel.localPort.map(Int.init)),
            connection: connection)
    }

    static func primaryConnectionStatus(
        mode: AppState.ConnectionMode,
        paused: Bool,
        channelState: ControlChannel.ConnectionState,
        gatewayVersion: String?) -> MacControlConnectionStatus
    {
        guard mode != .unconfigured, !paused else {
            return MacControlConnectionStatus(state: "disconnected")
        }
        return switch channelState {
        case .disconnected: MacControlConnectionStatus(state: "disconnected")
        case .connecting: MacControlConnectionStatus(state: "connecting")
        case .connected: MacControlConnectionStatus(state: "connected", gatewayVersion: gatewayVersion)
        case .degraded: MacControlConnectionStatus(state: "degraded", error: "Gateway connection needs attention.")
        }
    }

    func setPrimary(_ configuration: PrimaryGatewayControlConfiguration) async throws -> MacControlPrimaryStatus {
        try Task.checkCancellation()
        let state = AppStateStore.shared
        try state.setPrimaryGateway(configuration)
        let generation = state.gatewayRoutingGeneration
        await RemoteTunnelManager.shared.stopAll()
        try self.requireCurrentPrimary(generation)
        await ControlChannel.shared.disconnect()
        try self.requireCurrentPrimary(generation)
        await GatewayEndpointStore.shared.refresh()
        try self.requireCurrentPrimary(generation)
        await ConnectionModeCoordinator.shared.apply(mode: state.connectionMode, paused: state.isPaused)
        try self.requireCurrentPrimary(generation)
        return try await self.primaryStatus()
    }

    private func requireCurrentPrimary(_ generation: UInt64) throws {
        try Task.checkCancellation()
        guard AppStateStore.shared.gatewayRoutingGeneration == generation else {
            throw MacControlError(
                code: "superseded",
                message: "The primary Gateway changed during this request. Inspect status before retrying.")
        }
    }

    func gateways() async throws -> [MacControlGatewayStatus] {
        let profiles = try await MacGatewayProfileStore.shared.catalogProfiles()
        var result: [MacControlGatewayStatus] = []
        for profile in profiles {
            let connection = await MacGatewayConnectionFleet.shared.existingConnection(profileID: profile.profile.id)
            let summary = await connection?.connectionSummary()
            let expired = profile.browserSessionExpiresAt.map { $0 <= Date() } ?? false
            let identity: MacControlIdentity? = if let subject = profile.browserSessionSubject,
                                                   let expiry = profile.browserSessionExpiresAt
            {
                MacControlIdentity(subject: subject, expiresAt: expiry.ISO8601Format())
            } else {
                nil
            }
            // Legacy unauthenticated profiles have no credential field; token is the existing shared-secret route.
            let auth = switch profile.authKind {
            case .browser: "browser"
            case .password: "password"
            case .token, nil: "token"
            }
            result.append(MacControlGatewayStatus(
                id: profile.profile.id,
                name: profile.profile.name,
                url: profile.profile.url.absoluteString,
                auth: auth,
                identity: identity,
                connection: MacControlConnectionStatus(
                    state: summary?.connected == true && !expired ? "connected" : "disconnected",
                    error: expired ? "Browser sign-in expired. Reconnect this Gateway." : nil)))
        }
        return result
    }

    func addGateway(_ request: MacControlRequest) async throws -> MacControlGatewayStatus {
        try Task.checkCancellation()
        let profile = try await GatewayBrowserSignInCoordinator.connect(
            name: request.name ?? "",
            address: request.url ?? "",
            token: request.token ?? "",
            password: request.password ?? "")
        let gateway = try await self.gateway(id: profile.id)
        return try await Self.connectSavedGateway(gateway, deadline: request.deadline) {
            try Task.checkCancellation()
            let binding = try await MacGatewayConnectionFleet.shared.binding(profileID: profile.id)
            try Task.checkCancellation()
            _ = try await binding.connection.acquireServerLease()
            try Task.checkCancellation()
            let summary = await binding.connection.connectionSummary()
            return MacControlConnectionStatus(
                state: summary.connected ? "connected" : "disconnected", gatewayVersion: summary.gatewayVersion)
        }
    }

    static func connectSavedGateway(
        _ gateway: MacControlGatewayStatus,
        deadline: Date?,
        connect: @escaping @Sendable () async throws -> MacControlConnectionStatus) async throws
        -> MacControlGatewayStatus
    {
        guard gateway.auth != "browser" else { return gateway }
        var result = gateway
        do {
            try Task.checkCancellation()
            let remaining = min(310, deadline?.timeIntervalSinceNow ?? 310)
            guard remaining > 0 else { throw CancellationError() }
            result.connection = try await AsyncTimeout.withTimeout(
                seconds: remaining,
                onTimeout: { CancellationError() },
                operation: connect)
        } catch {
            try Task.checkCancellation()
            // Saving succeeded; connectivity failure must not turn it into a failed add or expose credentials.
            result.connection = MacControlConnectionStatus(
                state: "disconnected", error: "Connection unavailable. Check Gateway settings and reconnect.")
        }
        return result
    }

    func removeGateway(id: String) async throws {
        try Task.checkCancellation()
        _ = try await MacGatewayProfileStore.shared.remove(profileID: id)
    }

    func reconnectGateway(id: String) async throws -> MacControlGatewayStatus {
        let profiles = try await MacGatewayProfileStore.shared.catalogProfiles()
        guard let profile = profiles.first(where: { $0.profile.id == id }) else {
            throw MacGatewayProfileError.profileNotFound
        }
        try Task.checkCancellation()
        if profile.usesBrowserIdentity {
            _ = try await GatewayBrowserSignInCoordinator.connect(
                name: profile.profile.name,
                address: profile.profile.url.absoluteString,
                token: "",
                password: "")
        } else {
            let binding = try await MacGatewayConnectionFleet.shared.binding(profileID: id)
            try Task.checkCancellation()
            await binding.connection.shutdown(ifCurrent: { !Task.isCancelled })
            try Task.checkCancellation()
            _ = try await binding.connection.acquireServerLease()
        }
        return try await self.gateway(id: id)
    }

    private func gateway(id: String) async throws -> MacControlGatewayStatus {
        guard let profile = try await self.gateways().first(where: { $0.id == id }) else {
            throw MacGatewayProfileError.profileNotFound
        }
        return profile
    }
}
