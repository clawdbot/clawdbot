import Foundation
import Testing
@testable import OpenClaw

@Suite struct TalkSpeechLocaleTests {
    @Test func localSelectionOverridesGatewayConfig() {
        let locale = TalkSpeechLocale.resolvedLocaleID(
            localSelection: "de-DE",
            gatewaySelection: "ru-RU",
            deviceLocaleID: "en-US",
            supportedLocaleIDs: ["de-DE", "ru-RU", "en-US"])

        #expect(locale == "de-DE")
    }

    @Test func automaticLocalSelectionAllowsGatewayConfig() {
        let locale = TalkSpeechLocale.resolvedLocaleID(
            localSelection: TalkSpeechLocale.automaticID,
            gatewaySelection: "ru_RU",
            deviceLocaleID: "en-US",
            supportedLocaleIDs: ["ru-RU", "en-US"])

        #expect(locale == "ru-RU")
    }

    @Test func unsupportedConfiguredLocaleFallsBackToDeviceThenEnglish() {
        let deviceLocale = TalkSpeechLocale.resolvedLocaleID(
            localSelection: "zz-ZZ",
            gatewaySelection: nil,
            deviceLocaleID: "fr-FR",
            supportedLocaleIDs: ["fr-FR", "en-US"])
        let english = TalkSpeechLocale.resolvedLocaleID(
            localSelection: "zz-ZZ",
            gatewaySelection: nil,
            deviceLocaleID: "yy-YY",
            supportedLocaleIDs: ["en-US"])

        #expect(deviceLocale == "fr-FR")
        #expect(english == "en-US")
    }

    @Test func speechSynthesisPrefersDirectiveLocale() {
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: " tr_TR ",
            localSelection: "de-DE",
            gatewaySelection: "ru-RU",
            isVoiceAvailable: { _ in true })

        #expect(locale == "tr-TR")
    }

    @Test func speechSynthesisUsesLocalThenGatewayLocale() {
        let local = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: nil,
            localSelection: "de_DE",
            gatewaySelection: "ru-RU",
            isVoiceAvailable: { _ in true })
        let gateway = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: nil,
            localSelection: TalkSpeechLocale.automaticID,
            gatewaySelection: "ru_RU",
            isVoiceAvailable: { _ in true })

        #expect(local == "de-DE")
        #expect(gateway == "ru-RU")
    }

    @Test func automaticSpeechSynthesisUsesSystemDefaultWithoutGatewayLocale() {
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: nil,
            localSelection: TalkSpeechLocale.automaticID,
            gatewaySelection: nil,
            isVoiceAvailable: { _ in true })

        #expect(locale == nil)
    }

    @Test func unavailableDirectiveFallsThroughToAvailableLocalVoice() {
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: "zz-ZZ",
            localSelection: "fr-FR",
            gatewaySelection: "tr-TR",
            isVoiceAvailable: { $0 == "fr-FR" })

        #expect(locale == "fr-FR")
    }

    @Test func unavailableDirectiveAndLocalVoicesFallThroughToGatewayVoice() {
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: "zz-ZZ",
            localSelection: "yy-YY",
            gatewaySelection: "tr_TR",
            isVoiceAvailable: { $0 == "tr-TR" })

        #expect(locale == "tr-TR")
    }

    @Test func unavailableCandidatesUseSystemDefaultOnlyAfterEveryCandidateFails() {
        var checkedLocaleIDs: [String] = []
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: "zz-ZZ",
            localSelection: "fr-FR",
            gatewaySelection: "tr-TR",
            isVoiceAvailable: {
                checkedLocaleIDs.append($0)
                return false
            })

        #expect(locale == nil)
        #expect(checkedLocaleIDs == ["zz-ZZ", "fr-FR", "tr-TR"])
    }
}
