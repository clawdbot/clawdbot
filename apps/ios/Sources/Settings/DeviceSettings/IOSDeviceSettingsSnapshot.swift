import CoreLocation
import Foundation
import OpenClawKit
import UIKit
import UserNotifications

@MainActor
final class IOSDeviceSettingsSnapshotProducer {
    private let appModel: NodeAppModel
    private let appearanceModel: AppAppearanceModel
    private let defaults: UserDefaults

    init(
        appModel: NodeAppModel,
        appearanceModel: AppAppearanceModel,
        defaults: UserDefaults = .standard)
    {
        self.appModel = appModel
        self.appearanceModel = appearanceModel
        self.defaults = defaults
    }

    func snapshot(
        notificationStatus: UNAuthorizationStatus? = nil,
        locationServicesEnabled: Bool? = nil) -> DeviceSettingsSnapshot
    {
        let authorization = self.appModel.locationAuthorizationSnapshot
        let locationMode = self.defaults.string(forKey: "location.enabledMode")
            .flatMap(OpenClawLocationMode.init(rawValue:)) ?? .off
        return DeviceSettingsSnapshot(
            device: .init(
                platform: .ios,
                formFactor: UIDevice.current.userInterfaceIdiom == .pad ? .pad : .phone,
                appVersion: DeviceInfoHelper.appVersion(),
                appBuild: DeviceInfoHelper.appBuild(),
                modelName: UIDevice.current.model),
            app: .init(
                appearance: DeviceSettingsAppearance(rawValue: self.appearanceModel.preference.rawValue),
                notificationsEnabled: NotificationServingPreference.isEnabled(defaults: self.defaults)),
            capabilities: .init(
                cameraEnabled: self.defaults.object(forKey: "camera.enabled") as? Bool ?? true,
                keepAwakeEnabled: self.defaults.object(forKey: "screen.preventSleep") as? Bool ?? true,
                healthSummaryAvailable: HealthAuthorization.isAvailable,
                healthSummaryEnabled: HealthAuthorization.isEnabled),
            permissions: .init(
                entries: IOSDeviceSettingsPermissions.entries(
                    notificationStatus: notificationStatus,
                    locationAuthorization: authorization.authorizationStatus,
                    locationServicesEnabled: locationServicesEnabled,
                    photosAuthorization: PhotoLibraryAccess.authorizationStatus()),
                location: .init(
                    mode: DeviceSettingsLocationMode(locationMode),
                    precise: authorization.accuracyAuthorization == .fullAccuracy,
                    preciseEditable: false)),
            voice: .init(
                supported: ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] == nil &&
                    ProcessInfo.processInfo.environment["SIMULATOR_UDID"] == nil,
                wakeEnabled: self.appModel.voiceWake.isEnabled,
                systemVoice: self.systemVoice(),
                talkEnabled: self.appModel.talkMode.isEnabled,
                talkButtonEnabled: self.defaults.object(forKey: "talk.button.enabled") as? Bool ?? true,
                talkBackgroundEnabled: self.defaults.bool(forKey: "talk.background.enabled"),
                speakerphoneEnabled: TalkDefaults.speakerphoneEnabled(defaults: self.defaults)))
    }

    /// Pre-filtered by the gateway-configured synthesis language so the row never offers a voice
    /// `resolvedSpeechLanguages` would reject; a nil language means Automatic and lists every voice.
    /// "System Default" is injected by the web row, matching the microphone row on macOS.
    private func systemVoice() -> DeviceSettingsSnapshot.Voice.SystemVoice {
        let selected = self.defaults.string(forKey: TalkSystemVoiceSelection.storageKey) ?? ""
        let voices = TalkSystemVoiceCatalog.voices(
            matchingLanguageID: self.appModel.talkMode.gatewaySpeechLocaleID,
            in: TalkSystemVoiceCatalog.availableVoices())
        return .init(
            selectedId: selected.isEmpty ? nil : selected,
            available: voices.map { .init(id: $0.id, name: TalkSystemVoiceCatalog.label(for: $0)) })
    }
}
