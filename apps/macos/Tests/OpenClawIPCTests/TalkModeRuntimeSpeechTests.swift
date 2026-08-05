import Foundation
import OpenClawKit
import Speech
import Testing
@testable import OpenClaw

@MainActor
private final class RuntimeTestAudioCapture: RealtimeTalkAudioCapturing {
    let suppressesInputDuringOutput = false

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) throws
    {}

    func stop() {}
}

@MainActor
private final class RuntimeTestPCMPlayer: PCMStreamingAudioPlaying {
    private(set) var stopCount = 0

    func play(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) async -> StreamingPlaybackResult
    {
        fatalError("Playback is not used by this test")
    }

    func stop() -> Double? {
        self.stopCount += 1
        return nil
    }
}

struct TalkModeRuntimeSpeechTests {
    @Test func `macOS realtime relay requires local opt in and exact Gateway tuple`() {
        #expect(!TalkModeRuntime.shouldUseRealtimeRelay(
            localOptIn: false,
            hasGatewayRealtimeRelayTuple: false))
        #expect(!TalkModeRuntime.shouldUseRealtimeRelay(
            localOptIn: false,
            hasGatewayRealtimeRelayTuple: true))
        #expect(!TalkModeRuntime.shouldUseRealtimeRelay(
            localOptIn: true,
            hasGatewayRealtimeRelayTuple: false))
        #expect(TalkModeRuntime.shouldUseRealtimeRelay(
            localOptIn: true,
            hasGatewayRealtimeRelayTuple: true))
    }

    @Test @MainActor func `macOS realtime relay preference defaults off and reads explicit opt in`() async {
        await TestIsolation.withUserDefaultsValues([talkRealtimeRelayEnabledKey: nil]) {
            #expect(!AppState(preview: true).talkRealtimeRelayEnabled)
        }
        await TestIsolation.withUserDefaultsValues([talkRealtimeRelayEnabledKey: true]) {
            #expect(AppState(preview: true).talkRealtimeRelayEnabled)
        }
    }

    @Test func `speech request uses dictation defaults`() {
        let request = SFSpeechAudioBufferRecognitionRequest()

        TalkModeRuntime.configureRecognitionRequest(request)

        #expect(request.shouldReportPartialResults)
        #expect(request.taskHint == .dictation)
        #expect(!request.requiresOnDeviceRecognition)
    }

    @Test func `playback plan routes unsupported local providers through gateway speak`() {
        let elevenLabsPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "key",
            voiceId: "voice")
        let missingKeyPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: nil,
            voiceId: "voice")
        let missingVoicePlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "key",
            voiceId: nil)
        let blankKeyPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "",
            voiceId: "voice")
        let openAIPlan = TalkModeRuntime.playbackPlan(provider: "openai", apiKey: nil, voiceId: "onyx")
        let customPlan = TalkModeRuntime.playbackPlan(provider: "acme-speech", apiKey: nil, voiceId: nil)
        let mlxPlan = TalkModeRuntime.playbackPlan(provider: "mlx", apiKey: nil, voiceId: nil)
        let systemPlan = TalkModeRuntime.playbackPlan(provider: "system", apiKey: nil, voiceId: nil)

        #expect(elevenLabsPlan == .elevenLabsThenSystemVoice(apiKey: "key", voiceId: "voice"))
        #expect(missingKeyPlan == .systemVoiceOnly)
        #expect(missingVoicePlan == .systemVoiceOnly)
        #expect(blankKeyPlan == .systemVoiceOnly)
        #expect(openAIPlan == .gatewayTalkSpeakThenSystemVoice)
        #expect(customPlan == .gatewayTalkSpeakThenSystemVoice)
        #expect(mlxPlan == .mlxThenSystemVoice)
        #expect(systemPlan == .systemVoiceOnly)
    }

    @Test func `mlx cancellation stops while failures preserve system fallback`() {
        #expect(TalkModeRuntime.mlxFailureDisposition(
            TalkMLXSpeechSynthesizer.SynthesizeError.canceled) == .canceled)
        #expect(TalkModeRuntime.mlxFailureDisposition(
            TalkMLXSpeechSynthesizer.SynthesizeError.audioGenerationFailed) == .fallback)
        #expect(TalkModeRuntime.mlxFailureDisposition(
            TalkMLXSpeechSynthesizer.SynthesizeError.modelLoadFailed("missing")) == .fallback)
    }

    @Test func `realtime recovery uses the iOS retry budget`() {
        #expect(TalkModeRuntime.realtimeRestartAttempt(
            previousRapidRestarts: 1,
            activeDuration: 5) == 2)
        #expect(TalkModeRuntime.realtimeRestartAttempt(
            previousRapidRestarts: 2,
            activeDuration: 31) == 1)
        #expect(TalkModeRuntime.realtimeRestartDelayNanoseconds(attempt: 1) == 500_000_000)
        #expect(TalkModeRuntime.realtimeRestartDelayNanoseconds(attempt: 2) == 2_000_000_000)
        #expect(TalkModeRuntime.realtimeRestartDelayNanoseconds(attempt: 3) == nil)
    }

    @Test @MainActor func `ready then close clears relay owner and schedules bounded recovery`() async {
        let runtime = TalkModeRuntime()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { _, _, _ in throw CancellationError() }),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: RuntimeTestAudioCapture(),
            pcmPlayer: RuntimeTestPCMPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        let relayGeneration = await runtime._test_prepareEnabledRealtimeSessionForClose(session)

        await runtime._test_handleRealtimeTermination(
            .remoteClose(reason: "stale"),
            relayGeneration: relayGeneration &- 1)
        #expect(await runtime._test_realtimeSessionIsActive())

        await runtime._test_handleRealtimeStatus(
            "Listening (Realtime)",
            relayGeneration: relayGeneration)
        await runtime._test_handleRealtimeTermination(
            .remoteClose(reason: "completed"),
            relayGeneration: relayGeneration)

        let realtimeSessionIsActive = await runtime._test_realtimeSessionIsActive()
        #expect(!realtimeSessionIsActive)
        #expect(await runtime._test_rapidRealtimeRestartCount() == 1)
        #expect(await runtime._test_hasPendingRealtimeRestart())

        await runtime._test_cancelRealtimeRecovery()
        session.stop()
    }

    @Test @MainActor func `microphone failure clears relay owner and schedules bounded recovery`() async {
        let runtime = TalkModeRuntime()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { _, _, _ in throw CancellationError() }),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: RuntimeTestAudioCapture(),
            pcmPlayer: RuntimeTestPCMPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        let relayGeneration = await runtime._test_prepareEnabledRealtimeSessionForClose(session)

        await runtime._test_handleRealtimeAudioCaptureFailure(
            "input disappeared",
            relayGeneration: relayGeneration)

        let realtimeSessionIsActive = await runtime._test_realtimeSessionIsActive()
        #expect(!realtimeSessionIsActive)
        #expect(await runtime._test_rapidRealtimeRestartCount() == 1)
        #expect(await runtime._test_hasPendingRealtimeRestart())

        await runtime._test_cancelRealtimeRecovery()
    }

    @Test @MainActor func `pausing realtime cancels output and resets the visible phase`() async {
        let runtime = TalkModeRuntime()
        let player = RuntimeTestPCMPlayer()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { _, _, _ in Data("{\"ok\":true}".utf8) }),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: RuntimeTestAudioCapture(),
            pcmPlayer: player,
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        _ = await runtime._test_prepareEnabledRealtimeSessionForClose(session)
        TalkModeController.shared.updatePhase(.speaking)
        TalkModeController.shared.updateLevel(0.8)

        await runtime.setPaused(true)

        #expect(await runtime._test_phase() == .idle)
        #expect(TalkModeController.shared.phase == .idle)
        #expect(TalkModeController.shared.level == 0)
        #expect(player.stopCount == 1)

        await runtime._test_cancelRealtimeRecovery()
        session.stop()
    }

    @Test func `talk speak params carry resolved voice and directive overrides`() {
        let params = TalkModeRuntime.makeTalkSpeakParams(
            text: "hello",
            voiceId: "voice-123",
            modelId: "eleven_v3",
            outputFormat: "mp3_44100_128",
            directive: TalkDirective(
                modelId: "eleven_turbo_v2_5",
                speed: 1.1,
                rateWPM: 180,
                stability: 0.4,
                similarity: 0.7,
                style: 0.2,
                speakerBoost: true,
                seed: 42,
                normalize: "auto",
                language: "en",
                outputFormat: "mp3_44100_128",
                latencyTier: 3))

        #expect(params["text"]?.value as? String == "hello")
        #expect(params["voiceId"]?.value as? String == "voice-123")
        #expect(params["modelId"]?.value as? String == "eleven_turbo_v2_5")
        #expect(params["outputFormat"]?.value as? String == "mp3_44100_128")
        #expect(params["speed"]?.value as? Double == 1.1)
        #expect(params["rateWpm"]?.value as? Int == 180)
        #expect(params["stability"]?.value as? Double == 0.4)
        #expect(params["similarity"]?.value as? Double == 0.7)
        #expect(params["style"]?.value as? Double == 0.2)
        #expect(params["speakerBoost"]?.value as? Bool == true)
        #expect(params["seed"]?.value as? Int == 42)
        #expect(params["normalize"]?.value as? String == "auto")
        #expect(params["language"]?.value as? String == "en")
        #expect(params["latencyTier"]?.value as? Int == 3)
    }
}
