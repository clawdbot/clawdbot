import Foundation
import OpenClawIPC
import OpenClawKit
import Testing
@testable import OpenClaw

struct DeviceSettingsBridgeTests {
    private static let toggleKeys: [(String, DeviceSettingKey)] = [
        ("app.notificationsEnabled", .notificationsEnabled),
        ("capabilities.keepAwakeEnabled", .keepAwakeEnabled),
        ("capabilities.healthSummaryEnabled", .healthSummaryEnabled),
        ("voice.talkEnabled", .talkEnabled),
        ("voice.talkButtonEnabled", .talkButtonEnabled),
        ("voice.talkBackgroundEnabled", .talkBackgroundEnabled),
        ("voice.speakerphoneEnabled", .speakerphoneEnabled),
        ("app.showDockIcon", .showDockIcon),
        ("app.iconAnimationsEnabled", .iconAnimationsEnabled),
        ("app.launchAtLogin", .launchAtLogin),
        ("app.quickChatEnabled", .quickChatEnabled),
        ("app.debugPaneEnabled", .debugPaneEnabled),
        ("capabilities.canvasEnabled", .canvasEnabled),
        ("capabilities.cameraEnabled", .cameraEnabled),
        ("capabilities.computerControlEnabled", .computerControlEnabled),
        ("capabilities.peekabooBridgeEnabled", .peekabooBridgeEnabled),
        ("capabilities.activeComputerPresenceEnabled", .activeComputerPresenceEnabled),
        ("browser.cookieSync.enabled", .cookieSyncEnabled),
        ("permissions.location.precise", .locationPrecise),
        ("voice.wakeEnabled", .wakeEnabled),
        ("voice.wakeTriggersTalkMode", .wakeTriggersTalkMode),
        ("voice.pushToTalkEnabled", .pushToTalkEnabled),
        ("voice.talkPhaseSoundsEnabled", .talkPhaseSoundsEnabled),
        ("voice.talkShiftToStopEnabled", .talkShiftToStopEnabled),
        ("voice.realtimeRelayEnabled", .realtimeRelayEnabled),
        ("voice.triggerChime", .triggerChime),
        ("voice.sendChime", .sendChime),
        ("updates.automatic", .automaticUpdates),
    ]

    @Test func `toggle setters accept JSON booleans and reject numeric coercion`() throws {
        for (wireKey, key) in Self.toggleKeys {
            for value in [false, true] {
                let body = try JSONSerialization.jsonObject(with: Data(
                    "{\"type\":\"set\",\"key\":\"\(wireKey)\",\"value\":\(value)}".utf8))
                #expect(DeviceSettingsRequest(body: body) == .set(key, .boolean(value)))
            }
            for invalidJSON in ["0", "1", "0.0", "1.0", "\"true\"", "null", "[]", "{}"] {
                let body = try JSONSerialization.jsonObject(with: Data(
                    "{\"type\":\"set\",\"key\":\"\(wireKey)\",\"value\":\(invalidJSON)}".utf8))
                #expect(DeviceSettingsRequest(body: body) == nil)
            }
        }
    }

    @Test func `typed setters accept the frozen strings arrays and nullable microphone`() {
        let cases: [(String, Any, DeviceSettingsRequest)] = [
            ("app.appearance", "system", .set(.appearance, .string("system"))),
            ("app.appearance", "light", .set(.appearance, .string("light"))),
            ("app.appearance", "dark", .set(.appearance, .string("dark"))),
            ("app.iconStyle", "paper", .set(.iconStyle, .string("paper"))),
            ("app.iconStyle", "heritage", .set(.iconStyle, .string("heritage"))),
            ("app.iconStyle", "clawmark", .set(.iconStyle, .string("clawmark"))),
            ("app.iconStyle", "origami", .set(.iconStyle, .string("origami"))),
            ("app.iconStyle", "pincer", .set(.iconStyle, .string("pincer"))),
            ("app.iconStyle", "openC", .set(.iconStyle, .string("openC"))),
            ("capabilities.computerControlProvider", "peekaboo", .set(.computerControlProvider, .string("peekaboo"))),
            ("capabilities.computerControlProvider", "cua", .set(.computerControlProvider, .string("cua"))),
            ("browser.cookieSync.domains", ["example.test"], .set(.cookieSyncDomains, .strings(["example.test"]))),
            ("browser.cookieSync.domains", [String](), .set(.cookieSyncDomains, .strings([]))),
            ("browser.cookieSync.targetProfile", "work", .set(.cookieSyncTargetProfile, .string("work"))),
            ("permissions.location.mode", "off", .set(.locationMode, .string("off"))),
            ("permissions.location.mode", "whileUsing", .set(.locationMode, .string("whileUsing"))),
            ("permissions.location.mode", "always", .set(.locationMode, .string("always"))),
            ("voice.microphone", "fixture-mic", .set(.microphone, .string("fixture-mic"))),
            ("voice.microphone", NSNull(), .set(.microphone, .null)),
            ("voice.locale.primary", "en-US", .set(.localePrimary, .string("en-US"))),
            ("voice.locale.additional", ["de-DE"], .set(.localeAdditional, .strings(["de-DE"]))),
            ("voice.locale.additional", [String](), .set(.localeAdditional, .strings([]))),
        ]
        for (key, value, expected) in cases {
            #expect(DeviceSettingsRequest(body: ["type": "set", "key": key, "value": value]) == expected)
        }
    }

    @Test func `setters reject unknown keys wrong types and noncanonical enum values`() {
        let invalid: [(String, Any)] = [
            ("app.appearance", "automatic"),
            ("app.appearance", "Dark"),
            ("app.iconStyle", "Original"),
            ("app.iconStyle", "openc"),
            ("app.iconStyle", ["paper"]),
            ("app.quickChatShortcut", "⌥Space"),
            ("app.launchAtLoginAvailable", true),
            ("capabilities.cuaDriverBundled", true),
            ("voice.supported", true),
            ("voice.triggerWords", ["computer"]),
            ("gateway.auth.token", "fixture"),
            ("unknown", true),
            ("capabilities.computerControlProvider", "automatic"),
            ("capabilities.computerControlProvider", "CUA"),
            ("permissions.location.mode", "while-using"),
            ("permissions.location.mode", "authorizedAlways"),
            ("browser.cookieSync.domains", "example.test"),
            ("browser.cookieSync.domains", ["example.test", 1]),
            ("voice.locale.additional", "en-US"),
            ("voice.locale.additional", ["en-US", NSNull()]),
            ("voice.microphone", ["fixture-mic"]),
            ("voice.locale.primary", ["en-US"]),
            ("browser.cookieSync.targetProfile", ["work"]),
        ]
        for (key, value) in invalid {
            #expect(DeviceSettingsRequest(body: ["type": "set", "key": key, "value": value]) == nil)
        }
        let typedKeys = [
            "app.appearance", "app.iconStyle",
            "capabilities.computerControlProvider", "permissions.location.mode", "browser.cookieSync.domains",
            "browser.cookieSync.targetProfile", "voice.microphone", "voice.locale.primary", "voice.locale.additional",
        ]
        #expect(Set(DeviceSettingKey.allCases.map(\.rawValue)) == Set(Self.toggleKeys.map(\.0) + typedKeys))
        let invalidScalars: [Any] = [true, NSNumber(value: 1)]
        for key in typedKeys {
            for value in invalidScalars {
                #expect(DeviceSettingsRequest(body: ["type": "set", "key": key, "value": value]) == nil)
            }
            if key != "voice.microphone" {
                #expect(DeviceSettingsRequest(body: ["type": "set", "key": key, "value": NSNull()]) == nil)
            }
            #expect(DeviceSettingsRequest(body: ["type": "set", "key": key]) == nil)
        }
    }

    @Test func `action requests retain the closed panel and permission identities`() {
        #expect(DeviceSettingsRequest(body: ["type": "status"]) == .status)
        #expect(DeviceSettingsRequest(body: ["type": "check-for-updates"]) == .checkForUpdates)
        #expect(DeviceSettingsRequest(body: ["type": "install-chrome-extension"]) == .installChromeExtension)
        #expect(DeviceSettingsRequest(body: ["type": "install-chrome-extension", "command": "other"]) == nil)
        let panels: [(String, DeviceSettingsPanel)] = [
            ("quick-chat-shortcut", .quickChatShortcut), ("microphone-test", .microphoneTest),
            ("browser-import", .browserImport), ("connection", .connection), ("gateways", .gateways), ("debug", .debug),
            ("diagnostics", .diagnostics), ("licenses", .licenses), ("about", .about), ("watch", .watch),
        ]
        #expect(Set(DeviceSettingsPanel.allCases.map(\.rawValue)) == Set(panels.map(\.0)))
        for (name, panel) in panels {
            #expect(DeviceSettingsRequest(body: ["type": "open", "panel": name]) == .open(panel))
        }
        let permissions: [(String, DeviceSettingsPermission, Capability)] = [
            ("notifications", .notifications, .notifications),
            ("accessibility", .accessibility, .accessibility),
            ("screenRecording", .screenRecording, .screenRecording),
            ("microphone", .microphone, .microphone),
            ("camera", .camera, .camera),
            ("speechRecognition", .speechRecognition, .speechRecognition),
            ("location", .location, .location),
            ("automation", .automation, .appleScript),
        ]
        #expect(DeviceSettingsPermission.macOSPermissions.map(\.rawValue) == permissions.map(\.0))
        for permission in [DeviceSettingsPermission.contacts, .calendars, .reminders, .photos] {
            #expect(permission.capability == nil)
            #expect(DeviceSettingsRequest(body: ["type": "request-permission", "id": permission.rawValue]) ==
                .requestPermission(permission))
        }
        for (name, permission, capability) in permissions {
            #expect(DeviceSettingsRequest(body: ["type": "request-permission", "id": name]) ==
                .requestPermission(permission))
            #expect(DeviceSettingsRequest(body: ["type": "open-system-settings", "id": name]) ==
                .openSystemSettings(permission))
            #expect(permission.capability == capability)
        }
    }

    @Test func `malformed actions never select a default native panel or permission`() {
        let invalid: [Any] = [
            "status", NSNull(), [String: Any](), ["type": true], ["type": "unknown"],
            ["type": "set", "value": true], ["type": "set", "key": 1, "value": true],
            ["type": "open"], ["type": "open", "panel": "settings"], ["type": "open", "panel": true],
            ["type": "request-permission"], ["type": "request-permission", "id": "appleScript"],
            ["type": "request-permission", "id": "screen-recording"],
            ["type": "open-system-settings", "id": "unknown"],
            ["type": "open-system-settings", "id": NSNull()],
        ]
        for body in invalid {
            #expect(DeviceSettingsRequest(body: body) == nil)
        }
    }

    @Test func `location and permission statuses encode their web spellings`() throws {
        let locations: [(OpenClawLocationMode, String)] = [
            (.off, "off"), (.whileUsing, "whileUsing"), (.always, "always"),
        ]
        for (native, wire) in locations {
            let mapped = DeviceSettingsLocationMode(native)
            #expect(mapped.nativeMode == native)
            #expect(try String(decoding: JSONEncoder().encode(mapped), as: UTF8.self) == "\"\(wire)\"")
        }
        #expect(DeviceSettingsPermissionStatus(.granted) == .granted)
        #expect(DeviceSettingsPermissionStatus(.notGranted) == .denied)
        #expect(DeviceSettingsPermissionStatus(.unknown) == .unavailable)
        #expect(DeviceSettingsPermissionStatus(nil) == .unavailable)
        let statuses: [DeviceSettingsPermissionStatus] = [.granted, .denied, .notDetermined, .unavailable, .limited]
        let data = try JSONEncoder().encode(statuses)
        #expect(try JSONSerialization.jsonObject(with: data) as? [String] ==
            ["granted", "denied", "notDetermined", "unavailable", "limited"])
    }
}
