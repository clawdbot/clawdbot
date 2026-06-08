import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
private final class UnusedPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async -> StreamingPlaybackResult {
        fatalError("Playback is not used by this test")
    }

    func stop() -> Double? {
        nil
    }
}

@MainActor
@Suite struct RealtimeTalkRelaySessionTests {
    @Test func outputPlaybackFinishClearsBargeInStartTime() {
        var speakingStates: [Bool] = []
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })

        session._test_markOutputAudioStarted(nowMs: 100)
        #expect(session._test_isOutputPlaying())
        #expect(session._test_outputStartedAtMs() == 100)

        session._test_markOutputPlaybackFinished()
        #expect(!session._test_isOutputPlaying())
        #expect(session._test_outputStartedAtMs() == nil)
        #expect(speakingStates == [false])

        session._test_markOutputAudioStarted(nowMs: 500)
        #expect(session._test_outputStartedAtMs() == 500)
    }

    @Test func closeAfterClassifiedErrorDoesNotReplaceIssue() async {
        var issues: [TalkRuntimeIssue] = []
        var statuses: [String] = []
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "error",
                "message": "OpenAI API key rejected with 401",
                "code": "realtime_unavailable",
                "provider": "openai",
                "model": "gpt-realtime-2",
                "transport": "gateway-relay",
                "phase": "connect",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "close",
                "reason": "error",
            ]),
            seq: nil,
            stateversion: nil))

        #expect(issues.map(\.code) == [.realtimeUnavailable])
        #expect(statuses == ["OpenAI API key rejected with 401"])
    }

    @Test func closedRelayDoesNotWaitForStartupReady() async {
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        session.stop()

        #expect(await session._test_waitForStartupCancelled(timeoutSeconds: 1))
    }

    @Test func startupReadyWaitCoversGatewayConnectBudget() {
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        #expect(session._test_startupReadyTimeoutSeconds() >= 12)
    }
}
