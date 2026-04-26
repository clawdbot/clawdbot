import CryptoKit
import Foundation
import OSLog
import Security

enum ExecSecurity: String, CaseIterable, Codable, Identifiable {
    case deny
    case allowlist
    case full

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .deny: "Deny"
        case .allowlist: "Allowlist"
        case .full: "Always Allow"
        }
    }
}

enum ExecApprovalQuickMode: String, CaseIterable, Identifiable {
    case deny
    case ask
    case allow

    var id: String {
        self.rawValue
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

    static func from(security: ExecSecurity, ask: ExecAsk) -> ExecApprovalQuickMode {
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

enum ExecAsk: String, CaseIterable, Codable, Identifiable {
    case off
    case onMiss = "on-miss"
    case always

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .off: "Never Ask"
        case .onMiss: "Ask on Allowlist Miss"
        case .always: "Always Ask"
        }
    }
}

enum ExecApprovalDecision: String, Codable {
    case allowOnce = "allow-once"
    case allowAlways = "allow-always"
    case deny
}

enum ExecAllowlistPatternValidationReason: String, Codable, Equatable {
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
    let id: UUID
    let pattern: String
    let reason: ExecAllowlistPatternValidationReason
}

struct ExecAllowlistEntry: Codable, Hashable, Identifiable {
    var id: UUID
    var pattern: String
    var lastUsedAt: Double?
    var lastUsedCommand: String?
    var lastResolvedPath: String?

    init(
        id: UUID = UUID(),
        pattern: String,
        lastUsedAt: Double? = nil,
        lastUsedCommand: String? = nil,
        lastResolvedPath: String? = nil)
    {
        self.id = id
        self.pattern = pattern
        self.lastUsedAt = lastUsedAt
        self.lastUsedCommand = lastUsedCommand
        self.lastResolvedPath = lastResolvedPath
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case pattern
        case lastUsedAt
        case lastUsedCommand
        case lastResolvedPath
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        self.pattern = try container.decode(String.self, forKey: .pattern)
        self.lastUsedAt = try container.decodeIfPresent(Double.self, forKey: .lastUsedAt)
        self.lastUsedCommand = try container.decodeIfPresent(String.self, forKey: .lastUsedCommand)
        self.lastResolvedPath = try container.decodeIfPresent(String.self, forKey: .lastResolvedPath)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.id, forKey: .id)
        try container.encode(self.pattern, forKey: .pattern)
        try container.encodeIfPresent(self.lastUsedAt, forKey: .lastUsedAt)
        try container.encodeIfPresent(self.lastUsedCommand, forKey: .lastUsedCommand)
        try container.encodeIfPresent(self.lastResolvedPath, forKey: .lastResolvedPath)
    }
}

struct ExecApprovalsDefaults: Codable {
    var security: ExecSecurity?
    var ask: ExecAsk?
    var askFallback: ExecSecurity?
    var autoAllowSkills: Bool?
}

struct ExecApprovalsAgent: Codable {
    var security: ExecSecurity?
    var ask: ExecAsk?
    var askFallback: ExecSecurity?
    var autoAllowSkills: Bool?
    var allowlist: [ExecAllowlistEntry]?

    var isEmpty: Bool {
        self.security == nil && self.ask == nil && self.askFallback == nil && self
            .autoAllowSkills == nil && (self.allowlist?.isEmpty ?? true)
    }
}

struct ExecApprovalsSocketConfig: Codable {
    var path: String?
    var token: String?
}

struct ExecApprovalsFile: Codable {
    var version: Int
    var socket: ExecApprovalsSocketConfig?
    var defaults: ExecApprovalsDefaults?
    var agents: [String: ExecApprovalsAgent]?
}

struct ExecApprovalsSnapshot: Codable {
    var path: String
    var exists: Bool
    var hash: String
    var file: ExecApprovalsFile
}

struct ExecApprovalsResolved {
    let url: URL
    let socketPath: String
    let token: String
    let defaults: ExecApprovalsResolvedDefaults
    let agent: ExecApprovalsResolvedDefaults
    let allowlist: [ExecAllowlistEntry]
    var file: ExecApprovalsFile
}

struct ExecApprovalsResolvedDefaults {
    var security: ExecSecurity
    var ask: ExecAsk
    var askFallback: ExecSecurity
    var autoAllowSkills: Bool
}

enum ExecApprovalsStore {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals")
    private static let defaultAgentId = "main"
    private static let defaultSecurity: ExecSecurity = .deny
    private static let defaultAsk: ExecAsk = .onMiss
    private static let defaultAskFallback: ExecSecurity = .deny
    private static let defaultAutoAllowSkills = false
    private static let secureStateDirPermissions = 0o700

    static func fileURL() -> URL {
        OpenClawPaths.stateDirURL.appendingPathComponent("exec-approvals.json")
    }

    static func socketPath() -> String {
        OpenClawPaths.stateDirURL.appendingPathComponent("exec-approvals.sock").path
    }

    static func normalizeIncoming(_ file: ExecApprovalsFile) -> ExecApprovalsFile {
        let socketPath = file.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = file.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var agents = file.agents ?? [:]
        if let legacyDefault = agents["default"] {
            if let main = agents[self.defaultAgentId] {
                agents[self.defaultAgentId] = self.mergeAgents(current: main, legacy: legacyDefault)
            } else {
                agents[self.defaultAgentId] = legacyDefault
            }
            agents.removeValue(forKey: "default")
        }
        if !agents.isEmpty {
            var normalizedAgents: [String: ExecApprovalsAgent] = [:]
            normalizedAgents.reserveCapacity(agents.count)
            for (key, var agent) in agents {
                if let allowlist = agent.allowlist {
                    let normalized = self.normalizeAllowlistEntries(allowlist, dropInvalid: false).entries
                    agent.allowlist = normalized.isEmpty ? nil : normalized
                }
                normalizedAgents[key] = agent
            }
            agents = normalizedAgents
        }
        return ExecApprovalsFile(
            version: 1,
            socket: ExecApprovalsSocketConfig(
                path: socketPath.isEmpty ? nil : socketPath,
                token: token.isEmpty ? nil : token),
            defaults: file.defaults,
            agents: agents.isEmpty ? nil : agents)
    }

    static func readSnapshot() -> ExecApprovalsSnapshot {
        let url = self.fileURL()
        guard FileManager().fileExists(atPath: url.path) else {
            return ExecApprovalsSnapshot(
                path: url.path,
                exists: false,
                hash: self.hashRaw(nil),
                file: ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:]))
        }
        let raw = try? String(contentsOf: url, encoding: .utf8)
        let data = raw.flatMap { $0.data(using: .utf8) }
        let decoded: ExecApprovalsFile = {
            if let data, let file = try? JSONDecoder().decode(ExecApprovalsFile.self, from: data), file.version == 1 {
                return file
            }
            return ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:])
        }()
        return ExecApprovalsSnapshot(
            path: url.path,
            exists: true,
            hash: self.hashRaw(raw),
            file: decoded)
    }

    static func redactForSnapshot(_ file: ExecApprovalsFile) -> ExecApprovalsFile {
        let socketPath = file.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if socketPath.isEmpty {
            return ExecApprovalsFile(
                version: file.version,
                socket: nil,
                defaults: file.defaults,
                agents: file.agents)
        }
        return ExecApprovalsFile(
            version: file.version,
            socket: ExecApprovalsSocketConfig(path: socketPath, token: nil),
            defaults: file.defaults,
            agents: file.agents)
    }

    static func loadFile() -> ExecApprovalsFile {
        let url = self.fileURL()
        guard FileManager().fileExists(atPath: url.path) else {
            return ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:])
        }
        do {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode(ExecApprovalsFile.self, from: data)
            if decoded.version != 1 {
                return ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:])
            }
            return decoded
        } catch {
            self.logger.warning("exec approvals load failed: \(error.localizedDescription, privacy: .public)")
            return ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:])
        }
    }

    static func saveFile(_ file: ExecApprovalsFile) {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(file)
            let url = self.fileURL()
            self.ensureSecureStateDirectory()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
            try? FileManager().setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            self.logger.error("exec approvals save failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func ensureFile() -> ExecApprovalsFile {
        self.ensureSecureStateDirectory()
        let url = self.fileURL()
        let existed = FileManager().fileExists(atPath: url.path)
        let loaded = self.loadFile()
        let loadedHash = self.hashFile(loaded)

        var file = self.normalizeIncoming(loaded)
        if file.socket == nil { file.socket = ExecApprovalsSocketConfig(path: nil, token: nil) }
        let path = file.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if path.isEmpty {
            file.socket?.path = self.socketPath()
        }
        let token = file.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if token.isEmpty {
            file.socket?.token = self.generateToken()
        }
        if file.agents == nil { file.agents = [:] }
        if !existed || loadedHash != self.hashFile(file) {
            self.saveFile(file)
        }
        return file
    }

    static func resolve(agentId: String?) -> ExecApprovalsResolved {
        let file = self.ensureFile()
        return self.resolveFromFile(file, agentId: agentId)
    }

    /// Read-only resolve: loads file without writing (no ensureFile side effects).
    /// Safe to call from background threads / off MainActor.
    static func resolveReadOnly(agentId: String?) -> ExecApprovalsResolved {
        let file = self.loadFile()
        return self.resolveFromFile(file, agentId: agentId)
    }

    private static func resolveFromFile(_ file: ExecApprovalsFile, agentId: String?) -> ExecApprovalsResolved {
        let defaults = file.defaults ?? ExecApprovalsDefaults()
        let resolvedDefaults = ExecApprovalsResolvedDefaults(
            security: defaults.security ?? self.defaultSecurity,
            ask: defaults.ask ?? self.defaultAsk,
            askFallback: defaults.askFallback ?? self.defaultAskFallback,
            autoAllowSkills: defaults.autoAllowSkills ?? self.defaultAutoAllowSkills)
        let key = self.agentKey(agentId)
        let agentEntry = file.agents?[key] ?? ExecApprovalsAgent()
        let wildcardEntry = file.agents?["*"] ?? ExecApprovalsAgent()
        let resolvedAgent = ExecApprovalsResolvedDefaults(
            security: agentEntry.security ?? wildcardEntry.security ?? resolvedDefaults.security,
            ask: agentEntry.ask ?? wildcardEntry.ask ?? resolvedDefaults.ask,
            askFallback: agentEntry.askFallback ?? wildcardEntry.askFallback
                ?? resolvedDefaults.askFallback,
            autoAllowSkills: agentEntry.autoAllowSkills ?? wildcardEntry.autoAllowSkills
                ?? resolvedDefaults.autoAllowSkills)
        let allowlist = self.normalizeAllowlistEntries(
            (wildcardEntry.allowlist ?? []) + (agentEntry.allowlist ?? []),
            dropInvalid: true).entries
        let socketPath = self.expandPath(file.socket?.path ?? self.socketPath())
        let token = file.socket?.token ?? ""
        return ExecApprovalsResolved(
            url: self.fileURL(),
            socketPath: socketPath,
            token: token,
            defaults: resolvedDefaults,
            agent: resolvedAgent,
            allowlist: allowlist,
            file: file)
    }

    static func resolveDefaults() -> ExecApprovalsResolvedDefaults {
        let file = self.ensureFile()
        let defaults = file.defaults ?? ExecApprovalsDefaults()
        return ExecApprovalsResolvedDefaults(
            security: defaults.security ?? self.defaultSecurity,
            ask: defaults.ask ?? self.defaultAsk,
            askFallback: defaults.askFallback ?? self.defaultAskFallback,
            autoAllowSkills: defaults.autoAllowSkills ?? self.defaultAutoAllowSkills)
    }

    static func saveDefaults(_ defaults: ExecApprovalsDefaults) {
        self.updateFile { file in
            file.defaults = defaults
        }
    }

    static func updateDefaults(_ mutate: (inout ExecApprovalsDefaults) -> Void) {
        self.updateFile { file in
            var defaults = file.defaults ?? ExecApprovalsDefaults()
            mutate(&defaults)
            file.defaults = defaults
        }
    }

    static func saveAgent(_ agent: ExecApprovalsAgent, agentId: String?) {
        self.updateFile { file in
            var agents = file.agents ?? [:]
            let key = self.agentKey(agentId)
            if agent.isEmpty {
                agents.removeValue(forKey: key)
            } else {
                agents[key] = agent
            }
            file.agents = agents.isEmpty ? nil : agents
        }
    }

    @discardableResult
    static func addAllowlistEntry(agentId: String?, pattern: String) -> ExecAllowlistPatternValidationReason? {
        let normalizedPattern: String
        switch ExecApprovalHelpers.validateAllowlistPattern(pattern) {
        case let .valid(validPattern):
            normalizedPattern = validPattern
        case let .invalid(reason):
            return reason
        }

        self.updateFile { file in
            let key = self.agentKey(agentId)
            var agents = file.agents ?? [:]
            var entry = agents[key] ?? ExecApprovalsAgent()
            var allowlist = entry.allowlist ?? []
            if allowlist.contains(where: { $0.pattern == normalizedPattern }) { return }
            allowlist.append(ExecAllowlistEntry(
                pattern: normalizedPattern,
                lastUsedAt: Date().timeIntervalSince1970 * 1000))
            entry.allowlist = allowlist
            agents[key] = entry
            file.agents = agents
        }
        return nil
    }

    static func recordAllowlistUse(
        agentId: String?,
        pattern: String,
        command: String,
        resolvedPath: String?)
    {
        self.updateFile { file in
            let key = self.agentKey(agentId)
            var agents = file.agents ?? [:]
            var entry = agents[key] ?? ExecApprovalsAgent()
            let allowlist = (entry.allowlist ?? []).map { item -> ExecAllowlistEntry in
                guard item.pattern == pattern else { return item }
                return ExecAllowlistEntry(
                    id: item.id,
                    pattern: item.pattern,
                    lastUsedAt: Date().timeIntervalSince1970 * 1000,
                    lastUsedCommand: command,
                    lastResolvedPath: resolvedPath)
            }
            entry.allowlist = allowlist
            agents[key] = entry
            file.agents = agents
        }
    }

    @discardableResult
    static func updateAllowlist(agentId: String?, allowlist: [ExecAllowlistEntry]) -> [ExecAllowlistRejectedEntry] {
        var rejected: [ExecAllowlistRejectedEntry] = []
        self.updateFile { file in
            let key = self.agentKey(agentId)
            var agents = file.agents ?? [:]
            var entry = agents[key] ?? ExecApprovalsAgent()
            let normalized = self.normalizeAllowlistEntries(allowlist, dropInvalid: true)
            rejected = normalized.rejected
            let cleaned = normalized.entries
            entry.allowlist = cleaned
            agents[key] = entry
            file.agents = agents
        }
        return rejected
    }

    static func updateAgentSettings(agentId: String?, mutate: (inout ExecApprovalsAgent) -> Void) {
        self.updateFile { file in
            let key = self.agentKey(agentId)
            var agents = file.agents ?? [:]
            var entry = agents[key] ?? ExecApprovalsAgent()
            mutate(&entry)
            if entry.isEmpty {
                agents.removeValue(forKey: key)
            } else {
                agents[key] = entry
            }
            file.agents = agents.isEmpty ? nil : agents
        }
    }

    private static func updateFile(_ mutate: (inout ExecApprovalsFile) -> Void) {
        var file = self.ensureFile()
        mutate(&file)
        self.saveFile(file)
    }

    private static func ensureSecureStateDirectory() {
        let url = OpenClawPaths.stateDirURL
        do {
            try FileManager().createDirectory(at: url, withIntermediateDirectories: true)
            try FileManager().setAttributes(
                [.posixPermissions: self.secureStateDirPermissions],
                ofItemAtPath: url.path)
        } catch {
            let message =
                "exec approvals state dir permission hardening failed: \(error.localizedDescription)"
            self.logger
                .warning(
                    "\(message, privacy: .public)")
        }
    }

    private static func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status == errSecSuccess {
            return Data(bytes)
                .base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return UUID().uuidString
    }

    private static func hashRaw(_ raw: String?) -> String {
        let data = Data((raw ?? "").utf8)
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func hashFile(_ file: ExecApprovalsFile) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = (try? encoder.encode(file)) ?? Data()
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func expandPath(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "~" {
            return FileManager().homeDirectoryForCurrentUser.path
        }
        if trimmed.hasPrefix("~/") {
            let suffix = trimmed.dropFirst(2)
            return FileManager().homeDirectoryForCurrentUser
                .appendingPathComponent(String(suffix)).path
        }
        return trimmed
    }

    private static func agentKey(_ agentId: String?) -> String {
        let trimmed = agentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? self.defaultAgentId : trimmed
    }

    private static func normalizedPattern(_ pattern: String?) -> String? {
        switch ExecApprovalHelpers.validateAllowlistPattern(pattern) {
        case let .valid(normalized):
            return normalized.lowercased()
        case .invalid(.empty):
            return nil
        case .invalid:
            let trimmed = pattern?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed.lowercased()
        }
    }

    private static func migrateLegacyPattern(_ entry: ExecAllowlistEntry) -> ExecAllowlistEntry {
        let trimmedPattern = entry.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedResolved = entry.lastResolvedPath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let normalizedResolved = trimmedResolved.isEmpty ? nil : trimmedResolved

        if !ExecApprovalHelpers.patternHasPathSelector(trimmedPattern),
           !trimmedResolved.isEmpty,
           case let .valid(migratedPattern) = ExecApprovalHelpers.validateAllowlistPattern(trimmedResolved)
        {
            return ExecAllowlistEntry(
                id: entry.id,
                pattern: migratedPattern,
                lastUsedAt: entry.lastUsedAt,
                lastUsedCommand: entry.lastUsedCommand,
                lastResolvedPath: normalizedResolved)
        }

        switch ExecApprovalHelpers.validateAllowlistPattern(trimmedPattern) {
        case let .valid(pattern):
            return ExecAllowlistEntry(
                id: entry.id,
                pattern: pattern,
                lastUsedAt: entry.lastUsedAt,
                lastUsedCommand: entry.lastUsedCommand,
                lastResolvedPath: normalizedResolved)
        case .invalid:
            switch ExecApprovalHelpers.validateAllowlistPattern(trimmedResolved) {
            case let .valid(migratedPattern):
                return ExecAllowlistEntry(
                    id: entry.id,
                    pattern: migratedPattern,
                    lastUsedAt: entry.lastUsedAt,
                    lastUsedCommand: entry.lastUsedCommand,
                    lastResolvedPath: normalizedResolved)
            case .invalid:
                return ExecAllowlistEntry(
                    id: entry.id,
                    pattern: trimmedPattern,
                    lastUsedAt: entry.lastUsedAt,
                    lastUsedCommand: entry.lastUsedCommand,
                    lastResolvedPath: normalizedResolved)
            }
        }
    }

    private static func normalizeAllowlistEntries(
        _ entries: [ExecAllowlistEntry],
        dropInvalid: Bool) -> (entries: [ExecAllowlistEntry], rejected: [ExecAllowlistRejectedEntry])
    {
        var normalized: [ExecAllowlistEntry] = []
        normalized.reserveCapacity(entries.count)
        var rejected: [ExecAllowlistRejectedEntry] = []

        for entry in entries {
            let migrated = self.migrateLegacyPattern(entry)
            let trimmedPattern = migrated.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedResolvedPath = migrated.lastResolvedPath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let normalizedResolvedPath = trimmedResolvedPath.isEmpty ? nil : trimmedResolvedPath

            switch ExecApprovalHelpers.validateAllowlistPattern(trimmedPattern) {
            case let .valid(pattern):
                normalized.append(
                    ExecAllowlistEntry(
                        id: migrated.id,
                        pattern: pattern,
                        lastUsedAt: migrated.lastUsedAt,
                        lastUsedCommand: migrated.lastUsedCommand,
                        lastResolvedPath: normalizedResolvedPath))
            case let .invalid(reason):
                if dropInvalid {
                    rejected.append(
                        ExecAllowlistRejectedEntry(
                            id: migrated.id,
                            pattern: trimmedPattern,
                            reason: reason))
                } else if reason != .empty {
                    normalized.append(
                        ExecAllowlistEntry(
                            id: migrated.id,
                            pattern: trimmedPattern,
                            lastUsedAt: migrated.lastUsedAt,
                            lastUsedCommand: migrated.lastUsedCommand,
                            lastResolvedPath: normalizedResolvedPath))
                }
            }
        }

        return (normalized, rejected)
    }

    private static func mergeAgents(
        current: ExecApprovalsAgent,
        legacy: ExecApprovalsAgent) -> ExecApprovalsAgent
    {
        let currentAllowlist = self.normalizeAllowlistEntries(current.allowlist ?? [], dropInvalid: false).entries
        let legacyAllowlist = self.normalizeAllowlistEntries(legacy.allowlist ?? [], dropInvalid: false).entries
        var seen = Set<String>()
        var allowlist: [ExecAllowlistEntry] = []
        func append(_ entry: ExecAllowlistEntry) {
            guard let key = self.normalizedPattern(entry.pattern), !seen.contains(key) else {
                return
            }
            seen.insert(key)
            allowlist.append(entry)
        }
        for entry in currentAllowlist {
            append(entry)
        }
        for entry in legacyAllowlist {
            append(entry)
        }

        return ExecApprovalsAgent(
            security: current.security ?? legacy.security,
            ask: current.ask ?? legacy.ask,
            askFallback: current.askFallback ?? legacy.askFallback,
            autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
            allowlist: allowlist.isEmpty ? nil : allowlist)
    }
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
        if ask == .always { return true }
        if ask == .onMiss, security == .allowlist, allowlistMatch == nil, !skillAllow { return true }
        return false
    }

    static func allowlistPattern(command: [String], resolution: ExecCommandResolution?) -> String? {
        let pattern = resolution?.resolvedPath ?? resolution?.rawExecutable ?? command.first ?? ""
        return pattern.isEmpty ? nil : pattern
    }

    static func patternHasPathSelector(_ pattern: String) -> Bool {
        pattern.contains("/") || pattern.contains("~") || pattern.contains("\\")
    }
}

struct ExecEventPayload: Codable {
    var sessionKey: String
    var runId: String
    var host: String
    var command: String?
    var exitCode: Int?
    var timedOut: Bool?
    var success: Bool?
    var output: String?
    var reason: String?

    static func truncateOutput(_ raw: String, maxChars: Int = 20000) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.count <= maxChars { return trimmed }
        let suffix = trimmed.suffix(maxChars)
        return "... (truncated) \(suffix)"
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
        return URL(fileURLWithPath: trimmed).standardizedFileURL.path
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

                guard let name = self.normalizeSkillBinName(trimmed),
                      let resolvedPath = self.resolveSkillBinPath(trimmed, searchPaths: searchPaths),
                      let normalizedPath = self.normalizeResolvedPath(resolvedPath)
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
