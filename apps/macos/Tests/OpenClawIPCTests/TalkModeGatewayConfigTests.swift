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

        #expect(parsed.snapshot.activeProvider == "mlx")
        #expect(parsed.modelId == "mlx-community/fish-audio-s2-pro-8bit")
        #expect(parsed.apiKey == nil)
        #expect(parsed.voiceId == "unused-voice")
        #expect(parsed.snapshot.speechLocaleID == "ru-RU")
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
                "model": " gpt-live-test-canary ",
                "speakerVoice": " cedar ",
                "mode": " Realtime ",
                "transport": " Gateway-Relay ",
                "brain": " Agent-Consult ",
            ],
        ])

        let parsed = Self.parse(snapshot)

        #expect(parsed.snapshot.realtime.provider == "OpenAI")
        #expect(parsed.snapshot.realtime.modelId == "gpt-live-test-canary")
        #expect(parsed.snapshot.realtime.speakerVoice == "cedar")
        #expect(parsed.snapshot.realtime.mode == "realtime")
        #expect(parsed.snapshot.realtime.transport == "gateway-relay")
        #expect(parsed.snapshot.realtime.brain == "agent-consult")
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

        #expect(parsed.snapshot.realtime.provider == "openai")
        #expect(parsed.snapshot.realtime.modelId == "gpt-realtime-2.1")
        #expect(parsed.snapshot.realtime.speakerVoice == "marin")
        #expect(parsed.snapshot.realtime.mode == "realtime")
        #expect(parsed.snapshot.realtime.transport == nil)
        #expect(parsed.snapshot.realtime.brain == nil)
        #expect(!parsed.hasGatewayRealtimeRelayTuple)
    }

    @Test func `realtime provider config lookup is case insensitive`() {
        let snapshot = Self.snapshot(talk: [
            "realtime": [
                "provider": "OPENAI",
                "providers": [
                    "openai": [
                        "model": "gpt-live-test-canary",
                        "speakerVoice": "cedar",
                    ],
                ],
            ],
        ])

        let parsed = Self.parse(snapshot)

        #expect(parsed.snapshot.realtime.provider == "OPENAI")
        #expect(parsed.snapshot.realtime.modelId == "gpt-live-test-canary")
        #expect(parsed.snapshot.realtime.speakerVoice == "cedar")
    }

    @Test func `fallback has no realtime selection`() {
        let parsed = TalkModeGatewayConfigParser.fallback(
            defaultModelIdFallback: "eleven_v3",
            defaultSilenceTimeoutMs: TalkDefaults.silenceTimeoutMs,
            envVoice: nil,
            sagVoice: nil,
            envApiKey: nil)

        #expect(parsed.snapshot.realtime.provider == nil)
        #expect(parsed.snapshot.realtime.modelId == nil)
        #expect(parsed.snapshot.realtime.speakerVoice == nil)
        #expect(parsed.snapshot.realtime.mode == nil)
        #expect(parsed.snapshot.realtime.transport == nil)
        #expect(parsed.snapshot.realtime.brain == nil)
    }

    @Test func `redacted gateway model remains omitted`() {
        let snapshot = ConfigSnapshot(
            path: nil,
            exists: true,
            raw: nil,
            hash: nil,
            parsed: nil,
            valid: true,
            config: [
                "talk": AnyCodable([
                    "realtime": [
                        "provider": "openai",
                        "mode": "realtime",
                        "transport": "gateway-relay",
                    ],
                ]),
                "clientHints": AnyCodable([
                    "realtime": [
                        "modelSource": "gateway",
                        "gatewayRelaySupported": false,
                    ],
                ]),
            ],
            issues: nil)

        #expect(Self.parse(snapshot).snapshot.realtime.modelId == nil)
    }

    @Test func `released realtime model remains available`() {
        let snapshot = Self.snapshot(talk: [
            "realtime": [
                "provider": "openai",
                "model": "gpt-live-1-codex",
                "speakerVoice": "spruce",
                "mode": "realtime",
                "transport": "gateway-relay",
            ],
        ])

        let parsed = Self.parse(snapshot)
        #expect(parsed.snapshot.realtime.modelId == "gpt-live-1-codex")
        #expect(parsed.snapshot.realtime.speakerVoice == "spruce")
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
