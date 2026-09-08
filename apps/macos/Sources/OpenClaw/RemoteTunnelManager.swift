import Foundation
import OSLog

/// Manages the SSH tunnel that forwards the remote gateway/control port to localhost.
actor RemoteTunnelManager {
    static let shared = RemoteTunnelManager()

    struct Route: Equatable, Sendable {
        let localPort: UInt16
        let generation: UInt64
    }

    private enum RouteLookupResult {
        case none
        case retired(UInt64)
        case staleConfiguration
        case route(Route)
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
    private var retirementInFlight: (token: UUID, task: Task<Void, Never>)?
    private var tunnelGeneration: UInt64 = 0
    private var lifecycleGeneration: UInt64 = 0
    private var isShutDown = false
    private var lastRestartAt: Date?
    private let restartBackoffSeconds: TimeInterval = 2.0

    func controlTunnelStatus() -> (running: Bool, localPort: UInt16?) {
        guard !self.isShutDown, self.retirementInFlight == nil,
              let active = self.controlTunnel, active.tunnel.isRunning
        else { return (false, nil) }
        return (true, active.tunnel.localPort)
    }

    func controlTunnelRouteIfRunning() async -> Route? {
        guard !self.isShutDown, self.retirementInFlight == nil else { return nil }
        guard let configuration = try? RemotePortTunnel.configuration(
            remotePort: GatewayEnvironment.gatewayPort())
        else {
            self.beginRetirement()
            await self.waitForRetirement()
            return nil
        }
        switch await self.lookupControlTunnelRoute(
            configuration: configuration,
            lifecycleGeneration: self.lifecycleGeneration)
        {
        case let .route(route):
            return route
        case .none, .retired, .staleConfiguration:
            return nil
        }
    }

    func isCurrentRoute(_ route: Route) async -> Bool {
        await self.controlTunnelRouteIfRunning() == route
    }

    private func lookupControlTunnelRoute(
        configuration: RemotePortTunnel.Configuration,
        lifecycleGeneration: UInt64) async -> RouteLookupResult
    {
        await self.waitForRetirement()
        guard self.lifecycleGeneration == lifecycleGeneration else { return .none }
        guard let currentConfiguration = try? RemotePortTunnel.configuration(
            remotePort: GatewayEnvironment.gatewayPort()),
            Self.isCurrentConfiguration(requested: configuration, current: currentConfiguration)
        else {
            return .staleConfiguration
        }
        if let active = controlTunnel {
            guard Self.canReuse(active.configuration, for: configuration) else {
                self.logger.info("configured SSH route changed; replacing control tunnel")
                let replacementGeneration = self.beginRetirement()
                await self.waitForRetirement()
                return .retired(replacementGeneration)
            }
            guard active.tunnel.isRunning,
                  let local = active.tunnel.localPort
            else {
                let replacementGeneration = self.beginRetirement()
                await self.waitForRetirement()
                return .retired(replacementGeneration)
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
            if (try? RemotePortTunnel.configuration(remotePort: GatewayEnvironment.gatewayPort())) != configuration {
                return .staleConfiguration
            }
            if isListening {
                self.logger.info("reusing active SSH tunnel localPort=\(local, privacy: .public)")
                return .route(current.route)
            }
            self.logger.error(
                "active SSH tunnel on port \(local, privacy: .public) is not listening; restarting")
            let replacementGeneration = self.beginRetirement()
            self.lastRestartAt = Date()
            await self.waitForRetirement()
            return .retired(replacementGeneration)
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

    private func resolveLookup(
        _ result: RouteLookupResult,
        lifecycleGeneration: UInt64) async throws -> Route?
    {
        try Task.checkCancellation()
        switch result {
        case let .route(route):
            guard self.lifecycleGeneration == lifecycleGeneration else { throw CancellationError() }
            return route
        case let .retired(replacementGeneration):
            guard self.lifecycleGeneration == replacementGeneration else {
                throw CancellationError()
            }
            // Another caller may have installed the replacement during retirement.
            return try await self.ensureControlTunnelRoute(lifecycleGeneration: replacementGeneration)
        case .staleConfiguration:
            guard self.lifecycleGeneration == lifecycleGeneration else {
                throw CancellationError()
            }
            return try await self.ensureControlTunnelRoute(
                lifecycleGeneration: lifecycleGeneration)
        case .none:
            guard self.lifecycleGeneration == lifecycleGeneration else {
                throw CancellationError()
            }
            return nil
        }
    }

    /// Ensure an SSH tunnel is running for the gateway control port.
    /// Returns the local forwarded port (usually the configured gateway port).
    func ensureControlTunnel() async throws -> UInt16 {
        try await self.ensureControlTunnelRoute().localPort
    }

    func ensureControlTunnelRoute() async throws -> Route {
        guard !self.isShutDown else { throw CancellationError() }
        return try await self.ensureControlTunnelRoute(
            lifecycleGeneration: self.lifecycleGeneration)
    }

    private func ensureControlTunnelRoute(
        lifecycleGeneration: UInt64) async throws -> Route
    {
        var waitedForBackoff = false
        while true {
            try Task.checkCancellation()
            guard self.lifecycleGeneration == lifecycleGeneration else {
                throw CancellationError()
            }
            let configuration = try RemotePortTunnel.configuration(
                remotePort: GatewayEnvironment.gatewayPort())
            if let route = try await self.resolveLookup(
                self.lookupControlTunnelRoute(
                    configuration: configuration,
                    lifecycleGeneration: lifecycleGeneration),
                lifecycleGeneration: lifecycleGeneration)
            {
                return route
            }
            if let route = try await self.resolveLookup(
                self.joinCreateInFlight(
                    configuration: configuration,
                    lifecycleGeneration: lifecycleGeneration),
                lifecycleGeneration: lifecycleGeneration)
            {
                return route
            }
            if !waitedForBackoff {
                try await self.waitForRestartBackoffIfNeeded()
                waitedForBackoff = true
                continue
            }

            // Every suspension can admit another owner. Check all slots and the
            // current configuration in the same actor turn that claims creation.
            try Task.checkCancellation()
            guard self.lifecycleGeneration == lifecycleGeneration else { throw CancellationError() }
            let currentConfiguration = try RemotePortTunnel.configuration(
                remotePort: GatewayEnvironment.gatewayPort())
            guard self.retirementInFlight == nil, self.controlTunnel == nil,
                  self.createInFlight == nil, currentConfiguration == configuration
            else { continue }

            let desiredPort = configuration.preferredLocalPort ?? UInt16(GatewayEnvironment.gatewayPort())
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
                if self.createInFlight?.token == token { self.createInFlight = nil }
                throw error
            }
            return try await self.installCreatedTunnel(
                tunnel,
                token: token,
                configuration: configuration,
                lifecycleGeneration: lifecycleGeneration,
                fallbackPort: desiredPort)
        }
    }

    private func joinCreateInFlight(
        configuration: RemotePortTunnel.Configuration,
        lifecycleGeneration: UInt64) async throws -> RouteLookupResult
    {
        await self.waitForRetirement()
        guard self.lifecycleGeneration == lifecycleGeneration else { throw CancellationError() }
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
            let replacementGeneration = self.beginRetirement()
            await self.waitForRetirement()
            return .retired(replacementGeneration)
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

    @discardableResult
    private func beginRetirement() -> UInt64 {
        self.lifecycleGeneration &+= 1
        let active = self.controlTunnel?.tunnel
        let create = self.createInFlight?.task
        guard active != nil || create != nil else { return self.lifecycleGeneration }
        self.controlTunnel = nil
        self.createInFlight = nil
        self.tunnelGeneration &+= 1
        create?.cancel()

        // Publish cleanup ownership before suspending the actor. Reentrant ensures
        // must join this barrier before reserving the ledger for a replacement.
        let previous = self.retirementInFlight?.task
        self.retirementInFlight = (UUID(), Task {
            await previous?.value
            if let tunnel = try? await create?.value { await tunnel.terminate() }
            await active?.terminate()
        })
        return self.lifecycleGeneration
    }

    private func waitForRetirement() async {
        while let retirement = self.retirementInFlight {
            await retirement.task.value
            if self.retirementInFlight?.token == retirement.token {
                self.retirementInFlight = nil
            }
        }
    }

    private func installCreatedTunnel(
        _ tunnel: RemotePortTunnel,
        token: UUID,
        configuration: RemotePortTunnel.Configuration,
        lifecycleGeneration: UInt64,
        fallbackPort: UInt16) async throws -> Route
    {
        guard self.lifecycleGeneration == lifecycleGeneration else {
            await self.waitForRetirement()
            throw CancellationError()
        }
        if let active = controlTunnel, active.tunnel === tunnel {
            return active.route
        }
        guard self.createInFlight?.token == token else {
            await self.waitForRetirement()
            throw CancellationError()
        }
        let currentConfiguration: RemotePortTunnel.Configuration
        do {
            currentConfiguration = try RemotePortTunnel.configuration(
                remotePort: GatewayEnvironment.gatewayPort())
        } catch {
            self.beginRetirement()
            await self.waitForRetirement()
            throw error
        }
        guard currentConfiguration == configuration else {
            let replacementGeneration = self.beginRetirement()
            await self.waitForRetirement()
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
        self.logger.info(
            "ssh tunnel ready localPort=\(resolvedPort, privacy: .public) " +
                "generation=\(route.generation, privacy: .public)")
        return route
    }

    func shutdown() async {
        // Quit closes admission permanently; reconnect and mode changes still use stopAll.
        self.isShutDown = true
        await self.stopAll()
    }

    func stopAll() async {
        // Invalidate every captured route before terminating processes. Delayed
        // health checks and create completions cannot resurrect this epoch.
        self.beginRetirement()
        await self.waitForRetirement()
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
