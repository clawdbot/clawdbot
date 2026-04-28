import Foundation
import OpenClawKit
import Speech

enum TalkSpeechLocale {
    static let storageKey = "talk.speechLocale"
    static let automaticID = "auto"
    static let fallbackLocaleID = "en-US"

    struct Option: Identifiable {
        let id: String
        let label: String
    }

    static func supportedOptions(
        supportedLocales: Set<Locale> = SFSpeechRecognizer.supportedLocales()) -> [Option]
    {
        var seen = Set<String>()
        let dynamic: [Option] = supportedLocales
            .compactMap { locale in
                let id = self.canonicalID(locale.identifier)
                guard seen.insert(id).inserted else { return nil }
                return Option(id: id, label: self.friendlyName(for: locale))
            }
            .sorted { (lhs: Option, rhs: Option) in
                lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
            }
        return [Option(id: self.automaticID, label: "Automatic")] + dynamic
    }

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

    static func normalizedExplicitLocaleID(_ raw: String?) -> String? {
        TalkConfigParsing.normalizedExplicitSpeechLocaleID(raw, automaticID: self.automaticID)
    }

    private static func normalizedLocaleID(_ raw: String?) -> String? {
        TalkConfigParsing.normalizedSpeechLocaleID(raw)
    }

    private static func canonicalID(_ raw: String) -> String {
        raw.replacingOccurrences(of: "_", with: "-")
    }

    private static func friendlyName(for locale: Locale) -> String {
        let id = self.canonicalID(locale.identifier)
        let cleanLocale = Locale(identifier: id)
        if let langCode = cleanLocale.language.languageCode?.identifier,
           let lang = cleanLocale.localizedString(forLanguageCode: langCode),
           let regionCode = cleanLocale.region?.identifier,
           let region = cleanLocale.localizedString(forRegionCode: regionCode)
        {
            return "\(lang) (\(region))"
        }
        if let langCode = cleanLocale.language.languageCode?.identifier,
           let lang = cleanLocale.localizedString(forLanguageCode: langCode)
        {
            return lang
        }
        return cleanLocale.localizedString(forIdentifier: id) ?? id
    }
}
