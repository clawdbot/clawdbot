import Darwin
import Foundation
import OpenClawNativeState

struct PortGuardianStoreError: Error, LocalizedError, Sendable {
    let message: String

    var errorDescription: String? {
        self.message
    }

    init(_ message: String) {
        self.message = message
    }
}

/// Host-global SQLite ledger for SSH tunnels spawned by macOS app instances.
/// This intentionally ignores OPENCLAW_STATE_DIR: prod, dev, and profile-specific
/// app processes must share one orphan-recovery owner for machine-local ports.
final class PortGuardianRecordStore: @unchecked Sendable {
    typealias LegacyRecordResolver = (
        _ existing: PortGuardian.Record?,
        _ legacy: PortGuardian.Record) throws -> PortGuardian.Record?

    private static let maximumLegacyBytes = 1024 * 1024

    private struct LegacyFileSnapshot: Equatable {
        let device: UInt64
        let inode: UInt64
        let size: UInt64
        let modifiedAt: Date?
    }

    private struct LegacySource: Equatable {
        let snapshot: LegacyFileSnapshot
        let data: Data
    }

    private let database: OpenClawNativeStateSQLite
    private let legacyLockDescriptor: Int32?
    private let legacyCoordinationLock = NSLock()
    private let removeLegacySource: @Sendable (URL) throws -> Void

    static var liveRootURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("OpenClaw", isDirectory: true)
    }

    static var liveDatabaseURL: URL {
        self.liveRootURL
            .appendingPathComponent("state", isDirectory: true)
            .appendingPathComponent("openclaw.sqlite", isDirectory: false)
    }

    static var liveLegacyRecordURL: URL {
        self.liveRootURL.appendingPathComponent("port-guard.json", isDirectory: false)
    }

    static var liveLegacyLockURL: URL {
        self.liveRootURL.appendingPathComponent("port-guard.lock", isDirectory: false)
    }

    init(
        databaseURL: URL,
        legacyLockURL: URL? = nil,
        removeLegacySource: @escaping @Sendable (URL) throws -> Void = {
            try FileManager.default.removeItem(at: $0)
        }) throws
    {
        let legacyLockDescriptor = try legacyLockURL.map(Self.openLegacyLock)
        let database: OpenClawNativeStateSQLite
        do {
            database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
        } catch {
            Self.closeLegacyLock(legacyLockDescriptor)
            throw Self.storeError(error)
        }
        self.database = database
        self.legacyLockDescriptor = legacyLockDescriptor
        self.removeLegacySource = removeLegacySource
        do {
            try self.database.withImmediateTransaction {
                try self.database.ensureCanonicalTable(.macosPortGuardianRecords)
            }
        } catch {
            Self.closeLegacyLock(legacyLockDescriptor)
            throw Self.storeError(error)
        }
    }

    deinit {
        Self.closeLegacyLock(self.legacyLockDescriptor)
    }

    func records() throws -> [PortGuardian.Record] {
        try self.readRecords()
    }

    @discardableResult
    func upsert(_ record: PortGuardian.Record) throws -> PortGuardian.Record {
        try Self.validate(record)
        return try self.mapDatabaseError {
            try self.withValidatedMutationTransaction {
                try self.upsertUnlocked(record)
                guard try self.readRecord(pid: record.pid) == record else {
                    throw PortGuardianStoreError("SQLite did not preserve the PortGuardian record receipt")
                }
                return record
            }
        }
    }

    @discardableResult
    func deleteIfMatches(_ record: PortGuardian.Record) throws -> Bool {
        try self.deleteIfMatches([record]).contains(record)
    }

    @discardableResult
    func deleteIfMatches(_ records: [PortGuardian.Record]) throws -> [PortGuardian.Record] {
        try records.forEach(Self.validate)
        return try self.mapDatabaseError {
            try self.withValidatedMutationTransaction {
                var deleted: [PortGuardian.Record] = []
                for record in records where try self.deleteIfMatchesUnlocked(record) {
                    deleted.append(record)
                }
                return deleted
            }
        }
    }

    /// Imports the shipped JSON ledger under its original flock protocol, then
    /// verifies canonical rows before retiring the source.
    @discardableResult
    func migrateLegacyRecords(recordURL: URL) throws -> Int {
        try self.migrateLegacyRecords(recordURL: recordURL) { existing, legacy in
            guard let existing else { return legacy }
            guard existing != legacy else { return existing }
            throw PortGuardianStoreError(
                "Legacy PortGuardian record conflicts at pid \(existing.pid); source preserved")
        }
    }

    @discardableResult
    func migrateLegacyRecords(
        recordURL: URL,
        resolveRecord: LegacyRecordResolver) throws -> Int
    {
        guard let legacyLockDescriptor else {
            throw PortGuardianStoreError("Legacy PortGuardian migration requires its compatibility lock")
        }
        return try self.withLegacyCoordinationLock {
            guard let source = try Self.withExclusiveLegacyLock(legacyLockDescriptor, body: {
                try Self.readLegacySource(recordURL)
            }) else { return 0 }
            let byPID = try Self.decodeLegacyRecords(source.data)

            // Live process inspection can invoke system tools. Never hold the old
            // writer's flock while planning or an older app can strand spawned SSH.
            let plans = try self.planLegacyMigration(
                records: byPID,
                resolveRecord: resolveRecord)

            return try Self.withExclusiveLegacyLock(legacyLockDescriptor) {
                guard let currentSource = try Self.readLegacySource(recordURL) else {
                    // Another aligned app completed the same migration while this
                    // instance planned without holding the shipped writer lock.
                    return 0
                }
                guard currentSource == source else {
                    throw PortGuardianStoreError(
                        "Legacy PortGuardian source changed while migration was planned")
                }
                try self.applyLegacyMigration(plans)
                try self.removeLegacySource(recordURL)
                return byPID.count
            }
        }
    }

    private func withLegacyCoordinationLock<T>(_ body: () throws -> T) rethrows -> T {
        self.legacyCoordinationLock.lock()
        defer { self.legacyCoordinationLock.unlock() }
        return try body()
    }

    private static func decodeLegacyRecords(_ data: Data) throws -> [Int32: PortGuardian.Record] {
        let decoded: [PortGuardian.Record]
        do {
            decoded = try JSONDecoder().decode([PortGuardian.Record].self, from: data)
        } catch {
            throw PortGuardianStoreError("Legacy PortGuardian source is invalid: \(error.localizedDescription)")
        }
        var byPID: [Int32: PortGuardian.Record] = [:]
        for record in decoded {
            try self.validate(record)
            guard byPID.updateValue(record, forKey: record.pid) == nil else {
                throw PortGuardianStoreError("Legacy PortGuardian source contains duplicate pid \(record.pid)")
            }
        }
        return byPID
    }

    private typealias LegacyMigrationPlan = (
        legacy: PortGuardian.Record,
        expected: PortGuardian.Record?,
        selected: PortGuardian.Record?)

    private func planLegacyMigration(
        records: [Int32: PortGuardian.Record],
        resolveRecord: LegacyRecordResolver) throws -> [LegacyMigrationPlan]
    {
        try records.values.sorted { $0.pid < $1.pid }.map { legacy in
            let existing = try self.readRecord(pid: legacy.pid)
            let selected = try resolveRecord(existing, legacy)
            if let selected {
                try Self.validate(selected)
                guard selected.pid == legacy.pid else {
                    throw PortGuardianStoreError(
                        "Legacy PortGuardian conflict resolver changed pid \(legacy.pid)")
                }
            }
            return (legacy: legacy, expected: existing, selected: selected)
        }
    }

    private func applyLegacyMigration(_ plans: [LegacyMigrationPlan]) throws {
        try self.mapDatabaseError {
            try self.withValidatedMutationTransaction {
                for plan in plans {
                    let authoritative = try self.readRecord(pid: plan.legacy.pid)
                    guard authoritative == plan.expected else {
                        throw PortGuardianStoreError(
                            "SQLite PortGuardian row changed while migrating pid \(plan.legacy.pid)")
                    }
                    switch (authoritative, plan.selected) {
                    case let (existing?, selected?) where existing != selected:
                        try self.upsertUnlocked(selected)
                    case let (existing?, nil):
                        guard try self.deleteIfMatchesUnlocked(existing) else {
                            throw PortGuardianStoreError(
                                "Could not retire stale PortGuardian pid \(existing.pid)")
                        }
                    case (nil, let selected?):
                        try self.upsertUnlocked(selected)
                    default:
                        break
                    }
                }
                for plan in plans {
                    guard try self.readRecord(pid: plan.legacy.pid) == plan.selected else {
                        throw PortGuardianStoreError(
                            "SQLite did not preserve migrated PortGuardian record pid \(plan.legacy.pid)")
                    }
                }
            }
        }
    }

    /// A store can outlive another runtime's schema upgrade. Revalidate under the
    /// write lock so an older native client never mutates a newer database contract.
    private func withValidatedMutationTransaction<T>(_ body: () throws -> T) throws -> T {
        try self.database.withImmediateTransaction {
            try self.database.ensureCanonicalTable(
                .macosPortGuardianRecords,
                allowVersionZeroCreation: false)
            return try body()
        }
    }

    private static func readLegacySource(_ recordURL: URL) throws -> LegacySource? {
        guard FileManager.default.fileExists(atPath: recordURL.path) else { return nil }
        let before = try self.legacySnapshot(recordURL, maximumBytes: self.maximumLegacyBytes)
        let data = try Data(contentsOf: recordURL, options: [.mappedIfSafe])
        let afterRead = try self.legacySnapshot(recordURL, maximumBytes: self.maximumLegacyBytes)
        guard before == afterRead, UInt64(data.count) == before.size else {
            throw PortGuardianStoreError("Legacy PortGuardian source changed while being claimed")
        }
        return LegacySource(snapshot: before, data: data)
    }

    private func readRecords() throws -> [PortGuardian.Record] {
        try self.mapDatabaseError {
            let statement = try self.database.prepare("""
            SELECT port, pid, command, mode, timestamp
            FROM macos_port_guardian_records
            ORDER BY timestamp, pid
            """)
            var records: [PortGuardian.Record] = []
            while try statement.step() == .row {
                try records.append(Self.decodeRecord(statement))
            }
            return records
        }
    }

    private func readRecord(pid: Int32) throws -> PortGuardian.Record? {
        let statement = try self.database.prepare("""
        SELECT port, pid, command, mode, timestamp
        FROM macos_port_guardian_records
        WHERE pid = ?
        """)
        try statement.bindInt64(Int64(pid), at: 1)
        let result = try statement.step()
        if result == .done { return nil }
        let record = try Self.decodeRecord(statement)
        guard try statement.step() == .done else {
            throw PortGuardianStoreError("SQLite returned duplicate PortGuardian pids")
        }
        return record
    }

    private static func decodeRecord(
        _ statement: OpenClawNativeStateSQLiteStatement) throws -> PortGuardian.Record
    {
        guard statement.valueType(at: 0) == .integer,
              statement.valueType(at: 1) == .integer,
              statement.valueType(at: 2) == .text,
              statement.valueType(at: 3) == .text,
              [.float, .integer].contains(statement.valueType(at: 4))
        else {
            throw PortGuardianStoreError("SQLite PortGuardian row has invalid column types")
        }
        let port = statement.int64(at: 0)
        let pid = statement.int64(at: 1)
        guard (1...65535).contains(port), (1...Int64(Int32.max)).contains(pid) else {
            throw PortGuardianStoreError("SQLite PortGuardian row has invalid pid or port")
        }
        let record = try PortGuardian.Record(
            port: Int(port),
            pid: Int32(pid),
            command: statement.requiredText(at: 2, field: "command"),
            mode: statement.requiredText(at: 3, field: "mode"),
            timestamp: statement.double(at: 4))
        try Self.validate(record)
        return record
    }

    private static func validate(_ record: PortGuardian.Record) throws {
        guard record.pid > 0,
              (1...65535).contains(record.port),
              !record.command.isEmpty,
              !record.mode.isEmpty,
              record.timestamp.isFinite,
              record.timestamp >= 0
        else {
            throw PortGuardianStoreError("PortGuardian record has invalid fields")
        }
    }

    private func upsertUnlocked(_ record: PortGuardian.Record) throws {
        let statement = try self.database.prepare("""
        INSERT INTO macos_port_guardian_records (pid, port, command, mode, timestamp)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(pid) DO UPDATE SET
          port = excluded.port,
          command = excluded.command,
          mode = excluded.mode,
          timestamp = excluded.timestamp
        """)
        try Self.bind(record, to: statement)
        guard try statement.step() == .done else {
            throw PortGuardianStoreError("Could not upsert PortGuardian record")
        }
    }

    private func deleteIfMatchesUnlocked(_ record: PortGuardian.Record) throws -> Bool {
        let statement = try self.database.prepare("""
        DELETE FROM macos_port_guardian_records
        WHERE pid = ? AND port = ? AND command = ? AND mode = ? AND timestamp = ?
        """)
        try Self.bind(record, to: statement)
        guard try statement.step() == .done else {
            throw PortGuardianStoreError("Could not delete PortGuardian record")
        }
        return self.database.changes == 1
    }

    private static func bind(
        _ record: PortGuardian.Record,
        to statement: OpenClawNativeStateSQLiteStatement) throws
    {
        try statement.bindInt64(Int64(record.pid), at: 1)
        try statement.bindInt64(Int64(record.port), at: 2)
        try statement.bindText(record.command, at: 3)
        try statement.bindText(record.mode, at: 4)
        try statement.bindDouble(record.timestamp, at: 5)
    }

    private func mapDatabaseError<T>(_ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch {
            throw Self.storeError(error)
        }
    }

    private static func storeError(_ error: Error) -> Error {
        if let error = error as? PortGuardianStoreError { return error }
        if let error = error as? OpenClawNativeStateError {
            return PortGuardianStoreError(error.message)
        }
        return error
    }

    private static func openLegacyLock(_ lockURL: URL) throws -> Int32 {
        try self.secureDirectory(lockURL.deletingLastPathComponent())
        let descriptor = open(lockURL.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else {
            throw PortGuardianStoreError("Could not open legacy PortGuardian lock")
        }
        var descriptorStatus = stat()
        var pathStatus = stat()
        guard fstat(descriptor, &descriptorStatus) == 0,
              lstat(lockURL.path, &pathStatus) == 0,
              descriptorStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              descriptorStatus.st_uid == geteuid(),
              descriptorStatus.st_nlink == 1,
              descriptorStatus.st_mode & mode_t(0o022) == 0,
              descriptorStatus.st_dev == pathStatus.st_dev,
              descriptorStatus.st_ino == pathStatus.st_ino,
              fchmod(descriptor, 0o600) == 0
        else {
            close(descriptor)
            throw PortGuardianStoreError("Legacy PortGuardian lock is unsafe or unavailable")
        }
        return descriptor
    }

    private static func closeLegacyLock(_ descriptor: Int32?) {
        guard let descriptor else { return }
        _ = flock(descriptor, LOCK_UN)
        close(descriptor)
    }

    /// The inode stays stable for old and new app copies. The lock is short-lived:
    /// an old app may already have spawned SSH before recording its JSON receipt,
    /// so permanently blocking its writer would create an untracked orphan.
    private static func withExclusiveLegacyLock<T>(
        _ descriptor: Int32,
        body: () throws -> T) throws -> T
    {
        guard flock(descriptor, LOCK_EX) == 0 else {
            throw PortGuardianStoreError("Could not acquire exclusive legacy PortGuardian lock")
        }
        defer { _ = flock(descriptor, LOCK_UN) }
        return try body()
    }

    private static func legacySnapshot(_ url: URL, maximumBytes: Int) throws -> LegacyFileSnapshot {
        let root = url.deletingLastPathComponent().standardizedFileURL
        let candidate = url.standardizedFileURL
        let expected = root.resolvingSymlinksInPath()
            .appendingPathComponent(candidate.lastPathComponent, isDirectory: false)
            .standardizedFileURL
        guard candidate.resolvingSymlinksInPath().standardizedFileURL == expected else {
            throw PortGuardianStoreError("Legacy PortGuardian source must not traverse symbolic links")
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: candidate.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let links = attributes[.referenceCount] as? NSNumber,
              links.uint64Value == 1,
              let device = attributes[.systemNumber] as? NSNumber,
              let inode = attributes[.systemFileNumber] as? NSNumber,
              let size = attributes[.size] as? NSNumber,
              size.uint64Value <= UInt64(maximumBytes)
        else {
            throw PortGuardianStoreError(
                "Legacy PortGuardian source must be a bounded regular file with exactly one link")
        }
        return LegacyFileSnapshot(
            device: device.uint64Value,
            inode: inode.uint64Value,
            size: size.uint64Value,
            modifiedAt: attributes[.modificationDate] as? Date)
    }

    private static func secureDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        guard chmod(url.path, 0o700) == 0 else {
            throw PortGuardianStoreError("Could not secure PortGuardian state directory")
        }
    }
}
