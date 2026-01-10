import AVFAudio
import ClawdbotKit
import Foundation
import Observation
import OSLog
import Speech

@MainActor
@Observable
final class TalkModeManager: NSObject {
    private typealias SpeechRequest = SFSpeechAudioBufferRecognitionRequest
    private static let defaultModelIdFallback = "eleven_v3"
    var isEnabled: Bool = false
    var isListening: Bool = false
    var isSpeaking: Bool = false
    var statusText: String = "Off"

    private let audioEngine = AVAudioEngine()
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var silenceTask: Task<Void, Never>?

    private var lastHeard: Date?
    private var lastTranscript: String = ""
    private var lastSpokenText: String?
    private var lastInterruptedAtSeconds: Double?

    private var defaultVoiceId: String?
    private var currentVoiceId: String?
    private var defaultModelId: String?
    private var currentModelId: String?
    private var voiceOverrideActive = false
    private var modelOverrideActive = false
    private var defaultOutputFormat: String?
    private var apiKey: String?
    private var voiceAliases: [String: String] = [:]
    private var interruptOnSpeech: Bool = true
    private var mainSessionKey: String = "main"
    private var fallbackVoiceId: String?
    private var lastPlaybackWasPCM: Bool = false
    var pcmPlayer: PCMStreamingAudioPlaying = PCMStreamingAudioPlayer.shared
    var mp3Player: StreamingAudioPlaying = StreamingAudioPlayer.shared

    private var bridge: BridgeSession?
    private let silenceWindow: TimeInterval = 0.7

    private var chatSubscribedSessionKeys = Set<String>()

    private let logger = Logger(subsystem: "com.clawdbot", category: "TalkMode")

    func attachBridge(_ bridge: BridgeSession) {
        self.bridge = bridge
    }

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        if enabled {
            self.logger.info("enabled")
            Task { await self.start() }
        } else {
            self.logger.info("disabled")
            self.stop()
        }
    }

    func start() async {
        guard self.isEnabled else { return }
        if self.isListening { return }

        self.logger.info("start")
        self.statusText = "Requesting permissions…"
        let micOk = await Self.requestMicrophonePermission()
        guard micOk else {
            self.logger.warning("start blocked: microphone permission denied")
            self.statusText = "Microphone permission denied"
            return
        }
        let speechOk = await Self.requestSpeechPermission()
        guard speechOk else {
            self.logger.warning("start blocked: speech permission denied")
            self.statusText = "Speech recognition permission denied"
            return
        }

        await self.reloadConfig()
        do {
            try Self.configureAudioSession()
            try self.startRecognition()
            self.isListening = true
            self.statusText = "Listening"
            self.startSilenceMonitor()
            await self.subscribeChatIfNeeded(sessionKey: self.mainSessionKey)
            self.logger.info("listening")
        } catch {
            self.isListening = false
            self.statusText = "Start failed: \(error.localizedDescription)"
            self.logger.error("start failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func stop() {
        self.isEnabled = false
        self.isListening = false
        self.statusText = "Off"
        self.lastTranscript = ""
        self.lastHeard = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
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
    }

    func userTappedOrb() {
        self.stopSpeaking()
    }

    private func startRecognition() throws {
        self.stopRecognition()
        self.speechRecognizer = SFSpeechRecognizer()
        guard let recognizer = self.speechRecognizer else {
            throw NSError(domain: "TalkMode", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Speech recognizer unavailable",
            ])
        }

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest?.shouldReportPartialResults = true
        guard let request = self.recognitionRequest else { return }

        let input = self.audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        let tapBlock = Self.makeAudioTapAppendCallback(request: request)
        input.installTap(onBus: 0, bufferSize: 2048, format: format, block: tapBlock)

        self.audioEngine.prepare()
        try self.audioEngine.start()

        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let error {
                if !self.isSpeaking {
                    self.statusText = "Speech error: \(error.localizedDescription)"
                }
                self.logger.debug("speech recognition error: \(error.localizedDescription, privacy: .public)")
            }
            guard let result else { return }
            let transcript = result.bestTranscription.formattedString
            Task { @MainActor in
                await self.handleTranscript(transcript: transcript, isFinal: result.isFinal)
            }
        }
    }

    private func stopRecognition() {
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()
        self.speechRecognizer = nil
    }

    private nonisolated static func makeAudioTapAppendCallback(request: SpeechRequest) -> AVAudioNodeTapBlock {
        { buffer, _ in
            request.append(buffer)
        }
    }

    private func handleTranscript(transcript: String, isFinal: Bool) async {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if self.isSpeaking, self.interruptOnSpeech {
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
        }
    }

    private func startSilenceMonitor() {
        self.silenceTask?.cancel()
        self.silenceTask = Task { [weak self] in
            guard let self else { return }
            while self.isEnabled {
                try? await Task.sleep(nanoseconds: 200_000_000)
                await self.checkSilence()
            }
        }
    }

    private func checkSilence() async {
        guard self.isListening, !self.isSpeaking else { return }
        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }
        guard let lastHeard else { return }
        if Date().timeIntervalSince(lastHeard) < self.silenceWindow { return }
        await self.finalizeTranscript(transcript)
    }

    private func finalizeTranscript(_ transcript: String) async {
        self.isListening = false
        self.statusText = "Thinking…"
        self.lastTranscript = ""
        self.lastHeard = nil
        self.stopRecognition()

        await self.reloadConfig()
        let prompt = self.buildPrompt(transcript: transcript)
        guard let bridge else {
            self.statusText = "Bridge not connected"
            self.logger.warning("finalize: bridge not connected")
            await self.start()
            return
        }

        do {
            let startedAt = Date().timeIntervalSince1970
            let sessionKey = self.mainSessionKey
            await self.subscribeChatIfNeeded(sessionKey: sessionKey)
            self.logger.info(
                "chat.send start sessionKey=\(sessionKey, privacy: .public) chars=\(prompt.count, privacy: .public)")
            let runId = try await self.sendChat(prompt, bridge: bridge)
            self.logger.info("chat.send ok runId=\(runId, privacy: .public)")
            let completion = await self.waitForChatCompletion(runId: runId, bridge: bridge, timeoutSeconds: 120)
            if completion == .timeout {
                self.logger.warning(
                    "chat completion timeout runId=\(runId, privacy: .public); attempting history fallback")
            } else if completion == .aborted {
                self.statusText = "Aborted"
                self.logger.warning("chat completion aborted runId=\(runId, privacy: .public)")
                await self.start()
                return
            } else if completion == .error {
                self.statusText = "Chat error"
                self.logger.warning("chat completion error runId=\(runId, privacy: .public)")
                await self.start()
                return
            }

            guard let assistantText = try await self.waitForAssistantText(
                bridge: bridge,
                since: startedAt,
                timeoutSeconds: completion == .final ? 12 : 25)
            else {
                self.statusText = "No reply"
                self.logger.warning("assistant text timeout runId=\(runId, privacy: .public)")
                await self.start()
                return
            }
            self.logger.info("assistant text ok chars=\(assistantText.count, privacy: .public)")
            await self.playAssistant(text: assistantText)
        } catch {
            self.statusText = "Talk failed: \(error.localizedDescription)"
            self.logger.error("finalize failed: \(error.localizedDescription, privacy: .public)")
        }

        await self.start()
    }

    private func subscribeChatIfNeeded(sessionKey: String) async {
        let key = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        guard let bridge else { return }
        guard !self.chatSubscribedSessionKeys.contains(key) else { return }

        do {
            let payload = "{\"sessionKey\":\"\(key)\"}"
            try await bridge.sendEvent(event: "chat.subscribe", payloadJSON: payload)
            self.chatSubscribedSessionKeys.insert(key)
            self.logger.info("chat.subscribe ok sessionKey=\(key, privacy: .public)")
        } catch {
            let err = error.localizedDescription
            self.logger.warning("chat.subscribe failed key=\(key, privacy: .public) err=\(err, privacy: .public)")
        }
    }

    private func unsubscribeAllChats() async {
        guard let bridge else { return }
        let keys = self.chatSubscribedSessionKeys
        self.chatSubscribedSessionKeys.removeAll()
        for key in keys {
            do {
                let payload = "{\"sessionKey\":\"\(key)\"}"
                try await bridge.sendEvent(event: "chat.unsubscribe", payloadJSON: payload)
            } catch {
                // ignore
            }
        }
    }

    private func buildPrompt(transcript: String) -> String {
        let interrupted = self.lastInterruptedAtSeconds
        self.lastInterruptedAtSeconds = nil
        return TalkPromptBuilder.build(transcript: transcript, interruptedAtSeconds: interrupted)
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

    private func sendChat(_ message: String, bridge: BridgeSession) async throws -> String {
        struct SendResponse: Decodable { let runId: String }
        let payload: [String: Any] = [
            "sessionKey": self.mainSessionKey,
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
        let res = try await bridge.request(method: "chat.send", paramsJSON: json, timeoutSeconds: 30)
        let decoded = try JSONDecoder().decode(SendResponse.self, from: res)
        return decoded.runId
    }

    private func waitForChatCompletion(
        runId: String,
        bridge: BridgeSession,
        timeoutSeconds: Int = 120) async -> ChatCompletionState
    {
        let stream = await bridge.subscribeServerEvents(bufferingNewest: 200)
        return await withTaskGroup(of: ChatCompletionState.self) { group in
            group.addTask { [runId] in
                for await evt in stream {
                    if Task.isCancelled { return .timeout }
                    guard evt.event == "chat", let payload = evt.payloadJSON else { continue }
                    guard let data = payload.data(using: .utf8) else { continue }
                    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                    if (json["runId"] as? String) != runId { continue }
                    if let state = json["state"] as? String {
                        switch state {
                        case "final": return .final
                        case "aborted": return .aborted
                        case "error": return .error
                        default: break
                        }
                    }
                }
                return .timeout
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                return .timeout
            }
            let result = await group.next() ?? .timeout
            group.cancelAll()
            return result
        }
    }

    private func waitForAssistantText(
        bridge: BridgeSession,
        since: Double,
        timeoutSeconds: Int) async throws -> String?
    {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
        while Date() < deadline {
            if let text = try await self.fetchLatestAssistantText(bridge: bridge, since: since) {
                return text
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return nil
    }

    private func fetchLatestAssistantText(bridge: BridgeSession, since: Double? = nil) async throws -> String? {
        let res = try await bridge.request(
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

        let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedVoice = self.resolveVoiceAlias(requestedVoice)
        if requestedVoice?.isEmpty == false, resolvedVoice == nil {
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

        self.statusText = "Generating voice…"
        self.isSpeaking = true
        self.lastSpokenText = cleaned

        do {
            let started = Date()
            let language = ElevenLabsTTSClient.validatedLanguage(directive?.language)

            let resolvedKey =
                (self.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? self.apiKey : nil) ??
                ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"]
            let apiKey = resolvedKey?.trimmingCharacters(in: .whitespacesAndNewlines)
            let preferredVoice = resolvedVoice ?? self.currentVoiceId ?? self.defaultVoiceId
            let voiceId: String? = if let apiKey, !apiKey.isEmpty {
                await self.resolveVoiceId(preferred: preferredVoice, apiKey: apiKey)
            } else {
                nil
            }
            let canUseElevenLabs = (voiceId?.isEmpty == false) && (apiKey?.isEmpty == false)

            if canUseElevenLabs, let voiceId, let apiKey {
                let desiredOutputFormat = (directive?.outputFormat ?? self.defaultOutputFormat)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let requestedOutputFormat = (desiredOutputFormat?.isEmpty == false) ? desiredOutputFormat : nil
                let outputFormat = ElevenLabsTTSClient.validatedOutputFormat(requestedOutputFormat ?? "pcm_44100")
                if outputFormat == nil, let requestedOutputFormat {
                    self.logger.warning(
                        "talk output_format unsupported for local playback: \(requestedOutputFormat, privacy: .public)")
                }

                let modelId = directive?.modelId ?? self.currentModelId ?? self.defaultModelId
                func makeRequest(outputFormat: String?) -> ElevenLabsTTSRequest {
                    ElevenLabsTTSRequest(
                        text: cleaned,
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

                let request = makeRequest(outputFormat: outputFormat)

                let client = ElevenLabsTTSClient(apiKey: apiKey)
                let stream = client.streamSynthesize(voiceId: voiceId, request: request)

                if self.interruptOnSpeech {
                    do {
                        try self.startRecognition()
                    } catch {
                        self.logger.warning(
                            "startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
                    }
                }

                self.statusText = "Speaking…"
                let sampleRate = TalkTTSValidation.pcmSampleRate(from: outputFormat)
                let result: StreamingPlaybackResult
                if let sampleRate {
                    self.lastPlaybackWasPCM = true
                    var playback = await self.pcmPlayer.play(stream: stream, sampleRate: sampleRate)
                    if !playback.finished, playback.interruptedAt == nil {
                        let mp3Format = ElevenLabsTTSClient.validatedOutputFormat("mp3_44100")
                        self.logger.warning("pcm playback failed; retrying mp3")
                        self.lastPlaybackWasPCM = false
                        let mp3Stream = client.streamSynthesize(
                            voiceId: voiceId,
                            request: makeRequest(outputFormat: mp3Format))
                        playback = await self.mp3Player.play(stream: mp3Stream)
                    }
                    result = playback
                } else {
                    self.lastPlaybackWasPCM = false
                    result = await self.mp3Player.play(stream: stream)
                }
                let duration = Date().timeIntervalSince(started)
                self.logger.info("elevenlabs stream finished=\(result.finished, privacy: .public) dur=\(duration, privacy: .public)s")
                if !result.finished, let interruptedAt = result.interruptedAt {
                    self.lastInterruptedAtSeconds = interruptedAt
                }
            } else {
                self.logger.warning("tts unavailable; falling back to system voice (missing key or voiceId)")
                if self.interruptOnSpeech {
                    do {
                        try self.startRecognition()
                    } catch {
                        self.logger.warning(
                            "startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
                    }
                }
                self.statusText = "Speaking (System)…"
                try await TalkSystemSpeechSynthesizer.shared.speak(text: cleaned, language: language)
            }
        } catch {
            self.logger.error(
                "tts failed: \(error.localizedDescription, privacy: .public); falling back to system voice")
            do {
                if self.interruptOnSpeech {
                    do {
                        try self.startRecognition()
                    } catch {
                        self.logger.warning(
                            "startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
                    }
                }
                self.statusText = "Speaking (System)…"
                let language = ElevenLabsTTSClient.validatedLanguage(directive?.language)
                try await TalkSystemSpeechSynthesizer.shared.speak(text: cleaned, language: language)
            } catch {
                self.statusText = "Speak failed: \(error.localizedDescription)"
                self.logger.error("system voice failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        self.stopRecognition()
        self.isSpeaking = false
    }

    private func stopSpeaking(storeInterruption: Bool = true) {
        guard self.isSpeaking else { return }
        let interruptedAt = self.lastPlaybackWasPCM
            ? self.pcmPlayer.stop()
            : self.mp3Player.stop()
        if storeInterruption {
            self.lastInterruptedAtSeconds = interruptedAt
        }
        _ = self.lastPlaybackWasPCM
            ? self.mp3Player.stop()
            : self.pcmPlayer.stop()
        TalkSystemSpeechSynthesizer.shared.stop()
        self.isSpeaking = false
    }

    private func shouldInterrupt(with transcript: String) -> Bool {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return false }
        if let spoken = self.lastSpokenText?.lowercased(), spoken.contains(trimmed.lowercased()) {
            return false
        }
        return true
    }

    private func resolveVoiceAlias(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.lowercased()
        if let mapped = self.voiceAliases[normalized] { return mapped }
        if self.voiceAliases.values.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            return trimmed
        }
        return Self.isLikelyVoiceId(trimmed) ? trimmed : nil
    }

    private func resolveVoiceId(preferred: String?, apiKey: String) async -> String? {
        let trimmed = preferred?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            if let resolved = self.resolveVoiceAlias(trimmed) { return resolved }
            self.logger.warning("unknown voice alias \(trimmed, privacy: .public)")
        }
        if let fallbackVoiceId { return fallbackVoiceId }

        do {
            let voices = try await ElevenLabsTTSClient(apiKey: apiKey).listVoices()
            guard let first = voices.first else {
                self.logger.warning("elevenlabs voices list empty")
                return nil
            }
            self.fallbackVoiceId = first.voiceId
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

    private static func isLikelyVoiceId(_ value: String) -> Bool {
        guard value.count >= 10 else { return false }
        return value.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    private func reloadConfig() async {
        guard let bridge else { return }
        do {
            let res = try await bridge.request(method: "config.get", paramsJSON: "{}", timeoutSeconds: 8)
            guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return }
            guard let config = json["config"] as? [String: Any] else { return }
            let talk = config["talk"] as? [String: Any]
            let session = config["session"] as? [String: Any]
            self.mainSessionKey = SessionKey.normalizeMainKey(session?["mainKey"] as? String)
            self.defaultVoiceId = (talk?["voiceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let aliases = talk?["voiceAliases"] as? [String: Any] {
                var resolved: [String: String] = [:]
                for (key, value) in aliases {
                    guard let id = value as? String else { continue }
                    let normalizedKey = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    let trimmedId = id.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !normalizedKey.isEmpty, !trimmedId.isEmpty else { continue }
                    resolved[normalizedKey] = trimmedId
                }
                self.voiceAliases = resolved
            } else {
                self.voiceAliases = [:]
            }
            if !self.voiceOverrideActive {
                self.currentVoiceId = self.defaultVoiceId
            }
            let model = (talk?["modelId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            self.defaultModelId = (model?.isEmpty == false) ? model : Self.defaultModelIdFallback
            if !self.modelOverrideActive {
                self.currentModelId = self.defaultModelId
            }
            self.defaultOutputFormat = (talk?["outputFormat"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self.apiKey = (talk?["apiKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let interrupt = talk?["interruptOnSpeech"] as? Bool {
                self.interruptOnSpeech = interrupt
            }
        } catch {
            self.defaultModelId = Self.defaultModelIdFallback
            if !self.modelOverrideActive {
                self.currentModelId = self.defaultModelId
            }
        }
    }

    private static func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [
            .duckOthers,
            .mixWithOthers,
            .allowBluetoothHFP,
            .defaultToSpeaker,
        ])
        try session.setActive(true, options: [])
    }

    private nonisolated static func requestMicrophonePermission() async -> Bool {
        await withCheckedContinuation(isolation: nil) { cont in
            AVAudioApplication.requestRecordPermission { ok in
                cont.resume(returning: ok)
            }
        }
    }

    private nonisolated static func requestSpeechPermission() async -> Bool {
        await withCheckedContinuation(isolation: nil) { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status == .authorized)
            }
        }
    }
}
