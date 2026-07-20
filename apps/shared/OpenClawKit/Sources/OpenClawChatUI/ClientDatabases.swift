import CryptoKit
import Foundation
import GRDB
import OSLog

private let databaseLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawClientDatabases")

private struct GatewayCacheFormatMismatch: Error {}

private enum GatewayRemovalPhase: Int {
    case finalized = 0
    case staged = 1
    case committing = 2
    case scrubbing = 3
}

/// Installation-wide storage for every paired gateway.
///
/// Gateway-derived snapshots and client-owned work deliberately live in
/// separate files. The cache may be rebuilt at any time; client state uses
/// forward migrations and is never erased as a cache-repair strategy.
public final class OpenClawClientDatabases: @unchecked Sendable {
    public static let gatewayCacheFilename = "gateway-cache.sqlite"
    public static let clientStateFilename = "client-state.sqlite"
    static let gatewayCacheFormatVersion = 1

    public let directoryURL: URL
    let cacheQueue: DatabaseQueue
    let stateQueue: DatabaseQueue
    private let legacyDirectoryURLs: [URL]

    public init(
        directoryURL: URL,
        legacyDirectoryURLs: [URL] = [],
        registeredGatewayIDs: Set<String>? = nil) throws
    {
        self.directoryURL = directoryURL
        self.legacyDirectoryURLs = legacyDirectoryURLs
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)

        let stateURL = directoryURL.appendingPathComponent(Self.clientStateFilename, isDirectory: false)
        self.stateQueue = try Self.openStateDatabase(at: stateURL)
        self.cacheQueue = try Self.openRepairableCacheDatabase(
            at: directoryURL.appendingPathComponent(Self.gatewayCacheFilename, isDirectory: false))
        self.resolvePendingGatewayRemovals(registeredGatewayIDs: registeredGatewayIDs)
        self.importLegacyDatabases(registeredGatewayIDs: registeredGatewayIDs)
    }

    public func store(gatewayID: String) -> OpenClawChatSQLiteTranscriptCache {
        OpenClawChatSQLiteTranscriptCache(databases: self, gatewayID: gatewayID)
    }

    /// Retries one-time import and forgotten-gateway cleanup. iOS calls this
    /// again on foreground because old complete-protection files may have been
    /// unreadable during a locked background launch.
    public func retryLegacyImport(registeredGatewayIDs: Set<String>? = nil) {
        self.importLegacyDatabases(registeredGatewayIDs: registeredGatewayIDs)
    }

    public func loadSessionRoutingIdentity(
        gatewayID: String) -> OpenClawChatSessionRoutingIdentity?
    {
        do {
            return try self.stateQueue.read { db in
                guard let row = try Row.fetchOne(
                    db,
                    sql: """
                    SELECT scope, main_session_key, default_agent_id
                    FROM gateway_routing_identity WHERE gateway_id = ?
                    """,
                    arguments: [gatewayID])
                else { return nil }
                return OpenClawChatSessionRoutingIdentity(
                    scope: row["scope"],
                    mainSessionKey: row["main_session_key"],
                    defaultAgentID: row["default_agent_id"])
            }
        } catch {
            databaseLogger.error("client state routing read failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Removes one forgotten gateway without disturbing the other gateways in
    /// either installation-wide database.
    public func removeGatewayData(gatewayID: String) throws {
        try self.stageGatewayRemoval(gatewayID: gatewayID)
        try self.commitGatewayRemoval(gatewayID: gatewayID)
    }

    /// Stages the cross-owner forget transaction before pairing metadata is
    /// removed. No gateway payload is deleted until the registry owner commits.
    public func stageGatewayRemoval(gatewayID: String) throws {
        let gatewayHash = Self.gatewayIdentityHash(gatewayID)
        let existingPhase = try self.stateQueue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT cleanup_phase FROM forgotten_gateways WHERE gateway_hash = ?",
                arguments: [gatewayHash])
        }
        if existingPhase == GatewayRemovalPhase.committing.rawValue {
            try self.commitGatewayRemoval(gatewayID: gatewayID)
        } else if existingPhase == GatewayRemovalPhase.scrubbing.rawValue {
            try self.finishGatewayRemovalScrub(gatewayHash: gatewayHash)
        }
        try self.rejectPreservedSharedLegacyDatabase()
        try self.stateQueue.write { db in
            try db.execute(
                sql: """
                INSERT INTO forgotten_gateways(
                    gateway_hash, gateway_id, forgotten_at, cleanup_phase, restore_finalized
                ) VALUES (?, ?, ?, ?, 0)
                ON CONFLICT(gateway_hash) DO UPDATE SET
                    gateway_id = excluded.gateway_id,
                    forgotten_at = CASE
                        WHEN forgotten_gateways.cleanup_phase = 0
                            THEN forgotten_gateways.forgotten_at
                        ELSE excluded.forgotten_at
                    END,
                    cleanup_phase = excluded.cleanup_phase,
                    restore_finalized = CASE
                        WHEN forgotten_gateways.cleanup_phase = 0 THEN 1
                        ELSE forgotten_gateways.restore_finalized
                    END
                WHERE forgotten_gateways.cleanup_phase NOT IN (2, 3)
                """,
                arguments: [
                    gatewayHash,
                    gatewayID,
                    Date().timeIntervalSince1970,
                    GatewayRemovalPhase.staged.rawValue,
                ])
        }
    }

    /// Commits a staged forget after the registry owner has removed pairing
    /// metadata. A failed commit remains staged for startup reconciliation.
    public func commitGatewayRemoval(gatewayID: String) throws {
        let gatewayHash = Self.gatewayIdentityHash(gatewayID)
        let existingPhase = try self.stateQueue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT cleanup_phase FROM forgotten_gateways WHERE gateway_hash = ?",
                arguments: [gatewayHash])
        }
        if existingPhase == GatewayRemovalPhase.scrubbing.rawValue {
            try self.finishGatewayRemovalScrub(gatewayHash: gatewayHash)
            return
        }
        // Mark the irreversible phase in the same transaction that deletes
        // client state. Recovery must finish this phase even if pairing was
        // preserved (for example, a cache-only purge).
        try self.stateQueue.write { db in
            guard let phase = try Int.fetchOne(
                db,
                sql: """
                SELECT cleanup_phase FROM forgotten_gateways
                WHERE gateway_hash = ? AND gateway_id = ?
                """,
                arguments: [gatewayHash, gatewayID]),
                phase == GatewayRemovalPhase.staged.rawValue ||
                phase == GatewayRemovalPhase.committing.rawValue
            else {
                throw DatabaseError(message: "gateway removal was not staged")
            }
            if phase == GatewayRemovalPhase.staged.rawValue {
                try db.execute(
                    sql: """
                    UPDATE forgotten_gateways SET cleanup_phase = ?
                    WHERE gateway_hash = ? AND gateway_id = ? AND cleanup_phase = ?
                    """,
                    arguments: [
                        GatewayRemovalPhase.committing.rawValue,
                        gatewayHash,
                        gatewayID,
                        GatewayRemovalPhase.staged.rawValue,
                    ])
            }
            try db.execute(sql: "DELETE FROM outbox_commands WHERE gateway_id = ?", arguments: [gatewayID])
            try db.execute(
                sql: "DELETE FROM gateway_routing_identity WHERE gateway_id = ?",
                arguments: [gatewayID])
        }
        try self.cacheQueue.write { db in
            try db.execute(sql: "DELETE FROM cached_sessions WHERE gateway_id = ?", arguments: [gatewayID])
            try db.execute(sql: "DELETE FROM cached_transcripts WHERE gateway_id = ?", arguments: [gatewayID])
        }
        try self.removeLegacyGatewayDatabaseFiles(gatewayID: gatewayID)
        // secure_delete scrubs deleted cells; truncating both WALs removes
        // pre-delete frames while preserving every other gateway's rows.
        _ = try self.cacheQueue.writeWithoutTransaction { db in
            try db.checkpoint(.truncate)
        }
        _ = try self.stateQueue.writeWithoutTransaction { db in
            try db.checkpoint(.truncate)
        }
        try self.stateQueue.write { db in
            try db.execute(
                sql: """
                UPDATE forgotten_gateways
                SET gateway_id = NULL, cleanup_phase = 3, restore_finalized = 0
                WHERE gateway_hash = ? AND cleanup_phase = 2
                """,
                arguments: [gatewayHash])
        }
        try self.finishGatewayRemovalScrub(gatewayHash: gatewayHash)
    }

    /// Cancels an uncommitted forget when the registry owner could not remove
    /// the pairing. Since staging deletes no payload, the gateway stays intact.
    public func cancelGatewayRemoval(gatewayID: String) throws {
        let gatewayHash = Self.gatewayIdentityHash(gatewayID)
        try self.stateQueue.write { db in
            // A repeated forget temporarily expands a finalized hash-only
            // tombstone. Cancellation must collapse it again, not erase it.
            try db.execute(
                sql: """
                UPDATE forgotten_gateways
                SET gateway_id = NULL, cleanup_phase = 0, restore_finalized = 0
                WHERE gateway_hash = ? AND gateway_id = ?
                    AND cleanup_phase = 1 AND restore_finalized = 1
                """,
                arguments: [gatewayHash, gatewayID])
            try db.execute(
                sql: """
                DELETE FROM forgotten_gateways
                WHERE gateway_hash = ? AND gateway_id = ?
                    AND cleanup_phase = 1 AND restore_finalized = 0
                """,
                arguments: [gatewayHash, gatewayID])
        }
        _ = try self.stateQueue.writeWithoutTransaction { db in
            try db.checkpoint(.truncate)
        }
    }

    /// Resolves a crash between staging, registry removal, and commit. A still
    /// registered gateway cancels safely; an absent gateway finishes erasure.
    /// Without an authoritative registry, only irreversible commits advance;
    /// cancelable stages remain untouched.
    public func resolvePendingGatewayRemovals(registeredGatewayIDs: Set<String>? = nil) {
        let pending: [Row]
        do {
            pending = try self.stateQueue.read { db in
                try Row.fetchAll(
                    db,
                    sql: """
                    SELECT gateway_hash, gateway_id, cleanup_phase FROM forgotten_gateways
                    WHERE cleanup_phase IN (1, 2, 3)
                    ORDER BY gateway_hash
                    """)
            }
        } catch {
            databaseLogger.error(
                "pending gateway removal read failed: \(error.localizedDescription, privacy: .public)")
            return
        }
        for row in pending {
            let gatewayHash: String = row["gateway_hash"]
            let gatewayID: String? = row["gateway_id"]
            let phase: Int = row["cleanup_phase"]
            do {
                if phase == GatewayRemovalPhase.scrubbing.rawValue {
                    try self.finishGatewayRemovalScrub(gatewayHash: gatewayHash)
                } else if phase == GatewayRemovalPhase.committing.rawValue, let gatewayID {
                    try self.commitGatewayRemoval(gatewayID: gatewayID)
                } else if let gatewayID, let registeredGatewayIDs {
                    if registeredGatewayIDs.contains(gatewayID) {
                        try self.cancelGatewayRemoval(gatewayID: gatewayID)
                    } else {
                        try self.commitGatewayRemoval(gatewayID: gatewayID)
                    }
                }
            } catch {
                let reason = error.localizedDescription
                databaseLogger.error(
                    "pending removal \(gatewayHash.prefix(12), privacy: .public) failed: \(reason, privacy: .public)")
            }
        }
    }

    /// Fail closed while an irreversible or cancelable removal marker still
    /// exists. Callers use this after recovery before exposing a new writable
    /// facade for the same gateway.
    public func hasPendingGatewayRemoval(gatewayID: String) -> Bool {
        do {
            let gatewayHash = Self.gatewayIdentityHash(gatewayID)
            return try self.stateQueue.read { db in
                try Int.fetchOne(
                    db,
                    sql: """
                    SELECT 1 FROM forgotten_gateways
                    WHERE gateway_hash = ? AND cleanup_phase IN (1, 2, 3)
                    """,
                    arguments: [gatewayHash]) != nil
            }
        } catch {
            let reason = error.localizedDescription
            databaseLogger.error(
                "pending gateway removal check failed: \(reason, privacy: .public)")
            return true
        }
    }

    /// A hash-only marker survives until the checkpoint that physically drops
    /// old WAL frames. If that checkpoint fails, startup can retry without
    /// retaining the raw gateway identifier.
    private func finishGatewayRemovalScrub(gatewayHash: String) throws {
        _ = try self.stateQueue.writeWithoutTransaction { db in
            try db.checkpoint(.truncate)
        }
        try self.stateQueue.write { db in
            try db.execute(
                sql: """
                UPDATE forgotten_gateways SET cleanup_phase = 0
                WHERE gateway_hash = ? AND cleanup_phase = 3
                """,
                arguments: [gatewayHash])
        }
    }

    /// Closes both installation-wide handles before a full reset removes the
    /// files. Gateway-scoped deletion keeps the shared handles open.
    public func close() throws {
        try self.cacheQueue.close()
        try self.stateQueue.close()
    }

    /// Startup-only removal after all store/container references have been
    /// released. Sidecars are named explicitly so WAL pages cannot survive a
    /// full onboarding reset.
    public static func removeDatabaseFiles(in directoryURL: URL) throws {
        for filename in [self.gatewayCacheFilename, self.clientStateFilename] {
            try self.removeDatabaseFilesChecked(
                at: directoryURL.appendingPathComponent(filename, isDirectory: false))
        }
        for legacyURL in self.legacyDatabaseURLs(in: directoryURL) {
            try self.removeDatabaseFilesChecked(at: legacyURL)
        }
    }

    static func removeDatabaseFiles(at databaseURL: URL) {
        let fileManager = FileManager.default
        try? fileManager.removeItem(at: databaseURL)
        for suffix in ["-wal", "-shm", "-journal"] {
            try? fileManager.removeItem(at: URL(fileURLWithPath: databaseURL.path + suffix))
        }
    }

    static func legacyPerGatewayDatabaseURL(gatewayID: String, directoryURL: URL) -> URL {
        directoryURL.appendingPathComponent("\(self.gatewayIdentityHash(gatewayID)).sqlite", isDirectory: false)
    }

    static func gatewayIdentityHash(_ gatewayID: String) -> String {
        SHA256.hash(data: Data(gatewayID.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func removeDatabaseFilesChecked(at databaseURL: URL) throws {
        let fileManager = FileManager.default
        for url in [databaseURL] + ["-wal", "-shm", "-journal"].map({ suffix in
            URL(fileURLWithPath: databaseURL.path + suffix)
        }) where fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }
    }

    private func removeLegacyGatewayDatabaseFiles(gatewayID: String) throws {
        let directories = Set([self.directoryURL] + self.legacyDirectoryURLs)
        for directoryURL in directories {
            try Self.removeDatabaseFilesChecked(at: Self.legacyPerGatewayDatabaseURL(
                gatewayID: gatewayID,
                directoryURL: directoryURL))
        }
    }

    private func rejectPreservedSharedLegacyDatabase() throws {
        let directories = Set([self.directoryURL] + self.legacyDirectoryURLs)
        guard directories.contains(where: { directoryURL in
            FileManager.default.fileExists(
                atPath: directoryURL.appendingPathComponent("chat-cache.sqlite").path)
        }) else { return }
        // A shared legacy file may contain several gateways. If startup could
        // not import it, targeted erasure cannot be proven without data loss.
        throw DatabaseError(message: "shared legacy database blocks targeted gateway removal")
    }
}

extension OpenClawClientDatabases {
    // MARK: - Schema ownership

    private static func configuration(label: String) -> Configuration {
        var configuration = Configuration()
        configuration.label = label
        // Use the platform app-container default so background cache/outbox
        // work is not coupled to iOS protected-data availability.
        configuration.journalMode = .wal
        configuration.busyMode = .timeout(5)
        configuration.prepareDatabase { db in
            try db.execute(sql: "PRAGMA secure_delete = ON")
        }
        return configuration
    }

    private static func openStateDatabase(at url: URL) throws -> DatabaseQueue {
        let queue = try DatabaseQueue(
            path: url.path,
            configuration: self.configuration(label: "OpenClaw.client-state"))
        var migrator = DatabaseMigrator()
        migrator.registerMigration("client-state-v1") { db in
            try db.execute(sql: """
            CREATE TABLE forgotten_gateways(
                gateway_hash TEXT NOT NULL PRIMARY KEY,
                gateway_id TEXT,
                forgotten_at REAL NOT NULL,
                cleanup_phase INTEGER NOT NULL CHECK(cleanup_phase IN (0, 1, 2, 3)),
                restore_finalized INTEGER NOT NULL DEFAULT 0
                    CHECK(restore_finalized IN (0, 1)),
                CHECK((cleanup_phase IN (1, 2) AND gateway_id IS NOT NULL) OR
                      (cleanup_phase IN (0, 3) AND gateway_id IS NULL AND restore_finalized = 0))
            );
            CREATE TABLE gateway_routing_identity(
                gateway_id TEXT NOT NULL PRIMARY KEY,
                scope TEXT NOT NULL,
                main_session_key TEXT NOT NULL,
                default_agent_id TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
                CREATE TABLE outbox_commands(
                    enqueue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    gateway_id TEXT NOT NULL,
                    client_uuid TEXT NOT NULL,
                session_key TEXT NOT NULL,
                delivery_session_key TEXT NOT NULL,
                routing_contract TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                text TEXT NOT NULL,
                thinking TEXT NOT NULL,
                created_at REAL NOT NULL,
                status TEXT NOT NULL CHECK(status IN (
                    'queued', 'sending', 'awaiting_confirmation', 'failed'
                )),
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    attachment_bytes INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(gateway_id, client_uuid)
                );
                CREATE INDEX outbox_commands_delivery_order
                    ON outbox_commands(gateway_id, created_at, enqueue_sequence);
            CREATE TABLE outbox_attachments(
                gateway_id TEXT NOT NULL,
                command_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                type TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                file_name TEXT NOT NULL,
                payload BLOB NOT NULL,
                duration_seconds REAL,
                PRIMARY KEY(gateway_id, command_id, position),
                FOREIGN KEY(gateway_id, command_id)
                    REFERENCES outbox_commands(gateway_id, client_uuid)
                    ON DELETE CASCADE
            );
            """)
        }
        try migrator.migrate(queue)
        return queue
    }

    private static func openRepairableCacheDatabase(at url: URL) throws -> DatabaseQueue {
        do {
            let queue = try DatabaseQueue(
                path: url.path,
                configuration: self.configuration(label: "OpenClaw.gateway-cache"))
            try self.prepareCacheSchema(queue)
            return queue
        } catch {
            // This file contains gateway snapshots only. A format mismatch or
            // corruption is repaired by rebuilding, never by migrating rows.
            self.removeDatabaseFiles(at: url)
            let queue = try DatabaseQueue(
                path: url.path,
                configuration: self.configuration(label: "OpenClaw.gateway-cache"))
            try self.prepareCacheSchema(queue)
            return queue
        }
    }

    private static func prepareCacheSchema(_ queue: DatabaseQueue) throws {
        try queue.write { db in
            let currentVersion: Int? = if try db.tableExists("cache_metadata") {
                try Int.fetchOne(db, sql: "SELECT format_version FROM cache_metadata WHERE id = 1")
            } else {
                nil
            }
            if let currentVersion, currentVersion != self.gatewayCacheFormatVersion {
                throw GatewayCacheFormatMismatch()
            }
            if currentVersion == nil,
               try db.tableExists("cached_sessions") ||
               db.tableExists("cached_transcripts") ||
               db.tableExists("cached_messages")
            {
                throw GatewayCacheFormatMismatch()
            }
            try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS cache_metadata(
                id INTEGER NOT NULL PRIMARY KEY CHECK(id = 1),
                format_version INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cached_sessions(
                gateway_id TEXT NOT NULL,
                session_key TEXT NOT NULL,
                position INTEGER NOT NULL,
                updated_at REAL NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY(gateway_id, session_key)
            );
            CREATE INDEX IF NOT EXISTS cached_sessions_order
                ON cached_sessions(gateway_id, position);
            CREATE TABLE IF NOT EXISTS cached_transcripts(
                gateway_id TEXT NOT NULL,
                session_key TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY(gateway_id, session_key, agent_id)
            );
            CREATE INDEX IF NOT EXISTS cached_transcripts_recency
                ON cached_transcripts(gateway_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS cached_messages(
                gateway_id TEXT NOT NULL,
                session_key TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                timestamp_ms REAL,
                idempotency_key TEXT,
                payload_json TEXT NOT NULL,
                PRIMARY KEY(gateway_id, session_key, agent_id, position),
                FOREIGN KEY(gateway_id, session_key, agent_id)
                    REFERENCES cached_transcripts(gateway_id, session_key, agent_id)
                    ON DELETE CASCADE
            );
            INSERT OR REPLACE INTO cache_metadata(id, format_version)
                VALUES (1, \(self.gatewayCacheFormatVersion));
            """)
        }
    }
}

extension OpenClawClientDatabases {
    // MARK: - One-time legacy import

    private struct LegacySnapshot {
        var commands: [LegacyCommand]
        var routingIdentities: [LegacyRoutingIdentity]
    }

    private struct LegacyCommand {
        var gatewayID: String
        var id: String
        var sessionKey: String
        var deliverySessionKey: String
        var routingContract: String
        var agentID: String
        var text: String
        var attachments: [OpenClawChatOutboxAttachment]
        var thinking: String
        var createdAt: Double
        var status: String
        var retryCount: Int
        var lastError: String
    }

    private struct LegacyRoutingIdentity {
        var gatewayID: String
        var scope: String
        var mainSessionKey: String
        var defaultAgentID: String
        var updatedAt: Double
    }

    private func importLegacyDatabases(registeredGatewayIDs: Set<String>?) {
        let directories = [self.directoryURL] + self.legacyDirectoryURLs
        let legacyURLs = Set(directories.flatMap(Self.legacyDatabaseURLs(in:)))
        for legacyURL in legacyURLs.sorted(by: { $0.path < $1.path }) {
            do {
                guard let snapshot = try Self.readLegacySnapshot(at: legacyURL) else { continue }
                let legacyGatewayIDs = Set(
                    snapshot.commands.map(\.gatewayID) + snapshot.routingIdentities.map(\.gatewayID))
                let ownedSnapshot: LegacySnapshot = if let registeredGatewayIDs {
                    LegacySnapshot(
                        commands: snapshot.commands.filter {
                            registeredGatewayIDs.contains($0.gatewayID)
                        },
                        routingIdentities: snapshot.routingIdentities.filter {
                            registeredGatewayIDs.contains($0.gatewayID)
                        })
                } else {
                    snapshot
                }
                try self.writeLegacySnapshot(ownedSnapshot)
                // Preserve bytes for unregistered gateways rather than
                // importing or destroying state whose ownership is unknown.
                let forgottenGatewayHashes = try self.forgottenGatewayHashesForLegacyImport()
                let allLegacyGatewaysAccountedFor = legacyGatewayIDs.allSatisfy { gatewayID in
                    registeredGatewayIDs?.contains(gatewayID) == true ||
                        forgottenGatewayHashes.contains(Self.gatewayIdentityHash(gatewayID))
                }
                if registeredGatewayIDs == nil || allLegacyGatewaysAccountedFor {
                    Self.removeDatabaseFiles(at: legacyURL)
                }
            } catch {
                // The new stores remain usable, but unknown/corrupt durable
                // bytes stay untouched for a future compatible importer.
                let filename = legacyURL.lastPathComponent
                let reason = error.localizedDescription
                databaseLogger.error(
                    "legacy import failed: \(filename, privacy: .public): \(reason, privacy: .public)")
            }
        }
    }

    private static func legacyDatabaseURLs(in directoryURL: URL) -> [URL] {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles])
        else { return [] }
        return urls.filter { url in
            let name = url.lastPathComponent
            guard name.hasSuffix(".sqlite"),
                  name != self.gatewayCacheFilename,
                  name != self.clientStateFilename
            else { return false }
            if name == "chat-cache.sqlite" { return true }
            let stem = String(name.dropLast(".sqlite".count))
            return stem.count == 64 && stem.allSatisfy(\.isHexDigit)
        }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private static func readLegacySnapshot(at url: URL) throws -> LegacySnapshot? {
        var configuration = Configuration()
        configuration.label = "OpenClaw.legacy-chat-import"
        configuration.readonly = true
        configuration.busyMode = .timeout(5)
        let queue = try DatabaseQueue(path: url.path, configuration: configuration)
        return try queue.read { db in
            let version = try Int.fetchOne(db, sql: "PRAGMA user_version") ?? 0
            guard (1...6).contains(version) else { return nil }

            var snapshot = LegacySnapshot(commands: [], routingIdentities: [])
            if try db.tableExists("outbox_commands") {
                let columns = try Set(db.columns(in: "outbox_commands").map(\.name))
                func expression(_ name: String, fallback: String) -> String {
                    columns.contains(name) ? name : fallback
                }
                let rows = try Row.fetchAll(db, sql: """
                SELECT client_uuid, gateway_id, session_key,
                       \(expression("delivery_session_key", fallback: "''")) AS delivery_session_key,
                       \(expression("routing_contract", fallback: "''")) AS routing_contract,
                       \(expression("agent_id", fallback: "''")) AS agent_id,
                       text,
                       \(expression("attachments", fallback: "'[]'")) AS attachments,
                       thinking, created_at, status, retry_count, last_error
                FROM outbox_commands ORDER BY created_at, id
                """)
                for row in rows {
                    let attachmentsJSON: String = row["attachments"]
                    let attachments = try JSONDecoder().decode(
                        [OpenClawChatOutboxAttachment].self,
                        from: Data(attachmentsJSON.utf8))
                    let originalStatus: String = row["status"]
                    guard OpenClawChatOutboxCommand.Status(rawValue: originalStatus) != nil else {
                        throw DatabaseError(message: "unknown legacy outbox status")
                    }
                    let routingContract: String = row["routing_contract"]
                    let originalError: String = row["last_error"]
                    let lacksVerifiedTarget = routingContract.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    let status = lacksVerifiedTarget ? OpenClawChatOutboxCommand.Status.failed.rawValue : originalStatus
                    let lastError: String = if lacksVerifiedTarget {
                        if originalStatus == OpenClawChatOutboxCommand.Status.sending.rawValue ||
                            originalStatus == OpenClawChatOutboxCommand.Status.awaitingConfirmation.rawValue ||
                            originalError == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError
                        {
                            OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError
                        } else {
                            OpenClawChatSQLiteTranscriptCache.outboxUnknownTargetError
                        }
                    } else {
                        originalError
                    }
                    snapshot.commands.append(LegacyCommand(
                        gatewayID: row["gateway_id"],
                        id: row["client_uuid"],
                        sessionKey: row["session_key"],
                        deliverySessionKey: lacksVerifiedTarget ? "" : row["delivery_session_key"],
                        routingContract: lacksVerifiedTarget ? "" : routingContract,
                        agentID: lacksVerifiedTarget ? "" : row["agent_id"],
                        text: row["text"],
                        attachments: attachments,
                        thinking: row["thinking"],
                        createdAt: row["created_at"],
                        status: status,
                        retryCount: row["retry_count"],
                        lastError: lastError))
                }
            }
            if try db.tableExists("gateway_routing_identity") {
                let rows = try Row.fetchAll(db, sql: """
                SELECT gateway_id, scope, main_session_key, default_agent_id, updated_at
                FROM gateway_routing_identity
                """)
                snapshot.routingIdentities = rows.map { row in
                    LegacyRoutingIdentity(
                        gatewayID: row["gateway_id"],
                        scope: row["scope"],
                        mainSessionKey: row["main_session_key"],
                        defaultAgentID: row["default_agent_id"],
                        updatedAt: row["updated_at"])
                }
            }
            return snapshot
        }
    }

    private func writeLegacySnapshot(_ snapshot: LegacySnapshot) throws {
        try self.stateQueue.write { db in
            let forgottenGatewayHashes = try Set(String.fetchAll(
                db,
                sql: """
                SELECT gateway_hash FROM forgotten_gateways
                WHERE cleanup_phase IN (0, 2, 3) OR restore_finalized = 1
                """))
            for identity in snapshot.routingIdentities
                where !forgottenGatewayHashes.contains(Self.gatewayIdentityHash(identity.gatewayID))
            {
                try db.execute(
                    sql: """
                    INSERT INTO gateway_routing_identity(
                        gateway_id, scope, main_session_key, default_agent_id, updated_at
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(gateway_id) DO UPDATE SET
                        scope = excluded.scope,
                        main_session_key = excluded.main_session_key,
                        default_agent_id = excluded.default_agent_id,
                        updated_at = excluded.updated_at
                    WHERE excluded.updated_at > gateway_routing_identity.updated_at
                    """,
                    arguments: [
                        identity.gatewayID,
                        identity.scope,
                        identity.mainSessionKey,
                        identity.defaultAgentID,
                        identity.updatedAt,
                    ])
            }
            for command in snapshot.commands
                where !forgottenGatewayHashes.contains(Self.gatewayIdentityHash(command.gatewayID))
            {
                let attachmentBytes = command.attachments.reduce(0) { $0 + $1.data.count }
                try db.execute(
                    sql: """
                    INSERT OR IGNORE INTO outbox_commands(
                        gateway_id, client_uuid, session_key, delivery_session_key,
                        routing_contract, agent_id, text, thinking, created_at,
                        status, retry_count, last_error, attachment_bytes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    arguments: [
                        command.gatewayID,
                        command.id,
                        command.sessionKey,
                        command.deliverySessionKey,
                        command.routingContract,
                        command.agentID,
                        command.text,
                        command.thinking,
                        command.createdAt,
                        command.status,
                        command.retryCount,
                        command.lastError,
                        attachmentBytes,
                    ])
                guard db.changesCount > 0 else { continue }
                for (position, attachment) in command.attachments.enumerated() {
                    try db.execute(
                        sql: """
                        INSERT INTO outbox_attachments(
                            gateway_id, command_id, position, type, mime_type,
                            file_name, payload, duration_seconds
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        arguments: [
                            command.gatewayID,
                            command.id,
                            position,
                            attachment.type,
                            attachment.mimeType,
                            attachment.fileName,
                            attachment.data,
                            attachment.durationSeconds,
                        ])
                }
            }
        }
    }

    private func forgottenGatewayHashesForLegacyImport() throws -> Set<String> {
        try self.stateQueue.read { db in
            try Set(String.fetchAll(
                db,
                sql: """
                SELECT gateway_hash FROM forgotten_gateways
                WHERE cleanup_phase IN (0, 2, 3) OR restore_finalized = 1
                """))
        }
    }
}
