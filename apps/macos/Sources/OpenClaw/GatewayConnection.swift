import ConcurrencyExtras
import CryptoKit
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

private let gatewayConnectionLogger = Logger(subsystem: "ai.openclaw", category: "gateway.connection")

/// Owns one Gateway websocket shared by its callers. The primary app runtime
/// uses `.shared`; saved-profile windows use independent connections.
actor GatewayConnection {
    static let shared: GatewayConnection = {
        #if DEBUG
        // Rendered test views can request previews through the shared connection.
        // Only explicitly injected test routes may reach a transport or credentials.
        if ProcessInfo.processInfo.isRunningTests {
            return GatewayConnection(testEndpointProvider: { throw URLError(.notConnectedToInternet) })
        }
        #endif
        return GatewayConnection(
            endpointProvider: GatewayConnection.defaultEndpointProvider,
            currentEndpointRevision: { GatewayEndpointStore.shared.routeRevision })
    }()

    nonisolated static let operatorClientCaps = [
        OpenClawGatewayClientCapability.agentKind,
        OpenClawGatewayClientCapability.inlineWidgets,
        OpenClawGatewayClientCapability.usageRefreshing,
    ]

    typealias Config = (url: URL, token: String?, password: String?)

    struct EndpointSnapshot {
        let config: Config
        let tls: GatewayTLSRoute?
        let routeAuthority: UInt64?
        let deviceAuthGatewayID: String?
        let revision: UInt64?

        init(
            config: Config,
            tls: GatewayTLSRoute? = nil,
            routeAuthority: UInt64?,
            deviceAuthGatewayID: String? = nil,
            revision: UInt64? = nil)
        {
            self.config = config
            self.tls = tls
            self.routeAuthority = routeAuthority
            self.deviceAuthGatewayID = deviceAuthGatewayID
            self.revision = revision
        }
    }

    typealias EndpointProvider = @Sendable () async throws -> EndpointSnapshot
    typealias SessionProvider = @Sendable (GatewayTLSRoute?) -> WebSocketSessionBox?

    struct Route: Equatable, Sendable {
        fileprivate let generation: UInt64
        fileprivate let authority: UInt64?
        let url: URL
        fileprivate let token: String?
        fileprivate let password: String?
        let tls: GatewayTLSRoute?
        fileprivate let deviceAuthGatewayID: String?
        let activationOwnershipFingerprint: String?

        fileprivate func matches(_ endpoint: EndpointSnapshot) -> Bool {
            self.authority == endpoint.routeAuthority &&
                self.url == endpoint.config.url &&
                self.token == endpoint.config.token &&
                self.password == endpoint.config.password &&
                GatewayTLSRoute.hasSameConnectionIdentity(self.tls, endpoint.tls) &&
                self.deviceAuthGatewayID == endpoint.deviceAuthGatewayID
        }
    }

    /// One connected Gateway server, not merely an endpoint configuration.
    /// A reconnect at the same URL creates a different lease.
    struct ServerLease: Sendable, Hashable {
        // Managed-image HTTP reuses this captured route from its focused extension file.
        // Carrying the snapshot forward prevents endpoint or TLS rediscovery after suspension.
        let route: Route
        let socketGeneration: UInt64
        let endpointRevision: UInt64?
        fileprivate let client: GatewayChannelActor

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.client === rhs.client && lhs.route.generation == rhs.route.generation &&
                lhs.socketGeneration == rhs.socketGeneration && lhs.endpointRevision == rhs.endpointRevision
        }

        func hash(into hasher: inout Hasher) {
            hasher.combine(ObjectIdentifier(self.client))
            hasher.combine(self.route.generation)
            hasher.combine(self.socketGeneration)
            hasher.combine(self.endpointRevision)
        }
    }

    struct PushDelivery: Sendable {
        enum Event: Sendable {
            case push(GatewayPush)
            /// Retirement is also an exact-source cleanup receipt. It grants no
            /// action or current-status authority when isCurrent is false.
            case disconnected(String?)
        }

        let event: Event
        let serverLease: ServerLease
        let mainSessionKey: String?
        fileprivate let currentOwner: @Sendable () -> Bool

        var isCurrent: Bool {
            self.currentOwner()
        }

        var push: GatewayPush? {
            guard case let .push(push) = self.event else { return nil }
            return push
        }
    }

    private struct AdmittedConnection: Sendable {
        let lease: ServerLease
        let mainSessionKey: String?
    }

    private enum ConnectionPublication: Sendable {
        case connected(AdmittedConnection)
        case disconnected(ServerLease)
    }

    enum Method: String {
        case agent
        case status
        case setHeartbeats = "set-heartbeats"
        case systemEvent = "system-event"
        case health
        case channelsStatus = "channels.status"
        case configGet = "config.get"
        case configSet = "config.set"
        case configPatch = "config.patch"
        case configSchema = "config.schema"
        case configSchemaLookup = "config.schema.lookup"
        case wizardStart = "wizard.start"
        case wizardNext = "wizard.next"
        case wizardCancel = "wizard.cancel"
        case wizardStatus = "wizard.status"
        case talkConfig = "talk.config"
        case talkMode = "talk.mode"
        case talkSpeak = "talk.speak"
        case webLoginStart = "web.login.start"
        case webLoginWait = "web.login.wait"
        case channelsLogout = "channels.logout"
        case modelsList = "models.list"
        case agentsList = "agents.list"
        case agentIdentityGet = "agent.identity.get"
        case chatHistory = "chat.history"
        case sessionsPreview = "sessions.preview"
        case chatSend = "chat.send"
        case skillsStatus = "skills.status"
        case skillsSearch = "skills.search"
        case skillsDetail = "skills.detail"
        case skillsInstall = "skills.install"
        case skillsUpdate = "skills.update"
        case voicewakeGet = "voicewake.get"
        case voicewakeSet = "voicewake.set"
        case nodePairApprove = "node.pair.approve"
        case nodePairReject = "node.pair.reject"
        case devicePairList = "device.pair.list"
        case devicePairApprove = "device.pair.approve"
        case devicePairReject = "device.pair.reject"
        case execApprovalList = "exec.approval.list"
        case execApprovalResolve = "exec.approval.resolve"
        case approvalResolve = "approval.resolve"
        case cronList = "cron.list"
        case cronRuns = "cron.runs"
        case cronRun = "cron.run"
        case cronRemove = "cron.remove"
        case cronUpdate = "cron.update"
        case cronAdd = "cron.add"
        case cronStatus = "cron.status"
    }

    private let endpointProvider: EndpointProvider
    private nonisolated let currentEndpointRevision: (@Sendable () -> UInt64)?
    private let supportsSharedEndpointRecovery: Bool
    private let activationBindingKeyProvider: @Sendable () -> SymmetricKey?
    private let includeDeviceIdentity: Bool
    private let sessionProvider: SessionProvider
    private let clientShutdown: @Sendable (GatewayChannelActor) async -> Void
    private let decoder = JSONDecoder()

    private struct ConfiguredConnection {
        let client: GatewayChannelActor
        var endpoint: EndpointSnapshot
        let tlsMetadataProvider: (any GatewayTLSRouteMetadataProviding)?
        let shutdownGeneration: UInt64
        let activationBindingKey: SymmetricKey?

        func matches(endpoint: EndpointSnapshot, shutdownGeneration: UInt64? = nil) -> Bool {
            self.endpoint.config.url == endpoint.config.url &&
                self.endpoint.config.token == endpoint.config.token &&
                self.endpoint.config.password == endpoint.config.password &&
                GatewayTLSRoute.hasSameConnectionIdentity(self.endpoint.tls, endpoint.tls) &&
                self.endpoint.deviceAuthGatewayID == endpoint.deviceAuthGatewayID &&
                self.endpoint.routeAuthority == endpoint.routeAuthority &&
                shutdownGeneration.map { self.shutdownGeneration == $0 } ?? true
        }

        func matches(route: Route) -> Bool {
            route.matches(self.endpoint)
        }
    }

    private nonisolated let connectionPublication = LockIsolated<ConnectionPublication?>(nil)
    private var configuredConnection: ConfiguredConnection? {
        didSet { self.publishConnectedServerLease() }
    }

    private var highestEndpointRevision: UInt64?
    private var routeGeneration: UInt64 = 0
    /// Unbound operations capture this before their first suspension. Shutdown
    /// advances it so delayed config and retry work cannot recreate a route.
    private var shutdownGeneration: UInt64 = 0
    // Callback work keeps the physical socket epoch that decoded it. Retiring
    // that epoch prevents delayed pushes from entering a replacement socket.
    var activeSocketGeneration: UInt64?
    private var lastRetiredSocketGeneration: UInt64?

    private var subscribers: [UUID: AsyncStream<PushDelivery>.Continuation] = [:]
    var realtimeTalkSubscribers: [
        UInt64: [UUID: AsyncStream<PushDelivery>.Continuation]
    ] = [:]
    var lastSnapshot: HelloOk? {
        didSet { self.publishConnectedServerLease() }
    }

    nonisolated var connectedEndpointRevision: UInt64? {
        guard case let .connected(connection) = self.connectionPublication.value else { return nil }
        return connection.lease.endpointRevision
    }

    private func publishConnectedServerLease() {
        // Retirement clears authority before changing any other actor state.
        // Only a fully admitted handshake may replace that terminal publication.
        guard self.lastSnapshot != nil, let connection = self.configuredConnection,
              let socketGeneration = self.activeSocketGeneration
        else { return }
        let endpoint = connection.endpoint
        let lease = ServerLease(
            route: Route(
                generation: self.routeGeneration,
                authority: endpoint.routeAuthority,
                url: endpoint.config.url,
                token: endpoint.config.token,
                password: endpoint.config.password,
                tls: endpoint.tls,
                deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
                activationOwnershipFingerprint: Self.activationOwnershipFingerprint(
                    config: endpoint.config, key: connection.activationBindingKey)),
            socketGeneration: socketGeneration,
            endpointRevision: endpoint.revision,
            client: connection.client)
        let admitted = AdmittedConnection(lease: lease, mainSessionKey: self.cachedMainSessionKey())
        self.connectionPublication.withValue { $0 = .connected(admitted) }
    }

    var canvasPluginSurfaceURL: String?

    struct CanvasPluginSurfaceRefresh {
        let id: UUID
        let task: Task<GatewayCanvasHostRoute?, Never>
    }

    var canvasPluginSurfaceRefresh: CanvasPluginSurfaceRefresh?

    init(
        endpointProvider: @escaping EndpointProvider = GatewayConnection.defaultEndpointProvider,
        currentEndpointRevision: (@Sendable () -> UInt64)? = nil,
        supportsSharedEndpointRecovery: Bool = true,
        activationBindingKeyProvider: @escaping @Sendable () -> SymmetricKey? =
            GatewayConnection.defaultActivationBindingKey,
        sessionBox: WebSocketSessionBox? = nil,
        sessionProvider: SessionProvider? = nil,
        clientShutdown: @escaping @Sendable (GatewayChannelActor) async -> Void = { client in
            await client.shutdown()
        })
    {
        self.endpointProvider = endpointProvider
        self.currentEndpointRevision = currentEndpointRevision
        self.supportsSharedEndpointRecovery = supportsSharedEndpointRecovery
        self.activationBindingKeyProvider = activationBindingKeyProvider
        self.includeDeviceIdentity = true
        self.sessionProvider = Self.resolveSessionProvider(
            sessionBox: sessionBox,
            sessionProvider: sessionProvider)
        self.clientShutdown = clientShutdown
    }

    #if DEBUG
    private static let testingActivationBindingKey = SymmetricKey(size: .bits256)

    init(
        configProvider: @escaping @Sendable () async throws -> Config,
        activationBindingKeyProvider: @escaping @Sendable () -> SymmetricKey? = {
            GatewayConnection.testingActivationBindingKey
        },
        sessionBox: WebSocketSessionBox? = nil,
        sessionProvider: SessionProvider? = nil,
        clientShutdown: @escaping @Sendable (GatewayChannelActor) async -> Void = { client in
            await client.shutdown()
        })
    {
        self.endpointProvider = {
            try await EndpointSnapshot(config: configProvider(), routeAuthority: nil)
        }
        self.currentEndpointRevision = nil
        self.supportsSharedEndpointRecovery = false
        self.activationBindingKeyProvider = activationBindingKeyProvider
        // Mock WebSocket routes do not exercise device authentication and must not
        // depend on the process-global persisted identity store.
        self.includeDeviceIdentity = false
        self.sessionProvider = Self.resolveSessionProvider(
            sessionBox: sessionBox,
            sessionProvider: sessionProvider)
        self.clientShutdown = clientShutdown
    }

    init(
        testEndpointProvider: @escaping EndpointProvider,
        currentEndpointRevision: (@Sendable () -> UInt64)? = nil,
        sessionBox: WebSocketSessionBox? = nil)
    {
        self.endpointProvider = testEndpointProvider
        self.currentEndpointRevision = currentEndpointRevision
        self.supportsSharedEndpointRecovery = false
        self.activationBindingKeyProvider = { GatewayConnection.testingActivationBindingKey }
        // Mock WebSocket routes do not exercise device authentication and must not
        // depend on the process-global persisted identity store.
        self.includeDeviceIdentity = false
        self.sessionProvider = Self.resolveSessionProvider(
            sessionBox: sessionBox,
            sessionProvider: nil)
        self.clientShutdown = { client in await client.shutdown() }
    }
    #endif

    private static func resolveSessionProvider(
        sessionBox: WebSocketSessionBox?,
        sessionProvider: SessionProvider?) -> SessionProvider
    {
        if let sessionProvider {
            return sessionProvider
        }
        if let sessionBox {
            return { _ in sessionBox }
        }
        return { route in
            route.map { WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0.params)) }
        }
    }

    // MARK: - Low-level request

    func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double? = nil,
        retryTransportFailures: Bool = true) async throws -> Data
    {
        try await self.request(
            method: method,
            params: params,
            timeoutMs: timeoutMs,
            retryTransportFailures: retryTransportFailures,
            allowTLSRepair: true)
    }

    private func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double?,
        retryTransportFailures: Bool,
        allowTLSRepair: Bool) async throws -> Data
    {
        let shutdownGeneration = shutdownGeneration
        let endpoint = try await currentEndpoint()
        let cfg = endpoint.config
        let client = try await configure(
            endpoint: endpoint,
            shutdownGeneration: shutdownGeneration)

        do {
            return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
        } catch {
            try Task.checkCancellation()
            if GatewayCompatibilityIssue(error: error) != nil { throw error }
            if allowTLSRepair,
               let tlsError = error as? GatewayTLSValidationError,
               await GatewayTLSRepairCoordinator.shared.repair(
                   route: endpoint.tls,
                   url: cfg.url,
                   failure: tlsError.failure)
            {
                return try await self.request(
                    method: method,
                    params: params,
                    timeoutMs: timeoutMs,
                    retryTransportFailures: retryTransportFailures,
                    allowTLSRepair: false)
            }
            if !retryTransportFailures || error is GatewayResponseError || error is GatewayDecodingError {
                throw error
            }
            try requireCurrentShutdownGeneration(shutdownGeneration)
            // Profile-bound windows own a fixed endpoint. Shared recovery reads global
            // connection-mode state and may legitimately retarget only the primary app route.
            guard self.supportsSharedEndpointRecovery else { throw error }

            // Auto-recover in local mode by spawning/attaching a gateway and retrying a few times.
            // Canvas interactions should "just work" even if the local gateway isn't running yet.
            let mode = await MainActor.run { AppStateStore.shared.connectionMode }
            try requireCurrentShutdownGeneration(shutdownGeneration)
            switch mode {
            case .local:
                await MainActor.run { GatewayProcessManager.shared.setActive(true) }
                try requireCurrentShutdownGeneration(shutdownGeneration)

                let lastError: Error
                do {
                    return try await self.retryRequest(
                        after: error,
                        shutdownGeneration: shutdownGeneration)
                    {
                        try await client.request(method: method, params: params, timeoutMs: timeoutMs)
                    }
                } catch {
                    lastError = error
                }

                let nsError = lastError as NSError
                if nsError.domain == URLError.errorDomain,
                   let fallback = await GatewayEndpointStore.shared.maybeFallbackToTailnet(from: cfg.url)
                {
                    try acceptEndpointRevision(fallback)
                    let fallbackClient = try await configure(
                        endpoint: fallback,
                        shutdownGeneration: shutdownGeneration)
                    return try await self.retryRequest(
                        after: lastError,
                        shutdownGeneration: shutdownGeneration)
                    {
                        try await fallbackClient.request(method: method, params: params, timeoutMs: timeoutMs)
                    }
                }

                throw lastError
            case .remote:
                let nsError = error as NSError
                guard nsError.domain == URLError.errorDomain else { throw error }

                var lastError: Error = error
                await RemoteTunnelManager.shared.stopAll()
                try requireCurrentShutdownGeneration(shutdownGeneration)
                do {
                    _ = try await GatewayEndpointStore.shared.ensureRemoteControlTunnel()
                    try requireCurrentShutdownGeneration(shutdownGeneration)
                } catch {
                    try requireCurrentShutdownGeneration(shutdownGeneration)
                    lastError = error
                }

                return try await self.retryRequest(
                    after: lastError,
                    shutdownGeneration: shutdownGeneration)
                {
                    let endpoint = try await self.currentEndpoint()
                    let client = try await self.configure(
                        endpoint: endpoint,
                        shutdownGeneration: shutdownGeneration)
                    return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
                }
            case .unconfigured:
                throw error
            }
        }
    }

    private func retryRequest(
        after initialError: Error,
        shutdownGeneration: UInt64,
        operation: @Sendable () async throws -> Data) async throws -> Data
    {
        var lastError = initialError
        for delayMs in [150, 400, 900] {
            try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            try requireCurrentShutdownGeneration(shutdownGeneration)
            do {
                return try await operation()
            } catch {
                try requireCurrentShutdownGeneration(shutdownGeneration)
                // Preserve the authoritative rejection before a later retry can
                // replace update guidance with an unrelated transport failure.
                if GatewayCompatibilityIssue(error: error) != nil { throw error }
                lastError = error
            }
        }
        throw lastError
    }

    /// Route-bound requests never reconfigure or retry on another endpoint.
    /// Durable outbox rows must remain owned by the gateway that created them.
    func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double? = nil,
        ifCurrentRoute route: Route,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> Data
    {
        let endpoint = try await currentEndpoint()
        guard self.routeMatchesCurrentState(route, endpoint: endpoint),
              let client = self.configuredConnection?.client
        else {
            if distinguishPreDispatchRouteChange {
                throw OpenClawChatTransportSendError.notDispatched
            }
            throw CancellationError()
        }
        let data = try await client.request(method: method, params: params, timeoutMs: timeoutMs)
        guard await self.isCurrentRoute(route), self.configuredConnection?.client === client else {
            throw CancellationError()
        }
        return data
    }

    /// Server-bound requests never reconfigure, reconnect, or cross onto a
    /// replacement socket at the same endpoint.
    func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double? = nil,
        ifCurrentServerLease lease: ServerLease) async throws -> Data
    {
        guard await isCurrentServerLease(lease) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        // Untagged channel cancellation can follow a send. Only the guard above
        // proves this wrapper rejected the request before dispatch.
        let data = try await lease.client.request(
            method: method,
            params: params,
            timeoutMs: timeoutMs,
            ifCurrentConnectionGeneration: lease.socketGeneration)
        guard await self.isCurrentServerLease(lease) else {
            throw CancellationError()
        }
        return data
    }
}

extension GatewayConnection {
    enum WizardCancellationOutcome: Equatable {
        case cancelled
        case absent
        case unresolved
    }

    /// Cancel on the socket that created the wizard, or a replacement socket on
    /// the same route. Absence stays distinct so callers can reconcile a commit.
    @discardableResult
    func cancelWizardSession(
        _ sessionID: String,
        on lease: ServerLease) async -> WizardCancellationOutcome
    {
        let initial = await sendWizardCancellation(sessionID, on: lease)
        if initial != .unresolved {
            return initial
        }
        guard let replacement = try? await acquireServerLease(
            ifSameRouteAs: lease,
            timeoutMs: 5000)
        else { return .unresolved }
        return await self.sendWizardCancellation(sessionID, on: replacement)
    }

    private func sendWizardCancellation(
        _ sessionID: String,
        on lease: ServerLease) async -> WizardCancellationOutcome
    {
        do {
            let data = try await lease.client.request(
                method: "wizard.cancel",
                params: ["sessionId": AnyCodable(sessionID)],
                timeoutMs: 10000,
                ifCurrentConnectionGeneration: lease.socketGeneration)
            let status = try decoder.decode(WizardCancellationStatus.self, from: data)
            return switch status.status {
            case "cancelled": .cancelled
            case "running": .unresolved
            default: .absent
            }
        } catch {
            return Self.wizardCancellationOutcome(after: error)
        }
    }

    static func wizardCancellationOutcome(after error: Error) -> WizardCancellationOutcome {
        guard let response = error as? GatewayResponseError else { return .unresolved }
        let sessionIsAbsent = response.method == "wizard.cancel" &&
            response.code == "INVALID_REQUEST" &&
            response.message == "wizard not found"
        return sessionIsAbsent ? .absent : .unresolved
    }

    private struct WizardCancellationStatus: Decodable {
        let status: String
    }

    func requestRaw(
        method: Method,
        params: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil) async throws -> Data
    {
        try await self.request(method: method.rawValue, params: params, timeoutMs: timeoutMs)
    }

    func request(
        _ request: OpenClawChatGatewayRequest,
        retryTransportFailures: Bool = true) async throws -> Data
    {
        try await self.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            retryTransportFailures: retryTransportFailures)
    }

    func request(
        _ request: OpenClawChatGatewayRequest,
        ifCurrentRoute route: Route,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> Data
    {
        try await self.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: distinguishPreDispatchRouteChange)
    }

    func requestRaw(
        method: String,
        params: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil) async throws -> Data
    {
        try await self.request(method: method, params: params, timeoutMs: timeoutMs)
    }

    func requestDecoded<T: Decodable>(
        method: Method,
        params: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil) async throws -> T
    {
        let data = try await requestRaw(method: method, params: params, timeoutMs: timeoutMs)
        do {
            return try self.decoder.decode(T.self, from: data)
        } catch {
            throw GatewayDecodingError(method: method.rawValue, message: error.localizedDescription)
        }
    }

    func requestDecoded<T: Decodable>(
        method: Method,
        params: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil,
        ifCurrentRoute route: Route) async throws -> T
    {
        let data = try await self.request(
            method: method.rawValue,
            params: params,
            timeoutMs: timeoutMs,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
        guard await self.isCurrentRoute(route) else {
            throw GatewayRouteChangedAfterDispatchError(method: method.rawValue)
        }
        do {
            return try self.decoder.decode(T.self, from: data)
        } catch {
            throw GatewayDecodingError(method: method.rawValue, message: error.localizedDescription)
        }
    }

    func requestVoid(
        method: Method,
        params: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil) async throws
    {
        _ = try await self.requestRaw(method: method, params: params, timeoutMs: timeoutMs)
    }

    /// Ensure the underlying socket is configured (and replaced if config changed).
    func refresh() async throws {
        let shutdownGeneration = shutdownGeneration
        let endpoint = try await currentEndpoint()
        _ = try await self.configure(
            endpoint: endpoint,
            shutdownGeneration: shutdownGeneration)
    }

    func captureRoute() async -> Route? {
        try? await self.captureRequiredRoute()
    }

    func captureRequiredRoute() async throws -> Route {
        let shutdownGeneration = shutdownGeneration
        let endpoint = try await currentEndpoint()
        let cfg = endpoint.config
        _ = try await self.configure(
            endpoint: endpoint,
            shutdownGeneration: shutdownGeneration)
        return Route(
            generation: self.routeGeneration,
            authority: endpoint.routeAuthority,
            url: cfg.url,
            token: cfg.token,
            password: cfg.password,
            tls: endpoint.tls,
            deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
            activationOwnershipFingerprint: Self.activationOwnershipFingerprint(
                config: cfg,
                key: self.configuredConnection?.activationBindingKey))
    }

    /// Connect and bind subsequent work to the hello snapshot's physical
    /// socket. The read-only health preflight intentionally uses the ordinary
    /// recovery path so a fresh local Gateway can start and a remote tunnel can
    /// recover before onboarding freezes the successful physical connection.
    func acquireServerLease() async throws -> ServerLease {
        try await self.acquireServerLease(timeoutMs: 15000, retryTransportFailures: true)
    }

    /// Captures the currently connected physical socket without probing or
    /// reconnecting. Queued mutations use this so waiting cannot retarget them.
    func captureServerLease() async -> ServerLease? {
        guard let route = await self.captureRoute(),
              let client = self.configuredConnection?.client,
              let socketGeneration = self.activeSocketGeneration
        else { return nil }
        let lease = ServerLease(
            route: route,
            socketGeneration: socketGeneration,
            endpointRevision: self.configuredConnection?.endpoint.revision,
            client: client)
        guard await self.isCurrentServerLease(lease) else { return nil }
        return lease
    }

    private func acquireServerLease(
        timeoutMs: Double,
        retryTransportFailures: Bool) async throws -> ServerLease
    {
        let shutdownGeneration = self.shutdownGeneration
        _ = try await self.request(
            method: Method.health.rawValue,
            params: nil,
            timeoutMs: timeoutMs,
            retryTransportFailures: retryTransportFailures)
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        let endpoint = try await currentEndpoint()
        let cfg = endpoint.config
        guard let client = configuredClient(
            endpoint: endpoint,
            shutdownGeneration: shutdownGeneration)
        else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard let socketGeneration = await client.currentConnectionGeneration() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard let authBinding = await client.authBinding(
            ifCurrentConnectionGeneration: socketGeneration)
        else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let lease = ServerLease(
            route: Route(
                generation: routeGeneration,
                authority: endpoint.routeAuthority,
                url: cfg.url,
                token: cfg.token,
                password: cfg.password,
                tls: endpoint.tls,
                deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
                activationOwnershipFingerprint: Self.activationOwnershipFingerprint(
                    config: cfg,
                    authBinding: authBinding,
                    key: self.configuredConnection?.activationBindingKey)),
            socketGeneration: socketGeneration,
            endpointRevision: endpoint.revision,
            client: client)
        guard await self.isCurrentServerLease(lease) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        return lease
    }

    /// Reconnect one physical socket without crossing the route that owned the
    /// original request. Endpoint or credential changes must start fresh work.
    func acquireServerLease(
        ifSameRouteAs previous: ServerLease,
        timeoutMs: Double) async throws -> ServerLease
    {
        guard await self.isCurrentRoute(previous.route) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        // Restart reconciliation owns its overall deadline. One short, non-retrying
        // health request keeps a failed attempt from consuming the whole budget.
        let replacement = try await acquireServerLease(
            timeoutMs: timeoutMs,
            retryTransportFailures: false)
        guard replacement.route.generation == previous.route.generation,
              replacement.route.url == previous.route.url,
              replacement.route.token == previous.route.token,
              replacement.route.password == previous.route.password,
              GatewayTLSRoute.hasSameConnectionIdentity(replacement.route.tls, previous.route.tls),
              replacement.route.deviceAuthGatewayID == previous.route.deviceAuthGatewayID
        else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        return replacement
    }

    func isCurrentRoute(_ route: Route) async -> Bool {
        guard let endpoint = try? await currentEndpoint() else { return false }
        return self.routeMatchesCurrentState(route, endpoint: endpoint)
    }

    func supportsServerCapability(
        _ capability: GatewayServerCapability,
        ifCurrentRoute route: Route) async -> Bool?
    {
        guard let endpoint = try? await currentEndpoint() else { return nil }
        guard self.routeMatchesCurrentState(route, endpoint: endpoint),
              let snapshot = lastSnapshot
        else { return nil }
        return snapshot.supportsServerCapability(capability)
    }

    func supportsServerCapability(
        _ capability: GatewayServerCapability,
        ifCurrentServerLease lease: ServerLease) async -> Bool?
    {
        guard await self.isCurrentServerLease(lease),
              self.serverLeaseMatchesCurrentState(lease),
              let snapshot = lastSnapshot
        else { return nil }
        return snapshot.supportsServerCapability(capability)
    }

    func supportsServerMethod(
        _ method: String,
        ifCurrentServerLease lease: ServerLease) async -> Bool?
    {
        guard await self.isCurrentServerLease(lease),
              self.serverLeaseMatchesCurrentState(lease),
              let snapshot = lastSnapshot
        else { return nil }
        return snapshot.advertisedServerMethods()?.contains(method)
    }

    func isCurrentServerLease(_ lease: ServerLease) async -> Bool {
        guard let endpoint = try? await currentEndpoint(),
              serverLeaseMatchesCurrentState(lease),
              lease.route.matches(endpoint),
              await lease.client.currentConnectionGeneration() == lease.socketGeneration,
              serverLeaseMatchesCurrentState(lease)
        else { return false }
        return true
    }

    func activationOwnershipFingerprint(
        ifCurrentServerLease lease: ServerLease) async -> String?
    {
        guard await self.isCurrentServerLease(lease) else { return nil }
        return lease.route.activationOwnershipFingerprint
    }

    nonisolated func serverLeaseMatchesCurrentState(_ lease: ServerLease) -> Bool {
        self.publicationIsCurrent(lease, connected: true)
    }

    private nonisolated func publicationIsCurrent(_ lease: ServerLease, connected: Bool) -> Bool {
        let current: ServerLease? = switch (self.connectionPublication.value, connected) {
        case let (.connected(connection), true): connection.lease
        case let (.disconnected(lease), false): lease
        default: nil
        }
        guard current == lease else { return false }
        return self.currentEndpointRevision.map { $0() == lease.endpointRevision } ?? true
    }

    private func routeMatchesCurrentState(_ route: Route, endpoint: EndpointSnapshot) -> Bool {
        route.matches(endpoint) && self.routeMatchesConfiguredConnection(route)
    }

    private func routeMatchesConfiguredConnection(_ route: Route) -> Bool {
        route.generation == self.routeGeneration &&
            self.configuredConnection?.matches(route: route) == true
    }

    func sessionRoutingIdentity(
        ifCurrentRoute route: Route) async throws -> OpenClawChatSessionRoutingIdentity
    {
        let data = try await request(
            OpenClawChatGatewayRequests.agentsList(),
            ifCurrentRoute: route)
        return try OpenClawChatGatewayPayloadCodec.decodeSessionRoutingIdentity(data)
    }

    func configuredGatewayURL() -> URL? {
        self.configuredConnection?.endpoint.config.url
    }

    func configuredTLSFingerprintSHA256() -> String? {
        self.configuredConnection?.tlsMetadataProvider?.effectiveTLSFingerprintSHA256
    }

    func authSource() async -> GatewayAuthSource? {
        guard let connection = self.configuredConnection else { return nil }
        return await connection.client.authSource()
    }

    func shutdown() async {
        let client = self.retireConfiguredConnection(disconnection: .disconnected(nil))
        self.shutdownGeneration &+= 1
        if let client {
            await self.clientShutdown(client)
        }
    }

    private func configure(
        endpoint: EndpointSnapshot,
        shutdownGeneration: UInt64) async throws -> GatewayChannelActor
    {
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        let config = endpoint.config
        if let client = configuredClient(
            endpoint: endpoint,
            shutdownGeneration: shutdownGeneration)
        {
            return client
        }
        let previousClient = self.retireConfiguredConnection()
        let configuredRouteGeneration = self.routeGeneration
        if let previousClient {
            await self.clientShutdown(previousClient)
        }
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        if self.routeGeneration != configuredRouteGeneration {
            if let client = configuredClient(
                endpoint: endpoint,
                shutdownGeneration: shutdownGeneration)
            {
                return client
            }
            throw CancellationError()
        }
        let activationBindingKey = self.activationBindingKeyProvider()
        let sessionBox = self.sessionProvider(endpoint.tls)
        let client = GatewayChannelActor(
            url: config.url,
            token: config.token,
            password: config.password,
            authBindingKey: activationBindingKey,
            session: sessionBox,
            connectSnapshotAdmissionHandler: { [weak self] snapshot, socketGeneration in
                await self?.admitConnectSnapshot(
                    snapshot,
                    routeGeneration: configuredRouteGeneration,
                    socketGeneration: socketGeneration)
            },
            pushHandler: { [weak self] push, socketGeneration in
                await self?.handle(
                    push: push,
                    routeGeneration: configuredRouteGeneration,
                    socketGeneration: socketGeneration)
            },
            connectOptions: GatewayConnectOptions(
                role: "operator",
                scopes: GatewayChannelActor.defaultOperatorConnectScopes,
                caps: Self.operatorClientCaps,
                commands: [],
                permissions: [:],
                clientId: "openclaw-macos",
                clientMode: "ui",
                clientDisplayName: InstanceIdentity.displayName,
                includeDeviceIdentity: self.includeDeviceIdentity,
                allowStoredDeviceAuth: endpoint.deviceAuthGatewayID != nil,
                deviceAuthGatewayID: endpoint.deviceAuthGatewayID),
            disconnectHandler: { [weak self] reason, socketGeneration in
                await self?.handleDisconnect(
                    routeGeneration: configuredRouteGeneration,
                    socketGeneration: socketGeneration,
                    reason: reason)
            })
        self.configuredConnection = ConfiguredConnection(
            client: client,
            endpoint: endpoint,
            tlsMetadataProvider: sessionBox?.session as? GatewayTLSRouteMetadataProviding,
            shutdownGeneration: shutdownGeneration,
            activationBindingKey: activationBindingKey)
        return client
    }

    private func configuredClient(
        endpoint: EndpointSnapshot,
        shutdownGeneration: UInt64) -> GatewayChannelActor?
    {
        guard let connection = self.configuredConnection,
              connection.matches(
                  endpoint: endpoint,
                  shutdownGeneration: shutdownGeneration)
        else { return nil }
        // Equivalent routes can acquire a new endpoint revision without reconnecting.
        // An older waiter must not roll the recorded connection owner backward.
        if endpoint.revision == self.highestEndpointRevision {
            self.configuredConnection?.endpoint = endpoint
        }
        return connection.client
    }

    /// Invalidate every route-owned fact before shutdown can suspend; otherwise
    /// reentrant work could continue on a client whose replacement is in flight.
    private func retireConfiguredConnection(disconnection: PushDelivery.Event? = nil) -> GatewayChannelActor? {
        self.retirePublication(disconnection: disconnection)
        self.routeGeneration &+= 1
        self.finishRealtimeTalkSubscribers()
        self.resetSocketGeneration()
        self.lastSnapshot = nil
        self.resetCanvasPluginSurfaceState()
        let client = self.configuredConnection?.client
        self.configuredConnection = nil
        return client
    }

    private func requireCurrentShutdownGeneration(_ shutdownGeneration: UInt64) throws {
        guard self.shutdownGeneration == shutdownGeneration else {
            throw CancellationError()
        }
    }

    private func handle(
        push: GatewayPush,
        routeGeneration: UInt64,
        socketGeneration: UInt64)
    {
        guard routeGeneration == self.routeGeneration,
              admitSocketGeneration(socketGeneration)
        else { return }
        broadcast(push)
    }

    /// Short connect-path admission only. Subscriber delivery stays on the
    /// ordinary push task so connect never waits on downstream UI work.
    private func admitConnectSnapshot(
        _ snapshot: HelloOk,
        routeGeneration: UInt64,
        socketGeneration: UInt64)
    {
        guard routeGeneration == self.routeGeneration,
              admitSocketGeneration(socketGeneration)
        else { return }
        self.lastSnapshot = snapshot
        self.installCanvasPluginSurfaceURL(from: snapshot)
    }

    private func handleDisconnect(
        routeGeneration: UInt64,
        socketGeneration: UInt64,
        reason: String = "gateway disconnected")
    {
        guard routeGeneration == self.routeGeneration,
              retireSocketGeneration(socketGeneration, reason: reason)
        else { return }
        self.finishRealtimeTalkSubscribers(socketGeneration: socketGeneration)
        self.lastSnapshot = nil
        self.resetCanvasPluginSurfaceState()
    }
}

extension GatewayConnection {
    private func admitSocketGeneration(_ socketGeneration: UInt64) -> Bool {
        if let lastRetiredSocketGeneration,
           socketGeneration <= lastRetiredSocketGeneration
        {
            return false
        }
        if let activeSocketGeneration {
            return socketGeneration == activeSocketGeneration
        }
        activeSocketGeneration = socketGeneration
        return true
    }

    private func retireSocketGeneration(_ socketGeneration: UInt64, reason: String) -> Bool {
        if let lastRetiredSocketGeneration,
           socketGeneration <= lastRetiredSocketGeneration
        {
            return false
        }
        if let activeSocketGeneration,
           socketGeneration != activeSocketGeneration
        {
            return false
        }
        self.retirePublication(disconnection: .disconnected(reason))
        activeSocketGeneration = nil
        lastRetiredSocketGeneration = socketGeneration
        return true
    }

    private func resetSocketGeneration() {
        self.activeSocketGeneration = nil
        self.lastRetiredSocketGeneration = nil
    }

    #if DEBUG
    func _test_routeGeneration() -> UInt64 {
        self.routeGeneration
    }

    func _test_configuredURL() -> URL? {
        self.configuredConnection?.endpoint.config.url
    }

    func _test_handlePush(
        _ push: GatewayPush,
        routeGeneration: UInt64? = nil,
        socketGeneration: UInt64)
    {
        self.handle(
            push: push,
            routeGeneration: routeGeneration ?? self.routeGeneration,
            socketGeneration: socketGeneration)
    }

    func _test_handleDisconnect(
        routeGeneration: UInt64? = nil,
        socketGeneration: UInt64)
    {
        self.handleDisconnect(
            routeGeneration: routeGeneration ?? self.routeGeneration,
            socketGeneration: socketGeneration)
    }
    #endif

    private static func defaultEndpointProvider() async throws -> EndpointSnapshot {
        try await GatewayEndpointStore.shared.requireEndpoint()
    }

    private func currentEndpoint() async throws -> EndpointSnapshot {
        let endpoint = try await endpointProvider()
        try acceptEndpointRevision(endpoint)
        return endpoint
    }

    private func acceptEndpointRevision(_ endpoint: EndpointSnapshot) throws {
        guard let revision = endpoint.revision else { return }
        if let highestEndpointRevision, revision < highestEndpointRevision {
            throw CancellationError()
        }
        if highestEndpointRevision.map({ revision > $0 }) ?? true {
            highestEndpointRevision = revision
        }
    }

    static func defaultActivationBindingKey() -> SymmetricKey? {
        self.activationBindingKey(
            launchPolicy: .current,
            loadOrCreate: GatewayActivationBindingKeyStore.loadOrCreate)
    }

    static func activationBindingKey(
        launchPolicy: AppLaunchRuntimePlan,
        loadOrCreate: () -> SymmetricKey?) -> SymmetricKey?
    {
        guard launchPolicy.allowsGatewayUIKeychainAccess else { return nil }
        return loadOrCreate()
    }

    private static func activationOwnershipFingerprint(
        config: Config,
        authBinding: GatewayAuthBinding? = nil,
        key: SymmetricKey?) -> String?
    {
        guard let key else { return nil }
        // The durable record is already keyed by the stable Gateway route identity.
        // Bind only auth here so an SSH tunnel's ephemeral local URL can rebind safely.
        var values = [config.token ?? "", config.password ?? ""]
        if authBinding?.source == .deviceToken {
            guard let credentialFingerprint = authBinding?.credentialFingerprint else { return nil }
            values.append(contentsOf: [GatewayAuthSource.deviceToken.rawValue, credentialFingerprint])
        }
        let framed = values.map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
        let tag = HMAC<SHA256>.authenticationCode(for: Data(framed.utf8), using: key)
        return tag.map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Snapshot cache and subscriptions

extension GatewayConnection {
    func controlUiAutoAuthToken(config: Config) async -> String? {
        guard let endpoint = try? await currentEndpoint(),
              endpoint.config.url == config.url,
              endpoint.config.token == config.token,
              endpoint.config.password == config.password,
              let client = self.configuredConnection?.client,
              let socketGeneration = activeSocketGeneration,
              controlUiRouteIsLive(
                  endpoint: endpoint,
                  client: client,
                  socketGeneration: socketGeneration),
              await client.currentConnectionGeneration() == socketGeneration,
              controlUiRouteIsLive(
                  endpoint: endpoint,
                  client: client,
                  socketGeneration: socketGeneration),
              let authBinding = await client.authBinding(
                  ifCurrentConnectionGeneration: socketGeneration),
              controlUiRouteIsLive(
                  endpoint: endpoint,
                  client: client,
                  socketGeneration: socketGeneration)
        else { return nil }

        switch authBinding.source {
        case .sharedToken:
            return config.token?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        case .deviceToken:
            guard let gatewayID = configuredConnection?.endpoint.deviceAuthGatewayID?
                .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            else { return nil }
            if let deviceToken = lastSnapshot?.auth["deviceToken"]?.value as? String,
               let token = deviceToken.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            {
                return token
            }
            guard let identity = DeviceIdentityStore.loadOrCreatePersisted() else { return nil }
            return DeviceAuthStore.loadToken(
                deviceId: identity.deviceId,
                role: "operator",
                gatewayID: gatewayID)?.token
                .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        case .bootstrapToken, .password, .none:
            return nil
        }
    }

    private func controlUiRouteIsLive(
        endpoint: EndpointSnapshot,
        client: GatewayChannelActor,
        socketGeneration: UInt64) -> Bool
    {
        self.configuredConnection?.matches(
            endpoint: endpoint,
            shutdownGeneration: self.shutdownGeneration) == true &&
            self.configuredConnection?.client === client &&
            self.activeSocketGeneration == socketGeneration &&
            self.lastSnapshot != nil
    }

    private func sessionDefaultString(_ defaults: [String: OpenClawProtocol.AnyCodable]?, key: String) -> String {
        let raw = defaults?[key]?.value as? String
        return (raw ?? "").trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
    }

    func cachedMainSessionKey() -> String? {
        guard let snapshot = lastSnapshot else { return nil }
        let trimmed = self.sessionDefaultString(snapshot.snapshot.sessiondefaults, key: "mainSessionKey")
        return trimmed.isEmpty ? nil : trimmed
    }

    func cachedGatewayVersion() -> String? {
        guard let snapshot = lastSnapshot else { return nil }
        let raw = snapshot.server["version"]?.value as? String
        let trimmed = raw?.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    func cachedGatewayVersion(ifCurrentServerLease lease: ServerLease) async -> String? {
        guard await self.isCurrentServerLease(lease) else { return nil }
        return self.cachedGatewayVersion()
    }

    func snapshotPaths() -> (configPath: String?, stateDir: String?) {
        guard let snapshot = lastSnapshot else { return (nil, nil) }
        let configPath = snapshot.snapshot.configpath?.trimmingCharacters(in: .whitespacesAndNewlines)
        let stateDir = snapshot.snapshot.statedir?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (
            configPath?.isEmpty == false ? configPath : nil,
            stateDir?.isEmpty == false ? stateDir : nil)
    }

    func subscribe(bufferingNewest: Int = 100) -> AsyncStream<PushDelivery> {
        let id = UUID()
        let snapshot = self.lastSnapshot
        let connection = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
            if let snapshot, let delivery = self.makePushDelivery(.snapshot(snapshot)) {
                continuation.yield(delivery)
            }
            self.subscribers[id] = continuation
            continuation.onTermination = { @Sendable _ in
                Task { await connection.removeSubscriber(id) }
            }
        }
    }

    private func removeSubscriber(_ id: UUID) {
        self.subscribers[id] = nil
    }

    func makePushDelivery(_ push: GatewayPush) -> PushDelivery? {
        guard case let .connected(connection) = self.connectionPublication.value else { return nil }
        let lease = connection.lease
        return PushDelivery(
            event: .push(push),
            serverLease: lease,
            mainSessionKey: connection.mainSessionKey,
            currentOwner: { [weak self] in
                self?.serverLeaseMatchesCurrentState(lease) == true
            })
    }

    private func retirePublication(disconnection: PushDelivery.Event?) {
        let lease = self.connectionPublication.withValue { publication -> ServerLease? in
            let lease: ServerLease? = switch publication {
            case let .connected(connection): connection.lease
            case let .disconnected(lease): lease
            case nil: nil
            }
            publication = disconnection == nil ? nil : lease.map(ConnectionPublication.disconnected)
            return lease
        }
        guard let lease else { return }
        // The terminal outcome survives its socket, but a replacement owner
        // invalidates it before it can degrade the newly selected Gateway.
        let delivery = PushDelivery(
            event: disconnection ?? .disconnected(nil),
            serverLease: lease,
            mainSessionKey: nil,
            currentOwner: { [weak self] in
                self?.publicationIsCurrent(lease, connected: false) == true
            })
        for continuation in self.subscribers.values {
            continuation.yield(delivery)
        }
    }

    private func broadcast(_ push: GatewayPush) {
        if case let .snapshot(snapshot) = push {
            self.lastSnapshot = snapshot
            if self.canvasPluginSurfaceURL == nil {
                self.installCanvasPluginSurfaceURL(from: snapshot)
            }
        }
        guard let delivery = self.makePushDelivery(push) else { return }
        for (_, continuation) in self.subscribers {
            continuation.yield(delivery)
        }
        if let socketGeneration = self.activeSocketGeneration {
            var terminatedSubscriberIDs: [UUID] = []
            for (id, continuation) in self.realtimeTalkSubscribers[socketGeneration] ?? [:] {
                switch continuation.yield(delivery) {
                case .enqueued:
                    break
                case .dropped, .terminated:
                    continuation.finish()
                    terminatedSubscriberIDs.append(id)
                @unknown default:
                    continuation.finish()
                    terminatedSubscriberIDs.append(id)
                }
            }
            for id in terminatedSubscriberIDs {
                self.removeRealtimeTalkSubscriber(id, socketGeneration: socketGeneration)
            }
        }
    }

    private func canonicalizeSessionKey(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return trimmed }
        guard let defaults = lastSnapshot?.snapshot.sessiondefaults else { return trimmed }
        let mainSessionKey = self.sessionDefaultString(defaults, key: "mainSessionKey")
        guard !mainSessionKey.isEmpty else { return trimmed }
        let mainKey = self.sessionDefaultString(defaults, key: "mainKey")
        let defaultAgentId = self.sessionDefaultString(defaults, key: "defaultAgentId")
        let isMainAlias =
            trimmed == "main" ||
            (!mainKey.isEmpty && trimmed == mainKey) ||
            trimmed == mainSessionKey ||
            (!defaultAgentId.isEmpty &&
                (trimmed == "agent:\(defaultAgentId):main" ||
                    (mainKey.isEmpty == false && trimmed == "agent:\(defaultAgentId):\(mainKey)")))
        return isMainAlias ? mainSessionKey : trimmed
    }
}

// MARK: - Typed gateway API

extension GatewayConnection {
    struct ConfigGetSnapshot: Decodable {
        struct SnapshotConfig: Decodable {
            struct Session: Decodable {
                let mainKey: String?
                let scope: String?
            }

            let session: Session?
        }

        let config: SnapshotConfig?
    }

    static func mainSessionKey(fromConfigGetData data: Data) throws -> String {
        let snapshot = try JSONDecoder().decode(ConfigGetSnapshot.self, from: data)
        let scope = snapshot.config?.session?.scope?.trimmingCharacters(in: .whitespacesAndNewlines)
        if scope == "global" {
            return "global"
        }
        return "main"
    }

    func mainSessionKey(timeoutMs: Double = 15000) async -> String {
        if let cached = cachedMainSessionKey() {
            return cached
        }
        return await self.refreshMainSessionKey(timeoutMs: timeoutMs)
    }

    func refreshMainSessionKey(timeoutMs: Double = 15000) async -> String {
        do {
            let data = try await requestRaw(method: "config.get", params: nil, timeoutMs: timeoutMs)
            return try Self.mainSessionKey(fromConfigGetData: data)
        } catch {
            return "main"
        }
    }

    func status() async -> (ok: Bool, error: String?) {
        do {
            _ = try await self.requestRaw(method: .status)
            return (true, nil)
        } catch {
            return (false, error.localizedDescription)
        }
    }

    func setHeartbeatsEnabled(_ enabled: Bool) async -> Bool {
        do {
            try await self.requestVoid(method: .setHeartbeats, params: ["enabled": AnyCodable(enabled)])
            return true
        } catch {
            gatewayConnectionLogger.error("setHeartbeatsEnabled failed \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func sendAgent(_ invocation: GatewayAgentInvocation) async -> (ok: Bool, error: String?) {
        let trimmed = invocation.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return (false, "message empty") }
        let sessionKey = self.canonicalizeSessionKey(invocation.sessionKey)

        var params: [String: AnyCodable] = [
            "message": AnyCodable(trimmed),
            "sessionKey": AnyCodable(sessionKey),
            "deliver": AnyCodable(invocation.deliver),
            "to": AnyCodable(invocation.to ?? ""),
            "channel": AnyCodable(invocation.channel.rawValue),
            "idempotencyKey": AnyCodable(invocation.idempotencyKey),
        ]
        if let thinking = invocation.thinking?.trimmingCharacters(in: .whitespacesAndNewlines),
           !thinking.isEmpty
        {
            params["thinking"] = AnyCodable(thinking)
        }
        if let timeout = invocation.timeoutSeconds {
            params["timeout"] = AnyCodable(timeout)
        }
        if let trigger = invocation.voiceWakeTrigger {
            params["voiceWakeTrigger"] = AnyCodable(
                trigger.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        do {
            try await self.requestVoid(method: .agent, params: params)
            return (true, nil)
        } catch {
            return (false, error.localizedDescription)
        }
    }

    // MARK: - Health

    func healthOK(timeoutMs: Int = 8000) async throws -> Bool {
        let data = try await requestRaw(method: .health, timeoutMs: Double(timeoutMs))
        return (try? self.decoder.decode(OpenClawGatewayHealthOK.self, from: data))?.ok ?? true
    }

    // MARK: - Skills

    func skillsStatus() async throws -> SkillsStatusReport {
        try await self.requestDecoded(method: .skillsStatus)
    }

    func skillsInstall(
        name: String,
        installId: String,
        dangerouslyForceUnsafeInstall: Bool? = nil,
        timeoutMs: Int? = nil) async throws -> SkillInstallResult
    {
        var params: [String: AnyCodable] = [
            "name": AnyCodable(name),
            "installId": AnyCodable(installId),
        ]
        if let dangerouslyForceUnsafeInstall {
            params["dangerouslyForceUnsafeInstall"] = AnyCodable(dangerouslyForceUnsafeInstall)
        }
        if let timeoutMs {
            params["timeoutMs"] = AnyCodable(timeoutMs)
        }
        return try await self.requestDecoded(method: .skillsInstall, params: params)
    }

    func skillsUpdate(
        skillKey: String,
        enabled: Bool? = nil,
        apiKey: String? = nil,
        env: [String: String]? = nil) async throws -> SkillUpdateResult
    {
        var params: [String: AnyCodable] = [
            "skillKey": AnyCodable(skillKey),
        ]
        if let enabled {
            params["enabled"] = AnyCodable(enabled)
        }
        if let apiKey {
            params["apiKey"] = AnyCodable(apiKey)
        }
        if let env, !env.isEmpty {
            params["env"] = AnyCodable(env)
        }
        return try await self.requestDecoded(method: .skillsUpdate, params: params)
    }

    // MARK: - Sessions

    func sessionsPreview(
        keys: [String],
        limit: Int? = nil,
        maxChars: Int? = nil,
        timeoutMs: Int? = nil) async throws -> OpenClawSessionsPreviewPayload
    {
        let resolvedKeys = keys
            .map { self.canonicalizeSessionKey($0) }
            .filter { !$0.isEmpty }
        if resolvedKeys.isEmpty {
            return OpenClawSessionsPreviewPayload(ts: 0, previews: [])
        }
        var params: [String: AnyCodable] = ["keys": AnyCodable(resolvedKeys)]
        if let limit {
            params["limit"] = AnyCodable(limit)
        }
        if let maxChars {
            params["maxChars"] = AnyCodable(maxChars)
        }
        let timeout = timeoutMs.map { Double($0) }
        return try await self.requestDecoded(
            method: .sessionsPreview,
            params: params,
            timeoutMs: timeout)
    }

    // MARK: - Chat

    func agentIdentity(sessionKey: String, timeoutMs: Double = 10000) async throws -> AgentIdentityResult {
        // Identity and chat.send must resolve aliases to the same canonical session target.
        let resolvedKey = self.canonicalizeSessionKey(sessionKey)
        return try await self.requestDecoded(
            method: .agentIdentityGet,
            params: ["sessionKey": AnyCodable(resolvedKey)],
            timeoutMs: timeoutMs)
    }

    func chatHistory(
        sessionKey: String,
        agentID: String? = nil,
        limit: Int? = nil,
        maxChars: Int? = nil,
        timeoutMs: Int? = nil,
        ifCurrentRoute route: Route? = nil) async throws -> OpenClawChatHistoryPayload
    {
        let resolvedKey = self.canonicalizeSessionKey(sessionKey)
        let request = OpenClawChatGatewayRequests.history(
            sessionKey: resolvedKey,
            agentID: agentID,
            limit: limit,
            maxChars: maxChars,
            timeoutMs: timeoutMs)
        if let route {
            let data = try await self.request(
                request,
                ifCurrentRoute: route)
            return try self.decoder.decode(OpenClawChatHistoryPayload.self, from: data)
        }
        let data = try await self.request(request)
        return try self.decoder.decode(OpenClawChatHistoryPayload.self, from: data)
    }

    func chatSend(
        sessionKey: String,
        agentID: String? = nil,
        expectedSessionRoutingContract: String? = nil,
        expectedSessionSettings: OpenClawChatSessionSettingsExpectation? = nil,
        message: String,
        thinking: String?,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload],
        runTimeoutMs: Int? = nil,
        requestTimeoutMs: Int = 30000,
        ifCurrentRoute route: Route? = nil,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> OpenClawChatSendResponse
    {
        let supportsSettingsCAS = if let route {
            await self.supportsServerCapability(
                .sessionSettingsCAS,
                ifCurrentRoute: route) == true
        } else {
            false
        }
        guard expectedSessionSettings == nil || supportsSettingsCAS else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let resolvedKey = self.canonicalizeSessionKey(sessionKey)
        let request = OpenClawChatGatewayRequests.sendMessage(
            sessionKey: resolvedKey,
            agentID: agentID,
            expectedSessionRoutingContract: expectedSessionRoutingContract,
            expectedSessionSettings: expectedSessionSettings,
            supportsSessionSettingsCAS: supportsSettingsCAS,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            runTimeoutMs: runTimeoutMs,
            requestTimeoutMs: requestTimeoutMs)

        if let route {
            let data = try await self.request(
                request,
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: distinguishPreDispatchRouteChange)
            return try self.decoder.decode(OpenClawChatSendResponse.self, from: data)
        }
        let data = try await self.request(request)
        return try self.decoder.decode(OpenClawChatSendResponse.self, from: data)
    }

    func talkMode(enabled: Bool, phase: String? = nil) async {
        var params: [String: AnyCodable] = ["enabled": AnyCodable(enabled)]
        if let phase {
            params["phase"] = AnyCodable(phase)
        }
        // Phase broadcasts report UI state; a failed notification must not start
        // the Gateway or restart its tunnel. Talk startup owns that recovery.
        _ = try? await self.request(method: Method.talkMode.rawValue, params: params, retryTransportFailures: false)
    }

    // MARK: - VoiceWake

    func voiceWakeSetTriggers(_ triggers: [String]) async {
        do {
            try await self.requestVoid(
                method: .voicewakeSet,
                params: ["triggers": AnyCodable(triggers)],
                timeoutMs: 10000)
        } catch {
            // Best-effort only.
        }
    }
}
