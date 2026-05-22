import Foundation
import Testing
@testable import OpenClaw

@MainActor
@Suite struct TalkModeManagerTests {
    @Test func parsesOpenAIRealtimeProviderModelAndVoice() {
        let config: [String: Any] = [
            "talk": [
                "provider": "elevenlabs",
                "providers": [
                    "elevenlabs": [
                        "modelId": "eleven_v3",
                        "voiceId": "eleven-voice",
                    ],
                ],
                "resolved": [
                    "provider": "elevenlabs",
                    "config": [
                        "modelId": "eleven_v3",
                        "voiceId": "eleven-voice",
                    ],
                ],
                "realtime": [
                    "provider": " openai ",
                    "model": " gpt-realtime-2 ",
                    "voice": " marin ",
                    "mode": "realtime",
                    "transport": "gateway-relay",
                    "brain": "agent-consult",
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.activeProvider == "elevenlabs")
        #expect(parsed.executionMode == .realtimeRelay)
        #expect(parsed.defaultModelId == "eleven_v3")
        #expect(parsed.defaultVoiceId == "eleven-voice")
        #expect(parsed.realtimeProvider == "openai")
        #expect(parsed.realtimeModelId == "gpt-realtime-2")
        #expect(parsed.realtimeVoiceId == "marin")
    }

    @Test func defaultsOpenAIRealtimeModelWhenProviderOmitsModel() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "openai",
                    "mode": "realtime",
                    "transport": "gateway-relay",
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.executionMode == .realtimeRelay)
        #expect(parsed.defaultModelId == "eleven_v3")
        #expect(parsed.realtimeModelId == "gpt-realtime-2")
        #expect(parsed.realtimeVoiceId == nil)
    }

    @Test func resolvesRealtimeVoicePickerOverrides() {
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride(nil) == nil)
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride("") == nil)
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride(" Cedar ") == "cedar")
        #expect(TalkModeRealtimeVoiceSelection.resolvedOverride("unknown") == nil)
    }

    @Test func leavesNativeModeWhenRealtimeTransportIsNotGatewayRelay() {
        let config: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "openai",
                    "mode": "realtime",
                    "transport": "webrtc",
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.executionMode == .native)
    }

    @Test func detectsPCMFormatRejectionFromElevenLabsError() {
        let error = NSError(
            domain: "ElevenLabsTTS",
            code: 403,
            userInfo: [
                NSLocalizedDescriptionKey: "ElevenLabs failed: 403 subscription_required output_format=pcm_44100",
            ])
        #expect(TalkModeManager._test_isPCMFormatRejectedByAPI(error))
    }

    @Test func ignoresGenericPlaybackFailuresForPCMFormatRejection() {
        let error = NSError(
            domain: "StreamingAudio",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "queue enqueue failed"])
        #expect(TalkModeManager._test_isPCMFormatRejectedByAPI(error) == false)
    }
}
