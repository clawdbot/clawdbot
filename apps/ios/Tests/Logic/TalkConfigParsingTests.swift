import Foundation
import OpenClawKit
import Testing

private let iOSSilenceTimeoutMs = 900

@Suite struct TalkConfigParsingTests {
    @Test func rejectsNormalizedTalkProviderPayloadWithoutResolved() {
        let talk: [String: Any] = [
            "provider": "elevenlabs",
            "providers": [
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ],
            "voiceId": "voice-legacy",
        ]

        let selection = TalkConfigParsing.selectProviderConfig(
            TalkConfigParsing.bridgeFoundationDictionary(talk),
            defaultProvider: "elevenlabs",
            allowLegacyFallback: false)
        #expect(selection == nil)
    }

    @Test func ignoresLegacyTalkFieldsWhenNormalizedPayloadMissing() {
        let talk: [String: Any] = [
            "voiceId": "voice-legacy",
            "apiKey": "legacy-key", // pragma: allowlist secret
        ]

        let selection = TalkConfigParsing.selectProviderConfig(
            TalkConfigParsing.bridgeFoundationDictionary(talk),
            defaultProvider: "elevenlabs",
            allowLegacyFallback: false)
        #expect(selection == nil)
    }

    @Test func readsConfiguredSilenceTimeoutMs() {
        let talk: [String: Any] = [
            "silenceTimeoutMs": 1500,
        ]

        #expect(
            TalkConfigParsing.resolvedSilenceTimeoutMs(
                TalkConfigParsing.bridgeFoundationDictionary(talk),
                fallback: iOSSilenceTimeoutMs) == 1500)
    }

    @Test func readsConfiguredSpeechLocale() {
        let talk: [String: Any] = [
            "speechLocale": " ru-RU ",
        ]

        #expect(
            TalkConfigParsing.resolvedSpeechLocaleID(
                TalkConfigParsing.bridgeFoundationDictionary(talk)) == "ru-RU")
    }

    @Test func defaultsSilenceTimeoutMsWhenMissing() {
        #expect(TalkConfigParsing.resolvedSilenceTimeoutMs(nil, fallback: iOSSilenceTimeoutMs) == iOSSilenceTimeoutMs)
    }

    @Test func defaultsSilenceTimeoutMsWhenInvalid() {
        let talk: [String: Any] = [
            "silenceTimeoutMs": 0,
        ]

        #expect(
            TalkConfigParsing.resolvedSilenceTimeoutMs(
                TalkConfigParsing.bridgeFoundationDictionary(talk),
                fallback: iOSSilenceTimeoutMs) == iOSSilenceTimeoutMs)
    }

    @Test func defaultsSilenceTimeoutMsWhenBool() {
        let talk: [String: Any] = [
            "silenceTimeoutMs": true,
        ]

        #expect(
            TalkConfigParsing.resolvedSilenceTimeoutMs(
                TalkConfigParsing.bridgeFoundationDictionary(talk),
                fallback: iOSSilenceTimeoutMs) == iOSSilenceTimeoutMs)
    }
}
