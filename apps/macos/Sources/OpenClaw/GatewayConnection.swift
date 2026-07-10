import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

private let gatewayConnectionLogger = Logger(subsystem: "ai.openclaw", category: "gateway.connection")

enum GatewayAgentChannel: String, Codable, CaseIterable {
    case last
    case whatsapp
    case telegram
    case discord
    case googlechat
    case slack
    case signal
    case imessage
    case msteams
    case webchat

    init(raw: String?) {
        let normalized = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self = GatewayAgentChannel(rawValue: normalized) ?? .last
    }

    var isDeliverable: Bool {
        self != .webchat
    }

    func shouldDeliver(_ deliver: Bool) -> Bool {
        deliver && self.isDeliverable
    }
}

struct GatewayAgentInvocation {
    var message: String
    var sessionKey: String = "main"
    var thinking: String?
    var deliver: Bool = false
    var to: String?
    var channel: GatewayAgentChannel = .last
    var timeoutSeconds: Int?
    var idempotencyKey: String = UUID().uuidString
    var voiceWakeTrigger: String?
}

/// Single, shared Gateway websocket connection for the whole app.
///
/// This owns exactly one `GatewayChannelActor` and reuses it across all callers
/// (ControlChannel, debug actions, SwiftUI WebChat, etc.).
actor GatewayConnection {
    static let shared = GatewayConnection()

    typealias Config = (url: URL, token: String?, password: String?)

    struct Route {
        fileprivate let generation: UInt64
        fileprivate let url: URL
        fileprivate let token: String?
        fileprivate let password: String?

        fileprivate func matches(_ config: Config) -> Bool {
            self.url == config.url && self.token == config.token && self.password == config.password
        }
    }

    /// One connected Gateway server, not merely an endpoint configuration.
    /// A reconnect at the same URL creates a different lease.
    struct ServerLease {
        fileprivate let route: Route
        fileprivate let socketGeneration: UInt64
        fileprivate let client: GatewayChannelActor
    }

    struct SessionRoutingIdentity: Equatable {
        let defaultAgentID: String
        let contract: String
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
        case chatAbort = "chat.abort"
        case skillsStatus = "skills.status"
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

    private let configProvider: @Sendable () async throws -> Config
    private let sessionBox: WebSocketSessionBox?
    private let clientShutdown: @Sendable (GatewayChannelActor) async -> Void
    private let decoder = JSONDecoder()

    private var client: GatewayChannelActor?
    private var configuredURL: URL?
    private var configuredToken: String?
    private var configuredPassword: String?
    private var configuredShutdownGeneration: UInt64?
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
        configProvider: @escaping @Sendable () async throws -> Config = GatewayConnection.defaultConfigProvider,
        sessionBox: WebSocketSessionBox? = nil,
        clientShutdown: @escaping @Sendable (GatewayChannelActor) async -> Void = { client in
            await client.shutdown()
        })
    {
        self.configProvider = configProvider
        self.sessionBox = sessionBox
        self.clientShutdown = clientShutdown
    }

    // MARK: - Low-level request

    func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double? = nil,
        retryTransportFailures: Bool = true) async throws -> Data
    {
        let shutdownGeneration = self.shutdownGeneration
        let cfg = try await configProvider()
        let client = try await configure(
            url: cfg.url,
            token: cfg.token,
            password: cfg.password,
            shutdownGeneration: shutdownGeneration)

        do {
            return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
        } catch {
            if !retryTransportFailures || error is GatewayResponseError || error is GatewayDecodingError {
                throw error
            }
            try self.requireCurrentShutdownGeneration(shutdownGeneration)

            // Auto-recover in local mode by spawning/attaching a gateway and retrying a few times.
            // Canvas interactions should "just work" even if the local gateway isn't running yet.
            let mode = await MainActor.run { AppStateStore.shared.connectionMode }
            try self.requireCurrentShutdownGeneration(shutdownGeneration)
            switch mode {
            case .local:
                await MainActor.run { GatewayProcessManager.shared.setActive(true) }
                try self.requireCurrentShutdownGeneration(shutdownGeneration)

                var lastError: Error = error
                for delayMs in [150, 400, 900] {
                    try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                    try self.requireCurrentShutdownGeneration(shutdownGeneration)
                    do {
                        return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
                    } catch {
                        try self.requireCurrentShutdownGeneration(shutdownGeneration)
                        lastError = error
                    }
                }

                let nsError = lastError as NSError
                try self.requireCurrentShutdownGeneration(shutdownGeneration)
                if nsError.domain == URLError.errorDomain,
                   let fallback = await GatewayEndpointStore.shared.maybeFallbackToTailnet(from: cfg.url)
                {
                    let fallbackClient = try await self.configure(
                        url: fallback.url,
                        token: fallback.token,
                        password: fallback.password,
                        shutdownGeneration: shutdownGeneration)
                    for delayMs in [150, 400, 900] {
                        try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                        try self.requireCurrentShutdownGeneration(shutdownGeneration)
                        do {
                            return try await fallbackClient.request(
                                method: method,
                                params: params,
                                timeoutMs: timeoutMs)
                        } catch {
                            try self.requireCurrentShutdownGeneration(shutdownGeneration)
                            lastError = error
                        }
                    }
                }

                try self.requireCurrentShutdownGeneration(shutdownGeneration)
                throw lastError
            case .remote:
                let nsError = error as NSError
                guard nsError.domain == URLError.errorDomain else { throw error }

                var lastError: Error = error
                await RemoteTunnelManager.shared.stopAll()
                try self.requireCurrentShutdownGeneration(shutdownGeneration)
                do {
                    _ = try await GatewayEndpointStore.shared.ensureRemoteControlTunnel()
                    try self.requireCurrentShutdownGeneration(shutdownGeneration)
                } catch {
                    try self.requireCurrentShutdownGeneration(shutdownGeneration)
                    lastError = error
                }

                for delayMs in [150, 400, 900] {
                    try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                    try self.requireCurrentShutdownGeneration(shutdownGeneration)
                    do {
                        let cfg = try await configProvider()
                        let client = try await configure(
                            url: cfg.url,
                            token: cfg.token,
                            password: cfg.password,
                            shutdownGeneration: shutdownGeneration)
                        return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
                    } catch {
                        try self.requireCurrentShutdownGeneration(shutdownGeneration)
                        lastError = error
                    }
                }

                try self.requireCurrentShutdownGeneration(shutdownGeneration)
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
        let cfg = try await configProvider()
        guard route.generation == self.routeGeneration,
              route.matches(cfg),
              self.configuredURL == route.url,
              self.configuredToken == route.token,
              self.configuredPassword == route.password,
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
        guard await self.isCurrentServerLease(lease) else {
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

    func requestRaw(
        method: Method,
        params: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil) async throws -> Data
    {
        try await self.request(method: method.rawValue, params: params, timeoutMs: timeoutMs)
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

    func requestVoid(
        method: Method,
        params: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil) async throws
    {
        _ = try await self.requestRaw(method: method, params: params, timeoutMs: timeoutMs)
    }

    /// Ensure the underlying socket is configured (and replaced if config changed).
    func refresh() async throws {
        let shutdownGeneration = self.shutdownGeneration
        let cfg = try await configProvider()
        _ = try await self.configure(
            url: cfg.url,
            token: cfg.token,
            password: cfg.password,
            shutdownGeneration: shutdownGeneration)
    }

    func captureRoute() async -> Route? {
        let shutdownGeneration = self.shutdownGeneration
        do {
            let cfg = try await configProvider()
            _ = try await self.configure(
                url: cfg.url,
                token: cfg.token,
                password: cfg.password,
                shutdownGeneration: shutdownGeneration)
            return Route(
                generation: self.routeGeneration,
                url: cfg.url,
                token: cfg.token,
                password: cfg.password)
        } catch {
            return nil
        }
    }

    /// Connect and bind subsequent work to the hello snapshot's physical
    /// socket. The read-only health preflight intentionally uses the ordinary
    /// recovery path so a fresh local Gateway can start and a remote tunnel can
    /// recover before onboarding freezes the successful physical connection.
    func acquireServerLease() async throws -> ServerLease {
        let shutdownGeneration = self.shutdownGeneration
        _ = try await self.request(
            method: Method.health.rawValue,
            params: nil,
            timeoutMs: 15000)
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        let cfg = try await configProvider()
        guard let client = self.configuredClient(
            url: cfg.url,
            token: cfg.token,
            password: cfg.password,
            shutdownGeneration: shutdownGeneration)
        else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard let socketGeneration = await client.currentConnectionGeneration() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let lease = ServerLease(
            route: Route(
                generation: self.routeGeneration,
                url: cfg.url,
                token: cfg.token,
                password: cfg.password),
            socketGeneration: socketGeneration,
            client: client)
        guard await self.isCurrentServerLease(lease) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        return lease
    }

    func isCurrentRoute(_ route: Route) async -> Bool {
        guard let cfg = try? await configProvider() else { return false }
        return route.generation == self.routeGeneration &&
            route.matches(cfg) &&
            self.configuredURL == route.url &&
            self.configuredToken == route.token &&
            self.configuredPassword == route.password
    }

    func supportsServerCapability(
        _ capability: GatewayServerCapability,
        ifCurrentRoute route: Route) async -> Bool?
    {
        guard let cfg = try? await configProvider(),
              route.generation == self.routeGeneration,
              route.matches(cfg),
              configuredURL == route.url,
              configuredToken == route.token,
              configuredPassword == route.password,
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
              let snapshot = self.lastSnapshot
        else { return nil }
        return snapshot.supportsServerCapability(capability)
    }

    func isCurrentServerLease(_ lease: ServerLease) async -> Bool {
        guard let cfg = try? await configProvider(),
              self.serverLeaseMatchesCurrentState(lease),
              lease.route.matches(cfg),
              await lease.client.currentConnectionGeneration() == lease.socketGeneration,
              self.serverLeaseMatchesCurrentState(lease)
        else { return false }
        return true
    }

    private func serverLeaseMatchesCurrentState(_ lease: ServerLease) -> Bool {
        lease.route.generation == self.routeGeneration &&
            lease.route.url == self.configuredURL &&
            lease.route.token == self.configuredToken &&
            lease.route.password == self.configuredPassword &&
            self.client === lease.client &&
            self.activeSocketGeneration == lease.socketGeneration &&
            self.lastSnapshot != nil
    }

    func sessionRoutingIdentity(ifCurrentRoute route: Route) async throws -> SessionRoutingIdentity {
        let data = try await request(
            method: "agents.list",
            params: [:],
            timeoutMs: 15000,
            ifCurrentRoute: route)
        return try Self.decodeSessionRoutingIdentity(data)
    }

    static func decodeSessionRoutingIdentity(_ data: Data) throws -> SessionRoutingIdentity {
        let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
        guard let contract = OpenClawChatSessionRoutingContract.make(
            scope: result.scope.value as? String,
            mainKey: result.mainkey,
            defaultAgentID: result.defaultid)
        else { throw CancellationError() }
        return SessionRoutingIdentity(defaultAgentID: result.defaultid, contract: contract)
    }

    func configuredInferenceModel(ifCurrentRoute route: Route) async throws -> String? {
        let data = try await request(
            method: "agents.list",
            params: [:],
            timeoutMs: 15000,
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
        self.resetSocketGeneration()
        self.lastSnapshot = nil
        let client = self.client
        self.client = nil
        self.configuredURL = nil
        self.configuredToken = nil
        self.configuredPassword = nil
        self.configuredShutdownGeneration = nil
        if let client {
            await self.clientShutdown(client)
        }
    }

    func canvasPluginSurfaceUrl() async -> String? {
        guard let snapshot = lastSnapshot else { return nil }
        let raw = snapshot.pluginsurfaceurls?["canvas"]?.value as? String
        let trimmed = raw?.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    func controlUiAutoAuthToken(config: Config) async -> String? {
        if let token = config.token?.trimmingCharacters(in: .whitespacesAndNewlines),
           !token.isEmpty
        {
            return token
        }
        if let deviceToken = lastSnapshot?.auth["deviceToken"]?.value as? String {
            let trimmed = deviceToken.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        let identity = DeviceIdentityStore.loadOrCreate()
        if let entry = DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator") {
            let trimmed = entry.token.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
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

    private func configure(
        url: URL,
        token: String?,
        password: String?,
        shutdownGeneration: UInt64) async throws -> GatewayChannelActor
    {
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        if let client = self.configuredClient(
            url: url,
            token: token,
            password: password,
            shutdownGeneration: shutdownGeneration)
        {
            return client
        }
        // Invalidate captured routes before suspension so no reentrant caller
        // can continue an old-gateway outbox flush during replacement.
        self.routeGeneration &+= 1
        self.resetSocketGeneration()
        self.lastSnapshot = nil
        let configuredRouteGeneration = self.routeGeneration
        let previousClient = self.client
        self.client = nil
        self.configuredURL = nil
        self.configuredToken = nil
        self.configuredPassword = nil
        self.configuredShutdownGeneration = nil
        if let previousClient {
            await self.clientShutdown(previousClient)
        }
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        if self.routeGeneration != configuredRouteGeneration {
            if let client = self.configuredClient(
                url: url,
                token: token,
                password: password,
                shutdownGeneration: shutdownGeneration)
            {
                return client
            }
            throw CancellationError()
        }
        let client = GatewayChannelActor(
            url: url,
            token: token,
            password: password,
            session: self.sessionBox,
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
            disconnectHandler: { [weak self] _, socketGeneration in
                await self?.handleDisconnect(
                    routeGeneration: configuredRouteGeneration,
                    socketGeneration: socketGeneration)
            })
        self.client = client
        self.configuredURL = url
        self.configuredToken = token
        self.configuredPassword = password
        self.configuredShutdownGeneration = shutdownGeneration
        return client
    }

    private func configuredClient(
        url: URL,
        token: String?,
        password: String?,
        shutdownGeneration: UInt64) -> GatewayChannelActor?
    {
        guard self.configuredShutdownGeneration == shutdownGeneration,
              self.configuredURL == url,
              self.configuredToken == token,
              self.configuredPassword == password
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
              self.admitSocketGeneration(socketGeneration)
        else { return }
        self.broadcast(push)
    }

    /// Short connect-path admission only. Subscriber delivery stays on the
    /// ordinary push task so connect never waits on downstream UI work.
    private func admitConnectSnapshot(
        _ snapshot: HelloOk,
        routeGeneration: UInt64,
        socketGeneration: UInt64)
    {
        guard routeGeneration == self.routeGeneration,
              self.admitSocketGeneration(socketGeneration)
        else { return }
        self.lastSnapshot = snapshot
    }

    private func handleDisconnect(routeGeneration: UInt64, socketGeneration: UInt64) {
        guard routeGeneration == self.routeGeneration,
              self.retireSocketGeneration(socketGeneration)
        else { return }
        self.lastSnapshot = nil
    }

    private func admitSocketGeneration(_ socketGeneration: UInt64) -> Bool {
        if let lastRetiredSocketGeneration,
           socketGeneration <= lastRetiredSocketGeneration
        {
            return false
        }
        if let activeSocketGeneration {
            return socketGeneration == activeSocketGeneration
        }
        self.activeSocketGeneration = socketGeneration
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
        self.activeSocketGeneration = nil
        self.lastRetiredSocketGeneration = socketGeneration
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

    private static func defaultConfigProvider() async throws -> Config {
        try await GatewayEndpointStore.shared.requireConfig()
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

    func sendSystemEvent(_ params: [String: AnyCodable]) async {
        do {
            try await self.requestVoid(method: .systemEvent, params: params)
        } catch {
            // Best-effort only.
        }
    }

    // MARK: - Health

    func healthSnapshot(timeoutMs: Double? = nil) async throws -> HealthSnapshot {
        let data = try await requestRaw(method: .health, timeoutMs: timeoutMs)
        if let snap = decodeHealthSnapshot(from: data) { return snap }
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
        if let enabled { params["enabled"] = AnyCodable(enabled) }
        if let apiKey { params["apiKey"] = AnyCodable(apiKey) }
        if let env, !env.isEmpty { params["env"] = AnyCodable(env) }
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
        if let limit { params["limit"] = AnyCodable(limit) }
        if let maxChars { params["maxChars"] = AnyCodable(maxChars) }
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
        var params: [String: AnyCodable] = ["sessionKey": AnyCodable(resolvedKey)]
        if let agentID = agentID?.trimmingCharacters(in: .whitespacesAndNewlines), !agentID.isEmpty {
            params["agentId"] = AnyCodable(agentID)
        }
        if let limit { params["limit"] = AnyCodable(limit) }
        if let maxChars { params["maxChars"] = AnyCodable(maxChars) }
        let timeout = timeoutMs.map { Double($0) }
        if let route {
            let data = try await request(
                method: Method.chatHistory.rawValue,
                params: params,
                timeoutMs: timeout,
                ifCurrentRoute: route)
            return try self.decoder.decode(OpenClawChatHistoryPayload.self, from: data)
        }
        return try await self.requestDecoded(method: .chatHistory, params: params, timeoutMs: timeout)
    }

    func chatSend(
        sessionKey: String,
        agentID: String? = nil,
        expectedSessionRoutingContract: String? = nil,
        message: String,
        thinking: String?,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload],
        timeoutMs: Int = 30000,
        ifCurrentRoute route: Route? = nil,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> OpenClawChatSendResponse
    {
        let resolvedKey = self.canonicalizeSessionKey(sessionKey)
        var params: [String: AnyCodable] = [
            "sessionKey": AnyCodable(resolvedKey),
            "message": AnyCodable(message),
            "idempotencyKey": AnyCodable(idempotencyKey),
            "timeoutMs": AnyCodable(timeoutMs),
        ]
        if let agentID = agentID?.trimmingCharacters(in: .whitespacesAndNewlines), !agentID.isEmpty {
            params["agentId"] = AnyCodable(agentID)
        }
        if let expectedSessionRoutingContract = expectedSessionRoutingContract?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !expectedSessionRoutingContract.isEmpty
        {
            params["expectedSessionRoutingContract"] = AnyCodable(expectedSessionRoutingContract)
        }
        if let thinking = thinking?.trimmingCharacters(in: .whitespacesAndNewlines),
           !thinking.isEmpty
        {
            params["thinking"] = AnyCodable(thinking)
        }

        if !attachments.isEmpty {
            let encoded = attachments.map { att in
                [
                    "type": att.type,
                    "mimeType": att.mimeType,
                    "fileName": att.fileName,
                    "content": att.content,
                ]
            }
            params["attachments"] = AnyCodable(encoded)
        }

        if let route {
            let data = try await request(
                method: Method.chatSend.rawValue,
                params: params,
                timeoutMs: Double(timeoutMs),
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: distinguishPreDispatchRouteChange)
            return try self.decoder.decode(OpenClawChatSendResponse.self, from: data)
        }
        return try await self.requestDecoded(method: .chatSend, params: params, timeoutMs: Double(timeoutMs))
    }

    func chatAbort(sessionKey: String, runId: String) async throws -> Bool {
        let resolvedKey = self.canonicalizeSessionKey(sessionKey)
        struct AbortResponse: Decodable {
            let ok: Bool?
            let aborted: Bool?
        }
        let res: AbortResponse = try await requestDecoded(
            method: .chatAbort,
            params: ["sessionKey": AnyCodable(resolvedKey), "runId": AnyCodable(runId)])
        return res.aborted ?? false
    }

    func talkMode(enabled: Bool, phase: String? = nil) async {
        var params: [String: AnyCodable] = ["enabled": AnyCodable(enabled)]
        if let phase { params["phase"] = AnyCodable(phase) }
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
