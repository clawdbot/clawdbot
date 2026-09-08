import AVFoundation
import Contacts
import CoreLocation
import EventKit
import Foundation
import OpenClawKit
import Photos
import Speech
import Testing
import UserNotifications
@testable import OpenClaw

@MainActor
struct IOSDeviceSettingsSnapshotTests {
    @Test func `ios snapshot publishes device families and native defaults`() throws {
        let suite = "IOSDeviceSettingsSnapshotTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let appModel = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let producer = IOSDeviceSettingsSnapshotProducer(
            appModel: appModel,
            appearanceModel: AppAppearanceModel(userDefaults: defaults),
            defaults: defaults)

        let snapshot = producer.snapshot()
        let encoded = try JSONEncoder().encode(snapshot)
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        #expect(Set(json.keys) == ["contract", "device", "app", "capabilities", "permissions", "voice"])
        #expect(snapshot.device.platform == .ios)
        #expect(snapshot.device.modelName?.isEmpty == false)
        #expect(snapshot.device.formFactor == .phone || snapshot.device.formFactor == .pad)
        let device = try #require(json["device"] as? [String: Any])
        #expect(device["profileName"] is NSNull)
        #expect(snapshot.app?.notificationsEnabled == true)
        #expect(snapshot.capabilities?.cameraEnabled == true)
        #expect(snapshot.capabilities?.keepAwakeEnabled == true)
        #expect(snapshot.voice.talkButtonEnabled == true)
        #expect(snapshot.voice.talkBackgroundEnabled == false)
        #expect(snapshot.voice.speakerphoneEnabled == true)
        #expect(snapshot.permissions.location.preciseEditable == false)
        #expect(snapshot.permissions.entries.map(\.id) == [
            .notifications, .camera, .microphone, .speechRecognition, .location,
            .contacts, .calendars, .reminders, .photos,
        ])
        #expect(snapshot.permissions.entries.first?.status == .unavailable)
        #expect(snapshot.permissions.entries.first(where: { $0.id == .location })?.status == .unavailable)
    }

    @Test func `snapshot rereads preference owners and system owned precision`() throws {
        let suite = "IOSDeviceSettingsSnapshotTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let location = SnapshotLocationService()
        let appModel = NodeAppModel(locationService: location, audioAdmissionInitiallyAllowed: false)
        let appearance = AppAppearanceModel(userDefaults: defaults)
        let producer = IOSDeviceSettingsSnapshotProducer(
            appModel: appModel,
            appearanceModel: appearance,
            defaults: defaults)

        defaults.set(false, forKey: "camera.enabled")
        defaults.set(false, forKey: "screen.preventSleep")
        defaults.set(false, forKey: "talk.button.enabled")
        defaults.set(true, forKey: "talk.background.enabled")
        defaults.set(false, forKey: TalkDefaults.speakerphoneEnabledKey)
        defaults.set(false, forKey: NotificationServingPreference.storageKey)
        defaults.set("always", forKey: "location.enabledMode")
        appearance.select(.dark, userDefaults: defaults)
        let reduced = producer.snapshot(notificationStatus: .provisional, locationServicesEnabled: true)

        #expect(reduced.app?.appearance == .dark)
        #expect(reduced.app?.notificationsEnabled == false)
        #expect(reduced.capabilities?.cameraEnabled == false)
        #expect(reduced.capabilities?.keepAwakeEnabled == false)
        #expect(reduced.voice.talkButtonEnabled == false)
        #expect(reduced.voice.talkBackgroundEnabled == true)
        #expect(reduced.voice.speakerphoneEnabled == false)
        #expect(reduced.permissions.location.mode == .always)
        #expect(!reduced.permissions.location.precise)
        #expect(reduced.permissions.entries.first?.status == .granted)
        #expect(reduced.permissions.entries.first(where: { $0.id == .location })?.status == .granted)

        location.publishAccuracy(.fullAccuracy)
        appearance.select(.light, userDefaults: defaults)
        let full = producer.snapshot(notificationStatus: .denied, locationServicesEnabled: false)
        #expect(full.permissions.location.precise)
        #expect(full.permissions.location.preciseEditable == false)
        #expect(full.app?.appearance == .light)
        #expect(full.permissions.entries.first?.status == .denied)
        #expect(full.permissions.entries.first(where: { $0.id == .location })?.status == .unavailable)
    }

    @Test func `permission wire statuses retain limited and unavailable distinctions`() {
        #expect(IOSDeviceSettingsPermissions.permissionGrant(DevicePermissionStatusMap.contacts(.limited)) == .limited)
        #expect(IOSDeviceSettingsPermissions.permissionGrant(
            DevicePermissionStatusMap.eventKitRead(.writeOnly)) == .limited)
        #expect(IOSDeviceSettingsPermissions.permissionGrant(
            DevicePermissionStatusMap.eventKitRead(.fullAccess)) == .granted)
        #expect(IOSDeviceSettingsPermissions.location(.authorizedAlways, servicesEnabled: false) == .unavailable)
        #expect(IOSDeviceSettingsPermissions.location(.authorizedWhenInUse, servicesEnabled: true) == .granted)
        #expect(IOSDeviceSettingsPermissions.location(.notDetermined, servicesEnabled: true) == .notDetermined)
        #expect(IOSDeviceSettingsPermissions.location(.restricted, servicesEnabled: true) == .denied)
        #expect(IOSDeviceSettingsPermissions.notifications(.ephemeral) == .granted)
        #expect(IOSDeviceSettingsPermissions.notifications(.notDetermined) == .notDetermined)
        #expect(IOSDeviceSettingsPermissions.media(.restricted) == .denied)
        #expect(IOSDeviceSettingsPermissions.media(.notDetermined) == .notDetermined)
        #expect(IOSDeviceSettingsPermissions.speech(.restricted) == .denied)
        #expect(IOSDeviceSettingsPermissions.speech(.authorized) == .granted)
    }

    @Test func `photos authorization changes reconcile to published entries without a native prompt`() throws {
        let authorizations: [(PHAuthorizationStatus, String)] = [
            (.notDetermined, "notDetermined"),
            (.limited, "limited"),
            (.authorized, "granted"),
        ]
        for (authorization, expectedStatus) in authorizations {
            let entries = IOSDeviceSettingsPermissions.entries(
                notificationStatus: .notDetermined,
                locationAuthorization: .notDetermined,
                locationServicesEnabled: true,
                photosAuthorization: authorization)
            let encoded = try JSONEncoder().encode(entries)
            let published = try #require(JSONSerialization.jsonObject(with: encoded) as? [[String: Any]])
            let photos = published.filter { $0["id"] as? String == "photos" }
            #expect(photos.count == 1)
            #expect(photos.first?["status"] as? String == expectedStatus)
        }
    }

    @Test(arguments: [
        DeviceSettingsPermission.camera, .microphone, .speechRecognition, .contacts, .calendars, .reminders, .photos,
    ])
    func `cancelled permission requests retire before native prompts`(_ permission: DeviceSettingsPermission) async {
        let requester = IOSDeviceSettingsPermissions()
        let task = Task { @MainActor in
            try await requester.request(permission, isCurrent: { true })
        }
        task.cancel()
        await #expect(throws: CancellationError.self) {
            try await task.value
        }
    }
}

@MainActor
private final class SnapshotLocationService: LocationServicing {
    private var accuracy: CLAccuracyAuthorization = .reducedAccuracy
    private var handler: (@MainActor @Sendable (LocationAuthorizationSnapshot) -> Void)?

    func authorizationStatus() -> CLAuthorizationStatus {
        .authorizedWhenInUse
    }

    func accuracyAuthorization() -> CLAccuracyAuthorization {
        self.accuracy
    }

    func ensureAuthorization(
        mode _: OpenClawLocationMode,
        isCurrent _: @MainActor () -> Bool) async -> CLAuthorizationStatus
    {
        self.authorizationStatus()
    }

    func currentLocation(
        params _: OpenClawLocationGetParams,
        desiredAccuracy _: OpenClawLocationAccuracy,
        maxAgeMs _: Int?,
        timeoutMs _: Int?) async throws -> CLLocation
    {
        throw LocationService.Error.unavailable
    }

    func setBackgroundLocationUpdatesEnabled(_: Bool) {}
    func startMonitoringSignificantLocationChanges(onUpdate _: @escaping @Sendable (CLLocation) -> Void) {}
    func stopMonitoringSignificantLocationChanges() {}

    func setAuthorizationChangeHandler(
        _ handler: @escaping @MainActor @Sendable (LocationAuthorizationSnapshot) -> Void)
    {
        self.handler = handler
    }

    func publishAccuracy(_ accuracy: CLAccuracyAuthorization) {
        self.accuracy = accuracy
        self.handler?(self.authorizationSnapshot())
    }
}
