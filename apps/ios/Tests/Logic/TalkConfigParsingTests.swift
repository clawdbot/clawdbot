import Foundation
import Testing
@testable import OpenClawKit

private let iOSSilenceTimeoutMs = 900

struct TalkConfigParsingTests {
    @Test func `rejects normalized talk provider payload without resolved`() {
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

    @Test func `ignores legacy talk fields when normalized payload missing`() {
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

    @Test func `reads configured silence timeout ms`() {
        let talk: [String: Any] = [
            "silenceTimeoutMs": 1500,
        ]

        #expect(
            TalkConfigParsing.resolvedSilenceTimeoutMs(
                TalkConfigParsing.bridgeFoundationDictionary(talk),
                fallback: iOSSilenceTimeoutMs) == 1500)
    }

    @Test func `reads configured speech locale`() {
        let talk: [String: Any] = [
            "speechLocale": " ru-RU ",
        ]

        #expect(
            TalkConfigParsing.resolvedSpeechLocaleID(
                TalkConfigParsing.bridgeFoundationDictionary(talk)) == "ru-RU")
    }

    @Test func `defaults silence timeout ms when missing`() {
        #expect(TalkConfigParsing.resolvedSilenceTimeoutMs(nil, fallback: iOSSilenceTimeoutMs) == iOSSilenceTimeoutMs)
    }

    @Test func `defaults silence timeout ms when invalid`() {
        let talk: [String: Any] = [
            "silenceTimeoutMs": 0,
        ]

        #expect(
            TalkConfigParsing.resolvedSilenceTimeoutMs(
                TalkConfigParsing.bridgeFoundationDictionary(talk),
                fallback: iOSSilenceTimeoutMs) == iOSSilenceTimeoutMs)
    }

    @Test func `defaults silence timeout ms when bool`() {
        let talk: [String: Any] = [
            "silenceTimeoutMs": true,
        ]

        #expect(
            TalkConfigParsing.resolvedSilenceTimeoutMs(
                TalkConfigParsing.bridgeFoundationDictionary(talk),
                fallback: iOSSilenceTimeoutMs) == iOSSilenceTimeoutMs)
    }
}
