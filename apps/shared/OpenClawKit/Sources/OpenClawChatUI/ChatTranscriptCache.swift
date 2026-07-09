import Foundation
import OSLog
import SQLite3
#if os(iOS)
import UIKit
#endif

private let cacheLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatTranscriptCache")

private final class OutboxChangeHub: @unchecked Sendable {
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
/// actor hops would leave a window where an already-delivered row is scrubbed.
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

    /// Serializes the final cancellation decision and SQLite commit with
    /// synchronous canonical observation. Evidence recorded before this lock
    /// wins; evidence after it observes a completed cancellation.
    func lockProofDecision(for key: String) -> Bool {
        self.lock.lock()
        return self.keys.contains(key)
    }

    func unlockProofDecision() {
        self.lock.unlock()
    }
}

/// Read-only offline cache seam for chat sessions and transcripts.
///
/// The cache only pre-paints cold opens and covers offline browsing; connected
/// reads always come from the gateway and replace cached content wholesale.
/// Implementations must scope all rows to a single gateway identity so
/// transcripts never leak across paired gateways.
public protocol OpenClawChatTranscriptCache: Sendable {
    func loadSessions() async -> [OpenClawChatSessionEntry]
    func loadTranscript(sessionKey: String) async -> [OpenClawChatMessage]
    func loadTranscript(sessionKey: String, agentID: String?) async -> [OpenClawChatMessage]
    func storeSessions(_ sessions: [OpenClawChatSessionEntry]) async
    func storeTranscript(sessionKey: String, messages: [OpenClawChatMessage]) async
    func storeTranscript(sessionKey: String, agentID: String?, messages: [OpenClawChatMessage]) async
    /// Canonical gateway rows can prove that an ambiguously delivered local
    /// command landed after cancellation and must override local suppression.
    func storeCanonicalTranscript(
        sessionKey: String,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys: Set<String>) async
    func storeCanonicalTranscript(
        sessionKey: String,
        agentID: String?,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys: Set<String>) async
    /// Synchronous observation closes the session.message -> cancellation
    /// race before asynchronous SQLite confirmation starts.
    func observeCanonicalMessageIdempotencyKeys(_ keys: Set<String>)
}

extension OpenClawChatTranscriptCache {
    public func loadTranscript(sessionKey: String, agentID: String?) async -> [OpenClawChatMessage] {
        guard agentID == nil else { return [] }
        return await self.loadTranscript(sessionKey: sessionKey)
    }

    public func storeTranscript(
        sessionKey: String,
        agentID: String?,
        messages: [OpenClawChatMessage]) async
    {
        guard agentID == nil else { return }
        await self.storeTranscript(sessionKey: sessionKey, messages: messages)
    }

    public func storeCanonicalTranscript(
        sessionKey: String,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys _: Set<String>) async
    {
        await self.storeTranscript(sessionKey: sessionKey, messages: messages)
    }

    public func storeCanonicalTranscript(
        sessionKey: String,
        agentID: String?,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys: Set<String>) async
    {
        guard agentID == nil else { return }
        await self.storeCanonicalTranscript(
            sessionKey: sessionKey,
            messages: messages,
            canonicalMessageIdempotencyKeys: canonicalMessageIdempotencyKeys)
    }

    public func observeCanonicalMessageIdempotencyKeys(_: Set<String>) {}
}

/// Optional atomic merge seam for cache owners that also provide a durable
/// outbox. Keeping this separate preserves source compatibility for read-only
/// transcript-cache conformers.
public protocol OpenClawChatCanonicalTranscriptMerging: OpenClawChatTranscriptCache {
    func mergeCanonicalTranscriptMessage(
        sessionKey: String,
        agentID: String?,
        message: OpenClawChatMessage,
        canonicalMessageIdempotencyKey: String) async
}

/// One attachment captured with a durable chat command.
public struct OpenClawChatOutboxAttachment: Codable, Hashable, Sendable {
    public let type: String
    public let mimeType: String
    public let fileName: String
    public let data: Data
    public let durationSeconds: Double?

    public init(
        type: String,
        mimeType: String,
        fileName: String,
        data: Data,
        durationSeconds: Double? = nil)
    {
        self.type = type
        self.mimeType = mimeType
        self.fileName = fileName
        self.data = data
        self.durationSeconds = durationSeconds
    }
}

/// One durable queued chat command. `id` is the client UUID
/// that becomes the transport idempotency key on flush, so at-least-once
/// delivery stays safe across retries and app restarts.
///
/// Naming mirrors the watch-side `QueuedCommand` shape (WatchChatCoordinator)
/// so the two queues can merge into one owner later.
public struct OpenClawChatOutboxCommand: Hashable, Sendable, Identifiable {
    static let legacyUnboundRoutingContract = "legacy-unbound"

    public enum Status: String, Sendable {
        case queued
        case sending
        case awaitingConfirmation = "awaiting_confirmation"
        case failed
    }

    public let id: String
    /// Presentation/cache key captured when the user queued the command.
    public let sessionKey: String
    /// Canonical transport key captured at enqueue time. This must never be
    /// re-resolved from a mutable main/default alias during reconnect.
    public let deliverySessionKey: String
    /// Gateway main-routing contract (scope, main key, default agent) captured
    /// with the command. A changed contract must fail closed before replay.
    public let routingContract: String?
    /// Durable routing owner, required for the literal `global` session and
    /// retained for ownership checks on canonical agent-scoped keys.
    public let agentID: String?
    public let text: String
    /// Attachment bytes remain owned by SQLite until canonical history proves
    /// delivery or the user explicitly deletes the command.
    public let attachments: [OpenClawChatOutboxAttachment]
    /// Thinking level captured when the command was queued, so a later flush
    /// never borrows the setting of whichever session is visible then.
    public let thinking: String
    /// Seconds since 1970; flush order is strictly ascending `createdAt`.
    public let createdAt: Double
    public var status: Status
    public var retryCount: Int
    public var lastError: String?

    public init(
        id: String,
        sessionKey: String,
        deliverySessionKey: String? = nil,
        routingContract: String? = nil,
        agentID: String? = nil,
        text: String,
        attachments: [OpenClawChatOutboxAttachment] = [],
        thinking: String,
        createdAt: Double,
        status: Status,
        retryCount: Int,
        lastError: String?)
    {
        self.id = id
        self.sessionKey = sessionKey
        if let deliverySessionKey {
            self.deliverySessionKey = deliverySessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            self.deliverySessionKey = sessionKey
        }
        let normalizedRoutingContract = routingContract?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.routingContract = normalizedRoutingContract?.isEmpty == false ? normalizedRoutingContract : nil
        let normalizedAgentID = agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.agentID = normalizedAgentID?.isEmpty == false ? normalizedAgentID : nil
        self.text = text
        self.attachments = attachments
        self.thinking = thinking
        self.createdAt = createdAt
        self.status = status
        self.retryCount = retryCount
        self.lastError = lastError
    }
}

public enum OpenClawChatOutboxUpdateResult: Equatable, Sendable {
    case updated
    case confirmed
    case missing
    case unavailable
}

public enum OpenClawChatOutboxChange: Equatable, Sendable {
    case canceled(id: String)
    case confirmed(id: String)
}

/// Durable offline outbox for chat commands, scoped to one gateway identity
/// exactly like the transcript cache. Implementations persist queued sends so
/// they survive app restarts and flush on reconnect.
public protocol OpenClawChatCommandOutbox: Sendable {
    /// Returns false when the row or attachment-byte budget is full, or
    /// storage is unavailable; callers surface that instead of dropping text.
    func enqueueCommand(_ command: OpenClawChatOutboxCommand) async -> Bool
    /// Gateway-scoped rows in `createdAt` order. Applies the staleness gate:
    /// old queued or unconfirmed rows become failed so reconnect never sends
    /// stale or ambiguously delivered commands silently.
    func loadCommands() async -> [OpenClawChatOutboxCommand]
    /// Availability-aware read used by the FIFO restoration gate. Nil means
    /// storage was not readable, not that the queue was empty.
    func loadCommandsIfAvailable() async -> [OpenClawChatOutboxCommand]?
    /// Crash safety: rows stuck in 'sending' from a previous process become
    /// failed once per store lifetime. Delivery is ambiguous after a crash,
    /// so only explicit user retry may replay them; acknowledged rows stay
    /// awaiting canonical history confirmation.
    /// Returns false while storage is unavailable so callers can retry later.
    @discardableResult
    func recoverInterruptedSends() async -> Bool
    /// Atomically claims the oldest queued row when no other row is sending.
    /// Nil means another flusher owns the queue or no deliverable row remains.
    func claimNextCommand() async -> OpenClawChatOutboxCommand?
    func markCommandQueued(id: String, retryCount: Int, lastError: String?) async
    func markCommandAwaitingConfirmation(id: String) async -> OpenClawChatOutboxUpdateResult
    /// Result-bearing terminal transition for callers that must stop their
    /// FIFO when durable storage is unavailable.
    func markCommandFailedIfPresent(
        id: String,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    /// Result-bearing retry used to adopt an unowned legacy alias into the
    /// canonical target explicitly selected by the user.
    func markCommandRetriedIfPresent(
        id: String,
        agentID: String?,
        deliverySessionKey: String,
        routingContract: String) async -> OpenClawChatOutboxUpdateResult
    /// User cancellation succeeds only before a sender claims the row. The
    /// status predicate is the cross-view-model cancellation boundary.
    func cancelCommand(id: String) async -> OpenClawChatOutboxUpdateResult
    /// Canonical gateway history may complete any row, including a sending
    /// row whose request ACK was lost.
    func confirmCommand(id: String) async -> OpenClawChatOutboxUpdateResult
    /// Cross-view-model invalidation.
    func changes() -> AsyncStream<OpenClawChatOutboxChange>
}

public struct OpenClawChatSessionRoutingIdentity: Equatable, Sendable {
    public let scope: String
    public let mainSessionKey: String
    public let defaultAgentID: String
    public let contract: String

    public init?(contract: String?) {
        guard let components = OpenClawChatSessionRoutingContract.parse(contract) else { return nil }
        self.scope = components.scope
        self.mainSessionKey = components.mainKey
        self.defaultAgentID = components.defaultAgentID
        self.contract = "\(components.scope)|\(components.mainKey)|\(components.defaultAgentID)"
    }

    public init?(scope: String?, mainSessionKey: String?, defaultAgentID: String?) {
        guard let contract = OpenClawChatSessionRoutingContract.make(
            scope: scope,
            mainKey: mainSessionKey,
            defaultAgentID: defaultAgentID)
        else { return nil }
        self.init(contract: contract)
    }
}

/// SQLite-backed transcript cache for one gateway identity. Owners should use
/// one database file per gateway so reset can physically remove that gateway's
/// cached transcript bytes without disturbing other paired gateways; queries
/// are additionally scoped by `gatewayID` as a defensive belt.
///
/// Transcript rows are disposable, but the command outbox is persistent user
/// state. Schema upgrades migrate the shared database; unknown or corrupt
/// existing schemas fail closed without deleting queued commands.
public actor OpenClawChatSQLiteTranscriptCache: OpenClawChatTranscriptCache,
    OpenClawChatCanonicalTranscriptMerging,
    OpenClawChatCommandOutbox
{
    /// Bounds keep the cache small: enough for a recently-used session picker
    /// and a full first screen of transcript, not a durable archive.
    public static let maxCachedSessions = 50
    public static let maxCachedTranscripts = 50
    public static let maxCachedMessagesPerSession = 200
    /// Outbox bounds: refuse enqueue beyond these per-gateway budgets, and
    /// expire queued commands instead of sending them after two days offline.
    public static let maxQueuedCommands = 50
    public static let maxAttachmentBytesPerCommand = 40_000_000
    public static let maxQueuedAttachmentBytes = 50_000_000
    public static let outboxCommandMaxAge: TimeInterval = 48 * 60 * 60
    /// Machine-readable `lastError` set by the staleness gate.
    public static let outboxExpiredError = "expired"
    public static let outboxUnconfirmedError = "delivery_unconfirmed"
    public static let outboxUnknownTargetError = "delivery_target_unknown"
    public static let outboxChangedTargetError = "delivery_target_changed"
    // v2 adds the durable outbox; v3 adds delivery ownership; v4 binds
    // replay to the main-routing contract; v5 persists that verified identity;
    // v6 keeps bounded attachment bytes inside the same durable command owner.
    static let schemaVersion: Int32 = 6
    private static let createOutboxTableSQL = """
    CREATE TABLE IF NOT EXISTS outbox_commands(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_uuid TEXT NOT NULL UNIQUE,
        gateway_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        delivery_session_key TEXT NOT NULL DEFAULT '',
        routing_contract TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        attachment_bytes INTEGER NOT NULL DEFAULT 0,
        thinking TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT ''
    )
    """
    private static let createTranscriptTableSQL = """
    CREATE TABLE IF NOT EXISTS cached_transcripts(
        gateway_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY(gateway_id, session_key, agent_id)
    )
    """
    private static let createRoutingIdentityTableSQL = """
    CREATE TABLE IF NOT EXISTS gateway_routing_identity(
        gateway_id TEXT NOT NULL PRIMARY KEY,
        scope TEXT NOT NULL,
        main_session_key TEXT NOT NULL,
        default_agent_id TEXT NOT NULL,
        updated_at REAL NOT NULL
    )
    """

    /// Owns the raw sqlite handle so it closes on release without needing an
    /// isolated actor deinit (OpaquePointer is not Sendable).
    private final class Connection: @unchecked Sendable {
        let raw: OpaquePointer

        init(raw: OpaquePointer) {
            self.raw = raw
        }

        deinit {
            sqlite3_close_v2(self.raw)
        }
    }

    private let databaseURL: URL
    public nonisolated let gatewayID: String
    private var db: Connection?
    private var isRetired = false
    private var hasRecoveredInterruptedSends = false
    /// Process-lifetime tombstones reject stale transcript snapshots from an
    /// overlapping view model after its queued bubble was canceled durably.
    private var canceledMessageKeysBySession: [String: [String]] = [:]
    private nonisolated let outboxChangeHub = OutboxChangeHub()
    private nonisolated let canonicalMessageProofHub = CanonicalMessageProofHub()
    /// Existing database failures preserve persistent outbox bytes and make
    /// this store a no-op; an explicit owner purge remains the recovery path.
    private var isBroken = false

    public init(databaseURL: URL, gatewayID: String) {
        self.databaseURL = databaseURL
        self.gatewayID = gatewayID
    }

    /// Startup-only synchronous read for UI owners that must seed routing
    /// before constructing a view model. Runtime writes stay actor-isolated.
    public nonisolated static func loadSessionRoutingIdentity(
        databaseURL: URL,
        gatewayID: String) -> OpenClawChatSessionRoutingIdentity?
    {
        var db: OpaquePointer?
        guard sqlite3_open_v2(databaseURL.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let db
        else {
            sqlite3_close_v2(db)
            return nil
        }
        defer { sqlite3_close_v2(db) }
        var statement: OpaquePointer?
        let sql = """
        SELECT scope, main_session_key, default_agent_id
        FROM gateway_routing_identity WHERE gateway_id = ?1
        """
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard sqlite3_bind_text(statement, 1, gatewayID, -1, transient) == SQLITE_OK,
              sqlite3_step(statement) == SQLITE_ROW,
              let scope = sqlite3_column_text(statement, 0),
              let mainSessionKey = sqlite3_column_text(statement, 1),
              let defaultAgentID = sqlite3_column_text(statement, 2)
        else { return nil }
        return OpenClawChatSessionRoutingIdentity(
            scope: String(cString: scope),
            mainSessionKey: String(cString: mainSessionKey),
            defaultAgentID: String(cString: defaultAgentID))
    }

    /// Startup-only cleanup, before any cache actor can own an open handle.
    public static func removeDatabaseFiles(at databaseURL: URL) {
        let fm = FileManager.default
        try? fm.removeItem(at: databaseURL)
        for suffix in ["-wal", "-shm", "-journal"] {
            try? fm.removeItem(at: URL(fileURLWithPath: databaseURL.path + suffix))
        }
    }

    // MARK: - OpenClawChatTranscriptCache

    public func loadSessions() async -> [OpenClawChatSessionEntry] {
        guard !self.isRetired else { return [] }
        guard let db = await handle() else { return [] }
        guard let payload = selectPayload(
            db,
            sql: "SELECT payload FROM cached_sessions WHERE gateway_id = ?1",
            bindings: [gatewayID])
        else {
            return []
        }
        guard let decoded = try? JSONDecoder().decode(
            [OpenClawChatSessionEntry].self,
            from: Data(payload.utf8))
        else {
            // Decode mismatch means a stale/foreign shape: drop the row silently.
            self.execute(db, sql: "DELETE FROM cached_sessions WHERE gateway_id = ?1", bindings: [self.gatewayID])
            return []
        }
        return decoded
    }

    public func loadTranscript(sessionKey: String) async -> [OpenClawChatMessage] {
        await self.loadTranscript(sessionKey: sessionKey, agentID: nil)
    }

    public func loadTranscript(sessionKey: String, agentID: String?) async -> [OpenClawChatMessage] {
        guard !self.isRetired else { return [] }
        guard let db = await handle() else { return [] }
        return self.readTranscript(db, sessionKey: sessionKey, agentID: agentID)
    }

    private func readTranscript(
        _ db: OpaquePointer,
        sessionKey: String,
        agentID: String?) -> [OpenClawChatMessage]
    {
        let normalizedAgentID = Self.normalizedAgentID(agentID)
        guard let payload = selectPayload(
            db,
            sql: """
            SELECT payload FROM cached_transcripts
            WHERE gateway_id = ?1 AND session_key = ?2 AND agent_id = ?3
            """,
            bindings: [gatewayID, sessionKey, normalizedAgentID])
        else {
            return []
        }
        guard let decoded = try? JSONDecoder().decode(
            [OpenClawChatMessage].self,
            from: Data(payload.utf8))
        else {
            self.execute(
                db,
                sql: """
                DELETE FROM cached_transcripts
                WHERE gateway_id = ?1 AND session_key = ?2 AND agent_id = ?3
                """,
                bindings: [self.gatewayID, sessionKey, normalizedAgentID])
            return []
        }
        return decoded
    }

    public func storeSessions(_ sessions: [OpenClawChatSessionEntry]) async {
        guard !self.isRetired else { return }
        guard let db = await handle() else { return }
        let bounded = Self.boundedSessions(sessions)
        guard !bounded.isEmpty else {
            self.execute(db, sql: "DELETE FROM cached_sessions WHERE gateway_id = ?1", bindings: [self.gatewayID])
            return
        }
        guard let payload = Self.encodeJSON(bounded) else { return }
        self.execute(
            db,
            sql: """
            INSERT OR REPLACE INTO cached_sessions(gateway_id, payload, updated_at)
            VALUES (?1, ?2, ?3)
            """,
            bindings: [self.gatewayID, payload, Date().timeIntervalSince1970])
    }

    public func loadSessionRoutingIdentity() async -> OpenClawChatSessionRoutingIdentity? {
        guard !self.isRetired, let db = await handle() else { return nil }
        var statement: OpaquePointer?
        let sql = """
        SELECT scope, main_session_key, default_agent_id
        FROM gateway_routing_identity WHERE gateway_id = ?1
        """
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: [self.gatewayID]),
              sqlite3_step(statement) == SQLITE_ROW,
              let scope = sqlite3_column_text(statement, 0),
              let mainSessionKey = sqlite3_column_text(statement, 1),
              let defaultAgentID = sqlite3_column_text(statement, 2)
        else { return nil }
        return OpenClawChatSessionRoutingIdentity(
            scope: String(cString: scope),
            mainSessionKey: String(cString: mainSessionKey),
            defaultAgentID: String(cString: defaultAgentID))
    }

    public func storeSessionRoutingIdentity(_ identity: OpenClawChatSessionRoutingIdentity) async {
        guard !self.isRetired, let db = await handle() else { return }
        self.execute(
            db,
            sql: """
            INSERT OR REPLACE INTO gateway_routing_identity(
                gateway_id, scope, main_session_key, default_agent_id, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)
            """,
            bindings: [
                self.gatewayID,
                identity.scope,
                identity.mainSessionKey,
                identity.defaultAgentID,
                Date().timeIntervalSince1970,
            ])
    }

    public func storeTranscript(sessionKey: String, messages: [OpenClawChatMessage]) async {
        await self.storeTranscript(sessionKey: sessionKey, agentID: nil, messages: messages)
    }

    public func storeTranscript(
        sessionKey: String,
        agentID: String?,
        messages: [OpenClawChatMessage]) async
    {
        await self.writeTranscript(sessionKey: sessionKey, agentID: agentID, messages: messages)
    }

    public func storeCanonicalTranscript(
        sessionKey: String,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys: Set<String>) async
    {
        await self.storeCanonicalTranscript(
            sessionKey: sessionKey,
            agentID: nil,
            messages: messages,
            canonicalMessageIdempotencyKeys: canonicalMessageIdempotencyKeys)
    }

    public func storeCanonicalTranscript(
        sessionKey: String,
        agentID: String?,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys: Set<String>) async
    {
        self.observeCanonicalMessageIdempotencyKeys(canonicalMessageIdempotencyKeys)
        if !canonicalMessageIdempotencyKeys.isEmpty,
           var canceledKeys = canceledMessageKeysBySession[sessionKey]
        {
            canceledKeys.removeAll(where: canonicalMessageIdempotencyKeys.contains)
            self.canceledMessageKeysBySession[sessionKey] = canceledKeys.isEmpty ? nil : canceledKeys
        }
        await self.writeTranscript(sessionKey: sessionKey, agentID: agentID, messages: messages)
    }

    public func mergeCanonicalTranscriptMessage(
        sessionKey: String,
        agentID: String?,
        message: OpenClawChatMessage,
        canonicalMessageIdempotencyKey: String) async
    {
        self.observeCanonicalMessageIdempotencyKeys([canonicalMessageIdempotencyKey])
        guard !self.isRetired, let db = await handle() else { return }

        if var canceledKeys = canceledMessageKeysBySession[sessionKey] {
            canceledKeys.removeAll(where: { $0 == canonicalMessageIdempotencyKey })
            self.canceledMessageKeysBySession[sessionKey] = canceledKeys.isEmpty ? nil : canceledKeys
        }

        // Keep the read, merge, and write in one actor turn. macOS shares this
        // cache across windows, so a caller-side read/modify/write can erase a
        // newer snapshot written by another view model.
        var cached = self.readTranscript(db, sessionKey: sessionKey, agentID: agentID)
        if let index = cached.firstIndex(where: {
            $0.idempotencyKey?.trimmingCharacters(in: .whitespacesAndNewlines) ==
                canonicalMessageIdempotencyKey
        }) {
            cached[index] = message
        } else if let timestamp = message.timestamp,
                  let index = cached.firstIndex(where: { ($0.timestamp ?? .greatestFiniteMagnitude) > timestamp })
        {
            cached.insert(message, at: index)
        } else {
            cached.append(message)
        }
        self.writeTranscript(db, sessionKey: sessionKey, agentID: agentID, messages: cached)
    }

    public nonisolated func observeCanonicalMessageIdempotencyKeys(_ keys: Set<String>) {
        self.canonicalMessageProofHub.observe(keys)
    }

    private func writeTranscript(
        sessionKey: String,
        agentID: String?,
        messages: [OpenClawChatMessage]) async
    {
        guard !self.isRetired else { return }
        guard let db = await handle() else { return }
        self.writeTranscript(db, sessionKey: sessionKey, agentID: agentID, messages: messages)
    }

    private func writeTranscript(
        _ db: OpaquePointer,
        sessionKey: String,
        agentID: String?,
        messages: [OpenClawChatMessage])
    {
        let normalizedAgentID = Self.normalizedAgentID(agentID)
        let canceledKeys = self.canceledMessageKeysBySession[sessionKey] ?? []
        let bounded = Self.cacheableMessages(messages).filter { message in
            guard let key = message.idempotencyKey else { return true }
            return !canceledKeys.contains(key)
        }
        guard !bounded.isEmpty else {
            // An emptied live transcript must also empty the cache, or the next
            // cold open would ghost-paint messages the gateway no longer has.
            self.execute(
                db,
                sql: """
                DELETE FROM cached_transcripts
                WHERE gateway_id = ?1 AND session_key = ?2 AND agent_id = ?3
                """,
                bindings: [self.gatewayID, sessionKey, normalizedAgentID])
            return
        }
        guard let payload = Self.encodeJSON(bounded) else { return }
        self.execute(
            db,
            sql: """
            INSERT OR REPLACE INTO cached_transcripts(gateway_id, session_key, agent_id, payload, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            """,
            bindings: [self.gatewayID, sessionKey, normalizedAgentID, payload, Date().timeIntervalSince1970])
        // rowid tie-breaks equal timestamps: INSERT OR REPLACE mints a fresh
        // rowid, so the most recently written transcript always survives.
        self.execute(
            db,
            sql: """
            DELETE FROM cached_transcripts WHERE gateway_id = ?1 AND rowid NOT IN (
                SELECT rowid FROM cached_transcripts WHERE gateway_id = ?1
                ORDER BY updated_at DESC, rowid DESC LIMIT \(Self.maxCachedTranscripts)
            )
            """,
            bindings: [self.gatewayID])
    }

    public func retire() async {
        // A queued write then either finishes before retirement or becomes a
        // no-op. Closing the handle lets the owner delete the whole cache file.
        self.isRetired = true
        self.db = nil
        self.outboxChangeHub.finish()
    }

    // MARK: - OpenClawChatCommandOutbox

    public nonisolated func changes() -> AsyncStream<OpenClawChatOutboxChange> {
        self.outboxChangeHub.stream()
    }

    public func enqueueCommand(_ command: OpenClawChatOutboxCommand) async -> Bool {
        guard let attachmentByteCount = Self.attachmentByteCount(command.attachments),
              Self.canEnqueueAttachmentBytes(
                  commandBytes: attachmentByteCount,
                  queuedBytes: 0),
              let attachments = Self.encodeJSON(command.attachments),
              !self.isRetired,
              let db = await handle(),
              sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK
        else { return false }
        var committed = false
        defer {
            if !committed {
                sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            }
        }
        guard let count = selectInt(
            db,
            sql: "SELECT COUNT(*) FROM outbox_commands WHERE gateway_id = ?1",
            bindings: [gatewayID]),
            let queuedAttachmentBytes = selectInt(
                db,
                sql: "SELECT COALESCE(SUM(attachment_bytes), 0) FROM outbox_commands WHERE gateway_id = ?1",
                bindings: [gatewayID])
        else { return false }
        // Count all statuses: failed and unconfirmed rows still own their bytes
        // until canonical history or explicit deletion releases them.
        guard count < Self.maxQueuedCommands,
              Self.canEnqueueAttachmentBytes(
                  commandBytes: attachmentByteCount,
                  queuedBytes: queuedAttachmentBytes),
              self.execute(
                  db,
                  sql: """
                  INSERT INTO outbox_commands(
                      client_uuid, gateway_id, session_key, delivery_session_key, routing_contract,
                      agent_id, text, attachments, attachment_bytes, thinking, created_at, status,
                      retry_count, last_error
                  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                  """,
                  bindings: [
                      command.id,
                      self.gatewayID,
                      command.sessionKey,
                      command.deliverySessionKey,
                      command.routingContract ?? "",
                      command.agentID ?? "",
                      command.text,
                      attachments,
                      attachmentByteCount,
                      command.thinking,
                      command.createdAt,
                      command.status.rawValue,
                      command.retryCount,
                      command.lastError ?? "",
                  ]),
              sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK
        else { return false }
        committed = true
        return true
    }

    public func loadCommands() async -> [OpenClawChatOutboxCommand] {
        await self.loadCommandsIfAvailable() ?? []
    }

    public func loadCommandsIfAvailable() async -> [OpenClawChatOutboxCommand]? {
        guard !self.isRetired, let db = await handle() else { return nil }
        guard self.applyOutboxStaleness(db) else { return nil }
        return self.readCommands(db)
    }

    @discardableResult
    public func recoverInterruptedSends() async -> Bool {
        guard !self.isRetired else { return false }
        if self.hasRecoveredInterruptedSends { return true }
        guard let db = await handle() else { return false }
        let recovered = self.execute(
            db,
            sql: """
            UPDATE outbox_commands SET status = 'failed', last_error = ?2
            WHERE gateway_id = ?1 AND status = 'sending'
            """,
            bindings: [self.gatewayID, Self.outboxUnconfirmedError])
        if recovered {
            self.hasRecoveredInterruptedSends = true
        }
        return recovered
    }

    public func claimNextCommand() async -> OpenClawChatOutboxCommand? {
        guard !self.isRetired, let db = await handle() else { return nil }
        guard self.execute(db, sql: "BEGIN IMMEDIATE", bindings: []) else { return nil }
        var committed = false
        defer {
            if !committed {
                _ = self.execute(db, sql: "ROLLBACK", bindings: [])
            }
        }
        guard self.applyOutboxStaleness(db) else { return nil }
        guard let activeClaimCount = selectInt(
            db,
            sql: "SELECT COUNT(*) FROM outbox_commands WHERE gateway_id = ?1 AND status = 'sending'",
            bindings: [gatewayID])
        else { return nil }
        let hasActiveClaim = activeClaimCount > 0
        guard !hasActiveClaim else {
            committed = self.execute(db, sql: "COMMIT", bindings: [])
            return nil
        }
        guard let commands = readCommands(db) else { return nil }
        guard var next = commands.first(where: { $0.status == .queued }) else {
            committed = self.execute(db, sql: "COMMIT", bindings: [])
            return nil
        }
        let updated = self.execute(
            db,
            sql: """
            UPDATE outbox_commands SET status = 'sending'
            WHERE gateway_id = ?1 AND client_uuid = ?2 AND status = 'queued'
            """,
            bindings: [self.gatewayID, next.id]) && sqlite3_changes(db) > 0
        guard updated else { return nil }
        committed = self.execute(db, sql: "COMMIT", bindings: [])
        guard committed else { return nil }
        next.status = .sending
        return next
    }

    public func markCommandQueued(id: String, retryCount: Int, lastError: String?) async {
        await self.updateCommandStatus(id: id, status: "queued", retryCount: retryCount, lastError: lastError)
    }

    public func markCommandAwaitingConfirmation(id: String) async -> OpenClawChatOutboxUpdateResult {
        guard !self.isRetired, let db = await handle() else {
            self.hasRecoveredInterruptedSends = false
            return .unavailable
        }
        let updated = self.execute(
            db,
            sql: """
            UPDATE outbox_commands SET status = 'awaiting_confirmation', retry_count = 0, last_error = ''
            WHERE gateway_id = ?1 AND client_uuid = ?2 AND status = 'sending'
            """,
            bindings: [self.gatewayID, id])
        guard updated else {
            // The claimed row may still be `sending`; a later healthy pass
            // must fail it closed within this store lifetime.
            self.hasRecoveredInterruptedSends = false
            return .unavailable
        }
        return sqlite3_changes(db) > 0 ? .updated : .missing
    }

    public func markCommandFailedIfPresent(
        id: String,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    {
        guard !self.isRetired, let db = await handle() else {
            self.hasRecoveredInterruptedSends = false
            return .unavailable
        }
        let updated = self.execute(
            db,
            sql: """
            UPDATE outbox_commands SET status = 'failed', retry_count = ?3, last_error = ?4
            WHERE gateway_id = ?1 AND client_uuid = ?2 AND status = 'sending'
            """,
            bindings: [self.gatewayID, id, retryCount, lastError ?? ""])
        guard updated else {
            // The caller must stop this flush pass until storage is healthy;
            // otherwise a durable `sending` row can block the FIFO silently.
            self.hasRecoveredInterruptedSends = false
            return .unavailable
        }
        return sqlite3_changes(db) > 0 ? .updated : .missing
    }

    public func markCommandRetriedIfPresent(
        id: String,
        agentID: String?,
        deliverySessionKey: String,
        routingContract: String) async -> OpenClawChatOutboxUpdateResult
    {
        guard !self.isRetired, let db = await handle() else { return .unavailable }
        let normalizedAgentID = agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let normalizedDeliverySessionKey = deliverySessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedRoutingContract = routingContract.trimmingCharacters(in: .whitespacesAndNewlines)
        let allowsUntargetedAgent = normalizedRoutingContract == OpenClawChatOutboxCommand
            .legacyUnboundRoutingContract || normalizedDeliverySessionKey.lowercased() == "unknown"
        guard !normalizedAgentID.isEmpty || allowsUntargetedAgent,
              !normalizedDeliverySessionKey.isEmpty,
              !normalizedRoutingContract.isEmpty
        else { return .unavailable }
        guard self.execute(db, sql: "BEGIN IMMEDIATE", bindings: []) else { return .unavailable }
        var committed = false
        defer {
            if !committed {
                _ = self.execute(db, sql: "ROLLBACK", bindings: [])
            }
        }
        let previousTarget = self.lookupOutboxTarget(db, id: id)
        let previousSessionKey: String
        let previousAgentID: String
        switch previousTarget {
        case let .value(sessionKey, agentID):
            previousSessionKey = sessionKey
            previousAgentID = agentID
        case .missing:
            committed = self.execute(db, sql: "COMMIT", bindings: [])
            return committed ? .missing : .unavailable
        case .unavailable:
            return .unavailable
        }
        guard self.execute(
            db,
            sql: """
            UPDATE outbox_commands
            SET status = 'queued', retry_count = 0, last_error = '', created_at = ?3,
                agent_id = ?4, delivery_session_key = ?5, routing_contract = ?6
            WHERE gateway_id = ?1 AND client_uuid = ?2 AND status = 'failed'
            """,
            bindings: [
                self.gatewayID,
                id,
                Date().timeIntervalSince1970,
                normalizedAgentID,
                normalizedDeliverySessionKey,
                normalizedRoutingContract,
            ])
        else { return .unavailable }
        guard sqlite3_changes(db) > 0 else {
            committed = self.execute(db, sql: "COMMIT", bindings: [])
            return committed ? .missing : .unavailable
        }
        // Retargeting adopts a new cache owner. Remove the optimistic row
        // from the previous partition before the command becomes sendable.
        if Self.normalizedAgentID(previousAgentID) != normalizedAgentID,
           !self.removeCachedMessage(
               db,
               sessionKey: previousSessionKey,
               agentID: Self.transcriptCacheAgentID(
                   sessionKey: previousSessionKey,
                   agentID: previousAgentID),
               idempotencyKey: "\(id):user")
        {
            return .unavailable
        }
        committed = self.execute(db, sql: "COMMIT", bindings: [])
        return committed ? .updated : .unavailable
    }

    public func cancelCommand(id: String) async -> OpenClawChatOutboxUpdateResult {
        guard !self.isRetired, let db = await handle() else { return .unavailable }
        guard self.execute(db, sql: "BEGIN IMMEDIATE", bindings: []) else { return .unavailable }
        var committed = false
        defer {
            if !committed {
                _ = self.execute(db, sql: "ROLLBACK", bindings: [])
            }
        }
        let messageKey = "\(id):user"
        let targetLookup = self.lookupOutboxTarget(db, id: id)
        let sessionKey: String
        let agentID: String
        switch targetLookup {
        case let .value(foundSessionKey, foundAgentID):
            sessionKey = foundSessionKey
            agentID = foundAgentID
        case .missing:
            let isProven = self.canonicalMessageProofHub.lockProofDecision(for: messageKey)
            defer { self.canonicalMessageProofHub.unlockProofDecision() }
            committed = self.execute(db, sql: "COMMIT", bindings: [])
            guard committed else { return .unavailable }
            return isProven ? .confirmed : .missing
        case .unavailable:
            return .unavailable
        }
        guard self.execute(
            db,
            sql: """
            DELETE FROM outbox_commands
            WHERE gateway_id = ?1 AND client_uuid = ?2 AND status IN ('queued', 'failed')
            """,
            bindings: [self.gatewayID, id])
        else { return .unavailable }
        guard sqlite3_changes(db) > 0 else { return .unavailable }
        let result: OpenClawChatOutboxUpdateResult
        do {
            let isProven = self.canonicalMessageProofHub.lockProofDecision(for: messageKey)
            defer { self.canonicalMessageProofHub.unlockProofDecision() }
            if isProven {
                committed = self.execute(db, sql: "COMMIT", bindings: [])
                result = committed ? .confirmed : .unavailable
            } else {
                guard self.removeCachedMessage(
                    db,
                    sessionKey: sessionKey,
                    agentID: Self.transcriptCacheAgentID(
                        sessionKey: sessionKey,
                        agentID: agentID),
                    idempotencyKey: messageKey)
                else { return .unavailable }
                committed = self.execute(db, sql: "COMMIT", bindings: [])
                result = committed ? .updated : .unavailable
            }
        }
        if result == .confirmed {
            self.emitOutboxChange(.confirmed(id: id))
            return .confirmed
        }
        guard result == .updated else { return .unavailable }
        Self.rememberMessageKey(
            messageKey,
            sessionKey: sessionKey,
            storage: &self.canceledMessageKeysBySession)
        self.emitOutboxChange(.canceled(id: id))
        return .updated
    }

    public func confirmCommand(id: String) async -> OpenClawChatOutboxUpdateResult {
        guard !self.isRetired, let db = await handle() else { return .unavailable }
        guard self.execute(
            db,
            sql: "DELETE FROM outbox_commands WHERE gateway_id = ?1 AND client_uuid = ?2",
            bindings: [self.gatewayID, id])
        else { return .unavailable }
        guard sqlite3_changes(db) > 0 else { return .missing }
        self.emitOutboxChange(.confirmed(id: id))
        return .updated
    }

    private func emitOutboxChange(_ change: OpenClawChatOutboxChange) {
        self.outboxChangeHub.yield(change)
    }

    private func updateCommandStatus(id: String, status: String, retryCount: Int, lastError: String?) async {
        guard !self.isRetired, let db = await handle() else {
            self.hasRecoveredInterruptedSends = false
            return
        }
        let updated = self.execute(
            db,
            sql: """
            UPDATE outbox_commands SET status = ?3, retry_count = ?4, last_error = ?5
            WHERE gateway_id = ?1 AND client_uuid = ?2
            """,
            bindings: [self.gatewayID, id, status, retryCount, lastError ?? ""])
        if !updated {
            self.hasRecoveredInterruptedSends = false
        }
    }

    private func applyOutboxStaleness(_ db: OpaquePointer) -> Bool {
        // Old queued work is no longer safe to send automatically. Likewise,
        // an acknowledged row that never appeared in canonical history needs
        // an explicit user decision rather than a potentially duplicate replay.
        self.execute(
            db,
            sql: """
            UPDATE outbox_commands
            SET status = 'failed',
                last_error = CASE WHEN status = 'awaiting_confirmation' THEN ?4 ELSE ?3 END
            WHERE gateway_id = ?1
              AND status IN ('queued', 'awaiting_confirmation')
              AND created_at < ?2
            """,
            bindings: [
                self.gatewayID,
                Date().timeIntervalSince1970 - Self.outboxCommandMaxAge,
                Self.outboxExpiredError,
                Self.outboxUnconfirmedError,
            ])
    }

    // MARK: - Cached shapes

    /// Text rows only in v1: strip attachment/binary payloads and tool
    /// arguments so the cache never persists base64 blobs or large payloads.
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
                        arguments: nil)
                },
                timestamp: message.timestamp,
                idempotencyKey: message.idempotencyKey,
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                usage: message.usage,
                stopReason: message.stopReason,
                errorMessage: message.errorMessage)
        }
    }

    static func boundedSessions(_ sessions: [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry] {
        guard sessions.count > self.maxCachedSessions else { return sessions }
        return Array(
            sessions
                .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
                .prefix(self.maxCachedSessions))
    }

    private static func normalizedAgentID(_ agentID: String?) -> String {
        agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    private static func transcriptCacheAgentID(sessionKey: String, agentID: String) -> String {
        let parts = sessionKey
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        // Canonical agent keys already own their cache partition. Aliases
        // need the separate agent dimension to prevent cross-agent repaint.
        if parts.count >= 3, parts[0].lowercased() == "agent", !parts[1].isEmpty, !parts[2].isEmpty {
            return ""
        }
        return self.normalizedAgentID(agentID)
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

    private static func encodeJSON(_ value: some Encodable) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(bytes: data, encoding: .utf8)
    }

    private static func rememberMessageKey(
        _ key: String,
        sessionKey: String,
        storage: inout [String: [String]])
    {
        var keys = storage[sessionKey] ?? []
        keys.removeAll(where: { $0 == key })
        keys.append(key)
        if keys.count > Self.maxCachedMessagesPerSession {
            keys.removeFirst(keys.count - Self.maxCachedMessagesPerSession)
        }
        storage[sessionKey] = keys
        if storage.count > Self.maxCachedTranscripts,
           let evictedSession = storage.keys.first(where: { $0 != sessionKey })
        {
            storage.removeValue(forKey: evictedSession)
        }
    }

    /// Runs inside the outbox cancellation transaction, so a process exit can
    /// never leave a deleted command behind as an ordinary cached sent row.
    private func removeCachedMessage(
        _ db: OpaquePointer,
        sessionKey: String,
        agentID: String,
        idempotencyKey: String) -> Bool
    {
        let transcriptLookup = self.lookupPayload(
            db,
            sql: """
            SELECT payload FROM cached_transcripts
            WHERE gateway_id = ?1 AND session_key = ?2 AND agent_id = ?3
            """,
            bindings: [self.gatewayID, sessionKey, agentID])
        let payload: String
        switch transcriptLookup {
        case let .value(value):
            payload = value
        case .missing:
            return true
        case .unavailable:
            return false
        }
        guard let decoded = try? JSONDecoder().decode(
            [OpenClawChatMessage].self,
            from: Data(payload.utf8))
        else {
            return self.execute(
                db,
                sql: """
                DELETE FROM cached_transcripts
                WHERE gateway_id = ?1 AND session_key = ?2 AND agent_id = ?3
                """,
                bindings: [self.gatewayID, sessionKey, agentID])
        }
        let filtered = decoded.filter { $0.idempotencyKey != idempotencyKey }
        guard filtered.count != decoded.count else { return true }
        guard !filtered.isEmpty else {
            return self.execute(
                db,
                sql: """
                DELETE FROM cached_transcripts
                WHERE gateway_id = ?1 AND session_key = ?2 AND agent_id = ?3
                """,
                bindings: [self.gatewayID, sessionKey, agentID])
        }
        guard let filteredPayload = Self.encodeJSON(filtered) else { return false }
        return self.execute(
            db,
            sql: """
            UPDATE cached_transcripts SET payload = ?4, updated_at = ?5
            WHERE gateway_id = ?1 AND session_key = ?2 AND agent_id = ?3
            """,
            bindings: [self.gatewayID, sessionKey, agentID, filteredPayload, Date().timeIntervalSince1970])
    }

    // MARK: - Connection lifecycle

    private func handle() async -> OpaquePointer? {
        guard !self.isRetired else { return nil }
        if let db { return db.raw }
        if self.isBroken { return nil }
        #if os(iOS)
        // Complete protection intentionally makes the cache unavailable while
        // locked. Treat that as a temporary miss, never as corruption.
        guard await self.isProtectedDataAvailable(), !self.isRetired else { return nil }
        #endif
        let databaseExisted = FileManager.default.fileExists(atPath: self.databaseURL.path)
        if let opened = openConnection() {
            db = Connection(raw: opened)
            return opened
        }
        #if os(iOS)
        guard await self.isProtectedDataAvailable(), !self.isRetired else { return nil }
        #endif
        if databaseExisted {
            // The shared file may contain unsent user text. Preserve it for a
            // future compatible build or explicit owner purge instead of
            // turning a cache repair into silent outbox data loss.
            cacheLogger.error("chat offline store unavailable; preserving existing database")
            self.isBroken = true
            return nil
        }
        // A failed first create cannot contain user state; remove the partial
        // file and retry once so transient bootstrap failures self-heal.
        self.removeDatabaseFiles()
        if let reopened = openConnection() {
            db = Connection(raw: reopened)
            return reopened
        }
        cacheLogger.error("chat transcript cache unavailable; continuing without offline cache")
        self.isBroken = true
        return nil
    }

    #if os(iOS)
    private func isProtectedDataAvailable() async -> Bool {
        await MainActor.run { UIApplication.shared.isProtectedDataAvailable }
    }
    #endif

    private func openConnection() -> OpaquePointer? {
        let fm = FileManager.default
        try? fm.createDirectory(
            at: self.databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        var opened: OpaquePointer?
        var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        #if os(iOS)
        // Apply Complete protection through the SQLite VFS so auxiliary files
        // receive the same class as the main transcript database.
        flags |= SQLITE_OPEN_FILEPROTECTION_COMPLETE
        #endif
        guard sqlite3_open_v2(self.databaseURL.path, &opened, flags, nil) == SQLITE_OK, let opened else {
            sqlite3_close_v2(opened)
            return nil
        }
        guard let version = readUserVersion(opened) else {
            sqlite3_close_v2(opened)
            return nil
        }
        if version == 0 {
            guard self.createSchema(opened) else {
                sqlite3_close_v2(opened)
                return nil
            }
        } else if version == 1 {
            guard self.migrateSchemaFromV1(opened) else {
                sqlite3_close_v2(opened)
                return nil
            }
        } else if version == 2 {
            guard self.migrateSchemaFromV2(opened) else {
                sqlite3_close_v2(opened)
                return nil
            }
        } else if version == 3 {
            guard self.migrateSchemaFromV3(opened) else {
                sqlite3_close_v2(opened)
                return nil
            }
        } else if version == 4 {
            guard self.migrateSchemaFromV4(opened) else {
                sqlite3_close_v2(opened)
                return nil
            }
        } else if version == 5 {
            guard self.migrateSchemaFromV5(opened) else {
                sqlite3_close_v2(opened)
                return nil
            }
        } else if version != Self.schemaVersion {
            // Unknown schemas may contain outbox rows from a newer build.
            // The caller preserves the file and fails closed.
            sqlite3_close_v2(opened)
            return nil
        }
        #if os(iOS)
        // Upgrade a database created by an older build to the stricter class.
        try? fm.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: self.databaseURL.path)
        #endif
        return opened
    }

    private func readUserVersion(_ db: OpaquePointer) -> Int32? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "PRAGMA user_version", -1, &statement, nil) == SQLITE_OK else {
            return nil
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        return sqlite3_column_int(statement, 0)
    }

    private func createSchema(_ db: OpaquePointer) -> Bool {
        let statements = [
            """
            CREATE TABLE IF NOT EXISTS cached_sessions(
                gateway_id TEXT NOT NULL PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
            """,
            Self.createTranscriptTableSQL,
            Self.createOutboxTableSQL,
            Self.createRoutingIdentityTableSQL,
            "PRAGMA user_version = \(Self.schemaVersion)",
        ]
        for sql in statements {
            guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { return false }
        }
        return true
    }

    private func migrateSchemaFromV1(_ db: OpaquePointer) -> Bool {
        guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
        var committed = false
        defer {
            if !committed {
                sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            }
        }
        guard self.migrateTranscriptTableToV3(db),
              sqlite3_exec(db, Self.createOutboxTableSQL, nil, nil, nil) == SQLITE_OK,
              sqlite3_exec(db, Self.createRoutingIdentityTableSQL, nil, nil, nil) == SQLITE_OK,
              sqlite3_exec(db, "PRAGMA user_version = \(Self.schemaVersion)", nil, nil, nil) == SQLITE_OK,
              sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK
        else {
            return false
        }
        committed = true
        return true
    }

    private func migrateSchemaFromV2(_ db: OpaquePointer) -> Bool {
        guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
        var committed = false
        defer {
            if !committed {
                sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            }
        }
        // A v2 non-canonical alias has no durable agent owner. Park it for
        // explicit retry; the current default agent may have changed. Agent
        // keys already carry enough ownership to migrate without replay risk.
        guard self.migrateTranscriptTableToV3(db),
              sqlite3_exec(
                  db,
                  "ALTER TABLE outbox_commands ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''",
                  nil,
                  nil,
                  nil) == SQLITE_OK,
              sqlite3_exec(
                  db,
                  "ALTER TABLE outbox_commands ADD COLUMN delivery_session_key TEXT NOT NULL DEFAULT ''",
                  nil,
                  nil,
                  nil) == SQLITE_OK,
              sqlite3_exec(
                  db,
                  "ALTER TABLE outbox_commands ADD COLUMN routing_contract TEXT NOT NULL DEFAULT ''",
                  nil,
                  nil,
                  nil) == SQLITE_OK,
              self.addV6AttachmentColumns(db),
              self.execute(
                  db,
                  sql: """
                  UPDATE outbox_commands
                  SET status = 'failed',
                      last_error = CASE
                          WHEN status IN ('sending', 'awaiting_confirmation') OR last_error = ?2
                              THEN ?2
                          ELSE ?1
                      END,
                      agent_id = '',
                      delivery_session_key = '', routing_contract = ''
                  """,
                  bindings: [Self.outboxUnknownTargetError, Self.outboxUnconfirmedError]),
              sqlite3_exec(db, Self.createRoutingIdentityTableSQL, nil, nil, nil) == SQLITE_OK,
              sqlite3_exec(db, "PRAGMA user_version = \(Self.schemaVersion)", nil, nil, nil) == SQLITE_OK,
              sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK
        else {
            return false
        }
        committed = true
        return true
    }

    private func migrateSchemaFromV3(_ db: OpaquePointer) -> Bool {
        guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
        var committed = false
        defer {
            if !committed {
                sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            }
        }
        guard sqlite3_exec(
            db,
            "ALTER TABLE outbox_commands ADD COLUMN routing_contract TEXT NOT NULL DEFAULT ''",
            nil,
            nil,
            nil) == SQLITE_OK,
            self.addV6AttachmentColumns(db),
            self.execute(
                db,
                sql: """
                UPDATE outbox_commands
                SET status = 'failed',
                    last_error = CASE
                        WHEN status IN ('sending', 'awaiting_confirmation') OR last_error = ?2
                            THEN ?2
                        ELSE ?1
                    END,
                    agent_id = '',
                    delivery_session_key = '', routing_contract = ''
                """,
                bindings: [Self.outboxUnknownTargetError, Self.outboxUnconfirmedError]),
            sqlite3_exec(db, Self.createRoutingIdentityTableSQL, nil, nil, nil) == SQLITE_OK,
            sqlite3_exec(db, "PRAGMA user_version = \(Self.schemaVersion)", nil, nil, nil) == SQLITE_OK,
            sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK
        else { return false }
        committed = true
        return true
    }

    private func migrateSchemaFromV4(_ db: OpaquePointer) -> Bool {
        guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
        var committed = false
        defer {
            if !committed {
                sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            }
        }
        guard sqlite3_exec(db, Self.createRoutingIdentityTableSQL, nil, nil, nil) == SQLITE_OK,
              self.addV6AttachmentColumns(db),
              sqlite3_exec(db, "PRAGMA user_version = \(Self.schemaVersion)", nil, nil, nil) == SQLITE_OK,
              sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK
        else { return false }
        committed = true
        return true
    }

    private func migrateSchemaFromV5(_ db: OpaquePointer) -> Bool {
        guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
        var committed = false
        defer {
            if !committed {
                sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            }
        }
        guard self.addV6AttachmentColumns(db),
              sqlite3_exec(db, "PRAGMA user_version = \(Self.schemaVersion)", nil, nil, nil) == SQLITE_OK,
              sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK
        else { return false }
        committed = true
        return true
    }

    private func addV6AttachmentColumns(_ db: OpaquePointer) -> Bool {
        sqlite3_exec(
            db,
            "ALTER TABLE outbox_commands ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
            nil,
            nil,
            nil) == SQLITE_OK &&
            sqlite3_exec(
                db,
                "ALTER TABLE outbox_commands ADD COLUMN attachment_bytes INTEGER NOT NULL DEFAULT 0",
                nil,
                nil,
                nil) == SQLITE_OK
    }

    private func migrateTranscriptTableToV3(_ db: OpaquePointer) -> Bool {
        let hadAgentID = self.table(db, hasColumn: "agent_id", tableName: "cached_transcripts")
        guard sqlite3_exec(
            db,
            "ALTER TABLE cached_transcripts RENAME TO cached_transcripts_pre_v3",
            nil,
            nil,
            nil) == SQLITE_OK,
            sqlite3_exec(db, Self.createTranscriptTableSQL, nil, nil, nil) == SQLITE_OK
        else { return false }
        let copySQL = hadAgentID
            ? """
            INSERT INTO cached_transcripts(gateway_id, session_key, agent_id, payload, updated_at)
            SELECT gateway_id, session_key, agent_id, payload, updated_at
            FROM cached_transcripts_pre_v3
            """
            : """
            INSERT INTO cached_transcripts(gateway_id, session_key, agent_id, payload, updated_at)
            SELECT gateway_id, session_key, '', payload, updated_at
            FROM cached_transcripts_pre_v3
            WHERE lower(trim(session_key)) GLOB 'agent:*:*'
            """
        guard sqlite3_exec(db, copySQL, nil, nil, nil) == SQLITE_OK,
              sqlite3_exec(db, "DROP TABLE cached_transcripts_pre_v3", nil, nil, nil) == SQLITE_OK
        else { return false }
        return true
    }

    private func table(_ db: OpaquePointer, hasColumn columnName: String, tableName: String) -> Bool {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "PRAGMA table_info(\(tableName))", -1, &statement, nil) == SQLITE_OK else {
            return false
        }
        defer { sqlite3_finalize(statement) }
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let name = sqlite3_column_text(statement, 1) else { continue }
            if String(cString: name) == columnName { return true }
        }
        return false
    }

    // MARK: - Statement helpers

    @discardableResult
    private func execute(_ db: OpaquePointer, sql: String, bindings: [Any]) -> Bool {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            cacheLogger.error("cache statement prepare failed")
            return false
        }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: bindings) else { return false }
        return sqlite3_step(statement) == SQLITE_DONE
    }

    private func selectInt(_ db: OpaquePointer, sql: String, bindings: [Any]) -> Int? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: bindings) else { return nil }
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        return Int(sqlite3_column_int64(statement, 0))
    }

    private func readCommands(_ db: OpaquePointer) -> [OpenClawChatOutboxCommand]? {
        var statement: OpaquePointer?
        let sql = """
        SELECT client_uuid, session_key, delivery_session_key, routing_contract, agent_id,
               text, attachments, thinking, created_at, status, retry_count, last_error
        FROM outbox_commands WHERE gateway_id = ?1
        ORDER BY created_at ASC, id ASC
        """
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: [self.gatewayID]) else { return nil }

        var commands: [OpenClawChatOutboxCommand] = []
        var step = sqlite3_step(statement)
        while step == SQLITE_ROW {
            if let id = sqlite3_column_text(statement, 0),
               let sessionKey = sqlite3_column_text(statement, 1),
               let text = sqlite3_column_text(statement, 5)
            {
                let deliverySessionKey = sqlite3_column_text(statement, 2).map { String(cString: $0) } ?? ""
                let routingContract = sqlite3_column_text(statement, 3).map { String(cString: $0) }
                let agentID = sqlite3_column_text(statement, 4).map { String(cString: $0) }
                let attachmentsPayload = sqlite3_column_text(statement, 6).map { String(cString: $0) } ?? "[]"
                guard let attachments = try? JSONDecoder().decode(
                    [OpenClawChatOutboxAttachment].self,
                    from: Data(attachmentsPayload.utf8))
                else { return nil }
                let thinking = sqlite3_column_text(statement, 7).map { String(cString: $0) } ?? ""
                let statusRaw = sqlite3_column_text(statement, 9).map { String(cString: $0) } ?? ""
                let lastError = sqlite3_column_text(statement, 11).map { String(cString: $0) } ?? ""
                if let status = OpenClawChatOutboxCommand.Status(rawValue: statusRaw) {
                    commands.append(
                        OpenClawChatOutboxCommand(
                            id: String(cString: id),
                            sessionKey: String(cString: sessionKey),
                            deliverySessionKey: deliverySessionKey,
                            routingContract: routingContract,
                            agentID: agentID,
                            text: String(cString: text),
                            attachments: attachments,
                            thinking: thinking,
                            createdAt: sqlite3_column_double(statement, 8),
                            status: status,
                            retryCount: Int(sqlite3_column_int64(statement, 10)),
                            lastError: lastError.isEmpty ? nil : lastError))
                }
            }
            step = sqlite3_step(statement)
        }
        guard step == SQLITE_DONE else { return nil }
        return commands
    }

    private enum PayloadLookup {
        case value(String)
        case missing
        case unavailable
    }

    private enum OutboxTargetLookup {
        case value(sessionKey: String, agentID: String)
        case missing
        case unavailable
    }

    private func lookupOutboxTarget(_ db: OpaquePointer, id: String) -> OutboxTargetLookup {
        var statement: OpaquePointer?
        let sql = """
        SELECT session_key, agent_id FROM outbox_commands
        WHERE gateway_id = ?1 AND client_uuid = ?2 AND status IN ('queued', 'failed')
        """
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return .unavailable }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: [self.gatewayID, id]) else { return .unavailable }
        switch sqlite3_step(statement) {
        case SQLITE_ROW:
            guard let sessionKey = sqlite3_column_text(statement, 0) else { return .unavailable }
            let agentID = sqlite3_column_text(statement, 1).map { String(cString: $0) } ?? ""
            return .value(sessionKey: String(cString: sessionKey), agentID: agentID)
        case SQLITE_DONE:
            return .missing
        default:
            return .unavailable
        }
    }

    private func lookupPayload(_ db: OpaquePointer, sql: String, bindings: [Any]) -> PayloadLookup {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return .unavailable }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: bindings) else { return .unavailable }
        switch sqlite3_step(statement) {
        case SQLITE_ROW:
            guard let text = sqlite3_column_text(statement, 0) else { return .unavailable }
            return .value(String(cString: text))
        case SQLITE_DONE:
            return .missing
        default:
            return .unavailable
        }
    }

    private func selectPayload(_ db: OpaquePointer, sql: String, bindings: [Any]) -> String? {
        guard case let .value(payload) = lookupPayload(db, sql: sql, bindings: bindings) else {
            return nil
        }
        return payload
    }

    private func bind(_ statement: OpaquePointer?, bindings: [Any]) -> Bool {
        // SQLITE_TRANSIENT: sqlite copies the buffer before the Swift string dies.
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in bindings.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32 = switch value {
            case let text as String:
                sqlite3_bind_text(statement, index, text, -1, transient)
            case let int as Int:
                sqlite3_bind_int64(statement, index, Int64(int))
            case let real as Double:
                sqlite3_bind_double(statement, index, real)
            default:
                SQLITE_MISUSE
            }
            guard result == SQLITE_OK else { return false }
        }
        return true
    }

    private func removeDatabaseFiles() {
        self.db = nil
        Self.removeDatabaseFiles(at: self.databaseURL)
    }
}
