import Foundation
import Observation

public enum OpenClawChatPermissionMode: String, Codable, CaseIterable, Hashable, Sendable {
    case readOnly = "read-only"
    case guarded
    case workspace
    case full

    public var displayName: String {
        switch self {
        case .readOnly: String(localized: "Read-only")
        case .guarded: String(localized: "Guarded")
        case .workspace: String(localized: "Workspace")
        case .full: String(localized: "Full")
        }
    }
}

public struct OpenClawChatSessionToolOverrides: Codable, Hashable, Sendable {
    public var webSearch: Bool?
    public var skills: [String: Bool]
    public var mcpServers: [String: Bool]
    public var mcpToolsDeny: [String: [String]]

    public init(
        webSearch: Bool? = nil,
        skills: [String: Bool] = [:],
        mcpServers: [String: Bool] = [:],
        mcpToolsDeny: [String: [String]] = [:])
    {
        self.webSearch = webSearch
        self.skills = skills
        self.mcpServers = mcpServers
        self.mcpToolsDeny = mcpToolsDeny
    }

    public var isEmpty: Bool {
        self.webSearch == nil && self.skills.isEmpty && self.mcpServers.isEmpty && self.mcpToolsDeny.isEmpty
    }

    public var overrideCount: Int {
        (self.webSearch == nil ? 0 : 1) + self.skills.count + self.mcpServers.count +
            self.mcpToolsDeny.values.reduce(0) { $0 + $1.count }
    }

    private enum CodingKeys: String, CodingKey {
        case webSearch
        case skills
        case mcpServers
        case mcpToolsDeny
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.webSearch = try container.decodeIfPresent(Bool.self, forKey: .webSearch)
        self.skills = try container.decodeIfPresent([String: Bool].self, forKey: .skills) ?? [:]
        self.mcpServers = try container.decodeIfPresent([String: Bool].self, forKey: .mcpServers) ?? [:]
        self.mcpToolsDeny = try container.decodeIfPresent([String: [String]].self, forKey: .mcpToolsDeny) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(self.webSearch, forKey: .webSearch)
        if !self.skills.isEmpty { try container.encode(self.skills, forKey: .skills) }
        if !self.mcpServers.isEmpty { try container.encode(self.mcpServers, forKey: .mcpServers) }
        if !self.mcpToolsDeny.isEmpty { try container.encode(self.mcpToolsDeny, forKey: .mcpToolsDeny) }
    }
}

public struct OpenClawChatComposerSkill: Identifiable, Equatable, Sendable {
    public let key: String
    public let name: String
    public let baseEnabled: Bool
    public let missingDependencies: Bool
    public let blocked: Bool
    public let agentFiltered: Bool

    public var id: String {
        self.key
    }

    public init(
        key: String,
        name: String,
        baseEnabled: Bool,
        missingDependencies: Bool,
        blocked: Bool,
        agentFiltered: Bool = false)
    {
        self.key = key
        self.name = name
        self.baseEnabled = baseEnabled
        self.missingDependencies = missingDependencies
        self.blocked = blocked
        self.agentFiltered = agentFiltered
    }
}

public struct OpenClawChatComposerTool: Identifiable, Equatable, Sendable {
    public let name: String
    public let label: String
    public let baseEnabled: Bool
    public let sessionDenied: Bool

    public var id: String {
        self.name
    }

    public init(
        name: String,
        label: String,
        baseEnabled: Bool = true,
        sessionDenied: Bool = false)
    {
        self.name = name
        self.label = label
        self.baseEnabled = baseEnabled
        self.sessionDenied = sessionDenied
    }
}

public struct OpenClawChatComposerConnector: Identifiable, Equatable, Sendable {
    public let name: String
    public let baseEnabled: Bool
    public let tools: [OpenClawChatComposerTool]
    public let notice: String?

    public var id: String {
        self.name
    }

    public init(
        name: String,
        baseEnabled: Bool,
        tools: [OpenClawChatComposerTool],
        notice: String? = nil)
    {
        self.name = name
        self.baseEnabled = baseEnabled
        self.tools = tools
        self.notice = notice
    }
}

public struct OpenClawChatComposerCapabilityCatalog: Equatable, Sendable {
    public let sessionSettingsAvailable: Bool
    public let modelMutationAvailable: Bool
    public let effortMutationAvailable: Bool
    public let webSearchBaseEnabled: Bool
    public let webSearchAvailable: Bool
    public let skills: [OpenClawChatComposerSkill]
    public let connectors: [OpenClawChatComposerConnector]
    public let skillsAvailable: Bool
    public let connectorsAvailable: Bool
    public let toolAccessAvailable: Bool
    public let permissionMutationAvailable: Bool
    public let sessionSettingsCASAvailable: Bool
    public let toolOverrideMutationAvailable: Bool
    public let toolOverrideMutationRequiresGatewayUpgrade: Bool
    public let canSelectFullPermission: Bool
    public let loadFailureMessage: String?

    public init(
        sessionSettingsAvailable: Bool = false,
        modelMutationAvailable: Bool = false,
        effortMutationAvailable: Bool = false,
        webSearchBaseEnabled: Bool = true,
        webSearchAvailable: Bool = false,
        skills: [OpenClawChatComposerSkill] = [],
        connectors: [OpenClawChatComposerConnector] = [],
        skillsAvailable: Bool = false,
        connectorsAvailable: Bool = false,
        toolAccessAvailable: Bool = false,
        permissionMutationAvailable: Bool = false,
        sessionSettingsCASAvailable: Bool = false,
        toolOverrideMutationAvailable: Bool = false,
        toolOverrideMutationRequiresGatewayUpgrade: Bool = false,
        canSelectFullPermission: Bool = false,
        loadFailureMessage: String? = nil)
    {
        self.sessionSettingsAvailable = sessionSettingsAvailable
        self.modelMutationAvailable = modelMutationAvailable
        self.effortMutationAvailable = effortMutationAvailable
        self.webSearchBaseEnabled = webSearchBaseEnabled
        self.webSearchAvailable = webSearchAvailable
        self.skills = skills
        self.connectors = connectors
        self.skillsAvailable = skillsAvailable
        self.connectorsAvailable = connectorsAvailable
        self.toolAccessAvailable = toolAccessAvailable
        self.permissionMutationAvailable = permissionMutationAvailable
        self.sessionSettingsCASAvailable = sessionSettingsCASAvailable
        self.toolOverrideMutationAvailable = toolOverrideMutationAvailable
        self.toolOverrideMutationRequiresGatewayUpgrade = toolOverrideMutationRequiresGatewayUpgrade
        self.canSelectFullPermission = canSelectFullPermission
        self.loadFailureMessage = loadFailureMessage
    }
}

@MainActor
@Observable
final class OpenClawChatComposerCapabilityState {
    enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case failed
    }

    var ownerID = ""
    var loadGeneration: UInt64 = 0
    var mutationGeneration: UInt64 = 0
    var phase = Phase.idle
    var catalog = OpenClawChatComposerCapabilityCatalog()
    var isMutating = false
    var notice: String?
    var errorMessage: String?
}
