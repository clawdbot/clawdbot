import OpenClawProtocol
import Testing
@testable import OpenClaw

struct TalkModeGatewayConfigTests {
    @Test func `mlx provider does not inherit elevenlabs defaults`() {
        let snapshot = ConfigSnapshot(
            path: nil,
            exists: true,
            raw: nil,
            hash: nil,
            parsed: nil,
            valid: true,
            config: [
                "talk": AnyCodable([
                    "provider": "mlx",
                    "providers": [
                        "mlx": [
                            "modelId": "mlx-community/fish-audio-s2-pro-8bit",
                            "voiceId": "unused-voice",
                            "referenceAudioPath": "/tmp/reference.wav",
                            "referenceText": "reference transcript",
                        ],
                    ],
                    "resolved": [
                        "provider": "mlx",
                        "config": [
                            "voiceId": "unused-voice",
                            "modelId": "mlx-community/fish-audio-s2-pro-8bit",
                            "referenceAudioPath": "/tmp/reference.wav",
                            "referenceText": "reference transcript",
                        ],
                    ],
                    "speechLocale": "ru-RU",
                ]),
            ],
            issues: nil)

        let parsed = TalkModeGatewayConfigParser.parse(
            snapshot: snapshot,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultSilenceTimeoutMs: TalkDefaults.silenceTimeoutMs,
            envVoice: "env-voice",
            sagVoice: "sag-voice",
            envApiKey: "env-key")

        #expect(parsed.activeProvider == "mlx")
        #expect(parsed.modelId == "mlx-community/fish-audio-s2-pro-8bit")
        #expect(parsed.apiKey == nil)
        #expect(parsed.voiceId == "unused-voice")
        #expect(parsed.speechLocaleID == "ru-RU")
        #expect(parsed.referenceAudioPath == "/tmp/reference.wav")
        #expect(parsed.referenceText == "reference transcript")
    }

    @Test func `realtime config uses top level overrides and normalizes control values`() {
        let snapshot = Self.snapshot(talk: [
            "realtime": [
                "provider": " OpenAI ",
                "providers": [
                    "openai": [
                        "model": "provider-model",
                        "speakerVoice": "alloy",
                    ],
                ],
                "model": " gpt-live-1-codex ",
                "speakerVoice": " cedar ",
                "mode": " Realtime ",
                "transport": " Gateway-Relay ",
                "brain": " Agent-Consult ",
            ],
        ])

        let parsed = Self.parse(snapshot)

        #expect(parsed.realtimeProvider == "OpenAI")
        #expect(parsed.realtimeModelId == "gpt-live-1-codex")
        #expect(parsed.realtimeSpeakerVoice == "cedar")
        #expect(parsed.realtimeMode == "realtime")
        #expect(parsed.realtimeTransport == "gateway-relay")
        #expect(parsed.realtimeBrain == "agent-consult")
        #expect(parsed.hasGatewayRealtimeRelayTuple)
    }

    @Test func `realtime config infers its sole provider and reads provider defaults`() {
        let snapshot = Self.snapshot(talk: [
            "realtime": [
                "providers": [
                    "openai": [
                        "model": "gpt-realtime-2.1",
                        "voice": "marin",
                    ],
                ],
                "mode": "realtime",
            ],
        ])

        let parsed = Self.parse(snapshot)

        #expect(parsed.realtimeProvider == "openai")
        #expect(parsed.realtimeModelId == "gpt-realtime-2.1")
        #expect(parsed.realtimeSpeakerVoice == "marin")
        #expect(parsed.realtimeMode == "realtime")
        #expect(parsed.realtimeTransport == nil)
        #expect(parsed.realtimeBrain == nil)
        #expect(!parsed.hasGatewayRealtimeRelayTuple)
    }

    @Test func `realtime provider config lookup is case insensitive`() {
        let snapshot = Self.snapshot(talk: [
            "realtime": [
                "provider": "OPENAI",
                "providers": [
                    "openai": [
                        "model": "gpt-live-1-codex",
                        "speakerVoice": "cedar",
                    ],
                ],
            ],
        ])

        let parsed = Self.parse(snapshot)

        #expect(parsed.realtimeProvider == "OPENAI")
        #expect(parsed.realtimeModelId == "gpt-live-1-codex")
        #expect(parsed.realtimeSpeakerVoice == "cedar")
    }

    @Test func `fallback has no realtime selection`() {
        let parsed = TalkModeGatewayConfigParser.fallback(
            defaultModelIdFallback: "eleven_v3",
            defaultSilenceTimeoutMs: TalkDefaults.silenceTimeoutMs,
            envVoice: nil,
            sagVoice: nil,
            envApiKey: nil)

        #expect(parsed.realtimeProvider == nil)
        #expect(parsed.realtimeModelId == nil)
        #expect(parsed.realtimeSpeakerVoice == nil)
        #expect(parsed.realtimeMode == nil)
        #expect(parsed.realtimeTransport == nil)
        #expect(parsed.realtimeBrain == nil)
    }

    private static func snapshot(talk: [String: Any]) -> ConfigSnapshot {
        ConfigSnapshot(
            path: nil,
            exists: true,
            raw: nil,
            hash: nil,
            parsed: nil,
            valid: true,
            config: ["talk": AnyCodable(talk)],
            issues: nil)
    }

    private static func parse(_ snapshot: ConfigSnapshot) -> TalkModeGatewayConfigState {
        TalkModeGatewayConfigParser.parse(
            snapshot: snapshot,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultSilenceTimeoutMs: TalkDefaults.silenceTimeoutMs,
            envVoice: nil,
            sagVoice: nil,
            envApiKey: nil)
    }
}
