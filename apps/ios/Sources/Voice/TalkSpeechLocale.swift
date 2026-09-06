import AVFoundation
import Foundation
import OpenClawKit
import Speech

enum TalkSpeechLocale {
    static let storageKey = "talk.speechLocale"
    static let automaticID = "auto"
    static let fallbackLocaleID = "en-US"

    static func resolvedLocaleID(
        localSelection: String?,
        gatewaySelection: String?,
        deviceLocaleID: String = Locale.autoupdatingCurrent.identifier,
        fallbackLocaleID: String = Self.fallbackLocaleID,
        supportedLocaleIDs: Set<String>) -> String?
    {
        TalkConfigParsing.resolvedSpeechRecognitionLocaleID(
            preferredLocaleIDs: [
                TalkConfigParsing.normalizedExplicitSpeechLocaleID(localSelection),
                TalkConfigParsing.normalizedExplicitSpeechLocaleID(gatewaySelection),
                deviceLocaleID,
            ],
            fallbackLocaleID: fallbackLocaleID,
            supportedLocaleIDs: supportedLocaleIDs)
    }

    static func resolvedSynthesisLocaleID(
        directiveLanguage: String?,
        localSelection: String?,
        gatewaySelection: String?,
        isVoiceAvailable: (String) -> Bool = TalkSpeechLocale.isSystemVoiceAvailable) -> String?
    {
        // A missing higher-priority voice must not mask a later configured voice.
        // Return nil only after every candidate fails so synthesis uses the device default.
        [directiveLanguage, localSelection, gatewaySelection]
            .compactMap { TalkConfigParsing.normalizedExplicitSpeechLocaleID($0) }
            .first(where: isVoiceAvailable)
    }

    static func isSystemVoiceAvailable(_ localeID: String) -> Bool {
        AVSpeechSynthesisVoice(language: localeID) != nil
    }

    static func makeRecognizer(
        localSelection: String?,
        gatewaySelection: String?,
        supportedLocales: Set<Locale> = SFSpeechRecognizer.supportedLocales()) -> (
        recognizer: SFSpeechRecognizer?,
        localeID: String?)
    {
        let supportedIDs = Set(supportedLocales.map(\.identifier))
        guard let localeID = self.resolvedLocaleID(
            localSelection: localSelection,
            gatewaySelection: gatewaySelection,
            supportedLocaleIDs: supportedIDs)
        else {
            let recognizer = SFSpeechRecognizer()
            return (recognizer, recognizer?.locale.identifier)
        }

        if let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeID)) {
            return (recognizer, localeID)
        }

        let recognizer = SFSpeechRecognizer()
        return (recognizer, recognizer?.locale.identifier)
    }
}
