import Foundation
import OpenClawChatUI
import OpenClawProtocol

enum AppleReviewDemoMode {
    static let setupCode = "APPLE-REVIEW-DEMO"
    static let gatewayName = "Apple Review Demo Gateway"
    static let gatewayAddress = "Local demo mode"
    static let gatewayID = "apple-review-demo"

    static func isSetupCode(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .localizedCaseInsensitiveCompare(self.setupCode) == .orderedSame
    }

    static var agents: [AgentSummary] {
        LocalChatFixture.appleReviewDemo.agents
    }
}

enum ScreenshotFixtureMode {
    static let gatewayName = "OpenClaw Gateway"
    static let gatewayAddress = "Gateway on local network"
    static let gatewayID = "screenshot-fixture-gateway"

    static var agents: [AgentSummary] {
        LocalChatFixture.appScreenshots.agents
    }
}

struct LocalChatFixture {
    let sessionKey: String
    let sessionIDPrefix: String
    let displayName: String
    let subject: String
    let modelProvider: String
    let modelID: String
    let modelName: String
    let responsePrefix: String
    let seedMessages: [String]
    let agents: [AgentSummary]

    static let appleReviewDemo = LocalChatFixture(
        sessionKey: "main",
        sessionIDPrefix: "apple-review-demo",
        displayName: "Apple Review Demo",
        subject: "Gateway review flow",
        modelProvider: "demo",
        modelID: "local-demo",
        modelName: "Apple Review Demo",
        responsePrefix: "Demo mode is active.",
        seedMessages: [
            """
            Apple Review demo mode is active. This local chat transport lets reviewers inspect the iOS app \
            without a private Gateway.
            """,
        ],
        agents: [
            AgentSummary(
                id: "main",
                name: "Main",
                identity: ["emoji": AnyCodable("OC")],
                workspace: "Apple Review Demo",
                workspacegit: false,
                model: ["provider": AnyCodable("demo"), "model": AnyCodable("local-demo")],
                agentruntime: ["kind": AnyCodable("local")],
                thinkinglevels: nil,
                thinkingoptions: ["auto", "low", "medium"],
                thinkingdefault: "auto"),
        ])

    static let appScreenshots = LocalChatFixture(
        sessionKey: "main",
        sessionIDPrefix: "screenshot-fixture",
        displayName: "Molty",
        subject: "Mobile command center",
        modelProvider: "openai",
        modelID: "gpt-5.6-sol",
        modelName: "GPT-5.6 Sol",
        responsePrefix: "OpenClaw is connected to your gateway.",
        seedMessages: ProcessInfo.processInfo.arguments.contains("--openclaw-empty-chat-fixture")
            ? []
            : ["Ready when you are. I can check a project, coordinate an agent, or prepare the next step."],
        agents: [
            AgentSummary(
                id: "main",
                name: "Molty",
                identity: ["emoji": AnyCodable("M")],
                workspace: "OpenClaw",
                workspacegit: false,
                model: ["provider": AnyCodable("openai"), "model": AnyCodable("gpt-5.6-sol")],
                agentruntime: ["kind": AnyCodable("gateway")],
                thinkinglevels: nil,
                thinkingoptions: ["auto", "low", "medium", "high"],
                thinkingdefault: "auto"),
            AgentSummary(
                id: "research",
                name: "Research",
                identity: ["emoji": AnyCodable("RS")],
                workspace: "OpenClaw",
                workspacegit: false,
                model: ["provider": AnyCodable("openai"), "model": AnyCodable("gpt-5.6-sol")],
                agentruntime: ["kind": AnyCodable("gateway")],
                thinkinglevels: nil,
                thinkingoptions: ["auto", "low", "medium", "high"],
                thinkingdefault: "medium"),
            AgentSummary(
                id: "automation",
                name: "Automation",
                identity: ["emoji": AnyCodable("AU")],
                workspace: "OpenClaw",
                workspacegit: false,
                model: ["provider": AnyCodable("openai"), "model": AnyCodable("gpt-5.6-sol")],
                agentruntime: ["kind": AnyCodable("gateway")],
                thinkinglevels: nil,
                thinkingoptions: ["auto", "low", "medium", "high"],
                thinkingdefault: "auto"),
        ])
}

struct LocalFixtureChatTransport: OpenClawChatTransport {
    private let fixture: LocalChatFixture
    private let store: LocalFixtureChatStore

    init(fixture: LocalChatFixture) {
        self.fixture = fixture
        self.store = LocalFixtureChatStore(fixture: fixture)
    }

    func createSession(
        key: String,
        label _: String?,
        parentSessionKey _: String?,
        worktree _: Bool?) async throws -> OpenClawChatCreateSessionResponse
    {
        try await self.store.createSession(key: key)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try await self.store.history(sessionKey: sessionKey)
    }

    func listModels() async throws -> [OpenClawChatModelChoice] {
        [
            OpenClawChatModelChoice(
                modelID: self.fixture.modelID,
                name: self.fixture.modelName,
                provider: self.fixture.modelProvider,
                contextWindow: 128_000),
        ]
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try await self.store.sendMessage(
            sessionKey: sessionKey,
            message: message,
            runId: idempotencyKey)
    }

    func abortRun(sessionKey _: String, runId _: String) async throws {}

    func listSessions(
        limit _: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        let response = try await self.store.sessions()
        var sessions = response.sessions
        if archived {
            sessions = []
        }
        if let search {
            sessions = OpenClawChatSessionListOrganizer.filter(sessions, search: search)
        }
        return OpenClawChatSessionsListResponse(
            ts: response.ts,
            path: response.path,
            count: sessions.count,
            defaults: response.defaults,
            sessions: sessions)
    }

    func setSessionModel(sessionKey _: String, model _: String?) async throws {}

    func setSessionThinking(sessionKey _: String, thinkingLevel _: String) async throws {}

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func waitForRunCompletion(
        runId _: String,
        timeoutMs _: Int) async -> OpenClawChatRunObservation
    {
        .terminal(.completed)
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            continuation.yield(.health(ok: true))
            continuation.finish()
        }
    }

    func setActiveSessionKey(_: String) async throws {}

    func resetSession(sessionKey _: String) async throws {
        await self.store.reset()
    }

    func compactSession(sessionKey _: String) async throws {}
}

struct AppleReviewDemoChatTransport: OpenClawChatTransport {
    private let transport = LocalFixtureChatTransport(fixture: .appleReviewDemo)

    func createSession(
        key: String,
        label: String?,
        parentSessionKey: String?,
        worktree: Bool?) async throws -> OpenClawChatCreateSessionResponse
    {
        try await self.transport.createSession(
            key: key,
            label: label,
            parentSessionKey: parentSessionKey,
            worktree: worktree)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try await self.transport.requestHistory(sessionKey: sessionKey)
    }

    func listModels() async throws -> [OpenClawChatModelChoice] {
        try await self.transport.listModels()
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try await self.transport.sendMessage(
            sessionKey: sessionKey,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        try await self.transport.abortRun(sessionKey: sessionKey, runId: runId)
    }

    func listSessions(
        limit: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        try await self.transport.listSessions(limit: limit, search: search, archived: archived)
    }

    func setSessionModel(sessionKey: String, model: String?) async throws {
        try await self.transport.setSessionModel(sessionKey: sessionKey, model: model)
    }

    func patchSessionModel(
        sessionKey: String,
        agentID: String?,
        model: String?) async throws -> OpenClawChatModelPatchResult?
    {
        try await self.transport.patchSessionModel(
            sessionKey: sessionKey,
            agentID: agentID,
            model: model)
    }

    func setSessionThinking(sessionKey: String, thinkingLevel: String) async throws {
        try await self.transport.setSessionThinking(sessionKey: sessionKey, thinkingLevel: thinkingLevel)
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        try await self.transport.requestHealth(timeoutMs: timeoutMs)
    }

    func waitForRunCompletion(
        runId: String,
        timeoutMs: Int) async -> OpenClawChatRunObservation
    {
        await self.transport.waitForRunCompletion(runId: runId, timeoutMs: timeoutMs)
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.transport.events()
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        try await self.transport.setActiveSessionKey(sessionKey)
    }

    func resetSession(sessionKey: String) async throws {
        try await self.transport.resetSession(sessionKey: sessionKey)
    }

    func compactSession(sessionKey: String) async throws {
        try await self.transport.compactSession(sessionKey: sessionKey)
    }
}

private actor LocalFixtureChatStore {
    private let fixture: LocalChatFixture
    private var messages: [OpenClawChatMessage]

    init(fixture: LocalChatFixture) {
        self.fixture = fixture
        self.messages = Self.seedMessages(fixture: fixture)
    }

    func createSession(key: String) throws -> OpenClawChatCreateSessionResponse {
        try Self.decode(
            CreateSessionPayload(ok: true, key: key, sessionId: "\(self.fixture.sessionIDPrefix)-\(key)"),
            as: OpenClawChatCreateSessionResponse.self)
    }

    func history(sessionKey: String) throws -> OpenClawChatHistoryPayload {
        let normalizedSessionKey = Self.normalizedSessionKey(sessionKey, fallback: self.fixture.sessionKey)
        return try Self.decode(
            HistoryPayload(
                sessionKey: normalizedSessionKey,
                sessionId: "\(self.fixture.sessionIDPrefix)-\(normalizedSessionKey)",
                messages: self.messages,
                thinkingLevel: "auto"),
            as: OpenClawChatHistoryPayload.self)
    }

    func sendMessage(sessionKey _: String, message: String, runId: String) throws -> OpenClawChatSendResponse {
        let now = Date().timeIntervalSince1970 * 1000
        self.messages.append(
            Self.message(
                role: "user",
                text: message,
                timestamp: now,
                idempotencyKey: "\(runId):user"))
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let subject = trimmed.isEmpty ? "that request" : "\"\(trimmed)\""
        self.messages.append(
            Self.message(
                role: "assistant",
                text: """
                \(self.fixture.responsePrefix) I can help with \(subject), summarize current project context, \
                prepare agent actions, and keep the mobile workflow connected to the gateway.
                """,
                timestamp: now + 1))
        return try Self.decode(
            SendPayload(runId: runId, status: "ok"),
            as: OpenClawChatSendResponse.self)
    }

    func sessions() throws -> OpenClawChatSessionsListResponse {
        let entry = OpenClawChatSessionEntry(
            key: self.fixture.sessionKey,
            kind: "chat",
            displayName: self.fixture.displayName,
            surface: "ios",
            subject: self.fixture.subject,
            room: nil,
            space: nil,
            updatedAt: Date().timeIntervalSince1970 * 1000,
            sessionId: "\(self.fixture.sessionIDPrefix)-\(self.fixture.sessionKey)",
            systemSent: true,
            abortedLastRun: false,
            thinkingLevel: "auto",
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: self.fixture.modelProvider,
            model: self.fixture.modelID,
            contextTokens: 128_000,
            thinkingLevels: Self.thinkingLevels,
            thinkingOptions: Self.thinkingOptions,
            thinkingDefault: "auto")
        return OpenClawChatSessionsListResponse(
            ts: Date().timeIntervalSince1970 * 1000,
            path: nil,
            count: 1,
            defaults: OpenClawChatSessionsDefaults(
                modelProvider: self.fixture.modelProvider,
                model: self.fixture.modelID,
                contextTokens: 128_000,
                thinkingLevels: Self.thinkingLevels,
                thinkingOptions: Self.thinkingOptions,
                thinkingDefault: "auto",
                mainSessionKey: self.fixture.sessionKey),
            sessions: [entry])
    }

    func reset() {
        self.messages = Self.seedMessages(fixture: self.fixture)
    }

    private static var thinkingOptions: [String] {
        ["auto", "low", "medium", "high"]
    }

    private static var thinkingLevels: [OpenClawChatThinkingLevelOption] {
        [
            OpenClawChatThinkingLevelOption(id: "auto", label: "Auto"),
            OpenClawChatThinkingLevelOption(id: "low", label: "Low"),
            OpenClawChatThinkingLevelOption(id: "medium", label: "Medium"),
            OpenClawChatThinkingLevelOption(id: "high", label: "High"),
        ]
    }

    private static func seedMessages(fixture: LocalChatFixture) -> [OpenClawChatMessage] {
        let now = Date().timeIntervalSince1970 * 1000
        return fixture.seedMessages.enumerated().map { index, text in
            self.message(role: "assistant", text: text, timestamp: now + Double(index))
        }
    }

    private static func message(
        role: String,
        text: String,
        timestamp: Double,
        idempotencyKey: String? = nil) -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            role: role,
            content: [
                OpenClawChatMessageContent(
                    type: "text",
                    text: text,
                    mimeType: nil,
                    fileName: nil,
                    content: nil),
            ],
            timestamp: timestamp,
            idempotencyKey: idempotencyKey,
            stopReason: role == "assistant" ? "stop" : nil)
    }

    private static func normalizedSessionKey(_ value: String, fallback: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }

    private static func decode<T: Decodable>(_ value: some Encodable, as type: T.Type) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(type, from: data)
    }

    private struct HistoryPayload: Encodable {
        var sessionKey: String
        var sessionId: String?
        var messages: [OpenClawChatMessage]?
        var thinkingLevel: String?
    }

    private struct SendPayload: Encodable {
        var runId: String
        var status: String
    }

    private struct CreateSessionPayload: Encodable {
        var ok: Bool?
        var key: String
        var sessionId: String?
    }
}
