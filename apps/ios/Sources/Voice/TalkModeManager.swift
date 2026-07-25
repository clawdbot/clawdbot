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

enum TalkPushToTalkOnceStart {
    case busy(OpenClawTalkPTTStopPayload)
    case started(captureId: String)
}

enum TalkPhase: Equatable {
    case idle
    case connecting
    case listening
    case thinking
    case speaking

    fileprivate var isFinalizerTransient: Bool {
        self == .thinking || self == .speaking
    }
}

enum TalkWatchPresentation: Equatable {
    case localized(String)
    case phase
    case verbatim(String)
}

private struct FinishingPushToTalk {
    let captureId: String
    let generation: UInt64
    let task: Task<Void, Never>
}

private struct ActivePushToTalk {
    let captureId: String
    let gatewayContext: PushToTalkGatewayContext?
    let transcriptionOnly: Bool
}

private enum ChatCompletionState {
    case final
    case aborted
    case error
    case timeout
}

private struct ChatCompletionResult {
    var state: ChatCompletionState
    var assistantText: String?
}

@MainActor
private final class TranscriptStreamingOwner {
    var task: Task<Void, Never>?
    var speechGeneration: Int?
    var terminalStatus: (
        text: String,
        phase: TalkPhase,
        watchPresentation: TalkWatchPresentation)?
    /// Subscribed before chat.send so a fast terminal cannot outrun its owner.
    var completionEvents: AsyncStream<EventFrame>?
}

private enum PushToTalkGatewayContext {
    case connected(
        gateway: GatewayNodeSession,
        route: GatewayNodeSessionRoute,
        sessionKey: String)
    #if DEBUG
    case stateTestFixture
    #endif
}

@MainActor
private final class TalkPushToTalkOnceOperation {
    private var result: OpenClawTalkPTTStopPayload?
    private var continuation: CheckedContinuation<OpenClawTalkPTTStopPayload, Never>?

    func wait() async -> OpenClawTalkPTTStopPayload {
        if let result {
            return result
        }
        return await withCheckedContinuation { continuation in
            if let result = self.result {
                continuation.resume(returning: result)
            } else {
                self.continuation = continuation
            }
        }
    }

    func finish(_ payload: OpenClawTalkPTTStopPayload) {
        guard self.result == nil else { return }
        self.result = payload
        self.continuation?.resume(returning: payload)
        self.continuation = nil
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
    private static let preferredInputDeviceIDKey = "talk.preferredInputDeviceID"
    var isEnabled: Bool = false
    var isListening: Bool = false
    var isSpeaking: Bool = false
    var isUserSpeechDetected: Bool = false
    var isPushToTalkActive: Bool = false
    var hasActivePushToTalkSession: Bool {
        self.isPushToTalkActive || self.activePushToTalk != nil || self.finishingPushToTalk != nil
    }

    private(set) var phase: TalkPhase = .idle
    private(set) var watchPresentation: TalkWatchPresentation = .phase
    var statusText: String = "Off" {
        didSet {
            self.statusRevision &+= 1
        }
    }

    /// 0..1-ish (not calibrated). Intended for UI feedback only.
    var micLevel: Double = 0
    /// Live agent playback envelope in 0...1 while speaking. nil means the active
    /// voice path exposes no real level (system voice, compressed streaming); the
    /// waveform then falls back to a synthetic pulse.
    var playbackLevel: Double?
    private(set) var preferredInputDeviceID: String?
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
    var gatewayTalkActiveModeTitle: String = .init(localized: "Not active")
    var gatewayTalkActiveModeSubtitle: String?
    var gatewayTalkLastIssueText: String?
    var gatewayTalkCurrentFallbackIssue: TalkRuntimeIssue?
    var gatewayTalkPermissionState: TalkGatewayPermissionState = .unknown

    var isGatewayConnected: Bool {
        self.gatewayConnected
    }

    var canKeepContinuousTalkActiveInBackground: Bool {
        self.isEnabled &&
            self.activePushToTalk == nil &&
            self.finishingPushToTalk == nil &&
            self.hasContinuousTalkOwner
    }

    private var hasContinuousTalkOwner: Bool {
        self.captureMode == .continuous ||
            self.continuousTranscriptProcessingGeneration == self.transcriptProcessingGeneration
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
    private static let realtimeVoiceSessionCloseRetryDelaysNanoseconds: [UInt64] = [0, 500_000_000, 2_000_000_000]

    private var isStarting = false
    private var startAttemptID = 0
    private var captureMode: CaptureMode = .idle
    private var foregroundAudioCaptureAllowed = true
    private var foregroundPushToTalkAllowed = true
    private var activePushToTalk: ActivePushToTalk?
    private var activePTTCaptureId: String? {
        self.activePushToTalk?.captureId
    }

    private var finishingPushToTalk: FinishingPushToTalk?
    private var transcriptProcessingGeneration: UInt64 = 0
    private var continuousTranscriptProcessingGeneration: UInt64?
    private var pttAudioOwnershipEndHandler: (@MainActor (String) -> Void)?
    private var pttAutoStopEnabled: Bool = false
    private var pttOnceOperations: [String: TalkPushToTalkOnceOperation] = [:]
    private var pttTimeoutTask: Task<Void, Never>?

    private let allowSimulatorCapture: Bool
    private let gatewaySpeechSynthesizerOverride: (any TalkGatewaySpeechSynthesizing)?
    private let audioSessionDeactivationAction: (@MainActor () throws -> Void)?
    private var audioSessionIsActive = false

    private let audioEngine = AVAudioEngine()
    private var inputTapInstalled = false
    private var audioTapDiagnostics: AudioTapDiagnostics?
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionGeneration: UInt64 = 0
    private var silenceTask: Task<Void, Never>?
    private var realtimeSession: TalkRealtimeWebRTCSession?
    private var activeRealtimeVoiceSessionId: String?
    private var realtimeVoiceSessionGeneration: UInt64 = 0
    private let realtimeTranscriptStore = TalkRealtimeTranscriptStore()
    private var realtimeSessionReadyAt: Date?
    private var rapidRealtimeRestartCount = 0
    private var bypassRealtimeOnNextStart = false
    private var realtimeRestartGeneration = 0
    private var realtimeRelaySession: RealtimeTalkRelaySession?
    private var realtimeRelayStartGeneration: UInt64?
    private var realtimeRelayGeneration: UInt64 = 0
    private var prefetchedRealtimeSession: TalkRealtimeClientSession?
    private var realtimePrefetchTask: Task<Void, Never>?
    private var realtimePrefetchGeneration: UInt64 = 0

    private var lastHeard: Date?
    private var lastTranscript: String = ""
    private var loggedPartialThisCycle: Bool = false
    private var lastSpokenText: String?
    private var lastInterruptedAtSeconds: Double?
    // Presentation copy can change independently; the revision lets restart cleanup
    // replace only the status it published without interpreting localized text.
    @ObservationIgnored private var speechErrorStatusRevisionPendingRestart: UInt64?
    @ObservationIgnored private var statusRevision: UInt64 = 0

    private var defaultVoiceId: String?
    private var currentVoiceId: String?
    private var defaultModelId: String?
    private var currentModelId: String?
    private var configuredProviderModelId: String?
    private var voiceOverrideActive = false
    private var modelOverrideActive = false
    private var defaultOutputFormat: String?
    private var executionMode: TalkModeExecutionMode = .native
    private var runtimeRoute: TalkModeRuntimeRoute = .localElevenLabs
    private var realtimeProvider: String?
    private var realtimeModelId: String?
    private var realtimeVoiceId: String?
    private var configuredVoiceModeDescriptor = TalkVoiceModeDescriptor(
        title: String(localized: "Not loaded"),
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

    private var incrementalSpeechQueue: [String] = []
    private var incrementalSpeechTask: Task<Void, Never>?
    private var incrementalSpeechTasksByGeneration: [Int: Task<Void, Never>] = [:]
    private var incrementalSpeechActive = false
    private var incrementalSpeechUsed = false
    private var incrementalSpeechLanguage: String?
    private var incrementalSpeechBuffer = IncrementalSpeechBuffer()
    private var incrementalSpeechContext: IncrementalSpeechContext?
    private var incrementalSpeechDirective: TalkDirective?
    private var incrementalSpeechPrefetch: IncrementalSpeechPrefetchState?
    private var incrementalSpeechPrefetchMonitorTask: Task<Void, Never>?

    #if DEBUG
    @ObservationIgnored private var testStartEntryHandler: (@MainActor () async -> Void)?
    @ObservationIgnored private var testPTTFinalizerHandler: (@MainActor () async -> Void)?
    @ObservationIgnored private var testPTTOnceStartedHandler: (@MainActor () async -> Void)?
    @ObservationIgnored private var testPTTReservedHandler: (@MainActor () async -> Void)?
    @ObservationIgnored private var testRealtimeVoiceSessionCloseRequest:
        (@MainActor (_ method: String, _ paramsJSON: String?) async throws -> Void)?
    #endif

    private let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "TalkMode")

    private static func nowSeconds() -> TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }

    private static func elapsedMs(since start: TimeInterval) -> Int {
        max(0, Int((self.nowSeconds() - start) * 1000))
    }

    @discardableResult
    private func setStatus(
        _ text: String,
        phase: TalkPhase,
        watchPresentation: TalkWatchPresentation = .phase) -> UInt64
    {
        self.phase = phase
        self.watchPresentation = watchPresentation
        self.statusText = text
        return self.statusRevision
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
        guard self.captureMode != .pushToTalk else { return }
        self.isListening = true
        self.captureMode = .continuous
        if self.realtimeSessionReadyAt == nil {
            self.realtimeSessionReadyAt = Date()
        }
        markRealtimeActive()
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
        self.gatewayTalkActiveModeTitle = String(localized: "Not active")
        self.gatewayTalkActiveModeSubtitle = nil
        guard shouldRestart else {
            if self.isEnabled {
                self.setStatus(
                    self.gatewayConnected
                        ? String(localized: "Ready")
                        : String(localized: "Offline"),
                    phase: .idle)
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
            let issue = realtimeIssue(
                message: "Realtime disconnected repeatedly.",
                phase: "reconnect")
            self.pendingRealtimeIssue = issue
            self.gatewayTalkLastIssueText = issue.diagnosticSummary
            self.bypassRealtimeOnNextStart = true
            self.scheduleRealtimeRestart(after: nil, generation: restartGeneration)
            return
        }
        self.setStatus(String(localized: "Reconnecting"), phase: .connecting)
        self.scheduleRealtimeRestart(after: delay, generation: restartGeneration)
    }

    init(
        allowSimulatorCapture: Bool = false,
        gatewaySpeechSynthesizer: (any TalkGatewaySpeechSynthesizing)? = nil,
        audioSessionDeactivationAction: (@MainActor () throws -> Void)? = nil)
    {
        self.allowSimulatorCapture = allowSimulatorCapture
        self.gatewaySpeechSynthesizerOverride = gatewaySpeechSynthesizer
        self.audioSessionDeactivationAction = audioSessionDeactivationAction
        self.preferredInputDeviceID = UserDefaults.standard.string(
            forKey: Self.preferredInputDeviceIDKey)
        super.init()
    }

    func selectInputDevice(_ deviceID: String?) {
        let normalizedID = deviceID.flatMap { $0.isEmpty ? nil : $0 }
        self.preferredInputDeviceID = normalizedID
        if let normalizedID {
            UserDefaults.standard.set(normalizedID, forKey: Self.preferredInputDeviceIDKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.preferredInputDeviceIDKey)
        }

        guard self.audioSessionIsActive else { return }
        Self.applyPreferredInput(normalizedID, to: AVAudioSession.sharedInstance())
    }

    func attachGateway(_ gateway: GatewayNodeSession) {
        if let current = self.gateway, current !== gateway {
            // Local dictation has no gateway owner, so a route replacement must
            // not discard an in-progress draft capture.
            if let captureId = activePTTCaptureId,
               self.activePushToTalk?.transcriptionOnly != true
            {
                _ = self.cancelPushToTalk(captureId: captureId)
            }
            self.cancelFinishingPushToTalk()
        }
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
            self.cancelPendingStart()
            let preservesLocalTranscription = self.activePushToTalk?.transcriptionOnly == true
            if let captureId = activePTTCaptureId, !preservesLocalTranscription {
                _ = self.cancelPushToTalk(captureId: captureId)
            }
            self.cancelFinishingPushToTalk()
            self.resetRealtimeRestartState()
            self.stopRealtimeSession()
            if !preservesLocalTranscription {
                self.stopNativeCaptureAndDiscardTranscript()
                self.stopSpeaking(storeInterruption: false)
                deactivateAudioSession()
                if self.isEnabled, !self.isSpeaking {
                    self.setStatus(String(localized: "Offline"), phase: .idle)
                }
            }
            self.gatewayTalkActiveModeTitle = String(localized: "Not active")
            self.gatewayTalkActiveModeSubtitle = nil
            self.cancelRealtimePrefetch()
            self.invalidatePrefetchedRealtimeSession()
        }
    }

    @discardableResult
    func updateMainSessionKey(_ sessionKey: String?) -> Bool {
        let trimmed = (sessionKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if trimmed == self.mainSessionKey {
            return false
        }
        let hasTalkOwner = self.hasRealtimeOwnerOrStart || self.hasContinuousTalkOwner
        let shouldRestartTalk = self.isEnabled && hasTalkOwner
        if let captureId = activePTTCaptureId {
            _ = self.cancelPushToTalk(captureId: captureId)
        }
        self.cancelFinishingPushToTalk()
        self.cancelRealtimePrefetch()
        if hasTalkOwner {
            // Session identity owns every in-flight relay/capture generation, even while
            // Talk is disabled. Leaving one alive can publish work into the replacement session.
            self.cancelPendingStart()
            self.resetRealtimeRestartState()
            self.stopRealtimeSession()
            self.stopNativeCaptureAndDiscardTranscript()
            deactivateAudioSession()
        }
        self.closeLogicalRealtimeVoiceSessions()
        self.mainSessionKey = trimmed
        if shouldRestartTalk, self.gatewayConnected, self.isEnabled {
            Task { await self.start() }
        }
        return true
    }

    func isUsingMainSessionKey(_ sessionKey: String?) -> Bool {
        let trimmed = (sessionKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed == self.mainSessionKey
    }

    func isActivePushToTalkCapture(_ captureId: String) -> Bool {
        self.activePTTCaptureId == captureId
    }

    func enterScreenshotFixtureMode() {
        self.updateGatewayConnected(true)
        self.isEnabled = false
        self.isListening = false
        self.isSpeaking = false
        self.isUserSpeechDetected = false
        self.setStatus(String(localized: "Ready"), phase: .idle)
        self.gatewayTalkConfigLoaded = true
        self.gatewayTalkApiKeyConfigured = true
        self.gatewayTalkDefaultModelId = "gpt-realtime-2"
        self.gatewayTalkDefaultVoiceId = "marin"
        self.gatewayTalkProviderLabel = "OpenAI"
        self.gatewayTalkTransportLabel = String(localized: "Gateway Relay")
        self.gatewayTalkUsesRealtime = true
        self.gatewayTalkUsesRealtimeRelay = true
        self.gatewayTalkRealtimeProviderLabel = "OpenAI"
        self.gatewayTalkRealtimeModelId = "gpt-realtime-2"
        self.gatewayTalkRealtimeVoiceId = "marin"
        self.gatewayTalkVoiceModeTitle = String(localized: "Realtime Voice")
        self.gatewayTalkVoiceModeSubtitle = String(localized: "Gateway relay ready")
        self.gatewayTalkVoiceModeAccessibilityValue = String(
            localized: "Realtime Voice, Gateway relay ready")
        self.gatewayTalkActiveModeTitle = String(localized: "Ready")
        self.gatewayTalkActiveModeSubtitle = String(localized: "Listening starts from this phone")
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
        guard self.audioSessionIsActive else { return }
        do {
            if let realtimeSession {
                try realtimeSession.applyAudioRoutePreferenceChanged()
            } else if self.realtimeRelaySession != nil {
                try configureOwnedRealtimeAudioSession()
            } else {
                try configureOwnedAudioSession()
            }
        } catch {
            GatewayDiagnostics.log("talk audio route preference failed error=\(error.localizedDescription)")
        }
    }

    func start() async {
        GatewayDiagnostics.log(
            "talk.timeline manager start enter enabled=\(self.isEnabled) "
                + "listening=\(self.isListening) gatewayConnected=\(self.gatewayConnected)")
        guard self.canBeginStart() else { return }

        self.isStarting = true
        self.startAttemptID += 1
        let attemptID = self.startAttemptID
        defer {
            if self.startAttemptID == attemptID {
                self.isStarting = false
            }
        }
        #if DEBUG
        if let testStartEntryHandler {
            await testStartEntryHandler()
            guard self.isCurrentStartAttempt(attemptID) else { return }
        }
        #endif
        self.logger.info("start")
        self.setStatus(String(localized: "Requesting permissions…"), phase: .connecting)
        let permissionStartedAt = Self.nowSeconds()
        let micOk = if self.allowSimulatorCapture {
            true
        } else {
            await Self.requestMicrophonePermission()
        }
        GatewayDiagnostics.log(
            "talk.timeline microphone permission ok=\(micOk) "
                + "elapsedMs=\(Self.elapsedMs(since: permissionStartedAt))")
        guard micOk else {
            self.logger.warning("start blocked: microphone permission denied")
            self.setStatus(
                String(localized: "Microphone permission denied"),
                phase: .idle,
                watchPresentation: .localized("Microphone permission denied"))
            return
        }
        guard self.isCurrentStartAttempt(attemptID) else { return }
        await ensureTalkConfigLoadedForStart()
        guard self.isCurrentStartAttempt(attemptID) else { return }
        if self.gatewayTalkPermissionState.requiresTalkPermissionAction {
            self.setStatus(String(localized: "Gateway permission required"), phase: .idle)
            GatewayDiagnostics.log("talk.timeline manager start blocked gateway permission")
            return
        }
        let bypassRealtime = self.bypassRealtimeOnNextStart
        self.bypassRealtimeOnNextStart = false
        if self.runtimeRoute.usesRealtime, !bypassRealtime {
            let realtimeStart = self.executionMode == .realtimeRelay
                ? await self.startRealtimeRelayIfAvailable(attemptID: attemptID)
                : await self.startRealtimeIfAvailable(attemptID: attemptID)
            switch realtimeStart {
            case .started, .ignored:
                return
            case let .unavailable(issue):
                self.pendingRealtimeIssue = issue
                self.gatewayTalkLastIssueText = issue.diagnosticSummary
            }
        }

        let speechOk = if self.allowSimulatorCapture {
            true
        } else {
            await Self.requestSpeechPermission()
        }
        guard speechOk else {
            self.logger.warning("start blocked: speech permission denied")
            self.stopNativeCaptureAndDiscardTranscript()
            deactivateAudioSession()
            let status = Self.permissionMessage(
                kind: String(localized: "Speech recognition"),
                status: SFSpeechRecognizer.authorizationStatus())
            self.setStatus(
                status,
                phase: .idle,
                watchPresentation: .verbatim(status))
            return
        }
        guard self.isCurrentStartAttempt(attemptID) else { return }

        do {
            GatewayDiagnostics.log("talk.timeline fallback speech pipeline start")
            try configureOwnedAudioSession()
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
            self.logger.info("listening")
        } catch {
            self.stopNativeCaptureAndDiscardTranscript()
            deactivateAudioSession()
            let status = String(
                format: String(localized: "Start failed: %@"),
                error.localizedDescription)
            self.setStatus(
                status,
                phase: .idle,
                watchPresentation: .verbatim(status))
            self.logger.error("start failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func canBeginStart() -> Bool {
        guard self.isEnabled else { return false }
        guard self.captureMode != .pushToTalk else { return false }
        guard self.finishingPushToTalk == nil else { return false }
        guard self.foregroundAudioCaptureAllowed else {
            self.setStatus(
                String(localized: "Paused"),
                phase: .idle,
                watchPresentation: .localized("Paused"))
            GatewayDiagnostics.log("talk start ignored: app backgrounded")
            return false
        }
        // Realtime callbacks own Listening/Thinking/Speaking while their session
        // exists. An idempotent enable must not replace that owner or its phase.
        guard !self.hasRealtimeOwnerOrStart else { return false }
        guard !self.isListening else { return false }
        guard !self.isStarting else {
            GatewayDiagnostics.log("talk start ignored: already starting")
            return false
        }
        guard self.gatewayConnected else {
            self.setStatus(String(localized: "Offline"), phase: .idle)
            GatewayDiagnostics.log("talk.timeline manager start blocked gateway offline")
            return false
        }
        return true
    }

    private func isCurrentStartAttempt(_ attemptID: Int) -> Bool {
        self.startAttemptID == attemptID &&
            self.isEnabled &&
            self.gatewayConnected &&
            self.captureMode != .pushToTalk &&
            self.finishingPushToTalk == nil &&
            self.foregroundAudioCaptureAllowed
    }

    private func cancelPendingStart() {
        self.startAttemptID += 1
        self.isStarting = false
    }

    private func cancelRealtimePrefetch() {
        self.realtimePrefetchGeneration &+= 1
        self.realtimePrefetchTask?.cancel()
        self.realtimePrefetchTask = nil
    }

    private var talkProviderSelection: TalkModeProviderSelection {
        TalkModeProviderSelection.resolved(
            UserDefaults.standard.string(forKey: TalkModeProviderSelection.storageKey))
    }

    private var shouldUseOpenAIRealtimeSelectionFallback: Bool {
        self.talkProviderSelection == .openAIRealtime
    }

    private var hasRealtimeOwnerOrStart: Bool {
        self.realtimeSession != nil ||
            self.realtimeRelaySession != nil ||
            self.realtimeRelayStartGeneration != nil
    }

    private func applyOpenAIRealtimeSelectionDefaults() {
        let realtimeVoiceOverride = TalkModeRealtimeVoiceSelection.resolvedOverride(
            UserDefaults.standard.string(forKey: TalkModeRealtimeVoiceSelection.storageKey))
        self.executionMode = .realtimeWebRTC
        self.runtimeRoute = .realtimeWebRTC
        self.realtimeProvider = "openai"
        self.realtimeModelId = Self.defaultRealtimeModelIdFallback
        self.realtimeVoiceId = realtimeVoiceOverride
        self.gatewayTalkProviderLabel = TalkModeProviderSelection.openAIRealtime.label
        self.gatewayTalkUsesRealtime = true
        self.gatewayTalkUsesRealtimeRelay = false
        self.gatewayTalkTransportLabel = String(localized: "Native WebRTC")
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
        self.cancelFinishingPushToTalk()
        self.isListening = false
        self.isUserSpeechDetected = false
        self.isPushToTalkActive = false
        self.captureMode = .idle
        self.setStatus(String(localized: "Off"), phase: .idle)
        self.pendingRealtimeIssue = nil
        self.gatewayTalkCurrentFallbackIssue = nil
        self.gatewayTalkActiveModeTitle = String(localized: "Not active")
        self.gatewayTalkActiveModeSubtitle = nil
        self.gatewayTalkLastIssueText = nil
        self.lastTranscript = ""
        self.lastHeard = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.resetRealtimeRestartState()
        self.cancelRealtimePrefetch()
        self.stopRealtimeSession()
        self.closeLogicalRealtimeVoiceSessions()
        self.stopRecognition()
        self.stopSpeaking()
        self.lastInterruptedAtSeconds = nil
        let pendingCaptureId = self.activePTTCaptureId
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false
        if let pendingCaptureId, pttOnceOperations[pendingCaptureId] != nil {
            let payload = OpenClawTalkPTTStopPayload(
                captureId: pendingCaptureId,
                transcript: nil,
                status: "cancelled")
            self.finishPTTOnce(payload)
        }
        if let pendingCaptureId {
            self.finishActivePushToTalk(pendingCaptureId)
        }
        TalkSystemSpeechSynthesizer.shared.stop()
        deactivateAudioSession()
    }

    /// Suspends microphone usage without disabling Talk Mode.
    /// Used when the app backgrounds (or when we need to temporarily release the mic).
    func suspendForBackground(keepActive: Bool = false) {
        let keepContinuousActive = keepActive && self.canKeepContinuousTalkActiveInBackground
        self.foregroundAudioCaptureAllowed = keepContinuousActive
        self.foregroundPushToTalkAllowed = false
        guard self.isEnabled || self.activePTTCaptureId != nil || self.finishingPushToTalk != nil else { return }
        if keepContinuousActive {
            if self.isListening {
                self.setStatus(String(localized: "Listening"), phase: .listening)
            }
            return
        }
        self.cancelFinishingPushToTalk()
        let pendingCaptureId = self.activePTTCaptureId
        self.cancelPendingStart()
        self.isListening = false
        self.isPushToTalkActive = false
        self.captureMode = .idle
        self.setStatus(
            String(localized: "Paused"),
            phase: .idle,
            watchPresentation: .localized("Paused"))
        self.gatewayTalkActiveModeTitle = String(localized: "Paused")
        self.gatewayTalkActiveModeSubtitle = nil
        self.lastTranscript = ""
        self.lastHeard = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false
        self.resetRealtimeRestartState()
        self.stopRealtimeSession()
        self.stopRecognition()
        self.stopSpeaking()
        self.lastInterruptedAtSeconds = nil
        if let pendingCaptureId {
            let payload = OpenClawTalkPTTStopPayload(
                captureId: pendingCaptureId,
                transcript: nil,
                status: "cancelled")
            self.finishPTTOnce(payload)
            // Release Voice Wake only after PTT has relinquished the audio engine.
            self.finishActivePushToTalk(pendingCaptureId)
        }
        TalkSystemSpeechSynthesizer.shared.stop()

        deactivateAudioSession()
    }

    func resumeAfterBackground(wasKeptActive: Bool = false) {
        self.foregroundPushToTalkAllowed = true
        self.foregroundAudioCaptureAllowed = true
        if wasKeptActive, self.hasContinuousTalkOwner {
            return
        }
        guard self.isEnabled else { return }
        Task { @MainActor [weak self] in
            await self?.start()
        }
    }

    func beginPushToTalk(
        transcriptionOnly: Bool = false,
        canStartCapture: @MainActor () -> Bool = { true },
        onCaptureReserved: @MainActor (String) -> Void = { _ in }) async throws -> OpenClawTalkPTTStartPayload
    {
        try Task.checkCancellation()
        guard canStartCapture(), self.foregroundPushToTalkAllowed else {
            throw Self.pushToTalkStartCancelledError()
        }
        if self.isPushToTalkActive, let activePushToTalk {
            guard activePushToTalk.transcriptionOnly == transcriptionOnly else {
                throw Self.pushToTalkModeConflictError()
            }
            return OpenClawTalkPTTStartPayload(captureId: activePushToTalk.captureId)
        }
        if self.finishingPushToTalk != nil {
            throw Self.pushToTalkBusyError()
        }
        guard transcriptionOnly || self.gatewayConnected else { throw self.pushToTalkOfflineError() }

        let gatewayContext: PushToTalkGatewayContext?
        if transcriptionOnly {
            gatewayContext = nil
        } else if let gateway {
            let gatewayRoute = await gateway.currentRoute()
            try Task.checkCancellation()
            guard canStartCapture(), self.gatewayConnected, self.gateway === gateway else {
                throw Self.pushToTalkStartCancelledError()
            }
            if let gatewayRoute {
                gatewayContext = .connected(
                    gateway: gateway,
                    route: gatewayRoute,
                    sessionKey: self.mainSessionKey)
            } else {
                #if DEBUG
                guard self.allowSimulatorCapture else { throw self.pushToTalkOfflineError() }
                gatewayContext = .stateTestFixture
                #else
                throw self.pushToTalkOfflineError()
                #endif
            }
        } else {
            #if DEBUG
            guard self.allowSimulatorCapture else { throw self.pushToTalkOfflineError() }
            gatewayContext = .stateTestFixture
            #else
            throw self.pushToTalkOfflineError()
            #endif
        }
        try Task.checkCancellation()
        guard canStartCapture(), transcriptionOnly || self.gatewayConnected, self.foregroundPushToTalkAllowed else {
            throw Self.pushToTalkStartCancelledError()
        }
        guard self.activePushToTalk == nil, self.finishingPushToTalk == nil else {
            throw Self.pushToTalkBusyError()
        }

        self.invalidateTranscriptProcessing()
        self.stopSpeaking(storeInterruption: false)
        self.cancelPendingStart()
        self.resetRealtimeRestartState()
        self.captureMode = .idle
        self.stopRealtimeSession()
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false

        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.stopRecognition()
        self.isListening = false
        self.isUserSpeechDetected = false

        let captureId = UUID().uuidString
        self.activePushToTalk = ActivePushToTalk(
            captureId: captureId,
            gatewayContext: gatewayContext,
            transcriptionOnly: transcriptionOnly)
        // Reserve the capture mode before permission awaits so delayed continuous
        // starts cannot open a second microphone while PTT is preparing.
        self.captureMode = .pushToTalk
        onCaptureReserved(captureId)
        self.lastTranscript = ""
        self.lastHeard = nil

        do {
            #if DEBUG
            if let testPTTReservedHandler {
                await testPTTReservedHandler()
                try self.ensurePushToTalkStartCurrent(captureId: captureId, canStartCapture: canStartCapture)
            }
            #endif
            self.setStatus(String(localized: "Requesting permissions…"), phase: .connecting)
            try await self.requestPushToTalkPermissions(
                captureId: captureId,
                canStartCapture: canStartCapture)

            try self.ensurePushToTalkStartCurrent(captureId: captureId, canStartCapture: canStartCapture)
            try configureOwnedAudioSession()
            try self.ensurePushToTalkStartCurrent(captureId: captureId, canStartCapture: canStartCapture)
            self.captureMode = .pushToTalk
            try self.startRecognition(pttCaptureId: captureId)
            try self.ensurePushToTalkStartCurrent(captureId: captureId, canStartCapture: canStartCapture)
            self.isListening = true
            self.isPushToTalkActive = true
            self.setStatus(String(localized: "Listening (PTT)"), phase: .listening)
        } catch {
            if self.activePTTCaptureId == captureId {
                self.stopRecognition()
                self.isListening = false
                self.isUserSpeechDetected = false
                self.isPushToTalkActive = false
                self.captureMode = .idle
                self.finishActivePushToTalk(captureId)
                let nsError = error as NSError
                let isPermissionError = nsError.domain == "TalkMode" && (nsError.code == 4 || nsError.code == 5)
                let isCancelled = error is CancellationError || (nsError.domain == "TalkMode" && nsError.code == 9)
                if isCancelled {
                    self.setStatus(String(localized: "Ready"), phase: .idle)
                } else if !isPermissionError {
                    let status = String(
                        format: String(localized: "Start failed: %@"),
                        error.localizedDescription)
                    self.setStatus(
                        status,
                        phase: .idle,
                        watchPresentation: .verbatim(status))
                }
            }
            let shouldResume = self.isEnabled
            self.scheduleContinuousResume(shouldResume)
            throw error
        }

        return OpenClawTalkPTTStartPayload(captureId: captureId)
    }

    func endPushToTalk() -> OpenClawTalkPTTStopPayload {
        let captureId = self.activePTTCaptureId ?? UUID().uuidString
        return self.endPushToTalk(captureId: captureId)
    }

    func endPushToTalk(expectedTranscriptionOnly: Bool) -> OpenClawTalkPTTStopPayload {
        guard let activePushToTalk,
              activePushToTalk.transcriptionOnly == expectedTranscriptionOnly
        else {
            return OpenClawTalkPTTStopPayload(
                captureId: UUID().uuidString,
                transcript: nil,
                status: "idle")
        }
        return self.endPushToTalk(captureId: activePushToTalk.captureId)
    }

    func endPushToTalk(captureId: String) -> OpenClawTalkPTTStopPayload {
        guard let activePushToTalk,
              activePushToTalk.captureId == captureId
        else {
            return OpenClawTalkPTTStopPayload(captureId: captureId, transcript: nil, status: "idle")
        }
        guard self.isPushToTalkActive else {
            let shouldResume = self.isEnabled
            self.isListening = false
            self.isUserSpeechDetected = false
            self.captureMode = .idle
            self.stopRecognition()
            self.pttTimeoutTask?.cancel()
            self.pttTimeoutTask = nil
            self.pttAutoStopEnabled = false
            self.setStatus(String(localized: "Ready"), phase: .idle)
            self.finishActivePushToTalk(captureId)
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "idle")
            self.finishPTTOnce(payload)
            self.scheduleContinuousResume(shouldResume)
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
            self.setStatus(String(localized: "Ready"), phase: .idle)
            let shouldResume = self.isEnabled
            self.finishActivePushToTalk(captureId)
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "empty")
            self.finishPTTOnce(payload)
            self.scheduleContinuousResume(shouldResume)
            return payload
        }

        if activePushToTalk.transcriptionOnly {
            self.setStatus(String(localized: "Ready"), phase: .idle)
            let shouldResume = self.isEnabled
            self.finishActivePushToTalk(captureId)
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: transcript,
                status: "transcribed")
            self.finishPTTOnce(payload)
            self.scheduleContinuousResume(shouldResume)
            return payload
        }

        guard self.gatewayConnected else {
            self.setStatus(String(localized: "Gateway not connected"), phase: .idle)
            let shouldResume = self.isEnabled
            self.finishActivePushToTalk(captureId)
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: transcript,
                status: "offline")
            self.finishPTTOnce(payload)
            self.scheduleContinuousResume(shouldResume)
            return payload
        }

        let payload = OpenClawTalkPTTStopPayload(
            captureId: captureId,
            transcript: transcript,
            status: "queued")
        // Finishing owns shared chat/TTS state after microphone capture ends.
        // Publish it first so a replacement cannot overlap old finalizer cleanup.
        guard let gatewayContext = activePushToTalk.gatewayContext else {
            preconditionFailure("Agent push-to-talk requires a gateway context")
        }
        self.startFinishingPushToTalk(
            captureId: captureId,
            transcript: transcript,
            gatewayContext: gatewayContext)
        // Reply generation can open interruption recognition. Keep the PTT
        // external-audio lease until that finalizer exits or is canceled.
        self.transferActivePushToTalkToFinalizer(captureId)
        self.finishPTTOnce(payload)
        return payload
    }

    func beginPushToTalkOnce(
        maxDurationSeconds: TimeInterval = 12,
        transcriptionOnly: Bool = false,
        canStartCapture: @MainActor () -> Bool = { true },
        onCaptureReserved: @MainActor (String) -> Void = { _ in }) async throws -> TalkPushToTalkOnceStart
    {
        if let captureId = activePTTCaptureId ?? finishingPushToTalk?.captureId {
            return .busy(OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "busy"))
        }

        let start = try await beginPushToTalk(
            transcriptionOnly: transcriptionOnly,
            canStartCapture: canStartCapture,
            onCaptureReserved: onCaptureReserved)
        let captureId = start.captureId
        do {
            #if DEBUG
            if let testPTTOnceStartedHandler {
                await testPTTOnceStartedHandler()
            }
            #endif
            try self.ensurePushToTalkStartCurrent(
                captureId: captureId,
                canStartCapture: canStartCapture)
            self.pttOnceOperations[captureId] = TalkPushToTalkOnceOperation()
            self.pttAutoStopEnabled = true
            self.startSilenceMonitor(pttCaptureId: captureId)
            self.schedulePTTTimeout(seconds: maxDurationSeconds, captureId: captureId)
            return .started(captureId: captureId)
        } catch {
            _ = self.cancelPushToTalk(captureId: captureId)
            throw error
        }
    }

    func awaitPushToTalkOnce(_ start: TalkPushToTalkOnceStart) async -> OpenClawTalkPTTStopPayload {
        switch start {
        case let .busy(payload):
            return payload
        case let .started(captureId):
            guard let operation = pttOnceOperations[captureId] else {
                return OpenClawTalkPTTStopPayload(captureId: captureId, transcript: nil, status: "idle")
            }
            let payload = await withTaskCancellationHandler {
                await operation.wait()
            } onCancel: {
                Task { @MainActor [weak self] in
                    _ = self?.cancelPushToTalk(captureId: captureId)
                }
            }
            self.pttOnceOperations.removeValue(forKey: captureId)
            return payload
        }
    }

    func cancelPushToTalk() -> OpenClawTalkPTTStopPayload {
        let captureId = self.activePTTCaptureId ?? UUID().uuidString
        return self.cancelPushToTalk(captureId: captureId)
    }

    func cancelPushToTalk(expectedTranscriptionOnly: Bool) -> OpenClawTalkPTTStopPayload {
        guard let activePushToTalk,
              activePushToTalk.transcriptionOnly == expectedTranscriptionOnly
        else {
            return OpenClawTalkPTTStopPayload(
                captureId: UUID().uuidString,
                transcript: nil,
                status: "idle")
        }
        return self.cancelPushToTalk(captureId: activePushToTalk.captureId)
    }

    func cancelPushToTalk(captureId: String) -> OpenClawTalkPTTStopPayload {
        guard self.activePTTCaptureId == captureId else {
            return OpenClawTalkPTTStopPayload(captureId: captureId, transcript: nil, status: "idle")
        }

        let shouldResume = self.isEnabled
        self.isPushToTalkActive = false
        self.isListening = false
        self.captureMode = .idle
        self.stopRecognition()
        self.lastTranscript = ""
        self.lastHeard = nil
        self.pttAutoStopEnabled = false
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.finishActivePushToTalk(captureId)
        self.setStatus(String(localized: "Ready"), phase: .idle)

        let payload = OpenClawTalkPTTStopPayload(
            captureId: captureId,
            transcript: nil,
            status: "cancelled")
        self.finishPTTOnce(payload)

        self.scheduleContinuousResume(shouldResume)
        return payload
    }

    private func ensurePushToTalkStartCurrent(
        captureId: String,
        canStartCapture: @MainActor () -> Bool) throws
    {
        try Task.checkCancellation()
        guard self.activePTTCaptureId == captureId, canStartCapture() else {
            throw Self.pushToTalkStartCancelledError()
        }
    }

    private func requestPushToTalkPermissions(
        captureId: String,
        canStartCapture: @MainActor () -> Bool) async throws
    {
        guard !self.allowSimulatorCapture else { return }

        let micOk = await Self.requestMicrophonePermission()
        try self.ensurePushToTalkStartCurrent(captureId: captureId, canStartCapture: canStartCapture)
        guard micOk else {
            self.setStatus(
                String(localized: "Microphone permission denied"),
                phase: .idle,
                watchPresentation: .localized("Microphone permission denied"))
            throw NSError(domain: "TalkMode", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "Microphone permission denied",
            ])
        }

        let speechOk = await Self.requestSpeechPermission()
        try self.ensurePushToTalkStartCurrent(captureId: captureId, canStartCapture: canStartCapture)
        guard speechOk else {
            let status = Self.permissionMessage(
                kind: String(localized: "Speech recognition"),
                status: SFSpeechRecognizer.authorizationStatus())
            self.setStatus(
                status,
                phase: .idle,
                watchPresentation: .verbatim(status))
            throw NSError(domain: "TalkMode", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "Speech recognition permission denied",
            ])
        }
    }

    private static func pushToTalkStartCancelledError() -> NSError {
        NSError(domain: "TalkMode", code: 9, userInfo: [
            NSLocalizedDescriptionKey: "PTT_CANCELLED: push-to-talk start was cancelled",
        ])
    }

    private static func pushToTalkBusyError() -> NSError {
        NSError(domain: "TalkMode", code: 10, userInfo: [
            NSLocalizedDescriptionKey: "PTT_BUSY: previous push-to-talk turn is still finishing",
        ])
    }

    private static func pushToTalkModeConflictError() -> NSError {
        NSError(domain: "TalkMode", code: 10, userInfo: [
            NSLocalizedDescriptionKey: "PTT_BUSY: another capture mode owns the microphone",
        ])
    }

    private func pushToTalkOfflineError() -> NSError {
        self.setStatus(String(localized: "Offline"), phase: .idle)
        return NSError(domain: "TalkMode", code: 7, userInfo: [
            NSLocalizedDescriptionKey: "Gateway not connected",
        ])
    }

    func setPushToTalkAudioOwnershipEndHandler(_ handler: (@MainActor (String) -> Void)?) {
        self.pttAudioOwnershipEndHandler = handler
    }

    private func clearActivePushToTalk(_ captureId: String) -> Bool {
        guard self.activePTTCaptureId == captureId else { return false }
        self.activePushToTalk = nil
        return true
    }

    private func finishActivePushToTalk(_ captureId: String) {
        guard self.clearActivePushToTalk(captureId) else { return }
        deactivateStandaloneAudioSessionIfIdle()
        self.pttAudioOwnershipEndHandler?(captureId)
    }

    private func transferActivePushToTalkToFinalizer(_ captureId: String) {
        precondition(self.clearActivePushToTalk(captureId))
    }

    private func startFinishingPushToTalk(
        captureId: String,
        transcript: String,
        gatewayContext: PushToTalkGatewayContext)
    {
        precondition(self.finishingPushToTalk == nil)
        let generation = self.beginTranscriptProcessing()
        self.setStatus(String(localized: "Thinking…"), phase: .thinking)

        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.clearFinishingPushToTalk(captureId: captureId, generation: generation) }
            #if DEBUG
            if let testPTTFinalizerHandler = self.testPTTFinalizerHandler {
                await testPTTFinalizerHandler()
            }
            #endif
            guard self.isCurrentFinishingPushToTalk(captureId: captureId, generation: generation) else { return }
            switch gatewayContext {
            case let .connected(gateway, gatewayRoute, sessionKey):
                await self.processTranscript(
                    transcript,
                    restartAfter: false,
                    gateway: gateway,
                    gatewayRoute: gatewayRoute,
                    sessionKey: sessionKey,
                    transcriptProcessingGeneration: generation)
            #if DEBUG
            case .stateTestFixture:
                break
            #endif
            }
        }
        // Publish ownership before the task can yield into gateway work. Matching
        // generation cleanup prevents a stale finalizer from releasing a newer turn.
        self.finishingPushToTalk = FinishingPushToTalk(
            captureId: captureId,
            generation: generation,
            task: task)
    }

    private func cancelFinishingPushToTalk() {
        let hadFinishingPushToTalk = self.finishingPushToTalk != nil
        self.finishingPushToTalk?.task.cancel()
        self.invalidateTranscriptProcessing()
        self.stopSpeaking(storeInterruption: false)
        if hadFinishingPushToTalk {
            self.setStatus(
                self.gatewayConnected
                    ? String(localized: "Ready")
                    : String(localized: "Offline"),
                phase: .idle)
        }
    }

    private func isCurrentFinishingPushToTalk(captureId: String, generation: UInt64) -> Bool {
        !Task.isCancelled &&
            self.finishingPushToTalk?.captureId == captureId &&
            self.finishingPushToTalk?.generation == generation &&
            self.transcriptProcessingGeneration == generation
    }

    private func clearFinishingPushToTalk(captureId: String, generation: UInt64) {
        guard let finishing = finishingPushToTalk,
              finishing.captureId == captureId,
              finishing.generation == generation
        else { return }
        self.finishingPushToTalk = nil
        deactivateStandaloneAudioSessionIfIdle()
        self.pttAudioOwnershipEndHandler?(captureId)
        if self.phase.isFinalizerTransient {
            self.setStatus(
                self.gatewayConnected
                    ? String(localized: "Ready")
                    : String(localized: "Offline"),
                phase: .idle)
        }
        self.scheduleContinuousResume(self.isEnabled)
    }

    private func beginTranscriptProcessing() -> UInt64 {
        self.transcriptProcessingGeneration &+= 1
        return self.transcriptProcessingGeneration
    }

    private func invalidateTranscriptProcessing() {
        self.transcriptProcessingGeneration &+= 1
    }

    private func isCurrentTranscriptProcessing(_ generation: UInt64) -> Bool {
        !Task.isCancelled && self.transcriptProcessingGeneration == generation
    }

    private func scheduleContinuousResume(_ shouldResume: Bool) {
        guard shouldResume else { return }
        Task { @MainActor [weak self] in
            await self?.start()
        }
    }

    private func startRecognition(pttCaptureId: String? = nil) throws {
        self.stopRecognition()
        let recognitionGeneration = self.recognitionGeneration
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
            Task { @MainActor in
                self?.updateMicLevel(level, recognitionGeneration: recognitionGeneration)
            }
        }
        self.audioTapDiagnostics = tapDiagnostics
        let tapBlock = Self.makeAudioTapAppendCallback(request: request, diagnostics: tapDiagnostics)
        input.installTap(onBus: 0, bufferSize: 2048, format: format, block: tapBlock)
        self.inputTapInstalled = true

        self.audioEngine.prepare()
        do {
            try self.audioEngine.start()
        } catch {
            self.stopRecognition()
            throw error
        }
        self.loggedPartialThisCycle = false

        GatewayDiagnostics.log(
            "talk speech: recognition started mode=\(String(describing: self.captureMode)) "
                + "engineRunning=\(self.audioEngine.isRunning)")
        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            self.handleRecognitionUpdate(
                result: result,
                error: error,
                pttCaptureId: pttCaptureId,
                recognitionGeneration: recognitionGeneration)
        }
    }

    private func updateMicLevel(_ level: Float, recognitionGeneration: UInt64) {
        guard self.recognitionGeneration == recognitionGeneration else { return }
        // Smooth + clamp for UI, and keep it cheap.
        let raw = max(0, min(Double(level) * 10.0, 1.0))
        self.micLevel = (self.micLevel * 0.80) + (raw * 0.20)
        self.updateNoiseFloorIfNeeded(raw)

        let threshold: Double = if let floor = noiseFloor, noiseFloorReady {
            min(0.35, max(0.12, floor + 0.10))
        } else {
            0.18
        }
        if raw >= threshold {
            self.lastAudioActivity = Date()
        }
    }

    private func updateNoiseFloorIfNeeded(_ raw: Double) {
        guard self.isListening, !self.isSpeaking, !self.noiseFloorReady else { return }
        self.noiseFloorSamples.append(raw)
        guard self.noiseFloorSamples.count >= 22 else { return }

        let sorted = self.noiseFloorSamples.sorted()
        let slice = sorted.prefix(max(6, sorted.count / 2))
        let average = slice.reduce(0.0, +) / Double(slice.count)
        self.noiseFloor = average
        self.noiseFloorReady = true
        self.noiseFloorSamples.removeAll(keepingCapacity: true)
        let threshold = min(0.35, max(0.12, average + 0.10))
        GatewayDiagnostics.log(
            "talk audio: noiseFloor=\(String(format: "%.3f", average)) "
                + "threshold=\(String(format: "%.3f", threshold))")
    }

    private func handleRecognitionUpdate(
        result: SFSpeechRecognitionResult?,
        error: Error?,
        pttCaptureId: String?,
        recognitionGeneration: UInt64)
    {
        guard self.recognitionGeneration == recognitionGeneration else { return }
        if let pttCaptureId, activePTTCaptureId != pttCaptureId {
            return
        }
        if let error, !self.handleRecognitionError(error) {
            return
        }
        guard self.recognitionGeneration == recognitionGeneration, let result else { return }
        let transcript = result.bestTranscription.formattedString
        if !result.isFinal, !self.loggedPartialThisCycle {
            let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                self.loggedPartialThisCycle = true
                GatewayDiagnostics.log("talk speech: partial chars=\(trimmed.count)")
            }
        }
        Task { @MainActor [weak self] in
            guard let self, self.recognitionGeneration == recognitionGeneration else { return }
            await self.handleTranscript(
                transcript: transcript,
                isFinal: result.isFinal,
                pttCaptureId: pttCaptureId,
                recognitionGeneration: recognitionGeneration)
        }
    }

    /// Returns false for cancellation, whose callback must not process a result.
    private func handleRecognitionError(_ error: Error) -> Bool {
        let msg = error.localizedDescription
        let lowered = msg.lowercased()
        let isCancellation = lowered.contains("cancelled") || lowered.contains("canceled")
        if isCancellation {
            GatewayDiagnostics.log("talk speech: cancelled")
            if self.captureMode == .continuous, self.isEnabled, !self.isSpeaking {
                self.setStatus(String(localized: "Listening"), phase: .listening)
            }
            self.logger.debug("speech recognition cancelled")
            return false
        }

        GatewayDiagnostics.log("talk speech: error=\(msg)")
        self.speechErrorStatusRevisionPendingRestart = nil
        if !self.isSpeaking {
            if msg.localizedCaseInsensitiveContains("no speech detected") {
                // Treat as transient silence. Don't scare users with an error banner.
                if self.isEnabled {
                    self.setStatus(String(localized: "Listening"), phase: .listening)
                } else {
                    let errorStatus = String(
                        format: String(localized: "Speech error: %@"),
                        msg)
                    self.speechErrorStatusRevisionPendingRestart = self.setStatus(
                        errorStatus,
                        phase: .idle,
                        watchPresentation: .verbatim(errorStatus))
                }
            } else {
                let errorStatus = String(
                    format: String(localized: "Speech error: %@"),
                    msg)
                self.speechErrorStatusRevisionPendingRestart = self.setStatus(
                    errorStatus,
                    phase: .idle,
                    watchPresentation: .verbatim(errorStatus))
            }
        }
        self.logger.debug("speech recognition error: \(msg, privacy: .public)")
        // Recognition can terminate on transient errors. Retire the dead task
        // before scheduling a restart so old callbacks cannot mutate the new turn.
        if self.captureMode == .continuous, self.isEnabled, !self.isSpeaking {
            self.stopRecognition()
            let restartGeneration = self.recognitionGeneration
            Task { @MainActor [weak self] in
                await self?.restartRecognitionAfterError(expectedGeneration: restartGeneration)
            }
        }
        return true
    }

    private func restartRecognitionAfterError(expectedGeneration: UInt64) async {
        guard self.canRestartNativeRecognition(expectedGeneration: expectedGeneration) else { return }
        // Avoid thrashing the audio engine if it’s already running.
        if self.recognitionTask != nil, self.audioEngine.isRunning {
            return
        }
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard self.canRestartNativeRecognition(expectedGeneration: expectedGeneration) else { return }
        do {
            try configureOwnedAudioSession()
            try self.startRecognition()
            self.isListening = true
            self.restoreListeningStatusAfterSpeechErrorRestart()
            GatewayDiagnostics.log("talk speech: recognition restarted")
        } catch {
            self.stopNativeCaptureAndDiscardTranscript()
            deactivateAudioSession()
            let msg = error.localizedDescription
            GatewayDiagnostics.log("talk speech: restart failed error=\(msg)")
        }
    }

    private func canRestartNativeRecognition(expectedGeneration: UInt64) -> Bool {
        self.recognitionGeneration == expectedGeneration &&
            self.isEnabled &&
            self.captureMode == .continuous &&
            self.foregroundAudioCaptureAllowed &&
            self.realtimeSession == nil &&
            self.realtimeRelaySession == nil &&
            self.realtimeRelayStartGeneration == nil
    }

    private func restoreListeningStatusAfterSpeechErrorRestart() {
        if self.speechErrorStatusRevisionPendingRestart == self.statusRevision {
            self.setStatus(String(localized: "Listening"), phase: .listening)
        }
        self.speechErrorStatusRevisionPendingRestart = nil
    }

    private func stopRecognition() {
        // Speech may deliver buffered callbacks after cancellation. Advancing the
        // owner before teardown makes every old callback and audio-level task inert.
        self.recognitionGeneration &+= 1
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

    private func stopNativeCaptureAndDiscardTranscript() {
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.stopRecognition()
        self.isListening = false
        self.isUserSpeechDetected = false
        self.captureMode = .idle
        self.lastTranscript = ""
        self.lastHeard = nil
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

    private func handleTranscript(
        transcript: String,
        isFinal: Bool,
        pttCaptureId: String? = nil,
        recognitionGeneration: UInt64) async
    {
        guard self.recognitionGeneration == recognitionGeneration else { return }
        if let pttCaptureId, activePTTCaptureId != pttCaptureId {
            return
        }
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
                if let pttCaptureId {
                    _ = self.endPushToTalk(captureId: pttCaptureId)
                } else {
                    _ = self.endPushToTalk()
                }
                return
            }
            if self.captureMode == .continuous, !self.isSpeechOutputActive {
                await self.processTranscript(trimmed, restartAfter: true)
            }
        }
    }

    private func startSilenceMonitor(pttCaptureId: String? = nil) {
        self.silenceTask?.cancel()
        self.silenceTask = Task { [weak self] in
            guard let self else { return }
            while self.isEnabled || (self.isPushToTalkActive && self.pttAutoStopEnabled) {
                do {
                    try await Task.sleep(nanoseconds: 200_000_000)
                } catch {
                    return
                }
                await self.checkSilence(pttCaptureId: pttCaptureId)
            }
        }
    }

    private func checkSilence(pttCaptureId: String? = nil) async {
        if self.captureMode == .continuous {
            guard self.isListening, !self.isSpeechOutputActive else { return }
            let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !transcript.isEmpty else { return }
            let lastActivity = [lastHeard, lastAudioActivity].compactMap(\.self).max()
            guard let lastActivity else { return }
            if Date().timeIntervalSince(lastActivity) < self.silenceWindow {
                return
            }
            await self.processTranscript(transcript, restartAfter: true)
            return
        }

        guard self.captureMode == .pushToTalk, self.pttAutoStopEnabled else { return }
        if let pttCaptureId {
            guard self.activePTTCaptureId == pttCaptureId else { return }
        }
        guard self.isListening, !self.isSpeaking, self.isPushToTalkActive else { return }
        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }
        let lastActivity = [lastHeard, lastAudioActivity].compactMap(\.self).max()
        guard let lastActivity else { return }
        if Date().timeIntervalSince(lastActivity) < self.silenceWindow {
            return
        }
        if let pttCaptureId {
            _ = self.endPushToTalk(captureId: pttCaptureId)
        } else {
            _ = self.endPushToTalk()
        }
    }

    /// Guardrail for PTT once so we don't stay open indefinitely.
    private func schedulePTTTimeout(seconds: TimeInterval, captureId: String) {
        guard seconds > 0 else { return }
        let nanos = UInt64(seconds * 1_000_000_000)
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: nanos)
            } catch {
                return
            }
            await self?.handlePTTTimeout(captureId: captureId)
        }
    }

    private func handlePTTTimeout(captureId: String) async {
        guard self.activePTTCaptureId == captureId,
              self.pttAutoStopEnabled,
              self.isPushToTalkActive
        else { return }
        _ = self.endPushToTalk(captureId: captureId)
    }

    private func finishPTTOnce(_ payload: OpenClawTalkPTTStopPayload) {
        self.pttOnceOperations[payload.captureId]?.finish(payload)
    }

    private func processTranscript(_ transcript: String, restartAfter: Bool) async {
        let generation = self.beginTranscriptProcessing()
        if restartAfter {
            self.continuousTranscriptProcessingGeneration = generation
        }
        defer {
            if self.continuousTranscriptProcessingGeneration == generation {
                self.continuousTranscriptProcessingGeneration = nil
            }
        }
        guard let gateway else {
            self.setStatus(String(localized: "Gateway not connected"), phase: .idle)
            self.scheduleContinuousResume(restartAfter)
            return
        }
        let sessionKey = self.mainSessionKey
        guard let gatewayRoute = await gateway.currentRoute(),
              isCurrentTranscriptProcessing(generation),
              self.gateway === gateway,
              mainSessionKey == sessionKey
        else { return }
        await self.processTranscript(
            transcript,
            restartAfter: restartAfter,
            gateway: gateway,
            gatewayRoute: gatewayRoute,
            sessionKey: sessionKey,
            transcriptProcessingGeneration: generation)
    }

    private func processTranscript(
        _ transcript: String,
        restartAfter: Bool,
        gateway: GatewayNodeSession,
        gatewayRoute: GatewayNodeSessionRoute,
        sessionKey: String,
        transcriptProcessingGeneration generation: UInt64) async
    {
        let streamingOwner = TranscriptStreamingOwner()
        await runTranscriptProcessing(
            transcript,
            restartAfter: restartAfter,
            gateway: gateway,
            gatewayRoute: gatewayRoute,
            sessionKey: sessionKey,
            transcriptProcessingGeneration: generation,
            streamingOwner: streamingOwner)
        streamingOwner.task?.cancel()
        if let streamingTask = streamingOwner.task {
            await streamingTask.value
        }
        await self.quiesceTranscriptSpeech(ownedGeneration: streamingOwner.speechGeneration)
        if self.isCurrentTranscriptProcessing(generation),
           let terminalStatus = streamingOwner.terminalStatus
        {
            self.setStatus(
                terminalStatus.text,
                phase: terminalStatus.phase,
                watchPresentation: terminalStatus.watchPresentation)
        }
        let shouldResume = restartAfter &&
            self.isEnabled &&
            self.gatewayConnected &&
            self.foregroundAudioCaptureAllowed &&
            self.activePushToTalk == nil &&
            self.finishingPushToTalk == nil
        self.scheduleContinuousResume(shouldResume)
    }

    private func runTranscriptProcessing(
        _ transcript: String,
        restartAfter: Bool,
        gateway: GatewayNodeSession,
        gatewayRoute: GatewayNodeSessionRoute,
        sessionKey: String,
        transcriptProcessingGeneration generation: UInt64,
        streamingOwner: TranscriptStreamingOwner) async
    {
        guard self.isCurrentTranscriptProcessing(generation) else { return }
        self.isListening = false
        self.isUserSpeechDetected = false
        self.captureMode = .idle
        self.setStatus(String(localized: "Thinking…"), phase: .thinking)
        self.lastTranscript = ""
        self.lastHeard = nil
        self.stopRecognition()

        GatewayDiagnostics.log("talk: process transcript chars=\(transcript.count) restartAfter=\(restartAfter)")
        await reloadConfig(
            gateway: gateway,
            gatewayRoute: gatewayRoute,
            shouldApply: { self.isCurrentTranscriptProcessing(generation) })
        guard self.isCurrentTranscriptProcessing(generation) else { return }
        guard await gateway.currentRoute() == gatewayRoute else {
            self.setStatus(String(localized: "Gateway not connected"), phase: .idle)
            return
        }
        guard self.isCurrentTranscriptProcessing(generation) else { return }
        let prompt = self.buildPrompt(transcript: transcript)

        do {
            let startedAt = Date().timeIntervalSince1970
            let runId = UUID().uuidString
            let completionSubscription = await gateway.makeServerEventSubscription(
                bufferingNewest: 200,
                matching: { Self.matchesChatEvent($0, runId: runId) })
            defer { completionSubscription.cancel() }
            let completionEvents = completionSubscription.events
            guard await gateway.currentRoute() == gatewayRoute else { return }
            guard self.isCurrentTranscriptProcessing(generation) else { return }
            streamingOwner.completionEvents = completionEvents
            self.logger.info(
                "chat.send start sessionKey=\(sessionKey, privacy: .public) chars=\(prompt.count, privacy: .public)")
            GatewayDiagnostics.log("talk: chat.send start sessionKey=\(sessionKey) chars=\(prompt.count)")
            guard self.isCurrentTranscriptProcessing(generation) else { return }
            let acknowledgement = try await sendChat(
                prompt,
                gateway: gateway,
                sessionKey: sessionKey,
                gatewayRoute: gatewayRoute,
                idempotencyKey: runId)
            guard self.isCurrentTranscriptProcessing(generation) else { return }
            guard acknowledgement.runId == runId else {
                throw NSError(
                    domain: "TalkModeManager",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Gateway returned a mismatched chat run ID"])
            }
            let normalizedStatus = Self.normalizedChatSendStatus(acknowledgement.status)
            self.logger.info(
                "chat.send ok runId=\(runId, privacy: .public) status=\(normalizedStatus, privacy: .public)")
            GatewayDiagnostics.log("talk: chat.send ok runId=\(runId) status=\(normalizedStatus)")
            if Self.isTerminalChatSendFailure(acknowledgement.status) {
                streamingOwner.terminalStatus = (
                    normalizedStatus == "error"
                        ? String(localized: "Chat error")
                        : String(localized: "Aborted"),
                    .idle,
                    .localized(normalizedStatus == "error" ? "Chat error" : "Aborted"))
                self.logger.warning(
                    """
                    chat.send terminal ack runId=\(runId, privacy: .public) \
                    status=\(normalizedStatus, privacy: .public)
                    """)
                GatewayDiagnostics.log(
                    "talk: chat.send terminal ack runId=\(runId) status=\(normalizedStatus)")
                return
            }
            guard let completedSuccessfully = try await completeTranscriptResponse(
                acknowledgement: acknowledgement,
                startedAt: startedAt,
                gateway: gateway,
                gatewayRoute: gatewayRoute,
                sessionKey: sessionKey,
                generation: generation,
                streamingOwner: streamingOwner)
            else { return }
            guard self.isCurrentTranscriptProcessing(generation) else { return }
            if completedSuccessfully, !self.isEnabled {
                streamingOwner.terminalStatus = (String(localized: "Ready"), .idle, .phase)
            }
        } catch is CancellationError {
            return
        } catch {
            guard self.isCurrentTranscriptProcessing(generation) else { return }
            let status = String(
                format: String(localized: "Talk failed: %@"),
                error.localizedDescription)
            streamingOwner.terminalStatus = (status, .idle, .verbatim(status))
            self.logger.error("finalize failed: \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("talk: failed error=\(error.localizedDescription)")
        }
    }

    private func completeTranscriptResponse(
        acknowledgement: OpenClawChatSendResponse,
        startedAt: Double,
        gateway: GatewayNodeSession,
        gatewayRoute: GatewayNodeSessionRoute,
        sessionKey: String,
        generation: UInt64,
        streamingOwner: TranscriptStreamingOwner) async throws -> Bool?
    {
        let runId = acknowledgement.runId
        let shouldIncremental = self.shouldUseIncrementalTTS()
        if shouldIncremental {
            self.resetIncrementalSpeech()
            streamingOwner.speechGeneration = self.speechGeneration
        }
        let completion: ChatCompletionResult
        if Self.isTerminalChatSendSuccess(acknowledgement.status) {
            GatewayDiagnostics.log("talk: chat.send terminal ok runId=\(runId); using history fallback")
            completion = ChatCompletionResult(state: .final, assistantText: nil)
        } else {
            if shouldIncremental {
                let speechGeneration = self.speechGeneration
                streamingOwner.task = Task { @MainActor [weak self] in
                    guard let self else { return }
                    await self.streamAssistant(
                        runId: runId,
                        gateway: gateway,
                        gatewayRoute: gatewayRoute,
                        speechGeneration: speechGeneration,
                        transcriptProcessingGeneration: generation)
                }
            }
            guard let completionEvents = streamingOwner.completionEvents else { return nil }
            completion = await self.waitForChatCompletion(
                runId: runId,
                gateway: gateway,
                gatewayRoute: gatewayRoute,
                stream: completionEvents,
                timeoutSeconds: 120)
            guard self.isCurrentTranscriptProcessing(generation) else { return nil }
            guard await gateway.currentRoute() == gatewayRoute else { return nil }
            if completion.state == .timeout {
                self.logger.warning(
                    "chat completion timeout runId=\(runId, privacy: .public); attempting history fallback")
                GatewayDiagnostics.log("talk: chat completion timeout runId=\(runId)")
            } else if completion.state == .aborted {
                self.logger.warning("chat completion aborted runId=\(runId, privacy: .public)")
                GatewayDiagnostics.log("talk: chat completion aborted runId=\(runId)")
                streamingOwner.task?.cancel()
                await self.finishIncrementalSpeech()
                guard self.isCurrentTranscriptProcessing(generation) else { return nil }
                streamingOwner.terminalStatus = (
                    String(localized: "Aborted"),
                    .idle,
                    .localized("Aborted"))
                return nil
            } else if completion.state == .error {
                self.logger.warning("chat completion error runId=\(runId, privacy: .public)")
                GatewayDiagnostics.log("talk: chat completion error runId=\(runId)")
                streamingOwner.task?.cancel()
                await self.finishIncrementalSpeech()
                guard self.isCurrentTranscriptProcessing(generation) else { return nil }
                streamingOwner.terminalStatus = (
                    String(localized: "Chat error"),
                    .idle,
                    .localized("Chat error"))
                return nil
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
                sessionKey: sessionKey,
                gatewayRoute: gatewayRoute,
                runId: runId,
                since: Self.chatSendHistorySince(response: acknowledgement, startedAt: startedAt),
                timeoutSeconds: completion.state == .final ? 12 : 25)
            guard self.isCurrentTranscriptProcessing(generation) else { return nil }
        }
        guard let assistantText else {
            self.logger.warning("assistant text timeout runId=\(runId, privacy: .public)")
            GatewayDiagnostics.log("talk: assistant text timeout runId=\(runId)")
            streamingOwner.task?.cancel()
            await self.finishIncrementalSpeech()
            guard self.isCurrentTranscriptProcessing(generation) else { return nil }
            streamingOwner.terminalStatus = (
                String(localized: "No reply"),
                .idle,
                .localized("No reply"))
            return nil
        }
        self.logger.info("assistant text ok chars=\(assistantText.count, privacy: .public)")
        GatewayDiagnostics.log("talk: assistant text ok chars=\(assistantText.count)")
        streamingOwner.task?.cancel()
        if shouldIncremental {
            guard let speechGeneration = streamingOwner.speechGeneration else { return nil }
            return await self.handleIncrementalAssistantFinal(
                text: assistantText,
                speechGeneration: speechGeneration)
        }
        await self.playAssistant(
            text: assistantText,
            gateway: gateway,
            gatewayRoute: gatewayRoute)
        return true
    }

    private func quiesceTranscriptSpeech(ownedGeneration: Int?) async {
        guard let ownedGeneration else { return }
        let ownedTask = self.incrementalSpeechTasksByGeneration[ownedGeneration]
        if self.speechGeneration == ownedGeneration {
            self.stopSpeaking(storeInterruption: false)
        }
        if let ownedTask {
            await ownedTask.value
        }
    }

    private func startRealtimeIfAvailable(attemptID: Int) async -> RealtimeStartResult {
        if self.realtimeSession != nil {
            return .started
        }
        guard let gateway else {
            return .unavailable(realtimeIssue(message: "Gateway not connected", phase: "start"))
        }
        let startedAt = Self.nowSeconds()
        if self.prefetchedRealtimeSession == nil, let prefetchTask = realtimePrefetchTask {
            GatewayDiagnostics.log("talk.timeline realtime awaiting in-flight prefetch")
            await prefetchTask.value
        }
        guard self.isCurrentStartAttempt(attemptID) else { return .ignored }
        let prefetchedSession = self.consumePrefetchedRealtimeSession()
        if let prefetchedSession {
            self.activeRealtimeVoiceSessionId = prefetchedSession.voiceSessionId
        }
        let sessionKey = self.mainSessionKey
        let voiceSessionGeneration = self.realtimeVoiceSessionGeneration
        GatewayDiagnostics.log("talk.timeline realtime start attempt sessionKey=\(sessionKey)")
        let session = TalkRealtimeWebRTCSession(
            gateway: gateway,
            sessionKey: sessionKey,
            voiceSessionId: self.activeRealtimeVoiceSessionId,
            transcriptStore: self.realtimeTranscriptStore,
            delegate: self)
        self.realtimeSession = session
        // WebRTC owns the shared AVAudioSession internally; track the attempt
        // before its first suspension so every failure/teardown can deactivate it.
        self.audioSessionIsActive = true
        do {
            try await session.start(
                provider: self.realtimeProvider,
                model: self.realtimeModelId,
                voice: self.realtimeVoiceId,
                prefetchedSession: prefetchedSession)
            guard self.realtimeSession === session, self.isCurrentStartAttempt(attemptID) else {
                self.finishStaleRealtimeStart(
                    session,
                    gateway: gateway,
                    sessionKey: sessionKey,
                    voiceSessionGeneration: voiceSessionGeneration)
                return .ignored
            }
            guard let voiceSessionId = session.voiceSessionId,
                  self.adoptRealtimeVoiceSessionId(
                      voiceSessionId,
                      gateway: gateway,
                      sessionKey: sessionKey)
            else {
                self.stopRealtimeSession()
                return .unavailable(realtimeIssue(
                    message: "Gateway returned a conflicting realtime voice session",
                    phase: "start"))
            }
            // WebRTC configures the shared session and may force speaker + built-in mic.
            // Apply the user's input last so the explicit microphone selection wins.
            Self.applyPreferredInput(self.preferredInputDeviceID, to: AVAudioSession.sharedInstance())
            self.markRealtimeSessionReady()
            GatewayDiagnostics.log(
                "talk.timeline realtime start ready elapsedMs=\(Self.elapsedMs(since: startedAt))")
            GatewayDiagnostics.log("talk realtime: started direct OpenAI WebRTC session")
            return .started
        } catch {
            guard self.realtimeSession === session, self.isCurrentStartAttempt(attemptID) else {
                self.finishStaleRealtimeStart(
                    session,
                    gateway: gateway,
                    sessionKey: sessionKey,
                    voiceSessionGeneration: voiceSessionGeneration)
                return .ignored
            }
            if let voiceSessionId = session.voiceSessionId {
                _ = self.adoptRealtimeVoiceSessionId(
                    voiceSessionId,
                    gateway: gateway,
                    sessionKey: sessionKey)
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

    private func finishStaleRealtimeStart(
        _ session: TalkRealtimeWebRTCSession,
        gateway: GatewayNodeSession,
        sessionKey: String,
        voiceSessionGeneration: UInt64)
    {
        if let voiceSessionId = session.voiceSessionId {
            if self.activeRealtimeVoiceSessionId == nil,
               self.realtimeSession == nil,
               self.isEnabled,
               self.mainSessionKey == sessionKey,
               self.realtimeVoiceSessionGeneration == voiceSessionGeneration
            {
                // A transport restart keeps the logical voice session alive.
                self.activeRealtimeVoiceSessionId = voiceSessionId
            } else if self.activeRealtimeVoiceSessionId != voiceSessionId {
                self.closeOrphanedRealtimeVoiceSession(
                    gateway: gateway,
                    sessionKey: sessionKey,
                    voiceSessionId: voiceSessionId)
            }
        }
        session.stop()
    }

    @discardableResult
    private func adoptRealtimeVoiceSessionId(
        _ voiceSessionId: String,
        gateway: GatewayNodeSession,
        sessionKey: String) -> Bool
    {
        if let activeRealtimeVoiceSessionId, activeRealtimeVoiceSessionId != voiceSessionId {
            GatewayDiagnostics.log(
                "talk realtime voice session mismatch active=\(activeRealtimeVoiceSessionId) "
                    + "returned=\(voiceSessionId)")
            self.closeOrphanedRealtimeVoiceSession(
                gateway: gateway,
                sessionKey: sessionKey,
                voiceSessionId: voiceSessionId)
            return false
        }
        self.activeRealtimeVoiceSessionId = voiceSessionId
        return true
    }

    private func startRealtimeRelayIfAvailable(attemptID: Int) async -> RealtimeStartResult {
        guard let gateway else {
            return .unavailable(realtimeIssue(message: "Gateway not connected", phase: "start"))
        }
        guard self.foregroundAudioCaptureAllowed else {
            self.setStatus(
                String(localized: "Paused"),
                phase: .idle,
                watchPresentation: .localized("Paused"))
            GatewayDiagnostics.log("talk realtime ignored: app backgrounded")
            return .ignored
        }
        guard self.isCurrentStartAttempt(attemptID) else { return .ignored }
        if self.realtimeRelaySession != nil {
            GatewayDiagnostics.log("talk realtime ignored: already active")
            return .started
        }
        guard self.realtimeRelayStartGeneration == nil else {
            GatewayDiagnostics.log("talk realtime ignored: already starting")
            return .ignored
        }
        prepareRealtimeRelayStart()
        self.realtimeRelayGeneration &+= 1
        let relayGeneration = self.realtimeRelayGeneration
        self.realtimeRelayStartGeneration = relayGeneration
        defer {
            if self.realtimeRelayStartGeneration == relayGeneration {
                self.realtimeRelayStartGeneration = nil
            }
        }
        let sessionKey = self.mainSessionKey
        GatewayDiagnostics.log("talk.timeline realtime relay start attempt sessionKey=\(sessionKey)")
        let startedAt = Self.nowSeconds()
        let relaySession = RealtimeTalkRelaySession(
            gateway: gateway,
            options: RealtimeTalkRelaySession.Options(
                sessionKey: sessionKey,
                provider: self.realtimeProvider,
                model: self.realtimeModelId,
                voice: self.realtimeVoiceId),
            pcmPlayer: self.pcmPlayer,
            onStatus: { [weak self] status in
                guard let self, self.realtimeRelayGeneration == relayGeneration else { return }
                self.handleRealtimeRelayStatus(status)
            },
            onIssue: { [weak self] issue in
                guard let self, self.realtimeRelayGeneration == relayGeneration else { return }
                self.realtimeRelayStartIssue = issue
                self.pendingRealtimeIssue = issue
                self.gatewayTalkLastIssueText = issue.diagnosticSummary
                self.gatewayTalkActiveModeTitle = String(localized: "Realtime unavailable")
                self.gatewayTalkActiveModeSubtitle = issue.displayMessage
            },
            onSpeakingChanged: { [weak self] speaking in
                guard let self, self.realtimeRelayGeneration == relayGeneration else { return }
                self.isSpeaking = speaking
                if speaking {
                    self.isListening = false
                    self.phase = .speaking
                }
            },
            onInputLevel: { [weak self] level in
                guard let self,
                      self.realtimeRelayGeneration == relayGeneration,
                      self.isListening
                else { return }
                // Same smoothing as the SFSpeech tap so route switches keep the wave feel.
                self.micLevel = (self.micLevel * 0.80) + (level * 0.20)
            },
            onOutputLevel: { [weak self] level in
                guard let self, self.realtimeRelayGeneration == relayGeneration else { return }
                self.playbackLevel = level
            })
        self.realtimeRelaySession = relaySession
        do {
            try configureOwnedRealtimeAudioSession()
            try await relaySession.start()
            guard self.realtimeRelaySession === relaySession,
                  self.realtimeRelayGeneration == relayGeneration,
                  self.isCurrentStartAttempt(attemptID),
                  self.mainSessionKey == sessionKey
            else {
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
            guard self.realtimeRelaySession === relaySession,
                  self.realtimeRelayGeneration == relayGeneration,
                  self.isCurrentStartAttempt(attemptID),
                  self.mainSessionKey == sessionKey
            else {
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
        let sessionKey = self.mainSessionKey
        let requestedVoiceSessionId = self.activeRealtimeVoiceSessionId
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
                    sessionKey: sessionKey,
                    voiceSessionId: requestedVoiceSessionId,
                    provider: self.realtimeProvider,
                    model: self.realtimeModelId,
                    voice: self.realtimeVoiceId)
                guard let voiceSessionId = session.voiceSessionId else {
                    throw NSError(domain: "TalkRealtimeVoiceSession", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "Gateway did not return a realtime voice session",
                    ])
                }
                guard !Task.isCancelled, shouldApply(), self.mainSessionKey == sessionKey else {
                    if self.activeRealtimeVoiceSessionId != voiceSessionId {
                        self.closeOrphanedRealtimeVoiceSession(
                            gateway: gateway,
                            sessionKey: sessionKey,
                            voiceSessionId: voiceSessionId)
                    }
                    return
                }
                guard self.adoptRealtimeVoiceSessionId(
                    voiceSessionId,
                    gateway: gateway,
                    sessionKey: sessionKey)
                else { return }
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
        sessionKey: String,
        voiceSessionId: String?,
        provider: String?,
        model: String?,
        voice: String?) async throws -> TalkRealtimeClientSession
    {
        let params = TalkRealtimeClientCreateParams(
            sessionKey: sessionKey,
            voiceSessionId: voiceSessionId,
            provider: provider,
            model: model,
            voice: voice,
            capabilities: ["voice-transcript"])
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
        let realtimeSession = self.realtimeSession
        if self.activeRealtimeVoiceSessionId == nil,
           let voiceSessionId = realtimeSession?.voiceSessionId
        {
            // Capture ownership before stopping the transport so close can drain its queue.
            self.activeRealtimeVoiceSessionId = voiceSessionId
        }
        let hadRealtimeOwner = realtimeSession != nil ||
            self.realtimeRelaySession != nil ||
            self.realtimeRelayStartGeneration != nil
        self.realtimeSession = nil
        realtimeSession?.stop()
        // Relay callbacks do not carry the session object. Advance their owner
        // token before stop so buffered status/audio cannot reclaim PTT state.
        self.realtimeRelayGeneration &+= 1
        self.realtimeRelayStartGeneration = nil
        let realtimeRelaySession = self.realtimeRelaySession
        self.realtimeRelaySession = nil
        realtimeRelaySession?.stop()
        if hadRealtimeOwner {
            self.isListening = false
            self.isSpeaking = false
            self.isUserSpeechDetected = false
            self.playbackLevel = nil
        }
    }

    @discardableResult
    private func invalidatePrefetchedRealtimeSession() -> Task<Void, Never>? {
        guard self.realtimeSession == nil else {
            // A config reload may overlap a live direct call. Discard only an unused prefetch;
            // the active transport still owns its logical session and transcript queue.
            self.prefetchedRealtimeSession = nil
            return nil
        }
        return self.closeLogicalRealtimeVoiceSessions()
    }

    @discardableResult
    private func closeLogicalRealtimeVoiceSessions() -> Task<Void, Never>? {
        // A close boundary invalidates every in-flight transport that captured the old owner.
        self.realtimeVoiceSessionGeneration &+= 1
        let voiceSessionIds = Set([
            self.activeRealtimeVoiceSessionId,
            self.prefetchedRealtimeSession?.voiceSessionId,
            self.realtimeSession?.voiceSessionId,
        ].compactMap(\.self))
        self.activeRealtimeVoiceSessionId = nil
        self.prefetchedRealtimeSession = nil
        guard !voiceSessionIds.isEmpty else { return nil }
        let gateway = self.gateway
        let sessionKey = self.mainSessionKey
        let transcriptStore = self.realtimeTranscriptStore
        return Task { @MainActor in
            defer { transcriptStore.remove(voiceSessionIds) }
            for voiceSessionId in voiceSessionIds.sorted() {
                await transcriptStore.flush(voiceSessionId: voiceSessionId)
            }
            for voiceSessionId in voiceSessionIds.sorted() {
                guard let gateway else {
                    GatewayDiagnostics.log(
                        "talk voice session close FAILED voiceSessionId=\(voiceSessionId) error=gateway unavailable")
                    continue
                }
                do {
                    try await self.closeRealtimeVoiceSession(
                        gateway: gateway,
                        sessionKey: sessionKey,
                        voiceSessionId: voiceSessionId)
                } catch {
                    GatewayDiagnostics.log(
                        "talk voice session close FAILED voiceSessionId=\(voiceSessionId) "
                            + "error=\(error.localizedDescription)")
                }
            }
        }
    }

    private static func retryRealtimeVoiceSessionClose(
        retryDelaysNanoseconds: [UInt64],
        sleep: @escaping @MainActor (UInt64) async throws -> Void = { delay in
            try await Task.sleep(nanoseconds: delay)
        },
        operation: @escaping @MainActor () async throws -> Void) async throws
    {
        var finalError: Error?
        for delay in retryDelaysNanoseconds {
            if delay > 0 {
                try await sleep(delay)
            }
            do {
                try await operation()
                return
            } catch {
                finalError = error
            }
        }
        throw finalError ?? NSError(domain: "TalkRealtimeVoiceSession", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "Voice session close failed",
        ])
    }

    private func closeRealtimeVoiceSession(
        gateway: GatewayNodeSession,
        sessionKey: String,
        voiceSessionId: String) async throws
    {
        try await Self.retryRealtimeVoiceSessionClose(
            retryDelaysNanoseconds: Self.realtimeVoiceSessionCloseRetryDelaysNanoseconds)
        {
            try await self.requestRealtimeVoiceSessionClose(
                gateway: gateway,
                sessionKey: sessionKey,
                voiceSessionId: voiceSessionId)
        }
    }

    private func requestRealtimeVoiceSessionClose(
        gateway: GatewayNodeSession,
        sessionKey: String,
        voiceSessionId: String) async throws
    {
        let params = TalkRealtimeClientCloseParams(
            sessionKey: sessionKey,
            voiceSessionId: voiceSessionId)
        let data = try JSONEncoder().encode(params)
        guard let json = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "TalkRealtimeVoiceSession", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode close request",
            ])
        }
        #if DEBUG
        if let testRealtimeVoiceSessionCloseRequest {
            try await testRealtimeVoiceSessionCloseRequest("talk.client.close", json)
            return
        }
        #endif
        _ = try await gateway.request(
            method: "talk.client.close",
            paramsJSON: json,
            timeoutSeconds: 10)
    }

    private func closeOrphanedRealtimeVoiceSession(
        gateway: GatewayNodeSession,
        sessionKey: String,
        voiceSessionId: String)
    {
        let transcriptStore = self.realtimeTranscriptStore
        Task { @MainActor in
            defer { transcriptStore.remove([voiceSessionId]) }
            await transcriptStore.flush(voiceSessionId: voiceSessionId)
            do {
                try await self.closeRealtimeVoiceSession(
                    gateway: gateway,
                    sessionKey: sessionKey,
                    voiceSessionId: voiceSessionId)
            } catch {
                GatewayDiagnostics.log(
                    "talk voice session close FAILED voiceSessionId=\(voiceSessionId) "
                        + "error=\(error.localizedDescription)")
            }
        }
    }

    private func buildPrompt(transcript: String) -> String {
        let interrupted = self.lastInterruptedAtSeconds
        self.lastInterruptedAtSeconds = nil
        return TalkPromptBuilder.build(
            transcript: transcript,
            interruptedAtSeconds: interrupted,
            includeVoiceDirectiveHint: false)
    }

    private static func normalizedChatSendStatus(_ status: String) -> String {
        status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private nonisolated static func matchesChatEvent(_ event: EventFrame, runId: String) -> Bool {
        guard event.event == "chat", let payload = event.payload else { return false }
        let chatEvent = try? GatewayPayloadDecoding.decode(
            payload,
            as: OpenClawChatEventPayload.self)
        return chatEvent?.runId == runId
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

    private func sendChat(
        _ message: String,
        gateway: GatewayNodeSession,
        sessionKey: String,
        gatewayRoute: GatewayNodeSessionRoute,
        idempotencyKey: String) async throws -> OpenClawChatSendResponse
    {
        let request = OpenClawChatGatewayRequests.sendMessage(
            sessionKey: sessionKey,
            agentID: nil,
            expectedSessionRoutingContract: nil,
            message: message,
            thinking: Self.chatThinkingOverride,
            idempotencyKey: idempotencyKey,
            attachments: [],
            runTimeoutMs: 30000)
        let res = try await gateway.request(
            request,
            ifCurrentRoute: gatewayRoute)
        guard await gateway.currentRoute() == gatewayRoute else { throw CancellationError() }
        return try JSONDecoder().decode(OpenClawChatSendResponse.self, from: res)
    }

    private func waitForChatCompletion(
        runId: String,
        gateway: GatewayNodeSession,
        gatewayRoute: GatewayNodeSessionRoute,
        stream: AsyncStream<EventFrame>,
        timeoutSeconds: Int = 120) async -> ChatCompletionResult
    {
        await withTaskGroup(of: ChatCompletionResult.self) { group in
            group.addTask { [runId] in
                var latestAssistantText: String?
                for await evt in stream {
                    if Task.isCancelled {
                        return ChatCompletionResult(state: .timeout, assistantText: latestAssistantText)
                    }
                    guard await gateway.currentRoute() == gatewayRoute else {
                        return ChatCompletionResult(state: .timeout, assistantText: latestAssistantText)
                    }
                    if Task.isCancelled {
                        return ChatCompletionResult(state: .timeout, assistantText: latestAssistantText)
                    }
                    guard let payload = evt.payload,
                          let chatEvent = try? GatewayPayloadDecoding.decode(
                              payload,
                              as: OpenClawChatEventPayload.self),
                          chatEvent.runId == runId
                    else {
                        continue
                    }
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
        sessionKey: String,
        gatewayRoute: GatewayNodeSessionRoute,
        runId: String,
        since: Double?,
        timeoutSeconds: Int) async throws -> String?
    {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
        while Date() < deadline {
            try Task.checkCancellation()
            if let text = try await fetchLatestAssistantText(
                gateway: gateway,
                sessionKey: sessionKey,
                gatewayRoute: gatewayRoute,
                runId: runId,
                since: since)
            {
                return text
            }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        return nil
    }

    private func fetchLatestAssistantText(
        gateway: GatewayNodeSession,
        sessionKey: String,
        gatewayRoute: GatewayNodeSessionRoute,
        runId: String,
        since: Double? = nil) async throws -> String?
    {
        let request = OpenClawChatGatewayRequests.history(sessionKey: sessionKey, agentID: nil)
        let res = try await gateway.request(
            request,
            ifCurrentRoute: gatewayRoute)
        guard await gateway.currentRoute() == gatewayRoute else { throw CancellationError() }
        guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return nil }
        guard let messages = json["messages"] as? [[String: Any]] else { return nil }
        return Self.latestAssistantText(messages: messages, runId: runId, since: since)
    }

    private static func latestAssistantText(
        messages: [[String: Any]],
        runId: String,
        since: Double?) -> String?
    {
        for msg in messages.reversed() {
            guard (msg["role"] as? String) == "assistant" else { continue }
            let metadata = msg["__openclaw"] as? [String: Any]
            let idempotencyKey = (msg["idempotencyKey"] as? String) ?? (metadata?["idempotencyKey"] as? String)
            guard idempotencyKey == runId else { continue }
            if let since, let timestamp = msg["timestamp"] as? Double,
               TalkHistoryTimestamp.isAfter(timestamp, sinceSeconds: since) == false
            {
                continue
            }
            guard let content = msg["content"] as? [[String: Any]] else { continue }
            let text = content.compactMap { $0["text"] as? String }.joined(separator: "\n")
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        return nil
    }

    private func playAssistant(
        text: String,
        gateway gatewayOverride: GatewayNodeSession? = nil,
        gatewayRoute: GatewayNodeSessionRoute? = nil) async
    {
        let parsed = TalkDirectiveParser.parse(text)
        let directive = parsed.directive
        let cleaned = parsed.stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        self.applyDirective(directive)
        self.speechGeneration += 1
        let speechGeneration = self.speechGeneration

        self.setStatus(String(localized: "Generating voice…"), phase: .speaking)
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
                    generation: speechGeneration,
                    gateway: gatewayOverride,
                    gatewayRoute: gatewayRoute)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, self.speechGeneration == speechGeneration else { return }
                let errorMessage = error.localizedDescription
                self.logger.error("gateway TTS failed: \(errorMessage, privacy: .public); falling back to system voice")
                GatewayDiagnostics.log("talk tts: provider=system (gateway error) msg=\(error.localizedDescription)")
                do {
                    try await self.playSystemVoice(text: cleaned, language: language)
                } catch {
                    guard !Task.isCancelled, self.speechGeneration == speechGeneration else { return }
                    let status = String(
                        format: String(localized: "Speak failed: %@"),
                        error.localizedDescription)
                    self.setStatus(
                        status,
                        phase: .idle,
                        watchPresentation: .verbatim(status))
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
                await resolveVoiceId(
                    preferred: preferredVoice,
                    apiKey: apiKey,
                    shouldApply: { self.isCurrentSpeechGeneration(speechGeneration) })
            } else {
                nil
            }
            guard !Task.isCancelled, self.speechGeneration == speechGeneration else { return }
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

                self.setStatus(String(localized: "Speaking…"), phase: .speaking)
                let result = await playElevenLabsStream(
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
                guard !Task.isCancelled, self.speechGeneration == speechGeneration else { return }
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
            guard !Task.isCancelled, self.speechGeneration == speechGeneration else { return }
            self.logger.error(
                "tts failed: \(error.localizedDescription, privacy: .public); falling back to system voice")
            GatewayDiagnostics.log("talk tts: provider=system (error) msg=\(error.localizedDescription)")
            do {
                try await self.playSystemVoice(text: cleaned, language: language)
            } catch {
                guard !Task.isCancelled, self.speechGeneration == speechGeneration else { return }
                let status = String(
                    format: String(localized: "Speak failed: %@"),
                    error.localizedDescription)
                self.setStatus(
                    status,
                    phase: .idle,
                    watchPresentation: .verbatim(status))
                self.logger.error("system voice failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func playGatewayTalkSpeak(
        text: String,
        directive: TalkDirective?,
        generation: Int,
        gateway gatewayOverride: GatewayNodeSession?,
        gatewayRoute: GatewayNodeSessionRoute?) async throws
    {
        let synthesizer: any TalkGatewaySpeechSynthesizing
        if let gatewaySpeechSynthesizerOverride {
            synthesizer = gatewaySpeechSynthesizerOverride
        } else if let gateway = gatewayOverride ?? gateway, let gatewayRoute {
            synthesizer = TalkGatewaySpeechClient(gateway: gateway, route: gatewayRoute)
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
        if let gatewayRoute, let gateway = gatewayOverride ?? gateway {
            guard await gateway.currentRoute() == gatewayRoute else { throw CancellationError() }
        }
        guard generation == self.speechGeneration, self.isSpeaking else { return }

        applyVoiceModeDescriptor(TalkVoiceModeDescriptorBuilder.build(
            providerId: audio.provider,
            providerLabel: Self.displayName(forProvider: audio.provider),
            modelId: modelId,
            voiceId: voiceId,
            transport: "native",
            isRealtime: false))
        self.startSpeechInterruptionRecognitionIfNeeded()
        self.setStatus(String(localized: "Speaking…"), phase: .speaking)
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
        self.setStatus(String(localized: "Speaking (System)…"), phase: .speaking)
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

    private func isCurrentSpeechGeneration(_ generation: Int) -> Bool {
        !Task.isCancelled && self.speechGeneration == generation
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
        self.speechGeneration &+= 1
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

        let speechGeneration = self.speechGeneration
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.incrementalSpeechTasksByGeneration.removeValue(forKey: speechGeneration)
                if self.speechGeneration == speechGeneration {
                    self.cancelIncrementalPrefetch()
                    self.isSpeaking = false
                    self.stopRecognition()
                    self.incrementalSpeechTask = nil
                }
            }
            while !Task.isCancelled {
                guard !self.incrementalSpeechQueue.isEmpty else { break }
                let segment = self.incrementalSpeechQueue.removeFirst()
                self.setStatus(String(localized: "Speaking…"), phase: .speaking)
                self.isSpeaking = true
                self.lastSpokenText = segment
                guard await self.updateIncrementalContextIfNeeded(speechGeneration: speechGeneration) else { return }
                let context = self.incrementalSpeechContext
                let prefetchedAudio = await self.consumeIncrementalPrefetchedAudioIfAvailable(
                    for: segment,
                    context: context)
                guard self.isCurrentSpeechGeneration(speechGeneration) else { return }
                if let context {
                    self.startIncrementalPrefetchMonitor(context: context)
                }
                await self.speakIncrementalSegment(
                    segment,
                    context: context,
                    prefetchedAudio: prefetchedAudio,
                    speechGeneration: speechGeneration)
                guard self.isCurrentSpeechGeneration(speechGeneration) else { return }
                self.cancelIncrementalPrefetchMonitor()
            }
        }
        self.incrementalSpeechTask = task
        self.incrementalSpeechTasksByGeneration[speechGeneration] = task
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
        guard !Task.isCancelled else { return nil }
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
        let speechGeneration = self.speechGeneration
        let leftover = self.incrementalSpeechBuffer.flush()
        if let leftover {
            self.enqueueIncrementalSpeech(leftover)
        }
        if let task = incrementalSpeechTask {
            _ = await task.result
        }
        guard self.speechGeneration == speechGeneration else { return }
        self.incrementalSpeechActive = false
    }

    private func handleIncrementalAssistantFinal(text: String, speechGeneration: Int) async -> Bool {
        guard self.incrementalSpeechActive,
              self.isCurrentSpeechGeneration(speechGeneration)
        else { return false }
        let parsed = TalkDirectiveParser.parse(text)
        self.applyDirective(parsed.directive)
        if let lang = parsed.directive?.language {
            self.incrementalSpeechLanguage = ElevenLabsTTSClient.validatedLanguage(lang)
        }
        guard await self.updateIncrementalContextIfNeeded(speechGeneration: speechGeneration) else { return false }
        guard self.incrementalSpeechActive,
              self.isCurrentSpeechGeneration(speechGeneration)
        else { return false }
        let segments = self.incrementalSpeechBuffer.ingest(text: text, isFinal: true)
        for segment in segments {
            self.enqueueIncrementalSpeech(segment)
        }
        await self.finishIncrementalSpeech()
        guard self.isCurrentSpeechGeneration(speechGeneration) else { return false }
        if !self.incrementalSpeechUsed {
            await self.playAssistant(text: text)
        }
        return !Task.isCancelled
    }

    private func streamAssistant(
        runId: String,
        gateway: GatewayNodeSession,
        gatewayRoute: GatewayNodeSessionRoute,
        speechGeneration: Int,
        transcriptProcessingGeneration generation: UInt64) async
    {
        let subscription = await gateway.makeServerEventSubscription(
            bufferingNewest: 200,
            matching: { Self.matchesChatEvent($0, runId: runId) })
        defer { subscription.cancel() }
        let stream = subscription.events
        guard self.isCurrentTranscriptProcessing(generation) else { return }
        for await evt in stream {
            guard self.isCurrentTranscriptProcessing(generation) else { return }
            guard await gateway.currentRoute() == gatewayRoute else { return }
            guard self.isCurrentTranscriptProcessing(generation),
                  self.isCurrentSpeechGeneration(speechGeneration)
            else { return }
            guard let payload = evt.payload else { continue }
            guard let chatEvent = try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawChatEventPayload.self)
            else {
                continue
            }
            guard chatEvent.runId == runId else { continue }
            guard chatEvent.state == "delta" || chatEvent.state == "final" else { continue }
            guard let text = OpenClawChatEventText.assistantText(from: chatEvent) else { continue }
            let segments = self.incrementalSpeechBuffer.ingest(text: text, isFinal: false)
            if let lang = incrementalSpeechBuffer.directive?.language {
                self.incrementalSpeechLanguage = ElevenLabsTTSClient.validatedLanguage(lang)
            }
            guard await self.updateIncrementalContextIfNeeded(speechGeneration: speechGeneration) else { return }
            guard self.isCurrentTranscriptProcessing(generation),
                  self.isCurrentSpeechGeneration(speechGeneration)
            else { return }
            for segment in segments {
                self.enqueueIncrementalSpeech(segment)
            }
        }
    }

    private func updateIncrementalContextIfNeeded(speechGeneration: Int) async -> Bool {
        guard self.isCurrentSpeechGeneration(speechGeneration) else { return false }
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
            return true
        }
        let context = await buildIncrementalSpeechContext(
            directive: directive,
            speechGeneration: speechGeneration)
        guard self.isCurrentSpeechGeneration(speechGeneration) else { return false }
        self.incrementalSpeechContext = context
        self.incrementalSpeechDirective = directive
        return true
    }

    private func buildIncrementalSpeechContext(
        directive: TalkDirective?,
        speechGeneration: Int) async -> IncrementalSpeechContext
    {
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
            await resolveVoiceId(
                preferred: preferredVoice,
                apiKey: apiKey,
                shouldApply: { self.isCurrentSpeechGeneration(speechGeneration) })
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
        prefetchedAudio: IncrementalPrefetchedAudio? = nil,
        speechGeneration: Int) async
    {
        let context: IncrementalSpeechContext
        if let preferredContext {
            context = preferredContext
        } else {
            guard await self.updateIncrementalContextIfNeeded(speechGeneration: speechGeneration) else { return }
            guard let resolvedContext = incrementalSpeechContext else {
                try? await TalkSystemSpeechSynthesizer.shared.speak(
                    text: text,
                    language: self.incrementalSpeechLanguage)
                return
            }
            context = resolvedContext
        }
        guard self.isCurrentSpeechGeneration(speechGeneration) else { return }

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
        let result = await playElevenLabsStream(
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
        guard self.isCurrentSpeechGeneration(speechGeneration) else { return }
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
        if let mapped = voiceAliases[normalized] {
            return mapped
        }
        if self.voiceAliases.values.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            return trimmed
        }
        return Self.isLikelyVoiceId(trimmed) ? trimmed : nil
    }

    func resolveVoiceId(
        preferred: String?,
        apiKey: String,
        shouldApply: @MainActor @Sendable () -> Bool = { true }) async -> String?
    {
        let trimmed = preferred?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            // Config / directives can provide a raw ElevenLabs voiceId (not an alias).
            // Accept it directly to avoid unnecessary listVoices calls (and accidental fallback selection).
            if Self.isLikelyVoiceId(trimmed) {
                return trimmed
            }
            if let resolved = resolveVoiceAlias(trimmed) {
                return resolved
            }
            self.logger.warning("unknown voice alias \(trimmed, privacy: .public)")
        }
        if let fallbackVoiceId {
            return fallbackVoiceId
        }

        do {
            let voices = try await ElevenLabsTTSClient(apiKey: apiKey).listVoices()
            guard shouldApply() else { return nil }
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
        if trimmed.hasPrefix("${"), trimmed.hasSuffix("}") {
            return nil
        }
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
            String(localized: "iOS System Voice")
        case "realtime":
            String(localized: "Realtime Voice")
        case let provider where !provider.isEmpty:
            provider
        default:
            String(localized: "Gateway Default")
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
        self.setStatus(String(localized: "Listening (Realtime)"), phase: .listening)
    }

    private static func phase(forRealtimeStatus status: String) -> TalkPhase {
        switch status {
        case "Listening", "Listening (Realtime)":
            .listening
        case "Thinking", "Thinking…", "Asking OpenClaw", "Still asking OpenClaw", "Updating OpenClaw":
            .thinking
        case "Speaking", "Speaking…":
            .speaking
        case "Connecting", "Connecting realtime…", "Waiting for realtime…", "Reconnecting", "Reconnecting…":
            .connecting
        default:
            .idle
        }
    }

    private static func watchPresentation(forRealtimeStatus status: String) -> TalkWatchPresentation {
        switch status {
        case "Listening", "Listening (Realtime)", "Thinking", "Thinking…", "Speaking", "Speaking…",
             "Asking OpenClaw", "Still asking OpenClaw", "Updating OpenClaw", "Connecting",
             "Connecting realtime…", "Waiting for realtime…", "Ready", "Reconnecting", "Reconnecting…":
            .phase
        case "Realtime failed before connecting":
            .localized("Realtime failed before connecting")
        case "Realtime disconnected":
            .localized("Realtime disconnected")
        case "OpenClaw unavailable":
            .localized("OpenClaw unavailable")
        case "Confirmation needed":
            .localized("Confirmation needed")
        default:
            .verbatim(status)
        }
    }

    private static func presentationText(forRealtimeStatus status: String) -> String {
        switch status {
        case "Listening":
            String(localized: "Listening")
        case "Listening (Realtime)":
            String(localized: "Listening (Realtime)")
        case "Thinking":
            String(localized: "Thinking")
        case "Thinking…":
            String(localized: "Thinking…")
        case "Asking OpenClaw":
            String(localized: "Asking OpenClaw")
        case "Still asking OpenClaw":
            String(localized: "Still asking OpenClaw")
        case "Updating OpenClaw":
            String(localized: "Updating OpenClaw")
        case "Speaking":
            String(localized: "Speaking")
        case "Speaking…":
            String(localized: "Speaking…")
        case "Connecting":
            String(localized: "Connecting")
        case "Connecting realtime…":
            String(localized: "Connecting realtime…")
        case "Waiting for realtime…":
            String(localized: "Waiting for realtime…")
        case "Ready":
            String(localized: "Ready")
        case "Reconnecting":
            String(localized: "Reconnecting")
        case "Reconnecting…":
            String(localized: "Reconnecting…")
        case "Realtime failed before connecting":
            String(localized: "Realtime failed before connecting")
        case "Realtime disconnected":
            String(localized: "Realtime disconnected")
        case "OpenClaw unavailable":
            String(localized: "OpenClaw unavailable")
        case "Confirmation needed":
            String(localized: "Confirmation needed")
        default:
            status
        }
    }

    private func handleRealtimeRelayStatus(_ status: String) {
        guard self.captureMode != .pushToTalk else { return }
        let phase = Self.phase(forRealtimeStatus: status)
        if status == "Listening (Realtime)" {
            // Ready can be followed by a buffered close before start() resumes. Commit continuous
            // state here so the close still enters bounded recovery.
            self.markRealtimeSessionReady()
        } else {
            self.setStatus(
                Self.presentationText(forRealtimeStatus: status),
                phase: phase,
                watchPresentation: Self.watchPresentation(forRealtimeStatus: status))
            if status == "Ready" {
                self.realtimeRelaySession = nil
                self.handleRealtimeSessionFinish()
            }
        }
        self.isListening = phase == .listening
        if phase == .thinking || phase == .connecting {
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
        self.gatewayTalkActiveModeTitle = String(localized: "iOS Speech + TTS")
        self.gatewayTalkActiveModeSubtitle = nil
        self.setStatus(String(localized: "Listening"), phase: .listening)
    }

    private func markNativeFallbackActive(after issue: TalkRuntimeIssue) {
        self.gatewayTalkActiveModeTitle = String(localized: "iOS Speech fallback")
        self.gatewayTalkActiveModeSubtitle = issue.displayMessage
        self.gatewayTalkCurrentFallbackIssue = issue
        self.gatewayTalkLastIssueText = issue.diagnosticSummary
        self.setStatus(issue.fallbackStatusText, phase: .listening)
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
        if self.gatewayTalkConfigLoaded {
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

    func reloadConfig(
        gateway gatewayOverride: GatewayNodeSession? = nil,
        gatewayRoute: GatewayNodeSessionRoute? = nil,
        shouldApply: @MainActor @Sendable () -> Bool = { true }) async
    {
        guard let gateway = gatewayOverride ?? gateway else { return }
        do {
            guard let loaded = try await loadTalkConfig(from: gateway, gatewayRoute: gatewayRoute) else { return }
            if let gatewayRoute {
                guard await gateway.currentRoute() == gatewayRoute else { return }
            }
            guard shouldApply() else { return }
            self.pcmFormatUnavailable = false
            self.invalidatePrefetchedRealtimeSession()
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
        } catch is CancellationError {
            return
        } catch {
            guard shouldApply() else { return }
            self.applyTalkConfigLoadFailure(error)
        }
    }

    private func loadTalkConfig(
        from gateway: GatewayNodeSession,
        gatewayRoute: GatewayNodeSessionRoute? = nil) async throws
        -> (config: [String: Any], redactedFallbackMissingScope: String?)?
    {
        func fetchConfig(includeSecrets: Bool) async throws -> [String: Any]? {
            let paramsJSON = includeSecrets ? "{\"includeSecrets\":true}" : "{}"
            let res = try await gateway.request(
                method: "talk.config",
                paramsJSON: paramsJSON,
                timeoutSeconds: 8,
                ifCurrentRoute: gatewayRoute)
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
        } catch is CancellationError {
            throw CancellationError()
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
        let transportLabel = usesRealtimeRelay
            ? String(localized: "Gateway Relay")
            : (usesRealtimeConfig
                ? String(localized: "Native WebRTC")
                : String(localized: "Native"))
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
            self.setStatus(String(localized: "Gateway permission required"), phase: .idle)
            GatewayDiagnostics.log("talk config missing gateway scope=\(missingScope)")
        } else {
            self.gatewayTalkPermissionState = .loadFailed(error.localizedDescription)
        }
    }

    private func applyTalkConfigLoadFailureFallback() {
        self.executionMode = .native
        self.runtimeRoute = .localElevenLabs
        self.realtimeProvider = nil
        self.realtimeModelId = nil
        self.realtimeVoiceId = nil
        self.configuredProviderModelId = nil
        self.gatewayTalkProviderLabel = String(localized: "Not loaded")
        self.gatewayTalkTransportLabel = String(localized: "Not loaded")
        self.gatewayTalkUsesRealtime = false
        self.gatewayTalkUsesRealtimeRelay = false
        self.gatewayTalkRealtimeProviderLabel = nil
        self.gatewayTalkRealtimeModelId = nil
        self.gatewayTalkRealtimeVoiceId = nil
        self.applyVoiceModeDescriptor(TalkVoiceModeDescriptor(
            title: String(localized: "Not loaded"),
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

    func markTalkPermissionUpgradeRequested() {
        self.gatewayTalkPermissionState = .upgradeRequested
        self.setStatus(String(localized: "Approval requested"), phase: .idle)
    }

    private static func missingTalkScope(from error: Error) -> String? {
        let targetScope = "operator.talk.secrets"
        if let gatewayError = error as? GatewayResponseError {
            return gatewayError.missingScope == targetScope ? targetScope : nil
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

    private func configureOwnedAudioSession() throws {
        try Self.configureAudioSession(preferredInputDeviceID: self.preferredInputDeviceID)
        self.audioSessionIsActive = true
    }

    private func configureOwnedRealtimeAudioSession() throws {
        try Self.configureRealtimeAudioSession(preferredInputDeviceID: self.preferredInputDeviceID)
        self.audioSessionIsActive = true
    }

    private func deactivateStandaloneAudioSessionIfIdle() {
        guard self.activePushToTalk == nil,
              self.finishingPushToTalk == nil,
              self.captureMode == .idle,
              !self.isListening,
              !self.isSpeaking
        else { return }
        self.deactivateAudioSession()
    }

    private func deactivateAudioSession() {
        guard self.audioSessionIsActive else { return }
        do {
            if let audioSessionDeactivationAction {
                try audioSessionDeactivationAction()
            } else {
                try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            }
            self.audioSessionIsActive = false
        } catch {
            self.logger.warning("audio session deactivate failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func configureAudioSession(preferredInputDeviceID: String? = nil) throws {
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
        // A speaker override also forces the built-in microphone; apply an explicit input last.
        self.applyPreferredInput(preferredInputDeviceID, to: session)
        GatewayDiagnostics.log("talk audio: session speakerphone=\(forceSpeaker) \(Self.describeAudioSession())")
    }

    static func configureRealtimeAudioSession(preferredInputDeviceID: String? = nil) throws {
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
        // A speaker override also forces the built-in microphone; apply an explicit input last.
        self.applyPreferredInput(preferredInputDeviceID, to: session)
        GatewayDiagnostics.log(
            "talk realtime audio: session speakerphone=\(forceSpeaker) \(Self.describeAudioSession())")
    }

    private static func applyPreferredInput(_ deviceID: String?, to session: AVAudioSession) {
        let input = deviceID.flatMap { id in
            session.availableInputs?.first(where: { $0.uid == id })
        }
        do {
            try session.setPreferredInput(input)
        } catch {
            try? session.setPreferredInput(nil)
            GatewayDiagnostics.log("talk audio: preferred input update failed: \(error.localizedDescription)")
        }
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
        if resolvedRms > self.maxRmsWindow {
            self.maxRmsWindow = resolvedRms
        }
        let maxRms = self.maxRmsWindow
        if shouldLog {
            self.maxRmsWindow = 0
        }
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
        let phase = Self.phase(forRealtimeStatus: status)
        if status == "Listening" {
            self.markRealtimeSessionReady()
        } else {
            self.setStatus(
                Self.presentationText(forRealtimeStatus: status),
                phase: phase,
                watchPresentation: Self.watchPresentation(forRealtimeStatus: status))
        }
        self.isListening = phase == .listening
        self.isSpeaking = phase == .speaking
        if phase == .thinking || phase == .connecting {
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

    func realtimeSession(
        _ session: TalkRealtimeWebRTCSession,
        didFailTranscriptPersistenceForEntry _: String,
        error _: Error)
    {
        guard session === self.realtimeSession else { return }
        self.setStatus(
            String(localized: "Chat error"),
            phase: self.phase,
            watchPresentation: .localized("Chat error"))
    }

    func realtimeSessionDidFinish(_ session: TalkRealtimeWebRTCSession) {
        guard session === self.realtimeSession else { return }
        self.realtimeSession = nil
        self.handleRealtimeSessionFinish()
    }
}

#if DEBUG
extension TalkModeManager {
    func _test_preparePrefetchedRealtimeVoiceSession(_ voiceSessionId: String) {
        self.activeRealtimeVoiceSessionId = voiceSessionId
        self.prefetchedRealtimeSession = TalkRealtimeClientSession(
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: voiceSessionId,
            clientSecret: "test-client-secret",
            offerUrl: nil,
            offerHeaders: nil,
            model: "gpt-realtime-2",
            voice: "marin",
            expiresAt: nil)
    }

    func _test_prepareLiveRealtimeVoiceSession(
        gateway: GatewayNodeSession,
        voiceSessionId: String,
        prefetchedVoiceSessionId: String)
    {
        self.activeRealtimeVoiceSessionId = voiceSessionId
        self.prefetchedRealtimeSession = TalkRealtimeClientSession(
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: prefetchedVoiceSessionId,
            clientSecret: "test-prefetch-secret",
            offerUrl: nil,
            offerHeaders: nil,
            model: "gpt-realtime-2",
            voice: "marin",
            expiresAt: nil)
        self.realtimeSession = TalkRealtimeWebRTCSession(
            gateway: gateway,
            sessionKey: self.mainSessionKey,
            voiceSessionId: voiceSessionId,
            transcriptStore: self.realtimeTranscriptStore,
            delegate: self)
    }

    func _test_invalidatePrefetchedRealtimeSession() async {
        await self.invalidatePrefetchedRealtimeSession()?.value
    }

    func _test_activeRealtimeVoiceSessionId() -> String? {
        self.activeRealtimeVoiceSessionId
    }

    func _test_hasPrefetchedRealtimeSession() -> Bool {
        self.prefetchedRealtimeSession != nil
    }

    func _test_clearRealtimeSession() {
        self.realtimeSession = nil
    }

    func _test_setRealtimeVoiceSessionCloseRequest(
        _ handler: (@MainActor (_ method: String, _ paramsJSON: String?) async throws -> Void)?)
    {
        self.testRealtimeVoiceSessionCloseRequest = handler
    }

    static func _test_retryRealtimeVoiceSessionClose(
        operation: @escaping @MainActor () async throws -> Void) async throws
    {
        try await self.retryRealtimeVoiceSessionClose(
            retryDelaysNanoseconds: [0, 1, 1],
            sleep: { _ in },
            operation: operation)
    }

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

    static func _test_latestAssistantText(
        messages: [[String: Any]],
        runId: String,
        since: Double? = nil) -> String?
    {
        self.latestAssistantText(messages: messages, runId: runId, since: since)
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

    func _test_beginIncrementalSpeechOwnership() -> Int {
        self.resetIncrementalSpeech()
        return self.speechGeneration
    }

    func _test_handleIncrementalAssistantFinal(text: String, speechGeneration: Int) async -> Bool {
        await self.handleIncrementalAssistantFinal(
            text: text,
            speechGeneration: speechGeneration)
    }

    func _test_hasIncrementalSpeechOwnership() -> Bool {
        self.incrementalSpeechActive || self.incrementalSpeechTask != nil
    }

    func _test_lastInterruptedAtSeconds() -> Double? {
        self.lastInterruptedAtSeconds
    }

    func _test_hasRecognitionRequest() -> Bool {
        self.recognitionRequest != nil
    }

    func _test_activePushToTalkCaptureId() -> String? {
        self.activePTTCaptureId
    }

    func _test_finishingPushToTalkCaptureId() -> String? {
        self.finishingPushToTalk?.captureId
    }

    func _test_setPTTFinalizerHandler(_ handler: (@MainActor () async -> Void)?) {
        self.testPTTFinalizerHandler = handler
    }

    func _test_setStartEntryHandler(_ handler: (@MainActor () async -> Void)?) {
        self.testStartEntryHandler = handler
    }

    func _test_setPTTOnceStartedHandler(_ handler: (@MainActor () async -> Void)?) {
        self.testPTTOnceStartedHandler = handler
    }

    func _test_setPTTReservedHandler(_ handler: (@MainActor () async -> Void)?) {
        self.testPTTReservedHandler = handler
    }

    func _test_pushToTalkCaptureIsIdle() -> Bool {
        self.captureMode == .idle
    }

    func _test_handlePushToTalkTranscript(
        _ transcript: String,
        isFinal: Bool,
        captureId: String) async
    {
        await self.handleTranscript(
            transcript: transcript,
            isFinal: isFinal,
            pttCaptureId: captureId,
            recognitionGeneration: self.recognitionGeneration)
    }

    func _test_recognitionGeneration() -> UInt64 {
        self.recognitionGeneration
    }

    func _test_handleTranscript(
        _ transcript: String,
        isFinal: Bool,
        pttCaptureId: String?,
        recognitionGeneration: UInt64) async
    {
        await self.handleTranscript(
            transcript: transcript,
            isFinal: isFinal,
            pttCaptureId: pttCaptureId,
            recognitionGeneration: recognitionGeneration)
    }

    func _test_lastTranscript() -> String {
        self.lastTranscript
    }

    func _test_audioSessionIsActive() -> Bool {
        self.audioSessionIsActive
    }

    func _test_setContinuousTranscriptProcessingActive(_ active: Bool) {
        if active {
            let generation = self.beginTranscriptProcessing()
            self.continuousTranscriptProcessingGeneration = generation
            self.captureMode = .idle
        } else {
            self.continuousTranscriptProcessingGeneration = nil
        }
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
        self.gatewayTalkActiveModeTitle = String(localized: "Realtime unavailable")
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
        self.isListening = false
        self.setStatus(String(localized: "Listening (PTT)"), phase: .listening)
        self.handleRealtimeRelayStatus("Listening (Realtime)")
        return self.captureMode == .pushToTalk &&
            !self.isListening &&
            self.phase == .listening
    }

    func _test_markSpeechErrorStatusPendingRestart(_ text: String) {
        self.isEnabled = true
        self.gatewayConnected = true
        self.speechErrorStatusRevisionPendingRestart = self.setStatus(
            text,
            phase: .idle,
            watchPresentation: .verbatim(text))
    }

    func _test_restoreListeningStatusAfterSpeechErrorRestart() {
        self.restoreListeningStatusAfterSpeechErrorRestart()
    }

    func _test_prepareRealtimeRelayStart() {
        self.prepareRealtimeRelayStart()
    }

    func _test_setRealtimeRelayStartInFlight(_ inFlight: Bool) {
        self.realtimeRelayStartGeneration = inFlight ? self.realtimeRelayGeneration : nil
    }

    func _test_realtimeRelayStartIsInFlight() -> Bool {
        self.realtimeRelayStartGeneration != nil
    }

    func _test_mainSessionKey() -> String {
        self.mainSessionKey
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

extension TalkModeManager {
    static let chatThinkingOverride: String? = nil
}

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
