import AVFoundation
import Foundation
import Speech
import SwabbleKit

enum VoiceWakeTestState: Equatable {
    case idle
    case requesting
    case listening
    case hearing(String)
    case finalizing
    case detected(String)
    case failed(String)
}

final class VoiceWakeTester {
    private let recognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var isStopping = false
    private var isFinalizing = false
    private var detectionStart: Date?
    private var lastHeard: Date?
    private var lastLoggedText: String?
    private var lastLoggedAt: Date?
    private var lastTranscript: String?
    private var lastTranscriptAt: Date?
    private var silenceTask: Task<Void, Never>?
    private var currentTriggers: [String] = []
    private var holdingAfterDetect = false
    private var detectedText: String?
    private let logger = Logger(subsystem: "com.clawdbot", category: "voicewake")
    private let silenceWindow: TimeInterval = 1.0

    init(locale: Locale = .current) {
        self.recognizer = SFSpeechRecognizer(locale: locale)
    }

    func start(
        triggers: [String],
        micID: String?,
        localeID: String?,
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void) async throws
    {
        guard self.recognitionTask == nil else { return }
        self.isStopping = false
        self.isFinalizing = false
        self.holdingAfterDetect = false
        self.detectedText = nil
        self.lastHeard = nil
        self.lastLoggedText = nil
        self.lastLoggedAt = nil
        self.lastTranscript = nil
        self.lastTranscriptAt = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.currentTriggers = triggers
        let chosenLocale = localeID.flatMap { Locale(identifier: $0) } ?? Locale.current
        let recognizer = SFSpeechRecognizer(locale: chosenLocale)
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Speech recognition unavailable"])
        }
        recognizer.defaultTaskHint = .dictation

        guard Self.hasPrivacyStrings else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 3,
                userInfo: [
                    NSLocalizedDescriptionKey: """
                    Missing mic/speech privacy strings. Rebuild the mac app (scripts/restart-mac.sh) \
                    to include usage descriptions.
                    """,
                ])
        }

        let granted = try await Self.ensurePermissions()
        guard granted else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Microphone or speech permission denied"])
        }

        self.logInputSelection(preferredMicID: micID)
        self.configureSession(preferredMicID: micID)

        let engine = AVAudioEngine()
        self.audioEngine = engine

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest?.shouldReportPartialResults = true
        self.recognitionRequest?.taskHint = .dictation
        let request = self.recognitionRequest

        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            self.audioEngine = nil
            throw NSError(
                domain: "VoiceWakeTester",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "No audio input available"])
        }
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        engine.prepare()
        try engine.start()
        DispatchQueue.main.async {
            onUpdate(.listening)
        }

        self.detectionStart = Date()
        self.lastHeard = self.detectionStart

        guard let request = recognitionRequest else { return }

        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self, !self.isStopping else { return }
            let text = result?.bestTranscription.formattedString ?? ""
            let segments = result.map { WakeWordSpeechSegments.from(
                transcription: $0.bestTranscription,
                transcript: text) } ?? []
            let isFinal = result?.isFinal ?? false
            let gateConfig = WakeWordGateConfig(triggers: triggers)
            var match = WakeWordGate.match(transcript: text, segments: segments, config: gateConfig)
            if match == nil, isFinal {
                match = self.textOnlyFallbackMatch(
                    transcript: text,
                    triggers: triggers,
                    config: gateConfig)
            }
            self.maybeLogDebug(
                transcript: text,
                segments: segments,
                triggers: triggers,
                match: match,
                isFinal: isFinal)
            let errorMessage = error?.localizedDescription

            Task { [weak self] in
                guard let self, !self.isStopping else { return }
                await self.handleResult(
                    match: match,
                    text: text,
                    isFinal: isFinal,
                    errorMessage: errorMessage,
                    onUpdate: onUpdate)
            }
        }
    }

    func stop() {
        self.stop(force: true)
    }

    func finalize(timeout: TimeInterval = 1.5) {
        guard self.recognitionTask != nil else {
            self.stop(force: true)
            return
        }
        self.isFinalizing = true
        self.recognitionRequest?.endAudio()
        if let engine = self.audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            if !self.isStopping {
                self.stop(force: true)
            }
        }
    }

    private func stop(force: Bool) {
        if force { self.isStopping = true }
        self.isFinalizing = false
        self.recognitionRequest?.endAudio()
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest = nil
        if let engine = self.audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        self.audioEngine = nil
        self.holdingAfterDetect = false
        self.detectedText = nil
        self.lastHeard = nil
        self.detectionStart = nil
        self.lastLoggedText = nil
        self.lastLoggedAt = nil
        self.lastTranscript = nil
        self.lastTranscriptAt = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.currentTriggers = []
    }

    private func handleResult(
        match: WakeWordGateMatch?,
        text: String,
        isFinal: Bool,
        errorMessage: String?,
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void) async
    {
        if !text.isEmpty {
            self.lastHeard = Date()
            self.lastTranscript = text
            self.lastTranscriptAt = Date()
        }
        if self.holdingAfterDetect {
            return
        }
        if let match, !match.command.isEmpty {
            self.holdingAfterDetect = true
            self.detectedText = match.command
            self.logger.info("voice wake detected (test) (len=\(match.command.count))")
            await MainActor.run { AppStateStore.shared.triggerVoiceEars(ttl: nil) }
            self.stop()
            await MainActor.run {
                AppStateStore.shared.stopVoiceEars()
                onUpdate(.detected(match.command))
            }
            return
        }
        if !isFinal, !text.isEmpty {
            self.scheduleSilenceCheck(
                triggers: self.currentTriggers,
                onUpdate: onUpdate)
        }
        if self.isFinalizing {
            Task { @MainActor in onUpdate(.finalizing) }
        }
        if let errorMessage {
            self.stop(force: true)
            Task { @MainActor in onUpdate(.failed(errorMessage)) }
            return
        }
        if isFinal {
            self.stop(force: true)
            let state: VoiceWakeTestState = text.isEmpty
                ? .failed("No speech detected")
                : .failed("No trigger heard: “\(text)”")
            Task { @MainActor in onUpdate(state) }
        } else {
            let state: VoiceWakeTestState = text.isEmpty ? .listening : .hearing(text)
            Task { @MainActor in onUpdate(state) }
        }
    }

    private func maybeLogDebug(
        transcript: String,
        segments: [WakeWordSegment],
        triggers: [String],
        match: WakeWordGateMatch?,
        isFinal: Bool)
    {
        guard !transcript.isEmpty else { return }
        let level = self.logger.logLevel
        guard level == .debug || level == .trace else { return }
        if transcript == self.lastLoggedText, !isFinal {
            if let last = self.lastLoggedAt, Date().timeIntervalSince(last) < 0.25 {
                return
            }
        }
        self.lastLoggedText = transcript
        self.lastLoggedAt = Date()

        let textOnly = WakeWordGate.matchesTextOnly(text: transcript, triggers: triggers)
        let gaps = Self.debugCandidateGaps(triggers: triggers, segments: segments)
        let segmentSummary = Self.debugSegments(segments)
        let timingCount = segments.count(where: { $0.start > 0 || $0.duration > 0 })
        let matchSummary = match.map {
            "match=true gap=\(String(format: "%.2f", $0.postGap))s cmdLen=\($0.command.count)"
        } ?? "match=false"

        self.logger.debug(
            "voicewake test transcript='\(transcript, privacy: .private)' textOnly=\(textOnly) " +
                "isFinal=\(isFinal) timing=\(timingCount)/\(segments.count) " +
                "\(matchSummary) gaps=[\(gaps, privacy: .private)] segments=[\(segmentSummary, privacy: .private)]")
    }

    private static func debugSegments(_ segments: [WakeWordSegment]) -> String {
        segments.map { seg in
            let start = String(format: "%.2f", seg.start)
            let end = String(format: "%.2f", seg.end)
            return "\(seg.text)@\(start)-\(end)"
        }.joined(separator: ", ")
    }

    private static func debugCandidateGaps(triggers: [String], segments: [WakeWordSegment]) -> String {
        let tokens = self.normalizeSegments(segments)
        guard !tokens.isEmpty else { return "" }
        let triggerTokens = self.normalizeTriggers(triggers)
        var gaps: [String] = []

        for trigger in triggerTokens {
            let count = trigger.tokens.count
            guard count > 0, tokens.count > count else { continue }
            for i in 0...(tokens.count - count - 1) {
                let matched = (0..<count).allSatisfy { tokens[i + $0].normalized == trigger.tokens[$0] }
                if !matched { continue }
                let triggerEnd = tokens[i + count - 1].end
                let nextToken = tokens[i + count]
                let gap = nextToken.start - triggerEnd
                let formatted = String(format: "%.2f", gap)
                gaps.append("\(trigger.tokens.joined(separator: " ")):\(formatted)s")
            }
        }
        return gaps.joined(separator: ", ")
    }

    private struct DebugToken {
        let normalized: String
        let start: TimeInterval
        let end: TimeInterval
    }

    private struct DebugTriggerTokens {
        let tokens: [String]
    }

    private static func normalizeTriggers(_ triggers: [String]) -> [DebugTriggerTokens] {
        var output: [DebugTriggerTokens] = []
        for trigger in triggers {
            let tokens = trigger
                .split(whereSeparator: { $0.isWhitespace })
                .map { VoiceWakeTextUtils.normalizeToken(String($0)) }
                .filter { !$0.isEmpty }
            if tokens.isEmpty { continue }
            output.append(DebugTriggerTokens(tokens: tokens))
        }
        return output
    }

    private static func normalizeSegments(_ segments: [WakeWordSegment]) -> [DebugToken] {
        segments.compactMap { segment in
            let normalized = VoiceWakeTextUtils.normalizeToken(segment.text)
            guard !normalized.isEmpty else { return nil }
            return DebugToken(
                normalized: normalized,
                start: segment.start,
                end: segment.end)
        }
    }

    private func textOnlyFallbackMatch(
        transcript: String,
        triggers: [String],
        config: WakeWordGateConfig) -> WakeWordGateMatch?
    {
        guard let command = VoiceWakeTextUtils.textOnlyCommand(
            transcript: transcript,
            triggers: triggers,
            minCommandLength: config.minCommandLength,
            trimWake: { WakeWordGate.stripWake(text: $0, triggers: $1) })
        else { return nil }
        return WakeWordGateMatch(triggerEndTime: 0, postGap: 0, command: command)
    }

    private func holdUntilSilence(onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void) {
        Task { [weak self] in
            guard let self else { return }
            let detectedAt = Date()
            let hardStop = detectedAt.addingTimeInterval(6) // cap overall listen after trigger

            while !self.isStopping {
                let now = Date()
                if now >= hardStop { break }
                if let last = self.lastHeard, now.timeIntervalSince(last) >= silenceWindow {
                    break
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            if !self.isStopping {
                self.stop()
                await MainActor.run { AppStateStore.shared.stopVoiceEars() }
                if let detectedText {
                    self.logger.info("voice wake hold finished; len=\(detectedText.count)")
                    Task { @MainActor in onUpdate(.detected(detectedText)) }
                }
            }
        }
    }

    private func scheduleSilenceCheck(
        triggers: [String],
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void)
    {
        self.silenceTask?.cancel()
        let lastSeenAt = self.lastTranscriptAt
        let lastText = self.lastTranscript
        self.silenceTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(self.silenceWindow * 1_000_000_000))
            guard !Task.isCancelled else { return }
            guard !self.isStopping, !self.holdingAfterDetect else { return }
            guard let lastSeenAt, let lastText else { return }
            guard self.lastTranscriptAt == lastSeenAt, self.lastTranscript == lastText else { return }
            guard let match = self.textOnlyFallbackMatch(
                transcript: lastText,
                triggers: triggers,
                config: WakeWordGateConfig(triggers: triggers)) else { return }
            self.holdingAfterDetect = true
            self.detectedText = match.command
            self.logger.info("voice wake detected (test, silence) (len=\(match.command.count))")
            await MainActor.run { AppStateStore.shared.triggerVoiceEars(ttl: nil) }
            self.stop()
            await MainActor.run {
                AppStateStore.shared.stopVoiceEars()
                onUpdate(.detected(match.command))
            }
        }
    }

    private func configureSession(preferredMicID: String?) {
        _ = preferredMicID
    }

    private func logInputSelection(preferredMicID: String?) {
        let preferred = (preferredMicID?.isEmpty == false) ? preferredMicID! : "system-default"
        self.logger.info(
            "voicewake test input preferred=\(preferred, privacy: .public) " +
                "\(AudioInputDeviceObserver.defaultInputDeviceSummary(), privacy: .public)")
    }

    private nonisolated static func ensurePermissions() async throws -> Bool {
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        if speechStatus == .notDetermined {
            let granted = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
            guard granted else { return false }
        } else if speechStatus != .authorized {
            return false
        }

        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        switch micStatus {
        case .authorized: return true

        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }

        default:
            return false
        }
    }

    private static var hasPrivacyStrings: Bool {
        let speech = Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") as? String
        let mic = Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") as? String
        return speech?.isEmpty == false && mic?.isEmpty == false
    }
}

extension VoiceWakeTester: @unchecked Sendable {}
