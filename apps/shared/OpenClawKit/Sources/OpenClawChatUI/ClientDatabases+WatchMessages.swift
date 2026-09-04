import CryptoKit
import Foundation
import GRDB
import OpenClawKit

extension OpenClawClientDatabases {
    static func registerWatchMessageJournalMigration(_ migrator: inout DatabaseMigrator) {
        migrator.registerMigration("client-state-watch-message-journal-v9") { db in
            try db.execute(sql: """
            ALTER TABLE gateway_routing_identity ADD COLUMN watch_route_generation TEXT;
            CREATE TABLE watch_message_journal(
                command_id TEXT NOT NULL PRIMARY KEY,
                gateway_id TEXT,
                route_generation TEXT,
                kind TEXT,
                command_json TEXT,
                command_fingerprint BLOB,
                legacy_text TEXT,
                submitted_at_ms INTEGER,
                admitted_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER,
                phase TEXT NOT NULL CHECK(phase IN (
                    'queued', 'sending', 'accepted', 'receiptReady',
                    'received', 'needsReview', 'tombstone'
                )),
                receipt_destination TEXT NOT NULL CHECK(receipt_destination IN ('watch', 'phone')),
                attempt_version INTEGER NOT NULL DEFAULT 0,
                accepted_run_id TEXT,
                receipt_json TEXT,
                CHECK(command_json IS NULL OR (
                    gateway_id IS NOT NULL AND route_generation IS NOT NULL
                    AND expires_at_ms IS NOT NULL AND kind IS NOT NULL
                ))
            );
            CREATE INDEX watch_message_journal_delivery
                ON watch_message_journal(gateway_id, route_generation, phase, admitted_at_ms);
            CREATE INDEX watch_message_journal_expiry ON watch_message_journal(expires_at_ms);
            CREATE TRIGGER watch_message_forget
            AFTER UPDATE OF cleanup_phase ON forgotten_gateways
            WHEN NEW.cleanup_phase = 2 AND NEW.gateway_id IS NOT NULL
            BEGIN
                DELETE FROM watch_message_journal WHERE gateway_id = NEW.gateway_id;
            END;
            """)
        }
        migrator.registerMigration("client-state-watch-message-legacy-receipts-v1") { db in
            try db.execute(sql: """
            CREATE TABLE watch_message_legacy_imports(
                command_id_hash TEXT NOT NULL PRIMARY KEY,
                content_hash TEXT
            );
            """)
        }
    }
}

extension OpenClawWatchMessageJournal {
    static let legacyImportIdentifier = "client-state-watch-message-defaults-import-v1"

    /// Reconcile every captured snapshot: an older app may write again after import.
    /// Hash-only receipts survive Forget and never grant permission to send.
    public func importLegacy(_ prepared: OpenClawWatchMessageLegacyImport, nowMs: Int64) throws {
        guard nowMs >= 0, nowMs <= Int64.max - OpenClawWatchChatDeliveryCodec.lifetimeMs else {
            throw OpenClawWatchChatDeliveryError(code: "clock_error", message: "Check the date and time on iPhone.")
        }
        var recent: [String] = []
        for id in prepared.recentMessageIDs {
            recent.removeAll { $0.utf8.elementsEqual(id.utf8) }
            recent.append(id)
        }
        let recentIDs = Array(recent.suffix(128))
        let retiredIDs = Set(recentIDs.map { Data($0.utf8) })
        try self.queue.write { db in
            var importedIDs = Set<Data>()
            for message in prepared.messages {
                let idHash = Self.legacyIDHash(message.id)
                let contentHash = Self.legacyContentHash(message)
                if let receipt = try Row.fetchOne(
                    db,
                    sql: "SELECT content_hash FROM watch_message_legacy_imports WHERE command_id_hash = ?",
                    arguments: [idHash])
                {
                    // NULL records the old recent-ID suppression policy, not a body match.
                    let previousHash: String? = receipt["content_hash"]
                    guard previousHash == nil || previousHash == contentHash else {
                        throw Self.legacyImportConflict()
                    }
                    continue
                }
                let retired = retiredIDs.contains(Data(message.id.utf8))
                let existing = try Self.fetch(db, id: message.id)
                if let existing {
                    guard existing.command == nil, existing.receipt == nil else {
                        throw Self.legacyImportConflict()
                    }
                    if existing.phase == .needsReview {
                        let original = try OpenClawWatchMessageLegacyImport.Message(
                            id: existing.commandId,
                            gatewayStableID: existing.owner?.gatewayStableID,
                            text: existing.displayText ?? "",
                            submittedAtMs: Int64.fetchOne(
                                db,
                                sql: "SELECT submitted_at_ms FROM watch_message_journal WHERE command_id = ?",
                                arguments: [message.id]))
                        guard Self.legacyContentHash(original) == contentHash else {
                            throw Self.legacyImportConflict()
                        }
                    } else {
                        guard existing.phase == .tombstone, existing.owner == nil else {
                            throw Self.legacyImportConflict()
                        }
                    }
                } else if !retired {
                    if let gatewayID = message.gatewayStableID,
                       try Bool.fetchOne(
                           db,
                           sql: """
                           SELECT EXISTS(SELECT 1 FROM forgotten_gateways WHERE gateway_hash = ?)
                           """,
                           arguments: [OpenClawClientDatabases.gatewayIdentityHash(gatewayID)]) == true
                    {
                        throw Self.legacyImportConflict()
                    }
                    try db.execute(
                        sql: """
                        INSERT INTO watch_message_journal(
                            command_id, gateway_id, legacy_text, submitted_at_ms, admitted_at_ms, phase,
                            receipt_destination
                        ) VALUES (?, ?, ?, ?, ?, 'needsReview', 'phone')
                        """,
                        arguments: [message.id, message.gatewayStableID, message.text, message.submittedAtMs, nowMs])
                }
                try db.execute(
                    sql: "INSERT INTO watch_message_legacy_imports(command_id_hash, content_hash) VALUES (?, ?)",
                    arguments: [idHash, existing?.phase == .tombstone ? nil : contentHash])
                importedIDs.insert(Data(message.id.utf8))
            }
            // A legacy recent ID has no route or execution proof. It can only
            // block replay; it must never become a command or a successful receipt.
            for id in recentIDs {
                // Never replace an imported body's fingerprint with ID-only metadata.
                try db.execute(
                    sql: "INSERT OR IGNORE INTO watch_message_legacy_imports(command_id_hash) VALUES (?)",
                    arguments: [Self.legacyIDHash(id)])
                let firstImport = db.changesCount > 0 || importedIDs.contains(Data(id.utf8))
                try db.execute(
                    sql: "DELETE FROM watch_message_journal WHERE command_id = ? AND phase = 'needsReview'",
                    arguments: [id])
                // Repeated snapshots must not renew an expired ID-only tombstone.
                guard firstImport || db.changesCount > 0 else { continue }
                try db.execute(
                    sql: """
                    INSERT OR IGNORE INTO watch_message_journal(
                        command_id, admitted_at_ms, expires_at_ms, phase, receipt_destination
                    ) VALUES (?, ?, ?, 'tombstone', 'phone')
                    """,
                    arguments: [id, nowMs, nowMs + OpenClawWatchChatDeliveryCodec.lifetimeMs])
            }
            try db.execute(
                sql: "INSERT OR IGNORE INTO grdb_migrations(identifier) VALUES (?)",
                arguments: [Self.legacyImportIdentifier])
        }
    }

    private static func legacyIDHash(_ id: String) -> String {
        SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func legacyContentHash(_ message: OpenClawWatchMessageLegacyImport.Message) -> String {
        var bytes = Data()
        // Presence and byte lengths distinguish nil, empty, zero and embedded separators.
        for field in [message.id, message.gatewayStableID, message.text, message.submittedAtMs.map(String.init)] {
            guard let field else {
                bytes.append(0)
                continue
            }
            bytes.append(1)
            var length = UInt64(field.utf8.count).bigEndian
            withUnsafeBytes(of: &length) { bytes.append(contentsOf: $0) }
            bytes.append(contentsOf: field.utf8)
        }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    private static func legacyImportConflict() -> OpenClawWatchChatDeliveryError {
        OpenClawWatchChatDeliveryError(
            code: "legacy_import_conflict",
            message: String(
                localized: "Watch messages need recovery. Contact support; Reset Onboarding erases all local data."))
    }

    static func hasImportedLegacyMessages(_ db: Database) throws -> Bool {
        try Bool.fetchOne(
            db,
            sql: "SELECT EXISTS(SELECT 1 FROM grdb_migrations WHERE identifier = ?)",
            arguments: [self.legacyImportIdentifier]) == true
    }
}
