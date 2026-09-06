import AVFoundation
import Contacts
import CoreLocation
import EventKit
import OpenClawKit
import Photos
import Speech
import UserNotifications

@MainActor
final class IOSDeviceSettingsPermissions {
    private let eventKit = EventKitPermissionRequester()

    static func entries(
        notificationStatus: UNAuthorizationStatus?,
        locationAuthorization: CLAuthorizationStatus,
        locationServicesEnabled: Bool?,
        photosAuthorization: PHAuthorizationStatus) -> [DeviceSettingsSnapshot.Permissions.Entry]
    {
        [
            .init(id: .notifications, status: self.notifications(notificationStatus)),
            .init(id: .camera, status: self.media(AVCaptureDevice.authorizationStatus(for: .video))),
            .init(id: .microphone, status: self.media(AVCaptureDevice.authorizationStatus(for: .audio))),
            .init(id: .speechRecognition, status: self.speech(SFSpeechRecognizer.authorizationStatus())),
            .init(id: .location, status: locationServicesEnabled.map {
                self.location(locationAuthorization, servicesEnabled: $0)
            } ?? .unavailable),
            .init(id: .contacts, status: self.permissionGrant(DevicePermissionStatusMap.contacts(
                CNContactStore.authorizationStatus(for: .contacts)))),
            .init(id: .calendars, status: self.permissionGrant(DevicePermissionStatusMap.eventKitRead(
                EKEventStore.authorizationStatus(for: .event)))),
            .init(id: .reminders, status: self.permissionGrant(DevicePermissionStatusMap.eventKitRead(
                EKEventStore.authorizationStatus(for: .reminder)))),
            .init(id: .photos, status: self.permissionGrant(DevicePermissionStatusMap.photos(
                photosAuthorization))),
        ]
    }

    func request(
        _ permission: DeviceSettingsPermission,
        isCurrent: @escaping @MainActor @Sendable () -> Bool) async throws
    {
        try Task.checkCancellation()
        guard isCurrent() else { throw CancellationError() }
        switch permission {
        case .camera:
            _ = await PermissionRequestBridge.awaitRequest(isCurrent: isCurrent) { completion in
                AVCaptureDevice.requestAccess(for: .video, completionHandler: completion)
            }
        case .microphone:
            _ = await PermissionRequestBridge.awaitRequest(isCurrent: isCurrent) { completion in
                AVCaptureDevice.requestAccess(for: .audio, completionHandler: completion)
            }
        case .speechRecognition:
            _ = await PermissionRequestBridge.awaitRequest(isCurrent: isCurrent) { completion in
                SFSpeechRecognizer.requestAuthorization { completion($0 == .authorized) }
            }
        case .contacts:
            _ = await PermissionRequestBridge.awaitRequest(isCurrent: isCurrent) { completion in
                CNContactStore().requestAccess(for: .contacts) { granted, _ in completion(granted) }
            }
        case .calendars:
            _ = await self.eventKit.requestFullAccessToEvents(isCurrent: isCurrent)
        case .reminders:
            _ = await self.eventKit.requestFullAccessToReminders(isCurrent: isCurrent)
        case .photos:
            _ = await PermissionRequestBridge.awaitRequest(isCurrent: isCurrent) { completion in
                PHPhotoLibrary.requestAuthorization(for: .readWrite) { completion(PhotoLibraryAccess.canRead($0)) }
            }
        case .notifications, .location, .accessibility, .screenRecording, .automation:
            break
        }
        try Task.checkCancellation()
        guard isCurrent() else { throw CancellationError() }
    }

    static func notifications(_ status: UNAuthorizationStatus?) -> DeviceSettingsPermissionStatus {
        guard let status else { return .unavailable }
        switch status {
        case .authorized, .provisional, .ephemeral: return .granted
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        @unknown default: return .unavailable
        }
    }

    static func media(_ status: AVAuthorizationStatus) -> DeviceSettingsPermissionStatus {
        switch status {
        case .authorized: .granted
        case .notDetermined: .notDetermined
        case .denied, .restricted: .denied
        @unknown default: .unavailable
        }
    }

    static func speech(_ status: SFSpeechRecognizerAuthorizationStatus) -> DeviceSettingsPermissionStatus {
        switch status {
        case .authorized: .granted
        case .notDetermined: .notDetermined
        case .denied, .restricted: .denied
        @unknown default: .unavailable
        }
    }

    static func location(
        _ status: CLAuthorizationStatus,
        servicesEnabled: Bool) -> DeviceSettingsPermissionStatus
    {
        guard servicesEnabled else { return .unavailable }
        switch status {
        case .authorizedAlways, .authorizedWhenInUse: return .granted
        case .notDetermined: return .notDetermined
        case .denied, .restricted: return .denied
        @unknown default: return .unavailable
        }
    }

    static func permissionGrant(_ grant: DevicePermissionGrant) -> DeviceSettingsPermissionStatus {
        switch grant {
        case .granted: .granted
        case .limited: .limited
        case .notRequested: .notDetermined
        case .denied: .denied
        }
    }
}
