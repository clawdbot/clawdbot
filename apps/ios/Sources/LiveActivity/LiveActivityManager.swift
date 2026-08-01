@preconcurrency import ActivityKit
import Foundation
import os

/// Owns the single ActivityKit presentation for connection, attention, tool,
/// and voice state. Producers update independent inputs; the arbiter decides
/// which state is visible so lower-priority updates cannot hide urgent work.
@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private struct PendingActivityUpdate {
        var state: OpenClawActivityAttributes.ContentState
        var staleDate: Date?
    }

    private struct StatusPresentation {
        let status: OpenClawActivityAttributes.ContentState.Status
        let verbatimDetail: String?
    }

    private let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "LiveActivity")
    private let connectingStaleSeconds: TimeInterval = 120
    private let transientStaleSeconds: TimeInterval = 300
    private let hydrationStaleSeconds: TimeInterval = 300
    private let voiceSamplePublishDelay = Duration.milliseconds(500)
    private let voiceStaleRefreshDelay = Duration.seconds(240)
    private let toolStaleRefreshDelay = Duration.seconds(240)

    private var arbiter = LiveActivityPresentationArbiter()
    private var currentActivity: Activity<OpenClawActivityAttributes>?
    private var currentState: OpenClawActivityAttributes.ContentState?
    private var currentStaleDate: Date?
    private var pendingActivityUpdate: PendingActivityUpdate?
    private var activityUpdateTask: Task<Void, Never>?
    private var activityGeneration: UInt64 = 0
    private var voiceSampleBuffer = LiveActivityVoiceSampleBuffer()
    private var pendingVoiceSample: UInt8?
    private var voiceSampleTask: Task<Void, Never>?
    private var voiceStaleRefreshTask: Task<Void, Never>?
    private var voiceStaleRefreshGeneration: UInt64 = 0
    private var toolStaleRefreshTask: Task<Void, Never>?
    private var toolStaleRefreshGeneration: UInt64 = 0
    #if DEBUG
    private var voicePreviewActive = false
    #endif

    private init() {
        self.hydrateCurrentAndPruneDuplicates()
    }

    func showConnecting(
        statusText: String = String(localized: "Connecting..."),
        agentName: String,
        sessionKey: String)
    {
        let presentation = Self.connectingPresentation(statusText: statusText)
        let startedAt = Self.lifecycleStartedAt(
            existing: self.arbiter.connection,
            agentName: agentName,
            sessionKey: sessionKey)
        let state = OpenClawActivityAttributes.ContentState(
            status: presentation.status,
            verbatimDetail: presentation.verbatimDetail,
            startedAt: startedAt)
        self.arbiter.setConnection(self.request(
            state: state,
            staleAfter: self.connectingStaleSeconds,
            agentName: agentName,
            sessionKey: sessionKey))
        self.reconcile(reason: "connecting")
    }

    func showAttention(statusText: String, agentName: String, sessionKey: String) {
        let presentation = Self.attentionPresentation(statusText: statusText)
        let startedAt = Self.lifecycleStartedAt(
            existing: self.arbiter.attention,
            agentName: agentName,
            sessionKey: sessionKey)
        let state = OpenClawActivityAttributes.ContentState(
            status: presentation.status,
            verbatimDetail: presentation.verbatimDetail,
            startedAt: startedAt)
        self.arbiter.setAttention(self.request(
            state: state,
            staleAfter: nil,
            agentName: agentName,
            sessionKey: sessionKey))
        self.reconcile(reason: "attention")
    }

    func showTool(id: String, name: String, agentName: String, agentBadge: String, sessionKey: String) {
        let toolName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, !toolName.isEmpty else { return }
        let state = OpenClawActivityAttributes.ContentState(
            status: .toolRunning,
            verbatimDetail: nil,
            startedAt: .now,
            agentBadge: agentBadge,
            toolName: toolName)
        self.arbiter.startTool(
            id: id,
            request: self.request(
                state: state,
                staleAfter: self.transientStaleSeconds,
                agentName: agentName,
                sessionKey: sessionKey))
        self.ensureToolStaleRefreshTask()
        self.reconcile(reason: "tool_started")
    }

    func endTool(id: String, sessionKey: String) {
        self.arbiter.endTool(id: id, sessionKey: sessionKey)
        if self.arbiter.activeToolCount == 0 {
            self.stopToolStaleRefreshTask()
        }
        self.reconcile(reason: "tool_finished")
    }

    func showVoice(
        statusText: String,
        isListening: Bool,
        isSpeaking: Bool,
        audioLevel: Double?,
        agentName: String,
        agentBadge: String,
        sessionKey: String)
    {
        let status = LiveActivityPresentationArbiter.voiceStatus(
            isListening: isListening,
            isSpeaking: isSpeaking)
        let detail = Self.voiceDetail(statusText, status: status)
        let previousVoice = self.arbiter.voice
        let hasSameOwner = Self.hasSameOwner(
            previousVoice,
            agentName: agentName,
            sessionKey: sessionKey)
        let startedAt = Self.lifecycleStartedAt(
            existing: previousVoice,
            agentName: agentName,
            sessionKey: sessionKey)
        let hasMeasuredAudio = isSpeaking || isListening
        if !hasSameOwner || Self.shouldResetVoiceSamples(previousStatus: previousVoice?.state.status) {
            self.resetVoiceSamples()
        }
        if hasMeasuredAudio, let sample = LiveActivityVoiceSampleBuffer.quantize(audioLevel) {
            self.voiceSampleBuffer.append(sample)
        }
        let state = OpenClawActivityAttributes.ContentState(
            status: status,
            verbatimDetail: detail,
            startedAt: startedAt,
            agentBadge: agentBadge,
            voiceSamples: hasMeasuredAudio ? self.voiceSampleBuffer.payload : nil)
        self.arbiter.setVoice(self.request(
            state: state,
            staleAfter: self.transientStaleSeconds,
            agentName: agentName,
            sessionKey: sessionKey))
        self.ensureVoiceStaleRefreshTask()
        self.reconcile(reason: "voice_changed")
    }

    /// Coalesces the high-rate playback meter into a bounded two-updates-per-second
    /// envelope. The widget gets real motion without building an ActivityKit queue.
    func updateVoiceLevel(_ level: Double?) {
        guard let status = arbiter.voice?.state.status,
              status == .voiceSpeaking || status == .voiceListening,
              let sample = LiveActivityVoiceSampleBuffer.quantize(level)
        else { return }
        self.pendingVoiceSample = sample
        guard self.voiceSampleTask == nil else { return }
        self.voiceSampleTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: self.voiceSamplePublishDelay)
            guard !Task.isCancelled else { return }
            self.voiceSampleTask = nil
            self.publishPendingVoiceSample()
        }
    }

    func endVoice() {
        #if DEBUG
        guard !self.voicePreviewActive else { return }
        #endif
        self.resetVoiceSamples()
        self.stopVoiceStaleRefreshTask()
        self.arbiter.setVoice(nil)
        self.reconcile(reason: "voice_finished")
    }

    #if DEBUG
    /// Simulator-only fixture. The widget supplies its own bounded animation;
    /// ActivityKit receives a state transition rather than audio-rate updates.
    func startVoicePreview() {
        self.voicePreviewActive = true
        self.showVoice(
            statusText: "Speaking",
            isListening: false,
            isSpeaking: true,
            audioLevel: nil,
            agentName: "Aiden",
            agentBadge: "🐕",
            sessionKey: "live-activity-preview")
    }
    #endif

    func handleReconnect() {
        self.arbiter.clearConnectionState()
        self.reconcile(reason: "connected")
    }

    func endActivity(reason: String) {
        self.arbiter.clearAll()
        self.stopToolStaleRefreshTask()
        self.stopVoiceStaleRefreshTask()
        self.resetVoiceSamples()
        #if DEBUG
        self.voicePreviewActive = false
        #endif
        self.endCurrentActivity(reason: reason)
    }

    private func request(
        state: OpenClawActivityAttributes.ContentState,
        staleAfter seconds: TimeInterval?,
        agentName: String,
        sessionKey: String) -> LiveActivityPresentationRequest
    {
        LiveActivityPresentationRequest(
            state: state,
            staleDate: seconds.map { Date().addingTimeInterval($0) },
            agentName: agentName,
            sessionKey: sessionKey)
    }

    private func reconcile(reason: String) {
        guard let request = arbiter.current else {
            self.endCurrentActivity(reason: reason)
            return
        }

        if let activity = currentActivity,
           activity.activityState == .active,
           activity.attributes.agentName != request.agentName ||
           activity.attributes.sessionKey != request.sessionKey
        {
            self.endCurrentActivity(reason: "context_changed")
            self.startActivity(request)
            return
        }

        if let activity = currentActivity, activity.activityState == .active {
            self.enqueueLatestUpdate(
                activity: activity,
                state: request.state,
                staleDate: request.staleDate)
            return
        }

        if let activity = currentActivity {
            // An inactive activity can still have a suspended update worker. Retire
            // that generation before replacing it or the new activity never starts one.
            self.activityGeneration &+= 1
            self.activityUpdateTask?.cancel()
            self.activityUpdateTask = nil
            self.pendingActivityUpdate = nil
            self.end(activity: activity)
            self.currentActivity = nil
            self.currentState = nil
            self.currentStaleDate = nil
        }
        self.startActivity(request)
    }

    private func publishPendingVoiceSample() {
        guard let sample = pendingVoiceSample,
              var request = arbiter.voice,
              request.state.status == .voiceSpeaking || request.state.status == .voiceListening
        else {
            self.pendingVoiceSample = nil
            return
        }
        self.pendingVoiceSample = nil
        self.voiceSampleBuffer.append(sample)
        request.state.voiceSamples = self.voiceSampleBuffer.payload
        request.staleDate = Date().addingTimeInterval(self.transientStaleSeconds)
        self.arbiter.setVoice(request)
        self.reconcile(reason: "voice_level")
    }

    private func resetVoiceSamples() {
        self.voiceSampleTask?.cancel()
        self.voiceSampleTask = nil
        self.pendingVoiceSample = nil
        self.voiceSampleBuffer.reset()
    }

    /// Active tool calls refresh their bounded deadline while this process owns
    /// them. Suspension or termination stops the heartbeat so stale work pauses.
    private func ensureToolStaleRefreshTask() {
        guard self.toolStaleRefreshTask == nil, self.arbiter.activeToolCount > 0 else { return }
        self.toolStaleRefreshGeneration &+= 1
        let generation = self.toolStaleRefreshGeneration
        self.toolStaleRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                try? await Task.sleep(for: self.toolStaleRefreshDelay)
                guard !Task.isCancelled,
                      generation == self.toolStaleRefreshGeneration,
                      self.arbiter.activeToolCount > 0
                else { break }
                self.arbiter.refreshTools(
                    staleDate: Date().addingTimeInterval(self.transientStaleSeconds))
                self.reconcile(reason: "tool_heartbeat")
            }
            guard let self, generation == self.toolStaleRefreshGeneration else { return }
            self.toolStaleRefreshTask = nil
        }
    }

    private func stopToolStaleRefreshTask() {
        self.toolStaleRefreshGeneration &+= 1
        self.toolStaleRefreshTask?.cancel()
        self.toolStaleRefreshTask = nil
    }

    private func ensureVoiceStaleRefreshTask() {
        guard self.voiceStaleRefreshTask == nil, self.arbiter.voice != nil else { return }
        self.voiceStaleRefreshGeneration &+= 1
        let generation = self.voiceStaleRefreshGeneration
        self.voiceStaleRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                try? await Task.sleep(for: self.voiceStaleRefreshDelay)
                guard !Task.isCancelled,
                      generation == self.voiceStaleRefreshGeneration,
                      self.arbiter.voice != nil
                else { break }
                self.arbiter.refreshVoice(
                    staleDate: Date().addingTimeInterval(self.transientStaleSeconds))
                self.reconcile(reason: "voice_heartbeat")
            }
            guard let self, generation == self.voiceStaleRefreshGeneration else { return }
            self.voiceStaleRefreshTask = nil
        }
    }

    private func stopVoiceStaleRefreshTask() {
        self.voiceStaleRefreshGeneration &+= 1
        self.voiceStaleRefreshTask?.cancel()
        self.voiceStaleRefreshTask = nil
    }

    private func startActivity(_ request: LiveActivityPresentationRequest) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            self.logger.info("Live Activities disabled; skipping start")
            return
        }

        do {
            let activity = try Activity.request(
                attributes: OpenClawActivityAttributes(
                    agentName: request.agentName,
                    sessionKey: request.sessionKey),
                content: ActivityContent(state: request.state, staleDate: request.staleDate),
                pushType: nil)
            self.activityGeneration &+= 1
            self.currentActivity = activity
            self.currentState = request.state
            self.currentStaleDate = request.staleDate
            self.logger.info("started live activity id=\(activity.id, privacy: .public)")
        } catch {
            self.logger.error("failed to start live activity: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Keeps at most one ActivityKit update in flight and one replaceable next
    /// value. Slow or throttled ActivityKit writes cannot build an obsolete queue.
    private func enqueueLatestUpdate(
        activity: Activity<OpenClawActivityAttributes>,
        state: OpenClawActivityAttributes.ContentState,
        staleDate: Date?)
    {
        guard state != self.currentState || staleDate != self.currentStaleDate else { return }
        self.currentState = state
        self.currentStaleDate = staleDate
        self.pendingActivityUpdate = PendingActivityUpdate(state: state, staleDate: staleDate)
        guard self.activityUpdateTask == nil else { return }
        self.startUpdateWorker(activity: activity, generation: self.activityGeneration)
    }

    private func startUpdateWorker(activity: Activity<OpenClawActivityAttributes>, generation: UInt64) {
        self.activityUpdateTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self,
                      generation == self.activityGeneration,
                      self.currentActivity?.id == activity.id,
                      let pending = self.pendingActivityUpdate
                else { break }
                self.pendingActivityUpdate = nil
                await activity.update(ActivityContent(state: pending.state, staleDate: pending.staleDate))
            }

            guard let self, generation == self.activityGeneration else { return }
            self.activityUpdateTask = nil
            if self.pendingActivityUpdate != nil,
               self.currentActivity?.id == activity.id
            {
                self.startUpdateWorker(activity: activity, generation: generation)
            }
        }
    }

    private func endCurrentActivity(reason: String) {
        guard let activity = currentActivity else { return }
        let startedAt = self.currentState?.startedAt ?? .now
        self.activityGeneration &+= 1
        self.activityUpdateTask?.cancel()
        self.activityUpdateTask = nil
        self.pendingActivityUpdate = nil
        self.currentActivity = nil
        self.currentState = nil
        self.currentStaleDate = nil
        self.logger.info("ending live activity reason=\(reason, privacy: .public)")
        let finalState = OpenClawActivityAttributes.ContentState(
            status: .disconnected,
            verbatimDetail: nil,
            startedAt: startedAt)
        Task {
            await activity.end(
                ActivityContent(state: finalState, staleDate: nil),
                dismissalPolicy: .immediate)
        }
    }

    private func hydrateCurrentAndPruneDuplicates() {
        let active = Activity<OpenClawActivityAttributes>.activities
        guard !active.isEmpty else { return }

        let now = Date()
        let candidates = active.filter { activity in
            let state = activity.content.state
            guard activity.activityState == .active else { return false }
            return Self.shouldHydrate(
                status: state.status,
                startedAt: state.startedAt,
                staleDate: activity.content.staleDate,
                now: now,
                maximumStartAge: self.hydrationStaleSeconds)
        }

        guard let keeper = candidates.max(by: {
            $0.content.state.startedAt < $1.content.state.startedAt
        }) else {
            for activity in active {
                self.end(activity: activity)
            }
            return
        }

        self.activityGeneration &+= 1
        self.currentActivity = keeper
        self.currentState = keeper.content.state
        self.currentStaleDate = keeper.content.staleDate
        var request = LiveActivityPresentationRequest(
            state: keeper.content.state,
            staleDate: keeper.content.staleDate,
            agentName: keeper.attributes.agentName,
            sessionKey: keeper.attributes.sessionKey)
        switch keeper.content.state.status {
        case .approvalNeeded, .actionRequired, .attention:
            self.arbiter.setAttention(request)
        case .voiceActive, .voiceListening, .voiceSpeaking:
            self.arbiter.setVoice(request)
        case .toolRunning:
            // A hydrated tool has no invocation ID to balance. Keep it as the
            // lowest-priority fallback until a live producer replaces it.
            request.staleDate = Date().addingTimeInterval(self.transientStaleSeconds)
            self.arbiter.adoptInitialHydratedToolFallback(request)
        case .connecting, .reconnecting, .paused:
            self.arbiter.setConnection(request)
        case .idle, .disconnected:
            break
        }
        for activity in active where activity.id != keeper.id {
            self.end(activity: activity)
        }
        // Hydrated tool fallbacks renew their bounded lifetime above. Reconcile
        // that request so ActivityKit receives the renewed stale date too.
        self.reconcile(reason: "hydrate")
    }

    /// Voice and tool activities renew `staleDate` while their producer is
    /// alive. Their original start time can therefore be old without making a
    /// heartbeat-refreshed presentation obsolete after process relaunch.
    nonisolated static func shouldHydrate(
        status: OpenClawActivityAttributes.ContentState.Status,
        startedAt: Date,
        staleDate: Date?,
        now: Date,
        maximumStartAge: TimeInterval = 300) -> Bool
    {
        guard status != .idle, status != .disconnected else { return false }
        if let staleDate, staleDate <= now {
            return false
        }
        switch status {
        case .approvalNeeded, .actionRequired, .attention:
            return true
        case .voiceActive, .voiceListening, .voiceSpeaking, .toolRunning:
            return staleDate != nil || now.timeIntervalSince(startedAt) < maximumStartAge
        case .connecting, .reconnecting, .paused:
            return now.timeIntervalSince(startedAt) < maximumStartAge
        case .idle, .disconnected:
            return false
        }
    }

    /// A live voice producer owns the waveform buffer. Phase changes preserve
    /// its recent envelope; only a newly adopted producer starts a new trace.
    nonisolated static func shouldResetVoiceSamples(
        previousStatus: OpenClawActivityAttributes.ContentState.Status?) -> Bool
    {
        previousStatus == nil
    }

    nonisolated static func hasSameOwner(
        _ existing: LiveActivityPresentationRequest?,
        agentName: String,
        sessionKey: String) -> Bool
    {
        existing?.agentName == agentName && existing?.sessionKey == sessionKey
    }

    nonisolated static func lifecycleStartedAt(
        existing: LiveActivityPresentationRequest?,
        agentName: String,
        sessionKey: String,
        now: Date = .now) -> Date
    {
        guard self.hasSameOwner(existing, agentName: agentName, sessionKey: sessionKey) else {
            return now
        }
        return existing?.state.startedAt ?? now
    }

    private func end(activity: Activity<OpenClawActivityAttributes>) {
        let startedAt = activity.content.state.startedAt
        Task {
            await activity.end(
                ActivityContent(
                    state: OpenClawActivityAttributes.ContentState(
                        status: .disconnected,
                        verbatimDetail: nil,
                        startedAt: startedAt),
                    staleDate: nil),
                dismissalPolicy: .immediate)
        }
    }

    /// Existing callers still pass rendered app copy. Collapse known values here so
    /// ActivityKit persists semantics; only unknown external detail remains verbatim.
    private static func connectingPresentation(statusText: String) -> StatusPresentation {
        if statusText == String(localized: "Connecting...") || statusText == "Connecting..." {
            return StatusPresentation(status: .connecting, verbatimDetail: nil)
        }
        if statusText == String(localized: "Reconnecting...") || statusText == "Reconnecting..." {
            return StatusPresentation(status: .reconnecting, verbatimDetail: nil)
        }
        return StatusPresentation(status: .connecting, verbatimDetail: self.normalizedDetail(statusText))
    }

    private static func attentionPresentation(statusText: String) -> StatusPresentation {
        if statusText == String(localized: "Approval needed") || statusText == "Approval needed" {
            return StatusPresentation(status: .approvalNeeded, verbatimDetail: nil)
        }
        if statusText == String(localized: "Action required") || statusText == "Action required" {
            return StatusPresentation(status: .actionRequired, verbatimDetail: nil)
        }
        return StatusPresentation(status: .attention, verbatimDetail: self.normalizedDetail(statusText))
    }

    private static func normalizedDetail(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func voiceDetail(
        _ value: String,
        status: OpenClawActivityAttributes.ContentState.Status) -> String?
    {
        let knownLabels: [String] = switch status {
        case .voiceListening:
            [
                String(localized: "Listening"),
                String(localized: "Listening (PTT)"),
                String(localized: "Listening (Realtime)"),
            ]
        case .voiceSpeaking:
            [
                String(localized: "Speaking…"),
                String(localized: "Speaking (System)…"),
                String(localized: "Generating voice…"),
            ]
        case .voiceActive:
            [String(localized: "Ready")]
        default:
            []
        }
        if knownLabels.contains(value) {
            return nil
        }
        return self.normalizedDetail(value)
    }
}
