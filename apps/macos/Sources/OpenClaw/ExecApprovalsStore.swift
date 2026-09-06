import CryptoKit
import Darwin
import Foundation
import OpenClawKit
import OSLog
import Security

enum ExecApprovalsMigrationLogEvent: Equatable {
    case required(ExecApprovalsLegacyMigrationRequiredError)
    case recovered(stateDirectoryPath: String)
}

final class ExecApprovalsMigrationRequiredCache: @unchecked Sendable {
    struct FileIdentity: Hashable, Sendable {
        let device: UInt64
        let inode: UInt64
        let modificationSeconds: Int64
        let modificationNanoseconds: Int64
    }

    private struct CachedFailure {
        let error: ExecApprovalsLegacyMigrationRequiredError
        let identity: FileIdentity
    }

    private struct Condition {
        var cachedFailure: CachedFailure?
        var loggedIdentities: Set<FileIdentity?> = []
    }

    private let lock = NSLock()
    private var conditions: [String: Condition] = [:]
    private let identityReader: (URL) -> FileIdentity?
    private let onEvent: (ExecApprovalsMigrationLogEvent) -> Void

    init(
        identityReader: @escaping (URL) -> FileIdentity? = ExecApprovalsMigrationRequiredCache.fileIdentity,
        onEvent: @escaping (ExecApprovalsMigrationLogEvent) -> Void)
    {
        self.identityReader = identityReader
        self.onEvent = onEvent
    }

    func cachedError(stateDirectoryURL: URL) -> ExecApprovalsLegacyMigrationRequiredError? {
        let key = Self.stateDirectoryKey(stateDirectoryURL)
        self.lock.lock()
        defer { self.lock.unlock() }
        guard var condition = self.conditions[key],
              let cachedFailure = condition.cachedFailure
        else { return nil }
        guard self.identityReader(cachedFailure.error.legacyFileURL) == cachedFailure.identity else {
            // A changed path may be Doctor's source -> claim rename. Keep the condition
            // open until a full SQLite resolve succeeds, so that rename cannot log recovery.
            condition.cachedFailure = nil
            self.conditions[key] = condition
            return nil
        }
        return cachedFailure.error
    }

    func record(_ error: ExecApprovalsLegacyMigrationRequiredError) {
        let identity = self.identityReader(error.legacyFileURL)
        let key = Self.stateDirectoryKey(error.stateDirectoryURL)
        self.lock.lock()
        var condition = self.conditions[key] ?? Condition()
        let shouldLog = condition.loggedIdentities.insert(identity).inserted
        condition.cachedFailure = identity.map { CachedFailure(error: error, identity: $0) }
        self.conditions[key] = condition
        self.lock.unlock()
        if shouldLog {
            self.onEvent(.required(error))
        }
    }

    func markResolved(stateDirectoryURL: URL) {
        let key = Self.stateDirectoryKey(stateDirectoryURL)
        self.lock.lock()
        let recovered = self.conditions.removeValue(forKey: key) != nil
        self.lock.unlock()
        if recovered {
            self.onEvent(.recovered(stateDirectoryPath: key))
        }
    }

    private static func stateDirectoryKey(_ url: URL) -> String {
        url.standardizedFileURL.path
    }

    private static func fileIdentity(_ url: URL) -> FileIdentity? {
        var status = stat()
        guard lstat(url.path, &status) == 0 else { return nil }
        return FileIdentity(
            device: UInt64(truncatingIfNeeded: status.st_dev),
            inode: UInt64(truncatingIfNeeded: status.st_ino),
            modificationSeconds: Int64(status.st_mtimespec.tv_sec),
            modificationNanoseconds: Int64(status.st_mtimespec.tv_nsec))
    }
}

enum ExecApprovalsStore {
    // Test stores are task-scoped so parallel suites cannot redirect unrelated
    // shared-state consumers through the process environment.
    @TaskLocal private static var scopedStateDirectoryURL: URL?
    private static let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals")
    private static let migrationRequiredCache = ExecApprovalsMigrationRequiredCache { event in
        switch event {
        case let .required(error):
            Self.logger.error("exec approvals resolve blocked: \(error.localizedDescription, privacy: .public)")
        case let .recovered(stateDirectoryPath):
            Self.logger.info(
                "exec approvals migration requirement cleared for \(stateDirectoryPath, privacy: .public)")
        }
    }

    private static let defaultAgentId = "main"
    // Keep omitted-file behavior aligned with the TypeScript gateway/CLI contract.
    private static let defaultSecurity: ExecSecurity = .full
    private static let defaultAsk: ExecAsk = .off
    private static let defaultAskFallback: ExecSecurity = .deny
    private static let defaultAutoAllowSkills = false
    private static let cwdBoundArgPatternPrefix = "sha256:cwd-argv:v1:"

    #if compiler(>=6.4)
    nonisolated(nonsending) static func withStateDirectory<T>(
        _ url: URL,
        operation: () async throws -> T) async rethrows -> T
    {
        try await self.$scopedStateDirectoryURL.withValue(url) {
            try await operation()
        }
    }
    #else
    static func withStateDirectory<T>(
        _ url: URL,
        operation: () async throws -> T,
        isolation: isolated (any Actor)? = #isolation) async rethrows -> T
    {
        try await self.$scopedStateDirectoryURL.withValue(
            url,
            operation: operation,
            isolation: isolation)
    }
    #endif

    static func databaseURL() -> URL {
        ExecApprovalsSQLiteStore.databaseURL(stateDirectoryURL: self.stateDirURL())
    }

    static func socketPath() -> String {
        self.socketPath(
            stateDirectoryURL: self.stateDirURL(),
            profileActive: AppProfile.current.isActive)
    }

    static func socketPath(stateDirectoryURL: URL, profileActive: Bool) -> String {
        let canonical = stateDirectoryURL.appendingPathComponent("exec-approvals.sock").path
        let maximumLength = MemoryLayout.size(ofValue: sockaddr_un().sun_path)
        guard canonical.utf8.count >= maximumLength, profileActive else {
            return canonical
        }
        let digest = SHA256.hash(data: Data(canonical.utf8))
            .prefix(8)
            .map { String(format: "%02x", $0) }
            .joined()
        return "/tmp/openclaw-\(geteuid())/exec-approvals-\(digest).sock"
    }

    static func resolvedPersistedSocketPath(
        existing: String?,
        stateDirectoryURL: URL,
        computed: String) -> String
    {
        let existing = existing?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let oldCanonical = stateDirectoryURL.appendingPathComponent("exec-approvals.sock").path
        return existing.isEmpty || (existing == oldCanonical && computed != oldCanonical)
            ? computed
            : existing
    }

    private static func homeURL() -> URL {
        guard let configured = OpenClawEnv.path("OPENCLAW_HOME") else {
            return FileManager().homeDirectoryForCurrentUser
        }
        return URL(
            fileURLWithPath: (configured as NSString).expandingTildeInPath,
            isDirectory: true)
    }

    private static func stateDirURL() -> URL {
        if let scopedStateDirectoryURL {
            return scopedStateDirectoryURL
        }
        guard let configured = OpenClawEnv.path("OPENCLAW_STATE_DIR") else {
            return AppProfile.current.stateDirectoryURL(homeDirectory: self.homeURL())
        }
        let home = self.homeURL().path
        let expanded: String = if configured == "~" {
            home
        } else if configured.hasPrefix("~/") {
            URL(fileURLWithPath: home, isDirectory: true)
                .appendingPathComponent(String(configured.dropFirst(2)), isDirectory: true)
                .path
        } else {
            configured
        }
        return URL(fileURLWithPath: expanded, isDirectory: true).standardizedFileURL
    }

    private static func failClosedFallbackFile() -> ExecApprovalsFile {
        ExecApprovalsFile(
            version: 1,
            socket: nil,
            defaults: ExecApprovalsDefaults(
                security: .deny,
                ask: .off,
                askFallback: .deny,
                autoAllowSkills: false),
            agents: [:])
    }

    static func normalizeIncoming(_ file: ExecApprovalsFile) -> ExecApprovalsFile {
        let socketPath = file.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = file.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var agents = file.agents ?? [:]
        if let legacyDefault = agents["default"] {
            if let main = agents[defaultAgentId] {
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
                    let normalized = self.normalizeAllowlistEntries(allowlist)
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
        do {
            let record = try ExecApprovalsSQLiteStore.read(stateDirectoryURL: self.stateDirURL())
            return self.snapshot(record)
        } catch {
            self.logger.warning("exec approvals snapshot read failed: \(error.localizedDescription, privacy: .public)")
            return ExecApprovalsSnapshot(
                path: ExecApprovalsSQLiteStore.locator,
                exists: false,
                hash: "",
                file: self.failClosedFallbackFile())
        }
    }

    private static func snapshot(_ record: ExecApprovalsSQLiteRecord?) -> ExecApprovalsSnapshot {
        guard let record else {
            return ExecApprovalsSnapshot(
                path: ExecApprovalsSQLiteStore.locator,
                exists: false,
                hash: self.hashRaw(nil),
                file: ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:]))
        }
        return ExecApprovalsSnapshot(
            path: ExecApprovalsSQLiteStore.locator,
            exists: true,
            hash: self.hashRaw(record.rawJSON),
            file: self.normalizeIncoming(record.document))
    }

    static func loadFile() -> ExecApprovalsFile {
        do {
            return try self.loadFileForMutation(
                ExecApprovalsSQLiteStore.read(stateDirectoryURL: self.stateDirURL()))
        } catch {
            self.logger.warning("exec approvals read failed: \(error.localizedDescription, privacy: .public)")
            return self.failClosedFallbackFile()
        }
    }

    private static func loadFileForMutation(
        _ record: ExecApprovalsSQLiteRecord?) throws -> ExecApprovalsFile
    {
        self.normalizeIncoming(
            record?.document ?? ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:]))
    }

    static func ensureFile() -> ExecApprovalsFile {
        do {
            return try ExecApprovalsSQLiteStore.withImmediateTransaction(
                stateDirectoryURL: self.stateDirURL())
            { record in
                let ensured = self.ensureFile(record)
                return ExecApprovalsSQLiteMutation(
                    value: ensured.file,
                    documentToWrite: ensured.needsWrite ? ensured.file : nil)
            }
        } catch {
            self.logger.error("exec approvals ensure failed: \(error.localizedDescription, privacy: .public)")
            return self.failClosedFallbackFile()
        }
    }

    private static func ensureFile(
        _ record: ExecApprovalsSQLiteRecord?) -> (file: ExecApprovalsFile, needsWrite: Bool)
    {
        var file = self.normalizeIncoming(
            record?.document ?? ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:]))
        if file.socket == nil {
            file.socket = ExecApprovalsSocketConfig(path: nil, token: nil)
        }
        let existingSocketPath = file.socket?.path
        let resolvedSocketPath = self.resolvedPersistedSocketPath(
            existing: existingSocketPath,
            stateDirectoryURL: self.stateDirURL(),
            computed: self.socketPath())
        file.socket?.path = resolvedSocketPath
        let token = file.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if token.isEmpty {
            file.socket?.token = self.generateToken()
        }
        if file.agents == nil {
            file.agents = [:]
        }
        let needsCanonicalRewrite = record.map { self.rawNeedsAllowlistRewrite($0.rawJSON) } ?? false
        return (file, record?.document != file || needsCanonicalRewrite)
    }

    private static func rawNeedsAllowlistRewrite(_ rawJSON: String) -> Bool {
        guard let data = rawJSON.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let agents = root["agents"] as? [String: Any]
        else { return false }
        for case let agent as [String: Any] in agents.values {
            guard let allowlist = agent["allowlist"] as? [Any] else { continue }
            if allowlist.contains(where: { value in
                guard let entry = value as? [String: Any],
                      let rawID = entry["id"] as? String
                else { return true }
                return rawID.isEmpty || entry["commandText"] != nil
            }) {
                return true
            }
        }
        return false
    }

    static func saveFile(
        _ incoming: ExecApprovalsFile,
        ifBaseHash baseHash: String?) -> ExecApprovalsConditionalSaveResult
    {
        do {
            return try ExecApprovalsSQLiteStore.withImmediateTransaction(
                stateDirectoryURL: self.stateDirURL())
            { record in
                // A conditional write must not create or normalize policy state
                // before it proves the caller still owns the observed snapshot.
                let snapshot = self.snapshot(record)
                let expected = baseHash?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if snapshot.exists {
                    if snapshot.hash.isEmpty {
                        return ExecApprovalsSQLiteMutation(value: .baseHashUnavailable)
                    }
                    if expected.isEmpty {
                        return ExecApprovalsSQLiteMutation(value: .baseHashRequired)
                    }
                    if expected != snapshot.hash {
                        return ExecApprovalsSQLiteMutation(value: .conflict)
                    }
                } else if !expected.isEmpty, expected != snapshot.hash {
                    return ExecApprovalsSQLiteMutation(value: .conflict)
                }

                let current = self.ensureFile(record).file
                var normalized = self.normalizeIncoming(incoming)
                let socketPath = normalized.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines)
                let token = normalized.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines)
                let resolvedPath = (socketPath?.isEmpty == false)
                    ? socketPath!
                    : current.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines) ??
                    self.socketPath()
                let resolvedToken = (token?.isEmpty == false)
                    ? token!
                    : current.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                normalized.socket = ExecApprovalsSocketConfig(path: resolvedPath, token: resolvedToken)
                let rawJSON = try ExecApprovalsSQLiteStore.serialize(normalized)
                let saved = self.snapshot(ExecApprovalsSQLiteRecord(
                    rawJSON: rawJSON,
                    document: normalized))
                return ExecApprovalsSQLiteMutation(value: .saved(saved), documentToWrite: normalized)
            }
        } catch {
            self.logger.error("exec approvals conditional save failed: \(error.localizedDescription, privacy: .public)")
            return .unavailable
        }
    }

    static func resolve(agentId: String?) -> ExecApprovalsResolved {
        switch self.resolveResult(agentId: agentId) {
        case let .success(resolved):
            resolved
        case .failure:
            self.resolveFromFile(self.failClosedFallbackFile(), agentId: agentId)
        }
    }

    static func resolveResult(
        agentId: String?) -> Result<ExecApprovalsResolved, ExecApprovalsReadError>
    {
        let stateDirectoryURL = self.stateDirURL()
        if let error = self.migrationRequiredCache.cachedError(stateDirectoryURL: stateDirectoryURL) {
            return .failure(.migrationRequired(error))
        }
        do {
            let file = try ExecApprovalsSQLiteStore.withImmediateTransaction(
                stateDirectoryURL: stateDirectoryURL)
            { record in
                let ensured = self.ensureFile(record)
                return ExecApprovalsSQLiteMutation(
                    value: ensured.file,
                    documentToWrite: ensured.needsWrite ? ensured.file : nil)
            }
            self.migrationRequiredCache.markResolved(stateDirectoryURL: stateDirectoryURL)
            return .success(self.resolveFromFile(file, agentId: agentId))
        } catch let error as ExecApprovalsLegacyMigrationRequiredError {
            self.migrationRequiredCache.record(error)
            return .failure(.migrationRequired(error))
        } catch {
            self.logger.warning("exec approvals resolve failed: \(error.localizedDescription, privacy: .public)")
            return .failure(.unavailable)
        }
    }

    static func resolveDefaults(from file: ExecApprovalsFile) -> ExecApprovalsResolvedDefaults {
        let defaults = file.defaults ?? ExecApprovalsDefaults()
        return ExecApprovalsResolvedDefaults(
            security: defaults.security ?? self.defaultSecurity,
            ask: defaults.ask ?? self.defaultAsk,
            askFallback: defaults.askFallback ?? self.defaultAskFallback,
            autoAllowSkills: defaults.autoAllowSkills ?? self.defaultAutoAllowSkills)
    }

    private static func resolveFromFile(_ file: ExecApprovalsFile, agentId: String?) -> ExecApprovalsResolved {
        let resolvedDefaults = self.resolveDefaults(from: file)
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
            (wildcardEntry.allowlist ?? []) + (agentEntry.allowlist ?? []))
        let socketPath = self.expandPath(file.socket?.path ?? self.socketPath())
        let token = file.socket?.token ?? ""
        return ExecApprovalsResolved(
            url: self.databaseURL(),
            socketPath: socketPath,
            token: token,
            defaults: resolvedDefaults,
            agent: resolvedAgent,
            allowlist: allowlist,
            file: file)
    }
}

extension ExecApprovalsStore {
    @discardableResult
    static func commitExecution(
        _ commit: ExecApprovalExecutionCommit) -> Result<Void, ExecApprovalsMutationError>
    {
        let grants: [ExecAllowlistUse] = switch commit.authorization {
        case let .explicitAlways(_, _, grants):
            grants
        case .currentPolicy, .askFallback, .autoReview, .explicitOnce:
            []
        }
        let normalizedGrants: [ExecAllowlistUse]
        switch self.normalizeExecutionGrants(grants) {
        case let .success(normalized):
            normalizedGrants = normalized
        case let .failure(error):
            return .failure(error)
        }
        let authorizationUsesByKey = Dictionary(
            commit.uses.map { (self.allowlistEntryMatchKey($0.match), $0) },
            uniquingKeysWith: { first, _ in first })
        let allUsesByKey = Dictionary(
            (commit.uses + normalizedGrants).map { (self.allowlistEntryMatchKey($0.match), $0) },
            uniquingKeysWith: { first, _ in first })

        do {
            try ExecApprovalsSQLiteStore.withImmediateTransaction(
                stateDirectoryURL: self.stateDirURL())
            { record in
                let ensured = self.ensureFile(record)
                var file = ensured.file
                try self.assertCurrentExecutionAuthorization(
                    file: file,
                    agentId: commit.agentId,
                    usesByKey: authorizationUsesByKey,
                    authorization: commit.authorization)
                let grantsChanged = self.applyAllowlistGrantsUnlocked(
                    file: &file,
                    agentId: commit.agentId,
                    grants: normalizedGrants)
                let usesChanged = self.applyAllowlistUsesUnlocked(
                    file: &file,
                    agentId: commit.agentId,
                    usesByKey: allUsesByKey,
                    command: commit.command)
                return ExecApprovalsSQLiteMutation(
                    value: (),
                    documentToWrite: ensured.needsWrite || grantsChanged || usesChanged ? file : nil)
            }
            return .success(())
        } catch {
            self.logger.error("exec approval execution commit failed: \(error.localizedDescription, privacy: .public)")
            return .failure(.unavailable)
        }
    }

    @discardableResult
    static func recordAllowlistUses(
        agentId: String?,
        uses: [ExecAllowlistUse],
        command: String,
        authorization: ExecApprovalAuthorization? = nil) -> Result<Void, ExecApprovalsMutationError>
    {
        if let authorization {
            return self.commitExecution(ExecApprovalExecutionCommit(
                agentId: agentId,
                command: command,
                authorization: authorization,
                uses: uses))
        }
        guard !uses.isEmpty else { return .success(()) }
        let usesByKey = Dictionary(
            uses.map { (self.allowlistEntryMatchKey($0.match), $0) },
            uniquingKeysWith: { first, _ in first })
        do {
            try ExecApprovalsSQLiteStore.withImmediateTransaction(
                stateDirectoryURL: self.stateDirURL())
            { record in
                let ensured = self.ensureFile(record)
                var file = ensured.file
                let changed = self.applyAllowlistUsesUnlocked(
                    file: &file,
                    agentId: agentId,
                    usesByKey: usesByKey,
                    command: command)
                return ExecApprovalsSQLiteMutation(
                    value: (),
                    documentToWrite: ensured.needsWrite || changed ? file : nil)
            }
            return .success(())
        } catch {
            self.logger.error("exec approvals usage update failed: \(error.localizedDescription, privacy: .public)")
            return .failure(.unavailable)
        }
    }

    private static func normalizeExecutionGrants(
        _ grants: [ExecAllowlistUse]) -> Result<[ExecAllowlistUse], ExecApprovalsMutationError>
    {
        var normalized: [ExecAllowlistUse] = []
        normalized.reserveCapacity(grants.count)
        for grant in grants {
            switch ExecApprovalHelpers.validateAllowlistPattern(grant.match.pattern) {
            case let .valid(pattern):
                normalized.append(ExecAllowlistUse(
                    match: ExecAllowlistEntry(
                        id: grant.match.id,
                        pattern: pattern,
                        source: "allow-always",
                        argPattern: self.normalizeArgPattern(grant.match.argPattern)),
                    resolvedPath: grant.resolvedPath))
            case let .invalid(reason):
                return .failure(.invalidPattern(reason))
            }
        }
        return .success(normalized)
    }

    private static func assertCurrentExecutionAuthorization(
        file: ExecApprovalsFile,
        agentId: String?,
        usesByKey: [ExecAllowlistEntryMatchKey: ExecAllowlistUse],
        authorization: ExecApprovalAuthorization) throws
    {
        let current = self.resolveFromFile(file, agentId: agentId)
        let evaluatedSecurity: ExecSecurity
        let evaluatedAsk: ExecAsk?
        let basis: ExecApprovalAuthorization.Basis?
        let appliesFallback: Bool
        switch authorization {
        case let .autoReview(security, policySnapshot):
            guard ExecSecurity.narrower(security, current.agent.security) != .deny,
                  current.agent.ask != .always,
                  policySnapshot.isCurrent(ExecApprovalPolicySnapshot(resolved: current))
            else {
                throw self.executionAuthorizationChangedError()
            }
            return
        case let .explicitOnce(security, policySnapshot):
            guard ExecSecurity.narrower(security, current.agent.security) != .deny,
                  policySnapshot.isCurrent(ExecApprovalPolicySnapshot(resolved: current))
            else {
                throw self.executionAuthorizationChangedError()
            }
            return
        case let .explicitAlways(security, policySnapshot, _):
            guard ExecSecurity.narrower(security, current.agent.security) != .deny,
                  policySnapshot.isCurrent(ExecApprovalPolicySnapshot(resolved: current))
            else {
                throw self.executionAuthorizationChangedError()
            }
            return
        case let .currentPolicy(security, ask, authorizationBasis):
            evaluatedSecurity = security
            evaluatedAsk = ask
            basis = authorizationBasis
            appliesFallback = false
        case let .askFallback(security, authorizationBasis):
            evaluatedSecurity = security
            evaluatedAsk = nil
            basis = authorizationBasis
            appliesFallback = true
        }

        let currentKeys = Set(current.allowlist.map(self.allowlistEntryMatchKey))
        let currentSecurity = ExecSecurity.narrower(evaluatedSecurity, current.agent.security)
        let authorizationSecurity = appliesFallback
            ? ExecSecurity.narrower(currentSecurity, current.agent.askFallback)
            : currentSecurity
        let currentAskAllowsExecution = evaluatedAsk.map {
            ExecAsk.stricter($0, current.agent.ask) == $0
        } ?? true
        let basisIsCurrent: Bool = switch basis {
        case .allowlistEntries:
            !usesByKey.isEmpty && usesByKey.keys.allSatisfy { currentKeys.contains($0) }
        case let .autoAllowedSkill(snapshot):
            // The Gateway can retire while SQLite waits to begin this transaction.
            current.agent.autoAllowSkills && snapshot.isCurrent
        case nil:
            false
        }
        let authorizationIsCurrent: Bool = switch authorizationSecurity {
        case .deny:
            false
        case .full:
            currentAskAllowsExecution && authorizationSecurity == evaluatedSecurity
        case .allowlist:
            currentAskAllowsExecution &&
                authorizationSecurity == evaluatedSecurity &&
                basisIsCurrent
        }
        guard authorizationIsCurrent else {
            throw self.executionAuthorizationChangedError()
        }
    }

    private static func executionAuthorizationChangedError() -> NSError {
        NSError(domain: "ExecApprovals", code: 21, userInfo: [
            NSLocalizedDescriptionKey: "exec approval changed before execution",
        ])
    }

    private static func applyAllowlistGrantsUnlocked(
        file: inout ExecApprovalsFile,
        agentId: String?,
        grants: [ExecAllowlistUse]) -> Bool
    {
        guard !grants.isEmpty else { return false }
        let key = self.agentKey(agentId)
        var agents = file.agents ?? [:]
        var entry = agents[key] ?? ExecApprovalsAgent()
        var allowlist = entry.allowlist ?? []
        let now = Date().timeIntervalSince1970 * 1000
        for grant in grants {
            let incoming = grant.match
            if incoming.argPattern?.hasPrefix(self.cwdBoundArgPatternPrefix) == true {
                // Renewing trust for one executable also clears its inactive
                // pre-cwd grants, which can never authorize after this upgrade.
                allowlist.removeAll { item in
                    item.pattern == incoming.pattern &&
                        item.source == "allow-always" &&
                        item.argPattern?.hasPrefix(self.cwdBoundArgPatternPrefix) != true
                }
            }
            if let index = allowlist.firstIndex(where: {
                self.allowlistEntryMatchKey($0) == self.allowlistEntryMatchKey(incoming)
            }) {
                allowlist[index].source = "allow-always"
                allowlist[index].lastUsedAt = now
                continue
            }
            allowlist.append(ExecAllowlistEntry(
                pattern: incoming.pattern,
                source: "allow-always",
                argPattern: incoming.argPattern,
                lastUsedAt: now))
        }
        entry.allowlist = allowlist
        agents[key] = entry
        file.agents = agents
        return true
    }

    private static func applyAllowlistUsesUnlocked(
        file: inout ExecApprovalsFile,
        agentId: String?,
        usesByKey: [ExecAllowlistEntryMatchKey: ExecAllowlistUse],
        command: String) -> Bool
    {
        guard !usesByKey.isEmpty else { return false }
        let key = self.agentKey(agentId)
        let targetKeys = key == "*" ? [key] : ["*", key]
        let now = Date().timeIntervalSince1970 * 1000
        var changed = false
        var agents = file.agents ?? [:]
        for targetKey in targetKeys {
            guard var entry = agents[targetKey], let currentAllowlist = entry.allowlist else { continue }
            var entryChanged = false
            let allowlist = currentAllowlist.map { item -> ExecAllowlistEntry in
                guard let use = usesByKey[self.allowlistEntryMatchKey(item)] else { return item }
                entryChanged = true
                return ExecAllowlistEntry(
                    id: item.id,
                    pattern: item.pattern,
                    source: item.source,
                    argPattern: item.argPattern,
                    lastUsedAt: now,
                    lastUsedCommand: self.shouldRecordLastUsedCommand(for: item) ? command : nil,
                    lastResolvedPath: use.resolvedPath)
            }
            if entryChanged {
                changed = true
                entry.allowlist = allowlist
                agents[targetKey] = entry
            }
        }
        if changed {
            file.agents = agents
        }
        return changed
    }

    private static func shouldRecordLastUsedCommand(for entry: ExecAllowlistEntry) -> Bool {
        !(entry.argPattern?.hasPrefix("sha256:") ?? false)
    }

    private static func normalizeArgPattern(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    static func allowlistEntryMatchKey(_ entry: ExecAllowlistEntry) -> ExecAllowlistEntryMatchKey {
        ExecAllowlistEntryMatchKey(
            pattern: entry.pattern,
            argPattern: entry.argPattern)
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
        let hash = digest.map { String(format: "%02x", $0) }.joined()
        return raw == nil ? "missing:\(hash)" : hash
    }

    static func expandPath(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let configuredHome = OpenClawEnv.path("OPENCLAW_HOME")
            .map { ($0 as NSString).expandingTildeInPath }
        let home = configuredHome.map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager().homeDirectoryForCurrentUser
        if trimmed == "~" {
            return home.path
        }
        if trimmed.hasPrefix("~/") {
            let suffix = trimmed.dropFirst(2)
            return home.appendingPathComponent(String(suffix)).path
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
            normalized.lowercased()
        case .invalid:
            nil
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
                source: entry.source,
                commandText: entry.commandText,
                argPattern: entry.argPattern,
                lastUsedAt: entry.lastUsedAt,
                lastUsedCommand: entry.lastUsedCommand,
                lastResolvedPath: normalizedResolved)
        }

        switch ExecApprovalHelpers.validateAllowlistPattern(trimmedPattern) {
        case let .valid(pattern):
            return ExecAllowlistEntry(
                id: entry.id,
                pattern: pattern,
                source: entry.source,
                commandText: entry.commandText,
                argPattern: entry.argPattern,
                lastUsedAt: entry.lastUsedAt,
                lastUsedCommand: entry.lastUsedCommand,
                lastResolvedPath: normalizedResolved)
        case .invalid:
            switch ExecApprovalHelpers.validateAllowlistPattern(trimmedResolved) {
            case let .valid(migratedPattern):
                return ExecAllowlistEntry(
                    id: entry.id,
                    pattern: migratedPattern,
                    source: entry.source,
                    commandText: entry.commandText,
                    argPattern: entry.argPattern,
                    lastUsedAt: entry.lastUsedAt,
                    lastUsedCommand: entry.lastUsedCommand,
                    lastResolvedPath: normalizedResolved)
            case .invalid:
                return ExecAllowlistEntry(
                    id: entry.id,
                    pattern: trimmedPattern,
                    source: entry.source,
                    commandText: entry.commandText,
                    argPattern: entry.argPattern,
                    lastUsedAt: entry.lastUsedAt,
                    lastUsedCommand: entry.lastUsedCommand,
                    lastResolvedPath: normalizedResolved)
            }
        }
    }

    private static func normalizeAllowlistEntries(_ entries: [ExecAllowlistEntry]) -> [ExecAllowlistEntry] {
        var normalized: [ExecAllowlistEntry] = []
        normalized.reserveCapacity(entries.count)

        for entry in entries {
            var migrated = self.migrateLegacyPattern(entry)
            // Command text can contain secrets; it is accepted only for legacy decode.
            migrated.commandText = nil
            // Regex whitespace and Unicode normalization are semantic policy bytes.
            let normalizedArgPattern = self.normalizeArgPattern(migrated.argPattern)
            let trimmedPattern = migrated.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedResolvedPath = migrated.lastResolvedPath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let normalizedResolvedPath = trimmedResolvedPath.isEmpty ? nil : trimmedResolvedPath

            switch ExecApprovalHelpers.validateAllowlistPattern(trimmedPattern) {
            case let .valid(pattern):
                normalized.append(
                    ExecAllowlistEntry(
                        id: migrated.id,
                        pattern: pattern,
                        source: migrated.source,
                        commandText: migrated.commandText,
                        argPattern: normalizedArgPattern,
                        lastUsedAt: migrated.lastUsedAt,
                        lastUsedCommand: migrated.lastUsedCommand,
                        lastResolvedPath: normalizedResolvedPath))
            case .invalid:
                continue
            }
        }

        return normalized
    }

    private static func mergeAgents(
        current: ExecApprovalsAgent,
        legacy: ExecApprovalsAgent) -> ExecApprovalsAgent
    {
        let currentAllowlist = self.normalizeAllowlistEntries(current.allowlist ?? [])
        let legacyAllowlist = self.normalizeAllowlistEntries(legacy.allowlist ?? [])
        var seen = Set<ExecAllowlistEntryMatchKey>()
        var allowlist: [ExecAllowlistEntry] = []
        func append(_ entry: ExecAllowlistEntry) {
            guard let patternKey = normalizedPattern(entry.pattern) else {
                return
            }
            let key = ExecAllowlistEntryMatchKey(
                pattern: patternKey,
                argPattern: entry.argPattern)
            guard !seen.contains(key) else {
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
