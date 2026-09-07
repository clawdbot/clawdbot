import AudioToolbox
import AVFoundation
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog
import Speech

actor TalkModeRuntime {
    static let shared = TalkModeRuntime()
    typealias RealtimeTalkBootstrapProvider =
        @Sendable () async throws -> GatewayConnection.RealtimeTalkBootstrap

    enum PlaybackPlan: Equatable {
        case elevenLabsThenSystemVoice(apiKey: String, voiceId: String)
        case gatewayTalkSpeakThenSystemVoice
        case mlxThenSystemVoice
        case systemVoiceOnly
    }

    enum MLXFailureDisposition: Equatable {
        case canceled
        case fallback
    }

    let logger = Logger(subsystem: "ai.openclaw", category: "talk.runtime")
    let ttsLogger = Logger(subsystem: "ai.openclaw", category: "talk.tts")
    static let defaultModelIdFallback = "eleven_v3"
    static let defaultTalkProvider = "elevenlabs"
    static let mlxTalkProvider = "mlx"
    static let systemTalkProvider = "system"
    static let defaultSilenceTimeoutMs = TalkDefaults.silenceTimeoutMs

    private final class RMSMeter: @unchecked Sendable {
        private let lock = NSLock()
        private var latestRMS: Double = 0

        func set(_ rms: Double) {
            self.lock.lock()
            self.latestRMS = rms
            self.lock.unlock()
        }

        func get() -> Double {
            self.lock.lock()
            let value = self.latestRMS
            self.lock.unlock()
            return value
        }
    }

    private var recognizerCache = SpeechRecognizerCache()
    private var audioEngine: AVAudioEngine?
    private var audioInputObserver: AudioInputDeviceObserver?
    private var activeInputResolution: AudioInputDeviceResolution?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    var recognitionGeneration: Int = 0
    private var rmsTask: Task<Void, Never>?
    private let rmsMeter = RMSMeter()

    private var captureTask: Task<Void, Never>?
    private var silenceTask: Task<Void, Never>?
    var phase: TalkModePhase = .idle
    var isEnabled = false
    var isPaused = false
    var lifecycleGeneration: Int = 0

    private var lastHeard: Date?
    private var noiseFloorRMS: Double = 1e-4
    private var lastTranscript: String = ""
    private var lastSpeechEnergyAt: Date?

    private var defaultVoiceId: String?
    private var currentVoiceId: String?
    private var defaultModelId: String?
    private var currentModelId: String?
    private var voiceOverrideActive = false
    private var modelOverrideActive = false
    private var defaultOutputFormat: String?
    private var interruptOnSpeech: Bool = true
    private var activeTalkProvider = TalkModeRuntime.defaultTalkProvider
    var realtimeProvider: String?
    var realtimeModelId: String?
    var realtimeSpeakerVoice: String?
    var realtimeMode: String?
    var realtimeTransport: String?
    var realtimeBrain: String?
    var hasGatewayRealtimeRelayTuple = false
    var macOSRealtimeRelayOptIn = false
    var realtimeSession: RealtimeTalkRelaySession?
    var realtimeSessionReadyAt: Date?
    var rapidRealtimeRestartCount = 0
    var bypassRealtimeOnNextStart = false
    let realtimeRelayDeliveryGate = TalkGenerationDeliveryGate()
    var realtimeRelayGeneration: UInt64 = 0 {
        didSet { _ = self.realtimeRelayDeliveryGate.activate() }
    }

    var realtimeRelayStartGeneration: UInt64?
    var pendingRealtimeRelayStartLifecycleGeneration: Int?
    var realtimeRestartGeneration: UInt64 = 0
    var realtimeRestartTask: Task<Void, Never>?
    var realtimeReconfigurationGeneration: UInt64 = 0
    let realtimeTalkBootstrapProvider: RealtimeTalkBootstrapProvider
    #if DEBUG
    var voiceWakeSupportedProvider: @Sendable () -> Bool = { voiceWakeSupported }
    var voiceWakePermissionProvider: VoiceWakePermissionProvider = {
        await PermissionManager.ensureVoiceWakePermissions(interactive: true)
    }

    var realtimeAudioCaptureProvider: RealtimeAudioCaptureProvider = {
        MacRealtimeTalkAudioCapture()
    }

    var realtimeConfigApplicationCheckpoint: (@Sendable () async -> Void)?
    var recognitionCleanupProbe: (@Sendable () -> Void)?
    #endif
    private var speechLocaleID: String?
    private var lastInterruptedAtSeconds: Double?
    private var voiceAliases: [String: String] = [:]
    private var lastSpokenText: String?
    private var apiKey: String?
    private var mlxReferenceAudioPath: String?
    private var mlxReferenceText: String?
    private var fallbackVoiceId: String?
    private var lastPlaybackWasPCM: Bool = false

    private var silenceWindow: TimeInterval = .init(TalkModeRuntime.defaultSilenceTimeoutMs) / 1000
    private let minSpeechRMS: Double = 1e-3
    private let speechBoostFactor: Double = 6.0

    init(realtimeTalkBootstrapProvider: @escaping RealtimeTalkBootstrapProvider = {
        try await GatewayConnection.shared.acquireRealtimeTalkBootstrap()
    }) {
        self.realtimeTalkBootstrapProvider = realtimeTalkBootstrapProvider
    }

    // MARK: - Lifecycle

    func setEnabled(_ enabled: Bool) async {
        guard enabled != self.isEnabled else { return }
        self.isEnabled = enabled
        self.lifecycleGeneration &+= 1
        resetRealtimeRecoveryState()
        if enabled {
            await start()
        } else {
            await self.stop()
        }
    }

    func setPaused(_ paused: Bool) async {
        guard paused != self.isPaused else { return }
        self.isPaused = paused
        await MainActor.run { TalkModeController.shared.updateLevel(0) }

        guard self.isEnabled else { return }

        if paused {
            self.pendingRealtimeRelayStartLifecycleGeneration = nil
            if self.realtimeRelayStartGeneration != nil {
                self.realtimeRelayGeneration &+= 1
            }
        } else if self.realtimeRelayStartGeneration != nil, self.macOSRealtimeRelayOptIn {
            self.pendingRealtimeRelayStartLifecycleGeneration = self.lifecycleGeneration
            return
        }

        if paused, realtimeSession == nil {
            cancelScheduledRealtimeRecovery()
        }

        if let realtimeSession {
            let relayGeneration = self.realtimeRelayGeneration
            if paused {
                await MainActor.run { realtimeSession.setOutputPaused(true) }
                guard self.isPaused,
                      self.realtimeRelayGeneration == relayGeneration,
                      self.realtimeSession === realtimeSession,
                      await setRealtimeInputPaused(
                          true,
                          session: realtimeSession,
                          relayGeneration: relayGeneration)
                else { return }
                self.lastTranscript = ""
                self.lastHeard = nil
                self.lastSpeechEnergyAt = nil
                self.phase = .idle
                _ = await projectRealtimeRelay(relayGeneration, realtimeSession) {
                    TalkModeController.shared.updateLevel(0)
                    TalkModeController.shared.updateSpeakingLevel(nil)
                    TalkModeController.shared.updatePartialTranscript("")
                    TalkModeController.shared.updatePhase(.idle)
                }
            } else {
                guard await setRealtimeInputPaused(
                    false,
                    session: realtimeSession,
                    relayGeneration: relayGeneration),
                    !self.isPaused,
                    self.realtimeRelayGeneration == relayGeneration,
                    self.realtimeSession === realtimeSession
                else { return }
                await MainActor.run { realtimeSession.setOutputPaused(false) }
                guard !self.isPaused,
                      self.realtimeRelayGeneration == relayGeneration,
                      self.realtimeSession === realtimeSession
                else {
                    await MainActor.run { realtimeSession.setOutputPaused(true) }
                    return
                }
                self.phase = .listening
                _ = await projectRealtimeRelay(relayGeneration, realtimeSession) {
                    TalkModeController.shared.updatePhase(.listening)
                }
            }
            return
        }

        if !paused, self.macOSRealtimeRelayOptIn {
            await start()
            return
        }

        if paused {
            self.lastTranscript = ""
            self.lastHeard = nil
            self.lastSpeechEnergyAt = nil
            await MainActor.run { TalkModeController.shared.updatePartialTranscript("") }
            self.stopRecognition()
            return
        }

        if self.phase == .idle || self.phase == .listening {
            let lifecycleGeneration = self.lifecycleGeneration
            guard await self.startRecognition(lifecycleGeneration: lifecycleGeneration),
                  self.isCurrent(lifecycleGeneration), !self.isPaused else { return }
            self.phase = .listening
            await MainActor.run { TalkModeController.shared.updatePhase(.listening) }
            self.startSilenceMonitor()
        }
    }

    func isCurrent(_ generation: Int) -> Bool {
        generation == self.lifecycleGeneration && self.isEnabled
    }

    func stop() async {
        await self.stop(reconfigurationGeneration: nil, lifecycleGeneration: nil)
    }

    func detachResourcesForRealtimeStop() -> RealtimeTalkRelaySession? {
        let realtimeSession = self.realtimeSession
        self.realtimeSession = nil
        self.audioInputObserver?.stop()
        self.audioInputObserver = nil
        self.captureTask?.cancel()
        self.captureTask = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.lastTranscript = ""
        self.lastHeard = nil
        self.lastSpeechEnergyAt = nil
        self.phase = .idle
        self.stopRecognition()
        return realtimeSession
    }

    func startAudioInputObserver() {
        guard self.audioInputObserver == nil else { return }
        let observer = AudioInputDeviceObserver()
        observer.start {
            Task { await TalkModeRuntime.shared.audioInputDevicesDidChange() }
        }
        self.audioInputObserver = observer
    }

    private func audioInputDevicesDidChange() async {
        guard self.isEnabled, !self.isPaused, self.phase == .listening else { return }
        let lifecycleGeneration = self.lifecycleGeneration
        let availableUIDs = AudioInputDeviceObserver.aliveInputDeviceUIDs()
        guard let activeInputResolution else {
            _ = await self.startRecognition(lifecycleGeneration: lifecycleGeneration)
            return
        }
        guard activeInputResolution.shouldRestart(
            availableUIDs: availableUIDs,
            defaultUID: AudioInputDeviceObserver.defaultInputDeviceUID())
        else { return }

        self.logger.warning("talk active/default input changed; restarting capture")
        _ = await self.startRecognition(lifecycleGeneration: lifecycleGeneration)
    }

    // MARK: - Speech recognition

    private struct RecognitionUpdate {
        let transcript: String?
        let hasConfidence: Bool
        let isFinal: Bool
        let errorDescription: String?
        let generation: Int
    }

    func startRecognition(lifecycleGeneration: Int) async -> Bool {
        guard let recognitionAttempt = beginRecognitionAttempt(
            lifecycleGeneration: lifecycleGeneration)
        else { return false }

        let voiceWakeLocale = await MainActor.run { AppStateStore.shared.voiceWakeLocaleID }
        let selectedInputUID = await MainActor.run { AppStateStore.shared.voiceWakeMicID }
        let supportedLocaleIDs = Set(SFSpeechRecognizer.supportedLocales().map(\.identifier))
        let localeID = TalkConfigParsing.resolvedSpeechRecognitionLocaleID(
            preferredLocaleIDs: [
                self.speechLocaleID,
                voiceWakeLocale,
                Locale.autoupdatingCurrent.identifier,
            ],
            supportedLocaleIDs: supportedLocaleIDs)
        let recognizer = self.recognizerCache.recognizer(localeID: localeID)
        guard let recognizer, recognizer.isAvailable else {
            self.logger.error("talk recognizer unavailable")
            return false
        }
        self.logger.debug("talk recognizer locale=\(recognizer.locale.identifier, privacy: .public)")

        let selection = AudioInputDeviceObserver.resolveSelection(selectedInputUID)
        // Preparation above crosses MainActor. Hardware can become owned/running only
        // after this lifecycle and recognition attempt are revalidated together.
        guard self.canCommitRecognitionStart(
            lifecycleGeneration: lifecycleGeneration,
            recognitionAttempt: recognitionAttempt) else { return false }

        // AVAudioEngine materializes inputNode from the system default before CurrentDevice can bind.
        // Without a usable default, accessing inputNode can SIGABRT even when another UID is alive.
        guard selection.resolvedUID != nil, AudioInputDeviceObserver.hasUsableDefaultInputDevice() else {
            self.logger.error("talk mode: no usable audio input device")
            return false
        }

        let started = TalkRecognitionCaptureLifecycle.start(
            isCurrent: {
                self.canCommitRecognitionStart(
                    lifecycleGeneration: lifecycleGeneration,
                    recognitionAttempt: recognitionAttempt)
            },
            prepare: { enableVoiceProcessing in
                try self.prepareStartedRecognitionCapture(
                    selection: selection,
                    enableVoiceProcessing: enableVoiceProcessing)
            },
            discard: { $0.discard() },
            publish: { preparedCapture in
                self.recognitionRequest = preparedCapture.request
                self.audioEngine = preparedCapture.engine
                self.activeInputResolution = preparedCapture.activeInputResolution
                self.recognitionTask = recognizer.recognitionTask(
                    with: preparedCapture.request,
                    resultHandler: { [weak self, recognitionAttempt] result, error in
                        guard let self else { return }
                        let segments = result?.bestTranscription.segments ?? []
                        let transcript = result?.bestTranscription.formattedString
                        let update = RecognitionUpdate(
                            transcript: transcript,
                            hasConfidence: segments.contains { $0.confidence > 0.6 },
                            isFinal: result?.isFinal ?? false,
                            errorDescription: error?.localizedDescription,
                            generation: recognitionAttempt)
                        Task { await self.handleRecognition(update) }
                    })
            },
            onFailure: { enableVoiceProcessing, error in
                if enableVoiceProcessing {
                    self.logger.warning(
                        "talk processed input start failed; retrying without voice processing: " +
                            "\(error.localizedDescription, privacy: .public)")
                } else {
                    self.logger.error(
                        "talk audio engine start failed: \(error.localizedDescription, privacy: .public)")
                }
            })
        guard started else { return false }
        self.startRMSTicker(meter: self.rmsMeter)
        return true
    }

    func beginRecognitionAttempt(lifecycleGeneration: Int) -> Int? {
        guard self.isCurrent(lifecycleGeneration), !self.isPaused else { return nil }
        self.recognitionGeneration &+= 1
        let recognitionAttempt = self.recognitionGeneration
        self.discardRecognitionResources()
        return recognitionAttempt
    }

    func canCommitRecognitionStart(lifecycleGeneration: Int, recognitionAttempt: Int) -> Bool {
        self.isCurrent(lifecycleGeneration) && !self.isPaused && self.recognitionGeneration == recognitionAttempt
    }

    private func stopRecognition() {
        self.recognitionGeneration &+= 1
        self.discardRecognitionResources()
    }

    func discardRecognitionResources() {
        #if DEBUG
        self.recognitionCleanupProbe?()
        #endif
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.audioEngine?.inputNode.removeTap(onBus: 0)
        self.audioEngine?.stop()
        self.audioEngine = nil
        self.activeInputResolution = nil
        self.rmsTask?.cancel()
        self.rmsTask = nil
    }

    private func startRMSTicker(meter: RMSMeter) {
        self.rmsTask?.cancel()
        self.rmsTask = Task { [weak self, meter] in
            while let self {
                try? await Task.sleep(nanoseconds: 50_000_000)
                if Task.isCancelled {
                    return
                }
                await self.noteAudioLevel(rms: meter.get())
            }
        }
    }

    private func handleRecognition(_ update: RecognitionUpdate) async {
        guard update.generation == self.recognitionGeneration else { return }
        guard !self.isPaused else { return }
        if let errorDescription = update.errorDescription {
            self.logger.debug("talk recognition error: \(errorDescription, privacy: .public)")
        }
        guard let transcript = update.transcript else { return }

        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if self.phase == .speaking, self.interruptOnSpeech {
            if await shouldInterrupt(transcript: trimmed, hasConfidence: update.hasConfidence) {
                await stopSpeaking(reason: .speech)
                self.lastTranscript = ""
                self.lastHeard = nil
                await self.startListening()
            }
            return
        }

        guard self.phase == .listening else { return }

        if !trimmed.isEmpty {
            self.lastTranscript = trimmed
            self.lastHeard = Date()
        }

        await MainActor.run { TalkModeController.shared.updatePartialTranscript(trimmed) }

        if update.isFinal {
            self.lastTranscript = trimmed
        }
    }

    // MARK: - Silence handling

    func startSilenceMonitor() {
        self.silenceTask?.cancel()
        self.silenceTask = Task { [weak self] in
            await self?.silenceLoop()
        }
    }

    private func silenceLoop() async {
        while self.isEnabled, await SimpleTaskSupport.waitForNextOperation(interval: 0.2) {
            await self.checkSilence()
        }
    }

    private func checkSilence() async {
        guard !self.isPaused else { return }
        guard self.phase == .listening else { return }
        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }
        guard let lastHeard else { return }
        let elapsed = Date().timeIntervalSince(lastHeard)
        guard elapsed >= self.silenceWindow else { return }
        await self.finalizeTranscript(transcript)
    }

    private func startListening() async {
        self.phase = .listening
        self.lastTranscript = ""
        self.lastHeard = nil
        await MainActor.run {
            TalkModeController.shared.updatePhase(.listening)
            TalkModeController.shared.updateLevel(0)
            TalkModeController.shared.updatePartialTranscript("")
        }
    }

    private func finalizeTranscript(_ text: String) async {
        self.lastTranscript = ""
        self.lastHeard = nil
        self.phase = .thinking
        await MainActor.run {
            TalkModeController.shared.commitTranscript(text)
            TalkModeController.shared.updatePhase(.thinking)
        }
        // Play "send" chime when the user's speech is finalized and about to be sent
        let sendChime = await MainActor.run { AppStateStore.shared.voiceWakeSendChime }
        if sendChime != .none {
            await MainActor.run { VoiceWakeChimePlayer.play(sendChime, reason: "talk.send") }
        }
        self.stopRecognition()
        await sendAndSpeak(text)
    }

    private func bindSelectedInputIfNeeded(
        _ selection: AudioInputDeviceResolution,
        to input: AVAudioInputNode) -> AudioInputDeviceResolution
    {
        guard selection.shouldBindSelectedDevice, let selectedUID = selection.resolvedUID else {
            return selection
        }
        guard let audioUnit = input.audioUnit,
              var deviceID = AudioInputDeviceObserver.inputDeviceID(forUID: selectedUID)
        else {
            self.logger.warning("talk selected input could not be resolved; using system default")
            return self.defaultFallback(for: selection)
        }

        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioObjectID>.size))
        guard status == noErr else {
            self.logger.warning(
                "talk selected input binding failed status=\(status); using system default")
            return self.defaultFallback(for: selection)
        }
        self.logger.info("talk selected input bound uid=\(selectedUID, privacy: .private(mask: .hash))")
        return selection
    }

    private func prepareStartedRecognitionCapture(
        selection: AudioInputDeviceResolution,
        enableVoiceProcessing: Bool)
        throws -> PreparedRecognitionCapture
    {
        let request = SFSpeechAudioBufferRecognitionRequest()
        TalkRecognitionCaptureLifecycle.configure(request)
        let audioEngine = AVAudioEngine()
        let input = audioEngine.inputNode
        var tapInstalled = false
        do {
            if enableVoiceProcessing {
                try input.setVoiceProcessingEnabled(true)
            }

            let activeResolution = self.bindSelectedInputIfNeeded(selection, to: input)
            guard activeResolution.resolvedUID != nil else {
                throw TalkAudioInputError.unavailable
            }

            let format = input.outputFormat(forBus: 0)
            guard format.channelCount > 0, format.sampleRate > 0 else {
                throw TalkAudioInputError.invalidFormat
            }
            input.removeTap(onBus: 0)
            let meter = self.rmsMeter
            input.installTap(
                onBus: 0,
                bufferSize: 2048,
                format: format)
            { [weak request, meter] buffer, _ in
                request?.append(SpeechAudioBufferNormalizer.speechCompatibleBuffer(from: buffer))
                meter.set(TalkAudioLevel.rms(buffer: buffer))
            }
            tapInstalled = true
            audioEngine.prepare()
            try audioEngine.start()
            return PreparedRecognitionCapture(
                request: request,
                engine: audioEngine,
                activeInputResolution: activeResolution)
        } catch {
            request.endAudio()
            if tapInstalled {
                input.removeTap(onBus: 0)
            }
            audioEngine.stop()
            throw error
        }
    }

    private func defaultFallback(for selection: AudioInputDeviceResolution) -> AudioInputDeviceResolution {
        AudioInputDeviceResolution(
            selectedUID: selection.selectedUID,
            resolvedUID: AudioInputDeviceObserver.resolveSelection(nil).resolvedUID,
            fellBackToSystemDefault: selection.selectedUID != nil)
    }
}

// MARK: - Gateway + TTS

extension TalkModeRuntime {
    private func sendAndSpeak(_ transcript: String) async {
        let gen = self.lifecycleGeneration
        await reloadConfig()
        guard self.isCurrent(gen) else { return }
        let prompt = self.buildPrompt(transcript: transcript)
        let activeSessionKey = await MainActor.run { WebChatManager.shared.activeSessionKey }
        let sessionKey: String = if let activeSessionKey {
            activeSessionKey
        } else {
            await GatewayConnection.shared.mainSessionKey()
        }
        let runId = UUID().uuidString
        let startedAt = Date().timeIntervalSince1970
        self.logger.info(
            "talk send start runId=\(runId, privacy: .public) " +
                "session=\(sessionKey, privacy: .public) " +
                "chars=\(prompt.count, privacy: .public)")

        do {
            let response = try await GatewayConnection.shared.chatSend(
                sessionKey: sessionKey,
                message: prompt,
                thinking: nil,
                idempotencyKey: runId,
                attachments: [])
            guard self.isCurrent(gen) else { return }
            let normalizedStatus = ChatSendStatus.normalized(response.status)
            self.logger.info(
                "talk chat.send ok runId=\(response.runId, privacy: .public) " +
                    "status=\(normalizedStatus, privacy: .public) " +
                    "session=\(sessionKey, privacy: .public)")
            if ChatSendStatus.acceptance(of: response.status) == .terminalFailure {
                self.logger.warning(
                    "talk chat.send terminal ack runId=\(response.runId, privacy: .public) " +
                        "status=\(normalizedStatus, privacy: .public)")
                await self.resumeListeningIfNeeded()
                return
            }

            var assistantText: String?
            if ChatSendStatus.acceptance(of: response.status) == .terminalSuccess {
                self.logger.info(
                    "talk chat.send terminal ok runId=\(response.runId, privacy: .public); " +
                        "using history fallback")
                assistantText = await self.waitForAssistantTextFromHistory(
                    sessionKey: sessionKey,
                    since: nil,
                    timeoutSeconds: 12)
            } else {
                assistantText = await self.waitForAssistantEventText(
                    sessionKey: sessionKey,
                    runId: response.runId,
                    timeoutSeconds: 45)
                if assistantText == nil {
                    self.logger.warning("talk assistant event text missing; using history fallback")
                    assistantText = await self.waitForAssistantTextFromHistory(
                        sessionKey: sessionKey,
                        since: startedAt,
                        timeoutSeconds: 12)
                }
            }
            guard let assistantText
            else {
                self.logger.warning("talk assistant text missing after timeout")
                guard await self.startRecognition(lifecycleGeneration: gen),
                      self.isCurrent(gen), !self.isPaused else { return }
                await self.startListening()
                return
            }
            guard self.isCurrent(gen) else { return }

            self.logger.info("talk assistant text len=\(assistantText.count, privacy: .public)")
            await self.playAssistant(text: assistantText)
            guard self.isCurrent(gen) else { return }
            await self.resumeListeningIfNeeded()
            return
        } catch {
            self.logger.error("talk chat.send failed: \(error.localizedDescription, privacy: .public)")
            await self.resumeListeningIfNeeded()
            return
        }
    }

    private func resumeListeningIfNeeded() async {
        if self.isPaused {
            self.lastTranscript = ""
            self.lastHeard = nil
            self.lastSpeechEnergyAt = nil
            await MainActor.run {
                TalkModeController.shared.updateLevel(0)
            }
            return
        }
        let lifecycleGeneration = self.lifecycleGeneration
        guard await self.startRecognition(lifecycleGeneration: lifecycleGeneration),
              self.isCurrent(lifecycleGeneration), !self.isPaused else { return }
        await self.startListening()
    }

    private func buildPrompt(transcript: String) -> String {
        let interrupted = self.lastInterruptedAtSeconds
        self.lastInterruptedAtSeconds = nil
        return TalkPromptBuilder.build(transcript: transcript, interruptedAtSeconds: interrupted)
    }

    private func waitForAssistantEventText(
        sessionKey: String,
        runId: String,
        timeoutSeconds: Int) async -> String?
    {
        let stream = await GatewayConnection.shared.subscribe(bufferingNewest: 200)
        return await withTaskGroup(of: String?.self) { group in
            group.addTask { [runId, sessionKey] in
                var latestText: String?
                for await delivery in stream {
                    if Task.isCancelled {
                        return latestText
                    }
                    guard delivery.isCurrent, case let .event(evt) = delivery.push else { continue }
                    guard evt.event == "chat", let payload = evt.payload else { continue }
                    guard let chatEvent = try? GatewayPayloadDecoding.decode(
                        payload,
                        as: OpenClawChatEventPayload.self)
                    else {
                        continue
                    }
                    guard chatEvent.runId == runId else { continue }
                    if let eventSessionKey = chatEvent.sessionKey,
                       !Self.matchesSessionKey(eventSessionKey, sessionKey)
                    {
                        continue
                    }
                    if let text = OpenClawChatEventText.assistantText(from: chatEvent) {
                        latestText = text
                    }
                    switch chatEvent.state {
                    case "final":
                        return latestText
                    case "aborted", "error":
                        return nil
                    default:
                        break
                    }
                }
                return latestText
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                return nil
            }
            guard let result = await group.next() else {
                group.cancelAll()
                return nil
            }
            group.cancelAll()
            return result
        }
    }

    private static func matchesSessionKey(_ incoming: String, _ current: String) -> Bool {
        let incoming = incoming.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let current = current.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if incoming == current {
            return true
        }
        return (incoming == "agent:main:main" && current == "main") ||
            (incoming == "main" && current == "agent:main:main")
    }

    private func waitForAssistantTextFromHistory(
        sessionKey: String,
        since: Double?,
        timeoutSeconds: Int) async -> String?
    {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
        while Date() < deadline {
            if let text = await latestAssistantText(sessionKey: sessionKey, since: since) {
                return text
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return nil
    }

    private func latestAssistantText(sessionKey: String, since: Double? = nil) async -> String? {
        do {
            let history = try await GatewayConnection.shared.chatHistory(sessionKey: sessionKey)
            let messages = history.messages ?? []
            let decoded: [OpenClawChatMessage] = messages.compactMap { item in
                guard let data = try? JSONEncoder().encode(item) else { return nil }
                return try? JSONDecoder().decode(OpenClawChatMessage.self, from: data)
            }
            let assistant = decoded.last { message in
                guard message.role == "assistant" else { return false }
                guard let since else { return true }
                guard let timestamp = message.timestamp else { return false }
                return TalkHistoryTimestamp.isAfter(timestamp, sinceSeconds: since)
            }
            guard let assistant else { return nil }
            let text = assistant.content.compactMap(\.text).joined(separator: "\n")
            let trimmed = text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        } catch {
            self.logger.error("talk history fetch failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func playAssistant(text: String) async {
        guard let input = await preparePlaybackInput(text: text) else { return }

        switch Self.playbackPlan(provider: input.provider, apiKey: input.apiKey, voiceId: input.voiceId) {
        case let .elevenLabsThenSystemVoice(apiKey, voiceId):
            do {
                try await self.playElevenLabs(input: input, apiKey: apiKey, voiceId: voiceId)
            } catch {
                self.ttsLogger
                    .error(
                        "talk TTS failed: \(error.localizedDescription, privacy: .public); " +
                            "retrying gateway talk.speak")
                do {
                    try await self.playGatewayTalkSpeak(input: input)
                    return
                } catch {
                    self.ttsLogger
                        .error(
                            "talk gateway TTS failed: \(error.localizedDescription, privacy: .public); " +
                                "falling back to system voice")
                }
                do {
                    try await self.playSystemVoice(input: input)
                } catch {
                    self.ttsLogger.error("talk system voice failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        case .gatewayTalkSpeakThenSystemVoice:
            do {
                try await self.playGatewayTalkSpeak(input: input)
                return
            } catch {
                self.ttsLogger
                    .error(
                        "talk gateway TTS failed: \(error.localizedDescription, privacy: .public); " +
                            "falling back to system voice")
                do {
                    try await self.playSystemVoice(input: input)
                } catch {
                    self.ttsLogger.error("talk system voice failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        case .mlxThenSystemVoice:
            do {
                try await self.playMLX(input: input)
            } catch {
                if Self.mlxFailureDisposition(error) == .canceled {
                    self.ttsLogger.info("talk mlx canceled")
                    return
                }
                self.ttsLogger
                    .error(
                        "talk MLX failed: \(error.localizedDescription, privacy: .public); " +
                            "falling back to system voice")
                do {
                    try await self.playSystemVoice(input: input)
                } catch {
                    self.ttsLogger.error("talk system voice failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        case .systemVoiceOnly:
            do {
                try await self.playSystemVoice(input: input)
            } catch {
                self.ttsLogger.error("talk system voice failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        if self.phase == .speaking {
            self.phase = .thinking
            await MainActor.run { TalkModeController.shared.updatePhase(.thinking) }
        }
    }

    static func playbackPlan(provider: String, apiKey: String?, voiceId: String?) -> PlaybackPlan {
        switch provider {
        case self.defaultTalkProvider:
            guard let apiKey, !apiKey.isEmpty, let voiceId else {
                return .systemVoiceOnly
            }
            return .elevenLabsThenSystemVoice(apiKey: apiKey, voiceId: voiceId)
        case self.mlxTalkProvider:
            return .mlxThenSystemVoice
        case self.systemTalkProvider:
            return .systemVoiceOnly
        default:
            return .gatewayTalkSpeakThenSystemVoice
        }
    }

    static func mlxFailureDisposition(_ error: Error) -> MLXFailureDisposition {
        if case TalkMLXSpeechSynthesizer.SynthesizeError.canceled = error {
            return .canceled
        }
        return .fallback
    }

    private struct TalkPlaybackInput {
        let generation: Int
        let provider: String
        let cleanedText: String
        let directive: TalkDirective?
        let apiKey: String?
        let voiceId: String?
        let voicePreset: String?
        let language: String?
        let referenceAudioPath: String?
        let referenceText: String?
        let synthTimeoutSeconds: Double
    }

    private func preparePlaybackInput(text: String) async -> TalkPlaybackInput? {
        let gen = self.lifecycleGeneration
        let parse = TalkDirectiveParser.parse(text)
        let directive = parse.directive
        let cleaned = parse.stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        guard self.isCurrent(gen) else { return nil }

        if !parse.unknownKeys.isEmpty {
            self.logger
                .warning(
                    "talk directive ignored keys: " +
                        "\(parse.unknownKeys.joined(separator: ","), privacy: .public)")
        }

        let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedVoice = TalkVoiceAliases.resolve(requestedVoice, aliases: self.voiceAliases)
        if let requestedVoice, !requestedVoice.isEmpty, resolvedVoice == nil {
            self.logger.warning("talk unknown voice alias \(requestedVoice, privacy: .public)")
        }
        if let voice = resolvedVoice {
            if directive?.once == true {
                self.logger.info("talk voice override (once) voiceId=\(voice, privacy: .public)")
            } else {
                self.currentVoiceId = voice
                self.voiceOverrideActive = true
                self.logger.info("talk voice override voiceId=\(voice, privacy: .public)")
            }
        }

        if let model = directive?.modelId {
            if directive?.once == true {
                self.logger.info("talk model override (once) modelId=\(model, privacy: .public)")
            } else {
                self.currentModelId = model
                self.modelOverrideActive = true
            }
        }

        let apiKey = self.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let preferredVoice =
            resolvedVoice ??
            self.currentVoiceId ??
            self.defaultVoiceId
        let voicePreset = preferredVoice
        let provider = self.activeTalkProvider

        let language = ElevenLabsTTSClient.validatedLanguage(directive?.language)

        let voiceId: String? = if provider == Self.defaultTalkProvider, let apiKey, !apiKey.isEmpty {
            await self.resolveVoiceId(preferred: preferredVoice, apiKey: apiKey)
        } else if provider == Self.mlxTalkProvider || provider == Self.systemTalkProvider {
            nil
        } else {
            preferredVoice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? preferredVoice : nil
        }

        if provider == Self.defaultTalkProvider, apiKey?.isEmpty != false {
            self.ttsLogger.warning("talk missing ELEVENLABS_API_KEY; falling back to system voice")
        } else if provider == Self.defaultTalkProvider, voiceId == nil {
            self.ttsLogger.warning("talk missing voiceId; falling back to system voice")
        } else if let voiceId {
            self.ttsLogger
                .info(
                    "talk TTS request voiceId=\(voiceId, privacy: .public) " +
                        "chars=\(cleaned.count, privacy: .public)")
        }
        self.lastSpokenText = cleaned

        let synthTimeoutSeconds = max(20.0, min(90.0, Double(cleaned.count) * 0.12))

        guard self.isCurrent(gen) else { return nil }

        return TalkPlaybackInput(
            generation: gen,
            provider: provider,
            cleanedText: cleaned,
            directive: directive,
            apiKey: apiKey,
            voiceId: voiceId,
            voicePreset: voicePreset,
            language: language,
            referenceAudioPath: self.mlxReferenceAudioPath,
            referenceText: self.mlxReferenceText,
            synthTimeoutSeconds: synthTimeoutSeconds)
    }

    private func playElevenLabs(
        input: TalkPlaybackInput,
        apiKey: String,
        voiceId: String) async throws
    {
        let desiredOutputFormat = input.directive?.outputFormat ?? self.defaultOutputFormat ?? "pcm_44100"
        let outputFormat = ElevenLabsTTSClient.validatedOutputFormat(desiredOutputFormat)
        if outputFormat == nil, !desiredOutputFormat.isEmpty {
            self.logger
                .warning(
                    "talk output_format unsupported for local playback: " +
                        "\(desiredOutputFormat, privacy: .public)")
        }

        let modelId = input.directive?.modelId ?? self.currentModelId ?? self.defaultModelId
        func makeRequest(outputFormat: String?) -> ElevenLabsTTSRequest {
            ElevenLabsTTSRequest(
                text: input.cleanedText,
                modelId: modelId,
                outputFormat: outputFormat,
                speed: TalkTTSValidation.resolveSpeed(
                    speed: input.directive?.speed,
                    rateWPM: input.directive?.rateWPM),
                stability: TalkTTSValidation.validatedStability(
                    input.directive?.stability,
                    modelId: modelId),
                similarity: TalkTTSValidation.validatedUnit(input.directive?.similarity),
                style: TalkTTSValidation.validatedUnit(input.directive?.style),
                speakerBoost: input.directive?.speakerBoost,
                seed: TalkTTSValidation.validatedSeed(input.directive?.seed),
                normalize: ElevenLabsTTSClient.validatedNormalize(input.directive?.normalize),
                language: input.language,
                latencyTier: TalkTTSValidation.validatedLatencyTier(input.directive?.latencyTier))
        }

        let request = makeRequest(outputFormat: outputFormat)
        self.ttsLogger.info("talk TTS synth timeout=\(input.synthTimeoutSeconds, privacy: .public)s")
        let client = ElevenLabsTTSClient(apiKey: apiKey)
        let stream = client.streamSynthesize(voiceId: voiceId, request: request)
        guard self.isCurrent(input.generation) else { return }

        if self.interruptOnSpeech {
            guard await self.prepareForPlayback(generation: input.generation) else { return }
        }

        await MainActor.run { TalkModeController.shared.updatePhase(.speaking) }
        self.phase = .speaking

        let result = await playRemoteStream(
            client: client,
            voiceId: voiceId,
            outputFormat: outputFormat,
            makeRequest: makeRequest,
            stream: stream)
        self.ttsLogger
            .info(
                "talk audio result finished=\(result.finished, privacy: .public) " +
                    "interruptedAt=\(String(describing: result.interruptedAt), privacy: .public)")
        if !result.finished, result.interruptedAt == nil {
            throw NSError(domain: "StreamingAudioPlayer", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "audio playback failed",
            ])
        }
        if !result.finished, let interruptedAt = result.interruptedAt, phase == .speaking {
            if self.interruptOnSpeech {
                self.lastInterruptedAtSeconds = interruptedAt
            }
        }
    }

    private func playRemoteStream(
        client: ElevenLabsTTSClient,
        voiceId: String,
        outputFormat: String?,
        makeRequest: (String?) -> ElevenLabsTTSRequest,
        stream: AsyncThrowingStream<Data, Error>) async -> StreamingPlaybackResult
    {
        let sampleRate = TalkTTSValidation.pcmSampleRate(from: outputFormat)
        if let sampleRate {
            self.lastPlaybackWasPCM = true
            let result = await playPCM(stream: stream, sampleRate: sampleRate)
            if result.finished || result.interruptedAt != nil {
                return result
            }
            let mp3Format = ElevenLabsTTSClient.validatedOutputFormat("mp3_44100")
            self.ttsLogger.warning("talk pcm playback failed; retrying mp3")
            self.lastPlaybackWasPCM = false
            let mp3Stream = client.streamSynthesize(
                voiceId: voiceId,
                request: makeRequest(mp3Format))
            return await playMP3(stream: mp3Stream)
        }
        self.lastPlaybackWasPCM = false
        return await playMP3(stream: stream)
    }

    private func playGatewayTalkSpeak(input: TalkPlaybackInput) async throws {
        let params = Self.makeTalkSpeakParams(
            text: input.cleanedText,
            voiceId: input.voiceId,
            modelId: self.currentModelId ?? self.defaultModelId,
            outputFormat: self.defaultOutputFormat,
            directive: input.directive)
        let result: TalkSpeakResult = try await GatewayConnection.shared.requestDecoded(
            method: .talkSpeak,
            params: params,
            timeoutMs: max(30000, input.synthTimeoutSeconds * 1000 + 5000))
        guard let audioData = Data(base64Encoded: result.audiobase64), !audioData.isEmpty else {
            throw NSError(domain: "TalkSpeak", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "gateway talk.speak returned empty audio",
            ])
        }
        _ = await stopPCM()
        _ = await stopMP3()
        if self.interruptOnSpeech {
            guard await self.prepareForPlayback(generation: input.generation) else { return }
        }
        await MainActor.run { TalkModeController.shared.updatePhase(.speaking) }
        self.phase = .speaking
        let playback = await playTalkAudio(data: audioData)
        self.ttsLogger
            .info(
                "talk gateway audio provider=\(result.provider, privacy: .public) " +
                    "format=\(result.outputformat ?? "unknown", privacy: .public) " +
                    "finished=\(playback.finished, privacy: .public)")
        if !playback.finished, playback.interruptedAt == nil {
            throw NSError(domain: "TalkSpeak", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "gateway talk.speak audio playback failed",
            ])
        }
    }

    private func playSystemVoice(input: TalkPlaybackInput) async throws {
        self.ttsLogger.info("talk system voice start chars=\(input.cleanedText.count, privacy: .public)")
        if self.interruptOnSpeech {
            guard await self.prepareForPlayback(generation: input.generation) else { return }
        }
        await MainActor.run { TalkModeController.shared.updatePhase(.speaking) }
        self.phase = .speaking
        await TalkSystemSpeechSynthesizer.shared.stop()
        // Use app locale as fallback when no explicit language is set (e.g. system voice without ElevenLabs directive).
        let appLocale = await MainActor.run { AppStateStore.shared.voiceWakeLocaleID }
        let ttsLanguage = input.language ?? appLocale
        try await TalkSystemSpeechSynthesizer.shared.speak(
            text: input.cleanedText,
            language: ttsLanguage)
        self.ttsLogger.info("talk system voice done")
    }

    private func playMLX(input: TalkPlaybackInput) async throws {
        self.ttsLogger.info("talk mlx start chars=\(input.cleanedText.count, privacy: .public)")
        if self.interruptOnSpeech {
            guard await self.prepareForPlayback(generation: input.generation) else { return }
        }
        await MainActor.run { TalkModeController.shared.updatePhase(.speaking) }
        self.phase = .speaking
        let modelRepo = input.directive?.modelId ?? self.currentModelId
        self.lastPlaybackWasPCM = true
        let playbackStream: MLXTTSPlaybackStream
        do {
            playbackStream = try await AsyncTimeout.withTimeout(
                seconds: input.synthTimeoutSeconds,
                onTimeout: {
                    TalkMLXSpeechSynthesizer.SynthesizeError.timedOut
                },
                operation: { [self] in
                    try await self.streamMLXVoice(
                        text: input.cleanedText,
                        modelRepo: modelRepo,
                        language: input.language,
                        voicePreset: input.voicePreset,
                        referenceAudioPath: input.referenceAudioPath,
                        referenceText: input.referenceText,
                        stallTimeoutSeconds: input.synthTimeoutSeconds)
                })
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.timedOut {
            _ = await stopPCM()
            await stopMLXVoice()
            throw TalkMLXSpeechSynthesizer.SynthesizeError.timedOut
        }
        let result = await playPCM(
            stream: playbackStream.chunks,
            sampleRate: playbackStream.sampleRate)
        if !result.finished, result.interruptedAt == nil {
            await stopMLXVoice()
            throw TalkMLXSpeechSynthesizer.SynthesizeError.audioPlaybackFailed
        }
        self.ttsLogger.info("talk mlx done")
    }

    private func prepareForPlayback(generation: Int) async -> Bool {
        guard await self.startRecognition(lifecycleGeneration: generation) else { return false }
        return self.isCurrent(generation) && !self.isPaused
    }

    private func resolveVoiceId(preferred: String?, apiKey: String) async -> String? {
        let trimmed = preferred?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            if let resolved = TalkVoiceAliases.resolve(trimmed, aliases: self.voiceAliases) {
                return resolved
            }
            self.ttsLogger.warning("talk unknown voice alias \(trimmed, privacy: .public)")
        }
        if let fallbackVoiceId {
            return fallbackVoiceId
        }

        do {
            let voices = try await ElevenLabsTTSClient(apiKey: apiKey).listVoices()
            guard let first = voices.first else {
                self.ttsLogger.error("elevenlabs voices list empty")
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
            self.ttsLogger
                .info("talk default voice selected \(name, privacy: .public) (\(first.voiceId, privacy: .public))")
            return first.voiceId
        } catch {
            self.ttsLogger.error("elevenlabs list voices failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    func stopSpeaking(
        reason: TalkStopReason,
        reconfigurationGeneration expectedReconfigurationGeneration: UInt64? = nil,
        lifecycleGeneration expectedLifecycleGeneration: Int? = nil) async
    {
        guard self.ownsReconfiguration(
            expectedReconfigurationGeneration,
            lifecycleGeneration: expectedLifecycleGeneration)
        else { return }
        if let realtimeSession {
            let relayReason = switch reason {
            case .userTap: "user"
            case .speech: "barge-in"
            case .manual: "shutdown"
            }
            let cancelled = await MainActor.run {
                realtimeSession.cancelOutput(reason: relayReason)
            }
            guard self.ownsReconfiguration(
                expectedReconfigurationGeneration,
                lifecycleGeneration: expectedLifecycleGeneration)
            else { return }
            if cancelled, reason != .manual, !self.isPaused {
                self.phase = .listening
                await MainActor.run { TalkModeController.shared.updatePhase(.listening) }
            }
            return
        }
        let usePCM = self.lastPlaybackWasPCM
        let remoteInterruptedAt = usePCM ? await stopPCM() : await stopMP3()
        guard self.ownsReconfiguration(
            expectedReconfigurationGeneration,
            lifecycleGeneration: expectedLifecycleGeneration)
        else { return }
        _ = usePCM ? await stopMP3() : await stopPCM()
        guard self.ownsReconfiguration(
            expectedReconfigurationGeneration,
            lifecycleGeneration: expectedLifecycleGeneration)
        else { return }
        let localInterruptedAt = await stopTalkAudio()
        guard self.ownsReconfiguration(
            expectedReconfigurationGeneration,
            lifecycleGeneration: expectedLifecycleGeneration)
        else { return }
        await TalkSystemSpeechSynthesizer.shared.stop()
        guard self.ownsReconfiguration(
            expectedReconfigurationGeneration,
            lifecycleGeneration: expectedLifecycleGeneration)
        else { return }
        await stopMLXVoice()
        guard self.ownsReconfiguration(
            expectedReconfigurationGeneration,
            lifecycleGeneration: expectedLifecycleGeneration)
        else { return }
        guard self.phase == .speaking else { return }
        let interruptedAt = remoteInterruptedAt ?? localInterruptedAt
        if reason == .speech, let interruptedAt {
            self.lastInterruptedAtSeconds = interruptedAt
        }
        if reason == .manual {
            return
        }
        if reason == .speech || reason == .userTap {
            await self.startListening()
            return
        }
        self.phase = .thinking
        await MainActor.run { TalkModeController.shared.updatePhase(.thinking) }
    }
}

extension TalkModeRuntime {
    static func makeTalkSpeakParams(
        text: String,
        voiceId: String?,
        modelId: String?,
        outputFormat: String?,
        directive: TalkDirective?) -> [String: AnyCodable]
    {
        var params: [String: AnyCodable] = ["text": AnyCodable(text)]

        func addString(_ key: String, _ value: String?) {
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !trimmed.isEmpty else { return }
            params[key] = AnyCodable(trimmed)
        }

        addString("voiceId", voiceId)
        addString("modelId", directive?.modelId ?? modelId)
        addString("outputFormat", directive?.outputFormat ?? outputFormat)
        if let speed = directive?.speed {
            params["speed"] = AnyCodable(speed)
        }
        if let rateWPM = directive?.rateWPM {
            params["rateWpm"] = AnyCodable(rateWPM)
        }
        if let stability = directive?.stability {
            params["stability"] = AnyCodable(stability)
        }
        if let similarity = directive?.similarity {
            params["similarity"] = AnyCodable(similarity)
        }
        if let style = directive?.style {
            params["style"] = AnyCodable(style)
        }
        if let speakerBoost = directive?.speakerBoost {
            params["speakerBoost"] = AnyCodable(speakerBoost)
        }
        if let seed = directive?.seed {
            params["seed"] = AnyCodable(seed)
        }
        addString("normalize", directive?.normalize)
        addString("language", directive?.language)
        if let latencyTier = directive?.latencyTier {
            params["latencyTier"] = AnyCodable(latencyTier)
        }

        return params
    }

    // MARK: - Audio playback (MainActor helpers)

    @MainActor
    private func playPCM(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) async -> StreamingPlaybackResult
    {
        let metered = TalkModeController.shared.meteredSpeechStream(stream, sampleRate: sampleRate)
        let result = await PCMStreamingAudioPlayer.shared.play(stream: metered, sampleRate: sampleRate)
        TalkModeController.shared.endSpeechMetering()
        return result
    }

    /// MP3 streaming has no metering hook; the wave falls back to its floor.
    @MainActor
    private func playMP3(stream: AsyncThrowingStream<Data, Error>) async -> StreamingPlaybackResult {
        await StreamingAudioPlayer.shared.play(stream: stream)
    }

    @MainActor
    private func stopPCM() -> Double? {
        PCMStreamingAudioPlayer.shared.stop()
    }

    @MainActor
    private func stopMP3() -> Double? {
        StreamingAudioPlayer.shared.stop()
    }

    @MainActor
    private func playTalkAudio(data: Data) async -> StreamingPlaybackResult {
        TalkBufferedAudioPlayer.shared.setLevelHandler { level in
            TalkModeController.shared.updateSpeakingLevel(level)
        }
        return await TalkBufferedAudioPlayer.shared.play(data: data)
    }

    @MainActor
    private func stopTalkAudio() -> Double? {
        TalkBufferedAudioPlayer.shared.stop()
    }

    private func streamMLXVoice(
        text: String,
        modelRepo: String?,
        language: String?,
        voicePreset: String?,
        referenceAudioPath: String?,
        referenceText: String?,
        stallTimeoutSeconds: Double) async throws -> MLXTTSPlaybackStream
    {
        try await TalkMLXSpeechSynthesizer.shared.synthesizeStream(
            text: text,
            modelRepo: modelRepo,
            language: language,
            voicePreset: voicePreset,
            referenceAudioPath: referenceAudioPath,
            referenceText: referenceText,
            stallTimeoutSeconds: stallTimeoutSeconds)
    }

    private func stopMLXVoice() async {
        await TalkMLXSpeechSynthesizer.shared.cancelCurrent()
    }

    func parseTalkConfig(_ snap: ConfigSnapshot) -> TalkModeGatewayConfigState {
        let env = ProcessInfo.processInfo.environment
        let envVoice = env["ELEVENLABS_VOICE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sagVoice = env["SAG_VOICE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let envApiKey = env["ELEVENLABS_API_KEY"]?.trimmingCharacters(in: .whitespacesAndNewlines)

        let parsed = TalkModeGatewayConfigParser.parse(
            snapshot: snap,
            defaultProvider: Self.defaultTalkProvider,
            defaultModelIdFallback: Self.defaultModelIdFallback,
            defaultSilenceTimeoutMs: Self.defaultSilenceTimeoutMs,
            envVoice: envVoice,
            sagVoice: sagVoice,
            envApiKey: envApiKey)
        if parsed.missingResolvedPayload {
            self.ttsLogger.info("talk config ignored: normalized payload missing talk.resolved")
        }
        if parsed.activeProvider == Self.defaultTalkProvider {
            self.ttsLogger.info("talk config provider from talk.resolved")
        } else if parsed.activeProvider == Self.mlxTalkProvider ||
            parsed.activeProvider == Self.systemTalkProvider
        {
            self.ttsLogger.info(
                "talk provider \(parsed.activeProvider, privacy: .public) active")
        } else {
            self.ttsLogger
                .info(
                    """
                    talk provider \(parsed.activeProvider, privacy: .public) uses gateway talk.speak \
                    with system voice fallback
                    """)
        }
        return parsed
    }

    func fetchTalkConfig() async -> TalkModeGatewayConfigState {
        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .talkConfig,
                params: ["includeSecrets": AnyCodable(true)],
                timeoutMs: 8000)
            return self.parseTalkConfig(snap)
        } catch {
            return self.fallbackTalkConfig()
        }
    }

    // MARK: - Config

    func reloadConfig() async {
        let cfg = await fetchTalkConfig()
        await self.applyTalkConfig(cfg)
        self.macOSRealtimeRelayOptIn = await MainActor.run {
            AppStateStore.shared.talkRealtimeRelayEnabled
        }
    }

    func applyTalkConfig(_ cfg: TalkModeGatewayConfigState) async {
        let locale = await MainActor.run {
            AppStateStore.shared.seamColorHex = cfg.seamColorHex
            return AppStateStore.shared.voiceWakeLocaleID
        }
        self.commitTalkConfig(cfg, locale: locale)
    }

    func commitTalkConfig(_ cfg: TalkModeGatewayConfigState, locale: String) {
        self.defaultVoiceId = cfg.voiceId
        self.voiceAliases = cfg.voiceAliases
        if !self.voiceOverrideActive {
            self.currentVoiceId = cfg.voiceId
        }
        self.defaultModelId = cfg.modelId
        if !self.modelOverrideActive {
            self.currentModelId = cfg.modelId
        }
        self.defaultOutputFormat = cfg.outputFormat
        self.interruptOnSpeech = cfg.interruptOnSpeech
        self.activeTalkProvider = cfg.activeProvider
        self.realtimeProvider = cfg.realtimeProvider
        self.realtimeModelId = cfg.realtimeModelId
        self.realtimeSpeakerVoice = cfg.realtimeSpeakerVoice
        self.realtimeMode = cfg.realtimeMode
        self.realtimeTransport = cfg.realtimeTransport
        self.realtimeBrain = cfg.realtimeBrain
        self.hasGatewayRealtimeRelayTuple = cfg.hasGatewayRealtimeRelayTuple
        let configuredSilenceMs = cfg.silenceTimeoutMs
        let isCJKLocale = locale.hasPrefix("ko") || locale.hasPrefix("ja") || locale.hasPrefix("zh")
        let effectiveSilenceMs = isCJKLocale ? max(configuredSilenceMs, 2000) : configuredSilenceMs
        if isCJKLocale, configuredSilenceMs < 2000 {
            self.logger
                .info(
                    "talk CJK locale: silence timeout clamped " +
                        "\(configuredSilenceMs, privacy: .public)ms -> 2000ms")
        }
        self.silenceWindow = TimeInterval(effectiveSilenceMs) / 1000
        self.speechLocaleID = cfg.speechLocaleID
        self.apiKey = cfg.apiKey
        self.mlxReferenceAudioPath = cfg.referenceAudioPath
        self.mlxReferenceText = cfg.referenceText
        let hasApiKey = (cfg.apiKey?.isEmpty == false)
        let voiceLabel = cfg.voiceId.flatMap { $0.isEmpty ? nil : $0 } ?? "none"
        let modelLabel = cfg.modelId.flatMap { $0.isEmpty ? nil : $0 } ?? "none"
        self.logger
            .info(
                "talk config provider=\(cfg.activeProvider, privacy: .public) " +
                    "talk config voiceId=\(voiceLabel, privacy: .public) " +
                    "modelId=\(modelLabel, privacy: .public) " +
                    "referenceAudio=\(cfg.referenceAudioPath != nil, privacy: .public) " +
                    "apiKey=\(hasApiKey, privacy: .public) " +
                    "interrupt=\(cfg.interruptOnSpeech, privacy: .public) " +
                    "silenceTimeoutMs=\(cfg.silenceTimeoutMs, privacy: .public) " +
                    "speechLocale=\(cfg.speechLocaleID ?? "device", privacy: .public) " +
                    "realtimeMode=\(cfg.realtimeMode ?? "off", privacy: .public) " +
                    "realtimeTransport=\(cfg.realtimeTransport ?? "default", privacy: .public) " +
                    "realtimeBrain=\(cfg.realtimeBrain ?? "default", privacy: .public) " +
                    "macOSRealtimeOptIn=\(self.macOSRealtimeRelayOptIn, privacy: .public)")
    }

    static func selectTalkProviderConfig(
        _ talk: [String: AnyCodable]?) -> TalkProviderConfigSelection?
    {
        TalkConfigParsing.selectProviderConfig(talk, defaultProvider: self.defaultTalkProvider)
    }

    static func resolvedSilenceTimeoutMs(_ talk: [String: AnyCodable]?) -> Int {
        TalkConfigParsing.resolvedSilenceTimeoutMs(talk, fallback: self.defaultSilenceTimeoutMs)
    }

    // MARK: - Audio level handling

    private func noteAudioLevel(rms: Double) async {
        if self.phase != .listening, self.phase != .speaking {
            return
        }
        let alpha: Double = rms < self.noiseFloorRMS ? 0.08 : 0.01
        self.noiseFloorRMS = max(1e-7, self.noiseFloorRMS + (rms - self.noiseFloorRMS) * alpha)

        let threshold = max(minSpeechRMS, noiseFloorRMS * self.speechBoostFactor)
        if rms >= threshold {
            let now = Date()
            self.lastHeard = now
            self.lastSpeechEnergyAt = now
        }

        if self.phase == .listening {
            let clamped = min(1.0, max(0.0, rms / max(self.minSpeechRMS, threshold)))
            await MainActor.run { TalkModeController.shared.updateLevel(clamped) }
        }
    }

    private func shouldInterrupt(transcript: String, hasConfidence: Bool) async -> Bool {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return false }
        if self.isLikelyEcho(of: trimmed) {
            return false
        }
        let now = Date()
        if let lastSpeechEnergyAt, now.timeIntervalSince(lastSpeechEnergyAt) > 0.35 {
            return false
        }
        return hasConfidence
    }

    private func isLikelyEcho(of transcript: String) -> Bool {
        guard let spoken = lastSpokenText?.lowercased(), !spoken.isEmpty else { return false }
        let probe = transcript.lowercased()
        if probe.count < 6 {
            return spoken.contains(probe)
        }
        return spoken.contains(probe)
    }
}
