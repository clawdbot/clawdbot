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
}

enum ScreenshotFixtureMode {
    static let gatewayName = "OpenClaw Gateway"
    static let gatewayAddress = "Gateway on local network"
    static let gatewayID = "screenshot-fixture-gateway"
}

struct LocalChatFixture {
    let sessionKey: String
    let defaultAgentID: String
    let sessionIDPrefix: String
    let displayName: String
    let subject: String
    let modelProvider: String
    let modelID: String
    let modelName: String
    let modelSelectionTarget: String
    let additionalModels: [OpenClawChatModelChoice]
    let responsePrefix: String
    let seedMessages: [String]
    let agents: [AgentSummary]

    static let appleReviewDemo = LocalChatFixture(
        sessionKey: "main",
        defaultAgentID: "main",
        sessionIDPrefix: "apple-review-demo",
        displayName: "Apple Review Demo",
        subject: "Gateway review flow",
        modelProvider: "demo",
        modelID: "local-demo",
        modelName: "Apple Review Demo",
        modelSelectionTarget: "session",
        additionalModels: [],
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
        defaultAgentID: "main",
        sessionIDPrefix: "screenshot-fixture",
        displayName: "Molty",
        subject: "Mobile command center",
        modelProvider: "openai",
        modelID: "gpt-5.6-sol",
        modelName: "GPT-5.6 Sol",
        modelSelectionTarget: "global",
        additionalModels: [
            OpenClawChatModelChoice(
                modelID: "claude-opus-4-1",
                name: "Claude Opus 4.1",
                provider: "anthropic",
                contextWindow: 200_000),
        ],
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
    var supportsComposerCapabilities: Bool {
        true
    }

    func loadComposerCapabilityCatalog(
        sessionKey _: String,
        agentID _: String?) async -> OpenClawChatComposerCapabilityCatalog
    {
        OpenClawChatComposerCapabilityCatalog(
            sessionSettingsAvailable: true,
            modelMutationAvailable: true,
            effortMutationAvailable: true,
            webSearchBaseEnabled: true,
            webSearchAvailable: true,
            skills: [
                OpenClawChatComposerSkill(
                    key: "autoreview",
                    name: "Auto Review",
                    baseEnabled: true,
                    missingDependencies: false,
                    blocked: false),
                OpenClawChatComposerSkill(
                    key: "release",
                    name: "Release OpenClaw",
                    baseEnabled: true,
                    missingDependencies: false,
                    blocked: false),
                OpenClawChatComposerSkill(
                    key: "disabled-fixture",
                    name: "Disabled Skill",
                    baseEnabled: false,
                    missingDependencies: false,
                    blocked: false),
            ],
            connectors: [
                OpenClawChatComposerConnector(
                    name: "GitHub",
                    baseEnabled: true,
                    tools: [
                        OpenClawChatComposerTool(name: "search_code", label: "Search code"),
                        OpenClawChatComposerTool(name: "create_issue", label: "Create issue"),
                    ]),
                OpenClawChatComposerConnector(
                    name: "Linear",
                    baseEnabled: true,
                    tools: [
                        OpenClawChatComposerTool(name: "search_issues", label: "Search issues"),
                    ]),
            ],
            skillsAvailable: true,
            connectorsAvailable: true,
            toolAccessAvailable: true,
            permissionMutationAvailable: true,
            toolOverrideMutationAvailable: true,
            canSelectFullPermission: true)
    }

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

    func createSession(
        key: String,
        label _: String?,
        agentID: String?,
        parentSessionKey _: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) async throws -> OpenClawChatCreateSessionResponse
    {
        let normalizedAgentID = agentID?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let requestedAgentID = normalizedAgentID?.isEmpty == false
            ? normalizedAgentID
            : self.fixture.defaultAgentID
        guard self.fixture.agents.contains(where: { $0.id.lowercased() == requestedAgentID }) else {
            throw Self.newSessionOptionsError("The selected fixture agent is unavailable.")
        }
        // Fixtures advertise no Git workspaces. Reject advanced inputs instead
        // of reporting a session that ignored the selected worktree contract.
        guard worktree != true, worktreeBaseRef == nil else {
            throw Self.newSessionOptionsError("Worktree sessions are unavailable in local fixture mode.")
        }
        return try await self.store.createSession(key: key)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try await self.store.history(sessionKey: sessionKey)
    }

    func listModels(agentID _: String?) async throws -> [OpenClawChatModelChoice] {
        if ProcessInfo.processInfo.arguments.contains("--openclaw-unavailable-model-fixture") {
            return try OpenClawChatGatewayPayloadCodec.decodeModelChoices(Data(#"""
            {"models":[
              {"id":"gpt-5.6-sol","name":"GPT-5.6 Sol","provider":"openai",
               "available":true,"contextWindow":128000},
              {"id":"claude-opus-4-1","name":"Claude Opus 4.1","provider":"anthropic",
               "available":false,"unavailableReason":"missing-auth","contextWindow":200000}
            ]}
            """#.utf8))
        }
        if ProcessInfo.processInfo.arguments.contains("--openclaw-selected-model-auth-failure-fixture") {
            return try OpenClawChatGatewayPayloadCodec.decodeModelChoices(Data(#"""
            {"models":[
              {"id":"gpt-5.6-sol","name":"GPT-5.6 Sol","provider":"openai",
               "available":false,"unavailableReason":"auth-failed","contextWindow":128000},
              {"id":"claude-opus-4-1","name":"Claude Opus 4.1","provider":"anthropic",
               "available":true,"contextWindow":200000}
            ]}
            """#.utf8))
        }
        return [
            OpenClawChatModelChoice(
                modelID: self.fixture.modelID,
                name: self.fixture.modelName,
                provider: self.fixture.modelProvider,
                contextWindow: 128_000),
        ] + self.fixture.additionalModels
    }

    func loadModelCatalog(
        sessionKey _: String,
        agentID: String?) async throws -> OpenClawChatModelCatalogSnapshot
    {
        let choices = try await self.listModels(agentID: agentID)
        return OpenClawChatModelCatalogSnapshot(
            choices: choices,
            availabilityIsSessionScoped: true)
    }

    func isSwarmEnabled(sessionKey _: String) async throws -> Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-swarm-chat-fixture")
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

    func abortRun(sessionKey: String, runId: String) async throws {
        await self.store.abortRun(sessionKey: sessionKey, runId: runId)
    }

    func listSessions(
        limit _: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        let response = try await store.sessions()
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

    func listAgents() async throws -> OpenClawChatAgentsListResponse? {
        OpenClawChatAgentsListResponse(
            defaultId: self.fixture.defaultAgentID,
            agents: self.fixture.agents.map {
                OpenClawChatAgentChoice(
                    id: $0.id,
                    name: $0.name,
                    workspaceGit: $0.workspacegit)
            })
    }

    func listChildSessions(parentKey: String) async throws -> [OpenClawChatSessionEntry] {
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-swarm-chat-fixture") else { return [] }
        let groupID = "swarm:\(parentKey):research"
        return [
            self.swarmChild("polling", "National polling", status: "done", groupID: groupID, parentKey: parentKey),
            self.swarmChild("work", "Work and labor", status: "running", groupID: groupID, parentKey: parentKey),
            self.swarmChild("health", "Health", status: "running", groupID: groupID, parentKey: parentKey),
            self.swarmChild(
                "trust",
                "Governance and trust",
                status: nil,
                groupID: groupID,
                parentKey: parentKey,
                queued: true),
            self.swarmChild("media", "Media signals", status: "failed", groupID: groupID, parentKey: parentKey),
        ]
    }

    private func swarmChild(
        _ key: String,
        _ label: String,
        status: String?,
        groupID: String,
        parentKey: String,
        queued: Bool = false) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: "agent:main:subagent:\(key)",
            kind: "direct",
            displayName: label,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: 1,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: self.fixture.modelProvider,
            model: self.fixture.modelID,
            contextTokens: 128_000,
            parentSessionKey: parentKey,
            spawnedBy: parentKey,
            status: status,
            hasActiveRun: status == "running",
            subagentRunState: queued ? "active" : nil,
            swarmGroupId: groupID,
            swarmPhase: "Research",
            swarmPhaseRank: 0,
            swarmLog: "Comparing labor, education, health, trust, and media signals.")
    }

    func setSessionModel(sessionKey: String, model: String?) async throws {
        _ = try await self.store.patchSessionSettings(
            sessionKey: sessionKey,
            patch: OpenClawChatSessionSettingsPatch(model: .some(model)))
    }

    func setSessionThinking(sessionKey: String, thinkingLevel: String) async throws {
        _ = try await self.store.patchSessionSettings(
            sessionKey: sessionKey,
            patch: OpenClawChatSessionSettingsPatch(thinkingLevel: .some(thinkingLevel)))
    }

    func patchSessionSettings(
        sessionKey: String,
        agentID _: String?,
        patch: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?
    {
        try await self.store.patchSessionSettings(sessionKey: sessionKey, patch: patch)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    /// The held screenshot run resolves only when the real composer aborts it.
    func waitForRunCompletion(runId: String, timeoutMs _: Int) async -> OpenClawChatRunObservation {
        await self.store.runObservation(runId: runId)
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            continuation.yield(.health(ok: true))
            self.registerFixtureEventContinuation(continuation)
        }
    }

    func setActiveSessionKey(_: String) async throws {}

    func resetSession(sessionKey _: String) async throws {
        await self.store.reset()
    }

    func compactSession(sessionKey _: String) async throws {}

    private static func newSessionOptionsError(_ description: String) -> NSError {
        NSError(
            domain: "LocalFixtureChatTransport",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: description])
    }
}

private actor LocalFixtureChatStore {
    private let fixture: LocalChatFixture
    private var messages: [OpenClawChatMessage]
    private var modelID: String
    private var thinkingLevel = "auto"
    private var fastMode: OpenClawChatFastMode?
    private var verboseLevel: String?
    private var permissionMode: OpenClawChatPermissionMode? = .guarded
    private var toolOverrides: OpenClawChatSessionToolOverrides?

    init(fixture: LocalChatFixture) {
        self.fixture = fixture
        self.messages = Self.seedMessages(fixture: fixture)
        self.modelID = fixture.modelID
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
                thinkingLevel: self.thinkingLevel,
                sessionInfo: OpenClawChatSessionInfo(
                    hasActiveRun: self.activeRunID != nil,
                    activeRunIds: self.activeRunID.map { [$0] })),
            as: OpenClawChatHistoryPayload.self)
    }

    func sendMessage(
        sessionKey _: String,
        message: String,
        runId: String) throws -> OpenClawChatSendResponse
    {
        let now = Date().timeIntervalSince1970 * 1000
        self.messages.append(
            Self.message(
                role: "user",
                text: message,
                timestamp: now,
                idempotencyKey: "\(runId):user"))
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let subject = trimmed.isEmpty ? "that request" : "\"\(trimmed)\""
        if ScreenshotFixtureMode.holdsInitialChatRun,
           self.fixture.sessionIDPrefix == "screenshot-fixture",
           !self.heldInitialRun
        {
            self.heldInitialRun = true
            self.activeRunID = runId
            return try Self.decode(
                SendPayload(runId: runId, status: "started"),
                as: OpenClawChatSendResponse.self)
        }
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

    private var heldInitialRun = false
    private var activeRunID: String?
    private var eventContinuation: AsyncStream<OpenClawChatTransportEvent>.Continuation?

    func setEventContinuation(_ continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation) {
        self.eventContinuation = continuation
    }

    func runObservation(runId: String) -> OpenClawChatRunObservation {
        self.activeRunID == runId ? .checkAgain : .terminal(.completed)
    }

    func abortRun(sessionKey: String, runId: String) {
        guard self.activeRunID == runId else { return }
        self.activeRunID = nil
        self.eventContinuation?.yield(.chat(OpenClawChatEventPayload(
            runId: runId,
            sessionKey: sessionKey,
            state: "aborted",
            message: nil,
            errorMessage: nil)))
    }

    func sessions() throws -> OpenClawChatSessionsListResponse {
        let entry = OpenClawChatSessionEntry(
            key: fixture.sessionKey,
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
            thinkingLevel: self.thinkingLevel,
            verboseLevel: self.verboseLevel,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: 24000,
            totalTokensFresh: true,
            modelProvider: self.fixture.modelProvider,
            model: self.modelID,
            contextTokens: 128_000,
            thinkingLevels: Self.thinkingLevels,
            thinkingOptions: Self.thinkingOptions,
            thinkingDefault: "auto",
            fastMode: self.fastMode,
            effectiveFastMode: self.fastMode,
            permissionMode: self.permissionMode,
            toolOverrides: self.toolOverrides)
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
                mainSessionKey: self.fixture.sessionKey,
                modelSelectionTarget: self.fixtureModelSelectionTarget),
            sessions: [entry])
    }

    private var fixtureModelSelectionTarget: String {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--openclaw-model-selection-target"),
              arguments.indices.contains(index + 1)
        else {
            return self.fixture.modelSelectionTarget
        }
        switch arguments[index + 1] {
        case "session", "agent", "global": return arguments[index + 1]
        default: return self.fixture.modelSelectionTarget
        }
    }

    func reset() {
        self.messages = Self.seedMessages(fixture: self.fixture)
        self.modelID = self.fixture.modelID
        self.thinkingLevel = "auto"
        self.fastMode = nil
        self.verboseLevel = nil
        self.permissionMode = .guarded
        self.toolOverrides = nil
    }

    func patchSessionSettings(
        sessionKey: String,
        patch: OpenClawChatSessionSettingsPatch) throws -> OpenClawChatModelPatchResult
    {
        let key = Self.normalizedSessionKey(sessionKey, fallback: self.fixture.sessionKey)
        let sessionID = "\(self.fixture.sessionIDPrefix)-\(key)"
        if let expectedSessionID = patch.expectedSessionID, expectedSessionID != sessionID {
            throw NSError(
                domain: "LocalFixtureChatTransport",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "The fixture session changed before the update."])
        }
        if let model = patch.model {
            self.modelID = model ?? self.fixture.modelID
        }
        if let thinkingLevel = patch.thinkingLevel {
            self.thinkingLevel = thinkingLevel ?? "auto"
        }
        if let fastMode = patch.fastMode {
            self.fastMode = fastMode
        }
        if let verboseLevel = patch.verboseLevel {
            self.verboseLevel = verboseLevel
        }
        if let permissionMode = patch.permissionMode {
            self.permissionMode = permissionMode
        }
        if let toolOverrides = patch.toolOverrides {
            self.toolOverrides = toolOverrides
        }
        return OpenClawChatModelPatchResult(
            key: key,
            modelProvider: self.fixture.modelProvider,
            model: self.modelID,
            thinkingLevel: self.thinkingLevel,
            thinkingLevels: Self.thinkingLevels,
            fastMode: self.fastMode,
            effectiveFastMode: self.fastMode,
            verboseLevel: self.verboseLevel,
            permissionMode: self.permissionMode,
            toolOverrides: self.toolOverrides)
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
        idempotencyKey: String? = nil,
        details: AnyCodable? = nil) -> OpenClawChatMessage
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
            stopReason: role == "assistant" ? "stop" : nil,
            details: details)
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
        var sessionInfo: OpenClawChatSessionInfo?
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

extension ScreenshotFixtureMode {
    static var holdsInitialChatRun: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-hold-initial-chat-run")
    }
}

extension LocalFixtureChatTransport {
    private func registerFixtureEventContinuation(
        _ continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation)
    {
        guard ScreenshotFixtureMode.holdsInitialChatRun else {
            continuation.finish()
            return
        }
        Task {
            await self.store.setEventContinuation(continuation)
        }
    }
}
