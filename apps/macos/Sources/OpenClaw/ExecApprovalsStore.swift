import CryptoKit
import Darwin
import Foundation
import OSLog
import Security

enum ExecApprovalsStore {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals")
    private static let defaultAgentId = "main"
    // Keep omitted-file behavior aligned with the TypeScript gateway/CLI contract.
    private static let defaultSecurity: ExecSecurity = .full
    private static let defaultAsk: ExecAsk = .off
    private static let defaultAskFallback: ExecSecurity = .deny
    private static let defaultAutoAllowSkills = false
    private static let secureStateDirPermissions = 0o700

    private enum LegacyMigrationResult {
        case notNeeded
        case migrated
        case blocked
    }

    /// Match the TypeScript writer's `<approvals>.lock` protocol. Both processes
    /// must cover the complete read-modify-write transaction or a stale native
    /// usage update can restore policy that an administrator just revoked.
    private static func withWriteLock<T>(_ body: () throws -> T) throws -> T {
        let fileURL = self.fileURL()
        let trustedRoot = self.trustedRootURL()
        try ExecApprovalsFileIO.assertSafeParentChain(of: fileURL, trustedRoot: trustedRoot)
        try self.ensureSecureStateDirectory()
        return try ExecApprovalsFileIO.withLock(
            fileURL: fileURL,
            trustedRoot: trustedRoot,
            body)
    }

    static func fileURL() -> URL {
        self.stateDirURL().appendingPathComponent("exec-approvals.json")
    }

    static func socketPath() -> String {
        self.stateDirURL().appendingPathComponent("exec-approvals.sock").path
    }

    private static func trustedRootURL() -> URL {
        guard let configured = OpenClawEnv.path("OPENCLAW_HOME") else {
            return FileManager().homeDirectoryForCurrentUser
        }
        return URL(
            fileURLWithPath: (configured as NSString).expandingTildeInPath,
            isDirectory: true)
    }

    private static func stateDirURL() -> URL {
        guard let configured = OpenClawEnv.path("OPENCLAW_STATE_DIR") else {
            return self.trustedRootURL().appendingPathComponent(".openclaw", isDirectory: true)
        }
        let home = self.trustedRootURL().path
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

    private static func legacyStateDirURLs() -> [URL] {
        if OpenClawEnv.path("OPENCLAW_HOME") != nil {
            var urls = [
                self.trustedRootURL()
                    .appendingPathComponent(".openclaw", isDirectory: true),
            ]
            let osHomeURL = FileManager().homeDirectoryForCurrentUser
                .appendingPathComponent(".openclaw", isDirectory: true)
            if !urls.contains(where: {
                $0.standardizedFileURL.path == osHomeURL.standardizedFileURL.path
            }) {
                urls.append(osHomeURL)
            }
            return urls
        }
        return [
            FileManager().homeDirectoryForCurrentUser
                .appendingPathComponent(".openclaw", isDirectory: true),
        ]
    }

    private static func legacyFileURLIfPending() -> URL? {
        guard OpenClawEnv.path("OPENCLAW_STATE_DIR") != nil || OpenClawEnv.path("OPENCLAW_HOME") != nil
        else { return nil }
        let targetURL = self.fileURL()
        for stateDirURL in self.legacyStateDirURLs() {
            let legacyURL = stateDirURL
                .appendingPathComponent("exec-approvals.json", isDirectory: false)
            guard legacyURL.standardizedFileURL.path != targetURL.standardizedFileURL.path else {
                continue
            }
            guard ExecApprovalsFileIO.pathExistsNoFollow(legacyURL) else { continue }
            guard !ExecApprovalsFileIO.pathExistsNoFollow(targetURL) else { return nil }
            return legacyURL
        }
        return nil
    }

    private static func unmigratedLegacyFallbackFile() -> ExecApprovalsFile {
        ExecApprovalsFile(
            version: 1,
            socket: nil,
            defaults: ExecApprovalsDefaults(
                security: .deny,
                ask: .always,
                askFallback: .deny,
                autoAllowSkills: false),
            agents: [:])
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

    private static func isLegacyDefaultSocketPath(_ raw: String, legacyFileURL: URL) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return true
        }
        let expanded = self.expandPath(trimmed)
        let legacySocket = legacyFileURL.deletingLastPathComponent()
            .appendingPathComponent("exec-approvals.sock", isDirectory: false)
            .path
        return URL(fileURLWithPath: expanded).standardizedFileURL.path
            == URL(fileURLWithPath: legacySocket).standardizedFileURL.path
    }

    private static func archiveMigratedLegacyFile(_ legacyURL: URL) throws -> URL {
        let manager = FileManager()
        var archiveURL = URL(fileURLWithPath: "\(legacyURL.path).migrated")
        if manager.fileExists(atPath: archiveURL.path) {
            archiveURL = URL(fileURLWithPath: "\(archiveURL.path)-\(UUID().uuidString)")
        }
        try manager.moveItem(at: legacyURL, to: archiveURL)
        return archiveURL
    }

    private static func writeMigratedFileExclusively(_ data: Data, to targetURL: URL) throws -> Bool {
        let tempURL = targetURL.deletingLastPathComponent()
            .appendingPathComponent(".exec-approvals.migration.\(UUID().uuidString)")
        let fd = open(tempURL.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        if fd == -1 {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        var closed = false
        defer {
            if !closed {
                close(fd)
            }
        }
        do {
            try data.withUnsafeBytes { rawBuffer in
                guard let base = rawBuffer.baseAddress else { return }
                var offset = 0
                while offset < rawBuffer.count {
                    let written = Darwin.write(
                        fd,
                        base.advanced(by: offset),
                        rawBuffer.count - offset)
                    if written < 0 {
                        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                    }
                    offset += written
                }
            }
            close(fd)
            closed = true
            // Publish the complete 0600 temp inode atomically without replacing
            // policy a mixed-version writer may have created meanwhile.
            let renamed = renamex_np(tempURL.path, targetURL.path, UInt32(RENAME_EXCL))
            if renamed == -1 {
                let code = errno
                try? FileManager().removeItem(at: tempURL)
                if code == EEXIST {
                    return false
                }
                throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
            }
            return true
        } catch {
            try? FileManager().removeItem(at: tempURL)
            throw error
        }
    }

    private static func migrateLegacyFileIfNeeded() -> LegacyMigrationResult {
        guard let legacyURL = legacyFileURLIfPending() else { return .notNeeded }
        let targetURL = self.fileURL()
        do {
            let trustedRoot = self.trustedRootURL()
            try ExecApprovalsFileIO.assertSafeParentChain(of: targetURL, trustedRoot: trustedRoot)
            let effectiveLegacyDir = trustedRoot.appendingPathComponent(".openclaw", isDirectory: true)
            let legacyRoot = legacyURL.deletingLastPathComponent().standardizedFileURL.path
                == effectiveLegacyDir.standardizedFileURL.path
                ? trustedRoot
                : FileManager().homeDirectoryForCurrentUser
            // ensureFileUnlocked already owns the target lock. Always take the
            // legacy lock second so migration cannot race an older writer and
            // two migrating processes cannot deadlock with opposite lock order.
            return try ExecApprovalsFileIO.withLock(
                fileURL: legacyURL,
                trustedRoot: legacyRoot)
            {
                if ExecApprovalsFileIO.pathExistsNoFollow(targetURL) {
                    return .notNeeded
                }
                guard ExecApprovalsFileIO.pathExistsNoFollow(legacyURL) else {
                    throw NSError(domain: "ExecApprovals", code: 10, userInfo: [
                        NSLocalizedDescriptionKey: "legacy exec approvals disappeared during migration",
                    ])
                }
                return try self.migrateLegacyFileLocked(
                    legacyURL: legacyURL,
                    legacyRoot: legacyRoot,
                    targetURL: targetURL,
                    trustedRoot: trustedRoot)
            }
        } catch {
            self.logger
                .error(
                    "exec approvals legacy migration failed: \(error.localizedDescription, privacy: .public)")
            return .blocked
        }
    }

    private static func migrateLegacyFileLocked(
        legacyURL: URL,
        legacyRoot: URL,
        targetURL: URL,
        trustedRoot: URL) throws -> LegacyMigrationResult
    {
        guard let legacy = try ExecApprovalsFileIO.read(at: legacyURL, trustedRoot: legacyRoot) else {
            throw NSError(domain: "ExecApprovals", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "legacy exec approvals disappeared during migration",
            ])
        }
        let data = legacy.data
        guard self.hasValidPersistedStructure(data) else {
            throw NSError(domain: "ExecApprovals", code: 13, userInfo: [
                NSLocalizedDescriptionKey: "invalid legacy approvals structure",
            ])
        }
        var file = try JSONDecoder().decode(ExecApprovalsFile.self, from: data)
        guard file.version == 1 else {
            throw NSError(domain: "ExecApprovals", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "unsupported legacy approvals version",
            ])
        }
        file = self.normalizeIncoming(file)
        let rawSocketPath = file.socket?.path?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if self.isLegacyDefaultSocketPath(rawSocketPath, legacyFileURL: legacyURL) {
            if file.socket == nil {
                file.socket = ExecApprovalsSocketConfig(path: nil, token: nil)
            }
            file.socket?.path = self.socketPath()
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let migrated = try encoder.encode(file)
        try self.ensureSecureStateDirectory()
        try FileManager().createDirectory(
            at: targetURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try ExecApprovalsFileIO.assertSafeParentChain(of: targetURL, trustedRoot: trustedRoot)
        if ExecApprovalsFileIO.pathExistsNoFollow(targetURL) {
            return .notNeeded
        }
        let created = try writeMigratedFileExclusively(migrated, to: targetURL)
        if !created {
            return .notNeeded
        }
        do {
            _ = try self.archiveMigratedLegacyFile(legacyURL)
        } catch {
            self.logger
                .warning(
                    "exec approvals legacy archive failed: \(error.localizedDescription, privacy: .public)")
        }
        return .migrated
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
        do {
            return try self.withWriteLock {
                try self.readSnapshotUnlocked()
            }
        } catch {
            self.logger.warning("exec approvals snapshot lock failed: \(error.localizedDescription, privacy: .public)")
            return ExecApprovalsSnapshot(
                path: self.fileURL().path,
                exists: ExecApprovalsFileIO.pathExistsNoFollow(self.fileURL()),
                hash: "",
                file: self.failClosedFallbackFile())
        }
    }

    static func ensureSnapshotResult()
        -> Result<ExecApprovalsSnapshot, ExecApprovalsReadError>
    {
        do {
            let snapshot = try self.withWriteLock {
                _ = try self.ensureFileUnlocked()
                return try self.readSnapshotUnlocked()
            }
            return .success(snapshot)
        } catch {
            self.logger.warning(
                "exec approvals snapshot unavailable: \(error.localizedDescription, privacy: .public)")
            return .failure(.unavailable)
        }
    }

    private static func readSnapshotUnlocked() throws -> ExecApprovalsSnapshot {
        if self.legacyFileURLIfPending() != nil {
            let file = self.unmigratedLegacyFallbackFile()
            return ExecApprovalsSnapshot(
                path: self.fileURL().path,
                exists: false,
                hash: self.hashRaw(nil),
                file: file)
        }
        let url = self.fileURL()
        guard let current = try ExecApprovalsFileIO.read(at: url, trustedRoot: self.trustedRootURL()) else {
            return ExecApprovalsSnapshot(
                path: url.path,
                exists: false,
                hash: self.hashRaw(nil),
                file: ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:]))
        }
        let raw = String(bytes: current.data, encoding: .utf8) ?? ""
        let decoded = (try? self.decodeCurrentFile(current.data))
            .map(self.normalizeIncoming) ?? self.failClosedFallbackFile()
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
        if self.legacyFileURLIfPending() != nil {
            return self.ensureFile()
        }
        do {
            return try self.withWriteLock {
                self.loadFileUnlocked()
            }
        } catch {
            self.logger.warning("exec approvals read lock failed: \(error.localizedDescription, privacy: .public)")
            return self.failClosedFallbackFile()
        }
    }

    private static func loadFileUnlocked() -> ExecApprovalsFile {
        do {
            return try self.loadFileForMutationUnlocked()
        } catch {
            self.logger.warning("exec approvals load failed: \(error.localizedDescription, privacy: .public)")
            return self.failClosedFallbackFile()
        }
    }

    /// Existing unreadable files are policy state, not equivalent to an absent
    /// file. Mutations must fail instead of replacing them with permissive defaults.
    private static func loadFileForMutationUnlocked() throws -> ExecApprovalsFile {
        let url = self.fileURL()
        guard let current = try ExecApprovalsFileIO.read(at: url, trustedRoot: self.trustedRootURL()) else {
            return ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:])
        }
        return try self.normalizeIncoming(self.decodeCurrentFile(current.data))
    }

    private static func decodeCurrentFile(_ data: Data) throws -> ExecApprovalsFile {
        guard self.hasValidPersistedStructure(data) else {
            throw NSError(domain: "ExecApprovals", code: 13, userInfo: [
                NSLocalizedDescriptionKey: "invalid exec approvals structure",
            ])
        }
        let decoded = try JSONDecoder().decode(ExecApprovalsFile.self, from: data)
        guard decoded.version == 1 else {
            throw NSError(domain: "ExecApprovals", code: 12, userInfo: [
                NSLocalizedDescriptionKey: "unsupported exec approvals version \(decoded.version)",
            ])
        }
        return decoded
    }

    private static func fileNeedsAllowlistRewrite(_ data: Data) -> Bool {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let agents = root["agents"] as? [String: Any]
        else { return false }
        for case let agent as [String: Any] in agents.values {
            guard let allowlist = agent["allowlist"] as? [Any] else { continue }
            if allowlist.contains(where: { value in
                guard let entry = value as? [String: Any] else { return true }
                guard let rawID = entry["id"] as? String else { return true }
                return rawID.isEmpty || entry["commandText"] != nil
            }) {
                return true
            }
        }
        return false
    }

    private static func hasValidPersistedStructure(_ data: Data) -> Bool {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = root["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(),
              version.doubleValue == 1
        else { return false }

        if let socket = root["socket"] {
            guard let object = socket as? [String: Any],
                  self.hasOptionalString(object, key: "path"),
                  self.hasOptionalString(object, key: "token")
            else { return false }
        }
        if let defaults = root["defaults"], !self.hasValidPolicyFields(defaults) {
            return false
        }
        if let agents = root["agents"] {
            guard let object = agents as? [String: Any] else { return false }
            for value in object.values {
                guard self.hasValidPolicyFields(value), let agent = value as? [String: Any] else { return false }
                if let allowlist = agent["allowlist"] {
                    guard let entries = allowlist as? [Any],
                          entries.allSatisfy(self.hasValidAllowlistEntry)
                    else { return false }
                }
            }
        }
        return true
    }

    private static func hasValidAllowlistEntry(_ value: Any) -> Bool {
        if let pattern = value as? String {
            return !pattern.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard let object = value as? [String: Any],
              let pattern = object["pattern"] as? String,
              !pattern.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return false }
        for key in ["id", "source", "commandText", "argPattern", "lastUsedCommand", "lastResolvedPath"] {
            if let value = object[key], !(value is String) {
                return false
            }
        }
        if let lastUsedAt = object["lastUsedAt"] {
            guard let number = lastUsedAt as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite
            else { return false }
        }
        return true
    }

    private static func hasValidPolicyFields(_ value: Any) -> Bool {
        guard let object = value as? [String: Any] else { return false }
        if let security = object["security"] {
            guard let raw = security as? String, ExecSecurity(rawValue: raw) != nil else { return false }
        }
        if let ask = object["ask"] {
            guard let raw = ask as? String, ExecAsk(rawValue: raw) != nil else { return false }
        }
        if let fallback = object["askFallback"] {
            guard let raw = fallback as? String, ExecSecurity(rawValue: raw) != nil else { return false }
        }
        if let autoAllowSkills = object["autoAllowSkills"], !(autoAllowSkills is Bool) {
            return false
        }
        return true
    }

    private static func hasOptionalString(_ object: [String: Any], key: String) -> Bool {
        guard let value = object[key] else { return true }
        return value is String
    }

    private static func saveFileUnlocked(_ file: ExecApprovalsFile) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(self.normalizeIncoming(file))
        let url = self.fileURL()
        try self.ensureSecureStateDirectory()
        try FileManager().createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try ExecApprovalsFileIO.write(data, to: url, trustedRoot: self.trustedRootURL())
    }

    static func ensureFile() -> ExecApprovalsFile {
        do {
            return try self.withWriteLock {
                try self.ensureFileUnlocked()
            }
        } catch {
            self.logger.error("exec approvals ensure failed: \(error.localizedDescription, privacy: .public)")
            return self.failClosedFallbackFile()
        }
    }

    private static func ensureFileUnlocked() throws -> ExecApprovalsFile {
        if self.legacyFileURLIfPending() != nil {
            switch self.migrateLegacyFileIfNeeded() {
            case .migrated, .notNeeded:
                break
            case .blocked:
                throw NSError(domain: "ExecApprovals", code: 18, userInfo: [
                    NSLocalizedDescriptionKey: "legacy exec approvals migration blocked",
                ])
            }
        }
        try self.ensureSecureStateDirectory()
        let url = self.fileURL()
        let current = try ExecApprovalsFileIO.read(at: url, trustedRoot: self.trustedRootURL())
        let existed = current != nil
        let needsAllowlistRewrite = current.map { self.fileNeedsAllowlistRewrite($0.data) } ?? false
        let loaded = try current.map { try self.decodeCurrentFile($0.data) }
            ?? ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:])
        let loadedHash = self.hashFile(loaded)

        var file = self.normalizeIncoming(loaded)
        if file.socket == nil {
            file.socket = ExecApprovalsSocketConfig(path: nil, token: nil)
        }
        let path = file.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if path.isEmpty {
            file.socket?.path = self.socketPath()
        }
        let token = file.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if token.isEmpty {
            file.socket?.token = self.generateToken()
        }
        if file.agents == nil {
            file.agents = [:]
        }
        if !existed || needsAllowlistRewrite || current?.linkCount != 1 || loadedHash != self.hashFile(file) {
            try self.saveFileUnlocked(file)
        }
        return file
    }

    static func saveFile(
        _ incoming: ExecApprovalsFile,
        ifBaseHash baseHash: String?) -> ExecApprovalsConditionalSaveResult
    {
        do {
            return try self.withWriteLock {
                let current = try self.ensureFileUnlocked()
                let snapshot = try self.readSnapshotUnlocked()
                if snapshot.exists {
                    if snapshot.hash.isEmpty {
                        return .baseHashUnavailable
                    }
                    let expected = baseHash?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if expected.isEmpty {
                        return .baseHashRequired
                    }
                    if expected != snapshot.hash {
                        return .conflict
                    }
                }

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

                try self.saveFileUnlocked(normalized)
                return try .saved(self.readSnapshotUnlocked())
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
        do {
            let file = try self.withWriteLock {
                try self.ensureFileUnlocked()
            }
            return .success(self.resolveFromFile(file, agentId: agentId))
        } catch {
            self.logger.warning("exec approvals resolve failed: \(error.localizedDescription, privacy: .public)")
            return .failure(.unavailable)
        }
    }

    static func resolveAsyncResult(
        agentId: String?) async -> Result<ExecApprovalsResolved, ExecApprovalsReadError>
    {
        await Task.detached(priority: .userInitiated) {
            self.resolveResult(agentId: agentId)
        }.value
    }

    /// Read-only resolve: loads file without writing (no ensureFile side effects).
    /// Safe to call from background threads / off MainActor.
    static func resolveReadOnly(agentId: String?) -> ExecApprovalsResolved {
        let file: ExecApprovalsFile
        do {
            file = try self.withWriteLock {
                guard self.legacyFileURLIfPending() == nil else {
                    return self.unmigratedLegacyFallbackFile()
                }
                return self.loadFileUnlocked()
            }
        } catch {
            self.logger.warning("exec approvals read-only lock failed: \(error.localizedDescription, privacy: .public)")
            file = self.failClosedFallbackFile()
        }
        return self.resolveFromFile(file, agentId: agentId)
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

    static func resolveDefaultsResult() -> Result<ExecApprovalsResolvedDefaults, ExecApprovalsReadError> {
        self.resolveResult(agentId: nil).map(\.defaults)
    }

    static func resolveDefaultsAsyncResult() async
        -> Result<ExecApprovalsResolvedDefaults, ExecApprovalsReadError>
    {
        await self.resolveAsyncResult(agentId: nil).map(\.defaults)
    }
}

extension ExecApprovalsStore {
    @discardableResult
    static func updateDefaults(
        _ mutate: (inout ExecApprovalsDefaults) -> Void) -> Result<Void, ExecApprovalsMutationError>
    {
        self.updateFile { file in
            var defaults = file.defaults ?? ExecApprovalsDefaults()
            mutate(&defaults)
            file.defaults = defaults
        }
    }

    @discardableResult
    static func addAllowlistEntry(
        agentId: String?,
        pattern: String,
        source: String? = nil,
        commandText: String? = nil,
        argPattern: String? = nil) -> Result<Void, ExecApprovalsMutationError>
    {
        self.addAllowlistEntries(
            agentId: agentId,
            entries: [ExecAllowlistEntry(
                pattern: pattern,
                source: source,
                commandText: commandText,
                argPattern: argPattern)])
    }

    @discardableResult
    static func addAllowlistEntries(
        agentId: String?,
        entries: [ExecAllowlistEntry]) -> Result<Void, ExecApprovalsMutationError>
    {
        var normalizedEntries: [ExecAllowlistEntry] = []
        normalizedEntries.reserveCapacity(entries.count)
        for var item in entries {
            switch ExecApprovalHelpers.validateAllowlistPattern(item.pattern) {
            case let .valid(pattern):
                item.pattern = pattern
            case let .invalid(reason):
                return .failure(.invalidPattern(reason))
            }
            item.commandText = nil
            item.argPattern = self.normalizeArgPattern(item.argPattern)
            normalizedEntries.append(item)
        }

        return self.updateFile { file in
            let key = self.agentKey(agentId)
            var agents = file.agents ?? [:]
            var entry = agents[key] ?? ExecApprovalsAgent()
            var allowlist = entry.allowlist ?? []
            let now = Date().timeIntervalSince1970 * 1000
            for incoming in normalizedEntries {
                if let index = allowlist.firstIndex(where: {
                    self.allowlistEntryMatchKey($0) == self.allowlistEntryMatchKey(incoming)
                }) {
                    if let source = incoming.source {
                        allowlist[index].source = source
                    }
                    allowlist[index].lastUsedAt = now
                    continue
                }
                allowlist.append(ExecAllowlistEntry(
                    pattern: incoming.pattern,
                    source: incoming.source,
                    argPattern: incoming.argPattern,
                    lastUsedAt: now))
            }
            entry.allowlist = allowlist
            agents[key] = entry
            file.agents = agents
        }
    }

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
            try self.withWriteLock {
                var file = try self.ensureFileUnlocked()
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
                if grantsChanged || usesChanged {
                    try self.saveFileUnlocked(file)
                }
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
            try self.withWriteLock {
                var file = try self.ensureFileUnlocked()
                if self.applyAllowlistUsesUnlocked(
                    file: &file,
                    agentId: agentId,
                    usesByKey: usesByKey,
                    command: command)
                {
                    try self.saveFileUnlocked(file)
                }
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
        let currentKeys = Set(current.allowlist.map(self.allowlistEntryMatchKey))
        let evaluatedSecurity: ExecSecurity
        let evaluatedAsk: ExecAsk?
        let basis: ExecApprovalAuthorization.Basis?
        let appliesFallback: Bool
        switch authorization {
        case let .autoReview(security):
            guard ExecSecurity.narrower(security, current.agent.security) != .deny,
                  current.agent.ask != .always
            else {
                throw self.executionAuthorizationChangedError()
            }
            return
        case let .explicitOnce(security):
            guard ExecSecurity.narrower(security, current.agent.security) != .deny else {
                throw self.executionAuthorizationChangedError()
            }
            return
        case let .explicitAlways(security, policySnapshot, _):
            let currentSnapshot = ExecApprovalPolicySnapshot(
                security: current.agent.security,
                ask: current.agent.ask,
                askFallback: current.agent.askFallback,
                autoAllowSkills: current.agent.autoAllowSkills,
                allowlist: current.allowlist)
            guard ExecSecurity.narrower(security, current.agent.security) != .deny,
                  policySnapshot.isCurrent(currentSnapshot)
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
        case .autoAllowedSkill:
            current.agent.autoAllowSkills
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
                    lastUsedCommand: command,
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

    @discardableResult
    static func updateAllowlistEntry(
        agentId: String?,
        id: String,
        pattern: String) -> Result<Void, ExecApprovalsMutationError>
    {
        let normalizedPattern: String
        switch ExecApprovalHelpers.validateAllowlistPattern(pattern) {
        case let .valid(validPattern):
            normalizedPattern = validPattern
        case let .invalid(reason):
            return .failure(.invalidPattern(reason))
        }

        return self.updateFile { file in
            let key = self.agentKey(agentId)
            var agents = file.agents ?? [:]
            var agent = agents[key] ?? ExecApprovalsAgent()
            var allowlist = agent.allowlist ?? []
            guard let index = allowlist.firstIndex(where: { $0.id == id }) else { return }
            allowlist[index].pattern = normalizedPattern
            agent.allowlist = allowlist
            agents[key] = agent
            file.agents = agents
        }
    }

    @discardableResult
    static func removeAllowlistEntry(
        agentId: String?,
        id: String) -> Result<Void, ExecApprovalsMutationError>
    {
        self.updateFile { file in
            let key = self.agentKey(agentId)
            var agents = file.agents ?? [:]
            var agent = agents[key] ?? ExecApprovalsAgent()
            let allowlist = (agent.allowlist ?? []).filter { $0.id != id }
            agent.allowlist = allowlist
            agents[key] = agent
            file.agents = agents
        }
    }

    @discardableResult
    static func updateAgentSettings(
        agentId: String?,
        mutate: (inout ExecApprovalsAgent) -> Void) -> Result<Void, ExecApprovalsMutationError>
    {
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

    private static func updateFile(
        _ mutate: (inout ExecApprovalsFile) -> Void) -> Result<Void, ExecApprovalsMutationError>
    {
        do {
            try self.withWriteLock {
                var file = try self.ensureFileUnlocked()
                mutate(&file)
                try self.saveFileUnlocked(file)
            }
            return .success(())
        } catch {
            self.logger.error("exec approvals update failed: \(error.localizedDescription, privacy: .public)")
            return .failure(.unavailable)
        }
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

    private static func ensureSecureStateDirectory() throws {
        let url = self.stateDirURL()
        try FileManager().createDirectory(at: url, withIntermediateDirectories: true)
        try ExecApprovalsFileIO.assertSafeDirectory(at: url)
        try FileManager().setAttributes(
            [.posixPermissions: self.secureStateDirPermissions],
            ofItemAtPath: url.path)
        try ExecApprovalsFileIO.assertSafeDirectory(at: url)
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

    private static func hashFile(_ file: ExecApprovalsFile) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = (try? encoder.encode(file)) ?? Data()
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
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

    private static func normalizeAllowlistEntries(
        _ entries: [ExecAllowlistEntry],
        dropInvalid: Bool) -> (entries: [ExecAllowlistEntry], rejected: [ExecAllowlistRejectedEntry])
    {
        var normalized: [ExecAllowlistEntry] = []
        normalized.reserveCapacity(entries.count)
        var rejected: [ExecAllowlistRejectedEntry] = []

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
                            source: migrated.source,
                            commandText: migrated.commandText,
                            argPattern: normalizedArgPattern,
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
