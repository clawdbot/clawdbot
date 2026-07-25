import Foundation
import Observation
import OpenClawKit
import OSLog

// Module-internal: ChatViewModel extension files share this logger.
let chatUILogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatUI")

@MainActor
@Observable
public final class OpenClawChatViewModel {
    public nonisolated static let defaultModelSelectionID = "__default__"
    public nonisolated static let inheritedThinkingSelectionID = "__inherited__"
    static let maxAttachmentBytes = 5_000_000
    static let sessionListFetchLimit = 200

    public internal(set) var messages: [OpenClawChatMessage] = []

    public var input: String = "" {
        didSet {
            guard self.input != oldValue else { return }
            self.noteComposerInputChanged()
        }
    }

    public internal(set) var replyTarget: OpenClawChatReplyTarget?
    @ObservationIgnored
    var inputHistoriesBySession: [String: ChatInputHistory] = [:]
    /// Unlike web persistence, native drafts stay in memory. Attachments are excluded because
    /// the staging guard prevents session switches while they are being prepared.
    @ObservationIgnored
    var draftsBySession: [String: String] = [:]
    @ObservationIgnored
    var composerRevisionsBySession: [String: UInt64] = [:]
    @ObservationIgnored
    var savedDraftRevisionsBySession: [String: UInt64] = [:]
    @ObservationIgnored
    var isApplyingRecalledInput = false
    /// Setter is module-internal for the thinking-level extension only.
    public internal(set) var thinkingLevel: String
    /// User intent stays stable while `thinkingLevel` follows the selected model's advertised levels.
    var preferredThinkingLevel: String
    /// Setter is module-internal for the thinking-level extension only.
    public internal(set) var thinkingLevelOptions: [OpenClawChatThinkingLevelOption]
    /// Setter is module-internal for the thinking-level extension only.
    public internal(set) var showsThinkingPicker = true
    public internal(set) var preferredVerboseLevel: String
    var prefersExplicitVerboseLevel: Bool
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
    var attachmentStagingCount = 0
    public private(set) var isAborting = false
    public var errorText: String?
    public var attachments: [OpenClawPendingAttachment] = []
    /// Setter is module-internal for the health/outbox extension only.
    public internal(set) var healthOK: Bool = false
    /// Bumped after every successful group-catalog mutation so views keyed on it
    /// refetch; catalog-only changes (e.g. creating an empty group) alter no
    /// session rows and would otherwise stay stale until reconnect.
    public internal(set) var sessionGroupsRevision = 0
    public internal(set) var sessionBranches: [OpenClawChatSessionBranch] = []
    public internal(set) var isLoadingSessionBranches = false
    @ObservationIgnored
    var sessionBranchesRefreshGeneration: UInt64 = 0
    struct SessionBranchSwitchActivity: Equatable {
        let session: SessionSnapshot
        let generation: UInt64
    }

    var sessionBranchSwitchActivity: SessionBranchSwitchActivity?
    @ObservationIgnored
    var nextSessionBranchSwitchGeneration: UInt64 = 0

    var isSwitchingSessionBranch: Bool {
        self.sessionBranchSwitchActivity != nil
    }

    /// True when this view model owns a gateway-scoped durable text outbox.
    public var supportsOfflineTextOutbox: Bool {
        self.outbox != nil
    }

    public private(set) var pendingRunCount: Int = 0
    public internal(set) var questionCards: [OpenClawQuestionCardModel] = []
    var questionRefreshGeneration: UInt64 = 0
    var questionStateRevision: UInt64 = 0
    var questionExpiryTasks: [String: Task<Void, Never>] = [:]
    var questionExpiryDeadlines: [String: Date] = [:]
    var questionRefreshRetryTask: Task<Void, Never>?
    var questionRefreshRetryDelaysMs: [Int64] = [1000, 2000, 4000]
    var hasActiveSessionRunWithoutChatSnapshot = false

    public private(set) var sessionKey: String {
        didSet { syncContextUsageFraction() }
    }

    public internal(set) var sessionId: String?
    public private(set) var streamingAssistantText: String?

    public private(set) var pendingToolCalls: [OpenClawChatPendingToolCall] = []
    public internal(set) var planSteps: [OpenClawChatPlanStep] = []
    public internal(set) var planExplanation: String?
    var planRunId: String?

    private(set) var timelineRevision: UInt64 = 0
    /// Setter is module-internal for the transcript-cache extension only.
    public internal(set) var sessions: [OpenClawChatSessionEntry] = [] {
        didSet { syncContextUsageFraction() }
    }

    public internal(set) var contextUsageFraction: Double?
    /// True while the visible transcript came from the offline cache and no
    /// live history response has replaced it yet (possibly stale).
    public internal(set) var isShowingCachedTranscript = false
    /// Guard the cache pre-paint: once a live response applied (even an empty
    /// one), a slow cache read must never paint stale rows over it.
    var hasAppliedLiveHistory = false
    var hasAppliedLiveSessions = false
    @ObservationIgnored
    var unreadPatchGuard = ChatSessionUnreadPatchGuard()
    let unreadMutationQueue = ChatSessionUnreadMutationQueue()
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
    @ObservationIgnored
    var outboxFailureVersionsByMessageID: [
        UUID: (attemptVersion: Int, retryCount: Int, lastError: String?)
    ] = [:]
    /// Recent canonical keys let the MainActor resolve proof that arrives
    /// after SQLite cancellation commits but before its UI continuation runs.
    @ObservationIgnored
    var canonicalOutboxMessageKeys: [String] = []
    @ObservationIgnored
    var isFlushingOutbox = false
    @ObservationIgnored
    var isOutboxFlushRequestedWhileActive = false
    @ObservationIgnored
    var reconciledOutboxBranchScopes: Set<OpenClawChatOutboxScope> = []
    @ObservationIgnored
    var reconcilingOutboxBranchScopes: Set<OpenClawChatOutboxScope> = []
    @ObservationIgnored
    var outboxBranchReconcileRetryAttempts: [OpenClawChatOutboxScope: Int] = [:]
    @ObservationIgnored
    var outboxBranchReconcileRetryTasks: [OpenClawChatOutboxScope: Task<Void, Never>] = [:]
    @ObservationIgnored
    var outboxBranchConnectionGeneration: UInt64 = 0
    @ObservationIgnored
    var bootstrapOutboxBranchStateCapture: (
        generation: UInt64,
        session: SessionSnapshot,
        task: Task<OpenClawChatOutboxBranchState?, Never>)?
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
        didSet { syncContextUsageFraction() }
    }

    var prefersExplicitThinkingLevel: Bool
    private let onSessionChanged: (@MainActor (String) -> Void)?
    let onThinkingLevelChanged: (@MainActor @Sendable (String) -> Void)?
    let onThinkingPreferenceChanged: (@MainActor @Sendable (String?) -> Void)?
    let onVerboseLevelChanged: (@MainActor @Sendable (String) -> Void)?
    let onVerbosePreferenceChanged: (@MainActor @Sendable (String?) -> Void)?
    private let diagnosticsLog: (@MainActor @Sendable (String) -> Void)?
    let onToolActivity: OpenClawChatToolActivityHandler?
    let attachmentOwnerIsActive: @MainActor () -> Bool

    @ObservationIgnored
    private nonisolated(unsafe) var eventTask: Task<Void, Never>?
    @ObservationIgnored
    private nonisolated(unsafe) var bootstrapTask: Task<Void, Never>?
    var runOwnershipGeneration: UInt64 = 0
    var latestAppliedRunSnapshotRequestID: UInt64 = 0
    var isApplyingRunSnapshot = false
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
    var sessionGeneration: UInt64 = 0
    private var bootstrapGeneration: UInt64 = 0
    // A newer same-session history request only invalidates older responses after it applies.
    // Failed later refreshes must not drop the last successful pending-run history payload.
    var lastIssuedHistoryRequestID: UInt64 = 0
    var latestAppliedHistoryRequestID: UInt64 = 0
    var historyMutationGeneration: UInt64 = 0
    private var nextSessionsFetchRequestID: UInt64 = 0
    private var latestAppliedSessionsFetchRequestID: UInt64 = 0
    /// Outbox replay waits for a sessions list from the current connection generation.
    var sessionMetadataGeneration: UInt64 = 0
    var readySessionMetadataGeneration: UInt64?

    @ObservationIgnored
    nonisolated(unsafe) var pendingRunOwnerTasks: [String: Task<Void, Never>] = [:]
    var nextPendingRunOwnerArmID: UInt64 = 0
    var pendingRunOwnerArmIDs: [String: UInt64] = [:]
    @ObservationIgnored
    nonisolated(unsafe) var activeSessionRunIndicatorTimeoutTask: Task<Void, Never>?
    var pendingRunWaitTimeoutMs: UInt64 = 120_000
    var pendingRunUnavailableRetryMs: UInt64 = 30000
    var pendingRunTerminalRetryMs: UInt64 = 2000
    var pendingRunTerminalHistoryGraceMs: UInt64 = 10000
    var pendingRunRefreshDelaysMs: [UInt64] = [
        1500,
        4000,
        9000,
        20000,
        45000,
    ]
    var pendingRunSteadyRefreshDelayMs: UInt64 = 60000
    // Session switches can overlap in-flight picker patches, so stale completions
    // must compare against the latest request and latest desired value for that session.
    private var nextSessionSettingsRequestID: UInt64 = 0
    private var latestModelSelectionRequestIDsByTarget: [ModelPatchTarget: UInt64] = [:]
    private var lastSuccessfulModelSelectionIDsByTarget: [ModelPatchTarget: String] = [:]
    var lastSuccessfulSettingsPatchRequestIDsByTarget: [ModelPatchTarget: UInt64] = [:]
    /// Rollback and pre-refresh sends need the authoritative state from the latest settings patch.
    var lastSuccessfulSettingsPatchResultsByTarget: [ModelPatchTarget: OpenClawChatModelPatchResult] = [:]
    var completedModelPatchTargets: Set<ModelPatchTarget> = []
    var inFlightSettingsPatchCountsByTarget: [ModelPatchTarget: Int] = [:]
    private var settingsPatchRevisionsByTarget: [ModelPatchTarget: UInt64] = [:]
    private var settingsPatchWaitersByTarget: [ModelPatchTarget: [CheckedContinuation<Void, Never>]] = [:]
    @ObservationIgnored
    private var settingsPatchTailsByTarget: [ModelPatchTarget: SettingsPatchTail] = [:]
    var nextThinkingSelectionRequestID: UInt64 = 0
    var latestThinkingSelectionRequestIDsByTarget: [ModelPatchTarget: UInt64] = [:]
    var confirmedThinkingPreference: ThinkingPreferenceState
    var emittedThinkingPreference: ThinkingPreferenceState
    var thinkingPreferenceRequests: [UInt64: ThinkingPreferenceRequest] = [:]
    var nextVerboseSelectionRequestID: UInt64 = 0
    var confirmedVerbosePreference: VerbosePreferenceState
    var emittedVerbosePreference: VerbosePreferenceState
    var verbosePreferenceRequests: [UInt64: VerbosePreferenceRequest] = [:]
    var acceptedVerboseLevelsByTarget: [ModelPatchTarget: VerboseLevelState] = [:]
    var acceptedFastModesByTarget: [ModelPatchTarget: FastModeState] = [:]
    var lastSuccessfulThinkingOverrideClearedByTarget: [ModelPatchTarget: Bool] = [:]
    var lastSuccessfulFastOverrideClearedByTarget: [ModelPatchTarget: Bool] = [:]
    var lastSuccessfulVerboseOverrideClearedByTarget: [ModelPatchTarget: Bool] = [:]
    var acceptedSettingsPatchResultsByTarget: [ModelPatchTarget: OpenClawChatModelPatchResult] = [:]
    var acceptedThinkingLevelsByTarget: [ModelPatchTarget: String] = [:]
    var acceptedPreferredThinkingLevelsByTarget: [ModelPatchTarget: String] = [:]
    var acceptedExplicitThinkingPreferencesByTarget: [ModelPatchTarget: Bool] = [:]
    var acceptedThinkingOverrideClearedByTarget: [ModelPatchTarget: Bool] = [:]
    private var isCompacting = false
    private var lastCompactAt: Date?
    private let compactCooldown: TimeInterval = 60

    private enum SessionSwitchIntent {
        case userInitiated
        case externalSync
    }

    struct ModelPatchTarget: Hashable {
        let canonicalSessionKey: String
        let agentID: String?
        let sessionRoutingContract: String?
    }

    struct VerbosePreferenceState: Equatable {
        let level: String
        let isExplicit: Bool
    }

    enum VerbosePreferenceRequest {
        case pending(VerbosePreferenceState)
        case succeeded(VerbosePreferenceState)
        case failed
    }

    struct ThinkingPreferenceState: Equatable {
        let level: String
        let isExplicit: Bool
    }

    enum ThinkingPreferenceRequest {
        case pending(ThinkingPreferenceState)
        case succeeded(ThinkingPreferenceState)
        case failed
    }

    enum VerboseLevelState {
        case none
        case value(String)

        var level: String? {
            if case let .value(level) = self { return level }
            return nil
        }
    }

    struct FastModeState {
        let override: OpenClawChatFastMode?
        let effective: OpenClawChatFastMode?
    }

    private struct ModelSelectionRequest {
        let id: UInt64
        let target: ModelPatchTarget
        let session: SessionSnapshot
        let sessionEntryKey: String?
        let rollbackSelectionID: String
        let previousRequestID: UInt64?
        let selectionID: String
        let modelRef: String?
    }

    private struct SettingsPatchTail {
        let requestID: UInt64
        let routeLeaseTask: Task<OpenClawChatSessionSettingsRouteLease?, Never>
        let task: Task<Void, Never>
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
            reportToolActivityChanges(from: oldValue, to: self.pendingToolCallsById)
            self.pendingToolCalls = self.pendingToolCallsById.values
                .sorted { ($0.startedAt ?? 0) < ($1.startedAt ?? 0) }
            markTimelineChanged()
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
        initialVerboseLevel: String? = nil,
        onSessionChanged: (@MainActor (String) -> Void)? = nil,
        onThinkingLevelChanged: (@MainActor @Sendable (String) -> Void)? = nil,
        onToolActivity: OpenClawChatToolActivityHandler? = nil,
        onThinkingPreferenceChanged: (@MainActor @Sendable (String?) -> Void)? = nil,
        onVerboseLevelChanged: (@MainActor @Sendable (String) -> Void)? = nil,
        onVerbosePreferenceChanged: (@MainActor @Sendable (String?) -> Void)? = nil,
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
        self.preferredThinkingLevel = initialResolvedThinkingLevel
        self.thinkingLevelOptions = Self.withCurrentThinkingOption(
            Self.baseThinkingLevelOptions,
            current: initialResolvedThinkingLevel)
        self.prefersExplicitThinkingLevel = normalizedThinkingLevel != nil
        let initialThinkingPreference = ThinkingPreferenceState(
            level: initialResolvedThinkingLevel,
            isExplicit: normalizedThinkingLevel != nil)
        self.confirmedThinkingPreference = initialThinkingPreference
        self.emittedThinkingPreference = initialThinkingPreference
        let normalizedVerboseLevel = Self.normalizedVerboseLevel(initialVerboseLevel)
        let initialResolvedVerboseLevel = normalizedVerboseLevel ?? "off"
        self.preferredVerboseLevel = initialResolvedVerboseLevel
        self.prefersExplicitVerboseLevel = normalizedVerboseLevel != nil
        let initialVerbosePreference = VerbosePreferenceState(
            level: initialResolvedVerboseLevel,
            isExplicit: normalizedVerboseLevel != nil)
        self.confirmedVerbosePreference = initialVerbosePreference
        self.emittedVerbosePreference = initialVerbosePreference
        self.onSessionChanged = onSessionChanged
        self.onThinkingLevelChanged = onThinkingLevelChanged
        self.onToolActivity = onToolActivity
        self.onThinkingPreferenceChanged = onThinkingPreferenceChanged
        self.onVerboseLevelChanged = onVerboseLevelChanged
        self.onVerbosePreferenceChanged = onVerbosePreferenceChanged
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

    isolated deinit {
        self.reportToolActivityChanges(from: self.pendingToolCallsById, to: [:])
        self.eventTask?.cancel()
        self.bootstrapTask?.cancel()
        self.outboxRetryTask?.cancel()
        for task in self.outboxBranchReconcileRetryTasks.values {
            task.cancel()
        }
        self.outboxChangesTask?.cancel()
        self.activeSessionRunIndicatorTimeoutTask?.cancel()
        self.questionRefreshRetryTask?.cancel()
        for (_, task) in self.questionExpiryTasks {
            task.cancel()
        }
        for (_, task) in self.pendingRunOwnerTasks {
            task.cancel()
        }
    }

    public func load() {
        startBootstrap()
    }

    public func refresh() {
        startBootstrap()
    }

    public var modelPickerSections: ChatModelPickerSections {
        let defaultProvider = ChatModelPickerStore.resolvedDefaultProvider(
            provider: self.sessionDefaults?.modelProvider,
            model: self.sessionDefaults?.model)
        return ChatModelPickerStore.sections(
            choices: self.modelChoices,
            favorites: self.modelPickerFavorites,
            recents: self.modelPickerRecents,
            defaultProvider: defaultProvider)
    }

    public func isDefaultModel(_ model: OpenClawChatModelChoice) -> Bool {
        ChatModelPickerStore.isDefaultModel(
            model,
            defaultProvider: self.sessionDefaults?.modelProvider,
            defaultModel: self.sessionDefaults?.model)
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
        applySessionSwitch(to: sessionKey, intent: .userInitiated)
    }

    public func syncSession(to sessionKey: String) {
        applySessionSwitch(to: sessionKey, intent: .externalSync)
    }

    // periphery:ignore - package tests vary one identity field while preserving the current routing contract.
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
            if blocksAttachmentOwnerChange {
                self.deferredDeliveryIdentity = nil
            }
            return
        }
        if blocksAttachmentOwnerChange {
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
                reconcilePendingOutboxBranchScopes()
            }
            return
        }
        // Restart when this key depends on a changed routing value so cleared
        // state cannot remain stuck or cross session owners.
        advanceSessionGeneration()
        clearSessionOwnedState()
        startBootstrap()
    }

    public func selectThinkingLevel(_ level: String) {
        performSelectThinkingLevel(level)
    }

    public func selectVerboseLevel(_ level: String) {
        performSelectVerboseLevel(level)
    }

    public func selectFastMode(_ selectionID: String) {
        performSelectFastMode(selectionID)
    }

    public func selectModel(_ selectionID: String) {
        guard let request = reserveModelSelection(selectionID) else { return }
        enqueueSessionSettingsPatch(requestID: request.id, target: request.target) { [weak self] routeLease in
            guard let self else { return }
            await self.performSelectModel(request, routeLease: routeLease)
        }
    }

    var resolvedMainSessionKey: String {
        let trimmed = self.sessionDefaults?.mainSessionKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false ? trimmed : nil) ?? "main"
    }

    private var usesMutableAgentRouting: Bool {
        OpenClawChatSessionKey.agentID(from: self.sessionKey) == nil
    }

    private func usesMutableContractRouting(for contract: String?) -> Bool {
        self.usesMutableContractRouting(sessionKey: self.sessionKey, contract: contract)
    }

    func usesMutableContractRouting(sessionKey: String, contract: String?) -> Bool {
        if OpenClawChatSessionKey.agentID(from: sessionKey) == nil {
            return true
        }
        let parts = sessionKey
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
        return "Default: \(modelLabel(for: defaultModelID))"
    }

    static let baseThinkingLevelOptions: [OpenClawChatThinkingLevelOption] = [
        OpenClawChatThinkingLevelOption(id: "off", label: "off"),
        OpenClawChatThinkingLevelOption(id: "minimal", label: "minimal"),
        OpenClawChatThinkingLevelOption(id: "low", label: "low"),
        OpenClawChatThinkingLevelOption(id: "medium", label: "medium"),
        OpenClawChatThinkingLevelOption(id: "high", label: "high"),
    ]
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

    func logDiagnostic(_ message: String) {
        self.diagnosticsLog?(message)
    }

    func currentSessionSnapshot() -> SessionSnapshot {
        SessionSnapshot(
            key: self.sessionKey,
            generation: self.sessionGeneration,
            agentID: self.activeAgentId,
            deliveryAgentID: OpenClawChatSessionKey.agentID(from: self.sessionKey) ?? self.activeAgentId,
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

    func beginSessionBranchSwitchActivity(for session: SessionSnapshot) -> SessionBranchSwitchActivity {
        self.nextSessionBranchSwitchGeneration &+= 1
        let activity = SessionBranchSwitchActivity(
            session: session,
            generation: self.nextSessionBranchSwitchGeneration)
        self.sessionBranchSwitchActivity = activity
        return activity
    }

    func isCurrentSessionBranchSwitchActivity(_ activity: SessionBranchSwitchActivity) -> Bool {
        self.sessionBranchSwitchActivity == activity && self.isCurrentSession(activity.session)
    }

    func endSessionBranchSwitchActivity(_ activity: SessionBranchSwitchActivity) {
        guard self.isCurrentSessionBranchSwitchActivity(activity) else { return }
        self.sessionBranchSwitchActivity = nil
        self.flushOutboxIfNeeded()
    }

    func reconcileSessionBranchChange(
        _ activity: SessionBranchSwitchActivity,
        confirmedLeafEntryID: String? = nil,
        confirmFromBranchRefresh: Bool = false) async
    {
        var stateApplied = true
        if let confirmedLeafEntryID {
            stateApplied = await self.confirmOutboxBranchChange(
                activity.session,
                activeLeafEntryID: confirmedLeafEntryID)
            if !stateApplied {
                await self.recoverOutboxAfterSessionMutationRefreshFailure(
                    activity.session,
                    branchingUnsupported: false)
            }
        } else if confirmFromBranchRefresh {
            stateApplied = await self.refreshSessionBranches(confirmingBranchChange: true)
        }
        guard self.isCurrentSessionBranchSwitchActivity(activity) else { return }
        if stateApplied {
            for _ in 0..<2 {
                stateApplied = await self.refreshHistoryAfterRun(
                    historyRequest: self.beginHistoryRequest(for: activity.session)).applied
                guard self.isCurrentSessionBranchSwitchActivity(activity) else { return }
                if stateApplied { break }
            }
        }
        if stateApplied, !confirmFromBranchRefresh {
            stateApplied = await self.refreshSessionBranches()
        }
        guard self.isCurrentSessionBranchSwitchActivity(activity) else { return }
        guard stateApplied else {
            // After the server-side branch changes, never keep partially consistent local state.
            // Either install the new state completely or reload the session from scratch.
            self.advanceSessionGeneration()
            self.clearSessionOwnedState()
            self.startBootstrap(paintCachedTranscript: false)
            return
        }
        self.errorText = nil
    }

    private func isCurrentBootstrap(_ context: BootstrapContext) -> Bool {
        self.bootstrapGeneration == context.id && self.isCurrentSession(context.session)
    }

    private func startBootstrap(
        sessionKey requestedSessionKey: String? = nil,
        paintCachedTranscript: Bool = true)
    {
        let sessionKey = requestedSessionKey ?? self.sessionKey
        guard sessionKey == self.sessionKey else { return }
        self.unreadPatchGuard.activate(key: self.sessionMutationIdentity(for: sessionKey))
        self.bootstrapGeneration &+= 1
        self.bootstrapTask?.cancel()
        self.isLoading = true
        self.errorText = nil
        self.invalidateSessionMetadataReadiness()
        self.invalidateOutboxBranchReconciliation()
        self.healthOK = false
        clearPendingRuns(reason: nil)
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
        clearPlan()
        self.updateActiveSessionRunWithoutChatSnapshot(false)
        self.sessionId = nil
        let historyRequest = self.beginHistoryRequest(captureLatestUserTurn: requestedSessionKey == nil)
        let context = BootstrapContext(
            id: bootstrapGeneration,
            historyRequest: historyRequest)
        let captureTask = Task { [weak self] in
            await self?.captureOutboxBranchState(for: context.session)
        }
        self.bootstrapOutboxBranchStateCapture = (
            generation: context.id,
            session: context.session,
            task: captureTask)
        self.pauseOutboxBranchScope(context.session)
        if paintCachedTranscript {
            paintFromCacheIfNeeded(session: context.session)
        }
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
            guard let capture = self.bootstrapOutboxBranchStateCapture,
                  capture.generation == context.id
            else { return }
            let preBootstrapBranchState = await capture.task.value
            guard self.isCurrentBootstrap(context) else { return }
            async let branchRefresh = self.refreshSessionBranches(
                for: context.session,
                preBootstrapBranchState: preBootstrapBranchState)

            await self.syncActiveSessionSubscription(startingWith: context.session.key)
            guard self.isCurrentBootstrap(context) else { return }

            Task { [weak self] in await self?.refreshQuestions() }

            let payload = try await transport.requestHistory(sessionKey: context.session.key)
            guard self.isCurrentBootstrap(context) else { return }
            _ = self.applyHistoryPayload(
                payload,
                for: context.historyRequest,
                preservingOptimisticLocalMessages: false,
                syncThinkingOptions: true)
            _ = await branchRefresh
            guard self.isCurrentBootstrap(context) else { return }
            await pollHealthIfNeeded(
                force: true,
                sessionSnapshot: context.session,
                refreshSessionsOnReconnect: false)
            guard self.isCurrentBootstrap(context) else { return }
            // A sidebar-selected row can sit outside the bootstrap's 50-row refresh.
            // Retain its unread metadata until activation acknowledgement finishes.
            let activationEntry = self.currentSessionEntry()
            await self.fetchSessions(limit: 50, sessionSnapshot: context.session)
            guard self.isCurrentBootstrap(context) else { return }
            await self.markCurrentSessionReadAfterActivation(
                context.session,
                fallbackEntry: activationEntry)
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
                clearPlan()
                // Keep a known run ID authoritative so its stream and terminal
                // events still route here. Synthesize activity only after the
                // client has no run identity to preserve.
                self.updateActiveSessionRunWithoutChatSnapshot(self.pendingRuns.isEmpty)
            } else {
                self.updateActiveSessionRunWithoutChatSnapshot(false)
                clearPendingRuns(
                    reason: nil,
                    hapticEvent: assistantHapticEventAfterLatestUser())
                self.pendingToolCallsById = [:]
                self.updateStreamingAssistantText(nil)
                clearPlan()
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
        self.nextSessionsFetchRequestID &+= 1
        let sessionsFetchRequestID = self.nextSessionsFetchRequestID
        let session = sessionSnapshot ?? self.currentSessionSnapshot()
        let target = modelPatchTarget(
            sessionKey: session.key,
            canonicalSessionKey: self.isCurrentSession(session) ? currentSessionEntry()?.key : nil,
            agentID: session.deliveryAgentID,
            sessionRoutingContract: session.sessionRoutingContract)
        var overlappingSuccessfulSettingsPatchRequestID: UInt64?
        // Request IDs start at one, so zero represents no earlier success.
        var pendingSettingsPatchOverlapBaseline: UInt64?
        while true {
            await self.waitForPendingSessionSettings(for: target)
            if let pendingBaseline = pendingSettingsPatchOverlapBaseline {
                let completedRequestID = self.lastSuccessfulSettingsPatchRequestIDsByTarget[target] ?? 0
                if completedRequestID != pendingBaseline {
                    overlappingSuccessfulSettingsPatchRequestID = completedRequestID
                }
                pendingSettingsPatchOverlapBaseline = nil
            }
            if let sessionSnapshot, !self.isCurrentSession(sessionSnapshot) {
                return
            }
            let metadataGeneration = self.sessionMetadataGeneration
            let settingsPatchRevision = self.settingsPatchRevisionsByTarget[target, default: 0]
            let successfulSettingsPatchRequestID = self.lastSuccessfulSettingsPatchRequestIDsByTarget[target]
            let res: OpenClawChatSessionsListResponse
            do {
                res = try await self.transport.listSessions(limit: limit, search: nil, archived: false)
            } catch {
                if self.outbox != nil, self.healthOK, !self.hasCurrentSessionMetadata {
                    applyTransportHealth(false)
                }
                return
            }
            if let sessionSnapshot, !self.isCurrentSession(sessionSnapshot) {
                return
            }
            guard sessionsFetchRequestID > self.latestAppliedSessionsFetchRequestID else { return }
            // A list that straddles a patch or reconnect is stale. Retry in this
            // owner so bootstrap cannot discard its only authoritative refresh.
            guard metadataGeneration == self.sessionMetadataGeneration else {
                overlappingSuccessfulSettingsPatchRequestID = nil
                pendingSettingsPatchOverlapBaseline = nil
                continue
            }
            guard settingsPatchRevision == self.settingsPatchRevisionsByTarget[target, default: 0],
                  self.inFlightSettingsPatchCountsByTarget[target] == nil
            else {
                let completedRequestID = self.lastSuccessfulSettingsPatchRequestIDsByTarget[target]
                if let completedRequestID,
                   completedRequestID != successfulSettingsPatchRequestID
                {
                    overlappingSuccessfulSettingsPatchRequestID = completedRequestID
                }
                if self.inFlightSettingsPatchCountsByTarget[target] != nil {
                    pendingSettingsPatchOverlapBaseline = completedRequestID ?? 0
                }
                continue
            }
            self.latestAppliedSessionsFetchRequestID = sessionsFetchRequestID
            let organized = OpenClawChatSessionListOrganizer.organize(res.sessions)
            for session in organized {
                self.unreadPatchGuard.observe(
                    key: self.sessionMutationIdentity(for: session.key, listedKey: session.key),
                    unread: session.unread)
            }
            self.sessions = self.applyingLocalUnreadOverrides(to: organized)
            self.sessionDefaults = res.defaults
            self.restoreOverlappingSettingsPatch(
                requestID: overlappingSuccessfulSettingsPatchRequestID,
                target: target)
            self.hasAppliedLiveSessions = true
            self.syncSelectedModel()
            syncThinkingLevelOptions()
            persistSessionsToCache(organized)
            self.readySessionMetadataGeneration = metadataGeneration
            if self.healthOK {
                reconcilePendingOutboxBranchScopes()
            }
            return
        }
    }

    private func restoreOverlappingSettingsPatch(requestID: UInt64?, target: ModelPatchTarget) {
        guard let requestID,
              self.lastSuccessfulSettingsPatchRequestIDsByTarget[target] == requestID
        else { return }

        // A post-patch list retry may still carry the pre-patch row. Preserve
        // only the route whose patch overlapped this fetch.
        let patchResult = self.lastSuccessfulSettingsPatchResultsByTarget[target]
        let resultKey = patchResult?.key ?? target.canonicalSessionKey
        if let selectionID = self.lastSuccessfulModelSelectionIDsByTarget[target] {
            self.applySuccessfulModelSelection(
                selectionID,
                target: target,
                sessionEntryKey: resultKey,
                syncSelection: false,
                patchResult: patchResult)
        } else if let thinkingLevel = patchResult?.thinkingLevel,
                  self.lastSuccessfulThinkingOverrideClearedByTarget[target] != true
        {
            self.updateCurrentSessionThinkingLevel(thinkingLevel, sessionKey: resultKey)
        }
        if self.lastSuccessfulThinkingOverrideClearedByTarget[target] == true {
            self.updateCurrentSessionThinkingLevel(nil, sessionKey: resultKey)
        }
        if let patchResult {
            self.applyModelControlPatchResult(
                patchResult,
                sessionKey: resultKey,
                fastOverrideCleared: self.lastSuccessfulFastOverrideClearedByTarget[target] == true,
                verboseOverrideCleared: self.lastSuccessfulVerboseOverrideClearedByTarget[target] == true)
        }
    }

    func invalidateSessionMetadataReadiness() {
        self.sessionMetadataGeneration &+= 1
        self.readySessionMetadataGeneration = nil
    }

    var hasCurrentSessionMetadata: Bool {
        self.readySessionMetadataGeneration == self.sessionMetadataGeneration
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
        if blocksAttachmentOwnerChange {
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
        self.prepareComposerForSessionSwitch(to: next)
        self.advanceSessionGeneration()
        self.clearSessionOwnedState()
        self.sessionKey = next
        self.restoreComposerAfterSessionSwitch()
        if intent == .userInitiated {
            self.onSessionChanged?(next)
        }
        self.startBootstrap(sessionKey: next)
    }

    func applyDeferredExternalStateIfReady() {
        guard !blocksAttachmentOwnerChange else { return }
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

    /// Adopts a freshly created session key: full composer-preserving switch plus
    /// session-owned state reset. Module-internal so the session-actions extension
    /// does not need access to the private switch members.
    func adoptCreatedSession(_ next: String) {
        self.prepareComposerForSessionSwitch(to: next)
        self.advanceSessionGeneration()
        self.clearSessionOwnedState()
        self.sessionKey = next
        self.restoreComposerAfterSessionSwitch()
        self.onSessionChanged?(next)
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
        clearPlan()
        self.updateActiveSessionRunWithoutChatSnapshot(false)
        resetSlashCommandCatalog()
        self.sessionBranches = []
        self.isLoadingSessionBranches = false
        self.sessionBranchSwitchActivity = nil
        clearPendingRuns(reason: nil)
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

        self.replyTarget = nil
        self.runMessageScopesByRunID.removeAll()
        self.provisionalFinalMessagesByID.removeAll()
        self.startBootstrap()
    }

    func performCompact() async {
        guard !self.isCompacting else { return }
        guard !self.isSending, !hasBlockingRunActivity, !self.isAborting else {
            self.errorText = "Wait for the current response before compacting the thread."
            return
        }
        if let lastCompactAt,
           Date().timeIntervalSince(lastCompactAt) < compactCooldown
        {
            self.errorText = "Please wait before compacting this thread again."
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
            self.errorText = "Unable to compact the thread. Please try again."
            let nsError = error as NSError
            chatUILogger.error(
                "compact failed domain=\(nsError.domain, privacy: .public) code=\(nsError.code, privacy: .public)")
            chatUILogger.error("compact details=\(String(describing: error), privacy: .private)")
            return
        }

        lastCompactAt = Date()
        self.startBootstrap()
    }

    private func reserveModelSelection(_ selectionID: String) -> ModelSelectionRequest? {
        let next = self.normalizedSelectionID(selectionID)
        guard next != self.modelSelectionID else { return nil }

        let session = self.currentSessionSnapshot()
        let sessionEntryKey = currentSessionEntry()?.key
        let target = modelPatchTarget(
            sessionKey: session.key,
            canonicalSessionKey: sessionEntryKey,
            agentID: session.deliveryAgentID,
            sessionRoutingContract: session.sessionRoutingContract)
        let previous = self.modelSelectionID
        let rollbackSelectionID = self.lastSuccessfulModelSelectionIDsByTarget[target] ?? previous
        let previousRequestID = self.latestModelSelectionRequestIDsByTarget[target]
        let requestID = self.reserveSessionSettingsRequest(for: target)
        let nextModelRef = self.modelRef(forSelectionID: next)
        self.latestModelSelectionRequestIDsByTarget[target] = requestID
        self.modelSelectionID = next
        syncThinkingLevelOptions()
        self.errorText = nil
        return ModelSelectionRequest(
            id: requestID,
            target: target,
            session: session,
            sessionEntryKey: sessionEntryKey,
            rollbackSelectionID: rollbackSelectionID,
            previousRequestID: previousRequestID,
            selectionID: next,
            modelRef: nextModelRef)
    }

    private func performSelectModel(
        _ request: ModelSelectionRequest,
        routeLease: OpenClawChatSessionSettingsRouteLease?) async
    {
        do {
            guard let routeLease else { throw OpenClawChatTransportSendError.notDispatched }
            let patchResult = try await routeLease.patchSessionSettings(
                sessionKey: request.target.canonicalSessionKey,
                agentID: request.target.agentID,
                patch: OpenClawChatSessionSettingsPatch(model: .some(request.modelRef)))
            self.lastSuccessfulSettingsPatchRequestIDsByTarget[request.target] = request.id
            guard request.id == self.latestModelSelectionRequestIDsByTarget[request.target] else {
                // Keep older successful patches as rollback state, but do not replay
                // stale UI/session state over a newer queued or completed selection.
                self.recordSuccessfulModelPatch(
                    selectionID: request.selectionID,
                    patchResult: patchResult,
                    target: request.target)
                return
            }
            self.applySuccessfulModelSelection(
                request.selectionID,
                target: request.target,
                sessionEntryKey: patchResult?.key ?? request.sessionEntryKey,
                syncSelection: self.isCurrentSession(request.session),
                patchResult: patchResult)
            self.modelPickerStore.recordRecent(request.selectionID)
            self.modelPickerRecents = self.modelPickerStore.recents
        } catch {
            guard request.id == self.latestModelSelectionRequestIDsByTarget[request.target] else { return }
            let rollbackSelectionID = self.lastSuccessfulModelSelectionIDsByTarget[request.target]
                ?? request.rollbackSelectionID
            if let previousRequestID = request.previousRequestID {
                self.latestModelSelectionRequestIDsByTarget[request.target] = previousRequestID
            } else {
                self.latestModelSelectionRequestIDsByTarget.removeValue(forKey: request.target)
            }
            if self.lastSuccessfulModelSelectionIDsByTarget[request.target] == rollbackSelectionID {
                self.applySuccessfulModelSelection(
                    rollbackSelectionID,
                    target: request.target,
                    sessionEntryKey: request.sessionEntryKey,
                    syncSelection: self.isCurrentSession(request.session),
                    patchResult: self.lastSuccessfulSettingsPatchResultsByTarget[request.target])
            }
            guard self.isCurrentSession(request.session) else { return }
            self.modelSelectionID = rollbackSelectionID
            syncThinkingLevelOptions()
            self.errorText = error.localizedDescription
            chatUILogger.error("sessions.patch(model) failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func finishSettingsPatchTail(requestID: UInt64, target: ModelPatchTarget) {
        guard self.settingsPatchTailsByTarget[target]?.requestID == requestID else { return }
        self.settingsPatchTailsByTarget.removeValue(forKey: target)
    }

    func reserveSessionSettingsRequest(for target: ModelPatchTarget) -> UInt64 {
        self.nextSessionSettingsRequestID &+= 1
        self.beginSettingsPatch(for: target)
        return self.nextSessionSettingsRequestID
    }

    func enqueueSessionSettingsPatch(
        requestID: UInt64,
        target: ModelPatchTarget,
        operation: @escaping @MainActor (OpenClawChatSessionSettingsRouteLease?) async -> Void)
    {
        let previousPatchTail = self.settingsPatchTailsByTarget[target]
        let previousTail = previousPatchTail?.task
        let previousRouteLeaseTask = previousPatchTail?.routeLeaseTask
        // Task scheduling is not FIFO. Chain lease capture separately so a
        // reconnect cannot give an older mutation a newer route than its successor.
        let routeLeaseTask = Task { [weak self] in
            _ = await previousRouteLeaseTask?.value
            return await self?.transport.acquireSessionSettingsRouteLease()
        }
        let task = Task { [weak self] in
            let routeLease = await routeLeaseTask.value
            await previousTail?.value
            guard let self else { return }
            await operation(routeLease)
            self.endSettingsPatch(for: target)
            self.finishSettingsPatchTail(requestID: requestID, target: target)
        }
        self.settingsPatchTailsByTarget[target] = SettingsPatchTail(
            requestID: requestID,
            routeLeaseTask: routeLeaseTask,
            task: task)
    }

    private func beginSettingsPatch(for target: ModelPatchTarget) {
        self.settingsPatchRevisionsByTarget[target, default: 0] &+= 1
        self.inFlightSettingsPatchCountsByTarget[target, default: 0] += 1
    }

    private func endSettingsPatch(for target: ModelPatchTarget) {
        self.settingsPatchRevisionsByTarget[target, default: 0] &+= 1
        let remaining = max(0, (inFlightSettingsPatchCountsByTarget[target] ?? 0) - 1)
        if remaining == 0 {
            self.inFlightSettingsPatchCountsByTarget.removeValue(forKey: target)
            // Rollback baselines belong to one contiguous settings lane. Once
            // drained, the next authoritative session snapshot owns state.
            self.acceptedSettingsPatchResultsByTarget.removeValue(forKey: target)
            self.acceptedThinkingLevelsByTarget.removeValue(forKey: target)
            self.acceptedPreferredThinkingLevelsByTarget.removeValue(forKey: target)
            self.acceptedExplicitThinkingPreferencesByTarget.removeValue(forKey: target)
            self.acceptedThinkingOverrideClearedByTarget.removeValue(forKey: target)
            self.acceptedVerboseLevelsByTarget.removeValue(forKey: target)
            self.acceptedFastModesByTarget.removeValue(forKey: target)
            self.latestThinkingSelectionRequestIDsByTarget.removeValue(forKey: target)
            let waiters = self.settingsPatchWaitersByTarget.removeValue(forKey: target) ?? []
            for waiter in waiters {
                waiter.resume()
            }
            return
        }
        self.inFlightSettingsPatchCountsByTarget[target] = remaining
    }

    /// Internal for the outbox flush, which must honor the same ordering
    /// behind in-flight settings patches as the live send path.
    func waitForPendingSessionSettings(
        in sessionKey: String,
        canonicalSessionKey: String? = nil,
        agentID: String? = nil,
        sessionRoutingContract: String? = nil) async
    {
        let target: ModelPatchTarget
        if canonicalSessionKey == nil,
           agentID == nil,
           sessionRoutingContract == nil,
           sessionKey == self.sessionKey
        {
            let session = self.currentSessionSnapshot()
            target = modelPatchTarget(
                sessionKey: session.key,
                canonicalSessionKey: currentSessionEntry()?.key,
                agentID: session.deliveryAgentID,
                sessionRoutingContract: session.sessionRoutingContract)
        } else {
            target = modelPatchTarget(
                sessionKey: sessionKey,
                canonicalSessionKey: canonicalSessionKey,
                agentID: agentID,
                sessionRoutingContract: sessionRoutingContract)
        }
        await self.waitForPendingSessionSettings(for: target)
    }

    private func waitForPendingSessionSettings(for target: ModelPatchTarget) async {
        guard (self.inFlightSettingsPatchCountsByTarget[target] ?? 0) > 0 else { return }
        await withCheckedContinuation { continuation in
            self.settingsPatchWaitersByTarget[target, default: []].append(continuation)
        }
    }

    func syncSelectedModel() {
        let currentSession = currentSessionEntry()
        let target = currentModelPatchTarget()
        let explicitModelID = self.normalizedModelSelectionID(
            currentSession?.model,
            provider: currentSession?.modelProvider)
        let defaultModelID = self.normalizedModelSelectionID(
            self.sessionDefaults?.model,
            provider: self.sessionDefaults?.modelProvider)
        if self.lastSuccessfulModelSelectionIDsByTarget[target] == Self.defaultModelSelectionID,
           explicitModelID == defaultModelID
        {
            self.modelSelectionID = Self.defaultModelSelectionID
            return
        }
        if let explicitModelID {
            self.lastSuccessfulModelSelectionIDsByTarget[target] = explicitModelID
            self.modelSelectionID = explicitModelID
            return
        }
        self.lastSuccessfulModelSelectionIDsByTarget[target] = Self.defaultModelSelectionID
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

    /// Module-internal: the session-actions extension derives new-session keys.
    func generatedNewSessionKey(agentID explicitAgentID: String? = nil) -> String {
        let baseKey = "ios-\(UUID().uuidString.lowercased())"
        guard let agentID = explicitAgentID ??
            OpenClawChatSessionKey.agentID(from: sessionKey) ??
            activeAgentId ??
            OpenClawChatSessionKey.agentID(from: resolvedMainSessionKey) ??
            sessions.lazy.compactMap({ OpenClawChatSessionKey.agentID(from: $0.key) }).first
        else {
            return baseKey
        }
        return "agent:\(agentID):\(baseKey)"
    }

    private func modelLabel(for modelID: String) -> String {
        self.modelChoices.first(where: { $0.selectionID == modelID || $0.modelID == modelID })?.displayLabel ??
            modelID
    }

    private func applySuccessfulModelSelection(
        _ selectionID: String,
        target: ModelPatchTarget,
        sessionEntryKey: String?,
        syncSelection: Bool,
        patchResult: OpenClawChatModelPatchResult? = nil)
    {
        self.recordSuccessfulModelPatch(
            selectionID: selectionID,
            patchResult: patchResult,
            target: target)
        if target.canonicalSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "global",
           let targetAgentID = target.agentID,
           targetAgentID != activeAgentId
        {
            return
        }
        let resolved: (modelID: String?, modelProvider: String?) = if selectionID == Self.defaultModelSelectionID {
            (modelID: nil, modelProvider: nil)
        } else if let model = patchResult?.model {
            (modelID: model, modelProvider: patchResult?.modelProvider)
        } else {
            self.resolvedSessionModelIdentity(forSelectionID: selectionID)
        }
        let modelStateKey = sessionEntryKey ?? target.canonicalSessionKey
        updateCurrentSessionModel(
            modelID: resolved.modelID,
            modelProvider: resolved.modelProvider,
            sessionKey: modelStateKey,
            syncSelection: syncSelection)
        if let thinkingLevels = patchResult?.thinkingLevels {
            updateCurrentSessionThinkingLevels(thinkingLevels, sessionKey: modelStateKey)
        }
        if syncSelection,
           !self.prefersExplicitThinkingLevel,
           Self.normalizedThinkingLevel(self.preferredThinkingLevel) != "ultra",
           let thinkingLevel = Self.normalizedThinkingLevel(patchResult?.thinkingLevel)
        {
            self.preferredThinkingLevel = thinkingLevel
        }
        if let thinkingLevel = Self.normalizedThinkingLevel(patchResult?.thinkingLevel) {
            updateCurrentSessionThinkingLevel(thinkingLevel, sessionKey: modelStateKey)
        }
        if syncSelection {
            syncThinkingLevelOptions()
        }
    }

    private func recordSuccessfulModelPatch(
        selectionID: String,
        patchResult: OpenClawChatModelPatchResult?,
        target: ModelPatchTarget)
    {
        self.lastSuccessfulModelSelectionIDsByTarget[target] = selectionID
        self.lastSuccessfulSettingsPatchResultsByTarget[target] = patchResult
        if let thinkingLevel = Self.normalizedThinkingLevel(patchResult?.thinkingLevel) {
            self.acceptedThinkingLevelsByTarget[target] = thinkingLevel
            if self.acceptedExplicitThinkingPreferencesByTarget[target] == false {
                self.acceptedPreferredThinkingLevelsByTarget[target] = thinkingLevel
                self.recordAuthoritativeInheritedThinkingPreference(thinkingLevel)
            }
        }
        if let patchResult {
            let previous = self.acceptedSettingsPatchResultsByTarget[target]
            self.acceptedSettingsPatchResultsByTarget[target] = OpenClawChatModelPatchResult(
                key: patchResult.key ?? previous?.key,
                modelProvider: patchResult.modelProvider ?? previous?.modelProvider,
                model: patchResult.model ?? previous?.model,
                thinkingLevel: patchResult.thinkingLevel ?? previous?.thinkingLevel,
                thinkingLevels: patchResult.thinkingLevels ?? previous?.thinkingLevels,
                fastMode: patchResult.fastMode ?? previous?.fastMode,
                effectiveFastMode: patchResult.effectiveFastMode ?? previous?.effectiveFastMode,
                verboseLevel: patchResult.verboseLevel ?? previous?.verboseLevel)
        }
        self.completedModelPatchTargets.insert(target)
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
}
