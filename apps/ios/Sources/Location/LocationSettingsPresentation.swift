import CoreLocation
import Foundation
import OpenClawKit

enum LocationSettingsAction: Equatable {
    case setMode(OpenClawLocationMode)
    case openAppSettings(OpenClawLocationMode)
}

struct LocationSettingsPresentation: Equatable {
    var selectedMode: OpenClawLocationMode
    var summary: LocationPermissionSummary

    var sharingControlIsOn: Bool {
        self.selectedMode != .off
    }

    var showsAccessLevel: Bool {
        self.selectedMode != .off
    }

    var accessLevelText: String? {
        self.selectedMode.locationAccessLevelText
    }

    var statusText: String? {
        guard self.selectedMode != .off else { return nil }
        guard self.summary.needsAttention else { return nil }

        if !self.summary.locationServicesEnabled {
            return String(localized: "Location Services are off in iOS Settings.")
        }

        switch self.summary.authorizationStatus {
        case .notDetermined:
            return String(localized: "iOS permission is required to share location.")
        case .denied:
            return String(localized: "Location permission is denied in iOS Settings.")
        case .restricted:
            return String(localized: "Location permission is restricted on this device.")
        case .authorizedWhenInUse where self.selectedMode == .always:
            return String(localized: "iOS currently allows location only while using the app.")
        case .authorizedWhenInUse, .authorizedAlways:
            return nil
        default:
            return String(localized: "OpenClaw cannot determine the current iOS location permission.")
        }
    }

    func toggleAction(defaultEnabledMode: OpenClawLocationMode = .whileUsing) -> LocationSettingsAction {
        if self.sharingControlIsOn {
            return .setMode(.off)
        }
        let mode = self.selectedMode == .off ? defaultEnabledMode : self.selectedMode
        return self.enableAction(mode: mode)
    }

    func accessLevelAction(mode: OpenClawLocationMode) -> LocationSettingsAction {
        self.enableAction(mode: mode)
    }

    private func enableAction(mode: OpenClawLocationMode) -> LocationSettingsAction {
        if !self.summary.locationServicesEnabled {
            return .openAppSettings(mode)
        }

        switch self.summary.authorizationStatus {
        case .denied, .restricted:
            return .openAppSettings(mode)
        default:
            return .setMode(mode)
        }
    }
}

extension OpenClawLocationMode {
    var locationAccessLevelText: String? {
        switch self {
        case .off:
            nil
        case .whileUsing:
            String(localized: "While Using the App")
        case .always:
            String(localized: "Always")
        }
    }
}
