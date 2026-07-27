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
}
