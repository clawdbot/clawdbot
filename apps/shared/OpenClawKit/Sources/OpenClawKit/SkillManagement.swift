import Foundation
import OpenClawProtocol

public struct SkillsStatusReport: Codable, Sendable {
    public let workspaceDir: String
    public let managedSkillsDir: String
    public let skills: [SkillStatus]

    public init(workspaceDir: String, managedSkillsDir: String, skills: [SkillStatus]) {
        self.workspaceDir = workspaceDir
        self.managedSkillsDir = managedSkillsDir
        self.skills = skills
    }
}

public struct SkillStatus: Codable, Identifiable, Sendable {
    public let name: String
    public let description: String
    public let source: String
    public let bundled: Bool?
    public let filePath: String
    public let baseDir: String
    public let skillKey: String
    public let primaryEnv: String?
    public let emoji: String?
    public let homepage: String?
    public let always: Bool
    public let disabled: Bool
    public let blockedByAllowlist: Bool?
    public let blockedByAgentFilter: Bool?
    public let platformIncompatible: Bool?
    public let eligible: Bool
    public let requirements: SkillRequirements
    public let missing: SkillMissing
    public let configChecks: [SkillStatusConfigCheck]
    public let install: [SkillInstallOption]
    public let clawhub: ClawHubInstalledSkillLink?

    public var id: String {
        self.skillKey
    }

    public init(
        name: String,
        description: String,
        source: String,
        bundled: Bool? = nil,
        filePath: String,
        baseDir: String,
        skillKey: String,
        primaryEnv: String?,
        emoji: String?,
        homepage: String?,
        always: Bool,
        disabled: Bool,
        blockedByAllowlist: Bool? = nil,
        blockedByAgentFilter: Bool? = nil,
        platformIncompatible: Bool? = nil,
        eligible: Bool,
        requirements: SkillRequirements,
        missing: SkillMissing,
        configChecks: [SkillStatusConfigCheck],
        install: [SkillInstallOption],
        clawhub: ClawHubInstalledSkillLink? = nil)
    {
        self.name = name
        self.description = description
        self.source = source
        self.bundled = bundled
        self.filePath = filePath
        self.baseDir = baseDir
        self.skillKey = skillKey
        self.primaryEnv = primaryEnv
        self.emoji = emoji
        self.homepage = homepage
        self.always = always
        self.disabled = disabled
        self.blockedByAllowlist = blockedByAllowlist
        self.blockedByAgentFilter = blockedByAgentFilter
        self.platformIncompatible = platformIncompatible
        self.eligible = eligible
        self.requirements = requirements
        self.missing = missing
        self.configChecks = configChecks
        self.install = install
        self.clawhub = clawhub
    }
}

public struct SkillRequirements: Codable, Sendable {
    public let bins: [String]
    public let anyBins: [String]
    public let env: [String]
    public let config: [String]
    public let os: [String]

    public init(
        bins: [String],
        anyBins: [String] = [],
        env: [String],
        config: [String],
        os: [String] = [])
    {
        self.bins = bins
        self.anyBins = anyBins
        self.env = env
        self.config = config
        self.os = os
    }

    private enum CodingKeys: String, CodingKey {
        case bins
        case anyBins
        case env
        case config
        case os
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.bins = try container.decode([String].self, forKey: .bins)
        self.anyBins = try container.decodeIfPresent([String].self, forKey: .anyBins) ?? []
        self.env = try container.decode([String].self, forKey: .env)
        self.config = try container.decode([String].self, forKey: .config)
        self.os = try container.decodeIfPresent([String].self, forKey: .os) ?? []
    }
}

public struct SkillMissing: Codable, Sendable {
    public let bins: [String]
    public let anyBins: [String]
    public let env: [String]
    public let config: [String]
    public let os: [String]

    public init(
        bins: [String],
        anyBins: [String] = [],
        env: [String],
        config: [String],
        os: [String] = [])
    {
        self.bins = bins
        self.anyBins = anyBins
        self.env = env
        self.config = config
        self.os = os
    }

    private enum CodingKeys: String, CodingKey {
        case bins
        case anyBins
        case env
        case config
        case os
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.bins = try container.decode([String].self, forKey: .bins)
        self.anyBins = try container.decodeIfPresent([String].self, forKey: .anyBins) ?? []
        self.env = try container.decode([String].self, forKey: .env)
        self.config = try container.decode([String].self, forKey: .config)
        self.os = try container.decodeIfPresent([String].self, forKey: .os) ?? []
    }
}

public struct SkillStatusConfigCheck: Codable, Identifiable, Sendable {
    public let path: String
    public let value: OpenClawProtocol.AnyCodable?
    public let satisfied: Bool

    public var id: String {
        self.path
    }
}

public struct SkillInstallOption: Codable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let label: String
    public let bins: [String]
}

public struct ClawHubInstalledSkillLink: Codable, Sendable {
    public let status: String
    public let valid: Bool
    public let slug: String?
    public let ownerHandle: String?
    /// Exact reference this skill was installed from. The Gateway records the canonical slug and
    /// this separately, so an install-only source stays identifiable after install.
    public let requestedReference: String?
    public let installedVersion: String?
    public let reason: String?
}
