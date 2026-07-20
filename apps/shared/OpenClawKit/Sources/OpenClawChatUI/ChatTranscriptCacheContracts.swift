import Foundation

/// Read-only offline cache seam for chat sessions and transcripts.
///
/// The cache only pre-paints cold opens and covers offline browsing; connected
/// reads always come from the gateway and replace cached content wholesale.
/// Implementations must scope every row by gateway identity so one shared
/// installation database can safely serve all paired gateways.
public protocol OpenClawChatTranscriptCache: Sendable {
    func loadSessions() async -> [OpenClawChatSessionEntry]
    func loadTranscript(sessionKey: String) async -> [OpenClawChatMessage]
    func loadTranscript(sessionKey: String, agentID: String?) async -> [OpenClawChatMessage]
    func storeSessions(_ sessions: [OpenClawChatSessionEntry]) async
    /// Canonical gateway rows can prove that an ambiguously delivered local
    /// command landed after cancellation and must override local suppression.
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

    public func observeCanonicalMessageIdempotencyKeys(_: Set<String>) {}
}

/// Optional atomic merge seam for cache owners that also provide a durable
/// outbox. Keeping this separate preserves source compatibility for read-only
/// transcript-cache conformers.
protocol OpenClawChatCanonicalTranscriptMerging: OpenClawChatTranscriptCache {
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

/// Durable offline outbox for chat commands. Implementations expose one
/// gateway-scoped facade over installation-wide client state so queued sends
/// survive app restarts and flush on reconnect.
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
