import Foundation
import OSLog

/// Manages the SSH tunnel that forwards the remote gateway/control port to localhost.
actor RemoteTunnelManager {
    static let shared = RemoteTunnelManager()

    struct Route: Equatable, Sendable {
        let localPort: UInt16
        let generation: UInt64
    }

    private struct ActiveTunnel {
        let tunnel: RemotePortTunnel
        let configuration: RemotePortTunnel.Configuration
        let route: Route
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "remote-tunnel")
    private var controlTunnel: ActiveTunnel?
    private var createInFlight: (
        token: UUID,
        configuration: RemotePortTunnel.Configuration,
        task: Task<RemotePortTunnel, Error>)?
    private var tunnelGeneration: UInt64 = 0
    private var restartInFlight = false
    private var lastRestartAt: Date?
    private let restartBackoffSeconds: TimeInterval = 2.0

    func controlTunnelRouteIfRunning() async -> Route? {
        guard let configuration = try? RemotePortTunnel.configuration(
            remotePort: GatewayEnvironment.gatewayPort())
        else {
            self.createInFlight?.task.cancel()
            self.createInFlight = nil
            self.controlTunnel?.tunnel.terminate()
            self.controlTunnel = nil
            return nil
        }
        return await self.controlTunnelRouteIfRunning(configuration: configuration)
    }

    func isCurrentRoute(_ route: Route) async -> Bool {
        await self.controlTunnelRouteIfRunning() == route
    }

    private func controlTunnelRouteIfRunning(
        configuration: RemotePortTunnel.Configuration) async -> Route?
    {
        if self.restartInFlight {
            self.logger.info("control tunnel restart in flight; skipping reuse check")
            return nil
        }
        if let active = controlTunnel {
            guard Self.canReuse(active.configuration, for: configuration) else {
                self.logger.info("configured SSH route changed; replacing control tunnel")
                active.tunnel.terminate()
                self.controlTunnel = nil
                self.tunnelGeneration &+= 1
                return nil
            }
            guard active.tunnel.process.isRunning,
                  let local = active.tunnel.localPort
            else {
                self.controlTunnel = nil
                self.tunnelGeneration &+= 1
                return nil
            }
            let pid = active.tunnel.process.processIdentifier
            let isListening = await PortGuardian.shared.isListening(port: Int(local), pid: pid)
            // PortGuardian suspends this actor. A concurrent stop or replacement
            // must win; never return or retire the captured tunnel afterward.
            guard let current = controlTunnel,
                  current.tunnel === active.tunnel,
                  current.configuration == active.configuration,
                  current.route == active.route
            else { return nil }
            if isListening {
                self.logger.info("reusing active SSH tunnel localPort=\(local, privacy: .public)")
                return current.route
            }
            self.logger.error(
                "active SSH tunnel on port \(local, privacy: .public) is not listening; restarting")
            await self.beginRestart()
            active.tunnel.terminate()
            self.controlTunnel = nil
            self.tunnelGeneration &+= 1
        }
        return nil
    }

    private static func canReuse(
        _ active: RemotePortTunnel.Configuration,
        for desired: RemotePortTunnel.Configuration) -> Bool
    {
        active == desired
    }

    /// Ensure an SSH tunnel is running for the gateway control port.
    /// Returns the local forwarded port (usually the configured gateway port).
    func ensureControlTunnel() async throws -> UInt16 {
        try await self.ensureControlTunnelRoute().localPort
    }

    func ensureControlTunnelRoute() async throws -> Route {
        let configuration = try RemotePortTunnel.configuration(
            remotePort: GatewayEnvironment.gatewayPort())
        let identitySet = !configuration.identity.isEmpty
        self.logger.info(
            "ensure SSH tunnel target=\(configuration.target.host, privacy: .public) " +
                "identitySet=\(identitySet, privacy: .public)")

        if let route = await self.controlTunnelRouteIfRunning(configuration: configuration) {
            return route
        }
        if let create = self.createInFlight {
            if create.configuration == configuration {
                self.logger.info("control tunnel create in flight; joining")
                let tunnel: RemotePortTunnel
                do {
                    tunnel = try await create.task.value
                } catch {
                    if self.createInFlight?.token == create.token {
                        self.createInFlight = nil
                    }
                    throw error
                }
                return try await self.installCreatedTunnel(
                    tunnel,
                    token: create.token,
                    configuration: configuration,
                    fallbackPort: UInt16(GatewayEnvironment.gatewayPort()))
            }
            // A suspended create owns the prior SSH route. It must not become
            // the loopback endpoint for the replacement Gateway.
            create.task.cancel()
            self.createInFlight = nil
        }
        await self.waitForRestartBackoffIfNeeded()

        let desiredPort = UInt16(GatewayEnvironment.gatewayPort())
        let token = UUID()
        let task = Task {
            try await RemotePortTunnel.create(
                configuration: configuration,
                preferredLocalPort: desiredPort,
                allowRandomLocalPort: true)
        }
        self.createInFlight = (token: token, configuration: configuration, task: task)
        let tunnel: RemotePortTunnel
        do {
            tunnel = try await task.value
        } catch {
            if self.createInFlight?.token == token {
                self.createInFlight = nil
            }
            throw error
        }
        return try await self.installCreatedTunnel(
            tunnel,
            token: token,
            configuration: configuration,
            fallbackPort: desiredPort)
    }

    private func installCreatedTunnel(
        _ tunnel: RemotePortTunnel,
        token: UUID,
        configuration: RemotePortTunnel.Configuration,
        fallbackPort: UInt16) async throws -> Route
    {
        if let active = controlTunnel, active.tunnel === tunnel {
            return active.route
        }
        guard self.createInFlight?.token == token else {
            tunnel.terminate()
            throw CancellationError()
        }
        let currentConfiguration: RemotePortTunnel.Configuration
        do {
            currentConfiguration = try RemotePortTunnel.configuration(
                remotePort: GatewayEnvironment.gatewayPort())
        } catch {
            self.createInFlight = nil
            tunnel.terminate()
            throw error
        }
        guard currentConfiguration == configuration else {
            self.createInFlight = nil
            tunnel.terminate()
            return try await self.ensureControlTunnelRoute()
        }
        self.createInFlight = nil
        self.tunnelGeneration &+= 1
        let resolvedPort = tunnel.localPort ?? fallbackPort
        let route = Route(localPort: resolvedPort, generation: tunnelGeneration)
        self.controlTunnel = ActiveTunnel(
            tunnel: tunnel,
            configuration: configuration,
            route: route)
        self.endRestart()
        self.logger.info(
            "ssh tunnel ready localPort=\(resolvedPort, privacy: .public) " +
                "generation=\(route.generation, privacy: .public)")
        return route
    }

    func stopAll() {
        // Invalidate every captured route before terminating processes. Delayed
        // health checks and create completions cannot resurrect this epoch.
        self.tunnelGeneration &+= 1
        self.createInFlight?.task.cancel()
        self.createInFlight = nil
        self.controlTunnel?.tunnel.terminate()
        self.controlTunnel = nil
    }

    #if DEBUG
    static func _testCanReuse(
        _ active: RemotePortTunnel.Configuration,
        for desired: RemotePortTunnel.Configuration) -> Bool
    {
        self.canReuse(active, for: desired)
    }
    #endif

    private func beginRestart() async {
        guard !self.restartInFlight else { return }
        self.restartInFlight = true
        self.lastRestartAt = Date()
        self.logger.info("control tunnel restart started")
        Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(self.restartBackoffSeconds * 1_000_000_000))
            await self.endRestart()
        }
    }

    private func endRestart() {
        if self.restartInFlight {
            self.restartInFlight = false
            self.logger.info("control tunnel restart finished")
        }
    }

    private func waitForRestartBackoffIfNeeded() async {
        guard let last = lastRestartAt else { return }
        let elapsed = Date().timeIntervalSince(last)
        let remaining = self.restartBackoffSeconds - elapsed
        guard remaining > 0 else { return }
        self.logger.info(
            "control tunnel restart backoff \(remaining, privacy: .public)s")
        try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
    }

    // Reuse is cheap only while both the listener and its captured SSH route remain current.
}
