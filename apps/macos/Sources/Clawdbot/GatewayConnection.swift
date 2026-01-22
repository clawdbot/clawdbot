import ClawdbotChatUI
import ClawdbotKit
import ClawdbotProtocol
import Foundation
import OSLog

private let gatewayConnectionLogger = Logger(subsystem: "com.clawdbot", category: "gateway.connection")

enum GatewayAgentChannel: String, Codable, CaseIterable, Sendable {
    case last
    case whatsapp
    case telegram
    case discord
    case slack
    case signal
    case imessage
    case msteams
    case bluebubbles
    case webchat

    init(raw: String?) {
        let normalized = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self = GatewayAgentChannel(rawValue: normalized) ?? .last
    }

    var isDeliverable: Bool { self != .webchat }

    func shouldDeliver(_ deliver: Bool) -> Bool { deliver && self.isDeliverable }
}

struct GatewayAgentInvocation: Sendable {
    var message: String
    var sessionKey: String = "main"
    var thinking: String?
    var deliver: Bool = false
    var to: String?
    var channel: GatewayAgentChannel = .last
    var timeoutSeconds: Int?
    var idempotencyKey: String = UUID().uuidString
}

/// Single, shared Gateway websocket connection for the whole app.
///
/// This owns exactly one `GatewayChannelActor` and reuses it across all callers
/// (ControlChannel, debug actions, SwiftUI WebChat, etc.).
actor GatewayConnection {
    static let shared = GatewayConnection()

    typealias Config = (url: URL, token: String?, password: String?)

    enum Method: String, Sendable {
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
        case wizardStart = "wizard.start"
        case wizardNext = "wizard.next"
        case wizardCancel = "wizard.cancel"
        case wizardStatus = "wizard.status"
        case talkMode = "talk.mode"
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
    private let decoder = JSONDecoder()

    private var client: GatewayChannelActor?
    private var configuredURL: URL?
    private var configuredToken: String?
    private var configuredPassword: String?

    private var subscribers: [UUID: AsyncStream<GatewayPush>.Continuation] = [:]
    private var lastSnapshot: HelloOk?

    init(
        configProvider: @escaping @Sendable () async throws -> Config = GatewayConnection.defaultConfigProvider,
        sessionBox: WebSocketSessionBox? = nil)
    {
        self.configProvider = configProvider
        self.sessionBox = sessionBox
    }

    // MARK: - Low-level request

    func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double? = nil) async throws -> Data
    {
        let cfg = try await self.configProvider()
        await self.configure(url: cfg.url, token: cfg.token, password: cfg.password)
        guard let client else {
            throw NSError(domain: "Gateway", code: 0, userInfo: [NSLocalizedDescriptionKey: "gateway not configured"])
        }

        do {
            return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
        } catch {
            if error is GatewayResponseError || error is GatewayDecodingError {
                throw error
            }

            // Auto-recover in local mode by spawning/attaching a gateway and retrying a few times.
            // Canvas interactions should "just work" even if the local gateway isn't running yet.
            let mode = await MainActor.run { AppStateStore.shared.connectionMode }
            switch mode {
            case .local:
                await MainActor.run { GatewayProcessManager.shared.setActive(true) }

                var lastError: Error = error
                for delayMs in [150, 400, 900] {
                    try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                    do {
                        return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
                    } catch {
                        lastError = error
                    }
                }

                let nsError = lastError as NSError
                if nsError.domain == URLError.errorDomain,
                   let fallback = await GatewayEndpointStore.shared.maybeFallbackToTailnet(from: cfg.url)
                {
                    await self.configure(url: fallback.url, token: fallback.token, password: fallback.password)
                    for delayMs in [150, 400, 900] {
                        try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                        do {
                            guard let client = self.client else {
                                throw NSError(
                                    domain: "Gateway",
                                    code: 0,
                                    userInfo: [NSLocalizedDescriptionKey: "gateway not configured"])
                            }
                            return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
                        } catch {
                            lastError = error
                        }
                    }
                }

                throw lastError
            case .remote:
                let nsError = error as NSError
                guard nsError.domain == URLError.errorDomain else { throw error }

                var lastError: Error = error
                await RemoteTunnelManager.shared.stopAll()
                do {
                    _ = try await GatewayEndpointStore.shared.ensureRemoteControlTunnel()
                } catch {
                    lastError = error
                }

                for delayMs in [150, 400, 900] {
                    try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                    do {
                        let cfg = try await self.configProvider()
                        await self.configure(url: cfg.url, token: cfg.token, password: cfg.password)
                        guard let client = self.client else {
                            throw NSError(
                                domain: "Gateway",
                                code: 0,
                                userInfo: [NSLocalizedDescriptionKey: "gateway not configured"])
                        }
                        return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
                    } catch {
                        lastError = error
                    }
                }

                throw lastError
            case .unconfigured:
                throw error
            }
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
        let data = try await self.requestRaw(method: method, params: params, timeoutMs: timeoutMs)
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
        let cfg = try await self.configProvider()
        await self.configure(url: cfg.url, token: cfg.token, password: cfg.password)
    }

    func authSource() async -> GatewayAuthSource? {
        guard let client else { return nil }
        return await client.authSource()
    }

    func shutdown() async {
        if let client {
            await client.shutdown()
        }
        self.client = nil
        self.configuredURL = nil
        self.configuredToken = nil
        self.lastSnapshot = nil
    }

    func canvasHostUrl() async -> String? {
        guard let snapshot = self.lastSnapshot else { return nil }
        let trimmed = snapshot.canvashosturl?.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func sessionDefaultString(_ defaults: [String: ClawdbotProtocol.AnyCodable]?, key: String) -> String {
        let raw = defaults?[key]?.value as? String
        return (raw ?? "").trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
    }

    func cachedMainSessionKey() -> String? {
        guard let snapshot = self.lastSnapshot else { return nil }
        let trimmed = self.sessionDefaultString(snapshot.snapshot.sessiondefaults, key: "mainSessionKey")
        return trimmed.isEmpty ? nil : trimmed
    }

    func cachedGatewayVersion() -> String? {
        guard let snapshot = self.lastSnapshot else { return nil }
        let raw = snapshot.server["version"]?.value as? String
        let trimmed = raw?.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    func snapshotPaths() -> (configPath: String?, stateDir: String?) {
        guard let snapshot = self.lastSnapshot else { return (nil, nil) }
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
            if let mainSessionKey = self.cachedMainSessionKey() {
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
        guard let defaults = self.lastSnapshot?.snapshot.sessiondefaults else { return trimmed }
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

    private func configure(url: URL, token: String?, password: String?) async {
        if self.client != nil, self.configuredURL == url, self.configuredToken == token,
           self.configuredPassword == password
        {
            return
        }
        if let client {
            await client.shutdown()
        }
        self.lastSnapshot = nil
        self.client = GatewayChannelActor(
            url: url,
            token: token,
            password: password,
            session: self.sessionBox,
            pushHandler: { [weak self] push in
                await self?.handle(push: push)
            })
        self.configuredURL = url
        self.configuredToken = token
        self.configuredPassword = password
    }

    private func handle(push: GatewayPush) {
        self.broadcast(push)
    }

    private static func defaultConfigProvider() async throws -> Config {
        try await GatewayEndpointStore.shared.requireConfig()
    }
}

// MARK: - Typed gateway API

extension GatewayConnection {
    struct ConfigGetSnapshot: Decodable, Sendable {
        struct SnapshotConfig: Decodable, Sendable {
            struct Session: Decodable, Sendable {
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
        if let cached = self.cachedMainSessionKey() {
            return cached
        }
        do {
            let data = try await self.requestRaw(method: "config.get", params: nil, timeoutMs: timeoutMs)
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
            "thinking": AnyCodable(invocation.thinking ?? "default"),
            "deliver": AnyCodable(invocation.deliver),
            "to": AnyCodable(invocation.to ?? ""),
            "channel": AnyCodable(invocation.channel.rawValue),
            "idempotencyKey": AnyCodable(invocation.idempotencyKey),
        ]
        if let timeout = invocation.timeoutSeconds {
            params["timeout"] = AnyCodable(timeout)
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
        let data = try await self.requestRaw(method: .health, timeoutMs: timeoutMs)
        if let snap = decodeHealthSnapshot(from: data) { return snap }
        throw GatewayDecodingError(method: Method.health.rawValue, message: "failed to decode health snapshot")
    }

    func healthOK(timeoutMs: Int = 8000) async throws -> Bool {
        let data = try await self.requestRaw(method: .health, timeoutMs: Double(timeoutMs))
        return (try? self.decoder.decode(ClawdbotGatewayHealthOK.self, from: data))?.ok ?? true
    }

    // MARK: - Skills

    func skillsStatus() async throws -> SkillsStatusReport {
        try await self.requestDecoded(method: .skillsStatus)
    }

    func skillsInstall(
        name: String,
        installId: String,
        timeoutMs: Int? = nil) async throws -> SkillInstallResult
    {
        var params: [String: AnyCodable] = [
            "name": AnyCodable(name),
            "installId": AnyCodable(installId),
        ]
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
        timeoutMs: Int? = nil) async throws -> ClawdbotSessionsPreviewPayload
    {
        let resolvedKeys = keys
            .map { self.canonicalizeSessionKey($0) }
            .filter { !$0.isEmpty }
        if resolvedKeys.isEmpty {
            return ClawdbotSessionsPreviewPayload(ts: 0, previews: [])
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
        limit: Int? = nil,
        timeoutMs: Int? = nil) async throws -> ClawdbotChatHistoryPayload
    {
        let resolvedKey = self.canonicalizeSessionKey(sessionKey)
        var params: [String: AnyCodable] = ["sessionKey": AnyCodable(resolvedKey)]
        if let limit { params["limit"] = AnyCodable(limit) }
        let timeout = timeoutMs.map { Double($0) }
        return try await self.requestDecoded(
            method: .chatHistory,
            params: params,
            timeoutMs: timeout)
    }

    func chatSend(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [ClawdbotChatAttachmentPayload],
        timeoutMs: Int = 30000) async throws -> ClawdbotChatSendResponse
    {
        let resolvedKey = self.canonicalizeSessionKey(sessionKey)
        var params: [String: AnyCodable] = [
            "sessionKey": AnyCodable(resolvedKey),
            "message": AnyCodable(message),
            "thinking": AnyCodable(thinking),
            "idempotencyKey": AnyCodable(idempotencyKey),
            "timeoutMs": AnyCodable(timeoutMs),
        ]

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

        return try await self.requestDecoded(
            method: .chatSend,
            params: params,
            timeoutMs: Double(timeoutMs))
    }

    func chatAbort(sessionKey: String, runId: String) async throws -> Bool {
        let resolvedKey = self.canonicalizeSessionKey(sessionKey)
        struct AbortResponse: Decodable { let ok: Bool?; let aborted: Bool? }
        let res: AbortResponse = try await self.requestDecoded(
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
        let payload: VoiceWakePayload = try await self.requestDecoded(method: .voicewakeGet)
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

    struct CronSchedulerStatus: Decodable, Sendable {
        let enabled: Bool
        let storePath: String
        let jobs: Int
        let nextWakeAtMs: Int?
    }

    func cronStatus() async throws -> CronSchedulerStatus {
        try await self.requestDecoded(method: .cronStatus)
    }

    func cronList(includeDisabled: Bool = true) async throws -> [CronJob] {
        let res: CronListResponse = try await self.requestDecoded(
            method: .cronList,
            params: ["includeDisabled": AnyCodable(includeDisabled)])
        return res.jobs
    }

    func cronRuns(jobId: String, limit: Int = 200) async throws -> [CronRunLogEntry] {
        let res: CronRunsResponse = try await self.requestDecoded(
            method: .cronRuns,
            params: ["id": AnyCodable(jobId), "limit": AnyCodable(limit)])
        return res.entries
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
}
