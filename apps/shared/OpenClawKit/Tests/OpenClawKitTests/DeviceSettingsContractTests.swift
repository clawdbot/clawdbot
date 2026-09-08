import Foundation
import OpenClawKit
import Testing

struct DeviceSettingsContractTests {
    @Test func `Chrome extension setup accepts only the exact action payload`() {
        #expect(DeviceSettingsRequest(body: ["type": "install-chrome-extension"]) == .installChromeExtension)
        #expect(DeviceSettingsRequest(body: ["type": "install-chrome-extension", "command": "other"]) == nil)
    }

    @Test(arguments: ["macos", "ios"])
    func `snapshots match the exact platform wire contract`(_ platform: String) throws {
        let snapshot = platform == "macos" ? Self.macSnapshot() : Self.iosSnapshot()
        let encoded = try JSONEncoder().encode(snapshot)
        let actual = try #require(JSONSerialization.jsonObject(with: encoded) as? NSDictionary)
        let fixture = try #require(Bundle.module.url(
            forResource: platform, withExtension: "json", subdirectory: "Fixtures/DeviceSettings"))
        let expected = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? NSDictionary)
        // Exact dictionary equality rejects extra keys as well as missing keys at every nesting level.
        #expect(actual == expected)
    }

    @Test func `unsupported families and fields are omitted instead of encoded as null`() throws {
        let snapshot = DeviceSettingsSnapshot(
            device: .init(platform: .ios, formFactor: .pad, appVersion: "1", appBuild: "2"),
            app: .init(), capabilities: .init(),
            permissions: .init(entries: [], location: .init(mode: .off, precise: false)),
            voice: .init(supported: false, wakeEnabled: false))
        let data = try JSONEncoder().encode(snapshot)
        let actual = try #require(JSONSerialization.jsonObject(with: data) as? NSDictionary)
        let expected = try #require(JSONSerialization.jsonObject(with: Data("""
        {"contract":1,"device":{"platform":"ios","formFactor":"pad","appVersion":"1","appBuild":"2","profileName":null},
         "app":{},"capabilities":{},"permissions":{"entries":[],"location":{"mode":"off","precise":false}},
         "voice":{"supported":false,"wakeEnabled":false}}
        """.utf8)) as? NSDictionary)
        #expect(actual == expected)
    }

    @Test(arguments: ["contacts", "calendars", "reminders", "photos"])
    func `iOS permissions keep their bridge identities`(_ id: String) throws {
        let permission = try #require(DeviceSettingsPermission(rawValue: id))
        #expect(DeviceSettingsRequest(body: ["type": "request-permission", "id": id]) ==
            .requestPermission(permission))
        #expect(DeviceSettingsRequest(body: ["type": "open-system-settings", "id": id]) ==
            .openSystemSettings(permission))
    }

    @Test func `published JavaScript assigns the global then dispatches the exact event with escaped values`() throws {
        let script = try Self.macSnapshot(withNullableValues: true).javaScript()
        let prefix = "window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__ = "
        let suffix = "; window.dispatchEvent(new CustomEvent('openclaw:native-device-settings-changed', " +
            "{detail: window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__}));"
        try #require(script.hasPrefix(prefix))
        try #require(script.hasSuffix(suffix))
        let json = script.dropFirst(prefix.count).dropLast(suffix.count)
        let payload = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let device = try #require(payload["device"] as? [String: Any])
        let app = try #require(payload["app"] as? [String: Any])
        let browser = try #require(payload["browser"] as? [String: Any])
        let cookieSync = try #require(browser["cookieSync"] as? [String: Any])
        let voice = try #require(payload["voice"] as? [String: Any])
        let microphone = try #require(voice["microphone"] as? [String: Any])
        let updates = try #require(payload["updates"] as? [String: Any])
        #expect(device["profileName"] as? String == "fixture-profile")
        #expect(app["quickChatShortcut"] as? String == "⌥Space")
        #expect(cookieSync["detail"] as? String == "Sync 'fixture' \\\"quoted\\\"\nnext line")
        #expect(microphone["selectedId"] as? String == "fixture-mic")
        #expect(updates["unavailableReason"] as? String == "Updates are unavailable for this fixture.")
    }

    private static func macSnapshot(withNullableValues: Bool = false) -> DeviceSettingsSnapshot {
        DeviceSettingsSnapshot(
            device: .init(
                appVersion: "2026.9.3",
                appBuild: "123",
                profileName: withNullableValues ? "fixture-profile" : nil),
            app: .init(
                showDockIcon: true,
                iconStyle: .init(selectedId: "paper", available: [
                    .init(id: "paper", name: "Original"), .init(id: "origami", name: "Origami"),
                ]),
                iconAnimationsEnabled: false, launchAtLogin: true, launchAtLoginAvailable: false,
                quickChatEnabled: true, quickChatShortcut: .some(withNullableValues ? "⌥Space" : nil),
                debugPaneEnabled: false),
            capabilities: .init(
                canvasEnabled: true, cameraEnabled: false, computerControlEnabled: true, computerControlProvider: "cua",
                cuaDriverBundled: true, peekabooBridgeEnabled: false, activeComputerPresenceEnabled: true),
            browser: .init(
                importAvailable: false,
                cookieSync: .init(
                    available: true, enabled: true, domains: ["example.test"], targetProfile: "fixture", state: .idle,
                    detail: withNullableValues ? "Sync 'fixture' \\\"quoted\\\"\nnext line" : nil)),
            permissions: .init(
                entries: [
                    .init(id: .notifications, status: .granted), .init(id: .accessibility, status: .denied),
                    .init(id: .screenRecording, status: .notDetermined), .init(id: .microphone, status: .unavailable),
                    .init(id: .camera, status: .granted), .init(id: .speechRecognition, status: .denied),
                    .init(id: .location, status: .notDetermined), .init(id: .automation, status: .unavailable),
                ],
                location: .init(mode: .whileUsing, precise: true)),
            voice: .init(
                supported: true, wakeEnabled: false, wakeTriggersTalkMode: true, pushToTalkEnabled: false,
                talkPhaseSoundsEnabled: true, talkShiftToStopEnabled: false, realtimeRelayEnabled: true,
                triggerChime: false, sendChime: true,
                microphone: .init(
                    selectedId: withNullableValues ? "fixture-mic" : nil,
                    devices: [.init(id: "fixture-mic", name: "Fixture Microphone")]),
                locale: .init(
                    primary: "en-US", additional: ["de-DE"],
                    available: [.init(id: "en-US", name: "English (United States)")])),
            updates: .init(
                available: false, automatic: true,
                unavailableReason: withNullableValues ? "Updates are unavailable for this fixture." : nil))
    }

    private static func iosSnapshot() -> DeviceSettingsSnapshot {
        DeviceSettingsSnapshot(
            device: .init(
                platform: .ios, formFactor: .phone, appVersion: "2026.9.5", appBuild: "456", modelName: "iPhone 17"),
            app: .init(appearance: .system, notificationsEnabled: true),
            capabilities: .init(
                cameraEnabled: false, keepAwakeEnabled: true, healthSummaryAvailable: true,
                healthSummaryEnabled: false),
            permissions: .init(
                entries: [
                    .init(id: .notifications, status: .granted), .init(id: .camera, status: .denied),
                    .init(id: .microphone, status: .notDetermined), .init(id: .speechRecognition, status: .unavailable),
                    .init(id: .location, status: .granted), .init(id: .contacts, status: .limited),
                    .init(id: .calendars, status: .denied), .init(id: .reminders, status: .notDetermined),
                    .init(id: .photos, status: .limited),
                ],
                location: .init(mode: .whileUsing, precise: false, preciseEditable: false)),
            voice: .init(
                supported: true, wakeEnabled: false, talkEnabled: true, talkButtonEnabled: true,
                talkBackgroundEnabled: false, speakerphoneEnabled: true))
    }
}
