import CoreLocation
import Foundation
import OpenClawKit

struct LocationAuthorizationSnapshot: Equatable, Sendable {
    var authorizationStatus: CLAuthorizationStatus
    var accuracyAuthorization: CLAccuracyAuthorization

    static let undetermined = LocationAuthorizationSnapshot(
        authorizationStatus: .notDetermined,
        accuracyAuthorization: .fullAccuracy)
}

struct LocationPermissionSummary: Equatable {
    var desiredMode: OpenClawLocationMode
    var locationServicesEnabled: Bool
    var authorizationStatus: CLAuthorizationStatus
    var accuracyAuthorization: CLAccuracyAuthorization

    var effectiveMode: OpenClawLocationMode {
        guard self.desiredMode != .off else { return .off }
        guard self.locationServicesEnabled else { return .off }
        switch self.authorizationStatus {
        case .authorizedAlways:
            return self.desiredMode == .always ? .always : .whileUsing
        case .authorizedWhenInUse:
            return .whileUsing
        default:
            return .off
        }
    }

    var canUseLocationInBackground: Bool {
        self.locationServicesEnabled && self.desiredMode == .always && self.authorizationStatus == .authorizedAlways
    }

    var needsAttention: Bool {
        switch self.desiredMode {
        case .off:
            false
        case .whileUsing:
            !self.locationServicesEnabled ||
                (self.authorizationStatus != .authorizedWhenInUse && self.authorizationStatus != .authorizedAlways)
        case .always:
            !self.locationServicesEnabled || self.authorizationStatus != .authorizedAlways
        }
    }

    var statusText: String {
        switch self.effectiveMode {
        case .off:
            "Off"
        case .whileUsing:
            "While Using"
        case .always:
            "Always"
        }
    }

    var detailText: String {
        switch (
            self.desiredMode,
            self.locationServicesEnabled,
            self.authorizationStatus,
            self.accuracyAuthorization)
        {
        case (.off, false, _, _):
            "Location sharing is disabled in OpenClaw. Location Services are off in iOS Settings."
        case (.off, true, .authorizedAlways, _):
            "Location sharing is disabled in OpenClaw. iOS currently allows Always."
        case (.off, true, .authorizedWhenInUse, _):
            "Location sharing is disabled in OpenClaw. iOS currently allows While Using."
        case (.off, _, _, _):
            "Location sharing is disabled."
        case (_, false, _, _):
            "Location Services are off in iOS Settings."
        case (.whileUsing, true, .authorizedWhenInUse, .fullAccuracy):
            "Foreground location requests are allowed. Precise Location is on."
        case (.whileUsing, true, .authorizedAlways, .fullAccuracy):
            "Foreground location requests are allowed. Precise Location is on."
        case (.whileUsing, true, .authorizedWhenInUse, .reducedAccuracy):
            "Foreground location requests are allowed. Precise Location is off."
        case (.whileUsing, true, .authorizedAlways, .reducedAccuracy):
            "Foreground location requests are allowed. Precise Location is off."
        case (.whileUsing, true, .authorizedWhenInUse, _):
            "Foreground location requests are allowed."
        case (.whileUsing, true, .authorizedAlways, _):
            "Foreground location requests are allowed."
        case (.always, true, .authorizedAlways, .fullAccuracy):
            "Background location requests and significant-change updates are allowed. Precise Location is on."
        case (.always, true, .authorizedAlways, .reducedAccuracy):
            "Background location requests and significant-change updates are allowed. Precise Location is off."
        case (.always, true, .authorizedAlways, _):
            "Background location requests and significant-change updates are allowed."
        case (.always, true, .authorizedWhenInUse, .fullAccuracy):
            "Always is selected, but iOS currently allows location only while using the app. Precise Location is on."
        case (.always, true, .authorizedWhenInUse, .reducedAccuracy):
            "Always is selected, but iOS currently allows location only while using the app. Precise Location is off."
        case (.always, true, .authorizedWhenInUse, _):
            "Always is selected, but iOS currently allows location only while using the app."
        case (_, true, .denied, _):
            "Location permission is denied in iOS Settings."
        case (_, true, .restricted, _):
            "Location permission is restricted on this device."
        case (_, true, .notDetermined, _):
            "Choose a location mode to request iOS permission."
        @unknown default:
            "OpenClaw cannot determine the current iOS location permission."
        }
    }
}
