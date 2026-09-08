import OpenClawIPC

extension Capability {
    var permissionDisplayName: String {
        switch self {
        case .appleScript: "Automation (Terminal)"
        case .notifications: "Notifications"
        case .accessibility: "Accessibility"
        case .screenRecording: "Screen Recording"
        case .microphone: "Microphone"
        case .speechRecognition: "Speech Recognition"
        case .camera: "Camera"
        case .location: "Location"
        }
    }
}
