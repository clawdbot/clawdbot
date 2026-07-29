import Foundation
import OpenClawProtocol

public enum OpenClawChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case sessionsChanged(OpenClawChatSessionsChangedEvent)
    case sessionObserver(SessionObserverDigest)
    case chat(OpenClawChatEventPayload)
    case sessionMessage(OpenClawSessionMessageEventPayload)
    case agent(OpenClawAgentEventPayload)
    case questionRequested(QuestionRecord)
    case questionResolved(OpenClawQuestionResolvedEvent)
    case routeChanged
    case seqGap
}

public struct OpenClawQuestionResolvedEvent: Codable, Sendable {
    public let id: String
    public let status: QuestionStatus
    public let answers: QuestionAnswers?

    // periphery:ignore - Package consumers construct transport events; native apps decode them.
    public init(id: String, status: QuestionStatus, answers: QuestionAnswers? = nil) {
        self.id = id
        self.status = status
        self.answers = answers
    }
}

public struct OpenClawChatSessionsChangedEvent: Codable, Sendable, Equatable {
    public let sessionKey: String?
    public let agentId: String?
    public let parentSessionKey: String?
    public let spawnedBy: String?
    public let reason: String
    public let phase: String?
    public let runId: String?
    public let session: OpenClawChatSessionEntry?
    public let updatedAt: Double?
    public let lastReadAt: Double?
    public let agentStatus: OpenClawChatSessionAgentStatus?
    public let observerDigest: OpenClawChatSessionObserverDigest?
    public let status: String?
    public let lastRunError: String?
    public let hasActiveRun: Bool?
    public let activeRunIds: [String]?
    public let startedAt: Double?
    public let endedAt: Double?
    public let swarmGroupId: String?
    public let kind: String?
    public let text: String?
    public let swarmPhase: String?
    let agentStatusPresent: Bool
    let observerDigestPresent: Bool
    let statusPresent: Bool
    let lastRunErrorPresent: Bool

    public init(
        sessionKey: String?,
        agentId: String? = nil,
        parentSessionKey: String? = nil,
        spawnedBy: String? = nil,
        reason: String = "",
        phase: String? = nil,
        runId: String? = nil,
        session: OpenClawChatSessionEntry? = nil,
        updatedAt: Double? = nil,
        lastReadAt: Double? = nil,
        agentStatus: OpenClawChatSessionAgentStatus? = nil,
        observerDigest: OpenClawChatSessionObserverDigest? = nil,
        status: String? = nil,
        lastRunError: String? = nil,
        hasActiveRun: Bool? = nil,
        activeRunIds: [String]? = nil,
        startedAt: Double? = nil,
        endedAt: Double? = nil,
        swarmGroupId: String? = nil,
        kind: String? = nil,
        text: String? = nil,
        swarmPhase: String? = nil,
        agentStatusPresent: Bool? = nil,
        observerDigestPresent: Bool? = nil,
        statusPresent: Bool? = nil,
        lastRunErrorPresent: Bool? = nil)
    {
        self.sessionKey = sessionKey
        self.agentId = agentId
        self.parentSessionKey = parentSessionKey
        self.spawnedBy = spawnedBy
        self.reason = reason
        self.phase = phase
        self.runId = runId
        self.session = session
        self.updatedAt = updatedAt
        self.lastReadAt = lastReadAt
        self.agentStatus = agentStatus
        self.observerDigest = observerDigest
        self.status = status
        self.lastRunError = lastRunError
        self.hasActiveRun = hasActiveRun
        self.activeRunIds = activeRunIds
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.swarmGroupId = swarmGroupId
        self.kind = kind
        self.text = text
        self.swarmPhase = swarmPhase
        self.agentStatusPresent = agentStatusPresent ?? (agentStatus != nil)
        self.observerDigestPresent = observerDigestPresent ?? (observerDigest != nil)
        self.statusPresent = statusPresent ?? (status != nil)
        self.lastRunErrorPresent = lastRunErrorPresent ?? (lastRunError != nil)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.session = try container.decodeIfPresent(OpenClawChatSessionEntry.self, forKey: .session)
        let nested = try? container.nestedContainer(keyedBy: CodingKeys.self, forKey: .session)

        func decode<T: Decodable>(_ type: T.Type, forKey key: CodingKeys) throws -> T? {
            if container.contains(key) {
                return try container.decodeIfPresent(type, forKey: key)
            }
            return try nested?.decodeIfPresent(type, forKey: key)
        }

        if container.contains(.sessionKey) {
            self.sessionKey = try container.decodeIfPresent(String.self, forKey: .sessionKey)
        } else if container.contains(.key) {
            self.sessionKey = try container.decodeIfPresent(String.self, forKey: .key)
        } else if nested?.contains(.sessionKey) == true {
            self.sessionKey = try nested?.decodeIfPresent(String.self, forKey: .sessionKey)
        } else {
            self.sessionKey = try nested?.decodeIfPresent(String.self, forKey: .key)
        }
        self.agentId = try decode(String.self, forKey: .agentId)
        self.parentSessionKey = try decode(String.self, forKey: .parentSessionKey)
        self.spawnedBy = try decode(String.self, forKey: .spawnedBy)
        self.reason = try decode(String.self, forKey: .reason) ?? ""
        self.phase = try decode(String.self, forKey: .phase)
        self.runId = try decode(String.self, forKey: .runId)
        self.updatedAt = try decode(Double.self, forKey: .updatedAt)
        self.lastReadAt = try decode(Double.self, forKey: .lastReadAt)
        self.agentStatus = try decode(OpenClawChatSessionAgentStatus.self, forKey: .agentStatus)
        self.observerDigest = try decode(OpenClawChatSessionObserverDigest.self, forKey: .observerDigest)
        self.status = try decode(String.self, forKey: .status)
        self.lastRunError = try decode(String.self, forKey: .lastRunError)
        self.hasActiveRun = try decode(Bool.self, forKey: .hasActiveRun)
        self.activeRunIds = try decode([String].self, forKey: .activeRunIds)
        self.startedAt = try decode(Double.self, forKey: .startedAt)
        self.endedAt = try decode(Double.self, forKey: .endedAt)
        self.swarmGroupId = try decode(String.self, forKey: .swarmGroupId)
        self.kind = try decode(String.self, forKey: .kind)
        self.text = try decode(String.self, forKey: .text)
        self.swarmPhase = try decode(String.self, forKey: .swarmPhase)
        self.agentStatusPresent = container.contains(.agentStatus) || nested?.contains(.agentStatus) == true
        self.observerDigestPresent = container.contains(.observerDigest) || nested?.contains(.observerDigest) == true
        self.statusPresent = container.contains(.status) || nested?.contains(.status) == true
        self.lastRunErrorPresent = container.contains(.lastRunError) || nested?.contains(.lastRunError) == true
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(self.sessionKey, forKey: .sessionKey)
        try container.encodeIfPresent(self.agentId, forKey: .agentId)
        try container.encodeIfPresent(self.parentSessionKey, forKey: .parentSessionKey)
        try container.encodeIfPresent(self.spawnedBy, forKey: .spawnedBy)
        try container.encodeIfPresent(self.reason, forKey: .reason)
        try container.encodeIfPresent(self.phase, forKey: .phase)
        try container.encodeIfPresent(self.runId, forKey: .runId)
        try container.encodeIfPresent(self.session, forKey: .session)
        try container.encodeIfPresent(self.updatedAt, forKey: .updatedAt)
        try container.encodeIfPresent(self.lastReadAt, forKey: .lastReadAt)
        try container.encodeIfPresent(self.agentStatus, forKey: .agentStatus)
        try container.encodeIfPresent(self.observerDigest, forKey: .observerDigest)
        try container.encodeIfPresent(self.status, forKey: .status)
        try container.encodeIfPresent(self.lastRunError, forKey: .lastRunError)
        try container.encodeIfPresent(self.hasActiveRun, forKey: .hasActiveRun)
        try container.encodeIfPresent(self.activeRunIds, forKey: .activeRunIds)
        try container.encodeIfPresent(self.startedAt, forKey: .startedAt)
        try container.encodeIfPresent(self.endedAt, forKey: .endedAt)
        try container.encodeIfPresent(self.swarmGroupId, forKey: .swarmGroupId)
        try container.encodeIfPresent(self.kind, forKey: .kind)
        try container.encodeIfPresent(self.text, forKey: .text)
        try container.encodeIfPresent(self.swarmPhase, forKey: .swarmPhase)
    }

    private enum CodingKeys: String, CodingKey {
        case session
        case key
        case sessionKey
        case agentId
        case parentSessionKey
        case spawnedBy
        case reason
        case phase
        case runId
        case updatedAt
        case lastReadAt
        case agentStatus
        case observerDigest
        case status
        case lastRunError
        case hasActiveRun
        case activeRunIds
        case startedAt
        case endedAt
        case swarmGroupId
        case kind
        case text
        case swarmPhase
    }
}

/// One immutable transport route used by an entire outbox flush. Route-aware
/// transports bind both sends and confirmation reads to the same connection;
/// a gateway switch then cancels the old work instead of retargeting it.
public struct OpenClawChatTransportRouteLease: Sendable {
    public typealias SendMessage = @Sendable (
        _ sessionKey: String,
        _ message: String,
        _ thinking: String,
        _ idempotencyKey: String,
        _ attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    public typealias RequestHistory = @Sendable (String) async throws -> OpenClawChatHistoryPayload
    public typealias SendTargetedMessage = @Sendable (
        _ sessionKey: String,
        _ agentID: String?,
        _ message: String,
        _ thinking: String,
        _ idempotencyKey: String,
        _ attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    public typealias RequestTargetedHistory = @Sendable (
        _ sessionKey: String,
        _ agentID: String?) async throws -> OpenClawChatHistoryPayload

    private let sendTargetedMessageImpl: SendTargetedMessage
    private let requestTargetedHistoryImpl: RequestTargetedHistory
    public let sessionRoutingContract: String?

    public init(
        sendMessage: @escaping SendMessage,
        requestHistory: @escaping RequestHistory,
        sessionRoutingContract: String? = nil)
    {
        self.sessionRoutingContract = sessionRoutingContract
        self.sendTargetedMessageImpl = { sessionKey, _, message, thinking, idempotencyKey, attachments in
            try await sendMessage(sessionKey, message, thinking, idempotencyKey, attachments)
        }
        self.requestTargetedHistoryImpl = { sessionKey, _ in
            try await requestHistory(sessionKey)
        }
    }

    public init(
        sendTargetedMessage: @escaping SendTargetedMessage,
        requestTargetedHistory: @escaping RequestTargetedHistory,
        sessionRoutingContract: String? = nil)
    {
        self.sessionRoutingContract = sessionRoutingContract
        self.sendTargetedMessageImpl = sendTargetedMessage
        self.requestTargetedHistoryImpl = requestTargetedHistory
    }

    public func sendMessage(
        sessionKey: String,
        agentID: String? = nil,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try await self.sendTargetedMessageImpl(
            sessionKey,
            agentID,
            message,
            thinking,
            idempotencyKey,
            attachments)
    }

    public func requestHistory(
        sessionKey: String,
        agentID: String? = nil) async throws -> OpenClawChatHistoryPayload
    {
        try await self.requestTargetedHistoryImpl(sessionKey, agentID)
    }
}

public enum OpenClawChatTransportRouteLeaseResult: Sendable {
    case available(OpenClawChatTransportRouteLease)
    case unavailable(reason: String?)
}

/// One physical gateway connection captured before a settings mutation waits
/// behind earlier mutations for the same session.
public struct OpenClawChatSessionSettingsRouteLease: Sendable {
    public typealias PatchSessionSettings = @Sendable (
        _ sessionKey: String,
        _ agentID: String?,
        _ patch: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?

    private let patchSessionSettingsImpl: PatchSessionSettings

    public init(patchSessionSettings: @escaping PatchSessionSettings) {
        self.patchSessionSettingsImpl = patchSessionSettings
    }

    public func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?
    {
        try await self.patchSessionSettingsImpl(sessionKey, agentID, patch)
    }
}

/// One physical gateway connection captured before a session mutation waits
/// behind an earlier mutation for the same session.
public struct OpenClawChatSessionMutationRouteLease: Sendable {
    public typealias PatchSession = @Sendable (
        _ key: String,
        _ label: String??,
        _ category: String??,
        _ pinned: Bool?,
        _ archived: Bool?,
        _ unread: Bool?) async throws -> Void
    public typealias DeleteSession = @Sendable (_ key: String) async throws -> Void

    private let patchSessionImpl: PatchSession
    private let deleteSessionImpl: DeleteSession?

    public init(
        patchSession: @escaping PatchSession,
        deleteSession: DeleteSession? = nil)
    {
        self.patchSessionImpl = patchSession
        self.deleteSessionImpl = deleteSession
    }

    public func patchSession(
        key: String,
        label: String??,
        category: String??,
        pinned: Bool?,
        archived: Bool?,
        unread: Bool?) async throws
    {
        try await self.patchSessionImpl(key, label, category, pinned, archived, unread)
    }

    public func deleteSession(key: String) async throws {
        guard let deleteSessionImpl else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        try await deleteSessionImpl(key)
    }
}

/// One physical gateway connection captured while a group catalog is shown.
/// Group replacement submits the complete catalog, so list and mutations must
/// never retarget independently when the selected gateway changes.
public struct OpenClawChatSessionGroupsRouteLease: Sendable {
    public typealias ListGroups = @Sendable () async throws -> OpenClawChatSessionGroupsResponse?
    public typealias PutGroups = @Sendable ([String]) async throws -> OpenClawChatSessionGroupsMutationResponse
    public typealias RenameGroup = @Sendable (String, String) async throws -> OpenClawChatSessionGroupsMutationResponse
    public typealias DeleteGroup = @Sendable (String) async throws -> OpenClawChatSessionGroupsMutationResponse

    private let listGroupsImpl: ListGroups
    private let putGroupsImpl: PutGroups
    private let renameGroupImpl: RenameGroup
    private let deleteGroupImpl: DeleteGroup

    public init(
        listGroups: @escaping ListGroups,
        putGroups: @escaping PutGroups,
        renameGroup: @escaping RenameGroup,
        deleteGroup: @escaping DeleteGroup)
    {
        self.listGroupsImpl = listGroups
        self.putGroupsImpl = putGroups
        self.renameGroupImpl = renameGroup
        self.deleteGroupImpl = deleteGroup
    }

    public func listGroups() async throws -> OpenClawChatSessionGroupsResponse? {
        try await self.listGroupsImpl()
    }

    public func putGroups(names: [String]) async throws -> OpenClawChatSessionGroupsMutationResponse {
        try await self.putGroupsImpl(names)
    }

    public func renameGroup(name: String, to: String) async throws -> OpenClawChatSessionGroupsMutationResponse {
        try await self.renameGroupImpl(name, to)
    }

    public func deleteGroup(name: String) async throws -> OpenClawChatSessionGroupsMutationResponse {
        try await self.deleteGroupImpl(name)
    }
}

/// One physical gateway connection captured while new-session options are
/// shown. Agent capabilities and the resulting create request share the route.
public struct OpenClawChatNewSessionRouteLease: Sendable {
    public typealias ListAgents = @Sendable () async throws -> OpenClawChatAgentsListResponse?
    public typealias CreateSession = @Sendable (
        _ key: String,
        _ label: String?,
        _ agentID: String?,
        _ parentSessionKey: String?,
        _ worktree: Bool?,
        _ worktreeBaseRef: String?) async throws -> OpenClawChatCreateSessionResponse

    private let listAgentsImpl: ListAgents
    private let createSessionImpl: CreateSession

    public init(
        listAgents: @escaping ListAgents,
        createSession: @escaping CreateSession)
    {
        self.listAgentsImpl = listAgents
        self.createSessionImpl = createSession
    }

    public func listAgents() async throws -> OpenClawChatAgentsListResponse? {
        try await self.listAgentsImpl()
    }

    public func createSession(
        key: String,
        label: String?,
        agentID: String?,
        parentSessionKey: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) async throws -> OpenClawChatCreateSessionResponse
    {
        try await self.createSessionImpl(
            key,
            label,
            agentID,
            parentSessionKey,
            worktree,
            worktreeBaseRef)
    }
}

/// The transport rejected a send before it reached its request channel. This
/// is the only failure class safe for automatic outbox retry.
public enum OpenClawChatTransportSendError: Error, Sendable {
    case notDispatched
}

public enum OpenClawChatTransportUpgradeMessage {
    public static let routingContract =
        "Update the gateway before sending queued messages. This version requires safe delivery routing."
}

public enum OpenClawChatRunTerminalState: Sendable, Equatable {
    case completed
    case failed(message: String)
}

public enum OpenClawChatRunObservation: Sendable, Equatable {
    case terminal(OpenClawChatRunTerminalState)
    case checkAgain
    case unavailable

    public static func fromWaitResponse(
        status: String?,
        endedAt: Double? = nil,
        error: String? = nil,
        stopReason: String? = nil,
        livenessState: String? = nil,
        yielded: Bool? = nil,
        pendingError: Bool? = nil,
        timeoutPhase: String? = nil,
        providerStarted: Bool? = nil,
        aborted: Bool? = nil) -> Self
    {
        let status = Self.normalized(status)
        if status == "pending" {
            return .checkAgain
        }
        if ["ok", "completed", "success", "succeeded"].contains(status) {
            return .terminal(.completed)
        }
        if [
            "error", "failed", "aborted", "cancelled", "canceled", "killed", "timed_out",
        ].contains(status) {
            return .terminal(.failed(message: Self.failureMessage(
                status: status,
                error: error,
                stopReason: stopReason,
                aborted: aborted)))
        }
        guard status == "timeout" else { return .unavailable }
        guard pendingError != true else { return .checkAgain }

        let timeoutPhase = Self.normalized(timeoutPhase)
        let stopReason = Self.normalized(stopReason)
        let terminalTimeout = ["preflight", "provider", "post_turn"].contains(timeoutPhase) ||
            ["timeout", "timed_out"].contains(stopReason) ||
            endedAt != nil ||
            !Self.normalized(error).isEmpty ||
            !stopReason.isEmpty ||
            !Self.normalized(livenessState).isEmpty ||
            yielded == true ||
            aborted == true ||
            (providerStarted == true && timeoutPhase != "queue" && timeoutPhase != "gateway_draining")
        return terminalTimeout
            ? .terminal(.failed(message: Self.failureMessage(
                status: status,
                error: error,
                stopReason: stopReason,
                aborted: aborted)))
            : .checkAgain
    }

    private static func normalized(_ value: String?) -> String {
        (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func failureMessage(
        status: String,
        error: String?,
        stopReason: String?,
        aborted: Bool?) -> String
    {
        if let error = error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
            return error
        }
        let stopReason = Self.normalized(stopReason)
        if aborted == true || status == "aborted" || stopReason == "aborted" {
            return "Run aborted"
        }
        if ["cancelled", "canceled", "killed"].contains(status) ||
            ["cancelled", "canceled", "killed", "restart", "rpc", "stop", "user"].contains(stopReason)
        {
            return "Run cancelled"
        }
        if status == "timeout" || status == "timed_out" ||
            stopReason == "timeout" || stopReason == "timed_out"
        {
            return "Run timed out"
        }
        return "Chat failed"
    }
}

public struct OpenClawChatMetadataCapabilities: Codable, Sendable, Equatable {
    public let swarmEnabled: Bool

    private enum CodingKeys: String, CodingKey {
        case swarmEnabled
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.swarmEnabled = if container.contains(.swarmEnabled) {
            try container.decode(Bool.self, forKey: .swarmEnabled)
        } else {
            false
        }
    }
}

public struct OpenClawChatLoadedImage: Sendable {
    public let data: Data
    public let mimeType: String

    public init(data: Data, mimeType: String) {
        self.data = data
        self.mimeType = mimeType
    }
}

/// One physical Gateway route for Swarm capability discovery and child paging.
/// All pages use the captured route so a reconnect cannot combine two servers.
public struct OpenClawChatSwarmRouteLease: Sendable {
    public typealias IsEnabled = @Sendable (_ sessionKey: String) async throws -> Bool
    public typealias ListChildSessions = @Sendable (_ parentKey: String) async throws -> [OpenClawChatSessionEntry]

    private let isEnabledImpl: IsEnabled
    private let listChildSessionsImpl: ListChildSessions

    public init(
        isEnabled: @escaping IsEnabled,
        listChildSessions: @escaping ListChildSessions)
    {
        self.isEnabledImpl = isEnabled
        self.listChildSessionsImpl = listChildSessions
    }

    public func isEnabled(sessionKey: String) async throws -> Bool {
        try await self.isEnabledImpl(sessionKey)
    }

    public func listChildSessions(parentKey: String) async throws -> [OpenClawChatSessionEntry] {
        try await self.listChildSessionsImpl(parentKey)
    }
}

public protocol OpenClawChatTransport: Sendable {
    func createSession(
        key: String,
        label: String?,
        parentSessionKey: String?,
        worktree: Bool?) async throws -> OpenClawChatCreateSessionResponse
    func createSession(
        key: String,
        label: String?,
        agentID: String?,
        parentSessionKey: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) async throws -> OpenClawChatCreateSessionResponse

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload
    func requestFullMessage(sessionKey: String, messageID: String) async throws -> OpenClawChatMessage?
    func listModels() async throws -> [OpenClawChatModelChoice]
    func isSwarmEnabled(sessionKey: String) async throws -> Bool
    var supportsSlashCommandCatalog: Bool { get }
    func listCommands(sessionKey: String) async throws -> [OpenClawChatCommandChoice]
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    func sendMessage(
        sessionKey: String,
        agentID: String?,
        expectedSessionRoutingContract: String?,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse

    /// Captures the current route for a durable outbox flush. Implementations
    /// backed by a mutable gateway must override this with route-checked calls.
    func acquireOutboxRouteLease() async -> OpenClawChatTransportRouteLeaseResult
    var outboxRequiresSessionRoutingContract: Bool { get }

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(
        limit: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    func listChildSessions(parentKey: String) async throws -> [OpenClawChatSessionEntry]
    func acquireSwarmRouteLease() async -> OpenClawChatSwarmRouteLease?
    func listAgents() async throws -> OpenClawChatAgentsListResponse?
    func acquireNewSessionRouteLease() async -> OpenClawChatNewSessionRouteLease?
    func listSessionGroups() async throws -> OpenClawChatSessionGroupsResponse?
    func putSessionGroups(names: [String]) async throws -> OpenClawChatSessionGroupsMutationResponse
    func renameSessionGroup(name: String, to: String) async throws -> OpenClawChatSessionGroupsMutationResponse
    func deleteSessionGroup(name: String) async throws -> OpenClawChatSessionGroupsMutationResponse
    func acquireSessionGroupsRouteLease() async -> OpenClawChatSessionGroupsRouteLease?
    func patchSession(
        key: String,
        label: String??,
        category: String??,
        pinned: Bool?,
        archived: Bool?,
        unread: Bool?) async throws
    func acquireSessionMutationRouteLease() async -> OpenClawChatSessionMutationRouteLease?
    func deleteSession(key: String) async throws
    func forkSession(parentKey: String) async throws -> String
    func rewindSession(sessionKey: String, entryId: String) async throws -> OpenClawChatRewindResponse
    func forkSessionAtMessage(
        sessionKey: String,
        entryId: String) async throws -> OpenClawChatForkAtMessageResponse
    func listSessionBranches(
        sessionKey: String,
        agentID: String?) async throws -> OpenClawChatSessionBranchesResponse
    func switchSessionBranch(sessionKey: String, agentID: String?, leafEntryId: String) async throws
    func setSessionModel(sessionKey: String, model: String?) async throws
    func patchSessionModel(
        sessionKey: String,
        agentID: String?,
        model: String?) async throws -> OpenClawChatModelPatchResult?
    func setSessionThinking(sessionKey: String, thinkingLevel: String) async throws
    func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?
    /// Mutable gateway transports must capture the physical connection here;
    /// queued settings work must never resolve its route after waiting.
    func acquireSessionSettingsRouteLease() async -> OpenClawChatSessionSettingsRouteLease?

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func listQuestions() async throws -> [QuestionRecord]
    func getQuestion(id: String) async throws -> QuestionRecord
    func resolveQuestion(id: String, answers: [String: [String]]) async throws
    func cancelQuestion(id: String) async throws
    func waitForRunCompletion(runId: String, timeoutMs: Int) async -> OpenClawChatRunObservation
    func events() -> AsyncStream<OpenClawChatTransportEvent>
    func resolveInlineWidgetResource(
        path: String,
        replacing failedResource: OpenClawChatWidgetResource?) async -> OpenClawChatWidgetResource?
    func resolveInlineWidgetURL(path: String, replacing failedURL: URL?) async -> URL?
    func loadImageArtifact(sessionKey: String, artifactId: String) async throws -> OpenClawChatLoadedImage?

    func setActiveSessionKey(_ sessionKey: String) async throws
    func resetSession(sessionKey: String) async throws
    func compactSession(sessionKey: String) async throws
}

extension OpenClawChatTransport {
    public func loadImageArtifact(
        sessionKey _: String,
        artifactId _: String) async throws -> OpenClawChatLoadedImage?
    {
        nil
    }

    public func isSwarmEnabled(sessionKey _: String) async throws -> Bool {
        false
    }

    public func acquireSwarmRouteLease() async -> OpenClawChatSwarmRouteLease? {
        let transport = self
        return OpenClawChatSwarmRouteLease(
            isEnabled: { try await transport.isSwarmEnabled(sessionKey: $0) },
            listChildSessions: { try await transport.listChildSessions(parentKey: $0) })
    }

    public func listQuestions() async throws -> [QuestionRecord] {
        []
    }

    public func getQuestion(id _: String) async throws -> QuestionRecord {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "question.get not supported by this transport"])
    }

    public func resolveQuestion(id _: String, answers _: [String: [String]]) async throws {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "question.resolve not supported by this transport"])
    }

    public func cancelQuestion(id _: String) async throws {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "question.resolve cancellation not supported by this transport"])
    }

    public func requestFullMessage(sessionKey _: String, messageID _: String) async throws -> OpenClawChatMessage? {
        nil
    }

    public func resolveInlineWidgetResource(
        path: String,
        replacing failedResource: OpenClawChatWidgetResource?) async -> OpenClawChatWidgetResource?
    {
        guard let url = await resolveInlineWidgetURL(path: path, replacing: failedResource?.url) else { return nil }
        return OpenClawChatWidgetResource(url: url)
    }

    public func resolveInlineWidgetURL(path _: String, replacing _: URL?) async -> URL? {
        nil
    }

    public var outboxRequiresSessionRoutingContract: Bool {
        false
    }

    public func acquireOutboxRouteLease() async -> OpenClawChatTransportRouteLeaseResult {
        let transport = self
        return .available(OpenClawChatTransportRouteLease(
            sendMessage: { sessionKey, message, thinking, idempotencyKey, attachments in
                try await transport.sendMessage(
                    sessionKey: sessionKey,
                    message: message,
                    thinking: thinking,
                    idempotencyKey: idempotencyKey,
                    attachments: attachments)
            },
            requestHistory: { sessionKey in
                try await transport.requestHistory(sessionKey: sessionKey)
            }))
    }

    public func acquireSessionSettingsRouteLease() async -> OpenClawChatSessionSettingsRouteLease? {
        let transport = self
        return OpenClawChatSessionSettingsRouteLease { sessionKey, agentID, patch in
            try await transport.patchSessionSettings(
                sessionKey: sessionKey,
                agentID: agentID,
                patch: patch)
        }
    }

    public func acquireSessionMutationRouteLease() async -> OpenClawChatSessionMutationRouteLease? {
        let transport = self
        return OpenClawChatSessionMutationRouteLease(
            patchSession: { key, label, category, pinned, archived, unread in
                try await transport.patchSession(
                    key: key,
                    label: label,
                    category: category,
                    pinned: pinned,
                    archived: archived,
                    unread: unread)
            },
            deleteSession: { key in
                try await transport.deleteSession(key: key)
            })
    }

    public func acquireSessionGroupsRouteLease() async -> OpenClawChatSessionGroupsRouteLease? {
        let transport = self
        return OpenClawChatSessionGroupsRouteLease(
            listGroups: { try await transport.listSessionGroups() },
            putGroups: { try await transport.putSessionGroups(names: $0) },
            renameGroup: { try await transport.renameSessionGroup(name: $0, to: $1) },
            deleteGroup: { try await transport.deleteSessionGroup(name: $0) })
    }

    public func acquireNewSessionRouteLease() async -> OpenClawChatNewSessionRouteLease? {
        let transport = self
        return OpenClawChatNewSessionRouteLease(
            listAgents: { try await transport.listAgents() },
            createSession: { key, label, agentID, parentSessionKey, worktree, worktreeBaseRef in
                try await transport.createSession(
                    key: key,
                    label: label,
                    agentID: agentID,
                    parentSessionKey: parentSessionKey,
                    worktree: worktree,
                    worktreeBaseRef: worktreeBaseRef)
            })
    }

    public func sendMessage(
        sessionKey: String,
        agentID _: String?,
        expectedSessionRoutingContract _: String?,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try await self.sendMessage(
            sessionKey: sessionKey,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
    }

    public func createSession(
        key _: String,
        label _: String?,
        parentSessionKey _: String?,
        worktree _: Bool?) async throws -> OpenClawChatCreateSessionResponse
    {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.create not supported by this transport"])
    }

    public func createSession(
        key: String,
        label: String?,
        agentID: String?,
        parentSessionKey: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) async throws -> OpenClawChatCreateSessionResponse
    {
        // Fail closed: a transport on this default cannot honor agent/base-ref
        // selection; delegating would report success while creating the wrong session.
        guard agentID == nil, worktreeBaseRef == nil else {
            throw NSError(
                domain: "OpenClawChatTransport",
                code: 0,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "sessions.create agent/base-ref options not supported by this transport",
                ])
        }
        return try await self.createSession(
            key: key,
            label: label,
            parentSessionKey: parentSessionKey,
            worktree: worktree)
    }

    public func setActiveSessionKey(_: String) async throws {}

    public func waitForRunCompletion(runId _: String, timeoutMs _: Int) async -> OpenClawChatRunObservation {
        .unavailable
    }

    public func resetSession(sessionKey _: String) async throws {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.reset not supported by this transport"])
    }

    public func compactSession(sessionKey _: String) async throws {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.compact not supported by this transport"])
    }

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(
        limit _: Int?,
        search _: String?,
        archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }

    public func listChildSessions(parentKey _: String) async throws -> [OpenClawChatSessionEntry] {
        []
    }

    /// Conveniences for callers that only page a list. Transports must
    /// implement the canonical `listSessions(limit:search:archived:)`
    /// requirement; same-name methods on a conformer are shadowed by these
    /// sugars and never called through the protocol.
    public func listSessions(limit: Int?) async throws -> OpenClawChatSessionsListResponse {
        try await self.listSessions(limit: limit, search: nil, archived: false)
    }

    public func listSessions(limit: Int?, archived: Bool) async throws -> OpenClawChatSessionsListResponse {
        try await self.listSessions(limit: limit, search: nil, archived: archived)
    }

    public func listAgents() async throws -> OpenClawChatAgentsListResponse? {
        nil
    }

    public func listSessionGroups() async throws -> OpenClawChatSessionGroupsResponse? {
        nil
    }

    public func putSessionGroups(names _: [String]) async throws -> OpenClawChatSessionGroupsMutationResponse {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.groups.put not supported by this transport"])
    }

    public func renameSessionGroup(
        name _: String,
        to _: String) async throws -> OpenClawChatSessionGroupsMutationResponse
    {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.groups.rename not supported by this transport"])
    }

    public func deleteSessionGroup(name _: String) async throws -> OpenClawChatSessionGroupsMutationResponse {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.groups.delete not supported by this transport"])
    }

    public func patchSession(
        key _: String,
        label _: String?? = nil,
        category _: String?? = nil,
        pinned _: Bool? = nil,
        archived _: Bool? = nil,
        unread _: Bool? = nil) async throws
    {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.patch not supported by this transport"])
    }

    public func deleteSession(key _: String) async throws {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.delete not supported by this transport"])
    }

    public func forkSession(parentKey _: String) async throws -> String {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.create fork not supported by this transport"])
    }

    public func rewindSession(
        sessionKey _: String,
        entryId _: String) async throws -> OpenClawChatRewindResponse
    {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.rewind not supported by this transport"])
    }

    public func forkSessionAtMessage(
        sessionKey _: String,
        entryId _: String) async throws -> OpenClawChatForkAtMessageResponse
    {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.fork not supported by this transport"])
    }

    public func listSessionBranches(
        sessionKey _: String,
        agentID _: String?) async throws -> OpenClawChatSessionBranchesResponse
    {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.branches.list not supported by this transport"])
    }

    public func switchSessionBranch(sessionKey _: String, agentID _: String?, leafEntryId _: String) async throws {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.branches.switch not supported by this transport"])
    }

    public func listModels() async throws -> [OpenClawChatModelChoice] {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "models.list not supported by this transport"])
    }

    public var supportsSlashCommandCatalog: Bool {
        false
    }

    public func listCommands(sessionKey _: String) async throws -> [OpenClawChatCommandChoice] {
        []
    }

    public func setSessionModel(sessionKey _: String, model _: String?) async throws {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.patch(model) not supported by this transport"])
    }

    public func patchSessionModel(
        sessionKey: String,
        agentID _: String?,
        model: String?) async throws -> OpenClawChatModelPatchResult?
    {
        try await self.setSessionModel(sessionKey: sessionKey, model: model)
        return nil
    }

    public func setSessionThinking(sessionKey _: String, thinkingLevel _: String) async throws {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.patch(thinkingLevel) not supported by this transport"])
    }

    public func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?
    {
        var result: OpenClawChatModelPatchResult?
        if let model = patch.model {
            result = try await self.patchSessionModel(
                sessionKey: sessionKey,
                agentID: agentID,
                model: model)
        }
        if let thinkingLevelUpdate = patch.thinkingLevel {
            guard let thinkingLevel = thinkingLevelUpdate else {
                throw NSError(
                    domain: "OpenClawChatTransport",
                    code: 0,
                    userInfo: [
                        NSLocalizedDescriptionKey: "sessions.patch(thinkingLevel=null) not supported by this transport",
                    ])
            }
            try await self.setSessionThinking(
                sessionKey: sessionKey,
                thinkingLevel: thinkingLevel)
            result = OpenClawChatModelPatchResult(
                key: result?.key ?? sessionKey,
                modelProvider: result?.modelProvider,
                model: result?.model,
                thinkingLevel: thinkingLevel,
                thinkingLevels: result?.thinkingLevels)
        }
        return result
    }
}

public enum OpenClawChatSessionRoutingContract {
    public static let changedErrorReason = "session-routing-changed"

    public struct Components: Equatable, Sendable {
        public let scope: String
        public let mainKey: String
        public let defaultAgentID: String
    }

    /// Live sends may proceed before routing identity is available. Queued
    /// replay acquires a separate route lease and never uses a nil contract.
    public static func expectedValue(
        _ contract: String?,
        serverSupportsGuard: Bool) -> String?
    {
        guard serverSupportsGuard else { return nil }
        return self.normalize(contract)
    }

    public static func make(
        scope: String?,
        mainKey: String?,
        defaultAgentID: String?) -> String?
    {
        let normalizedScope = self.normalize(scope)
        let normalizedMainKey = self.normalize(mainKey)
        let normalizedDefaultAgentID = self.normalize(defaultAgentID)
        guard let normalizedScope, let normalizedMainKey, let normalizedDefaultAgentID else { return nil }
        return "\(normalizedScope)|\(normalizedMainKey)|\(normalizedDefaultAgentID)"
    }

    /// Scope and agent ids cannot contain `|`; parse from both ends so an
    /// older custom main key containing the delimiter still round-trips.
    public static func parse(_ contract: String?) -> Components? {
        guard let normalized = normalize(contract),
              let firstSeparator = normalized.firstIndex(of: "|"),
              let lastSeparator = normalized.lastIndex(of: "|"),
              firstSeparator != lastSeparator
        else { return nil }
        let scope = String(normalized[..<firstSeparator])
        let mainKey = String(normalized[normalized.index(after: firstSeparator)..<lastSeparator])
        let defaultAgentID = String(normalized[normalized.index(after: lastSeparator)...])
        guard !scope.isEmpty, !mainKey.isEmpty, !defaultAgentID.isEmpty else { return nil }
        return Components(scope: scope, mainKey: mainKey, defaultAgentID: defaultAgentID)
    }

    private static func normalize(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized?.isEmpty == false ? normalized : nil
    }
}
