import Foundation
import GRDB
import OpenClawKit
import OSLog

private let cacheLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatTranscriptCache")

final class OutboxChangeHub: @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [UUID: AsyncStream<OpenClawChatOutboxChange>.Continuation] = [:]

    func stream() -> AsyncStream<OpenClawChatOutboxChange> {
        let id = UUID()
        let pair = AsyncStream<OpenClawChatOutboxChange>.makeStream()
        self.lock.lock()
        self.continuations[id] = pair.continuation
        self.lock.unlock()
        pair.continuation.onTermination = { [weak self] _ in
            self?.remove(id)
        }
        return pair.stream
    }

    func yield(_ change: OpenClawChatOutboxChange) {
        self.lock.lock()
        let continuations = Array(self.continuations.values)
        self.lock.unlock()
        for continuation in continuations {
            continuation.yield(change)
        }
    }

    func finish() {
        self.lock.lock()
        let continuations = Array(self.continuations.values)
        self.continuations.removeAll()
        self.lock.unlock()
        for continuation in continuations {
            continuation.finish()
        }
    }

    private func remove(_ id: UUID) {
        self.lock.lock()
        self.continuations.removeValue(forKey: id)
        self.lock.unlock()
    }
}

/// Canonical gateway evidence must beat a user cancellation synchronously;
/// actor hops would leave a window where an already-delivered row is hidden.
private final class CanonicalMessageProofHub: @unchecked Sendable {
    private static let maxKeys = 512
    private let lock = NSLock()
    private var keys: [String] = []

    func observe(_ observed: Set<String>) {
        guard !observed.isEmpty else { return }
        self.lock.lock()
        for key in observed.sorted() {
            self.keys.removeAll(where: { $0 == key })
            self.keys.append(key)
        }
        if self.keys.count > Self.maxKeys {
            self.keys.removeFirst(self.keys.count - Self.maxKeys)
        }
        self.lock.unlock()
    }

    func lockProofDecision(for key: String) -> Bool {
        self.lock.lock()
        return self.keys.contains(key)
    }

    func unlockProofDecision() {
        self.lock.unlock()
    }
}

/// Gateway-scoped facade over the installation-wide cache and client-state
/// databases. The facade owns no SQLite connection; every gateway store from
/// one container shares exactly one GRDB queue per database file.
public actor OpenClawChatSQLiteTranscriptCache: OpenClawChatTranscriptCache,
    OpenClawChatCanonicalTranscriptMerging,
    OpenClawChatCommandOutbox
{
    public static let maxCachedSessions = 50
    public static let maxCachedTranscripts = 50
    public static let maxCachedMessagesPerSession = 200
    public static let maxQueuedCommands = 50
    public static let maxAttachmentBytesPerCommand = 40_000_000
    public static let maxQueuedAttachmentBytes = 50_000_000
    public static let outboxCommandMaxAge: TimeInterval = 48 * 60 * 60
    public static let outboxExpiredError = "expired"
    public static let outboxUnconfirmedError = "delivery_unconfirmed"
    public static let outboxUnknownTargetError = "delivery_target_unknown"
    public static let outboxChangedTargetError = "delivery_target_changed"

    static func outboxDisplayError(_ lastError: String?) -> String? {
        guard let lastError,
              let marker = lastError.range(of: "\n# branch-park:")
        else { return lastError }
        return String(lastError[..<marker.lowerBound])
    }

    private let databases: OpenClawClientDatabases
    public nonisolated let gatewayID: String
    private var isRetired = false
    private var hasRecoveredInterruptedSends = false
    private nonisolated var outboxChangeHub: OutboxChangeHub {
        self.databases.outboxChangeHub
    }

    private nonisolated let storeChangeHub: OutboxChangeHub
    private nonisolated let storeChangeRelay: Task<Void, Never>

    private nonisolated let canonicalMessageProofHub = CanonicalMessageProofHub()

    init(databases: OpenClawClientDatabases, gatewayID: String) {
        self.databases = databases
        self.gatewayID = gatewayID
        let storeChangeHub = OutboxChangeHub()
        self.storeChangeHub = storeChangeHub
        let upstream = databases.outboxChangeHub.stream()
        self.storeChangeRelay = Task {
            for await change in upstream where change.gatewayID == gatewayID {
                storeChangeHub.yield(change)
            }
        }
    }

    deinit {
        storeChangeRelay.cancel()
        storeChangeHub.finish()
    }

    // MARK: - Gateway cache

    public func loadSessions() async -> [OpenClawChatSessionEntry] {
        guard !self.isRetired else { return [] }
        let gatewayID = self.gatewayID
        do {
            return try await self.databases.cacheQueue.write { db in
                let rows = try Row.fetchAll(
                    db,
                    sql: """
                    SELECT payload_json FROM cached_sessions
                    WHERE gateway_id = ? ORDER BY position
                    """,
                    arguments: [gatewayID])
                do {
                    return try rows.map { row in
                        let payload: String = row["payload_json"]
                        return try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(payload.utf8))
                    }
                } catch {
                    cacheLogger.error(
                        "gateway session cache decode failed: \(error.localizedDescription, privacy: .public)")
                    // Decode and cleanup share one transaction so a newer
                    // snapshot can never land between the failed read and delete.
                    try db.execute(
                        sql: "DELETE FROM cached_sessions WHERE gateway_id = ?",
                        arguments: [gatewayID])
                    return []
                }
            }
        } catch {
            cacheLogger.error("gateway session cache read failed: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    public func loadTranscript(sessionKey: String) async -> [OpenClawChatMessage] {
        await self.loadTranscript(sessionKey: sessionKey, agentID: nil)
    }

    public func loadTranscript(sessionKey: String, agentID: String?) async -> [OpenClawChatMessage] {
        guard !self.isRetired else { return [] }
        let normalizedAgentID = Self.normalizedAgentID(agentID)
        let gatewayID = self.gatewayID
        do {
            return try await self.databases.cacheQueue.write { db in
                let rows = try Row.fetchAll(
                    db,
                    sql: """
                    SELECT payload_json FROM cached_messages
                    WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
                    ORDER BY position
                    """,
                    arguments: [gatewayID, sessionKey, normalizedAgentID])
                do {
                    return try rows.map { row in
                        let payload: String = row["payload_json"]
                        return try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(payload.utf8))
                    }
                } catch {
                    cacheLogger.error(
                        "gateway transcript cache decode failed: \(error.localizedDescription, privacy: .public)")
                    // Keep the failed read and partition cleanup atomic; an
                    // overlapping history write must survive this recovery.
                    try db.execute(
                        sql: """
                        DELETE FROM cached_transcripts
                        WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
                        """,
                        arguments: [gatewayID, sessionKey, normalizedAgentID])
                    return []
                }
            }
        } catch {
            cacheLogger.error("gateway transcript cache read failed: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    public func storeSessions(_ sessions: [OpenClawChatSessionEntry]) async {
        guard !self.isRetired else { return }
        let bounded = Self.boundedSessions(sessions)
        let gatewayID = self.gatewayID
        do {
            let encoded = try bounded.map(Self.encodeJSON)
            try await self.databases.cacheQueue.write { db in
                try db.execute(
                    sql: "DELETE FROM cached_sessions WHERE gateway_id = ?",
                    arguments: [gatewayID])
                for (position, pair) in zip(bounded, encoded).enumerated() {
                    try db.execute(
                        sql: """
                        INSERT INTO cached_sessions(
                            gateway_id, session_key, position, updated_at, payload_json
                        ) VALUES (?, ?, ?, ?, ?)
                        """,
                        arguments: [
                            gatewayID,
                            pair.0.key,
                            position,
                            pair.0.updatedAt ?? 0,
                            pair.1,
                        ])
                }
            }
        } catch {
            cacheLogger.error("gateway session cache write failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    public func storeCanonicalTranscript(
        sessionKey: String,
        agentID: String?,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys: Set<String>) async
    {
        self.observeCanonicalMessageIdempotencyKeys(canonicalMessageIdempotencyKeys)
        // Every local user echo uses the `<runId>:user` convention. Requiring
        // explicit gateway proof also rejects a canceled echo captured by an
        // overlapping history reconciliation before its state row was deleted.
        let canonicalOnly = messages.filter { message in
            guard message.role.lowercased() == "user",
                  let key = message.idempotencyKey,
                  key.hasSuffix(":user")
            else { return true }
            return canonicalMessageIdempotencyKeys.contains(key)
        }
        await writeTranscript(sessionKey: sessionKey, agentID: agentID, messages: canonicalOnly)
    }

    public func mergeCanonicalTranscriptMessage(
        sessionKey: String,
        agentID: String?,
        message: OpenClawChatMessage,
        canonicalMessageIdempotencyKey: String) async
    {
        self.observeCanonicalMessageIdempotencyKeys([canonicalMessageIdempotencyKey])
        guard !self.isRetired else { return }
        let normalizedAgentID = Self.normalizedAgentID(agentID)
        let gatewayID = self.gatewayID
        do {
            try await self.databases.cacheQueue.write { db in
                let rows = try Row.fetchAll(
                    db,
                    sql: """
                    SELECT payload_json FROM cached_messages
                    WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
                    ORDER BY position
                    """,
                    arguments: [gatewayID, sessionKey, normalizedAgentID])
                var cached = rows.compactMap { row -> OpenClawChatMessage? in
                    let payload: String = row["payload_json"]
                    return try? JSONDecoder().decode(OpenClawChatMessage.self, from: Data(payload.utf8))
                }
                if let index = cached.firstIndex(where: {
                    $0.idempotencyKey?.trimmingCharacters(in: .whitespacesAndNewlines) ==
                        canonicalMessageIdempotencyKey
                }) {
                    cached[index] = message
                } else if let timestamp = message.timestamp,
                          let index = cached.firstIndex(where: {
                              ($0.timestamp ?? .greatestFiniteMagnitude) > timestamp
                          })
                {
                    cached.insert(message, at: index)
                } else {
                    cached.append(message)
                }
                try Self.replaceTranscript(
                    db,
                    gatewayID: gatewayID,
                    sessionKey: sessionKey,
                    agentID: normalizedAgentID,
                    messages: cached)
            }
        } catch {
            cacheLogger.error("gateway transcript cache merge failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    public nonisolated func observeCanonicalMessageIdempotencyKeys(_ keys: Set<String>) {
        self.canonicalMessageProofHub.observe(keys)
    }

    public func loadSessionRoutingIdentity() async -> OpenClawChatSessionRoutingIdentity? {
        guard !self.isRetired else { return nil }
        return self.databases.loadSessionRoutingIdentity(gatewayID: self.gatewayID)
    }

    public func storeSessionRoutingIdentity(_ identity: OpenClawChatSessionRoutingIdentity) async {
        guard !self.isRetired else { return }
        let gatewayID = self.gatewayID
        do {
            try await self.databases.stateQueue.write { db in
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
                    """,
                    arguments: [
                        gatewayID,
                        identity.scope,
                        identity.mainSessionKey,
                        identity.defaultAgentID,
                        Date().timeIntervalSince1970,
                    ])
            }
        } catch {
            cacheLogger.error("client state routing write failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    public func retire() async {
        self.isRetired = true
        self.storeChangeRelay.cancel()
        self.storeChangeHub.finish()
    }
}

extension OpenClawChatSQLiteTranscriptCache {
    private func writeTranscript(
        sessionKey: String,
        agentID: String?,
        messages: [OpenClawChatMessage]) async
    {
        guard !self.isRetired else { return }
        let normalizedAgentID = Self.normalizedAgentID(agentID)
        let gatewayID = self.gatewayID
        do {
            try await self.databases.cacheQueue.write { db in
                try Self.replaceTranscript(
                    db,
                    gatewayID: gatewayID,
                    sessionKey: sessionKey,
                    agentID: normalizedAgentID,
                    messages: messages)
            }
        } catch {
            cacheLogger.error("gateway transcript cache write failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private nonisolated static func replaceTranscript(
        _ db: Database,
        gatewayID: String,
        sessionKey: String,
        agentID: String,
        messages: [OpenClawChatMessage]) throws
    {
        let bounded = cacheableMessages(messages)
        let encoded = try bounded.map(encodeJSON)
        try db.execute(
            sql: """
            DELETE FROM cached_transcripts
            WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
            """,
            arguments: [gatewayID, sessionKey, agentID])
        guard !bounded.isEmpty else { return }
        try db.execute(
            sql: """
            INSERT INTO cached_transcripts(gateway_id, session_key, agent_id, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            arguments: [gatewayID, sessionKey, agentID, Date().timeIntervalSince1970])
        for (position, pair) in zip(bounded, encoded).enumerated() {
            try db.execute(
                sql: """
                INSERT INTO cached_messages(
                    gateway_id, session_key, agent_id, position,
                    timestamp_ms, idempotency_key, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                arguments: [
                    gatewayID,
                    sessionKey,
                    agentID,
                    position,
                    pair.0.timestamp,
                    pair.0.idempotencyKey,
                    pair.1,
                ])
        }
        let stale = try Row.fetchAll(
            db,
            sql: """
            SELECT session_key, agent_id FROM cached_transcripts
            WHERE gateway_id = ?
            ORDER BY updated_at DESC, rowid DESC
            LIMIT -1 OFFSET \(self.maxCachedTranscripts)
            """,
            arguments: [gatewayID])
        for row in stale {
            let staleSessionKey: String = row["session_key"]
            let staleAgentID: String = row["agent_id"]
            try db.execute(
                sql: """
                DELETE FROM cached_transcripts
                WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
                """,
                arguments: [gatewayID, staleSessionKey, staleAgentID])
        }
    }
}

extension OpenClawChatSQLiteTranscriptCache {
    // MARK: - Client-state outbox

    public nonisolated func changes() -> AsyncStream<OpenClawChatOutboxChange> {
        self.storeChangeHub.stream()
    }

    public func enqueueCommand(_ command: OpenClawChatOutboxCommand) async -> Bool {
        guard !self.isRetired,
              let attachmentByteCount = Self.attachmentByteCount(command.attachments),
              Self.canEnqueueAttachmentBytes(commandBytes: attachmentByteCount, queuedBytes: 0)
        else { return false }
        let gatewayID = self.gatewayID
        do {
            return try await self.databases.stateQueue.write { db in
                let count = try Int.fetchOne(
                    db,
                    sql: "SELECT COUNT(*) FROM outbox_commands WHERE gateway_id = ?",
                    arguments: [gatewayID]) ?? 0
                let queuedBytes = try Int.fetchOne(
                    db,
                    sql: """
                    SELECT COALESCE(SUM(attachment_bytes), 0)
                    FROM outbox_commands WHERE gateway_id = ?
                    """,
                    arguments: [gatewayID]) ?? 0
                guard count < Self.maxQueuedCommands,
                      Self.canEnqueueAttachmentBytes(
                          commandBytes: attachmentByteCount,
                          queuedBytes: queuedBytes)
                else { return false }
                let scope = OpenClawChatOutboxScope(
                    sessionKey: command.sessionKey,
                    agentID: command.agentID)
                try Self.ensureBranchScope(db, gatewayID: gatewayID, scope: scope)
                let branchState = try Self.readBranchState(db, gatewayID: gatewayID, scope: scope)
                try db.execute(
                    sql: """
                    INSERT INTO outbox_commands(
                        gateway_id, client_uuid, session_key, delivery_session_key,
                        routing_contract, agent_id, text, thinking, created_at,
                        status, attempt_version, branch_epoch, retry_count, last_error, attachment_bytes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    arguments: [
                        gatewayID,
                        command.id,
                        command.sessionKey,
                        command.deliverySessionKey,
                        command.routingContract ?? "",
                        Self.normalizedAgentID(command.agentID),
                        command.text,
                        command.thinking,
                        command.createdAt,
                        command.status.rawValue,
                        command.attemptVersion,
                        branchState.epoch,
                        command.retryCount,
                        command.lastError ?? "",
                        attachmentByteCount,
                    ])
                for (position, attachment) in command.attachments.enumerated() {
                    try db.execute(
                        sql: """
                        INSERT INTO outbox_attachments(
                            gateway_id, command_id, position, type, mime_type,
                            file_name, payload, duration_seconds
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        arguments: [
                            gatewayID,
                            command.id,
                            position,
                            attachment.type,
                            attachment.mimeType,
                            attachment.fileName,
                            attachment.data,
                            attachment.durationSeconds,
                        ])
                }
                return true
            }
        } catch {
            cacheLogger.error("outbox enqueue failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    public func loadCommands() async -> [OpenClawChatOutboxCommand] {
        await self.loadCommandsIfAvailable() ?? []
    }

    public func loadCommandsIfAvailable() async -> [OpenClawChatOutboxCommand]? {
        guard !self.isRetired else { return nil }
        let gatewayID = self.gatewayID
        do {
            return try await self.databases.stateQueue.write { db in
                try Self.applyOutboxStaleness(db, gatewayID: gatewayID)
                return try Self.readCommands(db, gatewayID: gatewayID)
            }
        } catch {
            cacheLogger.error("outbox read failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    @discardableResult
    public func recoverInterruptedSends() async -> Bool {
        guard !self.isRetired else { return false }
        if self.hasRecoveredInterruptedSends {
            return true
        }
        let gatewayID = self.gatewayID
        do {
            try await self.databases.stateQueue.write { db in
                // A send interrupted by process death may have reached the gateway;
                // keep that uncertainty so a post-park retry mints a fresh identity.
                try db.execute(
                    sql: """
                    UPDATE outbox_commands
                    SET status = 'failed', last_error = ?, had_unacknowledged_send = 1
                    WHERE gateway_id = ? AND status = 'sending'
                    """,
                    arguments: [Self.outboxUnconfirmedError, gatewayID])
            }
            self.hasRecoveredInterruptedSends = true
            return true
        } catch {
            return false
        }
    }

    public func claimNextCommand() async -> OpenClawChatOutboxCommand? {
        guard !self.isRetired else { return nil }
        let gatewayID = self.gatewayID
        do {
            let result = try await databases.stateQueue.write { db -> (
                OpenClawChatOutboxCommand?,
                [OpenClawChatOutboxScope]) in
                try Self.applyOutboxStaleness(db, gatewayID: gatewayID)
                let expiredScopes = try Self.expireBranchSwitchLeases(db, gatewayID: gatewayID)
                let active = try Int.fetchOne(
                    db,
                    sql: """
                    SELECT COUNT(*) FROM outbox_commands
                    WHERE gateway_id = ? AND status = 'sending'
                    """,
                    arguments: [gatewayID]) ?? 0
                guard active == 0,
                      let row = try Row.fetchOne(
                          db,
                          sql: """
                          SELECT c.*, s.branch_epoch AS scope_branch_epoch
                          FROM outbox_commands c
                          LEFT JOIN outbox_branch_scopes s
                            ON s.gateway_id = c.gateway_id AND s.session_key = c.session_key
                              AND s.agent_id = c.agent_id
                          WHERE c.gateway_id = ? AND c.status = 'queued'
                            AND s.switch_pending_since IS NULL
                            AND COALESCE(s.needs_reconciliation, 1) = 0
                          ORDER BY created_at, enqueue_sequence LIMIT 1
                          """,
                          arguments: [gatewayID])
                else { return (nil, expiredScopes) }
                let id: String = row["client_uuid"]
                try db.execute(
                    sql: """
                    UPDATE outbox_commands SET status = 'sending'
                    WHERE gateway_id = ? AND client_uuid = ? AND status = 'queued'
                    """,
                    arguments: [gatewayID, id])
                guard db.changesCount > 0 else { return (nil, expiredScopes) }
                var command = try Self.command(from: row, in: db, gatewayID: gatewayID)
                command.status = .sending
                return (command, expiredScopes)
            }
            for scope in result.1 {
                self.outboxChangeHub.yield(.invalidated(gatewayID: gatewayID, scope: scope))
            }
            return result.0
        } catch {
            cacheLogger.error("outbox claim failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func markCommandQueued(
        id: String,
        attemptVersion: Int,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    {
        await transitionClaimedCommand(
            id: id,
            attemptVersion: attemptVersion,
            status: .queued,
            retryCount: retryCount,
            lastError: lastError)
    }

    public func markCommandAwaitingConfirmation(
        id: String,
        attemptVersion: Int) async -> OpenClawChatOutboxUpdateResult
    {
        await transitionClaimedCommand(
            id: id,
            attemptVersion: attemptVersion,
            status: .awaitingConfirmation,
            retryCount: 0,
            lastError: nil)
    }

    public func markCommandFailedIfPresent(
        id: String,
        attemptVersion: Int,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    {
        await transitionClaimedCommand(
            id: id,
            attemptVersion: attemptVersion,
            status: .failed,
            retryCount: retryCount,
            lastError: lastError)
    }

    public func markCommandRetriedIfPresent(
        id: String,
        expectation: OpenClawChatOutboxRetryExpectation,
        agentID: String?,
        deliverySessionKey: String,
        routingContract: String,
        replacementID: String?) async -> OpenClawChatOutboxUpdateResult
    {
        guard !self.isRetired else { return .unavailable }
        let normalizedAgentID = agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let normalizedDeliverySessionKey = deliverySessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedRoutingContract = routingContract.trimmingCharacters(in: .whitespacesAndNewlines)
        let allowsUntargetedAgent = normalizedRoutingContract == OpenClawChatOutboxCommand
            .legacyUnboundRoutingContract || normalizedDeliverySessionKey.lowercased() == "unknown"
        guard !normalizedAgentID.isEmpty || allowsUntargetedAgent,
              !normalizedDeliverySessionKey.isEmpty,
              !normalizedRoutingContract.isEmpty
        else { return .unavailable }
        let gatewayID = self.gatewayID
        do {
            return try await self.databases.stateQueue.write { db in
                guard let row = try Row.fetchOne(
                    db,
                    sql: """
                    SELECT session_key, parked_was_accepted, had_unacknowledged_send, last_error
                    FROM outbox_commands
                    WHERE gateway_id = ? AND client_uuid = ? AND status = 'failed'
                      AND attempt_version = ? AND retry_count = ? AND last_error = ?
                    """,
                    arguments: [
                        gatewayID,
                        id,
                        expectation.attemptVersion,
                        expectation.retryCount,
                        expectation.lastError ?? "",
                    ])
                else { return .superseded }
                let previousSessionKey: String = row["session_key"]
                let retryScope = OpenClawChatOutboxScope(
                    sessionKey: previousSessionKey,
                    agentID: normalizedAgentID)
                try Self.ensureBranchScope(db, gatewayID: gatewayID, scope: retryScope)
                let branchState = try Self.readBranchState(db, gatewayID: gatewayID, scope: retryScope)
                let lastError: String = row["last_error"]
                let wasBranchParked = lastError.contains("\n# branch-park:")
                let parkedWasAccepted: Int = row["parked_was_accepted"]
                let hadUnacknowledgedSend: Int = row["had_unacknowledged_send"]
                let wasPossiblyAccepted = wasBranchParked &&
                    (parkedWasAccepted != 0 || hadUnacknowledgedSend != 0)
                let normalizedReplacementID = replacementID?.trimmingCharacters(in: .whitespacesAndNewlines)
                let nextID = normalizedReplacementID?.isEmpty == false ? normalizedReplacementID! : UUID().uuidString
                let updateID = wasPossiblyAccepted ? nextID : id
                try db.execute(
                    sql: """
                    UPDATE outbox_commands
                    SET client_uuid = ?, status = 'queued',
                        attempt_version = ?,
                        branch_epoch = ?, parked_was_accepted = 0, had_unacknowledged_send = 0,
                        retry_count = 0, last_error = '', created_at = ?,
                        agent_id = ?, delivery_session_key = ?, routing_contract = ?
                    WHERE gateway_id = ? AND client_uuid = ? AND status = 'failed'
                      AND attempt_version = ? AND retry_count = ? AND last_error = ?
                    """,
                    arguments: [
                        updateID,
                        wasPossiblyAccepted ? 1 : expectation.attemptVersion + 1,
                        branchState.epoch,
                        Date().timeIntervalSince1970,
                        normalizedAgentID,
                        normalizedDeliverySessionKey,
                        normalizedRoutingContract,
                        gatewayID,
                        id,
                        expectation.attemptVersion,
                        expectation.retryCount,
                        expectation.lastError ?? "",
                    ])
                return db.changesCount > 0 ? .updated : .superseded
            }
        } catch {
            return .unavailable
        }
    }

    public func cancelCommand(id: String) async -> OpenClawChatOutboxUpdateResult {
        guard !self.isRetired else { return .unavailable }
        let messageKey = "\(id):user"
        let gatewayID = self.gatewayID
        let proofHub = self.canonicalMessageProofHub
        do {
            let (deleted, isProven) = try await databases.stateQueue.writeWithoutTransaction { db in
                let isProven = proofHub.lockProofDecision(for: messageKey)
                defer { proofHub.unlockProofDecision() }
                var deleted = false
                try db.inTransaction(.immediate) {
                    try db.execute(
                        sql: """
                        DELETE FROM outbox_commands
                        WHERE gateway_id = ? AND client_uuid = ? AND status IN ('queued', 'failed')
                        """,
                        arguments: [gatewayID, id])
                    deleted = db.changesCount > 0
                    return .commit
                }
                return (deleted, isProven)
            }
            guard deleted else { return isProven ? .confirmed : .missing }
            if isProven {
                self.outboxChangeHub.yield(.confirmed(gatewayID: gatewayID, id: id))
                return .confirmed
            }
            self.outboxChangeHub.yield(.canceled(gatewayID: gatewayID, id: id))
            return .updated
        } catch {
            return .unavailable
        }
    }

    public func confirmCommand(
        id: String,
        attemptVersion: Int) async -> OpenClawChatOutboxUpdateResult
    {
        guard !self.isRetired else { return .unavailable }
        let gatewayID = self.gatewayID
        do {
            let deleted = try await databases.stateQueue.write { db in
                try db.execute(
                    sql: """
                    DELETE FROM outbox_commands
                    WHERE gateway_id = ? AND client_uuid = ? AND attempt_version = ?
                    """,
                    arguments: [gatewayID, id, attemptVersion])
                return db.changesCount > 0
            }
            guard deleted else { return .missing }
            self.outboxChangeHub.yield(.confirmed(gatewayID: gatewayID, id: id))
            return .updated
        } catch {
            return .unavailable
        }
    }

    public func branchState(
        for scope: OpenClawChatOutboxScope) async -> OpenClawChatOutboxBranchState?
    {
        guard !self.isRetired else { return nil }
        let gatewayID = self.gatewayID
        do {
            return try await self.databases.stateQueue.write { db in
                try Self.ensureBranchScope(db, gatewayID: gatewayID, scope: scope)
                var state = try Self.readBranchState(db, gatewayID: gatewayID, scope: scope)
                state = try OpenClawChatOutboxBranchState(
                    epoch: state.epoch,
                    lastActiveLeafEntryID: state.lastActiveLeafEntryID,
                    hadPendingCommands: Self.unconfirmedCommandCount(
                        db, gatewayID: gatewayID, scope: scope, includingFailed: true) > 0,
                    switchPendingSince: state.switchPendingSince,
                    needsReconciliation: state.needsReconciliation,
                    revision: state.revision)
                return state
            }
        } catch { return nil }
    }

    public func beginBranchSwitch(_ scope: OpenClawChatOutboxScope) async -> Bool {
        guard !self.isRetired else { return false }
        let gatewayID = self.gatewayID
        do {
            let result = try await databases.stateQueue.write { db -> Int in
                try Self.ensureBranchScope(db, gatewayID: gatewayID, scope: scope)
                let expired = try Self.expireBranchSwitchLeases(db, gatewayID: gatewayID, scope: scope)
                guard expired.isEmpty else { return 1 }
                let state = try Self.readBranchState(db, gatewayID: gatewayID, scope: scope)
                guard !state.needsReconciliation,
                      state.switchPendingSince == nil,
                      try Self.unconfirmedCommandCount(db, gatewayID: gatewayID, scope: scope) == 0
                else { return 0 }
                try db.execute(
                    sql: """
                    UPDATE outbox_branch_scopes
                    SET switch_pending_since = ?, branch_state_revision = branch_state_revision + 1
                    WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
                      AND switch_pending_since IS NULL
                    """,
                    arguments: [
                        Date().timeIntervalSince1970,
                        gatewayID,
                        scope.sessionKey,
                        Self.normalizedAgentID(scope.agentID),
                    ])
                return db.changesCount > 0 ? 2 : 0
            }
            if result == 1 {
                self.outboxChangeHub.yield(.invalidated(gatewayID: gatewayID, scope: scope))
            }
            return result == 2
        } catch { return false }
    }

    public func cancelBranchSwitch(_ scope: OpenClawChatOutboxScope) async -> Bool {
        guard !self.isRetired else { return false }
        let gatewayID = self.gatewayID
        do {
            let changed = try await databases.stateQueue.write { db -> Bool in
                try Self.ensureBranchScope(db, gatewayID: gatewayID, scope: scope)
                try db.execute(
                    sql: """
                    UPDATE outbox_branch_scopes
                    SET switch_pending_since = NULL, branch_state_revision = branch_state_revision + 1
                    WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
                    """,
                    arguments: [gatewayID, scope.sessionKey, Self.normalizedAgentID(scope.agentID)])
                return db.changesCount > 0
            }
            if changed {
                self.outboxChangeHub.yield(.invalidated(gatewayID: gatewayID, scope: scope))
            }
            return true
        } catch { return false }
    }

    public func demoteBranchSwitchToReconcile(_ scope: OpenClawChatOutboxScope) async -> Bool {
        guard !self.isRetired else { return false }
        let gatewayID = self.gatewayID
        do {
            let changed = try await databases.stateQueue.write { db -> Bool in
                try Self.ensureBranchScope(db, gatewayID: gatewayID, scope: scope)
                try db.execute(
                    sql: """
                    UPDATE outbox_branch_scopes
                    SET switch_pending_since = NULL, needs_reconciliation = 1,
                        branch_state_revision = branch_state_revision + 1
                    WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
                    """,
                    arguments: [gatewayID, scope.sessionKey, Self.normalizedAgentID(scope.agentID)])
                return db.changesCount > 0
            }
            if changed {
                self.outboxChangeHub.yield(.invalidated(gatewayID: gatewayID, scope: scope))
            }
            return true
        } catch { return false }
    }

    public func updateLastActiveLeafEntryID(
        _ leafEntryID: String,
        expectedEpoch: Int,
        for scope: OpenClawChatOutboxScope) async -> Bool
    {
        let leaf = leafEntryID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !self.isRetired, !leaf.isEmpty else { return false }
        let gatewayID = self.gatewayID
        do {
            return try await self.databases.stateQueue.write { db in
                try Self.ensureBranchScope(db, gatewayID: gatewayID, scope: scope)
                try db.execute(
                    sql: """
                    UPDATE outbox_branch_scopes
                    SET last_active_leaf_id = ?, branch_state_revision = branch_state_revision + 1
                    WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
                      AND branch_epoch = ? AND switch_pending_since IS NULL
                      AND needs_reconciliation = 0
                      AND NOT EXISTS (
                          SELECT 1 FROM outbox_commands
                          WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
                            AND status IN ('queued', 'sending', 'awaiting_confirmation')
                      )
                    """,
                    arguments: [
                        leaf,
                        gatewayID,
                        scope.sessionKey,
                        Self.normalizedAgentID(scope.agentID),
                        expectedEpoch,
                        gatewayID,
                        scope.sessionKey,
                        Self.normalizedAgentID(scope.agentID),
                    ])
                return db.changesCount > 0
            }
        } catch { return false }
    }

    public func reconcileBranchScope(
        _ scope: OpenClawChatOutboxScope,
        previousState: OpenClawChatOutboxBranchState,
        activeLeafEntryID: String?,
        branchLeafEntryIDs: Set<String>,
        activeTranscriptEntryIDs: Set<String> = [],
        lastError: String) async -> [OpenClawChatOutboxCommand]?
    {
        let leaf = activeLeafEntryID?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !self.isRetired, activeLeafEntryID == nil || leaf?.isEmpty == false else { return nil }
        let gatewayID = self.gatewayID
        do {
            let result = try await databases.stateQueue.write { db -> ([OpenClawChatOutboxCommand], Bool) in
                try Self.ensureBranchScope(db, gatewayID: gatewayID, scope: scope)
                _ = try Self.expireBranchSwitchLeases(db, gatewayID: gatewayID, scope: scope)
                let state = try Self.readBranchState(db, gatewayID: gatewayID, scope: scope)
                guard state.revision == previousState.revision, state.switchPendingSince == nil else {
                    throw DatabaseError(message: "stale branch reconciliation")
                }
                let pending = try Self.unconfirmedCommandCount(
                    db, gatewayID: gatewayID, scope: scope, includingFailed: true)
                var invalidated = false
                // A cross-client switch can win after this reconciliation but before send reaches the gateway.
                // Sends, like the web client, carry no branch precondition and land on the active branch at arrival.
                // Close this only with a protocol-level expectedActiveLeaf precondition.
                if let leaf,
                   let lastLeaf = previousState.lastActiveLeafEntryID,
                   lastLeaf != leaf,
                   branchLeafEntryIDs.contains(lastLeaf)
                {
                    try Self.installConfirmedBranchChange(
                        db,
                        gatewayID: gatewayID,
                        scope: scope,
                        previousEpoch: state.epoch,
                        activeLeafEntryID: leaf,
                        lastError: lastError)
                    invalidated = true
                } else {
                    let advancedOnActivePath = previousState.lastActiveLeafEntryID.map {
                        activeTranscriptEntryIDs.contains($0)
                    } ?? false
                    if previousState.lastActiveLeafEntryID != leaf,
                       !advancedOnActivePath,
                       pending > 0 || leaf == nil
                    {
                        try Self.parkPendingCommands(db, gatewayID: gatewayID, scope: scope, lastError: lastError)
                        invalidated = true
                    }
                    try Self.writeBranchState(
                        db,
                        gatewayID: gatewayID,
                        scope: scope,
                        epoch: state.epoch,
                        lastActiveLeafEntryID: leaf,
                        expectedRevision: previousState.revision)
                }
                return try (Self.readCommands(db, gatewayID: gatewayID), invalidated)
            }
            if result.1 {
                self.outboxChangeHub.yield(.invalidated(gatewayID: gatewayID, scope: scope))
            }
            return result.0
        } catch { return nil }
    }

    public func confirmBranchChange(
        _ scope: OpenClawChatOutboxScope,
        activeLeafEntryID: String,
        lastError: String) async -> [OpenClawChatOutboxCommand]?
    {
        let leaf = activeLeafEntryID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !self.isRetired, !leaf.isEmpty else { return nil }
        let gatewayID = self.gatewayID
        do {
            let result = try await databases.stateQueue.write { db -> ([OpenClawChatOutboxCommand], Bool) in
                try Self.ensureBranchScope(db, gatewayID: gatewayID, scope: scope)
                let state = try Self.readBranchState(db, gatewayID: gatewayID, scope: scope)
                let invalidated: Bool
                if state.lastActiveLeafEntryID == leaf {
                    try Self.writeBranchState(
                        db,
                        gatewayID: gatewayID,
                        scope: scope,
                        epoch: state.epoch,
                        lastActiveLeafEntryID: leaf)
                    invalidated = state.switchPendingSince != nil
                } else {
                    try Self.installConfirmedBranchChange(
                        db,
                        gatewayID: gatewayID,
                        scope: scope,
                        previousEpoch: state.epoch,
                        activeLeafEntryID: leaf,
                        lastError: lastError)
                    invalidated = true
                }
                return try (Self.readCommands(db, gatewayID: gatewayID), invalidated)
            }
            if result.1 {
                self.outboxChangeHub.yield(.invalidated(gatewayID: gatewayID, scope: scope))
            }
            return result.0
        } catch { return nil }
    }
}

extension OpenClawChatSQLiteTranscriptCache {
    private func transitionClaimedCommand(
        id: String,
        attemptVersion: Int,
        status: OpenClawChatOutboxCommand.Status,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    {
        guard !self.isRetired else {
            self.hasRecoveredInterruptedSends = false
            return .unavailable
        }
        let gatewayID = self.gatewayID
        do {
            let updated = try await databases.stateQueue.write { db in
                try db.execute(
                    sql: """
                    UPDATE outbox_commands
                    SET status = ?, had_unacknowledged_send = 1,
                        attempt_version = CASE WHEN ? = 'queued' THEN attempt_version + 1 ELSE attempt_version END,
                        retry_count = ?, last_error = ?
                    WHERE gateway_id = ? AND client_uuid = ? AND attempt_version = ?
                      AND status = 'sending'
                    """,
                    arguments: [
                        status.rawValue,
                        status.rawValue,
                        retryCount,
                        lastError ?? "",
                        gatewayID,
                        id,
                        attemptVersion,
                    ])
                return db.changesCount > 0
            }
            return updated ? .updated : .missing
        } catch {
            self.hasRecoveredInterruptedSends = false
            return .unavailable
        }
    }

    private nonisolated static func applyOutboxStaleness(
        _ db: Database,
        gatewayID: String) throws
    {
        try db.execute(
            sql: """
            UPDATE outbox_commands
            SET status = 'failed',
                last_error = CASE
                    WHEN status = 'awaiting_confirmation' THEN ? ELSE ?
                END
            WHERE gateway_id = ?
              AND status IN ('queued', 'awaiting_confirmation')
              AND created_at < ?
            """,
            arguments: [
                self.outboxUnconfirmedError,
                self.outboxExpiredError,
                gatewayID,
                Date().timeIntervalSince1970 - self.outboxCommandMaxAge,
            ])
    }

    private nonisolated static func readCommands(
        _ db: Database,
        gatewayID: String) throws -> [OpenClawChatOutboxCommand]
    {
        let rows = try Row.fetchAll(
            db,
            sql: """
            SELECT c.*, s.branch_epoch AS scope_branch_epoch
            FROM outbox_commands c
            LEFT JOIN outbox_branch_scopes s
              ON s.gateway_id = c.gateway_id AND s.session_key = c.session_key
                AND s.agent_id = c.agent_id
            WHERE c.gateway_id = ?
            ORDER BY c.created_at, c.enqueue_sequence
            """,
            arguments: [gatewayID])
        return try rows.map { try self.command(from: $0, in: db, gatewayID: gatewayID) }
    }

    private nonisolated static func command(
        from row: Row,
        in db: Database,
        gatewayID: String) throws -> OpenClawChatOutboxCommand
    {
        let id: String = row["client_uuid"]
        let attachmentRows = try Row.fetchAll(
            db,
            sql: """
            SELECT type, mime_type, file_name, payload, duration_seconds
            FROM outbox_attachments
            WHERE gateway_id = ? AND command_id = ? ORDER BY position
            """,
            arguments: [gatewayID, id])
        let attachments = attachmentRows.map { attachmentRow in
            OpenClawChatOutboxAttachment(
                type: attachmentRow["type"],
                mimeType: attachmentRow["mime_type"],
                fileName: attachmentRow["file_name"],
                data: attachmentRow["payload"],
                durationSeconds: attachmentRow["duration_seconds"])
        }
        let statusRaw: String = row["status"]
        guard let status = OpenClawChatOutboxCommand.Status(rawValue: statusRaw) else {
            throw DatabaseError(message: "unknown outbox status")
        }
        let lastError: String = row["last_error"]
        return OpenClawChatOutboxCommand(
            id: id,
            sessionKey: row["session_key"],
            deliverySessionKey: row["delivery_session_key"],
            routingContract: row["routing_contract"],
            agentID: Self.optionalAgentID(row["agent_id"]),
            branchEpoch: row["branch_epoch"],
            scopeBranchEpoch: row["scope_branch_epoch"],
            text: row["text"],
            attachments: attachments,
            thinking: row["thinking"],
            createdAt: row["created_at"],
            status: status,
            attemptVersion: row["attempt_version"],
            retryCount: row["retry_count"],
            lastError: lastError.isEmpty ? nil : lastError)
    }

    private nonisolated static func normalizedAgentID(_ agentID: String?) -> String {
        agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    private nonisolated static func optionalAgentID(_ agentID: String) -> String? {
        let normalized = self.normalizedAgentID(agentID)
        return normalized.isEmpty ? nil : normalized
    }

    private nonisolated static func ensureBranchScope(
        _ db: Database,
        gatewayID: String,
        scope: OpenClawChatOutboxScope) throws
    {
        try db.execute(
            sql: """
            INSERT OR IGNORE INTO outbox_branch_scopes(
                gateway_id, session_key, agent_id, branch_epoch, last_active_leaf_id, needs_reconciliation
            ) VALUES (?, ?, ?, 0, NULL, 0)
            """,
            arguments: [gatewayID, scope.sessionKey, self.normalizedAgentID(scope.agentID)])
    }

    private nonisolated static func readBranchState(
        _ db: Database,
        gatewayID: String,
        scope: OpenClawChatOutboxScope) throws -> OpenClawChatOutboxBranchState
    {
        guard let row = try Row.fetchOne(
            db,
            sql: """
            SELECT branch_epoch, last_active_leaf_id, switch_pending_since, needs_reconciliation, branch_state_revision
            FROM outbox_branch_scopes
            WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
            """,
            arguments: [gatewayID, scope.sessionKey, normalizedAgentID(scope.agentID)])
        else { throw DatabaseError(message: "missing branch scope") }
        return OpenClawChatOutboxBranchState(
            epoch: row["branch_epoch"],
            lastActiveLeafEntryID: row["last_active_leaf_id"],
            switchPendingSince: row["switch_pending_since"],
            needsReconciliation: row["needs_reconciliation"],
            revision: row["branch_state_revision"])
    }

    /// `includingFailed` widens the count for branch-reconcile decisions: failed rows
    /// still hold a retryable idempotency identity, so a branch change must observe and
    /// park them. The mutation lease gate stays narrow — a visible failed message must
    /// not block rewind/fork/switch.
    private nonisolated static func unconfirmedCommandCount(
        _ db: Database,
        gatewayID: String,
        scope: OpenClawChatOutboxScope,
        includingFailed: Bool = false) throws -> Int
    {
        let statuses = includingFailed
            ? "'queued', 'sending', 'awaiting_confirmation', 'failed'"
            : "'queued', 'sending', 'awaiting_confirmation'"
        return try Int.fetchOne(
            db,
            sql: """
            SELECT COUNT(*) FROM outbox_commands
            WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
              AND status IN (\(statuses))
            """,
            arguments: [gatewayID, scope.sessionKey, self.normalizedAgentID(scope.agentID)]) ?? 0
    }

    private nonisolated static func expireBranchSwitchLeases(
        _ db: Database,
        gatewayID: String,
        scope: OpenClawChatOutboxScope? = nil) throws -> [OpenClawChatOutboxScope]
    {
        let cutoff = Date().timeIntervalSince1970 - 5 * 60
        // if/else keeps these SQL literals out of the ternary shape the native
        // i18n extractor treats as user-facing conditional text.
        let sql: String
        let arguments: StatementArguments
        if let scope {
            sql = """
            SELECT session_key, agent_id FROM outbox_branch_scopes
            WHERE gateway_id = ? AND session_key = ? AND agent_id = ? AND switch_pending_since <= ?
            """
            arguments = [gatewayID, scope.sessionKey, Self.normalizedAgentID(scope.agentID), cutoff]
        } else {
            sql = """
            SELECT session_key, agent_id FROM outbox_branch_scopes
            WHERE gateway_id = ? AND switch_pending_since <= ?
            """
            arguments = [gatewayID, cutoff]
        }
        let rows = try Row.fetchAll(db, sql: sql, arguments: arguments)
        guard !rows.isEmpty else { return [] }
        for row in rows {
            let sessionKey: String = row["session_key"]
            let agentID: String = row["agent_id"]
            try db.execute(
                sql: """
                UPDATE outbox_branch_scopes
                SET switch_pending_since = NULL, needs_reconciliation = 1,
                    branch_state_revision = branch_state_revision + 1
                WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
                """,
                arguments: [gatewayID, sessionKey, agentID])
        }
        return rows.map { row in
            OpenClawChatOutboxScope(sessionKey: row["session_key"], agentID: row["agent_id"])
        }
    }

    private nonisolated static func writeBranchState(
        _ db: Database,
        gatewayID: String,
        scope: OpenClawChatOutboxScope,
        epoch: Int,
        lastActiveLeafEntryID: String?,
        expectedRevision: Int? = nil) throws
    {
        try db.execute(
            sql: """
            UPDATE outbox_branch_scopes
            SET branch_epoch = ?, last_active_leaf_id = ?, switch_pending_since = NULL,
                needs_reconciliation = 0, branch_state_revision = branch_state_revision + 1
            WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
              AND (? IS NULL OR branch_state_revision = ?)
            """,
            arguments: [
                epoch,
                lastActiveLeafEntryID,
                gatewayID,
                scope.sessionKey,
                self.normalizedAgentID(scope.agentID),
                expectedRevision,
                expectedRevision,
            ])
        guard db.changesCount > 0 else { throw DatabaseError(message: "stale branch state") }
    }

    private nonisolated static func installConfirmedBranchChange(
        _ db: Database,
        gatewayID: String,
        scope: OpenClawChatOutboxScope,
        previousEpoch: Int,
        activeLeafEntryID: String,
        lastError: String) throws
    {
        let nextEpoch = previousEpoch + 1
        try Self.writeBranchState(
            db,
            gatewayID: gatewayID,
            scope: scope,
            epoch: nextEpoch,
            lastActiveLeafEntryID: activeLeafEntryID)
        try db.execute(
            sql: """
            UPDATE outbox_commands
            SET parked_was_accepted = CASE
                    WHEN status IN ('sending', 'awaiting_confirmation') OR had_unacknowledged_send = 1
                    THEN 1 ELSE parked_was_accepted END,
                status = 'failed', last_error = ?
            WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
              AND branch_epoch <> ?
              AND status IN ('queued', 'sending', 'awaiting_confirmation', 'failed')
            """,
            arguments: [
                lastError + "\n# branch-park:" + UUID().uuidString,
                gatewayID,
                scope.sessionKey,
                Self.normalizedAgentID(scope.agentID),
                nextEpoch,
            ])
    }

    private nonisolated static func parkPendingCommands(
        _ db: Database,
        gatewayID: String,
        scope: OpenClawChatOutboxScope,
        lastError: String) throws
    {
        try db.execute(
            sql: """
            UPDATE outbox_commands
            SET parked_was_accepted = CASE
                    WHEN status IN ('sending', 'awaiting_confirmation') OR had_unacknowledged_send = 1
                    THEN 1 ELSE parked_was_accepted END,
                status = 'failed', last_error = ?
            WHERE gateway_id = ? AND session_key = ? AND agent_id = ?
              AND status IN ('queued', 'sending', 'awaiting_confirmation', 'failed')
            """,
            arguments: [
                lastError + "\n# branch-park:" + UUID().uuidString,
                gatewayID,
                scope.sessionKey,
                self.normalizedAgentID(scope.agentID),
            ])
    }
}

extension OpenClawChatSQLiteTranscriptCache {
    // MARK: - Portable cache record shaping

    /// Cache format v1 stores one JSON document per session/message row. Large
    /// attachment bodies and ordinary tool arguments are never cache data.
    static func cacheableMessages(_ messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        messages.suffix(self.maxCachedMessagesPerSession).map { message in
            OpenClawChatMessage(
                id: message.id,
                role: message.role,
                content: message.content.map { item in
                    OpenClawChatMessageContent(
                        type: item.type,
                        text: item.text,
                        thinking: item.thinking,
                        thinkingSignature: nil,
                        mimeType: item.mimeType,
                        fileName: item.fileName,
                        durationSeconds: item.durationSeconds,
                        content: nil,
                        id: item.id,
                        name: item.name,
                        arguments: self.cacheablePatchArguments(item),
                        details: self.cacheableDetails(item.details),
                        isError: item.isError)
                },
                timestamp: message.timestamp,
                idempotencyKey: message.idempotencyKey,
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                usage: message.usage,
                stopReason: message.stopReason,
                errorMessage: message.errorMessage,
                details: self.cacheableDetails(message.details),
                isError: message.isError)
        }
    }

    private static func cacheableDetails(_ details: AnyCodable?) -> AnyCodable? {
        guard let diff = details?.dictionaryValue?["diff"]?.stringValue else { return nil }
        let capped = self.cacheableText(diff)
        guard !capped.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return AnyCodable(["diff": AnyCodable(capped)])
    }

    private static func cacheablePatchArguments(_ item: OpenClawChatMessageContent) -> AnyCodable? {
        guard let type = item.type?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              ["toolcall", "tool_call", "tooluse", "tool_use"].contains(type),
              let name = item.name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              ["apply_patch", "applypatch", "patch"].contains(name),
              let arguments = item.arguments?.dictionaryValue
        else { return nil }

        for key in ["input", "patch", "diff"] {
            guard let value = arguments[key]?.stringValue,
                  !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { continue }
            return AnyCodable([key: AnyCodable(self.cacheableText(value))])
        }
        return nil
    }

    private static func cacheableText(_ value: String) -> String {
        let limit = 64000
        let truncationMarker = "\n...(truncated)..."
        return if value.utf16.count > limit {
            self.utf16Prefix(value, limit: limit - truncationMarker.utf16.count) + truncationMarker
        } else {
            value
        }
    }

    private static func utf16Prefix(_ value: String, limit: Int) -> String {
        let units = value.utf16
        guard units.count > limit else { return value }
        var end = units.index(units.startIndex, offsetBy: limit)
        if String.Index(end, within: value) == nil {
            end = units.index(before: end)
        }
        guard let stringEnd = String.Index(end, within: value) else { return "" }
        return String(value[..<stringEnd])
    }

    static func boundedSessions(_ sessions: [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry] {
        guard sessions.count > self.maxCachedSessions else { return sessions }
        return Array(
            sessions
                .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
                .prefix(self.maxCachedSessions))
    }

    private static func attachmentByteCount(_ attachments: [OpenClawChatOutboxAttachment]) -> Int? {
        var total = 0
        for attachment in attachments {
            let (next, overflow) = total.addingReportingOverflow(attachment.data.count)
            guard !overflow else { return nil }
            total = next
        }
        return total
    }

    static func canEnqueueAttachmentBytes(commandBytes: Int, queuedBytes: Int) -> Bool {
        guard commandBytes >= 0,
              queuedBytes >= 0,
              commandBytes <= self.maxAttachmentBytesPerCommand
        else { return false }
        return queuedBytes <= self.maxQueuedAttachmentBytes - commandBytes
    }

    private static func encodeJSON(_ value: some Encodable) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(value)
        guard let result = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileWriteInapplicableStringEncoding)
        }
        return result
    }
}
