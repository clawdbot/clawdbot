import AVFAudio
import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog
import Speech

private final class StreamFailureBox: @unchecked Sendable {
    private let lock = NSLock()
    private var valueInternal: Error?

    func set(_ error: Error) {
        self.lock.lock()
        self.valueInternal = error
        self.lock.unlock()
    }

    var value: Error? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.valueInternal
    }
}

// This file intentionally centralizes talk mode state + behavior.
// It's large, and splitting would force `private` -> `fileprivate` across many members.
// We'll refactor into smaller files when the surface stabilizes.
// swiftlint:disable type_body_length file_length
@MainActor
@Observable
final class TalkModeManager: NSObject {
    private typealias SpeechRequest = SFSpeechAudioBufferRecognitionRequest
    private static let defaultModelIdFallback = "eleven_v3"
    private static let defaultRealtimeModelIdFallback = "gpt-realtime-2"
    private static let defaultTalkProvider = "elevenlabs"
    private static let defaultSilenceTimeoutMs = TalkDefaults.silenceTimeoutMs
    private static let redactedConfigSentinel = "__OPENCLAW_REDACTED__"
    private static let realtimePrefetchExpiryLeewaySeconds: TimeInterval = 30
    var isEnabled: Bool = false
    var isListening: Bool = false
    var isSpeaking: Bool = false
    var isUserSpeechDetected: Bool = false
    var isPushToTalkActive: Bool = false
    var statusText: String = "Off"
    /// 0..1-ish (not calibrated). Intended for UI feedback only.
    var micLevel: Double = 0
    /// Live agent playback envelope in 0...1 while speaking. nil means the active
    /// voice path exposes no real level (system voice, compressed streaming); the
    /// waveform then falls back to a synthetic pulse.
    var playbackLevel: Double?
    var gatewayTalkConfigLoaded: Bool = false
    var gatewayTalkApiKeyConfigured: Bool = false
    var gatewayTalkDefaultModelId: String?
    var gatewayTalkDefaultVoiceId: String?
    var gatewayTalkProviderLabel: String = "Not loaded"
    var gatewayTalkTransportLabel: String = "Not loaded"
    var gatewayTalkUsesRealtime: Bool = false
    var gatewayTalkUsesRealtimeRelay: Bool = false
    var gatewayTalkRealtimeProviderLabel: String?
    var gatewayTalkRealtimeModelId: String?
    var gatewayTalkRealtimeVoiceId: String?
    var gatewayTalkVoiceModeTitle: String = "Not loaded"
    var gatewayTalkVoiceModeSubtitle: String?
    var gatewayTalkVoiceModeAccessibilityValue: String = "Not loaded"
    var gatewayTalkActiveModeTitle: String = "Not active"
    var gatewayTalkActiveModeSubtitle: String?
    var gatewayTalkLastIssueText: String?
    var gatewayTalkCurrentFallbackIssue: TalkRuntimeIssue?
    var gatewayTalkPermissionState: TalkGatewayPermissionState = .unknown

    var isGatewayConnected: Bool {
        self.gatewayConnected
    }

    private enum CaptureMode {
        case idle
        case continuous
        case pushToTalk
    }

    private enum RealtimeStartResult {
        case started
        case unavailable(TalkRuntimeIssue)
        case ignored
    }

    private static let realtimeStableSessionSeconds: TimeInterval = 30
    private static let realtimeRestartDelaysNanoseconds: [UInt64] = [500_000_000, 2_000_000_000]

    private var isStarting = false
    private var startAttemptID = 0
    private var captureMode: CaptureMode = .idle
    private var foregroundAudioCaptureAllowed = true
    private var resumeContinuousAfterPTT: Bool = false
    private var activePTTCaptureId: String?
    private var pttAutoStopEnabled: Bool = false
    private var pttCompletion: CheckedContinuation<OpenClawTalkPTTStopPayload, Never>?
    private var pttTimeoutTask: Task<Void, Never>?

    private let allowSimulatorCapture: Bool
    private let gatewaySpeechSynthesizerOverride: (any TalkGatewaySpeechSynthesizing)?

    private let audioEngine = AVAudioEngine()
    private var inputTapInstalled = false
    private var audioTapDiagnostics: AudioTapDiagnostics?
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var silenceTask: Task<Void, Never>?
    private var realtimeSession: TalkRealtimeWebRTCSession?
    private var realtimeSessionReadyAt: Date?
    private var rapidRealtimeRestartCount = 0
    private var bypassRealtimeOnNextStart = false
    private var realtimeRestartGeneration = 0
    private var realtimeRelaySession: RealtimeTalkRelaySession?
    private var realtimeRelayStartInFlight = false
    private var prefetchedRealtimeSession: TalkRealtimeClientSession?
    private var realtimePrefetchTask: Task<Void, Never>?
    private var realtimePrefetchGeneration: UInt64 = 0

    private var lastHeard: Date?
    private var lastTranscript: String = ""
    private var loggedPartialThisCycle: Bool = false
    private var lastSpokenText: String?
    private var lastInterruptedAtSeconds: Double?

    private var defaultVoiceId: String?
    private var currentVoiceId: String?
    private var defaultModelId: String?
    private var currentModelId: String?
    private var configuredProviderModelId: String?
    private var voiceOverrideActive = false
    private var modelOverrideActive = false
    private var defaultOutputFormat: String?
    private var activeTalkProvider: String = TalkModeManager.defaultTalkProvider
    private var executionMode: TalkModeExecutionMode = .native
    private var runtimeRoute: TalkModeRuntimeRoute = .localElevenLabs
    private var realtimeProvider: String?
    private var realtimeModelId: String?
    private var realtimeVoiceId: String?
    private var configuredVoiceModeDescriptor = TalkVoiceModeDescriptor(
        title: "Not loaded",
        subtitle: nil,
        providerId: nil,
        modelId: nil,
        voiceId: nil,
        transport: nil,
        isRealtime: false)
    private var pendingRealtimeIssue: TalkRuntimeIssue?
    private var realtimeRelayStartIssue: TalkRuntimeIssue?
    private var apiKey: String?
    private var voiceAliases: [String: String] = [:]
    private var interruptOnSpeech: Bool = true
    private var gatewaySpeechLocaleID: String?
    private var mainSessionKey: String = "main"
    private var fallbackVoiceId: String?
    private var lastPlaybackWasPCM: Bool = false
    private var speechGeneration = 0
    /// Set when the ElevenLabs API rejects PCM format (e.g. 403 subscription_required).
    /// Once set, all subsequent requests in this session use MP3 instead of re-trying PCM.
    private var pcmFormatUnavailable: Bool = false
    var pcmPlayer: PCMStreamingAudioPlaying = PCMStreamingAudioPlayer.shared
    var mp3Player: StreamingAudioPlaying = StreamingAudioPlayer.shared
    var bufferedPlayer: TalkBufferedAudioPlaying = TalkBufferedAudioPlayer.shared

    /// Meters PCM speech bytes on their way into the streaming player so the
    /// speaking waveform tracks the audible envelope, not network arrival.
    @ObservationIgnored private lazy var pcmPlaybackEnvelope = PCMPlaybackEnvelope { [weak self] level in
        self?.playbackLevel = level
    }

    private var gateway: GatewayNodeSession?
    private var gatewayConnected = false
    private var talkConfigLoadedAt: Date?
    private var silenceWindow: TimeInterval = .init(TalkModeManager.defaultSilenceTimeoutMs) / 1000
    private var lastAudioActivity: Date?
    private var noiseFloorSamples: [Double] = []
    private var noiseFloor: Double?
    private var noiseFloorReady: Bool = false

    private var chatSubscribedSessionKeys = Set<String>()
    private var incrementalSpeechQueue: [String] = []
    private var incrementalSpeechTask: Task<Void, Never>?
    private var incrementalSpeechActive = false
    private var incrementalSpeechUsed = false
    private var incrementalSpeechLanguage: String?
    private var incrementalSpeechBuffer = IncrementalSpeechBuffer()
    private var incrementalSpeechContext: IncrementalSpeechContext?
    private var incrementalSpeechDirective: TalkDirective?
    private var incrementalSpeechPrefetch: IncrementalSpeechPrefetchState?
    private var incrementalSpeechPrefetchMonitorTask: Task<Void, Never>?

    private let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "TalkMode")

    private static func nowSeconds() -> TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }

    private static func elapsedMs(since start: TimeInterval) -> Int {
        max(0, Int((self.nowSeconds() - start) * 1000))
    }

    private static func shouldRestartRealtimeSession(
        isEnabled: Bool,
        gatewayConnected: Bool,
        captureIsContinuous: Bool) -> Bool
    {
        isEnabled && gatewayConnected && captureIsContinuous
    }

    private static func realtimeRestartAttempt(
        previousRapidRestarts: Int,
        activeDuration: TimeInterval) -> Int
    {
        activeDuration >= self.realtimeStableSessionSeconds ? 1 : previousRapidRestarts + 1
    }

    private static func realtimeRestartDelayNanoseconds(attempt: Int) -> UInt64? {
        guard attempt > 0, attempt <= self.realtimeRestartDelaysNanoseconds.count else { return nil }
        return self.realtimeRestartDelaysNanoseconds[attempt - 1]
    }

    private func resetRealtimeRestartState() {
        self.realtimeRestartGeneration += 1
        self.realtimeSessionReadyAt = nil
        self.rapidRealtimeRestartCount = 0
        self.bypassRealtimeOnNextStart = false
    }

    private func markRealtimeSessionReady() {
        self.isListening = true
        if self.captureMode != .pushToTalk {
            self.captureMode = .continuous
        }
        if self.realtimeSessionReadyAt == nil {
            self.realtimeSessionReadyAt = Date()
        }
        self.markRealtimeActive()
    }

    private func scheduleRealtimeRestart(after delayNanoseconds: UInt64?, generation: Int) {
        Task { [weak self] in
            if let delayNanoseconds {
                do {
                    try await Task.sleep(nanoseconds: delayNanoseconds)
                } catch {
                    return
                }
            }
            // A ready/close pair can arrive before the current start() unwinds. Wait for that
            // attempt instead of letting its isStarting guard consume the only recovery task.
            while self?.isStarting == true {
                do {
                    try await Task.sleep(nanoseconds: 50_000_000)
                } catch {
                    return
                }
                guard let self,
                      self.realtimeRestartGeneration == generation,
                      Self.shouldRestartRealtimeSession(
                          isEnabled: self.isEnabled,
                          gatewayConnected: self.gatewayConnected,
                          captureIsContinuous: self.captureMode == .continuous)
                else { return }
            }
            guard let self,
                  self.realtimeRestartGeneration == generation,
                  Self.shouldRestartRealtimeSession(
                      isEnabled: self.isEnabled,
                      gatewayConnected: self.gatewayConnected,
                      captureIsContinuous: self.captureMode == .continuous)
            else { return }
            await self.start()
        }
    }

    private func handleRealtimeSessionFinish() {
        // Provider sessions expire or disconnect while continuous Talk remains enabled. Explicit
        // stop/background paths clear one of these guards before closing either session type.
        let shouldRestart = Self.shouldRestartRealtimeSession(
            isEnabled: self.isEnabled,
            gatewayConnected: self.gatewayConnected,
            captureIsContinuous: self.captureMode == .continuous)
        let activeDuration = self.realtimeSessionReadyAt.map { Date().timeIntervalSince($0) } ?? 0
        self.realtimeSessionReadyAt = nil
        self.isListening = false
        self.isSpeaking = false
        self.isUserSpeechDetected = false
        self.gatewayTalkActiveModeTitle = "Not active"
        self.gatewayTalkActiveModeSubtitle = nil
        guard shouldRestart else {
            if self.isEnabled {
                self.statusText = self.gatewayConnected ? "Ready" : "Offline"
            }
            return
        }

        self.realtimeRestartGeneration += 1
        let restartGeneration = self.realtimeRestartGeneration
        let attempt = Self.realtimeRestartAttempt(
            previousRapidRestarts: self.rapidRealtimeRestartCount,
            activeDuration: activeDuration)
        self.rapidRealtimeRestartCount = attempt
        guard let delay = Self.realtimeRestartDelayNanoseconds(attempt: attempt) else {
            let issue = self.realtimeIssue(
                message: "Realtime disconnected repeatedly.",
                phase: "reconnect")
            self.pendingRealtimeIssue = issue
            self.gatewayTalkLastIssueText = issue.diagnosticSummary
            self.bypassRealtimeOnNextStart = true
            self.scheduleRealtimeRestart(after: nil, generation: restartGeneration)
            return
        }
        self.statusText = "Reconnecting"
        self.scheduleRealtimeRestart(after: delay, generation: restartGeneration)
    }

    init(
        allowSimulatorCapture: Bool = false,
        gatewaySpeechSynthesizer: (any TalkGatewaySpeechSynthesizing)? = nil)
    {
        self.allowSimulatorCapture = allowSimulatorCapture
        self.gatewaySpeechSynthesizerOverride = gatewaySpeechSynthesizer
        super.init()
    }

    func attachGateway(_ gateway: GatewayNodeSession) {
        self.gateway = gateway
    }

    func updateGatewayConnected(_ connected: Bool) {
        self.gatewayConnected = connected
        if connected {
            // If talk mode is enabled before the gateway connects (common on cold start),
            // kick recognition once we're online so the UI doesn’t stay “Offline”.
            if self.isEnabled, !self.isListening, self.captureMode != .pushToTalk {
                Task { await self.start() }
            }
        } else {
            self.resetRealtimeRestartState()
            self.stopRealtimeSession()
            self.gatewayTalkActiveModeTitle = "Not active"
            self.gatewayTalkActiveModeSubtitle = nil
            if self.isEnabled, !self.isSpeaking {
                self.statusText = "Offline"
            }
            self.realtimePrefetchGeneration &+= 1
            self.realtimePrefetchTask?.cancel()
            self.realtimePrefetchTask = nil
            self.prefetchedRealtimeSession = nil
        }
    }

    func updateMainSessionKey(_ sessionKey: String?) {
        let trimmed = (sessionKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if trimmed == self.mainSessionKey { return }
        self.mainSessionKey = trimmed
        if self.gatewayConnected, self.isEnabled {
            Task { await self.subscribeChatIfNeeded(sessionKey: trimmed) }
        }
    }

    func enterScreenshotFixtureMode() {
        self.updateGatewayConnected(true)
        self.isEnabled = false
        self.isListening = false
        self.isSpeaking = false
        self.isUserSpeechDetected = false
        self.statusText = "Ready"
        self.gatewayTalkConfigLoaded = true
        self.gatewayTalkApiKeyConfigured = true
        self.gatewayTalkDefaultModelId = "gpt-realtime-2"
        self.gatewayTalkDefaultVoiceId = "marin"
        self.gatewayTalkProviderLabel = "OpenAI"
        self.gatewayTalkTransportLabel = "Gateway Relay"
        self.gatewayTalkUsesRealtime = true
        self.gatewayTalkUsesRealtimeRelay = true
        self.gatewayTalkRealtimeProviderLabel = "OpenAI"
        self.gatewayTalkRealtimeModelId = "gpt-realtime-2"
        self.gatewayTalkRealtimeVoiceId = "marin"
        self.gatewayTalkVoiceModeTitle = "Realtime Voice"
        self.gatewayTalkVoiceModeSubtitle = "Gateway relay ready"
        self.gatewayTalkVoiceModeAccessibilityValue = "Realtime Voice, Gateway relay ready"
        self.gatewayTalkActiveModeTitle = "Ready"
        self.gatewayTalkActiveModeSubtitle = "Listening starts from this phone"
        self.gatewayTalkLastIssueText = nil
        self.gatewayTalkCurrentFallbackIssue = nil
        self.gatewayTalkPermissionState = .ready
    }

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        if enabled {
            self.logger.info("enabled")
            GatewayDiagnostics.log("talk.timeline manager enabled")
            Task { await self.start() }
        } else {
            self.logger.info("disabled")
            GatewayDiagnostics.log("talk.timeline manager disabled")
            self.stop()
        }
    }

    func applyProviderSelectionChanged() {
        let shouldRestart = self.isEnabled
        if shouldRestart {
            self.stop()
            self.isEnabled = true
            Task { await self.start() }
        } else {
            Task { await self.reloadConfig() }
        }
    }

    func applyAudioRoutePreferenceChanged() {
        guard self.isEnabled || self.isListening || self.isSpeaking else { return }
        do {
            if let realtimeSession {
                try realtimeSession.applyAudioRoutePreferenceChanged()
            } else if self.realtimeRelaySession != nil {
                try Self.configureRealtimeAudioSession()
            } else {
                try Self.configureAudioSession()
            }
        } catch {
            GatewayDiagnostics.log("talk audio route preference failed error=\(error.localizedDescription)")
        }
    }

    func start() async {
        GatewayDiagnostics.log(
            "talk.timeline manager start enter enabled=\(self.isEnabled) "
                + "listening=\(self.isListening) gatewayConnected=\(self.gatewayConnected)")
        guard self.isEnabled else { return }
        guard self.captureMode != .pushToTalk else { return }
        guard self.foregroundAudioCaptureAllowed else {
            self.statusText = "Paused"
            GatewayDiagnostics.log("talk start ignored: app backgrounded")
            return
        }
        if self.isListening { return }
        guard !self.isStarting else {
            GatewayDiagnostics.log("talk start ignored: already starting")
            return
        }
        guard self.gatewayConnected else {
            self.statusText = "Offline"
            GatewayDiagnostics.log("talk.timeline manager start blocked gateway offline")
            return
        }

        self.isStarting = true
        self.startAttemptID += 1
        let attemptID = self.startAttemptID
        defer {
            if self.startAttemptID == attemptID {
                self.isStarting = false
            }
        }
        self.logger.info("start")
        self.statusText = "Requesting permissions…"
        let permissionStartedAt = Self.nowSeconds()
        let micOk = await Self.requestMicrophonePermission()
        GatewayDiagnostics.log(
            "talk.timeline microphone permission ok=\(micOk) "
                + "elapsedMs=\(Self.elapsedMs(since: permissionStartedAt))")
        guard micOk else {
            self.logger.warning("start blocked: microphone permission denied")
            self.statusText = "Microphone permission denied"
            return
        }
        guard self.isCurrentStartAttempt(attemptID) else { return }
        await ensureTalkConfigLoadedForStart()
        guard self.isCurrentStartAttempt(attemptID) else { return }
        if self.gatewayTalkPermissionState.requiresTalkPermissionAction {
            self.statusText = "Gateway permission required"
            GatewayDiagnostics.log("talk.timeline manager start blocked gateway permission")
            return
        }
        let bypassRealtime = self.bypassRealtimeOnNextStart
        self.bypassRealtimeOnNextStart = false
        if self.runtimeRoute.usesRealtime, !bypassRealtime {
            let realtimeStart = self.executionMode == .realtimeRelay
                ? await self.startRealtimeRelayIfAvailable()
                : await self.startRealtimeIfAvailable()
            switch realtimeStart {
            case .started, .ignored:
                return
            case let .unavailable(issue):
                self.pendingRealtimeIssue = issue
                self.gatewayTalkLastIssueText = issue.diagnosticSummary
            }
        }

        let speechOk = await Self.requestSpeechPermission()
        guard speechOk else {
            self.logger.warning("start blocked: speech permission denied")
            self.statusText = Self.permissionMessage(
                kind: "Speech recognition",
                status: SFSpeechRecognizer.authorizationStatus())
            return
        }
        guard self.isCurrentStartAttempt(attemptID) else { return }

        do {
            GatewayDiagnostics.log("talk.timeline fallback speech pipeline start")
            try Self.configureAudioSession()
            // Set this before starting recognition so any early speech errors are classified correctly.
            self.captureMode = .continuous
            try self.startRecognition()
            self.isListening = true
            if let issue = pendingRealtimeIssue {
                markNativeFallbackActive(after: issue)
            } else {
                markNativeTalkActive()
            }
            self.startSilenceMonitor()
            await self.subscribeChatIfNeeded(sessionKey: self.mainSessionKey)
            self.logger.info("listening")
        } catch {
            self.isListening = false
            self.statusText = "Start failed: \(error.localizedDescription)"
            self.logger.error("start failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func isCurrentStartAttempt(_ attemptID: Int) -> Bool {
        self.startAttemptID == attemptID && self.isEnabled && self.captureMode != .pushToTalk
    }

    private func cancelPendingStart() {
        self.startAttemptID += 1
        self.isStarting = false
    }

    private var talkProviderSelection: TalkModeProviderSelection {
        TalkModeProviderSelection.resolved(
            UserDefaults.standard.string(forKey: TalkModeProviderSelection.storageKey))
    }

    private var shouldUseOpenAIRealtimeSelectionFallback: Bool {
        self.talkProviderSelection == .openAIRealtime
    }

    private func applyOpenAIRealtimeSelectionDefaults() {
        let realtimeVoiceOverride = TalkModeRealtimeVoiceSelection.resolvedOverride(
            UserDefaults.standard.string(forKey: TalkModeRealtimeVoiceSelection.storageKey))
        self.activeTalkProvider = "openai"
        self.executionMode = .realtimeWebRTC
        self.runtimeRoute = .realtimeWebRTC
        self.realtimeProvider = "openai"
        self.realtimeModelId = Self.defaultRealtimeModelIdFallback
        self.realtimeVoiceId = realtimeVoiceOverride
        self.gatewayTalkProviderLabel = TalkModeProviderSelection.openAIRealtime.label
        self.gatewayTalkUsesRealtime = true
        self.gatewayTalkUsesRealtimeRelay = false
        self.gatewayTalkTransportLabel = "Native WebRTC"
        self.gatewayTalkRealtimeProviderLabel = Self.displayName(forProvider: self.realtimeProvider ?? "openai")
        self.gatewayTalkRealtimeModelId = self.realtimeModelId
        self.gatewayTalkRealtimeVoiceId = self.realtimeVoiceId
        self.gatewayTalkDefaultModelId = self.realtimeModelId
        self.gatewayTalkDefaultVoiceId = self.realtimeVoiceId
        self.gatewayTalkApiKeyConfigured = true
    }

    func stop() {
        self.isEnabled = false
        self.cancelPendingStart()
        self.isListening = false
        self.isUserSpeechDetected = false
        self.isPushToTalkActive = false
        self.captureMode = .idle
        self.statusText = "Off"
        self.pendingRealtimeIssue = nil
        self.gatewayTalkCurrentFallbackIssue = nil
        self.gatewayTalkActiveModeTitle = "Not active"
        self.gatewayTalkActiveModeSubtitle = nil
        self.gatewayTalkLastIssueText = nil
        self.lastTranscript = ""
        self.lastHeard = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.resetRealtimeRestartState()
        self.stopRealtimeSession()
        self.stopRecognition()
        self.stopSpeaking()
        self.lastInterruptedAtSeconds = nil
        let pendingPTT = self.pttCompletion != nil
        let pendingCaptureId = self.activePTTCaptureId ?? UUID().uuidString
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false
        if pendingPTT {
            let payload = OpenClawTalkPTTStopPayload(
                captureId: pendingCaptureId,
                transcript: nil,
                status: "cancelled")
            self.finishPTTOnce(payload)
        }
        self.resumeContinuousAfterPTT = false
        self.activePTTCaptureId = nil
        TalkSystemSpeechSynthesizer.shared.stop()
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            self.logger.warning("audio session deactivate failed: \(error.localizedDescription, privacy: .public)")
        }
        Task { await self.unsubscribeAllChats() }
    }

    /// Suspends microphone usage without disabling Talk Mode.
    /// Used when the app backgrounds (or when we need to temporarily release the mic).
    func suspendForBackground(keepActive: Bool = false) -> Bool {
        guard self.isEnabled else { return false }
        if keepActive {
            self.statusText = self.isListening ? "Listening" : self.statusText
            return false
        }
        let wasActive = self.isListening || self.isSpeaking || self.isPushToTalkActive

        self.cancelPendingStart()
        self.isListening = false
        self.isPushToTalkActive = false
        self.captureMode = .idle
        self.statusText = "Paused"
        self.gatewayTalkActiveModeTitle = "Paused"
        self.gatewayTalkActiveModeSubtitle = nil
        self.lastTranscript = ""
        self.lastHeard = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil

        self.resetRealtimeRestartState()
        self.stopRealtimeSession()
        self.stopRecognition()
        self.stopSpeaking()
        self.lastInterruptedAtSeconds = nil
        TalkSystemSpeechSynthesizer.shared.stop()

        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            self.logger.warning("audio session deactivate failed: \(error.localizedDescription, privacy: .public)")
        }

        Task { await self.unsubscribeAllChats() }
        return wasActive
    }

    func resumeAfterBackground(wasSuspended: Bool, wasKeptActive: Bool = false) async {
        if wasKeptActive { return }
        guard wasSuspended else { return }
        guard self.isEnabled else { return }
        await self.start()
    }

    func beginPushToTalk() async throws -> OpenClawTalkPTTStartPayload {
        guard self.gatewayConnected else {
            self.statusText = "Offline"
            throw NSError(domain: "TalkMode", code: 7, userInfo: [
                NSLocalizedDescriptionKey: "Gateway not connected",
            ])
        }
        if self.isPushToTalkActive, let captureId = activePTTCaptureId {
            return OpenClawTalkPTTStartPayload(captureId: captureId)
        }

        self.stopSpeaking(storeInterruption: false)
        self.cancelPendingStart()
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false

        self.resumeContinuousAfterPTT = self.isEnabled && self.captureMode == .continuous
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.stopRecognition()
        self.isListening = false
        self.isUserSpeechDetected = false

        let captureId = UUID().uuidString
        self.activePTTCaptureId = captureId
        self.lastTranscript = ""
        self.lastHeard = nil

        self.statusText = "Requesting permissions…"
        if !self.allowSimulatorCapture {
            let micOk = await Self.requestMicrophonePermission()
            guard micOk else {
                self.statusText = "Microphone permission denied"
                throw NSError(domain: "TalkMode", code: 4, userInfo: [
                    NSLocalizedDescriptionKey: "Microphone permission denied",
                ])
            }
            let speechOk = await Self.requestSpeechPermission()
            guard speechOk else {
                self.statusText = Self.permissionMessage(
                    kind: "Speech recognition",
                    status: SFSpeechRecognizer.authorizationStatus())
                throw NSError(domain: "TalkMode", code: 5, userInfo: [
                    NSLocalizedDescriptionKey: "Speech recognition permission denied",
                ])
            }
        }

        do {
            try Self.configureAudioSession()
            self.captureMode = .pushToTalk
            try self.startRecognition()
            self.isListening = true
            self.isPushToTalkActive = true
            self.statusText = "Listening (PTT)"
        } catch {
            self.isListening = false
            self.isUserSpeechDetected = false
            self.isPushToTalkActive = false
            self.captureMode = .idle
            self.statusText = "Start failed: \(error.localizedDescription)"
            throw error
        }

        return OpenClawTalkPTTStartPayload(captureId: captureId)
    }

    func endPushToTalk() async -> OpenClawTalkPTTStopPayload {
        let captureId = self.activePTTCaptureId ?? UUID().uuidString
        guard self.isPushToTalkActive else {
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "idle")
            self.finishPTTOnce(payload)
            return payload
        }

        self.isPushToTalkActive = false
        self.isListening = false
        self.isUserSpeechDetected = false
        self.captureMode = .idle
        self.stopRecognition()
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false

        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        self.lastTranscript = ""
        self.lastHeard = nil

        guard !transcript.isEmpty else {
            self.statusText = "Ready"
            if self.resumeContinuousAfterPTT {
                await self.start()
            }
            self.resumeContinuousAfterPTT = false
            self.activePTTCaptureId = nil
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "empty")
            self.finishPTTOnce(payload)
            return payload
        }

        guard self.gatewayConnected else {
            self.statusText = "Gateway not connected"
            if self.resumeContinuousAfterPTT {
                await self.start()
            }
            self.resumeContinuousAfterPTT = false
            self.activePTTCaptureId = nil
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: transcript,
                status: "offline")
            self.finishPTTOnce(payload)
            return payload
        }

        self.statusText = "Thinking…"
        Task { @MainActor in
            await self.processTranscript(transcript, restartAfter: self.resumeContinuousAfterPTT)
        }
        self.resumeContinuousAfterPTT = false
        self.activePTTCaptureId = nil
        let payload = OpenClawTalkPTTStopPayload(
            captureId: captureId,
            transcript: transcript,
            status: "queued")
        self.finishPTTOnce(payload)
        return payload
    }

    func runPushToTalkOnce(maxDurationSeconds: TimeInterval = 12) async throws -> OpenClawTalkPTTStopPayload {
        if self.pttCompletion != nil {
            _ = await self.cancelPushToTalk()
        }

        if self.isPushToTalkActive {
            let captureId = self.activePTTCaptureId ?? UUID().uuidString
            return OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "busy")
        }

        _ = try await self.beginPushToTalk()

        return await withCheckedContinuation { cont in
            self.pttCompletion = cont
            self.pttAutoStopEnabled = true
            self.startSilenceMonitor()
            self.schedulePTTTimeout(seconds: maxDurationSeconds)
        }
    }

    func cancelPushToTalk() async -> OpenClawTalkPTTStopPayload {
        let captureId = self.activePTTCaptureId ?? UUID().uuidString
        guard self.isPushToTalkActive else {
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "idle")
            self.finishPTTOnce(payload)
            self.pttAutoStopEnabled = false
            self.pttTimeoutTask?.cancel()
            self.pttTimeoutTask = nil
            self.resumeContinuousAfterPTT = false
            self.activePTTCaptureId = nil
            return payload
        }

        let shouldResume = self.resumeContinuousAfterPTT
        self.isPushToTalkActive = false
        self.isListening = false
        self.captureMode = .idle
        self.stopRecognition()
        self.lastTranscript = ""
        self.lastHeard = nil
        self.pttAutoStopEnabled = false
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.resumeContinuousAfterPTT = false
        self.activePTTCaptureId = nil
        self.statusText = "Ready"

        let payload = OpenClawTalkPTTStopPayload(
            captureId: captureId,
            transcript: nil,
            status: "cancelled")
        self.finishPTTOnce(payload)

        if shouldResume {
            await self.start()
        }
        return payload
    }

    private func startRecognition() throws {
        #if targetEnvironment(simulator)
        if self.allowSimulatorCapture {
            self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
            self.recognitionRequest?.shouldReportPartialResults = true
            return
        }
        if !self.allowSimulatorCapture {
            throw NSError(domain: "TalkMode", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Talk mode is not supported on the iOS simulator",
            ])
        }
        #endif

        self.stopRecognition()
        let localSpeechLocale = UserDefaults.standard.string(forKey: TalkSpeechLocale.storageKey)
        let resolvedSpeech = TalkSpeechLocale.makeRecognizer(
            localSelection: localSpeechLocale,
            gatewaySelection: self.gatewaySpeechLocaleID)
        self.speechRecognizer = resolvedSpeech.recognizer
        guard let recognizer = speechRecognizer else {
            throw NSError(domain: "TalkMode", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Speech recognizer unavailable",
            ])
        }
        GatewayDiagnostics.log("talk speech: locale=\(resolvedSpeech.localeID ?? "default")")

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest?.shouldReportPartialResults = true
        self.recognitionRequest?.taskHint = .dictation
        guard let request = recognitionRequest else { return }

        GatewayDiagnostics.log("talk audio: session \(Self.describeAudioSession())")

        let input = self.audioEngine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "TalkMode", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Invalid audio input format",
            ])
        }
        input.removeTap(onBus: 0)
        let tapDiagnostics = AudioTapDiagnostics(label: "talk") { [weak self] level in
            guard let self else { return }
            Task { @MainActor in
                // Smooth + clamp for UI, and keep it cheap.
                let raw = max(0, min(Double(level) * 10.0, 1.0))
                let next = (self.micLevel * 0.80) + (raw * 0.20)
                self.micLevel = next

                // Dynamic thresholding so background noise doesn’t prevent endpointing.
                if self.isListening, !self.isSpeaking, !self.noiseFloorReady {
                    self.noiseFloorSamples.append(raw)
                    if self.noiseFloorSamples.count >= 22 {
                        let sorted = self.noiseFloorSamples.sorted()
                        let take = max(6, sorted.count / 2)
                        let slice = sorted.prefix(take)
                        let avg = slice.reduce(0.0, +) / Double(slice.count)
                        self.noiseFloor = avg
                        self.noiseFloorReady = true
                        self.noiseFloorSamples.removeAll(keepingCapacity: true)
                        let threshold = min(0.35, max(0.12, avg + 0.10))
                        GatewayDiagnostics.log(
                            "talk audio: noiseFloor=\(String(format: "%.3f", avg)) "
                                + "threshold=\(String(format: "%.3f", threshold))")
                    }
                }

                let threshold: Double = if let floor = self.noiseFloor, self.noiseFloorReady {
                    min(0.35, max(0.12, floor + 0.10))
                } else {
                    0.18
                }
                if raw >= threshold {
                    self.lastAudioActivity = Date()
                }
            }
        }
        self.audioTapDiagnostics = tapDiagnostics
        let tapBlock = Self.makeAudioTapAppendCallback(request: request, diagnostics: tapDiagnostics)
        input.installTap(onBus: 0, bufferSize: 2048, format: format, block: tapBlock)
        self.inputTapInstalled = true

        self.audioEngine.prepare()
        try self.audioEngine.start()
        self.loggedPartialThisCycle = false

        GatewayDiagnostics.log(
            "talk speech: recognition started mode=\(String(describing: self.captureMode)) "
                + "engineRunning=\(self.audioEngine.isRunning)")
        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let error {
                let msg = error.localizedDescription
                let lowered = msg.lowercased()
                let isCancellation = lowered.contains("cancelled") || lowered.contains("canceled")
                if isCancellation {
                    GatewayDiagnostics.log("talk speech: cancelled")
                    if self.captureMode == .continuous, self.isEnabled, !self.isSpeaking {
                        self.statusText = "Listening"
                    }
                    self.logger.debug("speech recognition cancelled")
                    return
                }
                GatewayDiagnostics.log("talk speech: error=\(msg)")
                if !self.isSpeaking {
                    if msg.localizedCaseInsensitiveContains("no speech detected") {
                        // Treat as transient silence. Don't scare users with an error banner.
                        self.statusText = self.isEnabled ? "Listening" : "Speech error: \(msg)"
                    } else {
                        self.statusText = "Speech error: \(msg)"
                    }
                }
                self.logger.debug("speech recognition error: \(msg, privacy: .public)")
                // Speech recognition can terminate on transient errors (e.g. no speech detected).
                // If talk mode is enabled and we're in continuous capture, try to restart.
                if self.captureMode == .continuous, self.isEnabled, !self.isSpeaking {
                    // Treat the task as terminal on error so we don't get stuck with a dead recognizer.
                    self.stopRecognition()
                    Task { @MainActor [weak self] in
                        await self?.restartRecognitionAfterError()
                    }
                }
            }
            guard let result else { return }
            let transcript = result.bestTranscription.formattedString
            if !result.isFinal, !self.loggedPartialThisCycle {
                let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    self.loggedPartialThisCycle = true
                    GatewayDiagnostics.log("talk speech: partial chars=\(trimmed.count)")
                }
            }
            Task { @MainActor in
                await self.handleTranscript(transcript: transcript, isFinal: result.isFinal)
            }
        }
    }

    private func restartRecognitionAfterError() async {
        guard self.isEnabled, self.captureMode == .continuous else { return }
        // Avoid thrashing the audio engine if it’s already running.
        if self.recognitionTask != nil, self.audioEngine.isRunning { return }
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard self.isEnabled, self.captureMode == .continuous else { return }
        do {
            try Self.configureAudioSession()
            try self.startRecognition()
            self.isListening = true
            if self.statusText.localizedCaseInsensitiveContains("speech error") {
                self.statusText = "Listening"
            }
            GatewayDiagnostics.log("talk speech: recognition restarted")
        } catch {
            let msg = error.localizedDescription
            GatewayDiagnostics.log("talk speech: restart failed error=\(msg)")
        }
    }

    private func stopRecognition() {
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.micLevel = 0
        self.lastAudioActivity = nil
        self.noiseFloorSamples.removeAll(keepingCapacity: true)
        self.noiseFloor = nil
        self.noiseFloorReady = false
        self.audioTapDiagnostics = nil
        if self.inputTapInstalled {
            self.audioEngine.inputNode.removeTap(onBus: 0)
            self.inputTapInstalled = false
        }
        self.audioEngine.stop()
        self.speechRecognizer = nil
    }

    private nonisolated static func makeAudioTapAppendCallback(
        request: SpeechRequest,
        diagnostics: AudioTapDiagnostics) -> AVAudioNodeTapBlock
    {
        { buffer, _ in
            request.append(buffer)
            diagnostics.onBuffer(buffer)
        }
    }

    private func handleTranscript(transcript: String, isFinal: Bool) async {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let ttsActive = self.isSpeechOutputActive
        if ttsActive, self.interruptOnSpeech {
            if self.shouldInterrupt(with: trimmed) {
                self.stopSpeaking()
            }
            return
        }

        guard self.isListening else { return }
        if !trimmed.isEmpty {
            self.lastTranscript = trimmed
            self.lastHeard = Date()
        }
        if isFinal {
            self.lastTranscript = trimmed
            guard !trimmed.isEmpty else { return }
            GatewayDiagnostics.log("talk speech: final transcript chars=\(trimmed.count)")
            self.loggedPartialThisCycle = false
            if self.captureMode == .pushToTalk, self.pttAutoStopEnabled, self.isPushToTalkActive {
                _ = await self.endPushToTalk()
                return
            }
            if self.captureMode == .continuous, !self.isSpeechOutputActive {
                await self.processTranscript(trimmed, restartAfter: true)
            }
        }
    }

    private func startSilenceMonitor() {
        self.silenceTask?.cancel()
        self.silenceTask = Task { [weak self] in
            guard let self else { return }
            while self.isEnabled || (self.isPushToTalkActive && self.pttAutoStopEnabled) {
                try? await Task.sleep(nanoseconds: 200_000_000)
                await self.checkSilence()
            }
        }
    }

    private func checkSilence() async {
        if self.captureMode == .continuous {
            guard self.isListening, !self.isSpeechOutputActive else { return }
            let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !transcript.isEmpty else { return }
            let lastActivity = [lastHeard, lastAudioActivity].compactMap(\.self).max()
            guard let lastActivity else { return }
            if Date().timeIntervalSince(lastActivity) < self.silenceWindow { return }
            await self.processTranscript(transcript, restartAfter: true)
            return
        }

        guard self.captureMode == .pushToTalk, self.pttAutoStopEnabled else { return }
        guard self.isListening, !self.isSpeaking, self.isPushToTalkActive else { return }
        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }
        let lastActivity = [lastHeard, lastAudioActivity].compactMap(\.self).max()
        guard let lastActivity else { return }
        if Date().timeIntervalSince(lastActivity) < self.silenceWindow { return }
        _ = await self.endPushToTalk()
    }

    /// Guardrail for PTT once so we don't stay open indefinitely.
    private func schedulePTTTimeout(seconds: TimeInterval) {
        guard seconds > 0 else { return }
        let nanos = UInt64(seconds * 1_000_000_000)
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanos)
            await self?.handlePTTTimeout()
        }
    }

    private func handlePTTTimeout() async {
        guard self.pttAutoStopEnabled, self.isPushToTalkActive else { return }
        _ = await self.endPushToTalk()
    }

    private func finishPTTOnce(_ payload: OpenClawTalkPTTStopPayload) {
        guard let continuation = pttCompletion else { return }
        self.pttCompletion = nil
        continuation.resume(returning: payload)
    }

    private func processTranscript(_ transcript: String, restartAfter: Bool) async {
        self.isListening = false
        self.isUserSpeechDetected = false
        self.captureMode = .idle
        self.statusText = "Thinking…"
        self.lastTranscript = ""
        self.lastHeard = nil
        self.stopRecognition()

        GatewayDiagnostics.log("talk: process transcript chars=\(transcript.count) restartAfter=\(restartAfter)")
        await reloadConfig()
        let prompt = self.buildPrompt(transcript: transcript)
        guard self.gatewayConnected, let gateway else {
            self.statusText = "Gateway not connected"
            self.logger.warning("finalize: gateway not connected")
            GatewayDiagnostics.log("talk: abort gateway not connected")
            if restartAfter {
                await self.start()
            }
            return
        }

        do {
            let startedAt = Date().timeIntervalSince1970
            let sessionKey = self.mainSessionKey
            await self.subscribeChatIfNeeded(sessionKey: sessionKey)
            self.logger.info(
                "chat.send start sessionKey=\(sessionKey, privacy: .public) chars=\(prompt.count, privacy: .public)")
            GatewayDiagnostics.log("talk: chat.send start sessionKey=\(sessionKey) chars=\(prompt.count)")
            let ack = try await sendChat(prompt, gateway: gateway)
            let runId = ack.runId
            let normalizedStatus = Self.normalizedChatSendStatus(ack.status)
            self.logger.info(
                "chat.send ok runId=\(runId, privacy: .public) status=\(normalizedStatus, privacy: .public)")
            GatewayDiagnostics.log("talk: chat.send ok runId=\(runId) status=\(normalizedStatus)")
            if Self.isTerminalChatSendFailure(ack.status) {
                self.statusText = normalizedStatus == "error" ? "Chat error" : "Aborted"
                self.logger.warning(
                    """
                    chat.send terminal ack runId=\(runId, privacy: .public) \
                    status=\(normalizedStatus, privacy: .public)
                    """)
                GatewayDiagnostics.log(
                    "talk: chat.send terminal ack runId=\(runId) status=\(normalizedStatus)")
                if restartAfter {
                    await self.start()
                }
                return
            }

            let shouldIncremental = self.shouldUseIncrementalTTS()
            var streamingTask: Task<Void, Never>?
            let completion: ChatCompletionResult
            if Self.isTerminalChatSendSuccess(ack.status) {
                GatewayDiagnostics.log("talk: chat.send terminal ok runId=\(runId); using history fallback")
                completion = ChatCompletionResult(state: .final, assistantText: nil)
            } else {
                if shouldIncremental {
                    self.resetIncrementalSpeech()
                    streamingTask = Task { @MainActor [weak self] in
                        guard let self else { return }
                        await self.streamAssistant(runId: runId, gateway: gateway)
                    }
                }
                completion = await self.waitForChatCompletion(runId: runId, gateway: gateway, timeoutSeconds: 120)
                if completion.state == .timeout {
                    self.logger.warning(
                        "chat completion timeout runId=\(runId, privacy: .public); attempting history fallback")
                    GatewayDiagnostics.log("talk: chat completion timeout runId=\(runId)")
                } else if completion.state == .aborted {
                    self.statusText = "Aborted"
                    self.logger.warning("chat completion aborted runId=\(runId, privacy: .public)")
                    GatewayDiagnostics.log("talk: chat completion aborted runId=\(runId)")
                    streamingTask?.cancel()
                    await self.finishIncrementalSpeech()
                    await self.start()
                    return
                } else if completion.state == .error {
                    self.statusText = "Chat error"
                    self.logger.warning("chat completion error runId=\(runId, privacy: .public)")
                    GatewayDiagnostics.log("talk: chat completion error runId=\(runId)")
                    streamingTask?.cancel()
                    await self.finishIncrementalSpeech()
                    await self.start()
                    return
                }
            }

            var assistantText = completion.assistantText
            if assistantText == nil, shouldIncremental {
                let fallback = self.incrementalSpeechBuffer.latestText
                if !fallback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    assistantText = fallback
                }
            }
            if assistantText == nil {
                assistantText = try await self.waitForAssistantTextFromHistory(
                    gateway: gateway,
                    since: Self.chatSendHistorySince(response: ack, startedAt: startedAt),
                    timeoutSeconds: completion.state == .final ? 12 : 25)
            }
            guard let assistantText else {
                self.statusText = "No reply"
                self.logger.warning("assistant text timeout runId=\(runId, privacy: .public)")
                GatewayDiagnostics.log("talk: assistant text timeout runId=\(runId)")
                streamingTask?.cancel()
                await self.finishIncrementalSpeech()
                await self.start()
                return
            }
            self.logger.info("assistant text ok chars=\(assistantText.count, privacy: .public)")
            GatewayDiagnostics.log("talk: assistant text ok chars=\(assistantText.count)")
            streamingTask?.cancel()
            if shouldIncremental {
                await self.handleIncrementalAssistantFinal(text: assistantText)
            } else {
                await self.playAssistant(text: assistantText)
            }
        } catch {
            self.statusText = "Talk failed: \(error.localizedDescription)"
            self.logger.error("finalize failed: \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("talk: failed error=\(error.localizedDescription)")
        }

        if restartAfter {
            await self.start()
        }
    }

    private func startRealtimeIfAvailable() async -> RealtimeStartResult {
        guard let gateway else {
            return .unavailable(realtimeIssue(message: "Gateway not connected", phase: "start"))
        }
        let startedAt = Self.nowSeconds()
        if self.prefetchedRealtimeSession == nil, let prefetchTask = realtimePrefetchTask {
            GatewayDiagnostics.log("talk.timeline realtime awaiting in-flight prefetch")
            await prefetchTask.value
        }
        let prefetchedSession = self.consumePrefetchedRealtimeSession()
        GatewayDiagnostics.log("talk.timeline realtime start attempt sessionKey=\(self.mainSessionKey)")
        let session = TalkRealtimeWebRTCSession(
            gateway: gateway,
            sessionKey: mainSessionKey,
            delegate: self)
        self.realtimeSession = session
        do {
            try await session.start(
                provider: self.realtimeProvider,
                model: self.realtimeModelId,
                voice: self.realtimeVoiceId,
                prefetchedSession: prefetchedSession)
            guard self.realtimeSession === session, self.isEnabled else {
                session.stop()
                return .ignored
            }
            self.markRealtimeSessionReady()
            GatewayDiagnostics.log(
                "talk.timeline realtime start ready elapsedMs=\(Self.elapsedMs(since: startedAt))")
            GatewayDiagnostics.log("talk realtime: started direct OpenAI WebRTC session")
            return .started
        } catch {
            guard self.realtimeSession === session, self.isEnabled else {
                session.stop()
                return .ignored
            }
            self.stopRealtimeSession()
            let issue = realtimeIssue(from: error, phase: "start")
            GatewayDiagnostics
                .log("talk realtime: unavailable; falling back to speech pipeline error=\(error.localizedDescription)")
            GatewayDiagnostics.log(
                "talk.timeline realtime start failed elapsedMs=\(Self.elapsedMs(since: startedAt)) "
                    + "error=\(error.localizedDescription)")
            return .unavailable(issue)
        }
    }

    private func startRealtimeRelayIfAvailable() async -> RealtimeStartResult {
        guard let gateway else {
            return .unavailable(realtimeIssue(message: "Gateway not connected", phase: "start"))
        }
        guard self.foregroundAudioCaptureAllowed else {
            self.statusText = "Paused"
            GatewayDiagnostics.log("talk realtime ignored: app backgrounded")
            return .ignored
        }
        if self.realtimeRelaySession != nil {
            self.captureMode = .continuous
            self.isListening = true
            GatewayDiagnostics.log("talk realtime ignored: already active")
            return .started
        }
        guard !self.realtimeRelayStartInFlight else {
            GatewayDiagnostics.log("talk realtime ignored: already starting")
            return .ignored
        }
        self.realtimeRelayStartInFlight = true
        defer { self.realtimeRelayStartInFlight = false }
        prepareRealtimeRelayStart()
        GatewayDiagnostics.log("talk.timeline realtime relay start attempt sessionKey=\(self.mainSessionKey)")
        let startedAt = Self.nowSeconds()
        let relaySession = RealtimeTalkRelaySession(
            gateway: gateway,
            options: RealtimeTalkRelaySession.Options(
                sessionKey: self.mainSessionKey,
                provider: self.realtimeProvider,
                model: self.realtimeModelId,
                voice: self.realtimeVoiceId),
            pcmPlayer: self.pcmPlayer,
            onStatus: { [weak self] status in
                guard let self else { return }
                self.handleRealtimeRelayStatus(status)
            },
            onIssue: { [weak self] issue in
                guard let self else { return }
                self.realtimeRelayStartIssue = issue
                self.pendingRealtimeIssue = issue
                self.gatewayTalkLastIssueText = issue.diagnosticSummary
                self.gatewayTalkActiveModeTitle = "Realtime unavailable"
                self.gatewayTalkActiveModeSubtitle = issue.displayMessage
            },
            onSpeakingChanged: { [weak self] speaking in
                guard let self else { return }
                self.isSpeaking = speaking
                if speaking {
                    self.isListening = false
                }
            },
            onInputLevel: { [weak self] level in
                guard let self, self.isListening else { return }
                // Same smoothing as the SFSpeech tap so route switches keep the wave feel.
                self.micLevel = (self.micLevel * 0.80) + (level * 0.20)
            },
            onOutputLevel: { [weak self] level in
                self?.playbackLevel = level
            })
        self.realtimeRelaySession = relaySession
        do {
            try Self.configureRealtimeAudioSession()
            try await relaySession.start()
            guard self.realtimeRelaySession === relaySession, self.isEnabled else {
                relaySession.stop()
                return .ignored
            }
            if let issue = realtimeRelayStartIssue {
                self.realtimeRelaySession = nil
                relaySession.stop()
                GatewayDiagnostics.log(
                    "talk.timeline realtime relay start unavailable elapsedMs=\(Self.elapsedMs(since: startedAt)) "
                        + "issue=\(issue.code.rawValue)")
                return .unavailable(issue)
            }
            self.markRealtimeSessionReady()
            self.realtimeRelayStartIssue = nil
            GatewayDiagnostics.log(
                "talk.timeline realtime relay start ready elapsedMs=\(Self.elapsedMs(since: startedAt))")
            return .started
        } catch {
            guard self.realtimeRelaySession === relaySession, self.isEnabled else {
                relaySession.stop()
                return .ignored
            }
            self.realtimeRelaySession = nil
            let issue = self.realtimeRelayStartIssue
                ?? realtimeIssue(from: error, phase: "start")
            self.realtimeRelayStartIssue = nil
            GatewayDiagnostics.log(
                "talk.timeline realtime relay start failed elapsedMs=\(Self.elapsedMs(since: startedAt)) "
                    + "error=\(error.localizedDescription)")
            return .unavailable(issue)
        }
    }

    func prefetchRealtimeSessionIfReady(
        reason: String,
        shouldApply: @escaping @MainActor @Sendable () -> Bool = { true }) async
    {
        guard self.gatewayConnected,
              self.realtimeSession == nil,
              self.realtimeRelaySession == nil,
              !self.isEnabled
        else { return }
        guard self.runtimeRoute.usesRealtime, self.executionMode != .realtimeRelay else { return }
        guard self.gatewayTalkPermissionState == .ready else { return }
        guard self.consumePrefetchedRealtimeSession(peekOnly: true) == nil else { return }
        guard self.realtimePrefetchTask == nil else { return }

        GatewayDiagnostics.log("talk.timeline realtime prefetch scheduled reason=\(reason)")
        self.realtimePrefetchGeneration &+= 1
        let prefetchGeneration = self.realtimePrefetchGeneration
        self.realtimePrefetchTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.realtimePrefetchGeneration == prefetchGeneration {
                    self.realtimePrefetchTask = nil
                }
            }
            let startedAt = Self.nowSeconds()
            do {
                guard !Task.isCancelled, shouldApply(), let gateway = self.gateway else { return }
                guard let route = await gateway.currentRoute() else { return }
                guard !Task.isCancelled, shouldApply() else { return }
                let session = try await self.createRealtimeClientSession(
                    gateway: gateway,
                    route: route,
                    provider: self.realtimeProvider,
                    model: self.realtimeModelId,
                    voice: self.realtimeVoiceId)
                guard !Task.isCancelled, shouldApply() else { return }
                self.prefetchedRealtimeSession = session
                GatewayDiagnostics.log(
                    "talk.timeline realtime prefetch ready elapsedMs=\(Self.elapsedMs(since: startedAt)) "
                        + "model=\(session.model ?? "unknown") voice=\(session.voice ?? "unknown")")
            } catch {
                guard !Task.isCancelled else { return }
                GatewayDiagnostics.log(
                    "talk.timeline realtime prefetch failed elapsedMs=\(Self.elapsedMs(since: startedAt)) "
                        + "error=\(error.localizedDescription)")
            }
        }
    }

    private func createRealtimeClientSession(
        gateway: GatewayNodeSession,
        route: GatewayNodeSessionRoute,
        provider: String?,
        model: String?,
        voice: String?) async throws -> TalkRealtimeClientSession
    {
        let params = TalkRealtimeClientCreateParams(provider: provider, model: model, voice: voice)
        let data = try JSONEncoder().encode(params)
        let json = String(data: data, encoding: .utf8)
        let res = try await gateway.request(
            method: "talk.client.create",
            paramsJSON: json,
            timeoutSeconds: 12,
            ifCurrentRoute: route)
        return try JSONDecoder().decode(TalkRealtimeClientSession.self, from: res)
    }

    private func consumePrefetchedRealtimeSession(peekOnly: Bool = false) -> TalkRealtimeClientSession? {
        guard let session = prefetchedRealtimeSession else { return nil }
        if let expiresAt = session.expiresAt {
            let usableUntil = expiresAt - Self.realtimePrefetchExpiryLeewaySeconds
            if Date().timeIntervalSince1970 >= usableUntil {
                GatewayDiagnostics.log("talk.timeline realtime prefetched session expired")
                self.prefetchedRealtimeSession = nil
                return nil
            }
        }
        if !peekOnly {
            self.prefetchedRealtimeSession = nil
            GatewayDiagnostics.log(
                "talk.timeline realtime using prefetched session model=\(session.model ?? "unknown") "
                    + "voice=\(session.voice ?? "unknown")")
        }
        return session
    }

    private func stopRealtimeSession() {
        self.realtimeSession?.stop()
        self.realtimeSession = nil
        self.realtimeRelaySession?.stop()
        self.realtimeRelaySession = nil
    }

    private func subscribeChatIfNeeded(sessionKey: String) async {
        let key = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        guard !self.chatSubscribedSessionKeys.contains(key) else { return }

        // Operator clients receive chat events without node-style subscriptions.
        self.chatSubscribedSessionKeys.insert(key)
    }

    private func unsubscribeAllChats() async {
        self.chatSubscribedSessionKeys.removeAll()
    }

    private func buildPrompt(transcript: String) -> String {
        let interrupted = self.lastInterruptedAtSeconds
        self.lastInterruptedAtSeconds = nil
        return TalkPromptBuilder.build(
            transcript: transcript,
            interruptedAtSeconds: interrupted,
            includeVoiceDirectiveHint: false)
    }

    private enum ChatCompletionState: CustomStringConvertible {
        case final
        case aborted
        case error
        case timeout

        var description: String {
            switch self {
            case .final: "final"
            case .aborted: "aborted"
            case .error: "error"
            case .timeout: "timeout"
            }
        }
    }

    private struct ChatCompletionResult {
        var state: ChatCompletionState
        var assistantText: String?
    }

    private static func normalizedChatSendStatus(_ status: String) -> String {
        status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func isTerminalChatSendSuccess(_ status: String) -> Bool {
        self.normalizedChatSendStatus(status) == "ok"
    }

    private static func isTerminalChatSendFailure(_ status: String) -> Bool {
        let normalized = self.normalizedChatSendStatus(status)
        return normalized == "timeout" || normalized == "error"
    }

    private static func chatSendHistorySince(
        response: OpenClawChatSendResponse,
        startedAt: Double) -> Double?
    {
        self.isTerminalChatSendSuccess(response.status) ? nil : startedAt
    }

    private func sendChat(_ message: String, gateway: GatewayNodeSession) async throws -> OpenClawChatSendResponse {
        let payload: [String: Any] = [
            "sessionKey": mainSessionKey,
            "message": message,
            "thinking": "low",
            "timeoutMs": 30000,
            "idempotencyKey": UUID().uuidString,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(
                domain: "TalkModeManager",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode chat payload"])
        }
        let res = try await gateway.request(method: "chat.send", paramsJSON: json, timeoutSeconds: 30)
        return try JSONDecoder().decode(OpenClawChatSendResponse.self, from: res)
    }

    private func waitForChatCompletion(
        runId: String,
        gateway: GatewayNodeSession,
        timeoutSeconds: Int = 120) async -> ChatCompletionResult
    {
        let stream = await gateway.subscribeServerEvents(bufferingNewest: 200)
        return await withTaskGroup(of: ChatCompletionResult.self) { group in
            group.addTask { [runId] in
                var latestAssistantText: String?
                for await evt in stream {
                    if Task.isCancelled {
                        return ChatCompletionResult(state: .timeout, assistantText: latestAssistantText)
                    }
                    guard let payload = evt.payload else { continue }
                    if evt.event == "chat" {
                        guard let chatEvent = try? GatewayPayloadDecoding.decode(
                            payload,
                            as: OpenClawChatEventPayload.self)
                        else {
                            continue
                        }
                        guard chatEvent.runId == runId else { continue }
                        if let text = OpenClawChatEventText.assistantText(from: chatEvent) {
                            latestAssistantText = text
                        }
                        switch chatEvent.state {
                        case "final":
                            return ChatCompletionResult(state: .final, assistantText: latestAssistantText)
                        case "aborted":
                            return ChatCompletionResult(state: .aborted, assistantText: nil)
                        case "error":
                            return ChatCompletionResult(state: .error, assistantText: nil)
                        default:
                            break
                        }
                    } else if evt.event == "agent" {
                        guard let agentEvent = try? GatewayPayloadDecoding.decode(
                            payload,
                            as: OpenClawAgentEventPayload.self)
                        else {
                            continue
                        }
                        guard agentEvent.runId == runId else { continue }
                        if agentEvent.stream == "assistant",
                           let text = agentEvent.data["text"]?.value as? String
                        {
                            latestAssistantText = text
                        } else if agentEvent.stream == "lifecycle" {
                            let phase = (agentEvent.data["phase"]?.value as? String)?.lowercased()
                            let status = (agentEvent.data["status"]?.value as? String)?.lowercased()
                            if phase == "end" || status == "ok" || status == "completed" || status == "success" {
                                return ChatCompletionResult(state: .final, assistantText: latestAssistantText)
                            }
                            if phase == "error" || status == "error" || status == "failed" {
                                return ChatCompletionResult(state: .error, assistantText: nil)
                            }
                            if phase == "aborted" || status == "aborted" || status == "cancelled" {
                                return ChatCompletionResult(state: .aborted, assistantText: nil)
                            }
                        }
                    }
                }
                return ChatCompletionResult(state: .timeout, assistantText: latestAssistantText)
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                return ChatCompletionResult(state: .timeout, assistantText: nil)
            }
            let result = await group.next() ?? ChatCompletionResult(state: .timeout, assistantText: nil)
            group.cancelAll()
            return result
        }
    }

    private func waitForAssistantTextFromHistory(
        gateway: GatewayNodeSession,
        since: Double?,
        timeoutSeconds: Int) async throws -> String?
    {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
        while Date() < deadline {
            if let text = try await fetchLatestAssistantText(gateway: gateway, since: since) {
                return text
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return nil
    }

    private func fetchLatestAssistantText(gateway: GatewayNodeSession, since: Double? = nil) async throws -> String? {
        let res = try await gateway.request(
            method: "chat.history",
            paramsJSON: "{\"sessionKey\":\"\(self.mainSessionKey)\"}",
            timeoutSeconds: 15)
        guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return nil }
        guard let messages = json["messages"] as? [[String: Any]] else { return nil }
        for msg in messages.reversed() {
            guard (msg["role"] as? String) == "assistant" else { continue }
            if let since, let timestamp = msg["timestamp"] as? Double,
               TalkHistoryTimestamp.isAfter(timestamp, sinceSeconds: since) == false
            {
                continue
            }
            guard let content = msg["content"] as? [[String: Any]] else { continue }
            let text = content.compactMap { $0["text"] as? String }.joined(separator: "\n")
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    private func playAssistant(text: String) async {
        let parsed = TalkDirectiveParser.parse(text)
        let directive = parsed.directive
        let cleaned = parsed.stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        self.applyDirective(directive)
        self.speechGeneration += 1
        let speechGeneration = self.speechGeneration

        self.statusText = "Generating voice…"
        self.isSpeaking = true
        self.lastSpokenText = cleaned
        defer {
            if self.speechGeneration == speechGeneration {
                self.stopRecognition()
                self.isSpeaking = false
                self.playbackLevel = nil
                self.restoreConfiguredVoiceModeDescriptor()
            }
        }

        let language = ElevenLabsTTSClient.validatedLanguage(directive?.language)
        if self.runtimeRoute.usesGatewayTalkSpeak {
            do {
                try await self.playGatewayTalkSpeak(
                    text: cleaned,
                    directive: directive,
                    generation: speechGeneration)
            } catch {
                guard self.speechGeneration == speechGeneration else { return }
                let errorMessage = error.localizedDescription
                self.logger.error("gateway TTS failed: \(errorMessage, privacy: .public); falling back to system voice")
                GatewayDiagnostics.log("talk tts: provider=system (gateway error) msg=\(error.localizedDescription)")
                do {
                    try await self.playSystemVoice(text: cleaned, language: language)
                } catch {
                    guard self.speechGeneration == speechGeneration else { return }
                    self.statusText = "Speak failed: \(error.localizedDescription)"
                    self.logger.error("system voice failed: \(error.localizedDescription, privacy: .public)")
                }
            }
            return
        }

        do {
            let started = Date()
            let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedVoice = resolveVoiceAlias(requestedVoice)
            if requestedVoice?.isEmpty == false, resolvedVoice == nil {
                self.logger.warning("unknown voice alias \(requestedVoice ?? "?", privacy: .public)")
            }

            let apiKey = self.resolvedElevenLabsAPIKey()
            let preferredVoice = resolvedVoice ?? self.currentVoiceId ?? self.defaultVoiceId
            let voiceId: String? = if let apiKey, !apiKey.isEmpty {
                await resolveVoiceId(preferred: preferredVoice, apiKey: apiKey)
            } else {
                nil
            }
            let canUseElevenLabs = (voiceId?.isEmpty == false) && (apiKey?.isEmpty == false)

            if canUseElevenLabs, let voiceId, let apiKey {
                GatewayDiagnostics.log("talk tts: provider=elevenlabs voiceId=\(voiceId)")
                let modelId = directive?.modelId ?? self.currentModelId ?? self.defaultModelId
                applyVoiceModeDescriptor(TalkVoiceModeDescriptorBuilder.build(
                    providerId: "elevenlabs",
                    providerLabel: Self.displayName(forProvider: "elevenlabs"),
                    modelId: modelId,
                    voiceId: voiceId,
                    transport: "native",
                    isRealtime: false))
                let desiredOutputFormat = (directive?.outputFormat ?? self.defaultOutputFormat)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let requestedOutputFormat = (desiredOutputFormat?.isEmpty == false) ? desiredOutputFormat : nil
                let outputFormat = ElevenLabsTTSClient.validatedOutputFormat(
                    requestedOutputFormat ?? self.effectiveDefaultOutputFormat)
                if outputFormat == nil, let requestedOutputFormat {
                    self.logger.warning(
                        "talk output_format unsupported for local playback: \(requestedOutputFormat, privacy: .public)")
                }

                if let modelId {
                    GatewayDiagnostics.log("talk tts: modelId=\(modelId)")
                }
                let request = self.makeElevenLabsTTSRequest(
                    text: cleaned,
                    directive: directive,
                    modelId: modelId,
                    outputFormat: outputFormat,
                    language: language)

                let client = ElevenLabsTTSClient(apiKey: apiKey)
                let rawStream = client.streamSynthesize(voiceId: voiceId, request: request)

                self.startSpeechInterruptionRecognitionIfNeeded()

                self.statusText = "Speaking…"
                let result = await self.playElevenLabsStream(
                    rawStream,
                    sampleRate: TalkTTSValidation.pcmSampleRate(from: outputFormat))
                { mp3Format in
                    client.streamSynthesize(
                        voiceId: voiceId,
                        request: self.makeElevenLabsTTSRequest(
                            text: cleaned,
                            directive: directive,
                            modelId: modelId,
                            outputFormat: mp3Format,
                            language: language))
                }
                let duration = Date().timeIntervalSince(started)
                self.logger
                    .info(
                        "elevenlabs finished=\(result.finished, privacy: .public) dur=\(duration, privacy: .public)s")
                if !result.finished, let interruptedAt = result.interruptedAt {
                    self.lastInterruptedAtSeconds = interruptedAt
                }
            } else {
                self.logger.warning("tts unavailable; falling back to system voice (missing key or voiceId)")
                GatewayDiagnostics.log("talk tts: provider=system (missing key or voiceId)")
                try await self.playSystemVoice(text: cleaned, language: language)
            }
        } catch {
            guard self.speechGeneration == speechGeneration else { return }
            self.logger.error(
                "tts failed: \(error.localizedDescription, privacy: .public); falling back to system voice")
            GatewayDiagnostics.log("talk tts: provider=system (error) msg=\(error.localizedDescription)")
            do {
                try await self.playSystemVoice(text: cleaned, language: language)
            } catch {
                guard self.speechGeneration == speechGeneration else { return }
                self.statusText = "Speak failed: \(error.localizedDescription)"
                self.logger.error("system voice failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func playGatewayTalkSpeak(
        text: String,
        directive: TalkDirective?,
        generation: Int) async throws
    {
        let synthesizer: any TalkGatewaySpeechSynthesizing
        if let gatewaySpeechSynthesizerOverride {
            synthesizer = gatewaySpeechSynthesizerOverride
        } else if let gateway {
            synthesizer = TalkGatewaySpeechClient(gateway: gateway)
        } else {
            throw NSError(domain: "TalkGatewaySpeech", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Gateway not connected",
            ])
        }

        let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let voiceId = requestedVoice?.isEmpty == false
            ? requestedVoice
            : (self.currentVoiceId ?? self.defaultVoiceId)
        let modelId = directive?.modelId ?? (self.modelOverrideActive
            ? self.currentModelId
            : self.configuredProviderModelId)
        let outputFormat = directive?.outputFormat ?? self.defaultOutputFormat
        let audio = try await synthesizer.synthesize(TalkGatewaySpeechRequest(
            text: text,
            voiceId: voiceId,
            modelId: modelId,
            outputFormat: outputFormat,
            directive: directive))
        guard generation == self.speechGeneration, self.isSpeaking else { return }

        applyVoiceModeDescriptor(TalkVoiceModeDescriptorBuilder.build(
            providerId: audio.provider,
            providerLabel: Self.displayName(forProvider: audio.provider),
            modelId: modelId,
            voiceId: voiceId,
            transport: "native",
            isRealtime: false))
        self.startSpeechInterruptionRecognitionIfNeeded()
        self.statusText = "Speaking…"
        let result: StreamingPlaybackResult
        switch audio.playbackMode {
        case let .pcm(sampleRate):
            self.lastPlaybackWasPCM = true
            let stream = Self.makeBufferedAudioStream(chunks: [audio.data])
            result = await self.pcmPlayer.play(
                stream: self.pcmPlaybackEnvelope.metering(stream, sampleRate: sampleRate),
                sampleRate: sampleRate)
            self.pcmPlaybackEnvelope.cancel()
        case .buffered:
            self.lastPlaybackWasPCM = false
            self.bufferedPlayer.setLevelHandler { [weak self] level in
                self?.playbackLevel = level
            }
            result = await self.bufferedPlayer.play(data: audio.data)
        case let .unsupportedRaw(codec):
            throw NSError(domain: "TalkGatewaySpeech", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Gateway talk.speak returned unsupported raw audio codec '\(codec)'",
            ])
        }
        guard generation == self.speechGeneration, self.isSpeaking else { return }
        GatewayDiagnostics.log(
            "talk tts: provider=\(audio.provider) outputFormat=\(audio.outputFormat ?? "unknown") " +
                "finished=\(result.finished)")
        if !result.finished, let interruptedAt = result.interruptedAt {
            self.lastInterruptedAtSeconds = interruptedAt
        } else if !result.finished {
            throw NSError(domain: "TalkGatewaySpeech", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Gateway talk.speak audio playback failed",
            ])
        }
    }

    private func playSystemVoice(text: String, language: String?) async throws {
        applyVoiceModeDescriptor(TalkVoiceModeDescriptorBuilder.build(
            providerId: "system",
            providerLabel: Self.displayName(forProvider: "system"),
            modelId: nil,
            voiceId: language,
            transport: "native",
            isRealtime: false))
        self.startSpeechInterruptionRecognitionIfNeeded()
        self.statusText = "Speaking (System)…"
        try await TalkSystemSpeechSynthesizer.shared.speak(text: text, language: language)
    }

    private func resolvedElevenLabsAPIKey() -> String? {
        let configuredKey = self.apiKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty == false ? self.apiKey : nil
        #if DEBUG
        let resolvedKey = configuredKey ?? ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"]
        #else
        let resolvedKey = configuredKey
        #endif
        return resolvedKey?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func makeElevenLabsTTSRequest(
        text: String,
        directive: TalkDirective?,
        modelId: String?,
        outputFormat: String?,
        language: String?) -> ElevenLabsTTSRequest
    {
        ElevenLabsTTSRequest(
            text: text,
            modelId: modelId,
            outputFormat: outputFormat,
            speed: TalkTTSValidation.resolveSpeed(speed: directive?.speed, rateWPM: directive?.rateWPM),
            stability: TalkTTSValidation.validatedStability(directive?.stability, modelId: modelId),
            similarity: TalkTTSValidation.validatedUnit(directive?.similarity),
            style: TalkTTSValidation.validatedUnit(directive?.style),
            speakerBoost: directive?.speakerBoost,
            seed: TalkTTSValidation.validatedSeed(directive?.seed),
            normalize: ElevenLabsTTSClient.validatedNormalize(directive?.normalize),
            language: language,
            latencyTier: TalkTTSValidation.validatedLatencyTier(directive?.latencyTier))
    }

    private func startSpeechInterruptionRecognitionIfNeeded() {
        guard self.interruptOnSpeech else { return }
        do {
            try self.startRecognition()
        } catch {
            self.logger.warning("startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func stopSpeaking(storeInterruption: Bool = true) {
        self.speechGeneration += 1
        let hasIncremental = self.incrementalSpeechActive ||
            self.incrementalSpeechTask != nil ||
            !self.incrementalSpeechQueue.isEmpty
        if self.isSpeaking {
            let streamedInterruptedAt = self.lastPlaybackWasPCM
                ? self.pcmPlayer.stop()
                : self.mp3Player.stop()
            if storeInterruption {
                self.lastInterruptedAtSeconds = self.bufferedPlayer.stop() ?? streamedInterruptedAt
            } else {
                _ = self.bufferedPlayer.stop()
            }
            _ = self.lastPlaybackWasPCM
                ? self.mp3Player.stop()
                : self.pcmPlayer.stop()
        } else if !hasIncremental {
            return
        }
        self.stopRecognition()
        TalkSystemSpeechSynthesizer.shared.stop()
        self.cancelIncrementalSpeech()
        self.pcmPlaybackEnvelope.cancel()
        self.isSpeaking = false
        self.playbackLevel = nil
        restoreConfiguredVoiceModeDescriptor()
    }

    private func shouldInterrupt(with transcript: String) -> Bool {
        guard self.shouldAllowSpeechInterruptForCurrentRoute() else { return false }
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return false }
        if let spoken = lastSpokenText?.lowercased(), spoken.contains(trimmed.lowercased()) {
            return false
        }
        return true
    }

    private func shouldAllowSpeechInterruptForCurrentRoute() -> Bool {
        let route = AVAudioSession.sharedInstance().currentRoute
        // Built-in speaker/receiver often feeds TTS back into STT, causing false interrupts.
        // Allow barge-in for isolated outputs (headphones/Bluetooth/USB/CarPlay/AirPlay).
        return !route.outputs.contains { output in
            switch output.portType {
            case .builtInSpeaker, .builtInReceiver:
                true
            default:
                false
            }
        }
    }

    private func shouldUseIncrementalTTS() -> Bool {
        !self.runtimeRoute.usesGatewayTalkSpeak
    }

    private var isSpeechOutputActive: Bool {
        self.isSpeaking ||
            self.incrementalSpeechActive ||
            self.incrementalSpeechTask != nil ||
            !self.incrementalSpeechQueue.isEmpty
    }

    private func applyDirective(_ directive: TalkDirective?) {
        let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let usesGatewayVoiceIds = self.runtimeRoute.usesGatewayTalkSpeak
        let resolvedVoice = usesGatewayVoiceIds ? requestedVoice : resolveVoiceAlias(requestedVoice)
        if !usesGatewayVoiceIds, requestedVoice?.isEmpty == false, resolvedVoice == nil {
            self.logger.warning("unknown voice alias \(requestedVoice ?? "?", privacy: .public)")
        }
        if let voice = resolvedVoice {
            if directive?.once != true {
                self.currentVoiceId = voice
                self.voiceOverrideActive = true
            }
        }
        if let model = directive?.modelId {
            if directive?.once != true {
                self.currentModelId = model
                self.modelOverrideActive = true
            }
        }
    }

    private func resetIncrementalSpeech() {
        self.incrementalSpeechQueue.removeAll()
        self.incrementalSpeechTask?.cancel()
        self.incrementalSpeechTask = nil
        self.cancelIncrementalPrefetch()
        self.incrementalSpeechActive = true
        self.incrementalSpeechUsed = false
        self.incrementalSpeechLanguage = nil
        self.incrementalSpeechBuffer = IncrementalSpeechBuffer()
        self.incrementalSpeechContext = nil
        self.incrementalSpeechDirective = nil
    }

    private func cancelIncrementalSpeech() {
        self.incrementalSpeechQueue.removeAll()
        self.incrementalSpeechTask?.cancel()
        self.incrementalSpeechTask = nil
        self.cancelIncrementalPrefetch()
        self.incrementalSpeechActive = false
        self.incrementalSpeechContext = nil
        self.incrementalSpeechDirective = nil
    }

    private func enqueueIncrementalSpeech(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.incrementalSpeechQueue.append(trimmed)
        self.incrementalSpeechUsed = true
        if self.incrementalSpeechTask == nil {
            self.startIncrementalSpeechTask()
        }
    }

    private func startIncrementalSpeechTask() {
        if self.interruptOnSpeech {
            do {
                try self.startRecognition()
            } catch {
                self.logger.warning(
                    "startRecognition during incremental speak failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        self.incrementalSpeechTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.cancelIncrementalPrefetch()
                self.isSpeaking = false
                self.stopRecognition()
                self.incrementalSpeechTask = nil
            }
            while !Task.isCancelled {
                guard !self.incrementalSpeechQueue.isEmpty else { break }
                let segment = self.incrementalSpeechQueue.removeFirst()
                self.statusText = "Speaking…"
                self.isSpeaking = true
                self.lastSpokenText = segment
                await self.updateIncrementalContextIfNeeded()
                let context = self.incrementalSpeechContext
                let prefetchedAudio = await self.consumeIncrementalPrefetchedAudioIfAvailable(
                    for: segment,
                    context: context)
                if let context {
                    self.startIncrementalPrefetchMonitor(context: context)
                }
                await self.speakIncrementalSegment(
                    segment,
                    context: context,
                    prefetchedAudio: prefetchedAudio)
                self.cancelIncrementalPrefetchMonitor()
            }
        }
    }

    private func cancelIncrementalPrefetch() {
        self.cancelIncrementalPrefetchMonitor()
        self.incrementalSpeechPrefetch?.task.cancel()
        self.incrementalSpeechPrefetch = nil
    }

    private func cancelIncrementalPrefetchMonitor() {
        self.incrementalSpeechPrefetchMonitorTask?.cancel()
        self.incrementalSpeechPrefetchMonitorTask = nil
    }

    private func startIncrementalPrefetchMonitor(context: IncrementalSpeechContext) {
        self.cancelIncrementalPrefetchMonitor()
        self.incrementalSpeechPrefetchMonitorTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                if self.ensureIncrementalPrefetchForUpcomingSegment(context: context) {
                    return
                }
                try? await Task.sleep(nanoseconds: 40_000_000)
            }
        }
    }

    private func ensureIncrementalPrefetchForUpcomingSegment(context: IncrementalSpeechContext) -> Bool {
        guard context.canUseElevenLabs else {
            self.cancelIncrementalPrefetch()
            return false
        }
        guard let nextSegment = incrementalSpeechQueue.first else { return false }
        if let existing = incrementalSpeechPrefetch {
            if existing.segment == nextSegment, existing.context == context {
                return true
            }
            existing.task.cancel()
            self.incrementalSpeechPrefetch = nil
        }
        self.startIncrementalPrefetch(segment: nextSegment, context: context)
        return self.incrementalSpeechPrefetch != nil
    }

    private func startIncrementalPrefetch(segment: String, context: IncrementalSpeechContext) {
        guard context.canUseElevenLabs, let apiKey = context.apiKey, let voiceId = context.voiceId else { return }
        let prefetchOutputFormat = self.resolveIncrementalPrefetchOutputFormat(context: context)
        let request = self.makeIncrementalTTSRequest(
            text: segment,
            context: context,
            outputFormat: prefetchOutputFormat)
        let id = UUID()
        let task = Task { [weak self] in
            let stream = ElevenLabsTTSClient(apiKey: apiKey).streamSynthesize(voiceId: voiceId, request: request)
            var chunks: [Data] = []
            do {
                for try await chunk in stream {
                    try Task.checkCancellation()
                    chunks.append(chunk)
                }
                self?.completeIncrementalPrefetch(id: id, chunks: chunks)
            } catch is CancellationError {
                self?.clearIncrementalPrefetch(id: id)
            } catch {
                self?.failIncrementalPrefetch(id: id, error: error)
            }
        }
        self.incrementalSpeechPrefetch = IncrementalSpeechPrefetchState(
            id: id,
            segment: segment,
            context: context,
            outputFormat: prefetchOutputFormat,
            chunks: nil,
            task: task)
    }

    private func completeIncrementalPrefetch(id: UUID, chunks: [Data]) {
        guard var prefetch = incrementalSpeechPrefetch, prefetch.id == id else { return }
        prefetch.chunks = chunks
        self.incrementalSpeechPrefetch = prefetch
    }

    private func clearIncrementalPrefetch(id: UUID) {
        guard let prefetch = incrementalSpeechPrefetch, prefetch.id == id else { return }
        prefetch.task.cancel()
        self.incrementalSpeechPrefetch = nil
    }

    private func failIncrementalPrefetch(id: UUID, error: any Error) {
        guard let prefetch = incrementalSpeechPrefetch, prefetch.id == id else { return }
        self.logger.debug("incremental prefetch failed: \(error.localizedDescription, privacy: .public)")
        prefetch.task.cancel()
        self.incrementalSpeechPrefetch = nil
    }

    private func consumeIncrementalPrefetchedAudioIfAvailable(
        for segment: String,
        context: IncrementalSpeechContext?) async -> IncrementalPrefetchedAudio?
    {
        guard let context else {
            self.cancelIncrementalPrefetch()
            return nil
        }
        guard let prefetch = incrementalSpeechPrefetch else {
            return nil
        }
        guard prefetch.context == context else {
            prefetch.task.cancel()
            self.incrementalSpeechPrefetch = nil
            return nil
        }
        guard prefetch.segment == segment else {
            return nil
        }
        if let chunks = prefetch.chunks, !chunks.isEmpty {
            let prefetched = IncrementalPrefetchedAudio(chunks: chunks, outputFormat: prefetch.outputFormat)
            self.incrementalSpeechPrefetch = nil
            return prefetched
        }
        await prefetch.task.value
        guard let completed = incrementalSpeechPrefetch else { return nil }
        guard completed.context == context, completed.segment == segment else { return nil }
        guard let chunks = completed.chunks, !chunks.isEmpty else { return nil }
        let prefetched = IncrementalPrefetchedAudio(chunks: chunks, outputFormat: completed.outputFormat)
        self.incrementalSpeechPrefetch = nil
        return prefetched
    }

    private func resolveIncrementalPrefetchOutputFormat(context: IncrementalSpeechContext) -> String? {
        if TalkTTSValidation.pcmSampleRate(from: context.outputFormat) != nil {
            return ElevenLabsTTSClient.validatedOutputFormat("mp3_44100_128")
        }
        return context.outputFormat
    }

    private func finishIncrementalSpeech() async {
        guard self.incrementalSpeechActive else { return }
        let leftover = self.incrementalSpeechBuffer.flush()
        if let leftover {
            self.enqueueIncrementalSpeech(leftover)
        }
        if let task = incrementalSpeechTask {
            _ = await task.result
        }
        self.incrementalSpeechActive = false
    }

    private func handleIncrementalAssistantFinal(text: String) async {
        let parsed = TalkDirectiveParser.parse(text)
        self.applyDirective(parsed.directive)
        if let lang = parsed.directive?.language {
            self.incrementalSpeechLanguage = ElevenLabsTTSClient.validatedLanguage(lang)
        }
        await self.updateIncrementalContextIfNeeded()
        let segments = self.incrementalSpeechBuffer.ingest(text: text, isFinal: true)
        for segment in segments {
            self.enqueueIncrementalSpeech(segment)
        }
        await self.finishIncrementalSpeech()
        if !self.incrementalSpeechUsed {
            await self.playAssistant(text: text)
        }
    }

    private func streamAssistant(runId: String, gateway: GatewayNodeSession) async {
        let stream = await gateway.subscribeServerEvents(bufferingNewest: 200)
        for await evt in stream {
            if Task.isCancelled { return }
            guard evt.event == "agent", let payload = evt.payload else { continue }
            guard let agentEvent = try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawAgentEventPayload.self)
            else {
                continue
            }
            guard agentEvent.runId == runId, agentEvent.stream == "assistant" else { continue }
            guard let text = agentEvent.data["text"]?.value as? String else { continue }
            let segments = self.incrementalSpeechBuffer.ingest(text: text, isFinal: false)
            if let lang = incrementalSpeechBuffer.directive?.language {
                self.incrementalSpeechLanguage = ElevenLabsTTSClient.validatedLanguage(lang)
            }
            await self.updateIncrementalContextIfNeeded()
            for segment in segments {
                self.enqueueIncrementalSpeech(segment)
            }
        }
    }

    private func updateIncrementalContextIfNeeded() async {
        let directive = self.incrementalSpeechBuffer.directive
        if let existing = incrementalSpeechContext, directive == incrementalSpeechDirective {
            if existing.language != self.incrementalSpeechLanguage {
                self.incrementalSpeechContext = IncrementalSpeechContext(
                    apiKey: existing.apiKey,
                    voiceId: existing.voiceId,
                    modelId: existing.modelId,
                    outputFormat: existing.outputFormat,
                    language: self.incrementalSpeechLanguage,
                    directive: existing.directive,
                    canUseElevenLabs: existing.canUseElevenLabs)
            }
            return
        }
        let context = await buildIncrementalSpeechContext(directive: directive)
        self.incrementalSpeechContext = context
        self.incrementalSpeechDirective = directive
    }

    private func buildIncrementalSpeechContext(directive: TalkDirective?) async -> IncrementalSpeechContext {
        let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedVoice = resolveVoiceAlias(requestedVoice)
        if requestedVoice?.isEmpty == false, resolvedVoice == nil {
            self.logger.warning("unknown voice alias \(requestedVoice ?? "?", privacy: .public)")
        }
        let preferredVoice = resolvedVoice ?? self.currentVoiceId ?? self.defaultVoiceId
        let modelId = directive?.modelId ?? self.currentModelId ?? self.defaultModelId
        let desiredOutputFormat = (directive?.outputFormat ?? self.defaultOutputFormat)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedOutputFormat = (desiredOutputFormat?.isEmpty == false) ? desiredOutputFormat : nil
        let outputFormat = ElevenLabsTTSClient.validatedOutputFormat(
            requestedOutputFormat ?? self.effectiveDefaultOutputFormat)
        if outputFormat == nil, let requestedOutputFormat {
            self.logger.warning(
                "talk output_format unsupported for local playback: \(requestedOutputFormat, privacy: .public)")
        }

        let configuredKey = self.apiKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty == false ? self.apiKey : nil
        #if DEBUG
        let resolvedKey = configuredKey ?? ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"]
        #else
        let resolvedKey = configuredKey
        #endif
        let apiKey = resolvedKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let voiceId: String? = if let apiKey, !apiKey.isEmpty {
            await resolveVoiceId(preferred: preferredVoice, apiKey: apiKey)
        } else {
            nil
        }
        let canUseElevenLabs = (voiceId?.isEmpty == false) && (apiKey?.isEmpty == false)
        return IncrementalSpeechContext(
            apiKey: apiKey,
            voiceId: voiceId,
            modelId: modelId,
            outputFormat: outputFormat,
            language: self.incrementalSpeechLanguage,
            directive: directive,
            canUseElevenLabs: canUseElevenLabs)
    }

    private func makeIncrementalTTSRequest(
        text: String,
        context: IncrementalSpeechContext,
        outputFormat: String?) -> ElevenLabsTTSRequest
    {
        ElevenLabsTTSRequest(
            text: text,
            modelId: context.modelId,
            outputFormat: outputFormat,
            speed: TalkTTSValidation.resolveSpeed(
                speed: context.directive?.speed,
                rateWPM: context.directive?.rateWPM),
            stability: TalkTTSValidation.validatedStability(
                context.directive?.stability,
                modelId: context.modelId),
            similarity: TalkTTSValidation.validatedUnit(context.directive?.similarity),
            style: TalkTTSValidation.validatedUnit(context.directive?.style),
            speakerBoost: context.directive?.speakerBoost,
            seed: TalkTTSValidation.validatedSeed(context.directive?.seed),
            normalize: ElevenLabsTTSClient.validatedNormalize(context.directive?.normalize),
            language: context.language,
            latencyTier: TalkTTSValidation.validatedLatencyTier(context.directive?.latencyTier))
    }

    /// Returns `mp3_44100_128` when the API has already rejected PCM, otherwise `pcm_44100`.
    private var effectiveDefaultOutputFormat: String {
        self.pcmFormatUnavailable ? "mp3_44100_128" : "pcm_44100"
    }

    private static func monitorStreamFailures(
        _ stream: AsyncThrowingStream<Data, Error>,
        failureBox: StreamFailureBox) -> AsyncThrowingStream<Data, Error>
    {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await chunk in stream {
                        continuation.yield(chunk)
                    }
                    continuation.finish()
                } catch {
                    failureBox.set(error)
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    private static func isPCMFormatRejectedByAPI(_ error: Error?) -> Bool {
        guard let error = error as NSError? else { return false }
        guard error.domain == "ElevenLabsTTS", error.code >= 400 else { return false }
        let message = (error.userInfo[NSLocalizedDescriptionKey] as? String ?? error.localizedDescription).lowercased()
        return message.contains("output_format")
            || message.contains("pcm_")
            || message.contains("pcm ")
            || message.contains("subscription_required")
    }

    private static func makeBufferedAudioStream(chunks: [Data]) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            for chunk in chunks {
                continuation.yield(chunk)
            }
            continuation.finish()
        }
    }

    private func speakIncrementalSegment(
        _ text: String,
        context preferredContext: IncrementalSpeechContext? = nil,
        prefetchedAudio: IncrementalPrefetchedAudio? = nil) async
    {
        let context: IncrementalSpeechContext
        if let preferredContext {
            context = preferredContext
        } else {
            await self.updateIncrementalContextIfNeeded()
            guard let resolvedContext = incrementalSpeechContext else {
                try? await TalkSystemSpeechSynthesizer.shared.speak(
                    text: text,
                    language: self.incrementalSpeechLanguage)
                return
            }
            context = resolvedContext
        }

        guard context.canUseElevenLabs, let apiKey = context.apiKey, let voiceId = context.voiceId else {
            try? await TalkSystemSpeechSynthesizer.shared.speak(
                text: text,
                language: self.incrementalSpeechLanguage)
            return
        }

        let client = ElevenLabsTTSClient(apiKey: apiKey)
        let request = self.makeIncrementalTTSRequest(
            text: text,
            context: context,
            outputFormat: context.outputFormat)
        let rawStream: AsyncThrowingStream<Data, Error> = if let prefetchedAudio, !prefetchedAudio.chunks.isEmpty {
            Self.makeBufferedAudioStream(chunks: prefetchedAudio.chunks)
        } else {
            client.streamSynthesize(voiceId: voiceId, request: request)
        }
        let playbackFormat = prefetchedAudio?.outputFormat ?? context.outputFormat
        let result = await self.playElevenLabsStream(
            rawStream,
            sampleRate: TalkTTSValidation.pcmSampleRate(from: playbackFormat))
        { mp3Format in
            client.streamSynthesize(
                voiceId: voiceId,
                request: self.makeIncrementalTTSRequest(
                    text: text,
                    context: context,
                    outputFormat: mp3Format))
        }
        if !result.finished, let interruptedAt = result.interruptedAt {
            self.lastInterruptedAtSeconds = interruptedAt
        }
    }

    /// Plays an ElevenLabs stream: metered PCM when the output format is raw
    /// PCM, retried once as mp3 when PCM playback fails outright (some plans
    /// and formats reject PCM); plain mp3 streaming otherwise.
    private func playElevenLabsStream(
        _ rawStream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double?,
        makeMP3Stream: (String?) -> AsyncThrowingStream<Data, Error>) async -> StreamingPlaybackResult
    {
        guard let sampleRate else {
            self.lastPlaybackWasPCM = false
            return await self.mp3Player.play(stream: rawStream)
        }
        let streamFailure = StreamFailureBox()
        let stream = Self.monitorStreamFailures(rawStream, failureBox: streamFailure)
        self.lastPlaybackWasPCM = true
        var playback = await pcmPlayer.play(
            stream: self.pcmPlaybackEnvelope.metering(stream, sampleRate: sampleRate),
            sampleRate: sampleRate)
        self.pcmPlaybackEnvelope.cancel()
        if !playback.finished, playback.interruptedAt == nil {
            self.logger.warning("pcm playback failed; retrying mp3")
            if Self.isPCMFormatRejectedByAPI(streamFailure.value) {
                self.pcmFormatUnavailable = true
            }
            self.lastPlaybackWasPCM = false
            let mp3Format = ElevenLabsTTSClient.validatedOutputFormat("mp3_44100_128")
            playback = await self.mp3Player.play(stream: makeMP3Stream(mp3Format))
        }
        return playback
    }
}

private struct IncrementalSpeechBuffer {
    private static let softBoundaryMinChars = 72

    private(set) var latestText: String = ""
    private(set) var directive: TalkDirective?
    private var spokenOffset: Int = 0
    private var inCodeBlock = false
    private var directiveParsed = false

    mutating func ingest(text: String, isFinal: Bool) -> [String] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        guard let usable = stripDirectiveIfReady(from: normalized) else { return [] }
        self.updateText(usable)
        return self.extractSegments(isFinal: isFinal)
    }

    mutating func flush() -> String? {
        guard !self.latestText.isEmpty else { return nil }
        let segments = self.extractSegments(isFinal: true)
        return segments.first
    }

    private mutating func stripDirectiveIfReady(from text: String) -> String? {
        guard !self.directiveParsed else { return text }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("{") {
            guard let newlineRange = text.range(of: "\n") else { return nil }
            let firstLine = text[..<newlineRange.lowerBound]
            let head = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard head.hasSuffix("}") else { return nil }
            let parsed = TalkDirectiveParser.parse(text)
            if let directive = parsed.directive {
                self.directive = directive
            }
            self.directiveParsed = true
            return parsed.stripped
        }
        self.directiveParsed = true
        return text
    }

    private mutating func updateText(_ newText: String) {
        if newText.hasPrefix(self.latestText) {
            self.latestText = newText
        } else if self.latestText.hasPrefix(newText) {
            // Stream reset or correction; prefer the newer prefix.
            self.latestText = newText
            self.spokenOffset = min(self.spokenOffset, newText.count)
        } else {
            // Diverged text means chunks arrived out of order or stream restarted.
            let commonPrefix = Self.commonPrefixCount(self.latestText, newText)
            self.latestText = newText
            if self.spokenOffset > commonPrefix {
                self.spokenOffset = commonPrefix
            }
        }
        if self.spokenOffset > self.latestText.count {
            self.spokenOffset = self.latestText.count
        }
    }

    private static func commonPrefixCount(_ lhs: String, _ rhs: String) -> Int {
        let left = Array(lhs)
        let right = Array(rhs)
        let limit = min(left.count, right.count)
        var idx = 0
        while idx < limit, left[idx] == right[idx] {
            idx += 1
        }
        return idx
    }

    private mutating func extractSegments(isFinal: Bool) -> [String] {
        let chars = Array(latestText)
        guard self.spokenOffset < chars.count else { return [] }
        var idx = self.spokenOffset
        var lastBoundary: Int?
        var inCodeBlock = self.inCodeBlock
        var buffer = ""
        var bufferAtBoundary = ""
        var inCodeBlockAtBoundary = inCodeBlock

        while idx < chars.count {
            if idx + 2 < chars.count,
               chars[idx] == "`",
               chars[idx + 1] == "`",
               chars[idx + 2] == "`"
            {
                inCodeBlock.toggle()
                idx += 3
                continue
            }

            if !inCodeBlock {
                let currentChar = chars[idx]
                buffer.append(currentChar)
                if Self.isBoundary(currentChar) || Self.isSoftBoundary(currentChar, bufferedChars: buffer.count) {
                    lastBoundary = idx + 1
                    bufferAtBoundary = buffer
                    inCodeBlockAtBoundary = inCodeBlock
                }
            }

            idx += 1
        }

        if let boundary = lastBoundary {
            self.spokenOffset = boundary
            self.inCodeBlock = inCodeBlockAtBoundary
            let trimmed = bufferAtBoundary.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? [] : [trimmed]
        }

        guard isFinal else { return [] }
        self.spokenOffset = chars.count
        self.inCodeBlock = inCodeBlock
        let trimmed = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? [] : [trimmed]
    }

    private static func isBoundary(_ ch: Character) -> Bool {
        ch == "." || ch == "!" || ch == "?" || ch == "\n"
    }

    private static func isSoftBoundary(_ ch: Character, bufferedChars: Int) -> Bool {
        bufferedChars >= self.softBoundaryMinChars && ch.isWhitespace
    }
}

extension TalkModeManager {
    func resolveVoiceAlias(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.lowercased()
        if let mapped = voiceAliases[normalized] { return mapped }
        if self.voiceAliases.values.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            return trimmed
        }
        return Self.isLikelyVoiceId(trimmed) ? trimmed : nil
    }

    func resolveVoiceId(preferred: String?, apiKey: String) async -> String? {
        let trimmed = preferred?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            // Config / directives can provide a raw ElevenLabs voiceId (not an alias).
            // Accept it directly to avoid unnecessary listVoices calls (and accidental fallback selection).
            if Self.isLikelyVoiceId(trimmed) {
                return trimmed
            }
            if let resolved = resolveVoiceAlias(trimmed) { return resolved }
            self.logger.warning("unknown voice alias \(trimmed, privacy: .public)")
        }
        if let fallbackVoiceId { return fallbackVoiceId }

        do {
            let voices = try await ElevenLabsTTSClient(apiKey: apiKey).listVoices()
            guard let first = voices.first else {
                self.logger.warning("elevenlabs voices list empty")
                return nil
            }
            fallbackVoiceId = first.voiceId
            if self.defaultVoiceId == nil {
                self.defaultVoiceId = first.voiceId
            }
            if !self.voiceOverrideActive {
                self.currentVoiceId = first.voiceId
            }
            let name = first.name ?? "unknown"
            self.logger
                .info("default voice selected \(name, privacy: .public) (\(first.voiceId, privacy: .public))")
            return first.voiceId
        } catch {
            self.logger.error("elevenlabs list voices failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    static func isLikelyVoiceId(_ value: String) -> Bool {
        guard value.count >= 10 else { return false }
        return value.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    private static func normalizedTalkApiKey(_ raw: String?) -> String? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed != Self.redactedConfigSentinel else { return nil }
        // Config values may be env placeholders (for example `${ELEVENLABS_API_KEY}`).
        if trimmed.hasPrefix("${"), trimmed.hasSuffix("}") { return nil }
        return trimmed
    }

    private static func displayName(forProvider provider: String) -> String {
        switch provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "elevenlabs":
            "ElevenLabs"
        case "openai":
            "OpenAI"
        case "google":
            "Google"
        case "system":
            "iOS System Voice"
        case "realtime":
            "Realtime Voice"
        case let provider where !provider.isEmpty:
            provider
        default:
            "Gateway Default"
        }
    }

    private func applyVoiceModeDescriptor(_ descriptor: TalkVoiceModeDescriptor, persistAsConfigured: Bool = false) {
        if persistAsConfigured {
            self.configuredVoiceModeDescriptor = descriptor
        }
        self.gatewayTalkVoiceModeTitle = descriptor.title
        self.gatewayTalkVoiceModeSubtitle = descriptor.subtitle
        self.gatewayTalkVoiceModeAccessibilityValue = descriptor.accessibilityValue
    }

    private func markRealtimeActive() {
        self.pendingRealtimeIssue = nil
        self.gatewayTalkCurrentFallbackIssue = nil
        self.gatewayTalkLastIssueText = nil
        self.gatewayTalkActiveModeTitle = self.configuredVoiceModeDescriptor.title
        self.gatewayTalkActiveModeSubtitle = self.configuredVoiceModeDescriptor.subtitle
        self.statusText = "Listening (Realtime)"
    }

    private func handleRealtimeRelayStatus(_ status: String) {
        if status == "Listening (Realtime)" {
            // Ready can be followed by a buffered close before start() resumes. Commit continuous
            // state here so the close still enters bounded recovery.
            self.markRealtimeSessionReady()
        } else {
            self.statusText = status
            if status == "Ready" {
                self.realtimeRelaySession = nil
                self.handleRealtimeSessionFinish()
            }
        }
        self.isListening = status.localizedCaseInsensitiveContains("listening")
        if status.localizedCaseInsensitiveContains("thinking") {
            self.isListening = false
            self.isSpeaking = false
            self.isUserSpeechDetected = false
        }
    }

    private func prepareRealtimeRelayStart() {
        self.realtimeRelayStartIssue = nil
        self.pendingRealtimeIssue = nil
        self.gatewayTalkCurrentFallbackIssue = nil
    }

    private func markNativeTalkActive() {
        self.pendingRealtimeIssue = nil
        self.gatewayTalkCurrentFallbackIssue = nil
        self.gatewayTalkActiveModeTitle = "iOS Speech + TTS"
        self.gatewayTalkActiveModeSubtitle = nil
        self.statusText = "Listening"
    }

    private func markNativeFallbackActive(after issue: TalkRuntimeIssue) {
        self.gatewayTalkActiveModeTitle = "iOS Speech fallback"
        self.gatewayTalkActiveModeSubtitle = issue.displayMessage
        self.gatewayTalkCurrentFallbackIssue = issue
        self.gatewayTalkLastIssueText = issue.diagnosticSummary
        self.statusText = issue.fallbackStatusText
    }

    private func realtimeIssue(message: String, phase: String) -> TalkRuntimeIssue {
        TalkRuntimeIssue.realtimeUnavailable(
            message: message,
            provider: self.realtimeProvider,
            model: self.realtimeModelId,
            transport: self.executionMode == .realtimeRelay ? "gateway-relay" : "webrtc",
            phase: phase)
    }

    private func realtimeIssue(from error: Error, phase: String) -> TalkRuntimeIssue {
        if let gatewayError = error as? GatewayResponseError,
           let issue = Self.talkRuntimeIssue(
               from: gatewayError,
               fallbackProvider: realtimeProvider,
               fallbackModel: realtimeModelId,
               fallbackTransport: executionMode == .realtimeRelay ? "gateway-relay" : "webrtc",
               fallbackPhase: phase)
        {
            return issue
        }
        return self.realtimeIssue(message: error.localizedDescription, phase: phase)
    }

    private static func talkRuntimeIssue(
        from gatewayError: GatewayResponseError,
        fallbackProvider: String?,
        fallbackModel: String?,
        fallbackTransport: String?,
        fallbackPhase: String) -> TalkRuntimeIssue?
    {
        guard let rawIssue = gatewayError.details["talkIssue"]?.dictionaryValue else { return nil }
        let message = rawIssue["message"]?.stringValue ?? gatewayError.message
        let provider = rawIssue["provider"]?.stringValue ?? fallbackProvider
        let model = rawIssue["model"]?.stringValue ?? fallbackModel
        let transport = rawIssue["transport"]?.stringValue ?? fallbackTransport
        let phase = rawIssue["phase"]?.stringValue ?? fallbackPhase
        return TalkRuntimeIssue.realtimeUnavailable(
            message: message,
            provider: provider,
            model: model,
            transport: transport,
            phase: phase)
    }

    private func restoreConfiguredVoiceModeDescriptor() {
        self.applyVoiceModeDescriptor(self.configuredVoiceModeDescriptor)
    }

    private func buildConfiguredVoiceModeDescriptor(
        provider: String,
        providerLabel: String,
        modelId: String?,
        voiceId: String?,
        transport: String,
        isRealtime: Bool) -> TalkVoiceModeDescriptor
    {
        TalkVoiceModeDescriptorBuilder.build(
            providerId: provider,
            providerLabel: providerLabel,
            modelId: modelId,
            voiceId: voiceId,
            transport: transport,
            isRealtime: isRealtime)
    }

    private func ensureTalkConfigLoadedForStart() async {
        if self.gatewayTalkConfigLoaded || self.gatewayTalkPermissionState.isApprovalRequestInProgress {
            GatewayDiagnostics.log(
                "talk.timeline config cached permission=\(self.gatewayTalkPermissionState.statusLabel) "
                    + "loadedAt=\(self.talkConfigLoadedAt?.timeIntervalSince1970 ?? 0)")
            return
        }

        let configStartedAt = Self.nowSeconds()
        await self.reloadConfig()
        GatewayDiagnostics.log(
            "talk.timeline config reload elapsedMs=\(Self.elapsedMs(since: configStartedAt)) "
                + "permission=\(self.gatewayTalkPermissionState.statusLabel)")
    }

    func reloadConfig(shouldApply: @MainActor @Sendable () -> Bool = { true }) async {
        guard let gateway else { return }
        self.pcmFormatUnavailable = false
        self.prefetchedRealtimeSession = nil
        do {
            guard let loaded = try await loadTalkConfig(from: gateway), shouldApply() else { return }
            let parsed = TalkModeGatewayConfigParser.parse(
                config: loaded.config,
                defaultProvider: Self.defaultTalkProvider,
                defaultModelIdFallback: Self.defaultModelIdFallback,
                defaultRealtimeModelIdFallback: Self.defaultRealtimeModelIdFallback,
                defaultSilenceTimeoutMs: Self.defaultSilenceTimeoutMs)
            if parsed.missingResolvedPayload {
                GatewayDiagnostics.log(
                    "talk config ignored: normalized payload missing talk.resolved")
            }
            self.applyLoadedTalkConfig(parsed, redactedFallbackMissingScope: loaded.redactedFallbackMissingScope)
        } catch {
            guard shouldApply() else { return }
            self.applyTalkConfigLoadFailure(error)
        }
    }

    private func loadTalkConfig(
        from gateway: GatewayNodeSession) async throws
        -> (config: [String: Any], redactedFallbackMissingScope: String?)?
    {
        func fetchConfig(includeSecrets: Bool) async throws -> [String: Any]? {
            let paramsJSON = includeSecrets ? "{\"includeSecrets\":true}" : "{}"
            let res = try await gateway.request(
                method: "talk.config",
                paramsJSON: paramsJSON,
                timeoutSeconds: 8)
            guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else {
                return nil
            }
            return json["config"] as? [String: Any]
        }

        do {
            if let config = try await fetchConfig(includeSecrets: true) {
                return (config, nil)
            }
            guard let config = try await fetchConfig(includeSecrets: false) else { return nil }
            GatewayDiagnostics.log("talk config secrets unavailable; loaded redacted config")
            return (config, nil)
        } catch {
            let missingScope = Self.missingTalkScope(from: error)
            guard let config = try await fetchConfig(includeSecrets: false) else {
                throw error
            }
            GatewayDiagnostics.log("talk config secrets unavailable; loaded redacted config")
            return (config, missingScope)
        }
    }

    private func applyLoadedTalkConfig(
        _ parsed: TalkModeGatewayConfigState,
        redactedFallbackMissingScope: String?,
        providerSelection providerSelectionOverride: TalkModeProviderSelection? = nil)
    {
        let providerSelection = providerSelectionOverride ?? self.talkProviderSelection
        let routing = TalkModeRoutingResolver.resolve(
            parsed: parsed,
            providerSelection: providerSelection,
            defaultProvider: Self.defaultTalkProvider,
            defaultRealtimeModelId: Self.defaultRealtimeModelIdFallback)
        let realtimeVoiceOverride = TalkModeRealtimeVoiceSelection.resolvedOverride(
            UserDefaults.standard.string(forKey: TalkModeRealtimeVoiceSelection.storageKey))
        let parsedRealtimeProviderIsOpenAI =
            parsed.realtimeProvider?.caseInsensitiveCompare("openai") == .orderedSame
        let parsedRealtimeVoiceId = providerSelection == .openAIRealtime && !parsedRealtimeProviderIsOpenAI
            ? nil
            : parsed.realtimeVoiceId
        let realtimeVoiceId = realtimeVoiceOverride ?? parsedRealtimeVoiceId
        self.activeTalkProvider = routing.activeProvider
        self.executionMode = routing.executionMode
        self.runtimeRoute = routing.route
        self.realtimeProvider = routing.realtimeProvider
        self.realtimeModelId = routing.realtimeModelId
        self.realtimeVoiceId = realtimeVoiceId
        self.defaultVoiceId = parsed.defaultVoiceId
        self.voiceAliases = parsed.voiceAliases
        if !self.voiceOverrideActive {
            self.currentVoiceId = self.defaultVoiceId
        }
        self.defaultModelId = parsed.defaultModelId
        self.configuredProviderModelId = parsed.configuredModelId
        if !self.modelOverrideActive {
            self.currentModelId = self.defaultModelId
        }
        self.defaultOutputFormat = parsed.defaultOutputFormat

        let credentialProvider = routing.route.usesRealtime
            ? (routing.realtimeProvider ?? routing.activeProvider)
            : routing.activeProvider
        let gatewayOwnedVoiceProvider = self.applyTalkConfigCredentials(
            parsed: parsed,
            activeProvider: routing.activeProvider,
            gatewayOwnsCredentials: routing.route.gatewayOwnsCredentials,
            credentialProvider: credentialProvider)
        self.applyTalkModeDescriptor(
            routing: routing,
            providerSelection: providerSelection,
            nativeModelId: routing.route == .localElevenLabs
                ? self.defaultModelId
                : self.configuredProviderModelId,
            realtimeVoiceId: realtimeVoiceId)
        self.applyTalkPermissionState(
            redactedFallbackMissingScope: redactedFallbackMissingScope,
            gatewayOwnedVoiceProvider: gatewayOwnedVoiceProvider)

        if let interrupt = parsed.interruptOnSpeech {
            self.interruptOnSpeech = interrupt
        }
        self.gatewaySpeechLocaleID = parsed.speechLocaleID
        self.silenceWindow = TimeInterval(parsed.silenceTimeoutMs) / 1000
        if parsed.normalizedPayload || parsed.defaultVoiceId != nil || parsed.rawConfigApiKey != nil {
            GatewayDiagnostics.log(
                "talk config provider=\(routing.activeProvider) silenceTimeoutMs=\(parsed.silenceTimeoutMs)")
        }
    }

    private func applyTalkConfigCredentials(
        parsed: TalkModeGatewayConfigState,
        activeProvider: String,
        gatewayOwnsCredentials: Bool,
        credentialProvider: String) -> Bool
    {
        let rawConfigApiKey = parsed.rawConfigApiKey
        let configApiKey = Self.normalizedTalkApiKey(rawConfigApiKey)
        let localApiKey = Self.normalizedTalkApiKey(
            GatewaySettingsStore.loadTalkProviderApiKey(provider: activeProvider))
        if rawConfigApiKey == Self.redactedConfigSentinel {
            self.apiKey = (localApiKey?.isEmpty == false) ? localApiKey : nil
            GatewayDiagnostics.log("talk config apiKey redacted; using local override if present")
        } else {
            self.apiKey = (localApiKey?.isEmpty == false) ? localApiKey : configApiKey
        }
        if gatewayOwnsCredentials {
            self.apiKey = nil
            GatewayDiagnostics.log("talk provider '\(credentialProvider)' uses gateway-owned credentials")
        }
        return gatewayOwnsCredentials
    }

    private func applyTalkModeDescriptor(
        routing: TalkModeResolvedRouting,
        providerSelection: TalkModeProviderSelection,
        nativeModelId: String?,
        realtimeVoiceId: String?)
    {
        let usesRealtimeConfig = routing.route.usesRealtime
        let usesRealtimeRelay = routing.executionMode == .realtimeRelay
        self.gatewayTalkDefaultVoiceId = usesRealtimeConfig ? realtimeVoiceId : self.defaultVoiceId
        self.gatewayTalkDefaultModelId = usesRealtimeConfig ? routing.realtimeModelId : nativeModelId
        let providerLabel = providerSelection == .gatewayDefault
            ? Self.displayName(forProvider: routing.activeProvider)
            : providerSelection.label
        let transport = usesRealtimeConfig ? (usesRealtimeRelay ? "gateway-relay" : "webrtc") : "native"
        let transportLabel = usesRealtimeRelay ? "Gateway Relay" : (usesRealtimeConfig ? "Native WebRTC" : "Native")
        self.gatewayTalkProviderLabel = providerLabel
        self.gatewayTalkUsesRealtime = usesRealtimeConfig
        self.gatewayTalkUsesRealtimeRelay = usesRealtimeRelay
        self.gatewayTalkTransportLabel = transportLabel
        self.gatewayTalkRealtimeProviderLabel = routing.realtimeProvider.map { Self.displayName(forProvider: $0) }
        self.gatewayTalkRealtimeModelId = routing.realtimeModelId
        self.gatewayTalkRealtimeVoiceId = realtimeVoiceId
        let voiceModeProvider = usesRealtimeConfig
            ? (routing.realtimeProvider ?? "realtime")
            : routing.activeProvider
        let voiceModeLabel = usesRealtimeConfig
            ? Self.displayName(forProvider: voiceModeProvider)
            : Self.displayName(forProvider: routing.activeProvider)
        let voiceModeDescriptor = self.buildConfiguredVoiceModeDescriptor(
            provider: voiceModeProvider,
            providerLabel: voiceModeLabel,
            modelId: usesRealtimeConfig ? routing.realtimeModelId : nativeModelId,
            voiceId: usesRealtimeConfig ? realtimeVoiceId : self.defaultVoiceId,
            transport: transport,
            isRealtime: usesRealtimeConfig)
        self.applyVoiceModeDescriptor(voiceModeDescriptor, persistAsConfigured: true)
    }

    private func applyTalkPermissionState(
        redactedFallbackMissingScope: String?,
        gatewayOwnedVoiceProvider: Bool)
    {
        self.gatewayTalkApiKeyConfigured = gatewayOwnedVoiceProvider || (self.apiKey?.isEmpty == false)
        self.gatewayTalkConfigLoaded = true
        self.talkConfigLoadedAt = Date()
        if let missingScope = redactedFallbackMissingScope,
           gatewayOwnedVoiceProvider || apiKey == nil
        {
            self.gatewayTalkPermissionState = .missingScope(missingScope)
            GatewayDiagnostics.log("talk config missing gateway scope=\(missingScope)")
        } else {
            self.gatewayTalkPermissionState = (self.gatewayTalkApiKeyConfigured || gatewayOwnedVoiceProvider)
                ? .ready
                : .apiKeyMissing
        }
    }

    private func applyTalkConfigLoadFailure(_ error: Error) {
        self.configuredProviderModelId = nil
        if self.shouldUseOpenAIRealtimeSelectionFallback {
            self.applyOpenAIRealtimeSelectionDefaults()
            GatewayDiagnostics.log("talk config unavailable; keeping openai realtime selection")
        } else {
            self.applyTalkConfigLoadFailureFallback()
        }
        self.defaultModelId = Self.defaultModelIdFallback
        if !self.modelOverrideActive {
            self.currentModelId = self.defaultModelId
        }
        self.gatewayTalkConfigLoaded = false
        self.talkConfigLoadedAt = nil
        self.gatewaySpeechLocaleID = nil
        self.silenceWindow = TimeInterval(Self.defaultSilenceTimeoutMs) / 1000
        if let missingScope = Self.missingTalkScope(from: error) {
            self.gatewayTalkPermissionState = .missingScope(missingScope)
            self.statusText = "Gateway permission required"
            GatewayDiagnostics.log("talk config missing gateway scope=\(missingScope)")
        } else {
            self.gatewayTalkPermissionState = .loadFailed(error.localizedDescription)
        }
    }

    private func applyTalkConfigLoadFailureFallback() {
        self.activeTalkProvider = Self.defaultTalkProvider
        self.executionMode = .native
        self.runtimeRoute = .localElevenLabs
        self.realtimeProvider = nil
        self.realtimeModelId = nil
        self.realtimeVoiceId = nil
        self.configuredProviderModelId = nil
        self.gatewayTalkProviderLabel = "Not loaded"
        self.gatewayTalkTransportLabel = "Not loaded"
        self.gatewayTalkUsesRealtime = false
        self.gatewayTalkUsesRealtimeRelay = false
        self.gatewayTalkRealtimeProviderLabel = nil
        self.gatewayTalkRealtimeModelId = nil
        self.gatewayTalkRealtimeVoiceId = nil
        self.applyVoiceModeDescriptor(TalkVoiceModeDescriptor(
            title: "Not loaded",
            subtitle: nil,
            providerId: nil,
            modelId: nil,
            voiceId: nil,
            transport: nil,
            isRealtime: false), persistAsConfigured: true)
        self.defaultModelId = Self.defaultModelIdFallback
        if !self.modelOverrideActive {
            self.currentModelId = self.defaultModelId
        }
        self.gatewayTalkDefaultVoiceId = nil
        self.gatewayTalkDefaultModelId = nil
        self.gatewayTalkApiKeyConfigured = false
    }

    func markTalkPermissionUpgradeRequested(requestId: String?) {
        self.gatewayTalkPermissionState = .upgradeRequested(requestId: requestId)
        self.statusText = "Approval requested"
    }

    private static func missingTalkScope(from error: Error) -> String? {
        let targetScope = "operator.talk.secrets"
        if let gatewayError = error as? GatewayResponseError {
            if Self.errorTextIndicatesMissingScope(gatewayError.message, scope: targetScope) {
                return targetScope
            }
            if let missingScope = gatewayError.details["missingScope"]?.value as? String,
               missingScope == targetScope
            {
                return targetScope
            }
        }
        if Self.errorTextIndicatesMissingScope(error.localizedDescription, scope: targetScope) {
            return targetScope
        }
        return nil
    }

    private static func errorTextIndicatesMissingScope(_ text: String, scope: String) -> Bool {
        let lower = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return lower.contains("missing scope") && lower.contains(scope.lowercased())
    }

    static func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        let forceSpeaker = TalkDefaults.speakerphoneEnabled()
        let options = TalkAudioRoute.categoryOptions(speakerphoneEnabled: forceSpeaker)
        // Prefer `.spokenAudio` for STT; it tends to preserve speech energy better than `.voiceChat`.
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: options)
        try? session.setPreferredSampleRate(48000)
        try? session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true, options: [])
        if TalkAudioRoute.shouldForceSpeaker(
            preferenceEnabled: forceSpeaker,
            outputPortTypes: session.currentRoute.outputs.map(\.portType))
        {
            try? session.overrideOutputAudioPort(.speaker)
        } else {
            try? session.overrideOutputAudioPort(.none)
        }
        GatewayDiagnostics.log("talk audio: session speakerphone=\(forceSpeaker) \(Self.describeAudioSession())")
    }

    static func configureRealtimeAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        let forceSpeaker = TalkDefaults.speakerphoneEnabled()
        let options = TalkAudioRoute.categoryOptions(speakerphoneEnabled: forceSpeaker)
        // Realtime Talk is full duplex. `.voiceChat` enables iOS voice processing so speaker
        // output is less likely to be captured as fresh microphone input.
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
        try? session.setPreferredSampleRate(48000)
        try? session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true, options: [])
        if TalkAudioRoute.shouldForceSpeaker(
            preferenceEnabled: forceSpeaker,
            outputPortTypes: session.currentRoute.outputs.map(\.portType))
        {
            try? session.overrideOutputAudioPort(.speaker)
        } else {
            try? session.overrideOutputAudioPort(.none)
        }
        GatewayDiagnostics.log(
            "talk realtime audio: session speakerphone=\(forceSpeaker) \(Self.describeAudioSession())")
    }

    private static func describeAudioSession() -> String {
        let session = AVAudioSession.sharedInstance()
        let inputs = session.currentRoute.inputs
            .map { "\($0.portType.rawValue):\($0.portName)" }
            .joined(separator: ",")
        let outputs = session.currentRoute.outputs
            .map { "\($0.portType.rawValue):\($0.portName)" }
            .joined(separator: ",")
        let available = session.availableInputs?
            .map { "\($0.portType.rawValue):\($0.portName)" }
            .joined(separator: ",") ?? ""
        return "category=\(session.category.rawValue) mode=\(session.mode.rawValue) "
            + "opts=\(session.categoryOptions.rawValue) inputAvail=\(session.isInputAvailable) "
            + "routeIn=[\(inputs)] routeOut=[\(outputs)] availIn=[\(available)]"
    }
}

private final class AudioTapDiagnostics: @unchecked Sendable {
    private let label: String
    private let onLevel: (@Sendable (Float) -> Void)?
    private let lock = NSLock()
    private var bufferCount: Int = 0
    private var lastLoggedAt = Date.distantPast
    private var lastLevelEmitAt = Date.distantPast
    private var maxRmsWindow: Float = 0
    private var lastRms: Float = 0

    init(label: String, onLevel: (@Sendable (Float) -> Void)? = nil) {
        self.label = label
        self.onLevel = onLevel
    }

    func onBuffer(_ buffer: AVAudioPCMBuffer) {
        var shouldLog = false
        var shouldEmitLevel = false
        var count = 0
        self.lock.lock()
        self.bufferCount += 1
        count = self.bufferCount
        let now = Date()
        if now.timeIntervalSince(self.lastLoggedAt) >= 1.0 {
            self.lastLoggedAt = now
            shouldLog = true
        }
        if now.timeIntervalSince(self.lastLevelEmitAt) >= 0.12 {
            self.lastLevelEmitAt = now
            shouldEmitLevel = true
        }
        self.lock.unlock()

        let rate = buffer.format.sampleRate
        let ch = buffer.format.channelCount
        let frames = buffer.frameLength

        let resolvedRms = Float(TalkAudioLevel.rms(buffer: buffer))
        self.lock.lock()
        self.lastRms = resolvedRms
        if resolvedRms > self.maxRmsWindow { self.maxRmsWindow = resolvedRms }
        let maxRms = self.maxRmsWindow
        if shouldLog { self.maxRmsWindow = 0 }
        self.lock.unlock()

        if shouldEmitLevel, let onLevel {
            onLevel(resolvedRms)
        }

        guard shouldLog else { return }
        GatewayDiagnostics.log(
            "\(self.label) mic: buffers=\(count) frames=\(frames) rate=\(Int(rate))Hz ch=\(ch) "
                + "rms=\(String(format: "%.4f", resolvedRms)) max=\(String(format: "%.4f", maxRms))")
    }
}

extension TalkModeManager: TalkRealtimeWebRTCSessionDelegate {
    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didChangeStatus status: String) {
        guard session === self.realtimeSession else { return }
        GatewayDiagnostics.log("talk.timeline realtime status=\(status)")
        if status == "Listening" {
            self.markRealtimeSessionReady()
        } else {
            self.statusText = status
        }
        self.isListening = status == "Listening"
        self.isSpeaking = status == "Speaking"
        if status == "Thinking" {
            self.isListening = false
            self.isSpeaking = false
            self.isUserSpeechDetected = false
        }
        if !self.isSpeaking {
            self.playbackLevel = nil
        }
    }

    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didDetectInputSpeech active: Bool) {
        guard session === self.realtimeSession else { return }
        self.isUserSpeechDetected = active
        if active {
            self.isListening = true
        }
    }

    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didUpdateAudioLevels input: Double?, output: Double?) {
        guard session === self.realtimeSession else { return }
        if self.isListening, let input {
            // Same smoothing as the SFSpeech tap so route switches keep the wave feel.
            self.micLevel = (self.micLevel * 0.80) + (input * 0.20)
        }
        if self.isSpeaking, let output {
            self.playbackLevel = output
        }
    }

    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didReceiveUserTranscript text: String) {
        guard session === self.realtimeSession else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        GatewayDiagnostics.log("talk.timeline realtime user transcript chars=\(trimmed.count)")
        self.lastTranscript = trimmed
        self.lastHeard = Date()
    }

    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didReceiveAssistantTranscript text: String) {
        guard session === self.realtimeSession else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        GatewayDiagnostics.log("talk.timeline realtime assistant transcript chars=\(trimmed.count)")
        self.lastSpokenText = trimmed
    }

    func realtimeSessionDidFinish(_ session: TalkRealtimeWebRTCSession) {
        guard session === self.realtimeSession else { return }
        self.realtimeSession = nil
        self.handleRealtimeSessionFinish()
    }
}

#if DEBUG
extension TalkModeManager {
    static func _test_shouldRestartRealtimeSession(
        isEnabled: Bool,
        gatewayConnected: Bool,
        captureIsContinuous: Bool) -> Bool
    {
        self.shouldRestartRealtimeSession(
            isEnabled: isEnabled,
            gatewayConnected: gatewayConnected,
            captureIsContinuous: captureIsContinuous)
    }

    static func _test_realtimeRestartAttempt(
        previousRapidRestarts: Int,
        activeDuration: TimeInterval) -> Int
    {
        self.realtimeRestartAttempt(
            previousRapidRestarts: previousRapidRestarts,
            activeDuration: activeDuration)
    }

    static func _test_realtimeRestartDelayNanoseconds(attempt: Int) -> UInt64? {
        self.realtimeRestartDelayNanoseconds(attempt: attempt)
    }

    static func _test_isPCMFormatRejectedByAPI(_ error: Error?) -> Bool {
        self.isPCMFormatRejectedByAPI(error)
    }

    func _test_applyOpenAIRealtimeSelectionDefaults() {
        self.applyOpenAIRealtimeSelectionDefaults()
    }

    func _test_applyLoadedTalkConfig(
        _ parsed: TalkModeGatewayConfigState,
        providerSelection: TalkModeProviderSelection)
    {
        self.applyLoadedTalkConfig(
            parsed,
            redactedFallbackMissingScope: nil,
            providerSelection: providerSelection)
    }

    func _test_runtimeRoute() -> TalkModeRuntimeRoute {
        self.runtimeRoute
    }

    func _test_playAssistant(text: String) async {
        await self.playAssistant(text: text)
    }

    func _test_stopSpeaking(storeInterruption: Bool = true) {
        self.stopSpeaking(storeInterruption: storeInterruption)
    }

    func _test_lastInterruptedAtSeconds() -> Double? {
        self.lastInterruptedAtSeconds
    }

    func _test_hasRecognitionRequest() -> Bool {
        self.recognitionRequest != nil
    }

    func _test_executionMode() -> TalkModeExecutionMode {
        self.executionMode
    }

    func _test_realtimeProvider() -> String? {
        self.realtimeProvider
    }

    func _test_realtimeModelId() -> String? {
        self.realtimeModelId
    }

    func _test_gatewayTalkUsesRealtimeRelay() -> Bool {
        self.gatewayTalkUsesRealtimeRelay
    }

    func _test_markNativeFallbackActive(after issue: TalkRuntimeIssue) {
        self.markNativeFallbackActive(after: issue)
    }

    func _test_recordRealtimeIssue(_ issue: TalkRuntimeIssue) {
        self.pendingRealtimeIssue = issue
        self.gatewayTalkLastIssueText = issue.diagnosticSummary
        self.gatewayTalkActiveModeTitle = "Realtime unavailable"
        self.gatewayTalkActiveModeSubtitle = issue.displayMessage
    }

    func _test_handleRealtimeRelayStatus(_ status: String) {
        self.handleRealtimeRelayStatus(status)
    }

    func _test_prepareEnabledRealtimeSessionForClose() {
        self.isEnabled = true
        self.gatewayConnected = true
        self.captureMode = .idle
        self.realtimeSessionReadyAt = nil
    }

    func _test_rapidRealtimeRestartCount() -> Int {
        self.rapidRealtimeRestartCount
    }

    func _test_realtimeStatusPreservesPushToTalkCapture() -> Bool {
        self.captureMode = .pushToTalk
        self.handleRealtimeRelayStatus("Listening (Realtime)")
        return self.captureMode == .pushToTalk
    }

    func _test_prepareRealtimeRelayStart() {
        self.prepareRealtimeRelayStart()
    }

    func _test_realtimeIssue(from error: Error, phase: String) -> TalkRuntimeIssue {
        self.realtimeIssue(from: error, phase: phase)
    }

    func _test_hasPendingRealtimeIssue() -> Bool {
        self.pendingRealtimeIssue != nil
    }

    func _test_gatewayTalkActiveModeTitle() -> String {
        self.gatewayTalkActiveModeTitle
    }

    func _test_gatewayTalkActiveModeSubtitle() -> String? {
        self.gatewayTalkActiveModeSubtitle
    }

    func _test_gatewayTalkLastIssueText() -> String? {
        self.gatewayTalkLastIssueText
    }

    func _test_gatewayTalkCurrentFallbackIssue() -> TalkRuntimeIssue? {
        self.gatewayTalkCurrentFallbackIssue
    }

    func _test_incrementalReset() {
        self.incrementalSpeechBuffer = IncrementalSpeechBuffer()
    }

    func _test_incrementalIngest(_ text: String, isFinal: Bool) -> [String] {
        self.incrementalSpeechBuffer.ingest(text: text, isFinal: isFinal)
    }
}
#endif

private struct IncrementalSpeechContext: Equatable {
    let apiKey: String?
    let voiceId: String?
    let modelId: String?
    let outputFormat: String?
    let language: String?
    let directive: TalkDirective?
    let canUseElevenLabs: Bool
}

private struct IncrementalSpeechPrefetchState {
    let id: UUID
    let segment: String
    let context: IncrementalSpeechContext
    let outputFormat: String?
    var chunks: [Data]?
    let task: Task<Void, Never>
}

private struct IncrementalPrefetchedAudio {
    let chunks: [Data]
    let outputFormat: String?
}

// swiftlint:enable type_body_length file_length
