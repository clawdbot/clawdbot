import Foundation

public struct OpenClawChatThinkingLevelOption: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
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

    public init(model: String?? = nil, thinkingLevel: String?? = nil) {
        self.model = model
        self.thinkingLevel = thinkingLevel
    }
}

/// Authoritative model identity and thinking state returned by `sessions.patch`.
public struct OpenClawChatModelPatchResult: Decodable, Sendable, Equatable {
    public let key: String?
    public let modelProvider: String?
    public let model: String?
    public let thinkingLevel: String?
    public let thinkingLevels: [OpenClawChatThinkingLevelOption]?

    // periphery:ignore - package tests construct patch responses; app consumers decode them.
    public init(
        key: String? = nil,
        modelProvider: String?,
        model: String?,
        thinkingLevel: String?,
        thinkingLevels: [OpenClawChatThinkingLevelOption]? = nil)
    {
        self.key = key
        self.modelProvider = modelProvider
        self.model = model
        self.thinkingLevel = thinkingLevel
        self.thinkingLevels = thinkingLevels
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
    }

    private enum ResolvedKeys: String, CodingKey {
        case modelProvider
        case model
        case thinkingLevel
        case thinkingLevels
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
        } else {
            self.modelProvider = entryModelProvider
            self.model = entryModel
            self.thinkingLevel = entryThinkingLevel
            self.thinkingLevels = nil
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

public struct OpenClawChatSessionEntry: Codable, Identifiable, Sendable, Hashable {
    public var id: String {
        self.key
    }

    public var key: String
    public var kind: String?
    public var displayName: String?
    public var label: String?
    public var category: String?
    public var pinned: Bool?
    public var pinnedAt: Double?
    public var archived: Bool?
    public var archivedAt: Double?
    public var unread: Bool?
    public var surface: String?
    public var subject: String?
    public var room: String?
    public var space: String?
    public var updatedAt: Double?
    public var lastReadAt: Double?
    public var lastActivityAt: Double?
    public var sessionId: String?

    public var systemSent: Bool?
    public var abortedLastRun: Bool?
    public var thinkingLevel: String?
    public var verboseLevel: String?

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
        pinned: Bool? = nil,
        pinnedAt: Double? = nil,
        archived: Bool? = nil,
        archivedAt: Double? = nil,
        unread: Bool? = nil,
        lastReadAt: Double? = nil,
        lastActivityAt: Double? = nil)
    {
        self.key = key
        self.kind = kind
        self.displayName = displayName
        self.label = label
        self.category = category
        self.pinned = pinned
        self.pinnedAt = pinnedAt
        self.archived = archived
        self.archivedAt = archivedAt
        self.unread = unread
        self.surface = surface
        self.subject = subject
        self.room = room
        self.space = space
        self.updatedAt = updatedAt
        self.lastReadAt = lastReadAt
        self.lastActivityAt = lastActivityAt
        self.sessionId = sessionId
        self.systemSent = systemSent
        self.abortedLastRun = abortedLastRun
        self.thinkingLevel = thinkingLevel
        self.verboseLevel = verboseLevel
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
            for field in [session.displayName, session.label, session.subject, session.sessionId, session.key] {
                if let field, field.lowercased().contains(query) {
                    return true
                }
            }
            return false
        }
    }
}

public struct OpenClawChatSessionsListResponse: Codable, Sendable {
    public let ts: Double?
    public let path: String?
    public let count: Int?
    public let defaults: OpenClawChatSessionsDefaults?
    public let sessions: [OpenClawChatSessionEntry]

    public init(
        ts: Double?,
        path: String?,
        count: Int?,
        defaults: OpenClawChatSessionsDefaults?,
        sessions: [OpenClawChatSessionEntry])
    {
        self.ts = ts
        self.path = path
        self.count = count
        self.defaults = defaults
        self.sessions = sessions
    }
}
