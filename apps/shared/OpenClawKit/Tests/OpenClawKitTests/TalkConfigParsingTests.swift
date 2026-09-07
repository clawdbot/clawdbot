import Testing
@testable import OpenClawKit

struct TalkConfigParsingTests {
    @Test func `prefers canonical resolved talk provider payload`() {
        let talk: [String: AnyCodable] = [
            "resolved": AnyCodable([
                "provider": "elevenlabs",
                "config": [
                    "voiceId": "voice-resolved",
                ],
            ]),
            "provider": AnyCodable("elevenlabs"),
            "providers": AnyCodable([
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ]),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(talk, defaultProvider: "elevenlabs")
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.normalizedPayload == true)
        #expect(selection?.config["voiceId"]?.stringValue == "voice-resolved")
    }

    @Test func `rejects normalized talk provider payload without resolved`() {
        let talk: [String: AnyCodable] = [
            "provider": AnyCodable("elevenlabs"),
            "providers": AnyCodable([
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ]),
            "voiceId": AnyCodable("voice-legacy"),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(talk, defaultProvider: "elevenlabs")
        #expect(selection == nil)
    }

    @Test func `falls back to legacy talk fields when normalized payload missing`() {
        let talk: [String: AnyCodable] = [
            "voiceId": AnyCodable("voice-legacy"),
            "apiKey": AnyCodable("legacy-key"),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(talk, defaultProvider: "elevenlabs")
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.normalizedPayload == false)
        #expect(selection?.config["voiceId"]?.stringValue == "voice-legacy")
        #expect(selection?.config["apiKey"]?.stringValue == "legacy-key")
    }

    @Test func `can disable legacy fallback`() {
        let talk: [String: AnyCodable] = [
            "voiceId": AnyCodable("voice-legacy"),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(
            talk,
            defaultProvider: "elevenlabs",
            allowLegacyFallback: false)
        #expect(selection == nil)
    }

    @Test func `rejects normalized payload when provider missing from providers`() {
        let talk: [String: AnyCodable] = [
            "provider": AnyCodable("acme"),
            "providers": AnyCodable([
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ]),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(talk, defaultProvider: "elevenlabs")
        #expect(selection == nil)
    }

    @Test func `rejects normalized payload when multiple providers and no provider`() {
        let talk: [String: AnyCodable] = [
            "providers": AnyCodable([
                "acme": [
                    "voiceId": "voice-acme",
                ],
                "elevenlabs": [
                    "voiceId": "voice-eleven",
                ],
            ]),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(talk, defaultProvider: "elevenlabs")
        #expect(selection == nil)
    }

    @Test func `bridges foundation dictionary`() {
        let raw: [String: Any] = [
            "provider": "elevenlabs",
            "providers": [
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ],
        ]

        let bridged = TalkConfigParsing.bridgeFoundationDictionary(raw)
        #expect(bridged?["provider"]?.stringValue == "elevenlabs")
        let nested = bridged?["providers"]?.dictionaryValue?["elevenlabs"]?.dictionaryValue
        #expect(nested?["voiceId"]?.stringValue == "voice-normalized")
    }

    @Test func `resolves positive integer timeout`() {
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(1500), fallback: 700) == 1500)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(0), fallback: 700) == 700)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(true), fallback: 700) == 700)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable("1500"), fallback: 700) == 700)
    }

    @Test func `resolves speech locale ID`() {
        #expect(TalkConfigParsing.resolvedSpeechLocaleID(["speechLocale": AnyCodable(" ru_RU ")]) == "ru-RU")
        #expect(TalkConfigParsing
            .resolvedSpeechLocaleID(["speechLocale": AnyCodable("")], fallback: "en-US") == "en-US")
    }

    @Test func `resolves speech recognition locale from supported fallbacks`() {
        let locale = TalkConfigParsing.resolvedSpeechRecognitionLocaleID(
            preferredLocaleIDs: ["zz-ZZ", "fr-FR"],
            supportedLocaleIDs: ["fr-FR", "en-US"])
        let fallback = TalkConfigParsing.resolvedSpeechRecognitionLocaleID(
            preferredLocaleIDs: ["zz-ZZ", "yy-YY"],
            supportedLocaleIDs: ["en-US"])

        #expect(locale == "fr-FR")
        #expect(fallback == "en-US")
    }

    @Test func `snapshot keeps speaker voice precedence separate from voice`() {
        let talk: [String: AnyCodable] = [
            "realtime": AnyCodable([
                "provider": " OpenAI ",
                "model": " top-model ",
                "voice": " top-voice ",
                "providers": ["openai": [
                    "model": "provider-model",
                    "speakerVoice": "provider-speaker",
                    "voice": "provider-voice",
                ]],
            ]),
        ]
        let snapshot = TalkConfigSnapshot(talk, defaultProvider: "elevenlabs", defaultSilenceTimeoutMs: 900)
        #expect(snapshot.realtime.provider == "OpenAI")
        #expect(snapshot.realtime.modelId == "top-model")
        #expect(snapshot.realtime.voice == "top-voice")
        #expect(snapshot.realtime.speakerVoice == "top-voice")
        #expect(snapshot.interruptOnSpeech == nil)

        let speakerOnly = TalkConfigSnapshot([
            "interruptOnSpeech": AnyCodable(false),
            "realtime": AnyCodable([
                "speakerVoice": " top-speaker ",
                "providers": ["openai": ["voice": "provider-voice"]],
            ]),
        ], defaultProvider: "elevenlabs", defaultSilenceTimeoutMs: 900)
        #expect(speakerOnly.realtime.voice == "provider-voice")
        #expect(speakerOnly.realtime.speakerVoice == "top-speaker")
        #expect(speakerOnly.interruptOnSpeech == false)
    }
}
