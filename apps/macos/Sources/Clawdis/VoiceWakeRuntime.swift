import AVFoundation
import Foundation
import OSLog
import Speech
#if canImport(AppKit)
import AppKit
#endif

/// Background listener that keeps the voice-wake pipeline alive outside the settings test view.
actor VoiceWakeRuntime {
    static let shared = VoiceWakeRuntime()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "voicewake.runtime")

    private var recognizer: SFSpeechRecognizer?
    private var audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var lastHeard: Date?
    private var noiseFloorRMS: Double = 1e-4
    private var captureStartedAt: Date?
    private var captureTask: Task<Void, Never>?
    private var capturedTranscript: String = ""
    private var isCapturing: Bool = false
    private var heardBeyondTrigger: Bool = false
    private var triggerChimePlayed: Bool = false
    private var committedTranscript: String = ""
    private var volatileTranscript: String = ""
    private var cooldownUntil: Date?
    private var currentConfig: RuntimeConfig?

    // Tunables
    // Silence threshold once we've captured user speech (post-trigger).
    private let silenceWindow: TimeInterval = 2.0
    // Silence threshold when we only heard the trigger but no post-trigger speech yet.
    private let triggerOnlySilenceWindow: TimeInterval = 5.0
    // Maximum capture duration from trigger until we force-send, to avoid runaway sessions.
    private let captureHardStop: TimeInterval = 120.0
    private let debounceAfterSend: TimeInterval = 0.35
    // Voice activity detection parameters (RMS-based).
    private let minSpeechRMS: Double = 1e-3
    private let speechBoostFactor: Double = 6.0 // how far above noise floor we require to mark speech

    /// Stops the active Speech pipeline without clearing the stored config, so we can restart cleanly.
    private func haltRecognitionPipeline() {
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()
    }

    struct RuntimeConfig: Equatable {
        let triggers: [String]
        let micID: String?
        let localeID: String?
        let triggerChime: VoiceWakeChime
        let sendChime: VoiceWakeChime
    }

    func refresh(state: AppState) async {
        let snapshot = await MainActor.run { () -> (Bool, RuntimeConfig) in
            let enabled = state.swabbleEnabled
            let config = RuntimeConfig(
                triggers: sanitizeVoiceWakeTriggers(state.swabbleTriggerWords),
                micID: state.voiceWakeMicID.isEmpty ? nil : state.voiceWakeMicID,
                localeID: state.voiceWakeLocaleID.isEmpty ? nil : state.voiceWakeLocaleID,
                triggerChime: state.voiceWakeTriggerChime,
                sendChime: state.voiceWakeSendChime)
            return (enabled, config)
        }

        guard voiceWakeSupported, snapshot.0 else {
            self.stop()
            return
        }

        guard PermissionManager.voiceWakePermissionsGranted() else {
            self.logger.debug("voicewake runtime not starting: permissions missing")
            self.stop()
            return
        }

        let config = snapshot.1

        if config == self.currentConfig, self.recognitionTask != nil {
            return
        }

        self.stop()
        await self.start(with: config)
    }

    private func start(with config: RuntimeConfig) async {
        do {
            self.configureSession(localeID: config.localeID)

            guard let recognizer, recognizer.isAvailable else {
                self.logger.error("voicewake runtime: speech recognizer unavailable")
                return
            }

            self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
            self.recognitionRequest?.shouldReportPartialResults = true
            guard let request = self.recognitionRequest else { return }

            let input = self.audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self, weak request] buffer, _ in
                request?.append(buffer)
                if let rms = Self.rmsLevel(buffer: buffer) {
                    Task { await self?.noteAudioLevel(rms: rms) }
                }
            }

            self.audioEngine.prepare()
            try self.audioEngine.start()

            self.currentConfig = config
            self.lastHeard = Date()
            self.cooldownUntil = nil

            self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self else { return }
                let transcript = result?.bestTranscription.formattedString
                let isFinal = result?.isFinal ?? false
                Task { await self.handleRecognition(transcript: transcript, isFinal: isFinal, error: error, config: config) }
            }

            self.logger.info("voicewake runtime started")
        } catch {
            self.logger.error("voicewake runtime failed to start: \(error.localizedDescription, privacy: .public)")
            self.stop()
        }
    }

    private func stop(dismissOverlay: Bool = true) {
        self.captureTask?.cancel()
        self.captureTask = nil
        self.isCapturing = false
        self.capturedTranscript = ""
        self.captureStartedAt = nil
        self.triggerChimePlayed = false
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()
        self.currentConfig = nil
        self.logger.debug("voicewake runtime stopped")

        guard dismissOverlay else { return }
        Task { @MainActor in
            VoiceWakeOverlayController.shared.dismiss()
        }
    }

    private func configureSession(localeID: String?) {
        let locale = localeID.flatMap { Locale(identifier: $0) } ?? Locale(identifier: Locale.current.identifier)
        self.recognizer = SFSpeechRecognizer(locale: locale)
    }

    private func handleRecognition(
        transcript: String?,
        isFinal: Bool,
        error: Error?,
        config: RuntimeConfig) async
    {
        if let error {
            self.logger.debug("voicewake recognition error: \(error.localizedDescription, privacy: .public)")
        }

        guard let transcript else { return }

        let now = Date()
        if !transcript.isEmpty {
            self.lastHeard = now
            if self.isCapturing {
                let trimmed = Self.trimmedAfterTrigger(transcript, triggers: config.triggers)
                self.capturedTranscript = trimmed
                self.updateHeardBeyondTrigger(withTrimmed: trimmed)
                if isFinal {
                    self.committedTranscript = trimmed
                    self.volatileTranscript = ""
                } else {
                    self.volatileTranscript = Self.delta(after: self.committedTranscript, current: trimmed)
                }

                let attributed = Self.makeAttributed(
                    committed: self.committedTranscript,
                    volatile: self.volatileTranscript,
                    isFinal: isFinal)
                let snapshot = self.committedTranscript + self.volatileTranscript
                await MainActor.run {
                    VoiceWakeOverlayController.shared.showPartial(transcript: snapshot, attributed: attributed)
                }
            }
        }

        if self.isCapturing { return }

        if Self.matches(text: transcript, triggers: config.triggers) {
            if let cooldown = cooldownUntil, now < cooldown {
                return
            }
            await self.beginCapture(transcript: transcript, config: config)
        }
    }

    private static func matches(text: String, triggers: [String]) -> Bool {
        guard !text.isEmpty else { return false }
        let normalized = text.lowercased()
        for trigger in triggers {
            let t = trigger.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { continue }
            if normalized.contains(t) { return true }
        }
        return false
    }

    private func beginCapture(transcript: String, config: RuntimeConfig) async {
        self.isCapturing = true
        let trimmed = Self.trimmedAfterTrigger(transcript, triggers: config.triggers)
        self.capturedTranscript = trimmed
        self.committedTranscript = ""
        self.volatileTranscript = trimmed
        self.captureStartedAt = Date()
        self.cooldownUntil = nil
        self.heardBeyondTrigger = !trimmed.isEmpty
        self.triggerChimePlayed = false

        if config.triggerChime != .none {
            self.triggerChimePlayed = true
            await MainActor.run { VoiceWakeChimePlayer.play(config.triggerChime) }
        }

        let snapshot = self.committedTranscript + self.volatileTranscript
        let attributed = Self.makeAttributed(
            committed: self.committedTranscript,
            volatile: self.volatileTranscript,
            isFinal: false)
        await MainActor.run {
            VoiceWakeOverlayController.shared.showPartial(transcript: snapshot, attributed: attributed)
        }

        await MainActor.run { AppStateStore.shared.triggerVoiceEars(ttl: nil) }

        self.captureTask?.cancel()
        self.captureTask = Task { [weak self] in
            guard let self else { return }
            await self.monitorCapture(config: config)
        }
    }

    private func monitorCapture(config: RuntimeConfig) async {
        let start = self.captureStartedAt ?? Date()
        let hardStop = start.addingTimeInterval(self.captureHardStop)

        while self.isCapturing {
            let now = Date()
            if now >= hardStop {
                await self.finalizeCapture(config: config)
                return
            }

            let silenceThreshold = self.heardBeyondTrigger ? self.silenceWindow : self.triggerOnlySilenceWindow
            if let last = self.lastHeard, now.timeIntervalSince(last) >= silenceThreshold {
                await self.finalizeCapture(config: config)
                return
            }

            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    private func finalizeCapture(config: RuntimeConfig) async {
        guard self.isCapturing else { return }
        self.isCapturing = false
        self.captureTask?.cancel()
        self.captureTask = nil

        let finalTranscript = self.capturedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        // Stop further recognition events so we don't retrigger immediately with buffered audio.
        self.haltRecognitionPipeline()
        self.capturedTranscript = ""
        self.captureStartedAt = nil
        self.lastHeard = nil
        self.heardBeyondTrigger = false
        self.triggerChimePlayed = false

        await MainActor.run { AppStateStore.shared.stopVoiceEars() }

        let forwardConfig = await MainActor.run { AppStateStore.shared.voiceWakeForwardConfig }
        // Auto-send should fire as soon as the silence threshold is satisfied (2s after speech, 5s after trigger-only).
        // Keep the overlay visible during capture; once we finalize, we dispatch immediately.
        let delay: TimeInterval = 0.0
        let finalAttributed = Self.makeAttributed(
            committed: finalTranscript,
            volatile: "",
            isFinal: true)
        let sendChime = finalTranscript.isEmpty ? .none : config.sendChime
        await MainActor.run {
            VoiceWakeOverlayController.shared.presentFinal(
                transcript: finalTranscript,
                forwardConfig: forwardConfig,
                delay: delay,
                sendChime: sendChime,
                attributed: finalAttributed)
        }

        self.cooldownUntil = Date().addingTimeInterval(self.debounceAfterSend)
        self.restartRecognizer()
    }

    private func restartRecognizer() {
        // Restart the recognizer so we listen for the next trigger with a clean buffer.
        let current = self.currentConfig
        self.stop(dismissOverlay: false)
        if let current {
            Task { await self.start(with: current) }
        }
    }

    func pauseForPushToTalk() {
        self.stop()
    }

    private func updateHeardBeyondTrigger(withTrimmed trimmed: String) {
        if !self.heardBeyondTrigger, !trimmed.isEmpty {
            self.heardBeyondTrigger = true
        }
    }

    private static func trimmedAfterTrigger(_ text: String, triggers: [String]) -> String {
        let lower = text.lowercased()
        for trigger in triggers {
            let token = trigger.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !token.isEmpty, let range = lower.range(of: token) else { continue }
            let after = range.upperBound
            let trimmed = text[after...].trimmingCharacters(in: .whitespacesAndNewlines)
            return String(trimmed)
        }
        return text
    }

    #if DEBUG
    static func _testTrimmedAfterTrigger(_ text: String, triggers: [String]) -> String {
        self.trimmedAfterTrigger(text, triggers: triggers)
    }

    static func _testHasContentAfterTrigger(_ text: String, triggers: [String]) -> Bool {
        !self.trimmedAfterTrigger(text, triggers: triggers).isEmpty
    }

    static func _testAttributedColor(isFinal: Bool) -> NSColor {
        self.makeAttributed(committed: "sample", volatile: "", isFinal: isFinal)
            .attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor ?? .clear
    }

    static func _testMatches(text: String, triggers: [String]) -> Bool {
        self.matches(text: text, triggers: triggers)
    }
    #endif

    private static func delta(after committed: String, current: String) -> String {
        if current.hasPrefix(committed) {
            let start = current.index(current.startIndex, offsetBy: committed.count)
            return String(current[start...])
        }
        return current
    }

    private static func makeAttributed(committed: String, volatile: String, isFinal: Bool) -> NSAttributedString {
        let full = NSMutableAttributedString()
        let committedAttr: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.labelColor,
            .font: NSFont.systemFont(ofSize: 13, weight: .regular),
        ]
        full.append(NSAttributedString(string: committed, attributes: committedAttr))
        let volatileColor: NSColor = isFinal ? .labelColor : NSColor.tertiaryLabelColor
        let volatileAttr: [NSAttributedString.Key: Any] = [
            .foregroundColor: volatileColor,
            .font: NSFont.systemFont(ofSize: 13, weight: .regular),
        ]
        full.append(NSAttributedString(string: volatile, attributes: volatileAttr))
        return full
    }
}
