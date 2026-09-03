import CryptoKit
import Foundation
import GRDB
import OpenClawKit
import OSLog

/// The phone's single owner for Watch admission, dispatch claims and receipts.
/// It shares client-state's queue; network work never runs in its transactions.
public actor OpenClawWatchMessageJournal {
    struct ClaimIdentity: Equatable, Sendable {
        let commandId: String
        let fingerprint: Data
        let owner: OpenClawWatchMessageOwner
        let attemptVersion: Int64
        let expiresAtMs: Int64

        init?(_ entry: OpenClawWatchMessageEntry) throws {
            guard let command = entry.command, let owner = entry.owner, let expiresAtMs = entry.expiresAtMs else {
                return nil
            }
            self.commandId = entry.commandId
            self.fingerprint = try OpenClawWatchMessageJournal.fingerprint(command)
            self.owner = owner
            self.attemptVersion = entry.attemptVersion
            self.expiresAtMs = expiresAtMs
        }
    }

    private enum SendingSettlement: Sendable {
        case accepted(runID: String)
        case notDispatched
        case uncertain
        case routingChanged
    }

    private struct PendingSettlement: Sendable {
        let token = UUID()
        let claim: ClaimIdentity
        let result: SendingSettlement
    }

    let queue: DatabaseQueue
    private var recoveryTask: Task<Void, any Error>?
    private var pendingSettlements: [Data: PendingSettlement] = [:]
    private static let logger = Logger(subsystem: "ai.openclaw", category: "WatchMessageJournal")

    init(queue: DatabaseQueue) {
        self.queue = queue
    }

    public func route(gatewayStableID: String) async throws -> OpenClawWatchMessageRoute? {
        try await self.queue.write { db in
            try Self.requireImport(db)
            try Self.requireGatewayAvailable(db, gatewayID: gatewayStableID)
            guard let row = try Row.fetchOne(
                db,
                sql: "SELECT * FROM gateway_routing_identity WHERE gateway_id = ?",
                arguments: [gatewayStableID]),
                let identity = OpenClawChatSessionRoutingIdentity(
                    scope: row["scope"],
                    mainSessionKey: row["main_session_key"],
                    defaultAgentID: row["default_agent_id"])
            else { return nil }
            // Forget deletes this row. Never restore a generation captured before
            // the transaction: a newly paired owner must get a fresh identity.
            let generation: String
            if let existing: String = row["watch_route_generation"] {
                generation = existing
            } else {
                generation = UUID().uuidString
                try db.execute(
                    sql: "UPDATE gateway_routing_identity SET watch_route_generation = ? WHERE gateway_id = ?",
                    arguments: [generation, gatewayStableID])
            }
            return OpenClawWatchMessageRoute(
                owner: OpenClawWatchMessageOwner(gatewayStableID: gatewayStableID, routeGeneration: generation),
                routingIdentity: identity)
        }
    }

    public func admit(
        _ command: OpenClawWatchChatDeliveryCommand,
        nowMs: Int64,
        destination: OpenClawWatchMessageReceiptDestination = .watch) async throws -> OpenClawWatchMessageEntry
    {
        try OpenClawWatchChatDeliveryCodec.validateCommand(command, nowMs: nowMs)
        try await self.pruneExpired(nowMs: nowMs)
        let commandJSON = try Self.encode(command)
        let commandFingerprint = Data(SHA256.hash(data: Data(commandJSON.utf8)))
        let receiptJSON = try Self.encode(OpenClawWatchChatDeliveryReceipt(
            context: command.context, commandId: command.commandId, state: .admitted(atMs: nowMs)))
        return try await self.queue.write { db in
            try Self.requireImport(db)
            try Self.requireContext(db, context: command.context, matchRoutingContract: false)
            if let row = try Row.fetchOne(
                db, sql: "SELECT * FROM watch_message_journal WHERE command_id = ?", arguments: [command.commandId])
            {
                let existing = try Self.decode(row)
                let savedFingerprint: Data? = row["command_fingerprint"]
                // Dismiss removes the body, not its identity. Legacy rows have no
                // fingerprint and cannot replay as newly admitted commands.
                guard savedFingerprint == commandFingerprint, existing.destination == destination else {
                    throw OpenClawWatchChatDeliveryError(
                        code: "identity_conflict",
                        message: String(localized: """
                        This message ID already belongs to different or older work. Start a new message.
                        """))
                }
                return existing
            }
            try Self.requireContext(db, context: command.context, matchRoutingContract: true)
            let unexpired = try Int.fetchOne(
                db, sql: "SELECT COUNT(*) FROM watch_message_journal WHERE route_generation IS NOT NULL") ?? 0
            let pending = try Int.fetchOne(
                db, sql: "SELECT COUNT(*) FROM watch_message_journal WHERE phase IN ('queued', 'sending')") ?? 0
            guard unexpired < OpenClawWatchChatDeliveryCodec.maxUnexpiredCommands,
                  pending < OpenClawWatchChatDeliveryCodec.maxPendingCommands
            else {
                throw OpenClawWatchChatDeliveryError(
                    code: "capacity", message: "The Watch message queue is full. Review pending messages on iPhone.")
            }
            try db.execute(
                sql: """
                INSERT INTO watch_message_journal(
                    command_id, gateway_id, route_generation, kind, command_json, command_fingerprint,
                    submitted_at_ms, admitted_at_ms, expires_at_ms, phase, receipt_json, receipt_destination
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
                """,
                arguments: [
                    command.commandId, command.context.gatewayStableID, command.context.routeGeneration,
                    command.kind.rawValue, commandJSON, commandFingerprint,
                    command.submittedAtMs, nowMs, command.expiresAtMs,
                    receiptJSON, destination.rawValue,
                ])
            return try Self.requireEntry(db, id: command.commandId)
        }
    }

    public func claim(_ command: OpenClawWatchChatDeliveryCommand, nowMs: Int64) async throws
        -> OpenClawWatchMessageEntry?
    {
        try await self.pruneExpired(nowMs: nowMs)
        return try await self.queue.write { db in
            // A suspended dispatcher may outlive this ID's original row.
            guard let entry = try Self.fetch(db, id: command.commandId), entry.command == command,
                  entry.owner == OpenClawWatchMessageOwner(context: command.context), entry.phase == .queued,
                  entry.expiresAtMs == command.expiresAtMs, command.expiresAtMs > max(nowMs, Self.nowMs)
            else { return nil }
            do {
                try Self.requireContext(db, context: command.context, matchRoutingContract: true)
            } catch let error as OpenClawWatchChatDeliveryError where error.code == "routing_changed" {
                try Self.storeTerminal(
                    db,
                    entry: entry,
                    outcome: .failed(code: error.code, message: error.message),
                    nowMs: nowMs)
                return nil
            }
            try db.execute(
                sql: """
                UPDATE watch_message_journal SET phase = 'sending', attempt_version = attempt_version + 1
                WHERE command_id = ? AND phase = 'queued' AND attempt_version = ?
                """,
                arguments: [command.commandId, entry.attemptVersion])
            return try Self.requireEntry(db, id: command.commandId)
        }
    }

    /// Only the transport's typed notDispatched result permits this transition.
    /// A timeout, cancellation or lost response leaves execution uncertain.
    public func releaseNotDispatched(_ entry: OpenClawWatchMessageEntry) async throws -> OpenClawWatchMessageMutation {
        try await self.writeSettlement(entry, phases: [.sending], recovery: .notDispatched) { db, current in
            try Self.storeNotDispatched(db, entry: current)
            return .applied
        }
    }

    public func recordAccepted(_ entry: OpenClawWatchMessageEntry, runID: String) async throws
        -> OpenClawWatchMessageMutation
    {
        guard !runID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw OpenClawWatchChatDeliveryError(code: "invalid_run", message: "The Gateway returned no run identity.")
        }
        return try await self
            .writeSettlement(entry, phases: [.sending], recovery: .accepted(runID: runID)) { db, current in
                try Self.storeAccepted(db, entry: current, runID: runID)
                return .applied
            }
    }

    public func recordTerminal(
        _ entry: OpenClawWatchMessageEntry,
        outcome: OpenClawWatchChatDeliveryOutcome,
        nowMs: Int64) async throws -> OpenClawWatchMessageMutation
    {
        let bounded: OpenClawWatchChatDeliveryOutcome
        if case let .reply(text) = outcome {
            let text = OpenClawWatchChatDeliveryCodec.boundedReplyText(text)
            guard !text.isEmpty else {
                throw OpenClawWatchChatDeliveryError(
                    code: "empty_reply",
                    message: "The Gateway returned an empty reply.")
            }
            bounded = .reply(text: text)
        } else {
            bounded = outcome
        }
        let recovery: SendingSettlement? = switch bounded {
        case .uncertain: .uncertain
        case .failed(code: "routing_changed", message: _): .routingChanged
        default: nil
        }
        return try await self.writeSettlement(
            entry, phases: [.sending, .accepted], nowMs: nowMs, recovery: recovery)
        { db, current in
            switch bounded {
            case .reply, .forwarded:
                guard current.phase == .accepted, current.acceptedRunID != nil else { return .superseded }
            case .failed, .uncertain:
                break
            }
            try Self.storeTerminal(db, entry: current, outcome: bounded, nowMs: nowMs)
            return .applied
        }
    }

    public func acknowledge(_ ack: OpenClawWatchChatDeliveryReceiptAck) async throws -> OpenClawWatchMessageMutation {
        try OpenClawWatchChatDeliveryCodec.validateReceiptAck(ack)
        return try await self.queue.write { db in
            guard let current = try Self.fetch(db, id: ack.commandId) else { return .missing }
            guard current.receipt?.context == ack.context,
                  current.receipt?.terminal?.receiptId == ack.receiptId,
                  current.destination == .watch,
                  (current.expiresAtMs ?? 0) > Self.nowMs,
                  [.receiptReady, .received, .tombstone].contains(current.phase)
            else { return .superseded }
            try Self.requireContext(db, context: ack.context, matchRoutingContract: false)
            try db.execute(
                sql: "UPDATE watch_message_journal SET phase = 'received' WHERE command_id = ?",
                arguments: [ack.commandId])
            return .applied
        }
    }

    public func recoverInterruptedWork(nowMs: Int64) async throws {
        try await self.retryPendingSettlements(nowMs: nowMs)
        if let recoveryTask {
            try await recoveryTask.value
            return
        }
        let queue = self.queue
        let task = Task<Void, any Error> {
            let expired = try await queue.write { db in
                try Self.requireImport(db)
                let expired = try Self.deleteExpired(db, nowMs: nowMs)
                for row in try Row.fetchAll(db, sql: "SELECT * FROM watch_message_journal WHERE phase = 'sending'") {
                    let entry = try Self.decode(row)
                    guard let command = entry.command else { continue }
                    // Retirement grants no dispatch authority. Cancellable Forget
                    // must not block recovery of this or another Gateway's work.
                    _ = try Self.requirePersistedGeneration(db, context: command.context)
                    try Self.storeTerminal(
                        db,
                        entry: entry,
                        outcome: .uncertain(
                            message: String(localized: """
                            Delivery was interrupted. Check Chat on iPhone before sending again.
                            """)),
                        nowMs: nowMs)
                }
                return expired
            }
            Self.logExpired(expired)
        }
        self.recoveryTask = task
        do {
            try await task.value
        } catch {
            self.recoveryTask = nil
            throw error
        }
    }

    public func entries(owner: OpenClawWatchMessageOwner? = nil) async throws -> [OpenClawWatchMessageEntry] {
        try await self.pruneExpired(nowMs: Self.nowMs)
        return try await self.queue.read { db in try Self.fetchEntries(db, owner: owner) }
    }

    public func resumableEntry(
        id: String, context: OpenClawWatchChatDeliveryContext) async throws -> OpenClawWatchMessageEntry?
    {
        try await self.pruneExpired(nowMs: Self.nowMs)
        return try await self.queue.read { db in
            guard let entry = try Self.fetch(db, id: id),
                  entry.owner == OpenClawWatchMessageOwner(context: context), entry.command?.context == context,
                  [.queued, .accepted].contains(entry.phase), (entry.expiresAtMs ?? 0) > Self.nowMs
            else { return nil }
            do {
                // New observers wait for Forget to be cancelled; late settlement
                // still uses its existing persisted-generation-only check.
                try Self.requireContext(db, context: context, matchRoutingContract: false)
            } catch is OpenClawWatchChatDeliveryError {
                return nil
            }
            return entry
        }
    }

    public func changes(owner: OpenClawWatchMessageOwner? = nil) async throws
        -> some AsyncSequence<[OpenClawWatchMessageEntry], any Error> & Sendable
    {
        try await self.pruneExpired(nowMs: Self.nowMs)
        return ValueObservation.tracking { db in try Self.fetchEntries(db, owner: owner) }
            .values(in: self.queue, bufferingPolicy: .bufferingNewest(1))
    }

    public func accepted(owner: OpenClawWatchMessageOwner) async throws -> [OpenClawWatchMessageEntry] {
        try await self.entries(in: .accepted, owner: owner)
    }

    public func pendingReceipts(owner: OpenClawWatchMessageOwner? = nil) async throws -> [OpenClawWatchMessageEntry] {
        let now = Self.nowMs
        return try await self.entries(owner: owner).filter {
            $0.destination == .watch && [.receiptReady, .tombstone].contains($0.phase) &&
                $0.receipt?.terminal != nil && ($0.expiresAtMs ?? 0) > now
        }
    }

    @discardableResult
    public func pruneExpired(nowMs: Int64) async throws -> Int {
        let count = try await self.queue.write { db in try Self.deleteExpired(db, nowMs: nowMs) }
        self.pendingSettlements = self.pendingSettlements.filter { $0.value.claim.expiresAtMs > nowMs }
        Self.logExpired(count)
        return count
    }

    private static func logExpired(_ count: Int) {
        guard count > 0 else { return }
        self.logger.info("Expired \(count, privacy: .public) Watch delivery records at their original deadline.")
    }

    public func discard(
        id: String,
        exactOwner: OpenClawWatchMessageOwner?) async throws -> OpenClawWatchMessageMutation
    {
        try await self.queue.write { db in
            guard let entry = try Self.fetch(db, id: id) else { return .missing }
            guard entry.owner == exactOwner, entry.phase == .needsReview,
                  entry.command == nil, entry.expiresAtMs == nil
            else { return .superseded }
            try db.execute(sql: "DELETE FROM watch_message_journal WHERE command_id = ?", arguments: [id])
            return .applied
        }
    }

    public func dismiss(
        id: String,
        exactOwner: OpenClawWatchMessageOwner?) async throws -> OpenClawWatchMessageMutation
    {
        try await self.queue.write { db in
            guard let entry = try Self.fetch(db, id: id) else { return .missing }
            guard entry.owner == exactOwner, [.receiptReady, .received].contains(entry.phase),
                  entry.receipt?.terminal != nil
            else { return .superseded }
            // Hide the card without replacing the receipt the Watch may already
            // have acknowledged. Its phase and original expiry still own replay.
            try db.execute(
                sql: """
                UPDATE watch_message_journal SET command_json = NULL, legacy_text = NULL
                WHERE command_id = ?
                """,
                arguments: [id])
            return .applied
        }
    }

    private func entries(
        in phase: OpenClawWatchMessagePhase,
        owner: OpenClawWatchMessageOwner) async throws -> [OpenClawWatchMessageEntry]
    {
        let now = Self.nowMs
        return try await self.entries(owner: owner).filter {
            $0.phase == phase && ($0.expiresAtMs ?? 0) > now
        }
    }

    private func writeSettlement(
        _ entry: OpenClawWatchMessageEntry,
        phases: [OpenClawWatchMessagePhase],
        nowMs: Int64? = nil,
        recovery: SendingSettlement?,
        updates: @escaping @Sendable (Database, OpenClawWatchMessageEntry) throws -> OpenClawWatchMessageMutation)
        async throws -> OpenClawWatchMessageMutation
    {
        let claim = try ClaimIdentity(entry)
        do {
            let result = try await self.queue.write { db in
                guard let claim,
                      let current = try Self.current(
                          db, expected: claim, phases: phases, nowMs: max(nowMs ?? Self.nowMs, Self.nowMs))
                else { return try Self.missingOrSuperseded(db, id: entry.commandId) }
                return try updates(db, current)
            }
            if self.pendingSettlements[entry.id]?.claim == claim { self.pendingSettlements[entry.id] = nil }
            return result
        } catch {
            if entry.phase == .sending, let claim, claim.expiresAtMs > Self.nowMs, let recovery {
                // Keep only claim identity and the known result, never message or reply text.
                self.pendingSettlements[entry.id] = PendingSettlement(claim: claim, result: recovery)
            }
            throw error
        }
    }

    private func retryPendingSettlements(nowMs: Int64) async throws {
        var firstError: (any Error)?
        for (id, pending) in self.pendingSettlements {
            guard self.pendingSettlements[id]?.token == pending.token else { continue }
            self.pendingSettlements[id] = nil
            do {
                try await self.queue.write { db in
                    let now = max(nowMs, Self.nowMs)
                    guard let current = try Self.current(db, expected: pending.claim, phases: [.sending], nowMs: now)
                    else { return }
                    switch pending.result {
                    case let .accepted(runID):
                        try Self.storeAccepted(db, entry: current, runID: runID)
                    case .notDispatched:
                        try Self.storeNotDispatched(db, entry: current)
                    case .uncertain:
                        try Self.storeTerminal(
                            db,
                            entry: current,
                            outcome: .uncertain(message: String(localized:
                                "Delivery could not be confirmed. Check Chat on iPhone before sending again.")),
                            nowMs: now)
                    case .routingChanged:
                        try Self.storeTerminal(
                            db,
                            entry: current,
                            outcome: .failed(
                                code: "routing_changed",
                                message: String(localized:
                                    "The Gateway delivery target changed. Review this message on iPhone.")),
                            nowMs: now)
                    }
                }
            } catch {
                if self.pendingSettlements[id] == nil, pending.claim.expiresAtMs > max(nowMs, Self.nowMs) {
                    self.pendingSettlements[id] = pending
                }
                if firstError == nil { firstError = error }
            }
        }
        if let firstError { throw firstError }
    }
}
