import AVFoundation
import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
private final class RecordingGatewaySpeechSynthesizer: TalkGatewaySpeechSynthesizing {
    let audio: TalkGatewaySpeechAudio
    private(set) var requests: [TalkGatewaySpeechRequest] = []

    init(audio: TalkGatewaySpeechAudio) {
        self.audio = audio
    }

    func synthesize(_ request: TalkGatewaySpeechRequest) async throws -> TalkGatewaySpeechAudio {
        self.requests.append(request)
        return self.audio
    }
}

@MainActor
private final class SuspendedGatewaySpeechSynthesizer: TalkGatewaySpeechSynthesizing {
    private var continuation: CheckedContinuation<TalkGatewaySpeechAudio, Never>?

    var hasPendingRequest: Bool {
        self.continuation != nil
    }

    func synthesize(_: TalkGatewaySpeechRequest) async throws -> TalkGatewaySpeechAudio {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func complete() {
        self.continuation?.resume(returning: TalkGatewaySpeechAudio(
            data: Data([1, 2, 3]),
            provider: "xiaomi",
            outputFormat: "mp3"))
        self.continuation = nil
    }
}

@MainActor
private final class RecordingBufferedAudioPlayer: TalkBufferedAudioPlaying {
    private(set) var payloads: [Data] = []

    func play(data: Data) async -> StreamingPlaybackResult {
        self.payloads.append(data)
        return StreamingPlaybackResult(finished: true, interruptedAt: nil)
    }

    func stop() -> Double? {
        nil
    }
}

@MainActor
private final class InterruptibleBufferedAudioPlayer: TalkBufferedAudioPlaying {
    private var continuation: CheckedContinuation<StreamingPlaybackResult, Never>?

    var isPlaying: Bool {
        self.continuation != nil
    }

    func play(data _: Data) async -> StreamingPlaybackResult {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func stop() -> Double? {
        self.continuation?.resume(returning: StreamingPlaybackResult(
            finished: false,
            interruptedAt: 0))
        self.continuation = nil
        return 0
    }
}

@MainActor
struct TalkGatewaySpeechClientTests {
    @Test func `forwards talk directives and decodes audio`() async throws {
        let expectedAudio = Data([1, 2, 3])
        var requestedMethod: String?
        var requestedParams: TalkSpeakParams?
        var requestedTimeout: Int?
        let client = TalkGatewaySpeechClient { method, paramsJSON, timeoutSeconds in
            requestedMethod = method
            requestedTimeout = timeoutSeconds
            requestedParams = try JSONDecoder().decode(
                TalkSpeakParams.self,
                from: Data((paramsJSON ?? "").utf8))
            return try JSONEncoder().encode(TalkSpeakResult(
                audiobase64: expectedAudio.base64EncodedString(),
                provider: "xiaomi",
                outputformat: "mp3",
                voicecompatible: false,
                mimetype: "audio/mpeg",
                fileextension: ".mp3"))
        }
        let directive = TalkDirective(
            voiceId: "mimo_default",
            modelId: "mimo-v2.5-tts",
            speed: 1.1,
            language: "zh-CN",
            outputFormat: "mp3")

        let audio = try await client.synthesize(TalkGatewaySpeechRequest(
            text: "hello",
            voiceId: "resolved-voice",
            modelId: "resolved-model",
            outputFormat: "mp3",
            directive: directive))

        #expect(requestedMethod == "talk.speak")
        #expect(requestedTimeout == 125)
        #expect(requestedParams?.text == "hello")
        #expect(requestedParams?.voiceid == "resolved-voice")
        #expect(requestedParams?.modelid == "resolved-model")
        #expect(requestedParams?.speed == 1.1)
        #expect(requestedParams?.language == "zh-CN")
        #expect(requestedParams?.outputformat == "mp3")
        #expect(audio.data == expectedAudio)
        #expect(audio.provider == "xiaomi")
        #expect(audio.playbackMode == .buffered)
    }

    @Test func `resolves gateway audio playback metadata`() {
        let pcm = TalkGatewaySpeechAudio(
            data: Data([0, 1]),
            provider: "elevenlabs",
            outputFormat: "pcm_24000")
        let mimeOnlyMP3 = TalkGatewaySpeechAudio(
            data: Data([0, 1]),
            provider: "xiaomi",
            outputFormat: nil)
        let wav = TalkGatewaySpeechAudio(
            data: Data([0, 1]),
            provider: "xiaomi",
            outputFormat: "wav")
        let rawPCM = TalkGatewaySpeechAudio(
            data: Data([0, 1]),
            provider: "xai",
            outputFormat: "pcm")
        let microsoftRawPCM = TalkGatewaySpeechAudio(
            data: Data([0, 1]),
            provider: "microsoft",
            outputFormat: "raw-24khz-16bit-mono-pcm")
        let rawULaw = TalkGatewaySpeechAudio(
            data: Data([0, 1]),
            provider: "microsoft",
            outputFormat: "ulaw_8000")
        let microsoftRIFF = TalkGatewaySpeechAudio(
            data: Data([0, 1]),
            provider: "microsoft",
            outputFormat: "riff-24khz-16bit-mono-pcm")

        #expect(pcm.playbackMode == .pcm(sampleRate: 24000))
        #expect(mimeOnlyMP3.playbackMode == .buffered)
        #expect(wav.playbackMode == .buffered)
        #expect(rawPCM.playbackMode == .unsupportedRaw(codec: "pcm"))
        #expect(microsoftRawPCM.playbackMode == .unsupportedRaw(codec: "raw-24khz-16bit-mono-pcm"))
        #expect(rawULaw.playbackMode == .unsupportedRaw(codec: "ulaw_8000"))
        #expect(microsoftRIFF.playbackMode == .buffered)
    }

    @Test func `gateway speech provider stays native and uses talk speak`() async {
        let parsed = Self.parseSpeechProvider("xiaomi")
        let routing = TalkModeRoutingResolver.resolve(
            parsed: parsed,
            providerSelection: .gatewayDefault,
            defaultProvider: "elevenlabs",
            defaultRealtimeModelId: "gpt-realtime-2")
        #expect(routing.activeProvider == "xiaomi")
        #expect(routing.executionMode == .native)
        #expect(routing.route == .gatewayTalkSpeak)

        let expectedAudio = Data([4, 5, 6])
        let synthesizer = RecordingGatewaySpeechSynthesizer(audio: TalkGatewaySpeechAudio(
            data: expectedAudio,
            provider: "xiaomi",
            outputFormat: "mp3"))
        let audioPlayer = RecordingBufferedAudioPlayer()
        let manager = TalkModeManager(
            allowSimulatorCapture: true,
            gatewaySpeechSynthesizer: synthesizer)
        manager.bufferedPlayer = audioPlayer
        manager._test_applyLoadedTalkConfig(parsed, providerSelection: .gatewayDefault)

        #expect(manager._test_runtimeRoute() == .gatewayTalkSpeak)
        #expect(manager._test_executionMode() == .native)
        #expect(!manager.gatewayTalkUsesRealtime)
        #expect(manager.gatewayTalkTransportLabel == "Native")

        await manager._test_playAssistant(text: "Gateway voice")

        #expect(synthesizer.requests.map(\.text) == ["Gateway voice"])
        #expect(audioPlayer.payloads == [expectedAudio])
    }

    @Test func `persisted voice and model overrides reach later gateway requests`() async {
        let parsed = Self.parseSpeechProvider("xiaomi")
        let synthesizer = RecordingGatewaySpeechSynthesizer(audio: TalkGatewaySpeechAudio(
            data: Data([4, 5, 6]),
            provider: "xiaomi",
            outputFormat: "mp3"))
        let manager = TalkModeManager(
            allowSimulatorCapture: true,
            gatewaySpeechSynthesizer: synthesizer)
        manager.bufferedPlayer = RecordingBufferedAudioPlayer()
        manager._test_applyLoadedTalkConfig(parsed, providerSelection: .gatewayDefault)

        await manager._test_playAssistant(text: "{\"voice\":\"alloy\",\"model\":\"expressive\"}\nFirst")
        await manager._test_playAssistant(text: "Second")

        #expect(synthesizer.requests.count == 2)
        #expect(synthesizer.requests[1].voiceId == "alloy")
        #expect(synthesizer.requests[1].modelId == "expressive")
    }

    @Test func `omitted gateway model does not send eleven labs fallback`() async {
        let parsed = Self.parseSpeechProvider("openai", model: nil)
        let synthesizer = RecordingGatewaySpeechSynthesizer(audio: TalkGatewaySpeechAudio(
            data: Data([4, 5, 6]),
            provider: "openai",
            outputFormat: "mp3"))
        let manager = TalkModeManager(
            allowSimulatorCapture: true,
            gatewaySpeechSynthesizer: synthesizer)
        manager.bufferedPlayer = RecordingBufferedAudioPlayer()
        manager._test_applyLoadedTalkConfig(parsed, providerSelection: .gatewayDefault)

        await manager._test_playAssistant(text: "No model override")

        #expect(synthesizer.requests.count == 1)
        #expect(synthesizer.requests[0].modelId == nil)
        #expect(manager.gatewayTalkDefaultModelId == nil)
    }

    @Test func `stopped talk does not play completed gateway synthesis`() async {
        let parsed = Self.parseSpeechProvider("xiaomi")
        let synthesizer = SuspendedGatewaySpeechSynthesizer()
        let audioPlayer = RecordingBufferedAudioPlayer()
        let manager = TalkModeManager(
            allowSimulatorCapture: true,
            gatewaySpeechSynthesizer: synthesizer)
        manager.bufferedPlayer = audioPlayer
        manager._test_applyLoadedTalkConfig(parsed, providerSelection: .gatewayDefault)

        let playback = Task { await manager._test_playAssistant(text: "Delayed voice") }
        while !synthesizer.hasPendingRequest {
            await Task.yield()
        }
        manager.stop()
        synthesizer.complete()
        await playback.value

        #expect(audioPlayer.payloads.isEmpty)
    }

    @Test func `stale buffered player callback does not finish replacement`() async throws {
        let player = TalkBufferedAudioPlayer()
        let wav = makeWav16Mono(sampleRate: 8000, samples: 8000)
        let stalePlayer = try AVAudioPlayer(data: wav)
        let stopAfterStaleCallback = Task { @MainActor in
            player.audioPlayerDidFinishPlaying(stalePlayer, successfully: true)
            return player.stop()
        }

        let result = await player.play(data: wav)
        let interruptedAt = await stopAfterStaleCallback.value

        #expect(interruptedAt != nil)
        #expect(!result.finished)
    }

    @Test func `interrupted gateway playback stops speech recognition`() async {
        let parsed = Self.parseSpeechProvider("xiaomi", interruptOnSpeech: true)
        let synthesizer = RecordingGatewaySpeechSynthesizer(audio: TalkGatewaySpeechAudio(
            data: Data([4, 5, 6]),
            provider: "xiaomi",
            outputFormat: "mp3"))
        let audioPlayer = InterruptibleBufferedAudioPlayer()
        let manager = TalkModeManager(
            allowSimulatorCapture: true,
            gatewaySpeechSynthesizer: synthesizer)
        manager.bufferedPlayer = audioPlayer
        manager._test_applyLoadedTalkConfig(parsed, providerSelection: .gatewayDefault)

        let playback = Task { await manager._test_playAssistant(text: "Interrupt me") }
        while !audioPlayer.isPlaying {
            await Task.yield()
        }
        #expect(manager._test_hasRecognitionRequest())

        manager._test_stopSpeaking(storeInterruption: false)
        await playback.value

        #expect(!manager._test_hasRecognitionRequest())
        #expect(manager._test_lastInterruptedAtSeconds() == nil)
    }

    @Test func `open AI speech provider without realtime config uses talk speak`() {
        let parsed = Self.parseSpeechProvider("openai")

        let routing = TalkModeRoutingResolver.resolve(
            parsed: parsed,
            providerSelection: .gatewayDefault,
            defaultProvider: "elevenlabs",
            defaultRealtimeModelId: "gpt-realtime-2")

        #expect(routing.activeProvider == "openai")
        #expect(routing.executionMode == .native)
        #expect(routing.route == .gatewayTalkSpeak)
    }

    @Test func `explicit realtime config keeps realtime relay`() {
        let parsed = TalkModeGatewayConfigParser.parse(
            config: [
                "talk": [
                    "provider": "openai",
                    "providers": [
                        "openai": [
                            "mode": "realtime",
                            "model": "gpt-realtime-2",
                        ],
                    ],
                    "resolved": [
                        "provider": "openai",
                        "config": [
                            "model": "gpt-realtime-2",
                        ],
                    ],
                    "realtime": [
                        "provider": "openai",
                        "mode": "realtime",
                        "transport": "gateway-relay",
                        "model": "gpt-realtime-2",
                    ],
                ],
            ],
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)

        let routing = TalkModeRoutingResolver.resolve(
            parsed: parsed,
            providerSelection: .gatewayDefault,
            defaultProvider: "elevenlabs",
            defaultRealtimeModelId: "gpt-realtime-2")

        #expect(routing.executionMode == .realtimeRelay)
        #expect(routing.route == .realtimeRelay)
        #expect(!routing.route.usesGatewayTalkSpeak)
        #expect(routing.route.gatewayOwnsCredentials)
    }

    private static func parseSpeechProvider(
        _ provider: String,
        model: String? = "speech-model",
        interruptOnSpeech: Bool = false) -> TalkModeGatewayConfigState
    {
        let providerConfig: [String: String] = model.map { ["model": $0] } ?? [:]
        return TalkModeGatewayConfigParser.parse(
            config: [
                "talk": [
                    "provider": provider,
                    "providers": [provider: providerConfig],
                    "resolved": [
                        "provider": provider,
                        "config": providerConfig,
                    ],
                    "interruptOnSpeech": interruptOnSpeech,
                ],
            ],
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)
    }
}

private func makeWav16Mono(sampleRate: UInt32, samples: Int) -> Data {
    let channels: UInt16 = 1
    let bitsPerSample: UInt16 = 16
    let blockAlign = channels * (bitsPerSample / 8)
    let byteRate = sampleRate * UInt32(blockAlign)
    let dataSize = UInt32(samples) * UInt32(blockAlign)

    var data = Data()
    data.append(contentsOf: [0x52, 0x49, 0x46, 0x46])
    data.appendTestLEUInt32(36 + dataSize)
    data.append(contentsOf: [0x57, 0x41, 0x56, 0x45])
    data.append(contentsOf: [0x66, 0x6D, 0x74, 0x20])
    data.appendTestLEUInt32(16)
    data.appendTestLEUInt16(1)
    data.appendTestLEUInt16(channels)
    data.appendTestLEUInt32(sampleRate)
    data.appendTestLEUInt32(byteRate)
    data.appendTestLEUInt16(blockAlign)
    data.appendTestLEUInt16(bitsPerSample)
    data.append(contentsOf: [0x64, 0x61, 0x74, 0x61])
    data.appendTestLEUInt32(dataSize)
    data.append(Data(repeating: 0, count: Int(dataSize)))
    return data
}

extension Data {
    fileprivate mutating func appendTestLEUInt16(_ value: UInt16) {
        var value = value.littleEndian
        Swift.withUnsafeBytes(of: &value) { self.append(contentsOf: $0) }
    }

    fileprivate mutating func appendTestLEUInt32(_ value: UInt32) {
        var value = value.littleEndian
        Swift.withUnsafeBytes(of: &value) { self.append(contentsOf: $0) }
    }
}
