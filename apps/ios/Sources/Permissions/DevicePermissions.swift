import AVFoundation
import Contacts
import CoreLocation
import EventKit
import Photos
import SwiftUI
import UserNotifications

/// Closed grant state for one device permission, shared by onboarding and Settings rows.
enum DevicePermissionGrant: Equatable {
    case granted
    case limited
    case notRequested
    case denied
}

/// Device permissions the connected agent can use from this iPhone.
enum DevicePermissionKind: String, CaseIterable, Identifiable {
    case notifications
    case camera
    case microphone
    case photos
    case contacts
    case calendar
    case reminders
    case location

    var id: String {
        self.rawValue
    }

    var symbol: String {
        switch self {
        case .notifications: "bell.badge.fill"
        case .camera: "camera.fill"
        case .microphone: "mic.fill"
        case .photos: "photo.on.rectangle"
        case .contacts: "person.crop.circle.fill"
        case .calendar: "calendar"
        case .reminders: "checklist"
        case .location: "location.fill"
        }
    }

    var tint: Color {
        switch self {
        case .notifications: .red
        case .camera: .indigo
        case .microphone: .pink
        case .photos: .orange
        case .contacts: .blue
        case .calendar: .teal
        case .reminders: .green
        case .location: .purple
        }
    }

    var title: LocalizedStringResource {
        switch self {
        case .notifications: LocalizedStringResource("Notifications")
        case .camera: LocalizedStringResource("Camera")
        case .microphone: LocalizedStringResource("Microphone")
        case .photos: LocalizedStringResource("Photos")
        case .contacts: LocalizedStringResource("Contacts")
        case .calendar: LocalizedStringResource("Calendar")
        case .reminders: LocalizedStringResource("Reminders")
        case .location: LocalizedStringResource("Location")
        }
    }

    var detail: LocalizedStringResource {
        switch self {
        case .notifications: LocalizedStringResource("Pairing approvals and replies from your agent.")
        case .camera: LocalizedStringResource("Scan setup codes and take photos on request.")
        case .microphone: LocalizedStringResource("Talk with your agent using voice.")
        case .photos: LocalizedStringResource("Share recent photos when you ask.")
        case .contacts: LocalizedStringResource("Look up and add people you mention.")
        case .calendar: LocalizedStringResource("Check and add calendar events.")
        case .reminders: LocalizedStringResource("List, add, and complete reminders.")
        case .location: LocalizedStringResource("Answer location and nearby questions.")
        }
    }
}

/// Pure status→grant maps so onboarding and Settings agree on one vocabulary.
enum DevicePermissionStatusMap {
    static func contacts(_ status: CNAuthorizationStatus) -> DevicePermissionGrant {
        switch status {
        case .authorized: .granted
        case .limited: .limited
        case .notDetermined: .notRequested
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }

    static func photos(_ status: PHAuthorizationStatus) -> DevicePermissionGrant {
        switch status {
        case .authorized: .granted
        case .limited: .limited
        case .notDetermined: .notRequested
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }

    /// Full read access; `.writeOnly` surfaces as `.limited` ("Add-Only").
    static func eventKitRead(_ status: EKAuthorizationStatus) -> DevicePermissionGrant {
        switch status {
        case .authorized, .fullAccess: .granted
        case .writeOnly: .limited
        case .notDetermined: .notRequested
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }

    /// Add-events access; `.writeOnly` already satisfies it.
    static func eventKitWrite(_ status: EKAuthorizationStatus) -> DevicePermissionGrant {
        switch status {
        case .authorized, .fullAccess, .writeOnly: .granted
        case .notDetermined: .notRequested
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }

    static func capture(_ status: AVAuthorizationStatus) -> DevicePermissionGrant {
        switch status {
        case .authorized: .granted
        case .notDetermined: .notRequested
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }

    static func microphone(_ permission: AVAudioApplication.recordPermission) -> DevicePermissionGrant {
        switch permission {
        case .granted: .granted
        case .undetermined: .notRequested
        case .denied: .denied
        @unknown default: .denied
        }
    }

    static func notifications(_ status: UNAuthorizationStatus) -> DevicePermissionGrant {
        switch status {
        case .authorized, .ephemeral, .provisional: .granted
        case .notDetermined: .notRequested
        case .denied: .denied
        @unknown default: .denied
        }
    }

    static func location(_ status: CLAuthorizationStatus) -> DevicePermissionGrant {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse: .granted
        case .notDetermined: .notRequested
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }
}

/// Live grant state + request plumbing for the onboarding permissions step.
/// Requests only raise the system prompts; product opt-ins (push relay serving,
/// Health sharing) remain explicit choices in Settings.
@MainActor
@Observable
final class DevicePermissionsModel {
    private(set) var grants: [DevicePermissionKind: DevicePermissionGrant] = [:]
    private(set) var requesting: Set<DevicePermissionKind> = []
    /// Owns its manager so authorization callbacks resolve without the app-wide service.
    private let locationService = LocationService()

    init() {
        self.locationService.setAuthorizationChangeHandler { [weak self] snapshot in
            self?.grants[.location] = DevicePermissionStatusMap.location(snapshot.authorizationStatus)
        }
    }

    func grant(for kind: DevicePermissionKind) -> DevicePermissionGrant {
        self.grants[kind] ?? .notRequested
    }

    func refresh() async {
        var next: [DevicePermissionKind: DevicePermissionGrant] = [
            .camera: DevicePermissionStatusMap.capture(AVCaptureDevice.authorizationStatus(for: .video)),
            .microphone: DevicePermissionStatusMap.microphone(AVAudioApplication.shared.recordPermission),
            .photos: DevicePermissionStatusMap.photos(PhotoLibraryAccess.authorizationStatus()),
            .contacts: DevicePermissionStatusMap.contacts(CNContactStore.authorizationStatus(for: .contacts)),
            .calendar: DevicePermissionStatusMap.eventKitRead(EKEventStore.authorizationStatus(for: .event)),
            .reminders: DevicePermissionStatusMap.eventKitRead(EKEventStore.authorizationStatus(for: .reminder)),
            .location: DevicePermissionStatusMap.location(self.locationService.authorizationStatus()),
        ]
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        next[.notifications] = DevicePermissionStatusMap.notifications(settings.authorizationStatus)
        self.grants = next
    }

    func request(_ kind: DevicePermissionKind) async {
        guard self.grant(for: kind) == .notRequested, !self.requesting.contains(kind) else { return }
        self.requesting.insert(kind)
        defer { self.requesting.remove(kind) }

        switch kind {
        case .notifications:
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [
                .alert,
                .badge,
                .sound,
            ])
        case .camera:
            _ = await PermissionRequestBridge.awaitRequest { completion in
                AVCaptureDevice.requestAccess(for: .video, completionHandler: completion)
            }
        case .microphone:
            _ = await TalkModeManager.requestMicrophonePermission()
        case .photos:
            _ = await PhotoLibraryAccess.requestReadWrite()
        case .contacts:
            _ = await PermissionRequestBridge.awaitRequest { completion in
                CNContactStore().requestAccess(for: .contacts) { granted, _ in
                    completion(granted)
                }
            }
        case .calendar:
            _ = await PermissionRequestBridge.awaitRequest { completion in
                EKEventStore().requestFullAccessToEvents { granted, _ in
                    completion(granted)
                }
            }
        case .reminders:
            _ = await PermissionRequestBridge.awaitRequest { completion in
                EKEventStore().requestFullAccessToReminders { granted, _ in
                    completion(granted)
                }
            }
        case .location:
            _ = await self.locationService.ensureAuthorization(mode: .whileUsing)
        }

        await self.refresh()
    }
}
