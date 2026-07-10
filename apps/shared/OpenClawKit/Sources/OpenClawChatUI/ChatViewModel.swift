import Foundation
import Observation
import OpenClawKit
import OSLog

private let chatUILogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatUI")

@MainActor
@Observable
public final class OpenClawChatViewModel {
    public nonisolated static let defaultModelSelectionID = "__default__"
    static let maxAttachmentBytes = 5_000_000
    static let sessionListFetchLimit = 200

    public internal(set) var messages: [OpenClawChatMessage] = []

    public var input: String = ""
    public private(set) var thinkingLevel: String
    /// Setter is module-internal for the thinking-level extension only.
    public internal(set) var thinkingLevelOptions: [OpenClawChatThinkingLevelOption]
    /// Setter is module-internal for the thinking-level extension only.
    public internal(set) var showsThinkingPicker = true
    public private(set) var modelSelectionID: String = "__default__"
    public private(set) var modelChoices: [OpenClawChatModelChoice] = []
    private var modelPickerFavorites: [String]
    private var modelPickerRecents: [String]
    /// Setters are module-internal for the sending extension's command catalog.
    public internal(set) var slashCommands: [OpenClawChatCommandChoice] = []
    public internal(set) var isLoadingSlashCommands = false
    public internal(set) var slashCommandsErrorText: String?
    public internal(set) var hasLoadedSlashCommands = false
    @ObservationIgnored
    var slashFilterCache: SlashFilterCache?

    struct SlashFilterCache {
        let query: String
        let filter: OpenClawChatCommandFilter
        let result: [OpenClawChatCommandChoice]
    }

    private struct DeferredDeliveryIdentity {
        let activeAgentID: String?
        let sessionRoutingContract: String?
    }

    public private(set) var isLoading = false
    /// Setters are module-internal for the sending extension only.
    public internal(set) var isSending = false
    public internal(set) var isSendingAttachmentDraft = false
    private var deferredExternalSessionKey: String?
    private var deferredDeliveryIdentity: DeferredDeliveryIdentity?
    var isSubmittingDraft = false
    private var attachmentStagingCount = 0
    public private(set) var isAborting = false
    public var errorText: String?
    public var attachments: [OpenClawPendingAttachment] = []
    /// Setter is module-internal for the health/outbox extension only.
    public internal(set) var healthOK: Bool = false

    /// True when this view model owns a gateway-scoped durable text outbox.
    public var supportsOfflineTextOutbox: Bool {
        self.outbox != nil
    }

    public private(set) var pendingRunCount: Int = 0
    private(set) var hasActiveSessionRunWithoutChatSnapshot = false

    public private(set) var sessionKey: String {
        didSet { self.syncContextUsageFraction() }
    }

    public private(set) var sessionId: String?
    public private(set) var streamingAssistantText: String?

    public private(set) var pendingToolCalls: [OpenClawChatPendingToolCall] = []

    private(set) var timelineRevision: UInt64 = 0
    /// Setter is module-internal for the transcript-cache extension only.
    public internal(set) var sessions: [OpenClawChatSessionEntry] = [] {
        didSet { self.syncContextUsageFraction() }
    }

    public internal(set) var contextUsageFraction: Double?
    /// True while the visible transcript came from the offline cache and no
    /// live history response has replaced it yet (possibly stale).
    public internal(set) var isShowingCachedTranscript = false
    /// Guard the cache pre-paint: once a live response applied (even an empty
    /// one), a slow cache read must never paint stale rows over it.
    var hasAppliedLiveHistory = false
    var hasAppliedLiveSessions = false
    /// Internal for the outbox extension's flush path only.
    let transport: any OpenClawChatTransport
    let haptics: OpenClawChatHaptics
    let transcriptCache: (any OpenClawChatTranscriptCache)?
    let outbox: (any OpenClawChatCommandOutbox)?
    @ObservationIgnored
    private let modelPickerStore: ChatModelPickerStore
    /// Per-message outbox display state; rows without an entry are normal
    /// transcript rows. Observable so bubbles update when flush progresses.
    public internal(set) var outboxStatesByMessageID: [UUID: OpenClawChatOutboxMessageState] = [:]
    @ObservationIgnored
    var outboxCommandIDsByMessageID: [UUID: String] = [:]
    @ObservationIgnored
    var outboxMessageIDsByCommandID: [String: UUID] = [:]
    /// Recent canonical keys let the MainActor resolve proof that arrives
    /// after SQLite cancellation commits but before its UI continuation runs.
    @ObservationIgnored
    var canonicalOutboxMessageKeys: [String] = []
    @ObservationIgnored
    var isFlushingOutbox = false
    @ObservationIgnored
    var isOutboxFlushRequestedWhileActive = false
    @ObservationIgnored
    var cancelingOutboxCommandIDs: Set<String> = []
    @ObservationIgnored
    var outboxPresentationGeneration: UInt64 = 0
    @ObservationIgnored
    var outboxChangesTask: Task<Void, Never>?
    /// Backoff between failed flush attempts; internal so tests can shorten it.
    @ObservationIgnored
    var outboxRetryDelaysMs: [UInt64] = [2000, 8000]
    /// False until restoreOutboxMessages has adopted durable rows for the
    /// visible session. Until then the in-memory outbox state is blind to
    /// rows persisted by an earlier process, so the FIFO send gate must
    /// assume a backlog exists.
    @ObservationIgnored
    var hasRestoredOutboxMessages = false
    @ObservationIgnored
    nonisolated(unsafe) var outboxRetryTask: Task<Void, Never>?
    /// A command becomes terminally 'failed' after this many send attempts.
    nonisolated static let maxOutboxSendAttempts = 3
    @ObservationIgnored
    var pendingCacheWriteTask: Task<Void, Never>?
    private(set) var activeAgentId: String?
    private(set) var sessionRoutingContract: String?
    var sessionDefaults: OpenClawChatSessionsDefaults? {
        didSet { self.syncContextUsageFraction() }
    }

    private let prefersExplicitThinkingLevel: Bool
    private let onSessionChanged: (@MainActor (String) -> Void)?
    private let onThinkingLevelChanged: (@MainActor @Sendable (String) -> Void)?
    private let diagnosticsLog: (@MainActor @Sendable (String) -> Void)?
    private let attachmentOwnerIsActive: @MainActor () -> Bool

    @ObservationIgnored
    private nonisolated(unsafe) var eventTask: Task<Void, Never>?
    @ObservationIgnored
    private nonisolated(unsafe) var bootstrapTask: Task<Void, Never>?
    var runOwnershipGeneration: UInt64 = 0
    var latestAppliedRunSnapshotRequestID: UInt64 = 0
    private var isApplyingRunSnapshot = false
    var pendingRuns = Set<String>() {
        didSet {
            if self.pendingRuns != oldValue, !self.isApplyingRunSnapshot {
                self.runOwnershipGeneration &+= 1
            }
            let nextCount = self.pendingRuns.count
            guard nextCount != self.pendingRunCount else { return }
            self.pendingRunCount = nextCount
            self.markTimelineChanged()
        }
    }

    var pendingLocalUserEchoMessageIDsByRunID: [String: UUID] = [:]
    // Final chat events and durable session-message rows arrive independently.
    // Keep each provisional final scoped to the run's user turn so a later identical
    // answer in the same session does not adopt or suppress the wrong row.
    var runMessageScopesByRunID: [String: RunMessageScope] = [:]
    var provisionalFinalMessagesByID: [UUID: ProvisionalFinalMessage] = [:]
    private var sessionGeneration: UInt64 = 0
    private var bootstrapGeneration: UInt64 = 0
    // A newer same-session history request only invalidates older responses after it applies.
    // Failed later refreshes must not drop the last successful pending-run history payload.
    private var lastIssuedHistoryRequestID: UInt64 = 0
    private var latestAppliedHistoryRequestID: UInt64 = 0
    private var historyMutationGeneration: UInt64 = 0

    @ObservationIgnored
    nonisolated(unsafe) var pendingRunTimeoutTasks: [String: Task<Void, Never>] = [:]
    var nextPendingRunTimeoutArmID: UInt64 = 0
    var pendingRunTimeoutArmIDs: [String: UInt64] = [:]
    @ObservationIgnored
    private nonisolated(unsafe) var activeSessionRunIndicatorTimeoutTask: Task<Void, Never>?
    let pendingRunTimeoutMs: UInt64 = 120_000
    static let postSendRefreshDelaysMs: [UInt64] = [
        1500,
        4000,
        9000,
        20000,
        45000,
        90000,
    ]
    // Session switches can overlap in-flight picker patches, so stale completions
    // must compare against the latest request and latest desired value for that session.
    private var nextModelSelectionRequestID: UInt64 = 0
    private var latestModelSelectionRequestIDsBySession: [String: UInt64] = [:]
    private var latestModelSelectionIDsBySession: [String: String] = [:]
    private var lastSuccessfulModelSelectionIDsBySession: [String: String] = [:]
    private var inFlightModelPatchCountsBySession: [String: Int] = [:]
    private var modelPatchWaitersBySession: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var nextThinkingSelectionRequestID: UInt64 = 0
    private var latestThinkingSelectionRequestIDsBySession: [String: UInt64] = [:]
    private var latestThinkingLevelsBySession: [String: String] = [:]
    private var isCompacting = false
    private var lastCompactAt: Date?
    private let compactCooldown: TimeInterval = 60

    private enum SessionSwitchIntent {
        case userInitiated
        case externalSync
    }

    private struct BootstrapContext {
        var id: UInt64
        var historyRequest: HistoryRequest

        var session: SessionSnapshot {
            self.historyRequest.session
        }
    }

    struct HistoryRequest {
        var id: UInt64
        var session: SessionSnapshot
        var pendingRunIDs: Set<String>
        var visibleMessagesByID: [UUID: OpenClawChatMessage]
        var historyMutationGeneration: UInt64
        var runOwnershipGeneration: UInt64
        var latestUserTurn: LatestUserTurn?
    }

    struct RunHistoryRefreshResult {
        let applied: Bool
        let runSnapshotApplied: Bool
        let supportsInFlightRunState: Bool
        let hasInFlightRun: Bool
        let sessionHasActiveRun: Bool

        static let failed = RunHistoryRefreshResult(
            applied: false,
            runSnapshotApplied: false,
            supportsInFlightRunState: false,
            hasInFlightRun: false,
            sessionHasActiveRun: false)
    }

    struct LatestUserTurn {
        var idempotencyKey: String?
        var refreshKey: String?
        var occurrence: Int
        var timestamp: Double?
    }

    struct RunMessageScope {
        var session: SessionSnapshot
        var latestUserTurn: LatestUserTurn?
    }

    struct ProvisionalFinalMessage {
        var reconciliationKey: String
        var runId: String?
        var scope: RunMessageScope
    }

    var pendingToolCallsById: [String: OpenClawChatPendingToolCall] = [:] {
        didSet {
            guard self.pendingToolCallsById != oldValue else { return }
            self.pendingToolCalls = self.pendingToolCallsById.values
                .sorted { ($0.startedAt ?? 0) < ($1.startedAt ?? 0) }
            self.markTimelineChanged()
        }
    }

    var lastHealthPollAt: Date?

    public init(
        sessionKey: String,
        transport: any OpenClawChatTransport,
        activeAgentId: String? = nil,
        sessionRoutingContract: String? = nil,
        attachmentOwnerIsActive: @escaping @MainActor () -> Bool = { false },
        haptics: OpenClawChatHaptics = OpenClawChatHaptics(),
        transcriptCache: (any OpenClawChatTranscriptCache)? = nil,
        outbox: (any OpenClawChatCommandOutbox)? = nil,
        modelPickerStore: ChatModelPickerStore = ChatModelPickerStore(),
        initialThinkingLevel: String? = nil,
        onSessionChanged: (@MainActor (String) -> Void)? = nil,
        onThinkingLevelChanged: (@MainActor @Sendable (String) -> Void)? = nil,
        diagnosticsLog: (@MainActor @Sendable (String) -> Void)? = nil)
    {
        self.sessionKey = sessionKey
        self.transport = transport
        self.haptics = haptics
        self.transcriptCache = transcriptCache
        self.modelPickerStore = modelPickerStore
        self.modelPickerFavorites = modelPickerStore.favorites
        self.modelPickerRecents = modelPickerStore.recents
        self.outbox = outbox
        let normalizedAgentId = activeAgentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.activeAgentId = normalizedAgentId?.isEmpty == false ? normalizedAgentId : nil
        let normalizedRoutingContract = sessionRoutingContract?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        self.sessionRoutingContract = normalizedRoutingContract?.isEmpty == false ? normalizedRoutingContract : nil
        let normalizedThinkingLevel = Self.normalizedThinkingLevel(initialThinkingLevel)
        let initialResolvedThinkingLevel = normalizedThinkingLevel ?? "off"
        self.thinkingLevel = initialResolvedThinkingLevel
        self.thinkingLevelOptions = Self.withCurrentThinkingOption(
            Self.baseThinkingLevelOptions,
            current: initialResolvedThinkingLevel)
        self.prefersExplicitThinkingLevel = normalizedThinkingLevel != nil
        self.onSessionChanged = onSessionChanged
        self.onThinkingLevelChanged = onThinkingLevelChanged
        self.diagnosticsLog = diagnosticsLog
        self.attachmentOwnerIsActive = attachmentOwnerIsActive

        let transport = self.transport
        self.eventTask = Task { [weak self, transport] in
            let stream = transport.events()
            for await evt in stream {
                if Task.isCancelled {
                    return
                }
                await MainActor.run { [weak self] in
                    self?.handleTransportEvent(evt)
                }
            }
        }
        if let outbox = self.outbox {
            let changes = outbox.changes()
            self.outboxChangesTask = Task { [weak self, changes] in
                for await change in changes {
                    guard !Task.isCancelled else { return }
                    self?.handleOutboxChange(change)
                }
            }
        }
    }

    deinit {
        self.eventTask?.cancel()
        self.bootstrapTask?.cancel()
        self.outboxRetryTask?.cancel()
        self.outboxChangesTask?.cancel()
        self.activeSessionRunIndicatorTimeoutTask?.cancel()
        for (_, task) in self.pendingRunTimeoutTasks {
            task.cancel()
        }
    }

    public func load() {
        self.startBootstrap()
    }

    public func refresh() {
        self.startBootstrap()
    }

    public var modelPickerSections: ChatModelPickerSections {
        ChatModelPickerStore.sections(
            choices: self.modelChoices,
            favorites: self.modelPickerFavorites,
            recents: self.modelPickerRecents)
    }

    public var isSelectedModelPinned: Bool {
        self.modelSelectionID != Self.defaultModelSelectionID &&
            self.modelPickerFavorites.contains(self.modelSelectionID)
    }

    public func toggleSelectedModelPinned() {
        guard self.modelSelectionID != Self.defaultModelSelectionID else { return }
        self.modelPickerStore.toggleFavorite(self.modelSelectionID)
        self.modelPickerFavorites = self.modelPickerStore.favorites
    }

    public func resumeFromForeground() {
        Task { await self.refreshRunStateAfterForeground() }
    }

    public func abort() {
        Task { await self.performAbort() }
    }

    public func deleteSession(_ sessionKey: String) {
        Task {
            do {
                try await self.transport.deleteSession(key: sessionKey)
            } catch {
                self.errorText = error.localizedDescription
                return
            }
            self.sessions.removeAll { $0.key == sessionKey }
            if self.matchesCurrentSessionKey(incoming: sessionKey, current: self.sessionKey) {
                // The active transcript just disappeared server-side; fall
                // back to the main session instead of a dead key.
                let fallback = self.resolvedMainSessionKey
                if fallback != self.sessionKey {
                    self.applySessionSwitch(to: fallback, intent: .userInitiated)
                } else {
                    // Deleting the active main session: the key stays the
                    // address, so clear local state and re-bootstrap in place.
                    self.advanceSessionGeneration()
                    self.clearSessionOwnedState()
                    self.errorText = nil
                    self.startBootstrap()
                }
            }
            await self.fetchSessions(limit: nil, sessionSnapshot: self.currentSessionSnapshot())
        }
    }

    public func switchSession(to sessionKey: String) {
        self.applySessionSwitch(to: sessionKey, intent: .userInitiated)
    }

    public func syncSession(to sessionKey: String) {
        self.applySessionSwitch(to: sessionKey, intent: .externalSync)
    }

    public func syncActiveAgentId(_ agentId: String?) {
        self.syncDeliveryIdentity(
            activeAgentId: agentId,
            sessionRoutingContract: self.deferredDeliveryIdentity?.sessionRoutingContract
                ?? self.sessionRoutingContract)
    }

    public func syncSessionRoutingContract(_ contract: String?) {
        self.syncDeliveryIdentity(
            activeAgentId: self.deferredDeliveryIdentity?.activeAgentID ?? self.activeAgentId,
            sessionRoutingContract: contract)
    }

    /// Updates the alias owner and its gateway routing contract as one
    /// identity change so an intermediate bootstrap cannot win either value.
    public func syncDeliveryIdentity(
        activeAgentId agentId: String?,
        sessionRoutingContract contract: String?)
    {
        let normalized = agentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let nextAgentId = normalized?.isEmpty == false ? normalized : nil
        let normalizedContract = contract?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextContract = normalizedContract?.isEmpty == false ? normalizedContract : nil
        let agentChanged = self.activeAgentId != nextAgentId
        let contractChanged = self.sessionRoutingContract != nextContract
        guard agentChanged || contractChanged else {
            if self.blocksAttachmentOwnerChange {
                self.deferredDeliveryIdentity = nil
            }
            return
        }
        if self.blocksAttachmentOwnerChange {
            self.deferredDeliveryIdentity = DeferredDeliveryIdentity(
                activeAgentID: nextAgentId,
                sessionRoutingContract: nextContract)
            return
        }
        self.deferredDeliveryIdentity = nil
        // A scoped key can be the main alias under either side of a contract
        // change. Check both or stale transcript state can survive the switch.
        let contractRoutingChanged = contractChanged &&
            (usesMutableContractRouting(for: sessionRoutingContract) ||
                self.usesMutableContractRouting(for: nextContract))
        self.activeAgentId = nextAgentId
        self.sessionRoutingContract = nextContract
        let bootstrapIdentityChanged =
            (agentChanged && self.usesMutableAgentRouting) ||
            contractRoutingChanged
        guard bootstrapIdentityChanged else {
            if contractChanged, self.healthOK {
                flushOutboxIfNeeded()
            }
            return
        }
        // Restart when this key depends on a changed routing value so cleared
        // state cannot remain stuck or cross session owners.
        self.advanceSessionGeneration()
        self.clearSessionOwnedState()
        self.startBootstrap()
    }

    public func selectThinkingLevel(_ level: String) {
        Task { await self.performSelectThinkingLevel(level) }
    }

    public func selectModel(_ selectionID: String) {
        Task { await self.performSelectModel(selectionID) }
    }

    var resolvedMainSessionKey: String {
        let trimmed = self.sessionDefaults?.mainSessionKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false ? trimmed : nil) ?? "main"
    }

    private var usesMutableAgentRouting: Bool {
        Self.agentID(fromSessionKey: self.sessionKey) == nil
    }

    private func usesMutableContractRouting(for contract: String?) -> Bool {
        if self.usesMutableAgentRouting {
            return true
        }
        let parts = self.sessionKey
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3 else { return false }
        let normalizedSessionKey = parts[2].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let resolvedMainParts = self.resolvedMainSessionKey
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        let normalizedMainSessionKey = String(resolvedMainParts.last ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let contractMainKey = OpenClawChatSessionRoutingContract.parse(contract)?.mainKey ?? ""
        return normalizedSessionKey == "global" ||
            normalizedSessionKey == "main" ||
            normalizedSessionKey == normalizedMainSessionKey ||
            normalizedSessionKey == contractMainKey
    }

    public var showsModelPicker: Bool {
        !self.modelChoices.isEmpty
    }

    public var defaultModelLabel: String {
        guard let defaultModelID = normalizedModelSelectionID(sessionDefaults?.model) else {
            return "Default"
        }
        return "Default: \(self.modelLabel(for: defaultModelID))"
    }

    static let baseThinkingLevelOptions: [OpenClawChatThinkingLevelOption] = [
        OpenClawChatThinkingLevelOption(id: "off", label: "off"),
        OpenClawChatThinkingLevelOption(id: "minimal", label: "minimal"),
        OpenClawChatThinkingLevelOption(id: "low", label: "low"),
        OpenClawChatThinkingLevelOption(id: "medium", label: "medium"),
        OpenClawChatThinkingLevelOption(id: "high", label: "high"),
    ]

    public func addAttachments(urls: [URL]) {
        self.beginAttachmentStaging()
        Task {
            defer { self.endAttachmentStaging() }
            await self.loadAttachments(urls: urls)
        }
    }

    public func addImageAttachment(data: Data, fileName: String, mimeType: String) {
        self.beginAttachmentStaging()
        Task {
            defer { self.endAttachmentStaging() }
            await self.addImageAttachment(url: nil, data: data, fileName: fileName, mimeType: mimeType)
        }
    }

    public func removeAttachment(_ id: OpenClawPendingAttachment.ID) {
        self.attachments.removeAll { $0.id == id }
        self.applyDeferredExternalStateIfReady()
    }

    public var canSend: Bool {
        !self.isSubmittingDraft && !self.isSending && !self.hasBlockingRunActivity && self.hasDraftToSend
    }

    public var hasDraftToSend: Bool {
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty || !self.attachments.isEmpty
    }

    public var canSendDraft: Bool {
        !self.isSubmittingDraft && !self.isSending && self.hasDraftToSend
    }

    /// True while replacing this model could move an attachment across chats.
    public var isAttachmentOwnerPinned: Bool {
        self.blocksAttachmentOwnerChange
    }

    private var blocksAttachmentOwnerChange: Bool {
        self.attachmentOwnerIsActive() ||
            self.isSendingAttachmentDraft ||
            self.attachmentStagingCount > 0 ||
            !self.attachments.isEmpty
    }

    var hasBlockingRunActivity: Bool {
        self.pendingRunCount > 0 || self.hasActiveSessionRunWithoutChatSnapshot
    }

    /// Applies external owner changes once recording or staging releases them.
    public func attachmentOwnerActivityChanged() {
        self.applyDeferredExternalStateIfReady()
    }

    /// File reads and image processing suspend before the attachment exists.
    /// Keep their original chat owner pinned until staging succeeds or fails.
    func beginAttachmentStaging() {
        self.attachmentStagingCount += 1
    }

    func endAttachmentStaging() {
        precondition(self.attachmentStagingCount > 0)
        self.attachmentStagingCount -= 1
        self.applyDeferredExternalStateIfReady()
    }
}

extension OpenClawChatViewModel {
    // MARK: - Internals

    func markTimelineChanged() {
        self.timelineRevision &+= 1
    }

    func appendMessage(_ message: OpenClawChatMessage) {
        self.messages.append(message)
        self.markTimelineChanged()
    }

    func removeMessage(id: UUID) {
        let previousCount = self.messages.count
        self.messages.removeAll { $0.id == id }
        if self.messages.count != previousCount {
            self.markTimelineChanged()
        }
    }

    func updateStreamingAssistantText(_ text: String?) {
        guard self.streamingAssistantText != text else { return }
        self.streamingAssistantText = text
        self.markTimelineChanged()
    }

    func updateActiveSessionRunWithoutChatSnapshot(_ active: Bool) {
        guard self.hasActiveSessionRunWithoutChatSnapshot != active else { return }
        self.hasActiveSessionRunWithoutChatSnapshot = active
        if active {
            self.armActiveSessionRunIndicatorTimeout()
        } else {
            self.activeSessionRunIndicatorTimeoutTask?.cancel()
            self.activeSessionRunIndicatorTimeoutTask = nil
        }
        self.markTimelineChanged()
    }

    private func armActiveSessionRunIndicatorTimeout() {
        self.activeSessionRunIndicatorTimeoutTask?.cancel()
        let timeoutMs = self.pendingRunTimeoutMs
        self.activeSessionRunIndicatorTimeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
            } catch {
                return
            }
            await MainActor.run {
                self?.updateActiveSessionRunWithoutChatSnapshot(false)
            }
        }
    }

    func clearActiveSessionRunIndicatorIfLatestUserAnswered() {
        guard self.hasActiveSessionRunWithoutChatSnapshot,
              !Self.hasUnansweredLatestUser(in: self.messages)
        else { return }
        self.updateActiveSessionRunWithoutChatSnapshot(false)
    }

    func logDiagnostic(_ message: String) {
        self.diagnosticsLog?(message)
    }

    func currentSessionSnapshot() -> SessionSnapshot {
        SessionSnapshot(
            key: self.sessionKey,
            generation: self.sessionGeneration,
            agentID: self.activeAgentId,
            deliveryAgentID: Self.agentID(fromSessionKey: self.sessionKey) ?? self.activeAgentId,
            sessionRoutingContract: self.sessionRoutingContract)
    }

    func isCurrentSession(_ snapshot: SessionSnapshot) -> Bool {
        let contractSensitive = self.usesMutableContractRouting(for: snapshot.sessionRoutingContract) ||
            self.usesMutableContractRouting(for: self.sessionRoutingContract)
        return self.sessionKey == snapshot.key &&
            self.sessionGeneration == snapshot.generation &&
            (!self.usesMutableAgentRouting || self.activeAgentId == snapshot.agentID) &&
            (!contractSensitive || self.sessionRoutingContract == snapshot.sessionRoutingContract)
    }

    private func isCurrentBootstrap(_ context: BootstrapContext) -> Bool {
        self.bootstrapGeneration == context.id && self.isCurrentSession(context.session)
    }

    private func canApplyHistory(_ request: HistoryRequest) -> Bool {
        request.id >= self.latestAppliedHistoryRequestID &&
            self.isCurrentSession(request.session)
    }

    private func advanceSessionGeneration() {
        self.sessionGeneration &+= 1
    }

    func invalidateRunSnapshots() {
        self.runOwnershipGeneration &+= 1
    }

    func invalidateHistorySnapshots() {
        self.historyMutationGeneration &+= 1
    }

    func beginHistoryRequest(
        for sessionSnapshot: SessionSnapshot? = nil,
        captureLatestUserTurn: Bool = true) -> HistoryRequest
    {
        self.lastIssuedHistoryRequestID &+= 1
        return HistoryRequest(
            id: self.lastIssuedHistoryRequestID,
            session: sessionSnapshot ?? self.currentSessionSnapshot(),
            pendingRunIDs: self.pendingRuns,
            visibleMessagesByID: Dictionary(uniqueKeysWithValues: self.messages.map { ($0.id, $0) }),
            historyMutationGeneration: self.historyMutationGeneration,
            runOwnershipGeneration: self.runOwnershipGeneration,
            latestUserTurn: captureLatestUserTurn ? Self.latestUserTurn(in: self.messages) : nil)
    }

    private func markHistoryRequestApplied(_ request: HistoryRequest) {
        self.latestAppliedHistoryRequestID = max(self.latestAppliedHistoryRequestID, request.id)
    }

    @discardableResult
    func applyHistoryPayload(
        _ payload: OpenClawChatHistoryPayload,
        for request: HistoryRequest,
        preservingOptimisticLocalMessages: Bool,
        syncThinkingOptions: Bool = false) -> Bool
    {
        guard self.canApplyHistory(request) else { return false }
        let incoming = adoptingProvisionalFinalMessageIDs(
            in: Self.decodeMessages(payload.messages ?? []))
        let unmatchedProvisionalFinalIDs = Set(provisionalFinalMessagesMissing(from: incoming).map(\.id))
        var retainedMessageIDs = unmatchedProvisionalFinalIDs
        if request.historyMutationGeneration != self.historyMutationGeneration {
            for message in self.messages where request.visibleMessagesByID[message.id] != message {
                let isMatchedProvisional = self.provisionalFinalMessagesByID[message.id] != nil &&
                    !unmatchedProvisionalFinalIDs.contains(message.id)
                if !isMatchedProvisional {
                    retainedMessageIDs.insert(message.id)
                }
            }
        }
        // Durable outbox rows remain authoritative until canonical history
        // confirms their idempotency key. Keep their bubbles through lagging
        // snapshots, including across app relaunches and session switches.
        retainedMessageIDs.formUnion(self.outboxCommandIDsByMessageID.keys)
        var nextMessages = if preservingOptimisticLocalMessages {
            Self.reconcileRunRefreshMessages(
                previous: self.messages,
                incoming: incoming,
                pendingLocalUserEchoIDs: Set(self.pendingLocalUserEchoMessageIDsByRunID.values))
        } else {
            Self.reconcileMessageIDs(previous: self.messages, incoming: incoming)
        }
        let reconciledMessageIDs = Set(nextMessages.map(\.id))
        nextMessages.append(contentsOf: self.messages.filter { message in
            retainedMessageIDs.contains(message.id) && !reconciledMessageIDs.contains(message.id)
        })
        nextMessages = Self.dedupeMessages(nextMessages)
        replaceMessages(nextMessages)
        confirmOutboxCommands(in: incoming)
        prunePendingLocalUserEchoMessageIDs()
        clearProvisionalFinalMarkersAdoptedByHistory(incoming)
        pruneProvisionalFinalMessages()
        pruneRunMessageScopes()
        self.rescopeRunsAdoptedAfterHistoryRequest(request)
        self.sessionId = payload.sessionId
        self.applyInFlightRunSnapshot(payload.inFlightRun, for: request)
        // Incomplete refreshes can arrive before durable assistant history.
        // The latest visible user turn must survive answered before it can reject older replies.
        let canInvalidateOlderHistory = if let latestUserTurn = request.latestUserTurn {
            Self.hasAnsweredUser(latestUserTurn, in: self.messages)
        } else {
            !Self.hasUnansweredLatestUser(in: self.messages)
        }
        if canInvalidateOlderHistory {
            self.markHistoryRequestApplied(request)
        }
        self.clearActiveSessionRunIndicatorIfLatestUserAnswered()
        let appliedThinkingLevel = !self.prefersExplicitThinkingLevel
            ? Self.normalizedThinkingLevel(payload.thinkingLevel)
            : nil
        if let level = appliedThinkingLevel {
            self.thinkingLevel = level
        }
        if syncThinkingOptions || appliedThinkingLevel != nil {
            syncThinkingLevelOptions()
        }
        // Live history is the source of truth: it clears the cached marker and
        // is written through so the next cold open pre-paints current rows.
        self.hasAppliedLiveHistory = true
        self.isShowingCachedTranscript = false
        // An empty post-send refresh is incomplete by contract: reconciliation
        // preserves the visible transcript, so preserve its last canonical cache too.
        if !preservingOptimisticLocalMessages || !incoming.isEmpty {
            // Persist the reconciled transcript, including durable outbox
            // rows retained while canonical history catches up.
            persistTranscriptToCache(
                sessionKey: request.session.key,
                agentID: request.session.agentID,
                messages: nextMessages,
                canonicalMessageIdempotencyKeys: Set(incoming.compactMap(\.idempotencyKey)))
        }
        // Wholesale history replacement drops local-only queued bubbles;
        // re-adopt or re-append them from the durable outbox.
        restoreOutboxMessages(session: request.session)
        self.applyDeferredExternalStateIfReady()
        return true
    }

    private func provisionalFinalMessagesMissing(
        from incoming: [OpenClawChatMessage]) -> [OpenClawChatMessage]
    {
        let incomingRunIds = Set(incoming.compactMap { Self.normalizedIdempotencyKey($0.idempotencyKey) })
        return self.messages.filter { message in
            guard let provisional = provisionalFinalMessagesByID[message.id] else { return false }
            if let runId = provisional.runId, incomingRunIds.contains(runId) {
                return false
            }
            guard Self.containsUserTurn(provisional.scope.latestUserTurn, in: incoming) else {
                return true
            }
            let searchRange = Self.messageRange(after: provisional.scope.latestUserTurn, in: incoming)
            return !incoming[searchRange].contains { incomingMessage in
                Self.finalMessageReconciliationKey(for: incomingMessage) == provisional.reconciliationKey
            }
        }
    }

    private func rescopeRunsAdoptedAfterHistoryRequest(_ request: HistoryRequest) {
        for runId in self.pendingRuns {
            let scope = self.runMessageScopesByRunID[runId]
            if !request.pendingRunIDs.contains(runId) || scope?.latestUserTurn == nil {
                self.runMessageScopesByRunID[runId] = currentRunMessageScope()
            }
        }
    }

    private func applyInFlightRunSnapshot(
        _ snapshot: OpenClawChatInFlightRun?,
        for request: HistoryRequest)
    {
        guard request.runOwnershipGeneration == self.runOwnershipGeneration,
              request.id >= self.latestAppliedRunSnapshotRequestID
        else {
            return
        }
        self.latestAppliedRunSnapshotRequestID = request.id
        guard let snapshot,
              let runId = Self.normalizedRunID(snapshot.runId)
        else {
            return
        }

        self.isApplyingRunSnapshot = true
        defer { self.isApplyingRunSnapshot = false }
        self.updateActiveSessionRunWithoutChatSnapshot(false)
        self.adoptRun(runId: runId, bufferedText: snapshot.text)
    }

    func adoptRun(runId: String, bufferedText: String) {
        let canonicalPendingRuns = Set([runId])
        if self.pendingRuns != canonicalPendingRuns {
            // Gateway snapshots and live deltas are canonical for this session.
            // Replace stale local ownership so only that run consumes later events.
            self.clearPendingRuns(reason: nil)
            self.pendingRuns.insert(runId)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
        }
        if self.runMessageScopesByRunID[runId] == nil {
            self.runMessageScopesByRunID[runId] = currentRunMessageScope()
        }
        self.armPendingRunTimeout(runId: runId)
        if !bufferedText.isEmpty {
            self.updateStreamingAssistantText(bufferedText)
        }
        self.logDiagnostic(
            "chat.ui adopted in-flight run sessionKey=\(self.sessionKey) "
                + "runId=\(runId) bufferedTextLen=\(bufferedText.count)")
    }

    private func startBootstrap(sessionKey requestedSessionKey: String? = nil) {
        let sessionKey = requestedSessionKey ?? self.sessionKey
        guard sessionKey == self.sessionKey else { return }
        self.bootstrapGeneration &+= 1
        self.bootstrapTask?.cancel()
        self.isLoading = true
        self.errorText = nil
        self.healthOK = false
        self.clearPendingRuns(reason: nil)
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
        self.updateActiveSessionRunWithoutChatSnapshot(false)
        self.sessionId = nil
        let historyRequest = self.beginHistoryRequest(captureLatestUserTurn: requestedSessionKey == nil)
        let context = BootstrapContext(
            id: bootstrapGeneration,
            historyRequest: historyRequest)
        paintFromCacheIfNeeded(session: context.session)
        restoreOutboxMessages(session: context.session)
        self.bootstrapTask = Task { [weak self] in
            guard let self else { return }
            await self.bootstrap(context: context)
        }
    }

    private func bootstrap(context: BootstrapContext) async {
        guard self.isCurrentBootstrap(context) else { return }
        defer {
            if self.isCurrentBootstrap(context) {
                self.isLoading = false
            }
        }
        do {
            await self.syncActiveSessionSubscription(startingWith: context.session.key)
            guard self.isCurrentBootstrap(context) else { return }

            let payload = try await transport.requestHistory(sessionKey: context.session.key)
            guard self.isCurrentBootstrap(context) else { return }
            _ = self.applyHistoryPayload(
                payload,
                for: context.historyRequest,
                preservingOptimisticLocalMessages: false,
                syncThinkingOptions: true)
            await pollHealthIfNeeded(force: true, sessionSnapshot: context.session)
            guard self.isCurrentBootstrap(context) else { return }
            await self.fetchSessions(limit: 50, sessionSnapshot: context.session)
            guard self.isCurrentBootstrap(context) else { return }
            await self.fetchModels(sessionSnapshot: context.session)
            guard self.isCurrentBootstrap(context) else { return }
            self.errorText = nil
        } catch {
            guard self.isCurrentBootstrap(context) else { return }
            self.errorText = error.localizedDescription
            chatUILogger.error("bootstrap failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func syncActiveSessionSubscription(startingWith sessionKey: String) async {
        var nextSessionKey = sessionKey
        while true {
            do {
                // Subscribe requests are gateway side effects. If a stale request finishes
                // after a newer switch, immediately reassert the latest visible session.
                try await self.transport.setActiveSessionKey(nextSessionKey)
            } catch {
                let currentSessionKey = self.sessionKey
                guard currentSessionKey != nextSessionKey else {
                    // Best-effort only; history/send/health still work without push events.
                    return
                }
                nextSessionKey = currentSessionKey
                continue
            }
            let currentSessionKey = self.sessionKey
            guard currentSessionKey != nextSessionKey else { return }
            nextSessionKey = currentSessionKey
        }
    }

    private func refreshRunStateAfterForeground() async {
        let context = self.beginHistoryRequest()
        self.logDiagnostic(
            "chat.ui foreground refresh sessionKey=\(context.session.key) "
                + "pending=\(self.pendingRunCount)")
        let refresh = await refreshHistoryAfterRun(historyRequest: context)
        guard self.isCurrentSession(context.session) else { return }
        if refresh.applied,
           refresh.runSnapshotApplied,
           context.runOwnershipGeneration == self.runOwnershipGeneration,
           !self.isSending,
           refresh.supportsInFlightRunState,
           !refresh.hasInFlightRun
        {
            if refresh.sessionHasActiveRun,
               Self.hasUnansweredLatestUser(in: self.messages)
            {
                self.pendingToolCallsById = [:]
                self.updateStreamingAssistantText(nil)
                // Keep a known run ID authoritative so its stream and terminal
                // events still route here. Synthesize activity only after the
                // client has no run identity to preserve.
                self.updateActiveSessionRunWithoutChatSnapshot(self.pendingRuns.isEmpty)
            } else {
                self.updateActiveSessionRunWithoutChatSnapshot(false)
                self.clearPendingRuns(
                    reason: nil,
                    hapticEvent: self.assistantHapticEventAfterLatestUser())
                self.pendingToolCallsById = [:]
                self.updateStreamingAssistantText(nil)
            }
        }
        await pollHealthIfNeeded(force: true, sessionSnapshot: context.session)
    }

    private func performAbort() async {
        guard !self.pendingRuns.isEmpty else { return }
        guard !self.isAborting else { return }
        self.isAborting = true
        defer { self.isAborting = false }

        let runIds = Array(pendingRuns)
        for runId in runIds {
            do {
                try await self.transport.abortRun(sessionKey: self.sessionKey, runId: runId)
            } catch {
                // Best-effort.
            }
        }
    }

    func fetchSessions(limit: Int?, sessionSnapshot: SessionSnapshot? = nil) async {
        do {
            let res = try await transport.listSessions(limit: limit, search: nil, archived: false)
            if let sessionSnapshot, !self.isCurrentSession(sessionSnapshot) {
                return
            }
            let organized = OpenClawChatSessionListOrganizer.organize(res.sessions)
            self.sessions = organized
            self.sessionDefaults = res.defaults
            self.hasAppliedLiveSessions = true
            self.syncSelectedModel()
            syncThinkingLevelOptions()
            persistSessionsToCache(organized)
        } catch {
            // Best-effort.
        }
    }

    private func fetchModels(sessionSnapshot: SessionSnapshot? = nil) async {
        do {
            let modelChoices = try await transport.listModels()
            if let sessionSnapshot, !self.isCurrentSession(sessionSnapshot) {
                return
            }
            self.modelChoices = modelChoices
            self.syncSelectedModel()
            syncThinkingLevelOptions()
        } catch {
            // Best-effort.
        }
    }

    private func applySessionSwitch(to sessionKey: String, intent: SessionSwitchIntent) {
        let next = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return }
        guard next != self.sessionKey else {
            if intent == .externalSync {
                self.deferredExternalSessionKey = nil
            }
            return
        }
        if self.blocksAttachmentOwnerChange {
            switch intent {
            case .externalSync:
                self.deferredExternalSessionKey = next
            case .userInitiated:
                self.errorText = String(
                    localized: "Remove attachments or wait for delivery to resolve before switching chats.")
            }
            return
        }
        self.deferredExternalSessionKey = nil
        self.advanceSessionGeneration()
        self.sessionKey = next
        if intent == .userInitiated {
            self.onSessionChanged?(next)
        }
        self.clearSessionOwnedState()
        self.startBootstrap(sessionKey: next)
    }

    func applyDeferredExternalStateIfReady() {
        guard !self.blocksAttachmentOwnerChange else { return }
        if let identity = deferredDeliveryIdentity {
            self.deferredDeliveryIdentity = nil
            self.syncDeliveryIdentity(
                activeAgentId: identity.activeAgentID,
                sessionRoutingContract: identity.sessionRoutingContract)
        }
        guard let sessionKey = deferredExternalSessionKey else { return }
        self.deferredExternalSessionKey = nil
        self.applySessionSwitch(to: sessionKey, intent: .externalSync)
    }

    func performStartNewSession(worktree: Bool) async {
        guard !self.blocksAttachmentOwnerChange else {
            self.errorText = String(
                localized: "Remove attachments or wait for delivery to resolve before starting a new chat.")
            return
        }
        let requested = self.generatedNewSessionKey()
        let parentSessionKey = self.sessionKey
        let next: String
        do {
            let created = try await transport.createSession(
                key: requested,
                label: nil,
                parentSessionKey: parentSessionKey,
                worktree: worktree ? true : nil)
            let createdKey = created.key.trimmingCharacters(in: .whitespacesAndNewlines)
            next = createdKey.isEmpty ? requested : createdKey
        } catch {
            if Self.isUnsupportedCreateSessionError(error) {
                chatUILogger.info("sessions.create unsupported; falling back to sessions.reset")
                await self.performReset()
                return
            }
            chatUILogger.error("sessions.create failed \(error.localizedDescription, privacy: .public)")
            self.errorText = error.localizedDescription
            return
        }
        guard !self.blocksAttachmentOwnerChange else {
            self.errorText = String(
                localized: "Remove attachments or wait for delivery to resolve before starting a new chat.")
            return
        }
        self.advanceSessionGeneration()
        self.sessionKey = next
        self.onSessionChanged?(next)
        self.clearSessionOwnedState()
        self.errorText = nil
        self.startBootstrap()
    }

    /// Clears state owned by the current session/agent before a new identity can consume events.
    private func clearSessionOwnedState() {
        self.modelSelectionID = Self.defaultModelSelectionID
        replaceMessages([])
        self.isShowingCachedTranscript = false
        self.hasAppliedLiveHistory = false
        self.pendingLocalUserEchoMessageIDsByRunID.removeAll()
        self.runMessageScopesByRunID.removeAll()
        self.provisionalFinalMessagesByID.removeAll()
        resetOutboxPresentationForSessionSwitch()
        self.sessionId = nil
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
        self.updateActiveSessionRunWithoutChatSnapshot(false)
        self.resetSlashCommandCatalog()
        self.clearPendingRuns(reason: nil)
    }

    private static func isUnsupportedCreateSessionError(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == "OpenClawChatTransport"
            && nsError.localizedDescription == "sessions.create not supported by this transport"
    }

    func performReset() async {
        self.isLoading = true
        self.errorText = nil

        do {
            try await self.transport.resetSession(sessionKey: self.sessionKey)
        } catch {
            self.isLoading = false
            self.errorText = error.localizedDescription
            chatUILogger.error("session reset failed \(error.localizedDescription, privacy: .public)")
            return
        }

        self.runMessageScopesByRunID.removeAll()
        self.provisionalFinalMessagesByID.removeAll()
        self.startBootstrap()
    }

    func performCompact() async {
        guard !self.isCompacting else { return }
        guard !self.isSending, !self.hasBlockingRunActivity, !self.isAborting else {
            self.errorText = "Wait for the current response before compacting the session."
            return
        }
        if let lastCompactAt,
           Date().timeIntervalSince(lastCompactAt) < compactCooldown
        {
            self.errorText = "Please wait before compacting this session again."
            return
        }

        self.isCompacting = true
        self.isLoading = true
        self.errorText = nil
        defer {
            self.isCompacting = false
        }

        do {
            try await self.transport.compactSession(sessionKey: self.sessionKey)
        } catch {
            self.isLoading = false
            self.errorText = "Unable to compact the session. Please try again."
            let nsError = error as NSError
            chatUILogger.error(
                "compact failed domain=\(nsError.domain, privacy: .public) code=\(nsError.code, privacy: .public)")
            chatUILogger.error("compact details=\(String(describing: error), privacy: .private)")
            return
        }

        lastCompactAt = Date()
        self.startBootstrap()
    }

    private func performSelectThinkingLevel(_ level: String) async {
        let next = Self.normalizedThinkingLevel(level) ?? "off"
        guard next != self.thinkingLevel else { return }

        let sessionKey = self.sessionKey
        self.thinkingLevel = next
        syncThinkingLevelOptions()
        self.updateCurrentSessionThinkingLevel(next, sessionKey: sessionKey)
        self.onThinkingLevelChanged?(next)
        self.nextThinkingSelectionRequestID &+= 1
        let requestID = self.nextThinkingSelectionRequestID
        self.latestThinkingSelectionRequestIDsBySession[sessionKey] = requestID
        self.latestThinkingLevelsBySession[sessionKey] = next

        do {
            try await self.transport.setSessionThinking(sessionKey: sessionKey, thinkingLevel: next)
            guard requestID == self.latestThinkingSelectionRequestIDsBySession[sessionKey] else {
                let latest = self.latestThinkingLevelsBySession[sessionKey] ?? next
                guard latest != next else { return }
                try? await self.transport.setSessionThinking(sessionKey: sessionKey, thinkingLevel: latest)
                return
            }
        } catch {
            guard sessionKey == self.sessionKey,
                  requestID == self.latestThinkingSelectionRequestIDsBySession[sessionKey]
            else { return }
            // Best-effort. Persisting the user's local preference matters more than a patch error here.
        }
    }

    private func performSelectModel(_ selectionID: String) async {
        let next = self.normalizedSelectionID(selectionID)
        guard next != self.modelSelectionID else { return }

        let sessionKey = self.sessionKey
        let previous = self.modelSelectionID
        let previousRequestID = self.latestModelSelectionRequestIDsBySession[sessionKey]
        self.nextModelSelectionRequestID &+= 1
        let requestID = self.nextModelSelectionRequestID
        let nextModelRef = self.modelRef(forSelectionID: next)
        self.latestModelSelectionRequestIDsBySession[sessionKey] = requestID
        self.latestModelSelectionIDsBySession[sessionKey] = next
        self.beginModelPatch(for: sessionKey)
        self.modelSelectionID = next
        syncThinkingLevelOptions()
        self.errorText = nil
        defer { self.endModelPatch(for: sessionKey) }

        do {
            try await self.transport.setSessionModel(
                sessionKey: sessionKey,
                model: nextModelRef)
            guard requestID == self.latestModelSelectionRequestIDsBySession[sessionKey] else {
                // Keep older successful patches as rollback state, but do not replay
                // stale UI/session state over a newer in-flight or completed selection.
                self.lastSuccessfulModelSelectionIDsBySession[sessionKey] = next
                return
            }
            self.modelPickerStore.recordRecent(next)
            self.modelPickerRecents = self.modelPickerStore.recents
            self.applySuccessfulModelSelection(next, sessionKey: sessionKey, syncSelection: true)
        } catch {
            guard requestID == self.latestModelSelectionRequestIDsBySession[sessionKey] else { return }
            self.latestModelSelectionIDsBySession[sessionKey] = previous
            if let previousRequestID {
                self.latestModelSelectionRequestIDsBySession[sessionKey] = previousRequestID
            } else {
                self.latestModelSelectionRequestIDsBySession.removeValue(forKey: sessionKey)
            }
            if self.lastSuccessfulModelSelectionIDsBySession[sessionKey] == previous {
                self.applySuccessfulModelSelection(
                    previous,
                    sessionKey: sessionKey,
                    syncSelection: sessionKey == self.sessionKey)
            }
            guard sessionKey == self.sessionKey else { return }
            self.modelSelectionID = previous
            syncThinkingLevelOptions()
            self.errorText = error.localizedDescription
            chatUILogger.error("sessions.patch(model) failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func beginModelPatch(for sessionKey: String) {
        self.inFlightModelPatchCountsBySession[sessionKey, default: 0] += 1
    }

    private func endModelPatch(for sessionKey: String) {
        let remaining = max(0, (inFlightModelPatchCountsBySession[sessionKey] ?? 0) - 1)
        if remaining == 0 {
            self.inFlightModelPatchCountsBySession.removeValue(forKey: sessionKey)
            let waiters = self.modelPatchWaitersBySession.removeValue(forKey: sessionKey) ?? []
            for waiter in waiters {
                waiter.resume()
            }
            return
        }
        self.inFlightModelPatchCountsBySession[sessionKey] = remaining
    }

    /// Internal for the outbox flush, which must honor the same ordering
    /// behind in-flight model patches as the live send path.
    func waitForPendingModelPatches(in sessionKey: String) async {
        guard (self.inFlightModelPatchCountsBySession[sessionKey] ?? 0) > 0 else { return }
        await withCheckedContinuation { continuation in
            self.modelPatchWaitersBySession[sessionKey, default: []].append(continuation)
        }
    }

    func placeholderSession(key: String) -> OpenClawChatSessionEntry {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: nil,
            model: nil,
            contextTokens: nil)
    }

    private func syncSelectedModel() {
        let currentSession = self.sessions.first(where: { $0.key == self.sessionKey })
        let explicitModelID = self.normalizedModelSelectionID(
            currentSession?.model,
            provider: currentSession?.modelProvider)
        if let explicitModelID {
            self.lastSuccessfulModelSelectionIDsBySession[self.sessionKey] = explicitModelID
            self.modelSelectionID = explicitModelID
            return
        }
        self.lastSuccessfulModelSelectionIDsBySession[self.sessionKey] = Self.defaultModelSelectionID
        self.modelSelectionID = Self.defaultModelSelectionID
    }

    private func normalizedSelectionID(_ selectionID: String) -> String {
        let trimmed = selectionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return Self.defaultModelSelectionID }
        return trimmed
    }

    private func normalizedModelSelectionID(_ modelID: String?, provider: String? = nil) -> String? {
        guard let modelID else { return nil }
        let trimmed = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let provider = Self.normalizedProvider(provider) {
            let providerQualified = Self.providerQualifiedModelSelectionID(modelID: trimmed, provider: provider)
            if let match = modelChoices.first(where: {
                $0.selectionID == providerQualified ||
                    ($0.modelID == trimmed && Self.normalizedProvider($0.provider) == provider)
            }) {
                return match.selectionID
            }
            return providerQualified
        }
        if self.modelChoices.contains(where: { $0.selectionID == trimmed }) {
            return trimmed
        }
        let matches = self.modelChoices.filter { $0.modelID == trimmed || $0.selectionID == trimmed }
        if matches.count == 1 {
            return matches[0].selectionID
        }
        return trimmed
    }

    private func modelRef(forSelectionID selectionID: String) -> String? {
        let normalized = self.normalizedSelectionID(selectionID)
        if normalized == Self.defaultModelSelectionID {
            return nil
        }
        return normalized
    }

    private func generatedNewSessionKey() -> String {
        let baseKey = "ios-\(UUID().uuidString.lowercased())"
        guard let agentID = Self.agentID(fromSessionKey: sessionKey) ??
            activeAgentId ??
            Self.agentID(fromSessionKey: resolvedMainSessionKey) ??
            sessions.lazy.compactMap({ Self.agentID(fromSessionKey: $0.key) }).first
        else {
            return baseKey
        }
        return "agent:\(agentID):\(baseKey)"
    }

    static func agentID(fromSessionKey sessionKey: String) -> String? {
        let parts = sessionKey
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else { return nil }
        let agentID = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        return agentID.isEmpty ? nil : agentID
    }

    private func modelLabel(for modelID: String) -> String {
        self.modelChoices.first(where: { $0.selectionID == modelID || $0.modelID == modelID })?.displayLabel ??
            modelID
    }

    private func applySuccessfulModelSelection(_ selectionID: String, sessionKey: String, syncSelection: Bool) {
        self.lastSuccessfulModelSelectionIDsBySession[sessionKey] = selectionID
        let resolved = self.resolvedSessionModelIdentity(forSelectionID: selectionID)
        self.updateCurrentSessionModel(
            modelID: resolved.modelID,
            modelProvider: resolved.modelProvider,
            sessionKey: sessionKey,
            syncSelection: syncSelection)
        if sessionKey == self.sessionKey {
            syncThinkingLevelOptions()
        }
    }

    private func resolvedSessionModelIdentity(forSelectionID selectionID: String)
        -> (modelID: String?, modelProvider: String?)
    {
        guard let modelRef = modelRef(forSelectionID: selectionID) else {
            return (nil, nil)
        }
        if let choice = modelChoices.first(where: { $0.selectionID == modelRef }) {
            return (choice.modelID, Self.normalizedProvider(choice.provider))
        }
        return (modelRef, nil)
    }

    private static func normalizedProvider(_ provider: String?) -> String? {
        self.normalizedModelIdentityComponent(provider)
    }

    private static func normalizedModelIdentityComponent(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private static func providerQualifiedModelSelectionID(modelID: String, provider: String) -> String {
        let providerPrefix = "\(provider)/"
        if modelID.hasPrefix(providerPrefix) {
            return modelID
        }
        return "\(provider)/\(modelID)"
    }

    private func updateCurrentSessionThinkingLevel(_ thinkingLevel: String?, sessionKey: String) {
        guard let index = sessions.firstIndex(where: { $0.key == sessionKey }) else { return }
        self.sessions[index].thinkingLevel = thinkingLevel
    }

    private func updateCurrentSessionModel(
        modelID: String?,
        modelProvider: String?,
        sessionKey: String,
        syncSelection: Bool)
    {
        var updated = self.sessions.first(where: { $0.key == sessionKey })
            ?? self.placeholderSession(key: sessionKey)
        // Thinking metadata follows model identity; stale options must not survive a model change.
        let preservesThinkingMetadata =
            Self.normalizedModelIdentityComponent(updated.model) ==
            Self.normalizedModelIdentityComponent(modelID) &&
            Self.normalizedModelIdentityComponent(updated.modelProvider) ==
            Self.normalizedModelIdentityComponent(modelProvider)
        updated.modelProvider = modelProvider
        updated.model = modelID
        if !preservesThinkingMetadata {
            updated.thinkingLevels = nil
            updated.thinkingOptions = nil
            updated.thinkingDefault = nil
        }
        if let index = sessions.firstIndex(where: { $0.key == sessionKey }) {
            self.sessions[index] = updated
        } else {
            self.sessions.append(updated)
        }
        if syncSelection {
            self.syncSelectedModel()
        }
    }
}
