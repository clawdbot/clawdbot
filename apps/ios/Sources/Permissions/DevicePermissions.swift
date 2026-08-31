import Contacts
import EventKit
import Photos
import SwiftUI

/// Closed grant state for one device permission shown in Settings.
enum DevicePermissionGrant: Equatable {
    case granted
    case limited
    case notRequested
    case denied
}

/// Device permissions managed by the Privacy & Access Settings section.
enum DevicePermissionKind {
    case photos
    case contacts
    case calendar
    case reminders

    var symbol: String {
        switch self {
        case .photos: "photo.on.rectangle"
        case .contacts: "person.crop.circle.fill"
        case .calendar: "calendar"
        case .reminders: "checklist"
        }
    }

    var tint: Color {
        switch self {
        case .photos: .orange
        case .contacts: .blue
        case .calendar: .teal
        case .reminders: .green
        }
    }

    var title: LocalizedStringResource {
        switch self {
        case .photos: LocalizedStringResource("Photos")
        case .contacts: LocalizedStringResource("Contacts")
        case .calendar: LocalizedStringResource("Calendar")
        case .reminders: LocalizedStringResource("Reminders")
        }
    }
}

/// Pure status→grant maps keep every Settings row on one vocabulary.
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
}
