import Foundation
import OpenClawNativeState

/// Watch-owned app-crash recovery. The phone's journal, not transport callbacks, owns admission.
public actor OpenClawWatchChatDeliveryStore {
    public struct Entry: Sendable, Equatable {
        public let command: OpenClawWatchChatDeliveryCommand
        public let receipt: OpenClawWatchChatDeliveryReceipt?
    }

    private let databaseURL: URL
    private var connection: OpenClawNativeStateSQLite?

    public init(databaseURL: URL = URL.applicationSupportDirectory
        .appendingPathComponent("OpenClaw/watch-chat-delivery.sqlite"))
    {
        self.databaseURL = databaseURL
    }

    public func enqueue(_ command: OpenClawWatchChatDeliveryCommand, nowMs: Int64) throws {
        try OpenClawWatchChatDeliveryCodec.validateCommand(command, nowMs: nowMs)
        let json = try Self.json(command)
        let database = try self.database()
        try database.withImmediateTransaction {
            if let existing = try self.entry(command.context.gatewayStableID, command.commandId, database: database) {
                guard existing.command == command else { throw Self.conflict() }
                return
            }
            let count = try database.prepare("""
            SELECT count(*), coalesce(sum(receipt_json IS NULL), 0)
            FROM watch_chat_delivery WHERE expires_at_ms > ?
            """)
            try count.bindInt64(nowMs, at: 1)
            guard try count.step() == .row,
                  count.int64(at: 0) < Int64(OpenClawWatchChatDeliveryCodec.maxUnexpiredCommands),
                  count.int64(at: 1) < Int64(OpenClawWatchChatDeliveryCodec.maxPendingCommands)
            else {
                throw OpenClawWatchChatDeliveryError(
                    code: "queue_full",
                    message: String(
                        localized: "The Watch message queue is full. Reconnect to iPhone before sending more."))
            }
            let insert = try database.prepare("""
            INSERT INTO watch_chat_delivery
              (gateway_id, command_id, route_generation, submitted_at_ms, expires_at_ms, command_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """)
            try insert.bindText(command.context.gatewayStableID, at: 1)
            try insert.bindText(command.commandId, at: 2)
            try insert.bindText(command.context.routeGeneration, at: 3)
            try insert.bindInt64(command.submittedAtMs, at: 4)
            try insert.bindInt64(command.expiresAtMs, at: 5)
            try insert.bindText(json, at: 6)
            _ = try insert.step()
        }
    }

    public func pendingCommands(nowMs: Int64) throws -> [OpenClawWatchChatDeliveryCommand] {
        let database = try self.database()
        let query = try database.prepare("""
        SELECT command_json, receipt_json FROM watch_chat_delivery
        WHERE receipt_json IS NULL AND expires_at_ms > ? ORDER BY submitted_at_ms, gateway_id, command_id
        """)
        try query.bindInt64(nowMs, at: 1)
        return try Self.read(query).map(\.command).sorted { left, right in
            if left.kind != right.kind { return left.kind == .quickReply }
            if left.submittedAtMs != right.submittedAtMs { return left.submittedAtMs < right.submittedAtMs }
            return left.commandId.utf8.lexicographicallyPrecedes(right.commandId.utf8)
        }
    }

    public func entries(
        context: OpenClawWatchChatDeliveryContext,
        nowMs: Int64) throws -> [Entry]
    {
        try OpenClawWatchChatDeliveryCodec.validateContext(context)
        let query = try self.database().prepare("""
        SELECT command_json, receipt_json FROM watch_chat_delivery
        WHERE gateway_id = ? AND route_generation = ? AND expires_at_ms > ?
        ORDER BY submitted_at_ms, command_id
        """)
        try query.bindText(context.gatewayStableID, at: 1)
        try query.bindText(context.routeGeneration, at: 2)
        try query.bindInt64(nowMs, at: 3)
        return try Self.read(query).filter { $0.command.context == context }
    }

    public func isPending(_ command: OpenClawWatchChatDeliveryCommand, nowMs: Int64) throws -> Bool {
        guard nowMs < command.expiresAtMs,
              let existing = try self.entry(
                  command.context.gatewayStableID,
                  command.commandId,
                  database: self.database())
        else { return false }
        return existing.command == command && existing.receipt == nil
    }

    /// Keep command and receipt together so expiry is projected for its saved owner before pruning.
    public func expiredEntries(nowMs: Int64) throws -> [Entry] {
        let query = try self.database().prepare("""
        SELECT command_json, receipt_json FROM watch_chat_delivery
        WHERE expires_at_ms <= ? ORDER BY submitted_at_ms, gateway_id, command_id
        """)
        try query.bindInt64(nowMs, at: 1)
        return try Self.read(query)
    }

    @discardableResult
    public func pruneExpired(nowMs: Int64) throws -> Int {
        let database = try self.database()
        return try database.withImmediateTransaction {
            let delete = try database.prepare("DELETE FROM watch_chat_delivery WHERE expires_at_ms <= ?")
            try delete.bindInt64(nowMs, at: 1)
            _ = try delete.step()
            return Int(database.changes)
        }
    }

    /// Unknown receipts cannot manufacture ownership. A terminal ACK follows the SQLite commit.
    public func record(
        _ receipt: OpenClawWatchChatDeliveryReceipt,
        nowMs: Int64) throws -> OpenClawWatchChatDeliveryReceiptAck?
    {
        try OpenClawWatchChatDeliveryCodec.validateReceipt(receipt)
        let json = try Self.json(receipt)
        let database = try self.database()
        return try database.withImmediateTransaction {
            guard let existing = try self.entry(receipt.context.gatewayStableID, receipt.commandId, database: database)
            else {
                throw OpenClawWatchChatDeliveryError(
                    code: "unknown_command", message: "This receipt does not belong to a saved Watch message.")
            }
            // New submissions use fresh UUIDs; retries preserve the original command and ID.
            guard existing.command.context == receipt.context else { throw Self.conflict() }
            if case let .rejected(code, _) = receipt.state,
               code == OpenClawWatchChatDeliveryCodec.staleRouteCode
            {
                // Only a receipt for an actually held command can clear its retired generation.
                let delete = try database.prepare("""
                DELETE FROM watch_chat_delivery WHERE gateway_id = ? AND route_generation = ?
                """)
                try delete.bindText(receipt.context.gatewayStableID, at: 1)
                try delete.bindText(receipt.context.routeGeneration, at: 2)
                _ = try delete.step()
                return nil
            }
            if case .rejected = receipt.state {
                if let previous = existing.receipt {
                    // Actual custody outranks a denial of another retransmission, in either arrival order.
                    if case .rejected = previous.state, previous != receipt { throw Self.conflict() }
                    return nil
                }
            } else {
                try OpenClawWatchChatDeliveryCodec.validateCommand(existing.command, nowMs: nowMs)
                if let previous = existing.receipt, previous.terminal != nil {
                    if receipt.terminal == nil { return nil }
                    guard previous == receipt else { throw Self.conflict() }
                    return Self.acknowledgment(previous)
                }
                if let previous = existing.receipt, case .admitted = previous.state,
                   case .admitted = receipt.state { return nil }
            }
            let update = try database.prepare("""
            UPDATE watch_chat_delivery SET receipt_json = ? WHERE gateway_id = ? AND command_id = ?
            """)
            try update.bindText(json, at: 1)
            try update.bindText(receipt.context.gatewayStableID, at: 2)
            try update.bindText(receipt.commandId, at: 3)
            _ = try update.step()
            return Self.acknowledgment(receipt)
        }
    }

    /// Includes a still-held expired denial so presentation can precede its immediate cleanup.
    public func receipt(context: OpenClawWatchChatDeliveryContext, commandId: String) throws
        -> OpenClawWatchChatDeliveryReceipt?
    {
        guard let entry = try self.entry(context.gatewayStableID, commandId, database: self.database()),
              entry.command.context == context,
              entry.command.commandId.utf8.elementsEqual(commandId.utf8)
        else { return nil }
        return entry.receipt
    }

    private static func acknowledgment(
        _ receipt: OpenClawWatchChatDeliveryReceipt) -> OpenClawWatchChatDeliveryReceiptAck?
    {
        receipt.terminal.map {
            OpenClawWatchChatDeliveryReceiptAck(
                context: receipt.context, commandId: receipt.commandId, receiptId: $0.receiptId)
        }
    }

    private static func json(_ value: some Encodable) throws -> String {
        let data = try OpenClawWatchChatDeliveryCodec.canonicalData(value)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw OpenClawNativeStateError("Could not encode the Watch delivery record")
        }
        return json
    }

    private func entry(
        _ gatewayID: String,
        _ commandID: String,
        database: OpenClawNativeStateSQLite) throws -> Entry?
    {
        let query = try database.prepare("""
        SELECT command_json, receipt_json FROM watch_chat_delivery WHERE gateway_id = ? AND command_id = ?
        """)
        try query.bindText(gatewayID, at: 1)
        try query.bindText(commandID, at: 2)
        return try Self.read(query).first
    }

    private static func read(_ query: OpenClawNativeStateSQLiteStatement) throws -> [Entry] {
        var entries: [Entry] = []
        while try query.step() == .row {
            let command = try JSONDecoder().decode(
                OpenClawWatchChatDeliveryCommand.self,
                from: Data(query.requiredText(at: 0, field: "Watch command").utf8))
            try OpenClawWatchChatDeliveryCodec.validateCommandStructure(command)
            let receipt: OpenClawWatchChatDeliveryReceipt?
            if query.valueType(at: 1) == .null {
                receipt = nil
            } else {
                receipt = try JSONDecoder().decode(
                    OpenClawWatchChatDeliveryReceipt.self,
                    from: Data(query.requiredText(at: 1, field: "Watch receipt").utf8))
                if let receipt {
                    try OpenClawWatchChatDeliveryCodec.validateReceipt(receipt)
                    guard receipt.context == command.context,
                          receipt.commandId.utf8.elementsEqual(command.commandId.utf8)
                    else { throw Self.conflict() }
                }
            }
            entries.append(Entry(command: command, receipt: receipt))
        }
        return entries
    }

    private func database() throws -> OpenClawNativeStateSQLite {
        if let connection { return connection }
        let database = try OpenClawNativeStateSQLite(databaseURL: self.databaseURL)
        try database.withImmediateTransaction {
            switch try database.scalarInt64("PRAGMA user_version") {
            case 0:
                guard try database.scalarInt64("SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'") == 0
                else { throw OpenClawNativeStateError("Unrecognized Watch delivery database") }
                try database.execute("""
                CREATE TABLE watch_chat_delivery (
                  gateway_id TEXT NOT NULL,
                  command_id TEXT NOT NULL,
                  route_generation TEXT NOT NULL,
                  submitted_at_ms INTEGER NOT NULL,
                  expires_at_ms INTEGER NOT NULL,
                  command_json TEXT NOT NULL,
                  receipt_json TEXT,
                  PRIMARY KEY (gateway_id, command_id)
                ) STRICT;
                CREATE INDEX watch_chat_delivery_expiry ON watch_chat_delivery(expires_at_ms);
                PRAGMA user_version = 1;
                """)
            case 1:
                break
            default:
                throw OpenClawNativeStateError("Update OpenClaw to open this Watch delivery database")
            }
        }
        guard try database.scalarText("PRAGMA journal_mode = WAL") == "wal" else {
            throw OpenClawNativeStateError("Could not enable the Watch delivery journal")
        }
        // NORMAL covers app termination; this contract does not promise power-loss durability.
        try database.execute("PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON;")
        self.connection = database
        return database
    }

    private static func conflict() -> OpenClawWatchChatDeliveryError {
        OpenClawWatchChatDeliveryError(
            code: "identity_conflict",
            message: String(localized: "This Watch message no longer matches its saved delivery owner."))
    }
}
