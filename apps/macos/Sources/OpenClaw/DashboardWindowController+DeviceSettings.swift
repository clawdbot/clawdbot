import AppKit
import Foundation
import OpenClawKit
import WebKit

extension Notification.Name {
    static let openclawDeviceSettingsChanged = Notification.Name("openclaw.deviceSettings.changed")
}

extension DashboardWindowController {
    static let deviceSettingsMessageHandlerName = "openclawDeviceSettings"

    func receiveDeviceSettingsMessage(
        _ message: WKScriptMessage,
        replyHandler: @escaping DashboardDeviceSettingsMessageHandler.ReplyHandler)
    {
        guard message.name == Self.deviceSettingsMessageHandlerName,
              message.webView === self.webView, message.frameInfo.isMainFrame,
              let request = DeviceSettingsRequest(body: message.body)
        else {
            replyHandler(nil, "Invalid device settings request.")
            return
        }
        if self.isShowingFailurePage,
           message.frameInfo.request.url?.absoluteString == "about:blank",
           self.webView.url?.absoluteString == "about:blank",
           request == .open(.connection)
        {
            // Only this action belongs to the native-authored error document. It never receives device data.
            AppNavigationActions.openConnection()
            replyHandler(NSNull(), nil)
            return
        }
        guard Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL) else {
            replyHandler(nil, "The device settings document is no longer available.")
            return
        }
        self.deviceSettingsMessageHandler.enqueue(
            request, sourceID: self.notificationSourceID, replyHandler: replyHandler)
    }

    func applyDeviceSettingsRequest(_ request: DeviceSettingsRequest) async {
        switch request {
        case .status:
            await self.publishDeviceSettings()
            await BrowserProfileImportModel.shared.refreshAvailability()
        case let .set(key, value):
            await self.setDeviceSetting(key, value: value)
        case let .requestPermission(id):
            if let capability = id.capability {
                _ = await PermissionManager.ensure([capability], interactive: true)
                await PermissionMonitor.shared.refreshNow()
            }
        case let .openSystemSettings(id):
            if let capability = id.capability {
                SystemSettingsURLSupport.openFirst(SystemSettingsURLSupport.settingsCandidates(for: capability))
            }
        case let .open(panel):
            await self.openDeviceSettingsPanel(panel)
        case .checkForUpdates:
            if self.updater?.isAvailable == true { self.updater?.checkForUpdates(nil) }
        case .installChromeExtension:
            break // The queued handler returns the installer result directly.
        }
        // All Gateway windows show settings for this Mac; mutations must update each open view.
        NotificationCenter.default.post(name: .openclawDeviceSettingsChanged, object: nil)
    }

    private func requiredDeviceSettingConsent(
        _ key: DeviceSettingKey,
        value: DeviceSettingValue) -> DeviceSettingsConsent?
    {
        let state = AppStateStore.shared
        let locationMode = AppDefaults.standard.string(forKey: locationModeKey)
            .flatMap(OpenClawLocationMode.init(rawValue:)) ?? .off
        return DeviceSettingsConsent.required(
            for: key,
            value: value,
            cookieSyncEnabled: state.cookieSyncEnabled,
            cookieDomains: state.cookieSyncDomains,
            cookieProfile: state.cookieSyncIntoProfile,
            locationMode: DeviceSettingsLocationMode(locationMode))
    }

    private static let booleanStateSettings: [DeviceSettingKey: ReferenceWritableKeyPath<AppState, Bool>] = [
        .showDockIcon: \.showDockIcon,
        .iconAnimationsEnabled: \.iconAnimationsEnabled,
        .debugPaneEnabled: \.debugPaneEnabled,
        .peekabooBridgeEnabled: \.peekabooBridgeEnabled,
        .activeComputerPresenceEnabled: \.activeComputerPresenceEnabled,
        .cookieSyncEnabled: \.cookieSyncEnabled,
        .wakeTriggersTalkMode: \.voiceWakeTriggersTalkMode,
        .pushToTalkEnabled: \.voicePushToTalkEnabled,
        .talkPhaseSoundsEnabled: \.talkPhaseSoundsEnabled,
        .talkShiftToStopEnabled: \.talkShiftToStopEnabled,
        .realtimeRelayEnabled: \.talkRealtimeRelayEnabled,
    ]

    private func setDeviceSetting(_ key: DeviceSettingKey, value: DeviceSettingValue) async {
        let sourceID = self.notificationSourceID
        let consent = self.requiredDeviceSettingConsent(key, value: value)
        if let consent {
            guard await self.deviceSettingsMessageHandler.confirm(consent) else { return }
        }
        // Another window can revoke scope while the sheet is open. Compare the consent
        // actually shown, then keep cookie mutations synchronous with this check.
        guard self.canUseDeviceSettings(sourceID: sourceID),
              self.requiredDeviceSettingConsent(key, value: value) == consent else { return }
        switch (key, value) {
        case let (.wakeEnabled, .boolean(enabled)):
            await AppStateStore.shared.setVoiceWakeEnabled(enabled) { self.canUseDeviceSettings(sourceID: sourceID) }
        case let (.locationMode, .string(value)):
            guard let mode = DeviceSettingsLocationMode(rawValue: value) else { return }
            await AppStateStore.shared
                .setLocationMode(mode.nativeMode) { self.canUseDeviceSettings(sourceID: sourceID) }
        case let (_, .boolean(enabled)):
            self.setDeviceBoolean(key, enabled: enabled)
        case let (_, .string(value)):
            self.setDeviceString(key, value: value)
        case let (_, .strings(values)):
            let state = AppStateStore.shared
            if key == .cookieSyncDomains {
                state.cookieSyncDomains = CookieSyncManager.normalizedDomains(values)
            } else if key == .localeAdditional {
                let available = Set(VoiceWakeDeviceOptions.locales().map(\.id))
                guard values.allSatisfy(available.contains) else { return }
                state.voiceWakeAdditionalLocaleIDs = values
            }
        case (_, .null):
            guard key == .microphone else { return }
            AppStateStore.shared.voiceWakeMicName = ""
            AppStateStore.shared.voiceWakeMicID = ""
        }
    }

    private func setDeviceBoolean(_ key: DeviceSettingKey, enabled: Bool) {
        let state = AppStateStore.shared
        let defaults = AppDefaults.standard
        if let keyPath = Self.booleanStateSettings[key] {
            state[keyPath: keyPath] = enabled
            return
        }
        switch key {
        case .launchAtLogin:
            guard !enabled || self.deviceLaunchAtLoginAvailable else { return }
            state.launchAtLogin = enabled
        case .quickChatEnabled:
            state.quickChatEnabled = enabled
            QuickChatController.shared.setEnabled(enabled)
        case .canvasEnabled:
            state.canvasEnabled = enabled
            if !enabled { CanvasManager.shared.hideAll() }
        case .cameraEnabled:
            defaults.set(enabled, forKey: cameraEnabledKey)
        case .computerControlEnabled:
            defaults.set(enabled, forKey: computerControlEnabledKey)
            state.applyComputerControlHostState()
        case .locationPrecise:
            defaults.set(enabled, forKey: locationPreciseKey)
        case .triggerChime:
            state.voiceWakeTriggerChime = Self.deviceChime(enabled: enabled, current: state.voiceWakeTriggerChime)
        case .sendChime:
            state.voiceWakeSendChime = Self.deviceChime(enabled: enabled, current: state.voiceWakeSendChime)
        case .automaticUpdates:
            guard let updater = self.updater, updater.isAvailable else { return }
            defaults.set(enabled, forKey: "autoUpdateEnabled")
            updater.automaticallyChecksForUpdates = enabled
            updater.automaticallyDownloadsUpdates = enabled
        default:
            break
        }
    }

    private func setDeviceString(_ key: DeviceSettingKey, value: String) {
        let state = AppStateStore.shared
        let defaults = AppDefaults.standard
        switch key {
        case .iconStyle:
            guard let style = AppIconStyle(rawValue: value), AppIconArtwork.isAvailable(style) else { return }
            defaults.set(style.rawValue, forKey: appIconStyleKey)
        case .computerControlProvider:
            guard value != ComputerControlProvider.cua.rawValue || CuaDriverArtifact.bundledExecutableURL != nil
            else { return }
            defaults.set(value, forKey: computerControlProviderKey)
            state.applyComputerControlHostState()
        case .cookieSyncTargetProfile:
            state.cookieSyncIntoProfile = value.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "imported"
        case .microphone:
            let devices = VoiceWakeDeviceOptions.microphones()
            guard devices.contains(where: { $0.id == value }) else { return }
            state.voiceWakeMicName = MicRefreshSupport.selectedMicName(
                selectedID: value, in: devices, uid: \.id, name: \.name)
            state.voiceWakeMicID = value
        case .localePrimary:
            guard VoiceWakeDeviceOptions.locales().contains(where: { $0.id == value }) else { return }
            // The System option carries a concrete locale identifier, as the native picker did; never store a sentinel.
            state.voiceWakeLocaleID = value
        default:
            break
        }
    }

    private static func deviceChime(enabled: Bool, current: VoiceWakeChime) -> VoiceWakeChime {
        guard enabled else { return .none }
        return current == .none ? .system(name: "Glass") : current
    }

    private func openDeviceSettingsPanel(_ panel: DeviceSettingsPanel) async {
        let publish: () -> Void = {
            NotificationCenter.default.post(name: .openclawDeviceSettingsChanged, object: nil)
        }
        switch panel {
        case .quickChatShortcut:
            DeviceSettingsPanels.shared.showQuickChatShortcut(parentWindow: self.window, onClose: publish)
        case .microphoneTest:
            DeviceSettingsPanels.shared.showMicrophoneTest(
                parentWindow: self.window, state: AppStateStore.shared, onClose: publish)
        case .browserImport:
            let outcome = await BrowserProfileImportModel.shared.refresh(force: true)
            guard !Task.isCancelled, self.isWindowOpen else { return }
            switch outcome {
            case .offering: self.show()
            case let .unavailable(title, message):
                let alert = NSAlert()
                alert.messageText = title
                alert.informativeText = message
                alert.addButton(withTitle: String(localized: "OK"))
                if let window = self.window { alert.beginSheetModal(for: window, completionHandler: nil) }
            }
        case .diagnostics, .licenses, .about, .watch:
            break
        case .connection: AppNavigationActions.openConnection()
        case .gateways: AppNavigationActions.openConnection(tab: .gateways)
        case .debug:
            guard AppStateStore.shared.debugPaneEnabled else { return }
            AppNavigationActions.openConnection(tab: .debug)
        }
    }
}
