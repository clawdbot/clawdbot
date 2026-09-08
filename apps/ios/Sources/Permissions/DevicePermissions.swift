import Contacts
import EventKit
import Photos

/// Native permission state published by the device-settings bridge.
enum DevicePermissionGrant: Equatable {
    case granted
    case limited
    case notRequested
    case denied
}

/// Native authorization states share one grant vocabulary across snapshots.
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
