import Foundation
import OpenClawProtocol

public let clawHubSkillGatewayMethods: Set<String> = ["skills.search", "skills.detail", "skills.install"]
public let clawHubInstallTimeoutMilliseconds = 120_000

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
    public let env: [String]
    public let config: [String]

    public init(bins: [String], env: [String], config: [String]) {
        self.bins = bins
        self.env = env
        self.config = config
    }
}

public struct SkillMissing: Codable, Sendable {
    public let bins: [String]
    public let env: [String]
    public let config: [String]

    public init(bins: [String], env: [String], config: [String]) {
        self.bins = bins
        self.env = env
        self.config = config
    }
}

public struct SkillStatusConfigCheck: Codable, Identifiable, Sendable {
    public let path: String
    public let value: OpenClawProtocol.AnyCodable?
    public let satisfied: Bool

    public var id: String {
        self.path
    }

    public init(path: String, value: OpenClawProtocol.AnyCodable?, satisfied: Bool) {
        self.path = path
        self.value = value
        self.satisfied = satisfied
    }
}

public struct SkillInstallOption: Codable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let label: String
    public let bins: [String]

    public init(id: String, kind: String, label: String, bins: [String]) {
        self.id = id
        self.kind = kind
        self.label = label
        self.bins = bins
    }
}

public struct SkillInstallResult: Codable, Sendable {
    public let ok: Bool
    public let message: String
    public let stdout: String?
    public let stderr: String?
    public let code: Int?
    public let slug: String?
    public let version: String?
    public let warning: String?
}

public struct SkillUpdateResult: Codable, Sendable {
    public let ok: Bool
    public let skillKey: String
    public let config: [String: OpenClawProtocol.AnyCodable]?
}

public struct ClawHubInstalledSkillLink: Codable, Sendable {
    public let status: String
    public let valid: Bool
    public let slug: String?
    public let ownerHandle: String?
    public let installedVersion: String?
    public let reason: String?
}

public struct ClawHubSkillSummary: Codable, Identifiable, Hashable, Sendable {
    public let slug: String
    public let displayName: String
    public let summary: String?
    public let version: String?

    public var id: String {
        self.slug
    }
}

public struct ClawHubSkillSearchResult: Codable, Sendable {
    public let results: [ClawHubSkillSummary]
}

public struct ClawHubSkillDetail: Codable, Sendable {
    public struct Skill: Codable, Sendable {
        public let slug: String?
        public let displayName: String
        public let summary: String?
    }

    public struct Version: Codable, Sendable {
        public let version: String
    }

    public struct Owner: Codable, Sendable {
        public let handle: String?
        public let displayName: String?
    }

    public let skill: Skill?
    public let latestVersion: Version?
    public let owner: Owner?
}

public struct ClawHubSkillInstallReview: Identifiable, Hashable, Sendable {
    public let slug: String
    public let displayName: String
    public let summary: String?
    public let version: String
    public let author: String

    public var id: String {
        "\(self.slug)@\(self.version)"
    }

    public init?(detail: ClawHubSkillDetail, fallback: ClawHubSkillSummary) {
        guard let version = detail.latestVersion?.version ?? fallback.version else { return nil }
        let detailSlug = detail.skill?.slug?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let handle = detail.owner?.handle?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        guard let reviewedSlug = SkillManagementContract.canonicalClawHubReference(
            slug: detailSlug ?? fallback.slug,
            ownerHandle: handle)
        else { return nil }
        self.slug = reviewedSlug
        self.displayName = detail.skill?.displayName ?? fallback.displayName
        self.summary = detail.skill?.summary ?? fallback.summary
        self.version = version
        let displayName = detail.owner?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        switch (displayName?.nilIfEmpty, handle?.nilIfEmpty) {
        case let (.some(name), .some(handle)) where name.caseInsensitiveCompare(handle) != .orderedSame:
            self.author = "\(name) (@\(handle))"
        case let (.some(name), _):
            self.author = name
        case let (_, .some(handle)):
            self.author = "@\(handle)"
        default:
            self.author = "Unknown publisher"
        }
    }
}

public struct ClawHubSkillInstallRejection: Equatable, Sendable {
    public let message: String
    public let warning: String?
    public let acknowledgeVersion: String?
    public let requiresAcknowledgement: Bool
}

public enum SkillManagementContract {
    public static func installed(_ skills: [SkillStatus], slug: String, version: String) -> Bool {
        guard let reference = clawHubReference(slug) else { return false }
        return skills.contains {
            self.matches($0.clawhub, reference: reference) && $0.clawhub?.installedVersion == version
        }
    }

    public static func installed(_ skills: [SkillStatus], slug: String) -> Bool {
        guard let reference = clawHubReference(slug) else { return false }
        return skills.contains { self.matches($0.clawhub, reference: reference) }
    }

    public static func ready(_ skill: SkillStatus) -> Bool {
        !skill.disabled
            && skill.eligible
            && skill.blockedByAllowlist != true
            && skill.blockedByAgentFilter != true
            && skill.platformIncompatible != true
    }

    public static func needsSetup(_ skill: SkillStatus) -> Bool {
        !skill.disabled && !self.ready(skill)
    }

    public static func rejection(
        from error: GatewayResponseError,
        attemptedVersion: String?) -> ClawHubSkillInstallRejection
    {
        let reviewedVersion = attemptedVersion?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let gatewayVersion = self.string(error.details["version"]?.value)
        let warning = self.string(error.details["warning"]?.value)
        let acknowledgementRequested = self.string(error.details["clawhubTrustCode"]?.value)
            == "clawhub_risk_acknowledgement_required"
        // Bind consent to the exact detail response version. A moving ClawHub release
        // must be reviewed again instead of inheriting acknowledgement for older bytes.
        let requiresAcknowledgement = acknowledgementRequested && reviewedVersion != nil
            && gatewayVersion == reviewedVersion
        let message = acknowledgementRequested && !requiresAcknowledgement
            ? "The Gateway evaluated a different ClawHub release. Review the skill again before installing."
            : error.message
        return ClawHubSkillInstallRejection(
            message: message,
            warning: warning,
            acknowledgeVersion: requiresAcknowledgement ? reviewedVersion : nil,
            requiresAcknowledgement: requiresAcknowledgement)
    }

    private static func string(_ value: Any?) -> String? {
        (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    fileprivate static func clawHubReference(_ rawValue: String) -> (slug: String, ownerHandle: String?)? {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        guard value.hasPrefix("@") else { return (value, nil) }
        let parts = value.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        return (String(parts[1]), String(parts[0]).lowercased())
    }

    fileprivate static func canonicalClawHubReference(slug: String, ownerHandle: String?) -> String? {
        guard let reference = clawHubReference(slug) else { return nil }
        let owner = ownerHandle?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty?
            .lowercased() ?? reference.ownerHandle
        return owner.map { "@\($0)/\(reference.slug)" } ?? reference.slug
    }

    private static func matches(
        _ installed: ClawHubInstalledSkillLink?,
        reference: (slug: String, ownerHandle: String?)) -> Bool
    {
        guard installed?.valid == true,
              let installedSlug = installed?.slug,
              let installedReference = clawHubReference(installedSlug),
              installedReference.slug.caseInsensitiveCompare(reference.slug) == .orderedSame
        else { return false }
        guard let ownerHandle = reference.ownerHandle else { return true }
        let installedOwner = installedReference.ownerHandle ?? installed?.ownerHandle
        return installedOwner?.caseInsensitiveCompare(ownerHandle) == .orderedSame
    }
}

extension String {
    fileprivate var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
