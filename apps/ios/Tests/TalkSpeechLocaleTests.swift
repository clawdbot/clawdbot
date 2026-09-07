import Foundation
import Testing
@testable import OpenClaw

struct TalkSpeechLocaleTests {
    @Test @MainActor func `talk manager clears retired speech locale preference`() {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: "talk.speechLocale")
        defaults.set("de-DE", forKey: "talk.speechLocale")
        defer {
            if let previous {
                defaults.set(previous, forKey: "talk.speechLocale")
            } else {
                defaults.removeObject(forKey: "talk.speechLocale")
            }
        }

        _ = TalkModeManager(allowSimulatorCapture: true)

        #expect(defaults.object(forKey: "talk.speechLocale") == nil)
    }

    @Test func `gateway speech locale overrides device locale`() {
        let locale = TalkSpeechLocale.resolvedLocaleID(
            gatewaySelection: "ru_RU",
            deviceLocaleID: "en-US",
            supportedLocaleIDs: ["ru-RU", "en-US"])

        #expect(locale == "ru-RU")
    }

    @Test(arguments: [nil, "auto", "zz-ZZ"] as [String?])
    func `missing or unsupported gateway locale falls back to device then english`(gatewaySelection: String?) {
        let deviceLocale = TalkSpeechLocale.resolvedLocaleID(
            gatewaySelection: gatewaySelection,
            deviceLocaleID: "fr-FR",
            supportedLocaleIDs: ["fr-FR", "en-US"])
        let english = TalkSpeechLocale.resolvedLocaleID(
            gatewaySelection: gatewaySelection,
            deviceLocaleID: "yy-YY",
            supportedLocaleIDs: ["en-US"])

        #expect(deviceLocale == "fr-FR")
        #expect(english == "en-US")
    }

    @Test func `speech synthesis prefers directive locale`() {
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: " tr_TR ",
            gatewaySelection: "ru-RU",
            isVoiceAvailable: { _ in true })

        #expect(locale == "tr-TR")
    }

    @Test func `speech synthesis uses gateway locale`() {
        let gateway = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: nil,
            gatewaySelection: "ru_RU",
            isVoiceAvailable: { _ in true })

        #expect(gateway == "ru-RU")
    }

    @Test func `automatic speech synthesis uses system default without gateway locale`() {
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: nil,
            gatewaySelection: nil,
            isVoiceAvailable: { _ in true })

        #expect(locale == nil)
    }

    @Test func `unavailable directive falls through to gateway voice`() {
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: "zz-ZZ",
            gatewaySelection: "tr_TR",
            isVoiceAvailable: { $0 == "tr-TR" })

        #expect(locale == "tr-TR")
    }

    @Test func `unavailable candidates use system default only after every candidate fails`() {
        var checkedLocaleIDs: [String] = []
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: "zz-ZZ",
            gatewaySelection: "tr-TR",
            isVoiceAvailable: {
                checkedLocaleIDs.append($0)
                return false
            })

        #expect(locale == nil)
        #expect(checkedLocaleIDs == ["zz-ZZ", "tr-TR"])
    }
}
