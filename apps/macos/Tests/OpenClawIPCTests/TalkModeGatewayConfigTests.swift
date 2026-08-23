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
}
