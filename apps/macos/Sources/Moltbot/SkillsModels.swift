import MoltbotProtocol
import Foundation

struct SkillsStatusReport: Codable {
    let workspaceDir: String
    let managedSkillsDir: String
    let skills: [SkillStatus]
}

struct SkillStatus: Codable, Identifiable {
    let name: String
    let description: String
    let source: String
    let filePath: String
    let baseDir: String
    let skillKey: String
    let primaryEnv: String?
    let emoji: String?
    let homepage: String?
    let always: Bool
    let disabled: Bool
    let eligible: Bool
    let requirements: SkillRequirements
    let missing: SkillMissing
    let configChecks: [SkillStatusConfigCheck]
    let install: [SkillInstallOption]

    var id: String { self.name }
}

struct SkillRequirements: Codable {
    let bins: [String]
    let env: [String]
    let config: [String]
}

struct SkillMissing: Codable {
    let bins: [String]
    let env: [String]
    let config: [String]
}

struct SkillStatusConfigCheck: Codable, Identifiable {
    let path: String
    let value: AnyCodable?
    let satisfied: Bool

    var id: String { self.path }
}

struct SkillInstallOption: Codable, Identifiable {
    let id: String
    let kind: String
    let label: String
    let bins: [String]
}

struct SkillInstallResult: Codable {
    let ok: Bool
    let message: String
    let stdout: String?
    let stderr: String?
    let code: Int?
}

struct SkillUpdateResult: Codable {
    let ok: Bool
    let skillKey: String
    let config: [String: AnyCodable]?
}
