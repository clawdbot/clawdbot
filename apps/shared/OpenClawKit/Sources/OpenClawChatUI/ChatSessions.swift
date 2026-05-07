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

    public init(modelID: String, name: String, provider: String, contextWindow: Int?) {
        self.modelID = modelID
        self.name = name
        self.provider = provider
        self.contextWindow = contextWindow
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

    public let key: String
    public let kind: String?
    public let displayName: String?
    public let surface: String?
    public let subject: String?
    public let room: String?
    public let space: String?
    public let updatedAt: Double?
    public let sessionId: String?

    public let systemSent: Bool?
    public let abortedLastRun: Bool?
    public let thinkingLevel: String?
    public let verboseLevel: String?

    public let inputTokens: Int?
    public let outputTokens: Int?
    public let totalTokens: Int?

    public let modelProvider: String?
    public let model: String?
    public let contextTokens: Int?
    public let thinkingLevels: [OpenClawChatThinkingLevelOption]?
    public let thinkingOptions: [String]?
    public let thinkingDefault: String?

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
        modelProvider: String?,
        model: String?,
        contextTokens: Int?,
        thinkingLevels: [OpenClawChatThinkingLevelOption]? = nil,
        thinkingOptions: [String]? = nil,
        thinkingDefault: String? = nil)
    {
        self.key = key
        self.kind = kind
        self.displayName = displayName
        self.surface = surface
        self.subject = subject
        self.room = room
        self.space = space
        self.updatedAt = updatedAt
        self.sessionId = sessionId
        self.systemSent = systemSent
        self.abortedLastRun = abortedLastRun
        self.thinkingLevel = thinkingLevel
        self.verboseLevel = verboseLevel
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
        self.modelProvider = modelProvider
        self.model = model
        self.contextTokens = contextTokens
        self.thinkingLevels = thinkingLevels
        self.thinkingOptions = thinkingOptions
        self.thinkingDefault = thinkingDefault
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
