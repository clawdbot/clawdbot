import AppKit
import Foundation
import OpenClawIPC

enum SystemSettingsURLSupport {
    static func privacySettingsCandidates(for capability: Capability) -> [String] {
        let pane: String? = switch capability {
        case .microphone: "Microphone"
        case .speechRecognition: "SpeechRecognition"
        case .camera: "Camera"
        case .location: "LocationServices"
        default: nil
        }
        guard let pane else { return [] }
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
