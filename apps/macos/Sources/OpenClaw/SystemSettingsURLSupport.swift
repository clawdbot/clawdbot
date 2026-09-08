import AppKit
import Foundation
import OpenClawIPC

enum SystemSettingsURLSupport {
    static func privacySettingsCandidates(for capability: Capability) -> [String] {
        // These permissions recover here; the others own their prompt/recovery flow.
        switch capability {
        case .microphone, .speechRecognition, .camera, .location:
            self.settingsCandidates(for: capability)
        default:
            []
        }
    }

    static func settingsCandidates(for capability: Capability) -> [String] {
        if capability == .notifications {
            return [
                "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
                "x-apple.systempreferences:com.apple.preference.notifications",
            ]
        }
        let pane = switch capability {
        case .notifications: "Notifications"
        case .accessibility: "Accessibility"
        case .screenRecording: "ScreenCapture"
        case .appleScript: "Automation"
        case .microphone: "Microphone"
        case .speechRecognition: "SpeechRecognition"
        case .camera: "Camera"
        case .location: "LocationServices"
        }
        return [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_\(pane)",
            "x-apple.systempreferences:com.apple.preference.security",
        ]
    }

    static func openPrivacySettings(for capability: Capability) {
        self.openFirst(self.privacySettingsCandidates(for: capability))
    }

    static func openFirst(_ candidates: [String]) {
        for candidate in candidates {
            if let url = URL(string: candidate), NSWorkspace.shared.open(url) {
                return
            }
        }
    }
}
