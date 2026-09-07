import CoreFoundation
import Foundation

public enum DeviceSettingValue: Equatable, Sendable {
    case boolean(Bool)
    case string(String)
    case strings([String])
    case null
}

public enum DeviceSettingKey: String, CaseIterable, Sendable {
    case appearance = "app.appearance"
    case notificationsEnabled = "app.notificationsEnabled"
    case showDockIcon = "app.showDockIcon"
    case iconStyle = "app.iconStyle"
    case iconAnimationsEnabled = "app.iconAnimationsEnabled"
    case launchAtLogin = "app.launchAtLogin"
    case quickChatEnabled = "app.quickChatEnabled"
    case debugPaneEnabled = "app.debugPaneEnabled"
    case keepAwakeEnabled = "capabilities.keepAwakeEnabled"
    case healthSummaryEnabled = "capabilities.healthSummaryEnabled"
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
    case talkEnabled = "voice.talkEnabled"
    case talkButtonEnabled = "voice.talkButtonEnabled"
    case talkBackgroundEnabled = "voice.talkBackgroundEnabled"
    case speakerphoneEnabled = "voice.speakerphoneEnabled"
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

    private enum ValueType {
        case boolean, string, strings, nullableString, provider, location, iconStyle, appearance
    }

    private var valueType: ValueType {
        switch self {
        case .appearance: .appearance
        case .computerControlProvider: .provider
        case .locationMode: .location
        case .iconStyle: .iconStyle
        case .cookieSyncTargetProfile, .localePrimary: .string
        case .cookieSyncDomains, .localeAdditional: .strings
        case .microphone: .nullableString
        default: .boolean
        }
    }

    public func value(from raw: Any) -> DeviceSettingValue? {
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
        case .string, .nullableString, .provider, .location, .iconStyle, .appearance:
            guard let value = raw as? String else { return nil }
            if self.valueType == .provider, !["peekaboo", "cua"].contains(value) { return nil }
            if self.valueType == .location, DeviceSettingsLocationMode(rawValue: value) == nil { return nil }
            if self.valueType == .iconStyle,
               !["paper", "heritage", "clawmark", "origami", "pincer", "openC"].contains(value) { return nil }
            if self.valueType == .appearance, DeviceSettingsAppearance(rawValue: value) == nil { return nil }
            return .string(value)
        }
    }
}

public enum DeviceSettingsPanel: String, CaseIterable, Sendable {
    case quickChatShortcut = "quick-chat-shortcut"
    case microphoneTest = "microphone-test"
    case browserImport = "browser-import"
    case connection, gateways, debug, diagnostics, licenses, about, watch
}

public enum DeviceSettingsPermission: String, CaseIterable, Encodable, Sendable {
    case notifications, accessibility, screenRecording, microphone
    case camera, speechRecognition, location, automation
    case contacts, calendars, reminders, photos
}

public enum DeviceSettingsPermissionStatus: String, Encodable, Sendable {
    case granted, denied, notDetermined, unavailable, limited
}

public enum DeviceSettingsAppearance: String, Encodable, Sendable {
    case system, light, dark
}

public enum DeviceSettingsLocationMode: String, CaseIterable, Encodable, Sendable {
    case off, whileUsing, always

    public init(_ mode: OpenClawLocationMode) {
        switch mode {
        case .off: self = .off
        case .whileUsing: self = .whileUsing
        case .always: self = .always
        }
    }

    public var nativeMode: OpenClawLocationMode {
        switch self {
        case .off: .off
        case .whileUsing: .whileUsing
        case .always: .always
        }
    }
}

public enum DeviceSettingsRequest: Equatable, Sendable {
    case status
    case set(DeviceSettingKey, DeviceSettingValue)
    case requestPermission(DeviceSettingsPermission)
    case openSystemSettings(DeviceSettingsPermission)
    case open(DeviceSettingsPanel)
    case checkForUpdates
    case installChromeExtension

    public init?(body: Any) {
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
        case "install-chrome-extension":
            guard payload.count == 1 else { return nil }
            self = .installChromeExtension
        default: return nil
        }
    }
}

public struct DeviceSettingsSnapshot: Encodable, Sendable {
    public let contract = 1
    public let device: Device
    public let app: App?
    public let capabilities: Capabilities?
    public let browser: Browser?
    public let permissions: Permissions
    public let voice: Voice
    public let updates: Updates?

    public init(
        device: Device,
        app: App? = nil,
        capabilities: Capabilities? = nil,
        browser: Browser? = nil,
        permissions: Permissions,
        voice: Voice,
        updates: Updates? = nil)
    {
        self.device = device
        self.app = app
        self.capabilities = capabilities
        self.browser = browser
        self.permissions = permissions
        self.voice = voice
        self.updates = updates
    }

    public struct Device: Encodable, Sendable {
        public enum Platform: String, Encodable, Sendable { case macos, ios }
        public enum FormFactor: String, Encodable, Sendable { case phone, pad, desktop }

        public let platform: Platform
        public let formFactor: FormFactor?
        public let appVersion: String
        public let appBuild: String
        public let profileName: String?
        public let modelName: String?

        public init(
            platform: Platform = .macos,
            formFactor: FormFactor? = nil,
            appVersion: String,
            appBuild: String,
            profileName: String? = nil,
            modelName: String? = nil)
        {
            self.platform = platform
            self.formFactor = formFactor
            self.appVersion = appVersion
            self.appBuild = appBuild
            self.profileName = profileName
            self.modelName = modelName
        }

        enum CodingKeys: CodingKey { case platform, formFactor, appVersion, appBuild, profileName, modelName }

        public func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(self.platform, forKey: .platform)
            try values.encodeIfPresent(self.formFactor, forKey: .formFactor)
            try values.encode(self.appVersion, forKey: .appVersion)
            try values.encode(self.appBuild, forKey: .appBuild)
            // The wire contract requires this key even when no profile is active.
            try values.encode(self.profileName, forKey: .profileName)
            try values.encodeIfPresent(self.modelName, forKey: .modelName)
        }
    }

    public struct Option: Identifiable, Encodable, Equatable, Sendable {
        public let id: String
        public let name: String

        public init(
            id: String,
            name: String)
        {
            self.id = id
            self.name = name
        }
    }

    public struct App: Encodable, Sendable {
        public let showDockIcon: Bool?
        public let iconStyle: IconStyle?
        public let iconAnimationsEnabled: Bool?
        public let launchAtLogin: Bool?
        public let launchAtLoginAvailable: Bool?
        public let quickChatEnabled: Bool?
        // The shortcut can be absent on iOS or explicitly unset on Mac.
        public let quickChatShortcut: String??
        public let debugPaneEnabled: Bool?
        public let appearance: DeviceSettingsAppearance?
        public let notificationsEnabled: Bool?

        public init(
            showDockIcon: Bool? = nil,
            iconStyle: IconStyle? = nil,
            iconAnimationsEnabled: Bool? = nil,
            launchAtLogin: Bool? = nil,
            launchAtLoginAvailable: Bool? = nil,
            quickChatEnabled: Bool? = nil,
            quickChatShortcut: String?? = nil,
            debugPaneEnabled: Bool? = nil,
            appearance: DeviceSettingsAppearance? = nil,
            notificationsEnabled: Bool? = nil)
        {
            self.showDockIcon = showDockIcon
            self.iconStyle = iconStyle
            self.iconAnimationsEnabled = iconAnimationsEnabled
            self.launchAtLogin = launchAtLogin
            self.launchAtLoginAvailable = launchAtLoginAvailable
            self.quickChatEnabled = quickChatEnabled
            self.quickChatShortcut = quickChatShortcut
            self.debugPaneEnabled = debugPaneEnabled
            self.appearance = appearance
            self.notificationsEnabled = notificationsEnabled
        }

        public struct IconStyle: Encodable, Sendable {
            public let selectedId: String
            public let available: [Option]

            public init(
                selectedId: String,
                available: [Option])
            {
                self.selectedId = selectedId
                self.available = available
            }
        }
    }

    public struct Capabilities: Encodable, Sendable {
        public let canvasEnabled: Bool?
        public let cameraEnabled: Bool?
        public let computerControlEnabled: Bool?
        public let computerControlProvider: String?
        public let cuaDriverBundled: Bool?
        public let peekabooBridgeEnabled: Bool?
        public let activeComputerPresenceEnabled: Bool?
        public let keepAwakeEnabled: Bool?
        public let healthSummaryAvailable: Bool?
        public let healthSummaryEnabled: Bool?

        public init(
            canvasEnabled: Bool? = nil,
            cameraEnabled: Bool? = nil,
            computerControlEnabled: Bool? = nil,
            computerControlProvider: String? = nil,
            cuaDriverBundled: Bool? = nil,
            peekabooBridgeEnabled: Bool? = nil,
            activeComputerPresenceEnabled: Bool? = nil,
            keepAwakeEnabled: Bool? = nil,
            healthSummaryAvailable: Bool? = nil,
            healthSummaryEnabled: Bool? = nil)
        {
            self.canvasEnabled = canvasEnabled
            self.cameraEnabled = cameraEnabled
            self.computerControlEnabled = computerControlEnabled
            self.computerControlProvider = computerControlProvider
            self.cuaDriverBundled = cuaDriverBundled
            self.peekabooBridgeEnabled = peekabooBridgeEnabled
            self.activeComputerPresenceEnabled = activeComputerPresenceEnabled
            self.keepAwakeEnabled = keepAwakeEnabled
            self.healthSummaryAvailable = healthSummaryAvailable
            self.healthSummaryEnabled = healthSummaryEnabled
        }
    }

    public struct Browser: Encodable, Sendable {
        public let importAvailable: Bool
        public let cookieSync: CookieSync

        public init(
            importAvailable: Bool,
            cookieSync: CookieSync)
        {
            self.importAvailable = importAvailable
            self.cookieSync = cookieSync
        }
    }

    public struct CookieSync: Encodable, Sendable {
        public enum State: String, Encodable, Sendable { case off, idle, running, error }
        public let available: Bool
        public let enabled: Bool
        public let domains: [String]
        public let targetProfile: String
        public let state: State
        public let detail: String?

        public init(
            available: Bool,
            enabled: Bool,
            domains: [String],
            targetProfile: String,
            state: State,
            detail: String? = nil)
        {
            self.available = available
            self.enabled = enabled
            self.domains = domains
            self.targetProfile = targetProfile
            self.state = state
            self.detail = detail
        }

        enum CodingKeys: CodingKey { case available, enabled, domains, targetProfile, state, detail }

        public func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(self.available, forKey: .available)
            try values.encode(self.enabled, forKey: .enabled)
            try values.encode(self.domains, forKey: .domains)
            try values.encode(self.targetProfile, forKey: .targetProfile)
            try values.encode(self.state, forKey: .state)
            try values.encode(self.detail, forKey: .detail)
        }
    }

    public struct Permissions: Encodable, Sendable {
        public let entries: [Entry]
        public let location: Location

        public init(
            entries: [Entry],
            location: Location)
        {
            self.entries = entries
            self.location = location
        }

        public struct Entry: Encodable, Sendable {
            public let id: DeviceSettingsPermission
            public let status: DeviceSettingsPermissionStatus

            public init(
                id: DeviceSettingsPermission,
                status: DeviceSettingsPermissionStatus)
            {
                self.id = id
                self.status = status
            }
        }

        public struct Location: Encodable, Sendable {
            public let mode: DeviceSettingsLocationMode
            public let precise: Bool
            public let preciseEditable: Bool?

            public init(
                mode: DeviceSettingsLocationMode,
                precise: Bool,
                preciseEditable: Bool? = nil)
            {
                self.mode = mode
                self.precise = precise
                self.preciseEditable = preciseEditable
            }
        }
    }

    public struct Voice: Encodable, Sendable {
        public let supported: Bool
        public let wakeEnabled: Bool
        public let wakeTriggersTalkMode: Bool?
        public let pushToTalkEnabled: Bool?
        public let talkPhaseSoundsEnabled: Bool?
        public let talkShiftToStopEnabled: Bool?
        public let realtimeRelayEnabled: Bool?
        public let triggerChime: Bool?
        public let sendChime: Bool?
        public let microphone: Microphone?
        public let locale: Locale?
        public let talkEnabled: Bool?
        public let talkButtonEnabled: Bool?
        public let talkBackgroundEnabled: Bool?
        public let speakerphoneEnabled: Bool?

        public init(
            supported: Bool,
            wakeEnabled: Bool,
            wakeTriggersTalkMode: Bool? = nil,
            pushToTalkEnabled: Bool? = nil,
            talkPhaseSoundsEnabled: Bool? = nil,
            talkShiftToStopEnabled: Bool? = nil,
            realtimeRelayEnabled: Bool? = nil,
            triggerChime: Bool? = nil,
            sendChime: Bool? = nil,
            microphone: Microphone? = nil,
            locale: Locale? = nil,
            talkEnabled: Bool? = nil,
            talkButtonEnabled: Bool? = nil,
            talkBackgroundEnabled: Bool? = nil,
            speakerphoneEnabled: Bool? = nil)
        {
            self.supported = supported
            self.wakeEnabled = wakeEnabled
            self.wakeTriggersTalkMode = wakeTriggersTalkMode
            self.pushToTalkEnabled = pushToTalkEnabled
            self.talkPhaseSoundsEnabled = talkPhaseSoundsEnabled
            self.talkShiftToStopEnabled = talkShiftToStopEnabled
            self.realtimeRelayEnabled = realtimeRelayEnabled
            self.triggerChime = triggerChime
            self.sendChime = sendChime
            self.microphone = microphone
            self.locale = locale
            self.talkEnabled = talkEnabled
            self.talkButtonEnabled = talkButtonEnabled
            self.talkBackgroundEnabled = talkBackgroundEnabled
            self.speakerphoneEnabled = speakerphoneEnabled
        }

        public struct Microphone: Encodable, Sendable {
            public let selectedId: String?
            public let devices: [Option]

            public init(
                selectedId: String? = nil,
                devices: [Option])
            {
                self.selectedId = selectedId
                self.devices = devices
            }

            enum CodingKeys: CodingKey { case selectedId, devices }

            public func encode(to encoder: Encoder) throws {
                var values = encoder.container(keyedBy: CodingKeys.self)
                try values.encode(self.selectedId, forKey: .selectedId)
                try values.encode(self.devices, forKey: .devices)
            }
        }

        public struct Locale: Encodable, Sendable {
            public let primary: String
            public let additional: [String]
            public let available: [Option]

            public init(
                primary: String,
                additional: [String],
                available: [Option])
            {
                self.primary = primary
                self.additional = additional
                self.available = available
            }
        }
    }

    public struct Updates: Encodable, Sendable {
        public let available: Bool
        public let automatic: Bool
        public let unavailableReason: String?

        public init(
            available: Bool,
            automatic: Bool,
            unavailableReason: String? = nil)
        {
            self.available = available
            self.automatic = automatic
            self.unavailableReason = unavailableReason
        }

        enum CodingKeys: CodingKey { case available, automatic, unavailableReason }

        public func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(self.available, forKey: .available)
            try values.encode(self.automatic, forKey: .automatic)
            try values.encode(self.unavailableReason, forKey: .unavailableReason)
        }
    }

    public func javaScript() throws -> String {
        let data = try JSONEncoder().encode(self)
        let json = String(bytes: data, encoding: .utf8)!
        return "window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__ = \(json); " +
            "window.dispatchEvent(new CustomEvent('openclaw:native-device-settings-changed', " +
            "{detail: window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__}));"
    }
}
