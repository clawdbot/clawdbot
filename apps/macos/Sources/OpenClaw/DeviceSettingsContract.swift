import CoreFoundation
import Foundation
import OpenClawIPC
import OpenClawKit

enum DeviceSettingValue: Equatable {
    case boolean(Bool)
    case string(String)
    case strings([String])
    case null
}

enum DeviceSettingKey: String, CaseIterable {
    case showDockIcon = "app.showDockIcon"
    case iconStyle = "app.iconStyle"
    case iconAnimationsEnabled = "app.iconAnimationsEnabled"
    case launchAtLogin = "app.launchAtLogin"
    case quickChatEnabled = "app.quickChatEnabled"
    case debugPaneEnabled = "app.debugPaneEnabled"
    case canvasEnabled = "capabilities.canvasEnabled"
    case cameraEnabled = "capabilities.cameraEnabled"
    case computerControlEnabled = "capabilities.computerControlEnabled"
    case computerControlProvider = "capabilities.computerControlProvider"
    case peekabooBridgeEnabled = "capabilities.peekabooBridgeEnabled"
    case activeComputerPresenceEnabled = "capabilities.activeComputerPresenceEnabled"
    case cookieSyncEnabled = "browser.cookieSync.enabled"
    case cookieSyncDomains = "browser.cookieSync.domains"
    case cookieSyncTargetProfile = "browser.cookieSync.targetProfile"
    case locationMode = "permissions.location.mode"
    case locationPrecise = "permissions.location.precise"
    case wakeEnabled = "voice.wakeEnabled"
    case wakeTriggersTalkMode = "voice.wakeTriggersTalkMode"
    case pushToTalkEnabled = "voice.pushToTalkEnabled"
    case talkPhaseSoundsEnabled = "voice.talkPhaseSoundsEnabled"
    case talkShiftToStopEnabled = "voice.talkShiftToStopEnabled"
    case realtimeRelayEnabled = "voice.realtimeRelayEnabled"
    case triggerChime = "voice.triggerChime"
    case sendChime = "voice.sendChime"
    case microphone = "voice.microphone"
    case localePrimary = "voice.locale.primary"
    case localeAdditional = "voice.locale.additional"
    case automaticUpdates = "updates.automatic"

    enum ValueType {
        case boolean, string, strings, nullableString, provider, location, iconStyle
    }

    var valueType: ValueType {
        switch self {
        case .computerControlProvider: .provider
        case .locationMode: .location
        case .iconStyle: .iconStyle
        case .cookieSyncTargetProfile, .localePrimary: .string
        case .cookieSyncDomains, .localeAdditional: .strings
        case .microphone: .nullableString
        default: .boolean
        }
    }

    func value(from raw: Any) -> DeviceSettingValue? {
        switch self.valueType {
        case .boolean:
            // WKWebView bridges both numbers and booleans as NSNumber. A numeric 0/1 is not a toggle.
            guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
            return .boolean(number.boolValue)
        case .strings:
            guard let values = raw as? [String] else { return nil }
            return .strings(values)
        case .nullableString where raw is NSNull:
            return .null
        case .string, .nullableString, .provider, .location, .iconStyle:
            guard let value = raw as? String else { return nil }
            if self.valueType == .provider, ComputerControlProvider(rawValue: value) == nil { return nil }
            if self.valueType == .location, DeviceSettingsLocationMode(rawValue: value) == nil { return nil }
            if self.valueType == .iconStyle, AppIconStyle(rawValue: value) == nil { return nil }
            return .string(value)
        }
    }
}

enum DeviceSettingsPanel: String, CaseIterable {
    case quickChatShortcut = "quick-chat-shortcut"
    case microphoneTest = "microphone-test"
    case browserImport = "browser-import"
    case connection, gateways, debug
}

enum DeviceSettingsPermission: String, CaseIterable, Encodable {
    case notifications, accessibility, screenRecording, microphone
    case camera, speechRecognition, location, automation

    var capability: Capability {
        switch self {
        case .notifications: .notifications
        case .accessibility: .accessibility
        case .screenRecording: .screenRecording
        case .microphone: .microphone
        case .camera: .camera
        case .speechRecognition: .speechRecognition
        case .location: .location
        case .automation: .appleScript
        }
    }
}

enum DeviceSettingsPermissionStatus: String, Encodable {
    case granted, denied, notDetermined, unavailable

    init(_ status: CapabilityAuthorizationStatus?) {
        switch status {
        case .granted: self = .granted
        case .notGranted: self = .denied
        case .unknown, nil: self = .unavailable
        }
    }
}

enum DeviceSettingsLocationMode: String, CaseIterable, Encodable {
    case off, whileUsing, always

    init(_ mode: OpenClawLocationMode) {
        switch mode {
        case .off: self = .off
        case .whileUsing: self = .whileUsing
        case .always: self = .always
        }
    }

    var nativeMode: OpenClawLocationMode {
        switch self {
        case .off: .off
        case .whileUsing: .whileUsing
        case .always: .always
        }
    }
}

enum DeviceSettingsRequest: Equatable {
    case status
    case set(DeviceSettingKey, DeviceSettingValue)
    case requestPermission(DeviceSettingsPermission)
    case openSystemSettings(DeviceSettingsPermission)
    case open(DeviceSettingsPanel)
    case checkForUpdates

    init?(body: Any) {
        guard let payload = body as? [String: Any], let type = payload["type"] as? String else { return nil }
        switch type {
        case "status": self = .status
        case "set":
            guard let rawKey = payload["key"] as? String, let key = DeviceSettingKey(rawValue: rawKey),
                  let rawValue = payload["value"], let value = key.value(from: rawValue)
            else { return nil }
            self = .set(key, value)
        case "request-permission", "open-system-settings":
            guard let rawID = payload["id"] as? String, let id = DeviceSettingsPermission(rawValue: rawID)
            else { return nil }
            self = type == "request-permission" ? .requestPermission(id) : .openSystemSettings(id)
        case "open":
            guard let rawPanel = payload["panel"] as? String, let panel = DeviceSettingsPanel(rawValue: rawPanel)
            else { return nil }
            self = .open(panel)
        case "check-for-updates": self = .checkForUpdates
        default: return nil
        }
    }
}

struct DeviceSettingsSnapshot: Encodable {
    let contract = 1
    let device: Device
    let app: App
    let capabilities: Capabilities
    let browser: Browser
    let permissions: Permissions
    let voice: Voice
    let updates: Updates

    struct Device: Encodable {
        let platform = "macos"
        let appVersion: String
        let appBuild: String
        let profileName: String?

        enum CodingKeys: CodingKey { case platform, appVersion, appBuild, profileName }

        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(self.platform, forKey: .platform)
            try values.encode(self.appVersion, forKey: .appVersion)
            try values.encode(self.appBuild, forKey: .appBuild)
            try values.encode(self.profileName, forKey: .profileName)
        }
    }

    struct App: Encodable {
        struct IconStyle: Encodable {
            struct Option: Encodable {
                let id: String
                let name: String
            }

            let selectedId: String
            let available: [Option]
        }

        let showDockIcon: Bool
        let iconStyle: IconStyle
        let iconAnimationsEnabled: Bool
        let launchAtLogin: Bool
        let launchAtLoginAvailable: Bool
        let quickChatEnabled: Bool
        let quickChatShortcut: String?
        let debugPaneEnabled: Bool

        enum CodingKeys: CodingKey {
            case showDockIcon, iconStyle, iconAnimationsEnabled, launchAtLogin, launchAtLoginAvailable
            case quickChatEnabled, quickChatShortcut, debugPaneEnabled
        }

        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(self.showDockIcon, forKey: .showDockIcon)
            try values.encode(self.iconStyle, forKey: .iconStyle)
            try values.encode(self.iconAnimationsEnabled, forKey: .iconAnimationsEnabled)
            try values.encode(self.launchAtLogin, forKey: .launchAtLogin)
            try values.encode(self.launchAtLoginAvailable, forKey: .launchAtLoginAvailable)
            try values.encode(self.quickChatEnabled, forKey: .quickChatEnabled)
            try values.encode(self.quickChatShortcut, forKey: .quickChatShortcut)
            try values.encode(self.debugPaneEnabled, forKey: .debugPaneEnabled)
        }
    }

    struct Capabilities: Encodable {
        let canvasEnabled: Bool
        let cameraEnabled: Bool
        let computerControlEnabled: Bool
        let computerControlProvider: String
        let cuaDriverBundled: Bool
        let peekabooBridgeEnabled: Bool
        let activeComputerPresenceEnabled: Bool
    }

    struct Browser: Encodable {
        let importAvailable: Bool
        let cookieSync: CookieSync
    }

    struct CookieSync: Encodable {
        enum State: String, Encodable { case off, idle, running, error }
        let available: Bool
        let enabled: Bool
        let domains: [String]
        let targetProfile: String
        let state: State
        let detail: String?

        enum CodingKeys: CodingKey { case available, enabled, domains, targetProfile, state, detail }

        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(self.available, forKey: .available)
            try values.encode(self.enabled, forKey: .enabled)
            try values.encode(self.domains, forKey: .domains)
            try values.encode(self.targetProfile, forKey: .targetProfile)
            try values.encode(self.state, forKey: .state)
            try values.encode(self.detail, forKey: .detail)
        }
    }

    struct Permissions: Encodable {
        struct Entry: Encodable {
            let id: DeviceSettingsPermission
            let status: DeviceSettingsPermissionStatus
        }

        struct Location: Encodable {
            let mode: DeviceSettingsLocationMode
            let precise: Bool
        }

        let entries: [Entry]
        let location: Location
    }

    struct Voice: Encodable {
        let supported: Bool
        let wakeEnabled: Bool
        let wakeTriggersTalkMode: Bool
        let pushToTalkEnabled: Bool
        let talkPhaseSoundsEnabled: Bool
        let talkShiftToStopEnabled: Bool
        let realtimeRelayEnabled: Bool
        let triggerChime: Bool
        let sendChime: Bool
        let microphone: Microphone
        let locale: Locale

        struct Microphone: Encodable {
            let selectedId: String?
            let devices: [VoiceWakeDeviceOptions.Option]

            enum CodingKeys: CodingKey { case selectedId, devices }

            func encode(to encoder: Encoder) throws {
                var values = encoder.container(keyedBy: CodingKeys.self)
                try values.encode(self.selectedId, forKey: .selectedId)
                try values.encode(self.devices, forKey: .devices)
            }
        }

        struct Locale: Encodable {
            let primary: String
            let additional: [String]
            let available: [VoiceWakeDeviceOptions.Option]
        }
    }

    struct Updates: Encodable {
        let available: Bool
        let automatic: Bool
        let unavailableReason: String?

        enum CodingKeys: CodingKey { case available, automatic, unavailableReason }

        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(self.available, forKey: .available)
            try values.encode(self.automatic, forKey: .automatic)
            try values.encode(self.unavailableReason, forKey: .unavailableReason)
        }
    }

    func javaScript() throws -> String {
        let data = try JSONEncoder().encode(self)
        let json = String(bytes: data, encoding: .utf8)!
        return "window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__ = \(json); " +
            "window.dispatchEvent(new CustomEvent('openclaw:native-device-settings-changed', " +
            "{detail: window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__}));"
    }
}
