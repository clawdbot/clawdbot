import Foundation
import OpenClawProtocol

public struct OpenClawChatSessionAgentStatus: Codable, Sendable, Hashable {
    public let note: String
    public let expiresAt: Double
    public let attention: String?
}

public struct OpenClawChatSessionObserverDigest: Codable, Sendable, Hashable {
    public let agentId: String?
    public let runId: String?
    public let revision: Int
    public let updatedAt: Double
    public let headline: String
    public let health: String

    public init(
        agentId: String? = nil,
        runId: String? = nil,
        revision: Int,
        updatedAt: Double,
        headline: String,
        health: String)
    {
        self.agentId = agentId
        self.runId = runId
        self.revision = revision
        self.updatedAt = updatedAt
        self.headline = headline
        self.health = health
    }

    public init(_ digest: SessionObserverDigest) {
        self.init(
            agentId: digest.agentid,
            runId: digest.runid,
            revision: digest.revision,
            updatedAt: Double(digest.updatedat),
            headline: digest.headline,
            health: digest.health.rawValue)
    }
}

public struct OpenClawChatThinkingLevelOption: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

public enum OpenClawChatFastMode: Sendable, Equatable, Hashable, Codable {
    case off
    case on
    case automatic

    public var isEnabled: Bool {
        self != .off
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let enabled = try? container.decode(Bool.self) {
            self = enabled ? .on : .off
            return
        }
        if try container.decode(String.self).lowercased() == "auto" {
            self = .automatic
            return
        }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid fast mode")
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .off:
            try container.encode(false)
        case .on:
            try container.encode(true)
        case .automatic:
            try container.encode("auto")
        }
    }
}

public struct OpenClawChatModelChoice: Identifiable, Codable, Sendable, Hashable {
    public var id: String {
        self.selectionID
    }

    public let modelID: String
    public let name: String
    public let provider: String
    public let contextWindow: Int?
    public let reasoning: Bool?

    public init(
        modelID: String,
        name: String,
        provider: String,
        contextWindow: Int?,
        reasoning: Bool? = nil)
    {
        self.modelID = modelID
        self.name = name
        self.provider = provider
        self.contextWindow = contextWindow
        self.reasoning = reasoning
    }

    /// Provider-qualified model ref used for picker identity and selection tags.
    public var selectionID: String {
        let trimmedProvider = self.provider.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProvider.isEmpty else { return self.modelID }
        let providerPrefix = "\(trimmedProvider)/"
        if self.modelID.hasPrefix(providerPrefix) {
            return self.modelID
        }
        return "\(trimmedProvider)/\(self.modelID)"
    }

    public var displayLabel: String {
        self.selectionID
    }
}

public struct OpenClawChatSessionSettingsPatch: Sendable, Equatable {
    /// Outer optional means unchanged; inner optional clears the override.
    public let model: String??
    public let thinkingLevel: String??
    public let fastMode: OpenClawChatFastMode??
    public let verboseLevel: String??

    public init(
        model: String?? = nil,
        thinkingLevel: String?? = nil,
        fastMode: OpenClawChatFastMode?? = nil,
        verboseLevel: String?? = nil)
    {
        self.model = model
        self.thinkingLevel = thinkingLevel
        self.fastMode = fastMode
        self.verboseLevel = verboseLevel
    }
}

/// Authoritative model identity and thinking state returned by `sessions.patch`.
public struct OpenClawChatModelPatchResult: Decodable, Sendable, Equatable {
    public let key: String?
    public let modelProvider: String?
    public let model: String?
    public let thinkingLevel: String?
    public let thinkingLevels: [OpenClawChatThinkingLevelOption]?
    public let fastMode: OpenClawChatFastMode?
    public let effectiveFastMode: OpenClawChatFastMode?
    public let verboseLevel: String?

    public init(
        key: String? = nil,
        modelProvider: String?,
        model: String?,
        thinkingLevel: String?,
        thinkingLevels: [OpenClawChatThinkingLevelOption]? = nil,
        fastMode: OpenClawChatFastMode? = nil,
        effectiveFastMode: OpenClawChatFastMode? = nil,
        verboseLevel: String? = nil)
    {
        self.key = key
        self.modelProvider = modelProvider
        self.model = model
        self.thinkingLevel = thinkingLevel
        self.thinkingLevels = thinkingLevels
        self.fastMode = fastMode
        self.effectiveFastMode = effectiveFastMode
        self.verboseLevel = verboseLevel
    }

    private enum CodingKeys: String, CodingKey {
        case key
        case entry
        case resolved
    }

    private enum EntryKeys: String, CodingKey {
        case modelProvider
        case model
        case providerOverride
        case modelOverride
        case thinkingLevel
        case fastMode
        case effectiveFastMode
        case verboseLevel
    }

    private enum ResolvedKeys: String, CodingKey {
        case modelProvider
        case model
        case thinkingLevel
        case thinkingLevels
        case fastMode
        case effectiveFastMode
        case verboseLevel
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let entry = try container.nestedContainer(keyedBy: EntryKeys.self, forKey: .entry)
        self.key = try container.decodeIfPresent(String.self, forKey: .key)
        let entryModelProvider = try entry.decodeIfPresent(String.self, forKey: .modelProvider)
            ?? entry.decodeIfPresent(String.self, forKey: .providerOverride)
        let entryModel = try entry.decodeIfPresent(String.self, forKey: .model)
            ?? entry.decodeIfPresent(String.self, forKey: .modelOverride)
        let entryThinkingLevel = try entry.decodeIfPresent(String.self, forKey: .thinkingLevel)
        let entryFastMode = try entry.decodeIfPresent(OpenClawChatFastMode.self, forKey: .fastMode)
        let entryEffectiveFastMode = try entry.decodeIfPresent(
            OpenClawChatFastMode.self,
            forKey: .effectiveFastMode)
        let entryVerboseLevel = try entry.decodeIfPresent(String.self, forKey: .verboseLevel)
        if container.contains(.resolved) {
            let resolved = try container.nestedContainer(keyedBy: ResolvedKeys.self, forKey: .resolved)
            self.modelProvider = try resolved.decodeIfPresent(String.self, forKey: .modelProvider)
                ?? entryModelProvider
            self.model = try resolved.decodeIfPresent(String.self, forKey: .model)
                ?? entryModel
            let resolvedThinkingLevel = try resolved.decodeIfPresent(String.self, forKey: .thinkingLevel)
            self.thinkingLevel = resolvedThinkingLevel ?? entryThinkingLevel
            self.thinkingLevels = try resolved.decodeIfPresent(
                [OpenClawChatThinkingLevelOption].self,
                forKey: .thinkingLevels)
            self.fastMode = try resolved.decodeIfPresent(OpenClawChatFastMode.self, forKey: .fastMode)
                ?? entryFastMode
            self.effectiveFastMode = try resolved.decodeIfPresent(
                OpenClawChatFastMode.self,
                forKey: .effectiveFastMode) ?? entryEffectiveFastMode
            self.verboseLevel = try resolved.decodeIfPresent(String.self, forKey: .verboseLevel)
                ?? entryVerboseLevel
        } else {
            self.modelProvider = entryModelProvider
            self.model = entryModel
            self.thinkingLevel = entryThinkingLevel
            self.thinkingLevels = nil
            self.fastMode = entryFastMode
            self.effectiveFastMode = entryEffectiveFastMode
            self.verboseLevel = entryVerboseLevel
        }
    }
}

public struct OpenClawChatSessionsDefaults: Codable, Sendable {
    public let modelProvider: String?
    public let model: String?
    public let contextTokens: Int?
    public let thinkingLevels: [OpenClawChatThinkingLevelOption]?
    public let thinkingOptions: [String]?
    public let thinkingDefault: String?
    public let mainSessionKey: String?

    public init(
        modelProvider: String? = nil,
        model: String?,
        contextTokens: Int?,
        thinkingLevels: [OpenClawChatThinkingLevelOption]? = nil,
        thinkingOptions: [String]? = nil,
        thinkingDefault: String? = nil,
        mainSessionKey: String? = nil)
    {
        self.modelProvider = modelProvider
        self.model = model
        self.contextTokens = contextTokens
        self.thinkingLevels = thinkingLevels
        self.thinkingOptions = thinkingOptions
        self.thinkingDefault = thinkingDefault
        self.mainSessionKey = mainSessionKey
    }
}

public struct OpenClawChatSessionWorktree: Codable, Sendable, Hashable {
    public let id: String?
    public let branch: String?
    public let repoRoot: String?

    public init(id: String?, branch: String?, repoRoot: String?) {
        self.id = id
        self.branch = branch
        self.repoRoot = repoRoot
    }
}

public struct OpenClawChatAgentRuntime: Codable, Sendable, Hashable {
    public let id: String
    public let fallback: String?
    public let source: String?
}

public struct OpenClawChatSessionGroup: Codable, Identifiable, Sendable, Hashable {
    public var id: String {
        self.name
    }

    public let name: String
    public let position: Int

    public init(name: String, position: Int) {
        self.name = name
        self.position = position
    }
}

public struct OpenClawChatSessionGroupsResponse: Codable, Sendable, Equatable {
    public let groups: [OpenClawChatSessionGroup]
}

public struct OpenClawChatSessionGroupsMutationResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let groups: [OpenClawChatSessionGroup]
    public let updatedSessions: Int?
}

public struct OpenClawChatAgentChoice: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String?
    public let workspaceGit: Bool?

    public init(id: String, name: String? = nil, workspaceGit: Bool? = nil) {
        self.id = id
        self.name = name
        self.workspaceGit = workspaceGit
    }

    public var displayName: String {
        let normalized = self.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let normalized, !normalized.isEmpty else { return self.id }
        return normalized
    }
}

public struct OpenClawChatAgentsListResponse: Codable, Sendable, Equatable {
    public let defaultId: String
    public let agents: [OpenClawChatAgentChoice]

    public init(defaultId: String, agents: [OpenClawChatAgentChoice]) {
        self.defaultId = defaultId
        self.agents = agents
    }
}

public struct OpenClawChatSessionEntry: Codable, Identifiable, Sendable, Hashable {
    public var id: String {
        self.key
    }

    public var key: String
    public var kind: String?
    public var displayName: String?
    public var derivedTitle: String?
    /// Non-sensitive facts derived by the Gateway from the canonical session route.
    public var classification: String?
    public var boardFace: String?
    public var agentId: String?
    public var accountId: String?
    public var peerKind: String?
    public var isMain: Bool?
    public var isBackground: Bool?
    public var label: String?
    public var category: String?
    public var color: String?
    public var pinned: Bool?
    public var pinnedAt: Double?
    public var archived: Bool?
    public var archivedAt: Double?
    public var unread: Bool?
    public var agentStatus: OpenClawChatSessionAgentStatus?
    public var observerDigest: OpenClawChatSessionObserverDigest?
    public var surface: String?
    public var subject: String?
    public var room: String?
    public var space: String?
    public var updatedAt: Double?
    public var lastReadAt: Double?
    public var markedUnreadAt: Double?
    public var lastInteractionAt: Double?
    public var lastActivityAt: Double?
    public var sessionId: String?

    public var parentSessionKey: String?
    public var spawnedBy: String?
    public var childSessions: [String]?
    public var status: String?
    public var lastRunError: String?
    public var hasActiveRun: Bool?
    public var activeRunIds: [String]?
    public var hasActiveSubagentRun: Bool?
    public var subagentRunState: String?
    public var swarmGroupId: String?
    public var swarmPhase: String?
    public var swarmPhaseRank: Int?
    public var swarmLog: String?
    public var worktree: OpenClawChatSessionWorktree?
    public var startedAt: Double?
    public var endedAt: Double?
    public var runtimeMs: Double?
    public var agentRuntime: OpenClawChatAgentRuntime?

    public var systemSent: Bool?
    public var abortedLastRun: Bool?
    public var thinkingLevel: String?
    public var verboseLevel: String?
    public var fastMode: OpenClawChatFastMode?
    public var effectiveFastMode: OpenClawChatFastMode?

    public var inputTokens: Int?
    public var outputTokens: Int?
    public var totalTokens: Int?
    public var totalTokensFresh: Bool?

    public var modelProvider: String?
    public var model: String?
    public var contextTokens: Int?
    public var thinkingLevels: [OpenClawChatThinkingLevelOption]?
    public var thinkingOptions: [String]?
    public var thinkingDefault: String?

    public init(
        key: String,
        kind: String?,
        displayName: String?,
        classification: String? = nil,
        boardFace: String? = nil,
        agentId: String? = nil,
        accountId: String? = nil,
        peerKind: String? = nil,
        isMain: Bool? = nil,
        isBackground: Bool? = nil,
        surface: String?,
        subject: String?,
        room: String?,
        space: String?,
        updatedAt: Double?,
        sessionId: String?,
        systemSent: Bool?,
        abortedLastRun: Bool?,
        thinkingLevel: String?,
        verboseLevel: String?,
        inputTokens: Int?,
        outputTokens: Int?,
        totalTokens: Int?,
        totalTokensFresh: Bool? = nil,
        modelProvider: String?,
        model: String?,
        contextTokens: Int?,
        thinkingLevels: [OpenClawChatThinkingLevelOption]? = nil,
        thinkingOptions: [String]? = nil,
        thinkingDefault: String? = nil,
        label: String? = nil,
        category: String? = nil,
        color: String? = nil,
        pinned: Bool? = nil,
        pinnedAt: Double? = nil,
        archived: Bool? = nil,
        archivedAt: Double? = nil,
        unread: Bool? = nil,
        agentStatus: OpenClawChatSessionAgentStatus? = nil,
        observerDigest: OpenClawChatSessionObserverDigest? = nil,
        lastReadAt: Double? = nil,
        markedUnreadAt: Double? = nil,
        lastInteractionAt: Double? = nil,
        lastActivityAt: Double? = nil,
        parentSessionKey: String? = nil,
        spawnedBy: String? = nil,
        childSessions: [String]? = nil,
        status: String? = nil,
        lastRunError: String? = nil,
        hasActiveRun: Bool? = nil,
        activeRunIds: [String]? = nil,
        hasActiveSubagentRun: Bool? = nil,
        subagentRunState: String? = nil,
        swarmGroupId: String? = nil,
        swarmPhase: String? = nil,
        swarmPhaseRank: Int? = nil,
        swarmLog: String? = nil,
        worktree: OpenClawChatSessionWorktree? = nil,
        fastMode: OpenClawChatFastMode? = nil,
        effectiveFastMode: OpenClawChatFastMode? = nil,
        startedAt: Double? = nil,
        endedAt: Double? = nil,
        runtimeMs: Double? = nil,
        agentRuntime: OpenClawChatAgentRuntime? = nil,
        derivedTitle: String? = nil)
    {
        self.key = key
        self.kind = kind
        self.displayName = displayName
        self.derivedTitle = derivedTitle
        self.classification = classification
        self.boardFace = boardFace
        self.agentId = agentId
        self.accountId = accountId
        self.peerKind = peerKind
        self.isMain = isMain
        self.isBackground = isBackground
        self.label = label
        self.category = category
        self.color = color
        self.pinned = pinned
        self.pinnedAt = pinnedAt
        self.archived = archived
        self.archivedAt = archivedAt
        self.unread = unread
        self.agentStatus = agentStatus
        self.observerDigest = observerDigest
        self.surface = surface
        self.subject = subject
        self.room = room
        self.space = space
        self.updatedAt = updatedAt
        self.lastReadAt = lastReadAt
        self.markedUnreadAt = markedUnreadAt
        self.lastInteractionAt = lastInteractionAt
        self.lastActivityAt = lastActivityAt
        self.sessionId = sessionId
        self.parentSessionKey = parentSessionKey
        self.spawnedBy = spawnedBy
        self.childSessions = childSessions
        self.status = status
        self.lastRunError = lastRunError
        self.hasActiveRun = hasActiveRun
        self.activeRunIds = activeRunIds
        self.hasActiveSubagentRun = hasActiveSubagentRun
        self.subagentRunState = subagentRunState
        self.swarmGroupId = swarmGroupId
        self.swarmPhase = swarmPhase
        self.swarmPhaseRank = swarmPhaseRank
        self.swarmLog = swarmLog
        self.worktree = worktree
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.runtimeMs = runtimeMs
        self.agentRuntime = agentRuntime
        self.systemSent = systemSent
        self.abortedLastRun = abortedLastRun
        self.thinkingLevel = thinkingLevel
        self.verboseLevel = verboseLevel
        self.fastMode = fastMode
        self.effectiveFastMode = effectiveFastMode
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
        self.totalTokensFresh = totalTokensFresh
        self.modelProvider = modelProvider
        self.model = model
        self.contextTokens = contextTokens
        self.thinkingLevels = thinkingLevels
        self.thinkingOptions = thinkingOptions
        self.thinkingDefault = thinkingDefault
    }

    public var isPinned: Bool {
        self.pinned == true
    }

    public var isArchived: Bool {
        self.archived == true
    }
}

/// Client-side session list policy shared by every session list surface.
/// Ordering mirrors the gateway (`pinnedAt` desc, `updatedAt` desc, key) so
/// cached/offline lists render in the same order as server responses.
public enum OpenClawChatSessionListOrganizer {
    public static func organize(_ sessions: [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry] {
        sessions.sorted { lhs, rhs in
            let lhsPinnedAt = lhs.pinnedAt ?? (lhs.isPinned ? .greatestFiniteMagnitude : 0)
            let rhsPinnedAt = rhs.pinnedAt ?? (rhs.isPinned ? .greatestFiniteMagnitude : 0)
            if lhsPinnedAt != rhsPinnedAt {
                return lhsPinnedAt > rhsPinnedAt
            }
            let lhsUpdatedAt = lhs.updatedAt ?? 0
            let rhsUpdatedAt = rhs.updatedAt ?? 0
            if lhsUpdatedAt != rhsUpdatedAt {
                return lhsUpdatedAt > rhsUpdatedAt
            }
            return lhs.key < rhs.key
        }
    }

    /// Local fallback for the server-side `sessions.list` search when the
    /// gateway is unreachable and only cached entries are available.
    public static func filter(
        _ sessions: [OpenClawChatSessionEntry],
        search: String) -> [OpenClawChatSessionEntry]
    {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return sessions }
        return sessions.filter { session in
            [session.displayName, session.label, session.subject, session.sessionId, session.category, session.key]
                .contains { $0?.lowercased().contains(query) == true }
        }
    }
}

public enum OpenClawChatChildSessionPager {
    private static let maxCollectedSessions = 100_000
    private static let maxPageRequests = 100

    public static func collect(
        fetchPage: (Int) async throws -> OpenClawChatSessionsListResponse) async throws
        -> [OpenClawChatSessionEntry]
    {
        var rowsByKey: [String: OpenClawChatSessionEntry] = [:]
        var remainingPageRequests = Self.maxPageRequests
        for _ in 0..<4 {
            let rowsBeforePass = rowsByKey.count
            var expectedTotal: Int?
            var seenOffsets = Set<Int>()
            var offset = 0
            while remainingPageRequests > 0,
                  rowsByKey.count < Self.maxCollectedSessions,
                  seenOffsets.insert(offset).inserted
            {
                remainingPageRequests -= 1
                let page = try await fetchPage(offset)
                expectedTotal = page.totalCount
                for row in page.sessions {
                    rowsByKey[row.key] = row
                    if rowsByKey.count >= Self.maxCollectedSessions {
                        break
                    }
                }
                if rowsByKey.count >= Self.maxCollectedSessions {
                    return Array(rowsByKey.values)
                }
                let hasMore = page.hasMore ?? expectedTotal.map { offset + page.sessions.count < $0 } ?? false
                let nextOffset = page.nextOffset ?? (offset + page.sessions.count)
                guard hasMore, !page.sessions.isEmpty, nextOffset > offset else { break }
                offset = nextOffset
            }
            let added = rowsByKey.count - rowsBeforePass
            if remainingPageRequests == 0 ||
                added == 0 ||
                expectedTotal.map({ rowsByKey.count >= $0 }) != false
            {
                break
            }
        }
        return Array(rowsByKey.values)
    }
}

public struct OpenClawChatSessionsListResponse: Codable, Sendable {
    public let ts: Double?
    public let path: String?
    public let count: Int?
    public let totalCount: Int?
    public let offset: Int?
    public let nextOffset: Int?
    public let hasMore: Bool?
    public let defaults: OpenClawChatSessionsDefaults?
    public let sessions: [OpenClawChatSessionEntry]

    public init(
        ts: Double?,
        path: String?,
        count: Int?,
        totalCount: Int? = nil,
        offset: Int? = nil,
        nextOffset: Int? = nil,
        hasMore: Bool? = nil,
        defaults: OpenClawChatSessionsDefaults?,
        sessions: [OpenClawChatSessionEntry])
    {
        self.ts = ts
        self.path = path
        self.count = count
        self.totalCount = totalCount
        self.offset = offset
        self.nextOffset = nextOffset
        self.hasMore = hasMore
        self.defaults = defaults
        self.sessions = sessions
    }
}
