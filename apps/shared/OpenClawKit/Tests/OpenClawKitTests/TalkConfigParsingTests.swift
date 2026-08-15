import OpenClawKit
import Testing

struct TalkConfigParsingTests {
    @Test func prefersCanonicalResolvedTalkProviderPayload() {
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

    @Test func rejectsNormalizedTalkProviderPayloadWithoutResolved() {
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

    @Test func fallsBackToLegacyTalkFieldsWhenNormalizedPayloadMissing() {
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

    @Test func canDisableLegacyFallback() {
        let talk: [String: AnyCodable] = [
            "voiceId": AnyCodable("voice-legacy"),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(
            talk,
            defaultProvider: "elevenlabs",
            allowLegacyFallback: false)
        #expect(selection == nil)
    }

    @Test func rejectsNormalizedPayloadWhenProviderMissingFromProviders() {
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

    @Test func rejectsNormalizedPayloadWhenMultipleProvidersAndNoProvider() {
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

    @Test func bridgesFoundationDictionary() {
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

    @Test func resolvesPositiveIntegerTimeout() {
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(1500), fallback: 700) == 1500)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(0), fallback: 700) == 700)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(true), fallback: 700) == 700)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable("1500"), fallback: 700) == 700)
    }

    @Test func resolvesSpeechLocaleID() {
        #expect(TalkConfigParsing.resolvedSpeechLocaleID(["speechLocale": AnyCodable(" ru_RU ")]) == "ru-RU")
        #expect(TalkConfigParsing.resolvedSpeechLocaleID(["speechLocale": AnyCodable("")], fallback: "en-US") == "en-US")
    }

    @Test func resolvesSpeechRecognitionLocaleFromSupportedFallbacks() {
        let locale = TalkConfigParsing.resolvedSpeechRecognitionLocaleID(
            preferredLocaleIDs: ["zz-ZZ", "fr-FR"],
            supportedLocaleIDs: ["fr-FR", "en-US"])
        let fallback = TalkConfigParsing.resolvedSpeechRecognitionLocaleID(
            preferredLocaleIDs: ["zz-ZZ", "yy-YY"],
            supportedLocaleIDs: ["en-US"])

        #expect(locale == "fr-FR")
        #expect(fallback == "en-US")
    }
}
