import Foundation
import OSLog

/// Manages the SSH tunnel that forwards the remote gateway/control port to localhost.
actor RemoteTunnelManager {
    static let shared = RemoteTunnelManager()

    struct Route: Equatable, Sendable {
        let localPort: UInt16
        let generation: UInt64
    }

    private enum CreateJoinResult {
        case none
        case replacedMismatchedCreate(UInt64)
        case staleConfiguration
        case route(Route)
    }

    private enum ActiveRouteLookupResult {
        case none
        case retiredActive(UInt64)
        case staleConfiguration
        case route(Route)
    }

    private struct EnsureStepResolution {
        let route: Route?
        let lifecycleGeneration: UInt64
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
        lifecycleGeneration: UInt64,
        task: Task<RemotePortTunnel, Error>)?
    private var tunnelGeneration: UInt64 = 0
    private var lifecycleGeneration: UInt64 = 0
    private var restartInFlight = false
    private var lastRestartAt: Date?
    private let restartBackoffSeconds: TimeInterval = 2.0

    func controlTunnelRouteIfRunning() async -> Route? {
        guard let configuration = try? RemotePortTunnel.configuration(
            remotePort: GatewayEnvironment.gatewayPort())
        else {
            self.lifecycleGeneration &+= 1
            self.createInFlight?.task.cancel()
            self.createInFlight = nil
            let tunnel = self.controlTunnel?.tunnel
            self.controlTunnel = nil
            if tunnel != nil {
                self.tunnelGeneration &+= 1
            }
            await tunnel?.terminate()
            return nil
        }
        switch await self.lookupControlTunnelRoute(configuration: configuration) {
        case let .route(route):
            return route
        case .none, .retiredActive, .staleConfiguration:
            return nil
        }
    }

    func isCurrentRoute(_ route: Route) async -> Bool {
        await self.controlTunnelRouteIfRunning() == route
    }

    private func lookupControlTunnelRoute(
        configuration: RemotePortTunnel.Configuration,
        requireCurrentConfiguration: Bool = false) async -> ActiveRouteLookupResult
    {
        if requireCurrentConfiguration {
            guard let currentConfiguration = try? RemotePortTunnel.configuration(
                remotePort: GatewayEnvironment.gatewayPort()),
                Self.isCurrentConfiguration(
                    requested: configuration,
                    current: currentConfiguration)
            else {
                return .staleConfiguration
            }
        }
        if self.restartInFlight {
            self.logger.info("control tunnel restart in flight; skipping reuse check")
            return .none
        }
        if let active = controlTunnel {
            guard Self.canReuse(active.configuration, for: configuration) else {
                self.logger.info("configured SSH route changed; replacing control tunnel")
                self.lifecycleGeneration &+= 1
                let replacementGeneration = self.lifecycleGeneration
                self.controlTunnel = nil
                self.tunnelGeneration &+= 1
                await active.tunnel.terminate()
                return .retiredActive(replacementGeneration)
            }
            guard active.tunnel.isRunning,
                  let local = active.tunnel.localPort
            else {
                self.lifecycleGeneration &+= 1
                let replacementGeneration = self.lifecycleGeneration
                self.controlTunnel = nil
                self.tunnelGeneration &+= 1
                return .retiredActive(replacementGeneration)
            }
            let pid = active.tunnel.processIdentifier
            let isListening = await PortGuardian.shared.isListening(port: Int(local), pid: pid)
            // PortGuardian suspends this actor. A concurrent stop or replacement
            // must win; never return or retire the captured tunnel afterward.
            guard let current = controlTunnel,
                  current.tunnel === active.tunnel,
                  current.configuration == active.configuration,
                  current.route == active.route
            else { return .none }
            if isListening {
                self.logger.info("reusing active SSH tunnel localPort=\(local, privacy: .public)")
                return .route(current.route)
            }
            self.logger.error(
                "active SSH tunnel on port \(local, privacy: .public) is not listening; restarting")
            self.lifecycleGeneration &+= 1
            let replacementGeneration = self.lifecycleGeneration
            self.controlTunnel = nil
            self.tunnelGeneration &+= 1
            self.beginRestart()
            await active.tunnel.terminate()
            return .retiredActive(replacementGeneration)
        }
        return .none
    }

    private static func canReuse(
        _ active: RemotePortTunnel.Configuration,
        for desired: RemotePortTunnel.Configuration) -> Bool
    {
        active == desired
    }

    private static func isCurrentConfiguration(
        requested: RemotePortTunnel.Configuration,
        current: RemotePortTunnel.Configuration) -> Bool
    {
        requested == current
    }

    private func resolveActiveLookup(
        _ result: ActiveRouteLookupResult,
        lifecycleGeneration: UInt64) async throws -> EnsureStepResolution
    {
        switch result {
        case let .route(route):
            return EnsureStepResolution(route: route, lifecycleGeneration: lifecycleGeneration)
        case let .retiredActive(replacementGeneration):
            guard self.lifecycleGeneration == replacementGeneration else {
                throw CancellationError()
            }
            return EnsureStepResolution(route: nil, lifecycleGeneration: replacementGeneration)
        case .staleConfiguration:
            try Task.checkCancellation()
            guard self.lifecycleGeneration == lifecycleGeneration else {
                throw CancellationError()
            }
            let route = try await self.ensureControlTunnelRoute(
                lifecycleGeneration: lifecycleGeneration)
            return EnsureStepResolution(route: route, lifecycleGeneration: lifecycleGeneration)
        case .none:
            guard self.lifecycleGeneration == lifecycleGeneration else {
                throw CancellationError()
            }
            return EnsureStepResolution(route: nil, lifecycleGeneration: lifecycleGeneration)
        }
    }

    private func resolveCreateJoin(
        _ result: CreateJoinResult,
        lifecycleGeneration: UInt64) async throws -> EnsureStepResolution
    {
        switch result {
        case let .route(route):
            return EnsureStepResolution(route: route, lifecycleGeneration: lifecycleGeneration)
        case let .replacedMismatchedCreate(replacementGeneration):
            guard self.lifecycleGeneration == replacementGeneration else {
                throw CancellationError()
            }
            return EnsureStepResolution(route: nil, lifecycleGeneration: replacementGeneration)
        case .staleConfiguration:
            try Task.checkCancellation()
            guard self.lifecycleGeneration == lifecycleGeneration else {
                throw CancellationError()
            }
            let route = try await self.ensureControlTunnelRoute(
                lifecycleGeneration: lifecycleGeneration)
            return EnsureStepResolution(route: route, lifecycleGeneration: lifecycleGeneration)
        case .none:
            guard self.lifecycleGeneration == lifecycleGeneration else {
                throw CancellationError()
            }
            return EnsureStepResolution(route: nil, lifecycleGeneration: lifecycleGeneration)
        }
    }

    /// Ensure an SSH tunnel is running for the gateway control port.
    /// Returns the local forwarded port (usually the configured gateway port).
    func ensureControlTunnel() async throws -> UInt16 {
        try await self.ensureControlTunnelRoute().localPort
    }

    func ensureControlTunnelRoute() async throws -> Route {
        try await self.ensureControlTunnelRoute(
            lifecycleGeneration: self.lifecycleGeneration)
    }

    private func ensureControlTunnelRoute(
        lifecycleGeneration initialLifecycleGeneration: UInt64) async throws -> Route
    {
        var lifecycleGeneration = initialLifecycleGeneration
        try Task.checkCancellation()
        guard self.lifecycleGeneration == lifecycleGeneration else {
            throw CancellationError()
        }

        let configuration = try RemotePortTunnel.configuration(
            remotePort: GatewayEnvironment.gatewayPort())
        let identitySet = !configuration.identity.isEmpty
        self.logger.info(
            "ensure SSH tunnel target=\(configuration.target.host, privacy: .public) " +
                "identitySet=\(identitySet, privacy: .public)")

        var resolution = try await self.resolveActiveLookup(
            self.lookupControlTunnelRoute(
                configuration: configuration,
                requireCurrentConfiguration: true),
            lifecycleGeneration: lifecycleGeneration)
        if let route = resolution.route {
            return route
        }
        lifecycleGeneration = resolution.lifecycleGeneration

        var joinResult = try await self.joinCreateInFlight(configuration: configuration)
        resolution = try await self.resolveCreateJoin(
            joinResult,
            lifecycleGeneration: lifecycleGeneration)
        if let route = resolution.route {
            return route
        }
        lifecycleGeneration = resolution.lifecycleGeneration

        try await self.waitForRestartBackoffIfNeeded()
        try Task.checkCancellation()
        guard self.lifecycleGeneration == lifecycleGeneration else {
            throw CancellationError()
        }

        // The backoff suspends this actor. Another caller may have installed or
        // started the canonical tunnel while we slept, so join it instead of
        // launching a duplicate SSH process.
        resolution = try await self.resolveActiveLookup(
            self.lookupControlTunnelRoute(
                configuration: configuration,
                requireCurrentConfiguration: true),
            lifecycleGeneration: lifecycleGeneration)
        if let route = resolution.route {
            return route
        }
        lifecycleGeneration = resolution.lifecycleGeneration

        joinResult = try await self.joinCreateInFlight(configuration: configuration)
        resolution = try await self.resolveCreateJoin(
            joinResult,
            lifecycleGeneration: lifecycleGeneration)
        if let route = resolution.route {
            return route
        }
        lifecycleGeneration = resolution.lifecycleGeneration
        try Task.checkCancellation()
        guard self.lifecycleGeneration == lifecycleGeneration else {
            throw CancellationError()
        }

        let currentConfiguration = try RemotePortTunnel.configuration(
            remotePort: GatewayEnvironment.gatewayPort())
        guard currentConfiguration == configuration else {
            guard self.lifecycleGeneration == lifecycleGeneration else {
                throw CancellationError()
            }
            return try await self.ensureControlTunnelRoute(
                lifecycleGeneration: lifecycleGeneration)
        }

        let desiredPort = UInt16(GatewayEnvironment.gatewayPort())
        let token = UUID()
        let task = Task {
            try await RemotePortTunnel.create(
                configuration: configuration,
                preferredLocalPort: desiredPort,
                allowRandomLocalPort: true)
        }
        self.createInFlight = (
            token: token,
            configuration: configuration,
            lifecycleGeneration: lifecycleGeneration,
            task: task)
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
            lifecycleGeneration: lifecycleGeneration,
            fallbackPort: desiredPort)
    }

    private func joinCreateInFlight(
        configuration: RemotePortTunnel.Configuration) async throws -> CreateJoinResult
    {
        guard let create = createInFlight else { return .none }
        guard create.configuration == configuration else {
            let currentConfiguration = try RemotePortTunnel.configuration(
                remotePort: GatewayEnvironment.gatewayPort())
            guard Self.isCurrentConfiguration(
                requested: configuration,
                current: currentConfiguration)
            else {
                return .staleConfiguration
            }

            // A suspended create owns the prior SSH route. It must not become
            // the loopback endpoint for the replacement Gateway.
            self.lifecycleGeneration &+= 1
            let replacementGeneration = self.lifecycleGeneration
            create.task.cancel()
            self.createInFlight = nil
            return .replacedMismatchedCreate(replacementGeneration)
        }

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
        return try await .route(self.installCreatedTunnel(
            tunnel,
            token: create.token,
            configuration: configuration,
            lifecycleGeneration: create.lifecycleGeneration,
            fallbackPort: UInt16(GatewayEnvironment.gatewayPort())))
    }

    private func installCreatedTunnel(
        _ tunnel: RemotePortTunnel,
        token: UUID,
        configuration: RemotePortTunnel.Configuration,
        lifecycleGeneration: UInt64,
        fallbackPort: UInt16) async throws -> Route
    {
        guard self.lifecycleGeneration == lifecycleGeneration else {
            await tunnel.terminate()
            throw CancellationError()
        }
        if let active = controlTunnel, active.tunnel === tunnel {
            return active.route
        }
        guard self.createInFlight?.token == token else {
            await tunnel.terminate()
            throw CancellationError()
        }
        let currentConfiguration: RemotePortTunnel.Configuration
        do {
            currentConfiguration = try RemotePortTunnel.configuration(
                remotePort: GatewayEnvironment.gatewayPort())
        } catch {
            self.lifecycleGeneration &+= 1
            self.createInFlight = nil
            await tunnel.terminate()
            throw error
        }
        guard currentConfiguration == configuration else {
            self.lifecycleGeneration &+= 1
            let replacementGeneration = self.lifecycleGeneration
            self.createInFlight = nil
            await tunnel.terminate()
            try Task.checkCancellation()
            guard self.lifecycleGeneration == replacementGeneration else {
                throw CancellationError()
            }
            return try await self.ensureControlTunnelRoute(
                lifecycleGeneration: replacementGeneration)
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

    func stopAll() async {
        // Invalidate every captured route before terminating processes. Delayed
        // health checks and create completions cannot resurrect this epoch.
        self.lifecycleGeneration &+= 1
        self.tunnelGeneration &+= 1
        self.createInFlight?.task.cancel()
        self.createInFlight = nil
        let tunnel = self.controlTunnel?.tunnel
        self.controlTunnel = nil
        await tunnel?.terminate()
    }

    #if DEBUG
    static func _testCanReuse(
        _ active: RemotePortTunnel.Configuration,
        for desired: RemotePortTunnel.Configuration) -> Bool
    {
        self.canReuse(active, for: desired)
    }

    static func _testIsCurrentConfiguration(
        requested: RemotePortTunnel.Configuration,
        current: RemotePortTunnel.Configuration) -> Bool
    {
        self.isCurrentConfiguration(requested: requested, current: current)
    }

    static func _testWaitForRestartBackoff(
        seconds: TimeInterval,
        sleep: @escaping @Sendable (UInt64) async throws -> Void) async throws
    {
        try await self.waitForRestartBackoff(seconds: seconds, sleep: sleep)
    }
    #endif

    private func beginRestart() {
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

    private func waitForRestartBackoffIfNeeded() async throws {
        guard let last = lastRestartAt else { return }
        let elapsed = Date().timeIntervalSince(last)
        let remaining = self.restartBackoffSeconds - elapsed
        guard remaining > 0 else { return }
        self.logger.info(
            "control tunnel restart backoff \(remaining, privacy: .public)s")
        try await Self.waitForRestartBackoff(seconds: remaining)
    }

    private nonisolated static func waitForRestartBackoff(
        seconds: TimeInterval,
        sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) })
        async throws
    {
        try Task.checkCancellation()
        try await sleep(UInt64(seconds * 1_000_000_000))
        try Task.checkCancellation()
    }

    // Reuse is cheap only while both the listener and its captured SSH route remain current.
}
