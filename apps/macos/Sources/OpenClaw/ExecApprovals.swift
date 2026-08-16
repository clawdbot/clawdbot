import Foundation
import OpenClawKit

typealias ExecSecurity = ExecApprovalsSecurity
typealias ExecAsk = ExecApprovalsAsk
typealias ExecAllowlistEntry = ExecApprovalsAllowlistEntry
typealias ExecApprovalsDefaults = ExecApprovalsDefaultsDocument
typealias ExecApprovalsAgent = ExecApprovalsAgentDocument
typealias ExecApprovalsSocketConfig = ExecApprovalsSocketDocument
typealias ExecApprovalsFile = ExecApprovalsDocument

extension ExecApprovalsSecurity {
    var title: String {
        switch self {
        case .deny: "Deny"
        case .allowlist: "Allowlist"
        case .full: "Always Allow"
        }
    }

    static func narrower(_ lhs: ExecSecurity, _ rhs: ExecSecurity) -> ExecSecurity {
        if lhs == .deny || rhs == .deny {
            return .deny
        }
        if lhs == .allowlist || rhs == .allowlist {
            return .allowlist
        }
        return .full
    }
}

enum ExecApprovalQuickMode: String, CaseIterable, Identifiable {
    case deny
    case ask
    case allow

    var id: String {
        rawValue
    }

    var title: String {
        switch self {
        case .deny: "Deny"
        case .ask: "Always Ask"
        case .allow: "Always Allow"
        }
    }

    var security: ExecSecurity {
        switch self {
        case .deny: .deny
        case .ask: .allowlist
        case .allow: .full
        }
    }

    var ask: ExecAsk {
        switch self {
        case .deny: .off
        case .ask: .onMiss
        case .allow: .off
        }
    }

    static func from(security: ExecSecurity, ask _: ExecAsk) -> ExecApprovalQuickMode {
        switch security {
        case .deny:
            .deny
        case .full:
            .allow
        case .allowlist:
            .ask
        }
    }
}

extension ExecApprovalsAsk {
    var title: String {
        switch self {
        case .off: "Never Ask"
        case .onMiss: "Ask on Allowlist Miss"
        case .always: "Always Ask"
        }
    }

    static func stricter(_ lhs: ExecAsk, _ rhs: ExecAsk) -> ExecAsk {
        lhs.strictnessRank >= rhs.strictnessRank ? lhs : rhs
    }

    private var strictnessRank: Int {
        switch self {
        case .off: 0
        case .onMiss: 1
        case .always: 2
        }
    }
}

enum ExecApprovalDecision: String, Codable, Equatable {
    case allowOnce = "allow-once"
    case allowAlways = "allow-always"
    case deny
}

enum ExecAllowlistPatternValidationReason: String, Codable, Equatable, Sendable {
    case empty
    case missingPathComponent

    var message: String {
        switch self {
        case .empty:
            "Pattern cannot be empty."
        case .missingPathComponent:
            "Path patterns only. Include '/', '~', or '\\\\'."
        }
    }
}

enum ExecAllowlistPatternValidation: Equatable {
    case valid(String)
    case invalid(ExecAllowlistPatternValidationReason)
}

struct ExecAllowlistRejectedEntry: Equatable {
    let id: String
    let pattern: String
    let reason: ExecAllowlistPatternValidationReason
}

struct ExecAllowlistUse: Sendable {
    let match: ExecAllowlistEntry
    let resolvedPath: String?
}

struct ExecAllowlistEntryMatchKey: Hashable, Sendable {
    let pattern: Data
    let argPattern: Data

    init(pattern: String, argPattern: String?) {
        self.pattern = Data(pattern.utf8)
        self.argPattern = Data((argPattern ?? "").utf8)
    }
}

struct ExecApprovalsSnapshot: Codable, Sendable {
    var path: String
    var exists: Bool
    var hash: String
    var file: ExecApprovalsFile
}

enum ExecApprovalsConditionalSaveResult {
    case saved(ExecApprovalsSnapshot)
    case baseHashUnavailable
    case baseHashRequired
    case conflict
    case unavailable
}

enum ExecApprovalsMutationError: Error, Equatable, Sendable {
    case invalidPattern(ExecAllowlistPatternValidationReason)
    case entryNotOwned
    case unavailable

    var message: String {
        switch self {
        case let .invalidPattern(reason):
            reason.message
        case .entryNotOwned:
            "This allowlist entry is inherited. Edit its owning scope and retry."
        case .unavailable:
            "Could not save exec approvals. Last known settings are shown; retry the change."
        }
    }
}

enum ExecApprovalsReadError: Error, Equatable, Sendable {
    case migrationRequired(ExecApprovalsLegacyMigrationRequiredError)
    case unavailable

    var message: String {
        switch self {
        case let .migrationRequired(error):
            "Exec approvals need migration — run openclaw doctor --fix with " +
                "OPENCLAW_STATE_DIR set to \(error.stateDirectoryURL.path)."
        case .unavailable:
            "Exec approvals unavailable. Retry to refresh."
        }
    }
}

struct ExecApprovalsResolved: Sendable {
    let url: URL
    let socketPath: String
    let token: String
    let defaults: ExecApprovalsResolvedDefaults
    let agent: ExecApprovalsResolvedDefaults
    let allowlist: [ExecAllowlistEntry]
    var file: ExecApprovalsFile
}

struct ExecApprovalsResolvedDefaults: Codable, Sendable {
    var security: ExecSecurity
    var ask: ExecAsk
    var askFallback: ExecSecurity
    var autoAllowSkills: Bool
}

enum ExecApprovalHelpers {
    static func validateAllowlistPattern(_ pattern: String?) -> ExecAllowlistPatternValidation {
        let trimmed = pattern?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return .invalid(.empty) }
        return .valid(trimmed)
    }

    static func isValidAllowlistPattern(_ pattern: String?) -> Bool {
        switch self.validateAllowlistPattern(pattern) {
        case .valid:
            true
        case .invalid:
            false
        }
    }

    static func isPathPattern(_ pattern: String?) -> Bool {
        let trimmed = pattern?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return self.patternHasPathSelector(trimmed)
    }

    static func parseDecision(_ raw: String?) -> ExecApprovalDecision? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return ExecApprovalDecision(rawValue: trimmed)
    }

    static func requiresAsk(
        ask: ExecAsk,
        security: ExecSecurity,
        allowlistMatch: ExecAllowlistEntry?,
        skillAllow: Bool) -> Bool
    {
        if ask == .always {
            return true
        }
        if ask == .onMiss, security == .allowlist, allowlistMatch == nil, !skillAllow {
            return true
        }
        return false
    }

    static func allowlistPattern(command: [String], resolution: ExecCommandResolution?) -> String? {
        let pattern = resolution?.resolvedRealPath ?? resolution?.resolvedPath ?? resolution?.rawExecutable ??
            command.first ?? ""
        return pattern.isEmpty ? nil : pattern
    }

    static func patternHasPathSelector(_ pattern: String) -> Bool {
        pattern.contains("/") || pattern.contains("~") || pattern.contains("\\")
    }
}

actor SkillBinsCache {
    static let shared = SkillBinsCache()

    private var bins: Set<String> = []
    private var trustByName: [String: Set<String>] = [:]
    private var lastRefresh: Date?
    private let refreshInterval: TimeInterval = 90

    func currentBins(force: Bool = false) async -> Set<String> {
        if force || self.isStale() {
            await self.refresh()
        }
        return self.bins
    }

    func currentTrust(force: Bool = false) async -> [String: Set<String>] {
        if force || self.isStale() {
            await self.refresh()
        }
        return self.trustByName
    }

    func refresh() async {
        do {
            let report = try await GatewayConnection.shared.skillsStatus()
            let trust = Self.buildTrustIndex(report: report, searchPaths: CommandResolver.preferredPaths())
            self.bins = trust.names
            self.trustByName = trust.pathsByName
            self.lastRefresh = Date()
        } catch {
            if self.lastRefresh == nil {
                self.bins = []
                self.trustByName = [:]
            }
        }
    }

    static func normalizeSkillBinName(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }

    static func normalizeResolvedPath(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return URL(fileURLWithPath: trimmed).resolvingSymlinksInPath().standardizedFileURL.path
    }

    static func buildTrustIndex(
        report: SkillsStatusReport,
        searchPaths: [String]) -> SkillBinTrustIndex
    {
        var names = Set<String>()
        var pathsByName: [String: Set<String>] = [:]

        for skill in report.skills {
            for bin in skill.requirements.bins {
                let trimmed = bin.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { continue }
                names.insert(trimmed)

                guard let name = normalizeSkillBinName(trimmed),
                      let resolvedPath = resolveSkillBinPath(trimmed, searchPaths: searchPaths),
                      let normalizedPath = normalizeResolvedPath(resolvedPath)
                else {
                    continue
                }

                var paths = pathsByName[name] ?? Set<String>()
                paths.insert(normalizedPath)
                pathsByName[name] = paths
            }
        }

        return SkillBinTrustIndex(names: names, pathsByName: pathsByName)
    }

    private static func resolveSkillBinPath(_ bin: String, searchPaths: [String]) -> String? {
        let expanded = bin.hasPrefix("~") ? (bin as NSString).expandingTildeInPath : bin
        if expanded.contains("/") || expanded.contains("\\") {
            return FileManager().isExecutableFile(atPath: expanded) ? expanded : nil
        }
        return CommandResolver.findExecutable(named: expanded, searchPaths: searchPaths)
    }

    private func isStale() -> Bool {
        guard let lastRefresh else { return true }
        return Date().timeIntervalSince(lastRefresh) > self.refreshInterval
    }

    static func _testBuildTrustIndex(
        report: SkillsStatusReport,
        searchPaths: [String]) -> SkillBinTrustIndex
    {
        self.buildTrustIndex(report: report, searchPaths: searchPaths)
    }
}

struct SkillBinTrustIndex {
    let names: Set<String>
    let pathsByName: [String: Set<String>]
}
