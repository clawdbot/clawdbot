import AVFoundation
import Foundation
import OpenClawKit
import Speech

enum VoiceWakeDeviceOptions {
    struct Option: Identifiable, Encodable, Equatable {
        let id: String
        let name: String
    }

    static func microphones() -> [Option] {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external, .microphone],
            mediaType: .audio,
            position: .unspecified)
        let aliveUIDs = AudioInputDeviceObserver.aliveInputDeviceUIDs()
        let connectedDevices = discovery.devices.filter(\.isConnected)
        let devices = aliveUIDs.isEmpty
            ? connectedDevices
            : connectedDevices.filter { aliveUIDs.contains($0.uniqueID) }
        return devices.map { Option(id: $0.uniqueID, name: $0.localizedName) }
    }

    static func localeSettings(
        primary: String,
        additional: [String],
        systemLocale: Locale = .current,
        supportedLocales: Set<Locale> = SFSpeechRecognizer.supportedLocales()) -> DeviceSettingsSnapshot.Voice.Locale
    {
        let available = self.locales(systemLocale: systemLocale, supportedLocales: supportedLocales)
        let identifiers = Dictionary(uniqueKeysWithValues: available.map { (self.localeKey($0.id), $0.id) })
        // Persisted system markers and locale aliases must resolve to actual select options.
        return .init(
            primary: identifiers[self.localeKey(primary)] ?? systemLocale.identifier,
            additional: additional.compactMap { identifiers[self.localeKey($0)] },
            available: available)
    }

    static func locales(
        systemLocale: Locale = .current,
        supportedLocales: Set<Locale> = SFSpeechRecognizer.supportedLocales()) -> [Option]
    {
        let system = Option(
            id: systemLocale.identifier,
            name: String(format: String(localized: "%@ (System)"), self.friendlyName(for: systemLocale)))
        var seen = Set([self.localeKey(system.id)])
        let supported = supportedLocales
            .map { Option(id: $0.identifier, name: self.friendlyName(for: $0)) }
            .sorted {
                let order = $0.name.localizedCaseInsensitiveCompare($1.name)
                return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
            }
            .filter { seen.insert(self.localeKey($0.id)).inserted }
        return [system] + supported
    }

    private static func localeKey(_ identifier: String) -> String {
        normalizeLocaleIdentifier(TalkConfigParsing.normalizedSpeechLocaleID(identifier)?.lowercased() ?? "")
    }

    private static func friendlyName(for locale: Locale) -> String {
        let cleanedID = normalizeLocaleIdentifier(locale.identifier)
        let cleanLocale = Locale(identifier: cleanedID)
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
        return cleanLocale.localizedString(forIdentifier: cleanedID) ?? cleanedID
    }
}
