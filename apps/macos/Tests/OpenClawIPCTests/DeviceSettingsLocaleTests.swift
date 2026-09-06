import Foundation
import Testing
@testable import OpenClaw

struct DeviceSettingsLocaleTests {
    @Test(arguments: [
        ("", "en_US"), ("system", "en_US"), ("en_US", "en_US"), ("en-US", "en_US"),
        ("en_US@collation=phonebook", "en_US"), ("de-DE", "de-DE"), ("de_DE", "de-DE"),
        ("unknown", "en_US"),
    ])
    func `published primary always names an available locale`(stored: String, expected: String) {
        let locale = VoiceWakeDeviceOptions.localeSettings(
            primary: stored,
            additional: [],
            systemLocale: Locale(identifier: "en_US"),
            supportedLocales: [Locale(identifier: "en-US"), Locale(identifier: "de-DE"), Locale(identifier: "ms_MY")])
        #expect(locale.primary == expected)
        #expect(locale.available.contains { $0.id == locale.primary })
        #expect(locale.available.filter { $0.id.hasPrefix("en") }.count == 1)
        #expect(locale.available.first?.id == "en_US")
        #expect(locale.available.first?.name == String(
            format: String(localized: "%@ (System)"), "English (United States)"))
    }

    @Test func `system locale remains selectable without an advertised speech locale`() {
        let locale = VoiceWakeDeviceOptions.localeSettings(
            primary: "system",
            additional: ["unknown", ""],
            systemLocale: Locale(identifier: "en_US@collation=phonebook"),
            supportedLocales: [])
        #expect(locale.primary == "en_US@collation=phonebook")
        #expect(locale.available.map(\.id) == [locale.primary])
        #expect(locale.additional.isEmpty)
    }

    @Test func `additional locales resolve available aliases and drop unavailable ids`() {
        let locale = VoiceWakeDeviceOptions.localeSettings(
            primary: "",
            additional: ["de_DE", "unknown", "en-US", "", "system", "ms_MY"],
            systemLocale: Locale(identifier: "en_US"),
            supportedLocales: [Locale(identifier: "de-DE"), Locale(identifier: "ms_MY")])
        #expect(locale.additional == ["de-DE", "en_US", "ms_MY"])
        #expect(locale.additional.allSatisfy { id in locale.available.contains { $0.id == id } })
    }
}
