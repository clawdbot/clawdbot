import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct DeviceSettingsConsentTests {
    @Test func `sensitive enable requests need consent and disabling does not`() throws {
        let sensitive: [DeviceSettingKey: DeviceSettingsConsent] = [
            .cookieSyncEnabled: .cookieSync,
            .computerControlEnabled: .computerControl,
            .peekabooBridgeEnabled: .peekabooBridge,
            .cameraEnabled: .camera,
            .activeComputerPresenceEnabled: .activityReporting,
            .wakeEnabled: .voiceWake,
            .locationPrecise: .preciseLocation,
        ]
        for key in DeviceSettingKey.allCases {
            guard DeviceSettingsRequest(body: ["type": "set", "key": key.rawValue, "value": true]) ==
                .set(key, .boolean(true)) else { continue }
            #expect(try self.consent(key, raw: true) == sensitive[key], "Enable \(key.rawValue)")
            #expect(try self.consent(key, raw: false) == nil, "Disable \(key.rawValue)")
        }
    }

    @Test func `location increases need consent but unchanged access and decreases do not`() throws {
        let transitions: [(DeviceSettingsLocationMode, DeviceSettingsLocationMode, DeviceSettingsConsent?)] = [
            (.off, .off, nil),
            (.off, .whileUsing, .locationWhileUsing),
            (.off, .always, .locationAlways),
            (.whileUsing, .off, nil),
            (.whileUsing, .whileUsing, nil),
            (.whileUsing, .always, .locationAlways),
            (.always, .off, nil),
            (.always, .whileUsing, nil),
            (.always, .always, nil),
        ]
        for (current, requested, expected) in transitions {
            #expect(
                try self.consent(
                    .locationMode, raw: requested.rawValue, locationMode: current) == expected,
                "Location \(current.rawValue) -> \(requested.rawValue)")
        }
    }

    @Test func `cookie domain additions require consent even before sync is enabled`() throws {
        for enabled in [true, false] {
            #expect(try self.consent(
                .cookieSyncDomains, raw: [" example.com, NEW.example ", "new.example"],
                enabled: enabled) == .cookieDomains(["NEW.example"]))
            for domains in [[], ["EXAMPLE.COM"], [" example.com,example.com "]] {
                #expect(try self.consent(.cookieSyncDomains, raw: domains, enabled: enabled) == nil)
            }
        }
    }

    @Test func `only active cookie destination changes require consent`() throws {
        #expect(try self.consent(.cookieSyncTargetProfile, raw: " work ") == .cookieProfile("work"))
        for profile in ["", "  ", "imported", " imported "] {
            #expect(try self.consent(.cookieSyncTargetProfile, raw: profile) == nil)
        }
        #expect(try self.consent(.cookieSyncTargetProfile, raw: "work", enabled: false) == nil)
    }

    @Test func `other typed settings apply without native consent`() throws {
        let settings: [(DeviceSettingKey, Any)] = [
            (.computerControlProvider, "cua"),
            (.computerControlProvider, "peekaboo"),
            (.microphone, "test-input"),
            (.microphone, NSNull()),
            (.localePrimary, "en-US"),
            (.localeAdditional, ["de-DE"]),
        ]
        for (key, raw) in settings {
            #expect(try self.consent(key, raw: raw) == nil)
        }
    }

    private func consent(
        _ key: DeviceSettingKey, raw: Any,
        enabled: Bool = true,
        locationMode: DeviceSettingsLocationMode = .off) throws -> DeviceSettingsConsent?
    {
        let request = try #require(DeviceSettingsRequest(body: ["type": "set", "key": key.rawValue, "value": raw]))
        guard case let .set(parsedKey, value) = request else {
            Issue.record("Expected a parsed set request")
            return nil
        }
        return DeviceSettingsConsent.required(
            for: parsedKey, value: value,
            cookieSyncEnabled: enabled, cookieDomains: ["example.com"], cookieProfile: "imported",
            locationMode: locationMode)
    }
}
