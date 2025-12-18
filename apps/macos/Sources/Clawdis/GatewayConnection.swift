import ClawdisChatUI
import ClawdisProtocol
import Foundation
import OSLog

private let gatewayConnectionLogger = Logger(subsystem: "com.steipete.clawdis", category: "gateway.connection")

enum GatewayAgentChannel: String, Codable, CaseIterable, Sendable {
    case last
    case whatsapp
    case telegram
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

    typealias Config = (url: URL, token: String?)

    enum Method: String, Sendable {
        case agent
        case status
        case setHeartbeats = "set-heartbeats"
        case systemEvent = "system-event"
        case health
        case chatHistory = "chat.history"
        case chatSend = "chat.send"
        case chatAbort = "chat.abort"
        case voicewakeGet = "voicewake.get"
        case voicewakeSet = "voicewake.set"
        case nodePairApprove = "node.pair.approve"
        case nodePairReject = "node.pair.reject"
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
        await self.configure(url: cfg.url, token: cfg.token)
        guard let client else {
            throw NSError(domain: "Gateway", code: 0, userInfo: [NSLocalizedDescriptionKey: "gateway not configured"])
        }

        do {
            return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
        } catch {
            // Auto-recover in local mode by spawning/attaching a gateway and retrying a few times.
            // Canvas interactions should "just work" even if the local gateway isn't running yet.
            let isLocal = await MainActor.run { AppStateStore.shared.connectionMode == .local }
            guard isLocal else { throw error }

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

            throw lastError
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
        await self.configure(url: cfg.url, token: cfg.token)
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
        }
        for (_, continuation) in self.subscribers {
            continuation.yield(push)
        }
    }

    private func configure(url: URL, token: String?) async {
        if self.client != nil, self.configuredURL == url, self.configuredToken == token {
            return
        }
        if let client {
            await client.shutdown()
        }
        self.lastSnapshot = nil
        self.client = GatewayChannelActor(
            url: url,
            token: token,
            session: self.sessionBox,
            pushHandler: { [weak self] push in
                await self?.handle(push: push)
            })
        self.configuredURL = url
        self.configuredToken = token
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

        var params: [String: AnyCodable] = [
            "message": AnyCodable(trimmed),
            "sessionKey": AnyCodable(invocation.sessionKey),
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
        return (try? self.decoder.decode(ClawdisGatewayHealthOK.self, from: data))?.ok ?? true
    }

    // MARK: - Chat

    func chatHistory(sessionKey: String) async throws -> ClawdisChatHistoryPayload {
        try await self.requestDecoded(
            method: .chatHistory,
            params: ["sessionKey": AnyCodable(sessionKey)])
    }

    func chatSend(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [ClawdisChatAttachmentPayload],
        timeoutMs: Int = 30000) async throws -> ClawdisChatSendResponse
    {
        var params: [String: AnyCodable] = [
            "sessionKey": AnyCodable(sessionKey),
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

        return try await self.requestDecoded(method: .chatSend, params: params)
    }

    func chatAbort(sessionKey: String, runId: String) async throws -> Bool {
        struct AbortResponse: Decodable { let ok: Bool?; let aborted: Bool? }
        let res: AbortResponse = try await self.requestDecoded(
            method: .chatAbort,
            params: ["sessionKey": AnyCodable(sessionKey), "runId": AnyCodable(runId)])
        return res.aborted ?? false
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
