import CryptoKit
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog
import Security

private let gatewayConnectionLogger = Logger(subsystem: "ai.openclaw", category: "gateway.connection")

private struct GatewayRouteChangedAfterDispatchError: LocalizedError, Sendable {
    let method: String

    var errorDescription: String? {
        "The Gateway route changed after \(self.method) was sent. Its result is unknown; refresh before retrying."
    }
}

private enum GatewayActivationBindingKeyStore {
    private static let service = "ai.openclaw.onboarding-route-binding"
    private static let account = "credential-binding-v1"
    private static let byteCount = 32

    static func loadOrCreate() -> SymmetricKey? {
        if let data = load() {
            return SymmetricKey(data: data)
        }

        var data = Data(count: byteCount)
        let randomStatus = data.withUnsafeMutableBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return errSecAllocate }
            return SecRandomCopyBytes(kSecRandomDefault, self.byteCount, baseAddress)
        }
        guard randomStatus == errSecSuccess else { return nil }

        var query = self.baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        if addStatus == errSecSuccess {
            return SymmetricKey(data: data)
        }
        // Another process can win the first-launch create race. Only accept the
        // secret after reading the Keychain item back through normal ACL checks.
        if addStatus == errSecDuplicateItem, let existing = load() {
            return SymmetricKey(data: existing)
        }
        return nil
    }

    private static func load() -> Data? {
        var query = self.baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              data.count == byteCount
        else { return nil }
        return data
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }
}

/// Single, shared Gateway websocket connection for the whole app.
///
/// This owns exactly one `GatewayChannelActor` and reuses it across all callers
/// (ControlChannel, debug actions, SwiftUI WebChat, etc.).
actor GatewayConnection {
    static let shared = GatewayConnection(
        endpointProvider: GatewayConnection.defaultEndpointProvider)

    typealias Config = (url: URL, token: String?, password: String?)

    struct EndpointSnapshot {
        let config: Config
        let routeAuthority: UInt64?
        let deviceAuthGatewayID: String?
        let revision: UInt64?

        init(
            config: Config,
            routeAuthority: UInt64?,
            deviceAuthGatewayID: String? = nil,
            revision: UInt64? = nil)
        {
            self.config = config
            self.routeAuthority = routeAuthority
            self.deviceAuthGatewayID = deviceAuthGatewayID
            self.revision = revision
        }
    }

    typealias EndpointProvider = @Sendable () async throws -> EndpointSnapshot

    struct Route: Equatable, Sendable {
        fileprivate let generation: UInt64
        fileprivate let authority: UInt64?
        fileprivate let url: URL
        fileprivate let token: String?
        fileprivate let password: String?
        fileprivate let deviceAuthGatewayID: String?
        let activationOwnershipFingerprint: String?

        fileprivate func matches(
            _ config: Config,
            authority: UInt64?,
            deviceAuthGatewayID: String?) -> Bool
        {
            self.authority == authority &&
                self.url == config.url &&
                self.token == config.token &&
                self.password == config.password &&
                self.deviceAuthGatewayID == deviceAuthGatewayID
        }
    }

    /// One connected Gateway server, not merely an endpoint configuration.
    /// A reconnect at the same URL creates a different lease.
    struct ServerLease: Sendable {
        fileprivate let route: Route
        fileprivate let socketGeneration: UInt64
        fileprivate let client: GatewayChannelActor
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
        case execApprovalResolve = "exec.approval.resolve"
        case cronList = "cron.list"
        case cronRuns = "cron.runs"
        case cronRun = "cron.run"
        case cronRemove = "cron.remove"
        case cronUpdate = "cron.update"
        case cronAdd = "cron.add"
        case cronStatus = "cron.status"
    }

    private let endpointProvider: EndpointProvider
    private let activationBindingKeyProvider: @Sendable () -> SymmetricKey?
    private let sessionBox: WebSocketSessionBox?
    private let clientShutdown: @Sendable (GatewayChannelActor) async -> Void
    private let decoder = JSONDecoder()

    private var client: GatewayChannelActor?
    private var configuredURL: URL?
    private var configuredToken: String?
    private var configuredPassword: String?
    private var configuredDeviceAuthGatewayID: String?
    private var configuredRouteAuthority: UInt64?
    private var configuredShutdownGeneration: UInt64?
    private var configuredActivationBindingKey: SymmetricKey?
    private var highestEndpointRevision: UInt64?
    private var routeGeneration: UInt64 = 0
    /// Unbound operations capture this before their first suspension. Shutdown
    /// advances it so delayed config and retry work cannot recreate a route.
    private var shutdownGeneration: UInt64 = 0
    // Callback work keeps the physical socket epoch that decoded it. Retiring
    // that epoch prevents delayed pushes from entering a replacement socket.
    private var activeSocketGeneration: UInt64?
    private var lastRetiredSocketGeneration: UInt64?

    private var subscribers: [UUID: AsyncStream<GatewayPush>.Continuation] = [:]
    private var lastSnapshot: HelloOk?

    private struct LossyDecodable<Value: Decodable>: Decodable {
        let value: Value?

        init(from decoder: Decoder) throws {
            do {
                self.value = try Value(from: decoder)
            } catch {
                self.value = nil
            }
        }
    }

    private struct LossyCronListResponse: Decodable {
        let jobs: [LossyDecodable<CronJob>]

        enum CodingKeys: String, CodingKey {
            case jobs
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.jobs = try container.decodeIfPresent([LossyDecodable<CronJob>].self, forKey: .jobs) ?? []
        }
    }

    private struct LossyCronRunsResponse: Decodable {
        let entries: [LossyDecodable<CronRunLogEntry>]

        enum CodingKeys: String, CodingKey {
            case entries
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.entries = try container.decodeIfPresent([LossyDecodable<CronRunLogEntry>].self, forKey: .entries) ?? []
        }
    }

    init(
        endpointProvider: @escaping EndpointProvider = GatewayConnection.defaultEndpointProvider,
        activationBindingKeyProvider: @escaping @Sendable () -> SymmetricKey? =
            GatewayConnection.defaultActivationBindingKey,
        sessionBox: WebSocketSessionBox? = nil,
        clientShutdown: @escaping @Sendable (GatewayChannelActor) async -> Void = { client in
            await client.shutdown()
        })
    {
        self.endpointProvider = endpointProvider
        self.activationBindingKeyProvider = activationBindingKeyProvider
        self.sessionBox = sessionBox
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
        clientShutdown: @escaping @Sendable (GatewayChannelActor) async -> Void = { client in
            await client.shutdown()
        })
    {
        self.endpointProvider = {
            try await EndpointSnapshot(config: configProvider(), routeAuthority: nil)
        }
        self.activationBindingKeyProvider = activationBindingKeyProvider
        self.sessionBox = sessionBox
        self.clientShutdown = clientShutdown
    }
    #endif

    // MARK: - Low-level request

    func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double? = nil,
        retryTransportFailures: Bool = true) async throws -> Data
    {
        let shutdownGeneration = shutdownGeneration
        let endpoint = try await currentEndpoint()
        let cfg = endpoint.config
        let client = try await configure(
            url: cfg.url,
            token: cfg.token,
            password: cfg.password,
            deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
            routeAuthority: endpoint.routeAuthority,
            shutdownGeneration: shutdownGeneration)

        do {
            return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
        } catch {
            if !retryTransportFailures || error is GatewayResponseError || error is GatewayDecodingError {
                throw error
            }
            try requireCurrentShutdownGeneration(shutdownGeneration)

            // Auto-recover in local mode by spawning/attaching a gateway and retrying a few times.
            // Canvas interactions should "just work" even if the local gateway isn't running yet.
            let mode = await MainActor.run { AppStateStore.shared.connectionMode }
            try requireCurrentShutdownGeneration(shutdownGeneration)
            switch mode {
            case .local:
                await MainActor.run { GatewayProcessManager.shared.setActive(true) }
                try requireCurrentShutdownGeneration(shutdownGeneration)

                var lastError: Error = error
                for delayMs in [150, 400, 900] {
                    try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                    try requireCurrentShutdownGeneration(shutdownGeneration)
                    do {
                        return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
                    } catch {
                        try requireCurrentShutdownGeneration(shutdownGeneration)
                        lastError = error
                    }
                }

                let nsError = lastError as NSError
                try requireCurrentShutdownGeneration(shutdownGeneration)
                if nsError.domain == URLError.errorDomain,
                   let fallback = await GatewayEndpointStore.shared.maybeFallbackToTailnet(from: cfg.url)
                {
                    try acceptEndpointRevision(fallback)
                    let fallbackConfig = fallback.config
                    let fallbackClient = try await configure(
                        url: fallbackConfig.url,
                        token: fallbackConfig.token,
                        password: fallbackConfig.password,
                        deviceAuthGatewayID: fallback.deviceAuthGatewayID,
                        routeAuthority: fallback.routeAuthority,
                        shutdownGeneration: shutdownGeneration)
                    for delayMs in [150, 400, 900] {
                        try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                        try requireCurrentShutdownGeneration(shutdownGeneration)
                        do {
                            return try await fallbackClient.request(
                                method: method,
                                params: params,
                                timeoutMs: timeoutMs)
                        } catch {
                            try requireCurrentShutdownGeneration(shutdownGeneration)
                            lastError = error
                        }
                    }
                }

                try requireCurrentShutdownGeneration(shutdownGeneration)
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

                for delayMs in [150, 400, 900] {
                    try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                    try requireCurrentShutdownGeneration(shutdownGeneration)
                    do {
                        let endpoint = try await currentEndpoint()
                        let cfg = endpoint.config
                        let client = try await configure(
                            url: cfg.url,
                            token: cfg.token,
                            password: cfg.password,
                            deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
                            routeAuthority: endpoint.routeAuthority,
                            shutdownGeneration: shutdownGeneration)
                        return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
                    } catch {
                        try requireCurrentShutdownGeneration(shutdownGeneration)
                        lastError = error
                    }
                }

                try requireCurrentShutdownGeneration(shutdownGeneration)
                throw lastError
            case .unconfigured:
                throw error
            }
        }
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
        let cfg = endpoint.config
        guard route.generation == self.routeGeneration,
              route.matches(
                  cfg,
                  authority: endpoint.routeAuthority,
                  deviceAuthGatewayID: endpoint.deviceAuthGatewayID),
              self.configuredURL == route.url,
              self.configuredToken == route.token,
              self.configuredPassword == route.password,
              self.configuredDeviceAuthGatewayID == route.deviceAuthGatewayID,
              self.configuredRouteAuthority == route.authority,
              let client
        else {
            if distinguishPreDispatchRouteChange {
                throw OpenClawChatTransportSendError.notDispatched
            }
            throw CancellationError()
        }
        return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
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
        do {
            return try await lease.client.request(
                method: method,
                params: params,
                timeoutMs: timeoutMs,
                ifCurrentConnectionGeneration: lease.socketGeneration)
        } catch is CancellationError {
            if Task.isCancelled {
                throw CancellationError()
            }
            throw OpenClawChatTransportSendError.notDispatched
        }
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
        let cfg = endpoint.config
        _ = try await self.configure(
            url: cfg.url,
            token: cfg.token,
            password: cfg.password,
            deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
            routeAuthority: endpoint.routeAuthority,
            shutdownGeneration: shutdownGeneration)
    }

    func captureRoute() async -> Route? {
        let shutdownGeneration = shutdownGeneration
        do {
            let endpoint = try await currentEndpoint()
            let cfg = endpoint.config
            _ = try await self.configure(
                url: cfg.url,
                token: cfg.token,
                password: cfg.password,
                deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
                routeAuthority: endpoint.routeAuthority,
                shutdownGeneration: shutdownGeneration)
            return Route(
                generation: self.routeGeneration,
                authority: endpoint.routeAuthority,
                url: cfg.url,
                token: cfg.token,
                password: cfg.password,
                deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
                activationOwnershipFingerprint: Self.activationOwnershipFingerprint(
                    config: cfg,
                    key: self.configuredActivationBindingKey))
        } catch {
            return nil
        }
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
              let client = self.client,
              let socketGeneration = self.activeSocketGeneration
        else { return nil }
        let lease = ServerLease(route: route, socketGeneration: socketGeneration, client: client)
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
            url: cfg.url,
            token: cfg.token,
            password: cfg.password,
            deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
            routeAuthority: endpoint.routeAuthority,
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
                deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
                activationOwnershipFingerprint: Self.activationOwnershipFingerprint(
                    config: cfg,
                    authBinding: authBinding,
                    key: self.configuredActivationBindingKey)),
            socketGeneration: socketGeneration,
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
              replacement.route.deviceAuthGatewayID == previous.route.deviceAuthGatewayID
        else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        return replacement
    }

    func isCurrentRoute(_ route: Route) async -> Bool {
        guard let endpoint = try? await currentEndpoint() else { return false }
        let cfg = endpoint.config
        return route.generation == self.routeGeneration &&
            route.matches(
                cfg,
                authority: endpoint.routeAuthority,
                deviceAuthGatewayID: endpoint.deviceAuthGatewayID) &&
            self.configuredURL == route.url &&
            self.configuredToken == route.token &&
            self.configuredPassword == route.password &&
            self.configuredDeviceAuthGatewayID == route.deviceAuthGatewayID &&
            self.configuredRouteAuthority == route.authority
    }

    func supportsServerCapability(
        _ capability: GatewayServerCapability,
        ifCurrentRoute route: Route) async -> Bool?
    {
        guard let endpoint = try? await currentEndpoint() else { return nil }
        let cfg = endpoint.config
        guard
            route.generation == self.routeGeneration,
            route.matches(
                cfg,
                authority: endpoint.routeAuthority,
                deviceAuthGatewayID: endpoint.deviceAuthGatewayID),
            self.configuredURL == route.url,
            self.configuredToken == route.token,
            self.configuredPassword == route.password,
            self.configuredDeviceAuthGatewayID == route.deviceAuthGatewayID,
            self.configuredRouteAuthority == route.authority,
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

    func isCurrentServerLease(_ lease: ServerLease) async -> Bool {
        guard let endpoint = try? await currentEndpoint(),
              serverLeaseMatchesCurrentState(lease),
              lease.route.matches(
                  endpoint.config,
                  authority: endpoint.routeAuthority,
                  deviceAuthGatewayID: endpoint.deviceAuthGatewayID),
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

    private func serverLeaseMatchesCurrentState(_ lease: ServerLease) -> Bool {
        lease.route.generation == self.routeGeneration &&
            lease.route.url == self.configuredURL &&
            lease.route.token == self.configuredToken &&
            lease.route.password == self.configuredPassword &&
            lease.route.deviceAuthGatewayID == self.configuredDeviceAuthGatewayID &&
            lease.route.authority == self.configuredRouteAuthority &&
            self.client === lease.client &&
            self.activeSocketGeneration == lease.socketGeneration &&
            self.lastSnapshot != nil
    }

    func sessionRoutingIdentity(
        ifCurrentRoute route: Route) async throws -> OpenClawChatSessionRoutingIdentity
    {
        let data = try await request(
            OpenClawChatGatewayRequests.agentsList(),
            ifCurrentRoute: route)
        return try OpenClawChatGatewayPayloadCodec.decodeSessionRoutingIdentity(data)
    }

    func configuredInferenceModel(
        ifCurrentRoute route: Route,
        timeoutMs: Double = 15000) async throws -> String?
    {
        let data = try await request(
            OpenClawChatGatewayRequests.agentsList(timeoutMs: timeoutMs),
            ifCurrentRoute: route)
        guard await self.isCurrentRoute(route) else {
            throw CancellationError()
        }
        return try Self.decodeConfiguredInferenceModel(data)
    }

    static func decodeConfiguredInferenceModel(_ data: Data) throws -> String? {
        let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
        let primary = result.agents
            .first(where: { $0.id == result.defaultid })?
            .model?["primary"]?.value as? String
        let trimmed = primary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    func authSource() async -> GatewayAuthSource? {
        guard let client else { return nil }
        return await client.authSource()
    }

    func shutdown() async {
        self.shutdownGeneration &+= 1
        self.routeGeneration &+= 1
        resetSocketGeneration()
        self.lastSnapshot = nil
        let client = client
        self.client = nil
        self.configuredURL = nil
        self.configuredToken = nil
        self.configuredPassword = nil
        self.configuredDeviceAuthGatewayID = nil
        self.configuredRouteAuthority = nil
        self.configuredShutdownGeneration = nil
        self.configuredActivationBindingKey = nil
        if let client {
            await self.clientShutdown(client)
        }
    }

    private func configure(
        url: URL,
        token: String?,
        password: String?,
        deviceAuthGatewayID: String?,
        routeAuthority: UInt64?,
        shutdownGeneration: UInt64) async throws -> GatewayChannelActor
    {
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        if let client = configuredClient(
            url: url,
            token: token,
            password: password,
            deviceAuthGatewayID: deviceAuthGatewayID,
            routeAuthority: routeAuthority,
            shutdownGeneration: shutdownGeneration)
        {
            return client
        }
        // Invalidate captured routes before suspension so no reentrant caller
        // can continue an old-gateway outbox flush during replacement.
        self.routeGeneration &+= 1
        resetSocketGeneration()
        self.lastSnapshot = nil
        let configuredRouteGeneration = self.routeGeneration
        let previousClient = client
        client = nil
        self.configuredURL = nil
        self.configuredToken = nil
        self.configuredPassword = nil
        self.configuredDeviceAuthGatewayID = nil
        self.configuredRouteAuthority = nil
        self.configuredShutdownGeneration = nil
        self.configuredActivationBindingKey = nil
        if let previousClient {
            await self.clientShutdown(previousClient)
        }
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        if self.routeGeneration != configuredRouteGeneration {
            if let client = configuredClient(
                url: url,
                token: token,
                password: password,
                deviceAuthGatewayID: deviceAuthGatewayID,
                routeAuthority: routeAuthority,
                shutdownGeneration: shutdownGeneration)
            {
                return client
            }
            throw CancellationError()
        }
        let activationBindingKey = self.activationBindingKeyProvider()
        let client = GatewayChannelActor(
            url: url,
            token: token,
            password: password,
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
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-macos",
                clientMode: "ui",
                clientDisplayName: InstanceIdentity.displayName,
                allowStoredDeviceAuth: deviceAuthGatewayID != nil,
                deviceAuthGatewayID: deviceAuthGatewayID),
            disconnectHandler: { [weak self] _, socketGeneration in
                await self?.handleDisconnect(
                    routeGeneration: configuredRouteGeneration,
                    socketGeneration: socketGeneration)
            })
        self.client = client
        self.configuredURL = url
        self.configuredToken = token
        self.configuredPassword = password
        self.configuredDeviceAuthGatewayID = deviceAuthGatewayID
        self.configuredRouteAuthority = routeAuthority
        self.configuredShutdownGeneration = shutdownGeneration
        self.configuredActivationBindingKey = activationBindingKey
        return client
    }

    private func configuredClient(
        url: URL,
        token: String?,
        password: String?,
        deviceAuthGatewayID: String?,
        routeAuthority: UInt64?,
        shutdownGeneration: UInt64) -> GatewayChannelActor?
    {
        guard self.configuredShutdownGeneration == shutdownGeneration,
              self.configuredURL == url,
              self.configuredToken == token,
              self.configuredPassword == password,
              self.configuredDeviceAuthGatewayID == deviceAuthGatewayID,
              self.configuredRouteAuthority == routeAuthority
        else { return nil }
        return self.client
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
    }

    private func handleDisconnect(routeGeneration: UInt64, socketGeneration: UInt64) {
        guard routeGeneration == self.routeGeneration,
              retireSocketGeneration(socketGeneration)
        else { return }
        self.lastSnapshot = nil
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

    private func retireSocketGeneration(_ socketGeneration: UInt64) -> Bool {
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
        self.configuredURL
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
        GatewayActivationBindingKeyStore.loadOrCreate()
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
    func canvasPluginSurfaceUrl() async -> String? {
        guard let snapshot = lastSnapshot else { return nil }
        let raw = snapshot.pluginsurfaceurls?["canvas"]?.value as? String
        let trimmed = raw?.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    func controlUiAutoAuthToken(config: Config) async -> String? {
        guard let endpoint = try? await currentEndpoint(),
              endpoint.config.url == config.url,
              endpoint.config.token == config.token,
              endpoint.config.password == config.password,
              let client,
              let socketGeneration = activeSocketGeneration,
              controlUiRouteIsLive(
                  config: config,
                  routeAuthority: endpoint.routeAuthority,
                  deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
                  client: client,
                  socketGeneration: socketGeneration),
              await client.currentConnectionGeneration() == socketGeneration,
              controlUiRouteIsLive(
                  config: config,
                  routeAuthority: endpoint.routeAuthority,
                  deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
                  client: client,
                  socketGeneration: socketGeneration),
              let authBinding = await client.authBinding(
                  ifCurrentConnectionGeneration: socketGeneration),
              controlUiRouteIsLive(
                  config: config,
                  routeAuthority: endpoint.routeAuthority,
                  deviceAuthGatewayID: endpoint.deviceAuthGatewayID,
                  client: client,
                  socketGeneration: socketGeneration)
        else { return nil }

        switch authBinding.source {
        case .sharedToken:
            return config.token?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        case .deviceToken:
            guard let gatewayID = configuredDeviceAuthGatewayID?
                .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            else { return nil }
            if let deviceToken = lastSnapshot?.auth["deviceToken"]?.value as? String,
               let token = deviceToken.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            {
                return token
            }
            let identity = DeviceIdentityStore.loadOrCreate()
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
        config: Config,
        routeAuthority: UInt64?,
        deviceAuthGatewayID: String?,
        client: GatewayChannelActor,
        socketGeneration: UInt64) -> Bool
    {
        self.configuredURL == config.url &&
            self.configuredToken == config.token &&
            self.configuredPassword == config.password &&
            self.configuredRouteAuthority == routeAuthority &&
            self.configuredDeviceAuthGatewayID == deviceAuthGatewayID &&
            self.configuredShutdownGeneration == self.shutdownGeneration &&
            self.client === client &&
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

    func snapshotPaths() -> (configPath: String?, stateDir: String?) {
        guard let snapshot = lastSnapshot else { return (nil, nil) }
        let configPath = snapshot.snapshot.configpath?.trimmingCharacters(in: .whitespacesAndNewlines)
        let stateDir = snapshot.snapshot.statedir?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (
            configPath?.isEmpty == false ? configPath : nil,
            stateDir?.isEmpty == false ? stateDir : nil)
    }

    func subscribe(bufferingNewest: Int = 100) -> AsyncStream<GatewayPush> {
        let id = UUID()
        let snapshot = self.lastSnapshot
        let connection = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
            if let snapshot {
                continuation.yield(.snapshot(snapshot))
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

    private func broadcast(_ push: GatewayPush) {
        if case let .snapshot(snapshot) = push {
            self.lastSnapshot = snapshot
            if let mainSessionKey = cachedMainSessionKey() {
                Task { @MainActor in
                    WorkActivityStore.shared.setMainSessionKey(mainSessionKey)
                }
            }
        }
        for (_, continuation) in self.subscribers {
            continuation.yield(push)
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

    func sendAgent(
        message: String,
        thinking: String?,
        sessionKey: String,
        deliver: Bool,
        to: String?,
        channel: GatewayAgentChannel = .last,
        timeoutSeconds: Int? = nil,
        idempotencyKey: String = UUID().uuidString) async -> (ok: Bool, error: String?)
    {
        await self.sendAgent(GatewayAgentInvocation(
            message: message,
            sessionKey: sessionKey,
            thinking: thinking,
            deliver: deliver,
            to: to,
            channel: channel,
            timeoutSeconds: timeoutSeconds,
            idempotencyKey: idempotencyKey))
    }

    // MARK: - Health

    func healthSnapshot(timeoutMs: Double? = nil) async throws -> HealthSnapshot {
        let data = try await requestRaw(method: .health, timeoutMs: timeoutMs)
        if let snap = decodeHealthSnapshot(from: data) {
            return snap
        }
        throw GatewayDecodingError(method: Method.health.rawValue, message: "failed to decode health snapshot")
    }

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
        message: String,
        thinking: String?,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload],
        runTimeoutMs: Int? = nil,
        requestTimeoutMs: Int = 30000,
        ifCurrentRoute route: Route? = nil,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> OpenClawChatSendResponse
    {
        let resolvedKey = self.canonicalizeSessionKey(sessionKey)
        let request = OpenClawChatGatewayRequests.sendMessage(
            sessionKey: resolvedKey,
            agentID: agentID,
            expectedSessionRoutingContract: expectedSessionRoutingContract,
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
        try? await self.requestVoid(method: .talkMode, params: params)
    }

    // MARK: - VoiceWake

    func voiceWakeGetTriggers() async throws -> [String] {
        struct VoiceWakePayload: Decodable { let triggers: [String] }
        let payload: VoiceWakePayload = try await requestDecoded(method: .voicewakeGet)
        return payload.triggers
    }

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

    // MARK: - Node pairing

    func nodePairApprove(requestId: String) async throws {
        try await self.requestVoid(
            method: .nodePairApprove,
            params: ["requestId": AnyCodable(requestId)],
            timeoutMs: 10000)
    }

    func nodePairReject(requestId: String) async throws {
        try await self.requestVoid(
            method: .nodePairReject,
            params: ["requestId": AnyCodable(requestId)],
            timeoutMs: 10000)
    }

    // MARK: - Device pairing

    func devicePairApprove(requestId: String) async throws {
        try await self.requestVoid(
            method: .devicePairApprove,
            params: ["requestId": AnyCodable(requestId)],
            timeoutMs: 10000)
    }

    func devicePairReject(requestId: String) async throws {
        try await self.requestVoid(
            method: .devicePairReject,
            params: ["requestId": AnyCodable(requestId)],
            timeoutMs: 10000)
    }

    // MARK: - Cron

    struct CronSchedulerStatus: Decodable {
        let enabled: Bool
        let storePath: String
        let sqlitePath: String?
        let jobs: Int
        let nextWakeAtMs: Int?
    }

    func cronStatus() async throws -> CronSchedulerStatus {
        try await self.requestDecoded(method: .cronStatus)
    }

    func cronList(includeDisabled: Bool = true) async throws -> [CronJob] {
        let data = try await requestRaw(
            method: .cronList,
            params: ["includeDisabled": AnyCodable(includeDisabled)])
        return try Self.decodeCronListResponse(data)
    }

    func cronRuns(jobId: String, limit: Int = 200) async throws -> [CronRunLogEntry] {
        let data = try await requestRaw(
            method: .cronRuns,
            params: ["id": AnyCodable(jobId), "limit": AnyCodable(limit)])
        return try Self.decodeCronRunsResponse(data)
    }

    func cronRun(jobId: String, force: Bool = true) async throws {
        try await self.requestVoid(
            method: .cronRun,
            params: [
                "id": AnyCodable(jobId),
                "mode": AnyCodable(force ? "force" : "due"),
            ],
            timeoutMs: 20000)
    }

    func cronRemove(jobId: String) async throws {
        try await self.requestVoid(method: .cronRemove, params: ["id": AnyCodable(jobId)])
    }

    func cronUpdate(jobId: String, patch: [String: AnyCodable]) async throws {
        try await self.requestVoid(
            method: .cronUpdate,
            params: ["id": AnyCodable(jobId), "patch": AnyCodable(patch)])
    }

    func cronAdd(payload: [String: AnyCodable]) async throws {
        try await self.requestVoid(method: .cronAdd, params: payload)
    }

    nonisolated static func decodeCronListResponse(_ data: Data) throws -> [CronJob] {
        let decoded = try JSONDecoder().decode(LossyCronListResponse.self, from: data)
        let jobs = decoded.jobs.compactMap(\.value)
        let skipped = decoded.jobs.count - jobs.count
        if skipped > 0 {
            gatewayConnectionLogger.warning("cron.list skipped \(skipped, privacy: .public) malformed jobs")
        }
        return jobs
    }

    nonisolated static func decodeCronRunsResponse(_ data: Data) throws -> [CronRunLogEntry] {
        let decoded = try JSONDecoder().decode(LossyCronRunsResponse.self, from: data)
        let entries = decoded.entries.compactMap(\.value)
        let skipped = decoded.entries.count - entries.count
        if skipped > 0 {
            gatewayConnectionLogger.warning("cron.runs skipped \(skipped, privacy: .public) malformed entries")
        }
        return entries
    }
}
