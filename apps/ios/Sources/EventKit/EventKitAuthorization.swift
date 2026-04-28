import EventKit

enum EventKitAuthorization {
    static func allowsRead(status: EKAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .fullAccess:
            return true
        case .writeOnly:
            return false
        case .notDetermined:
            // Don’t prompt during node.invoke; prompts block the invoke and lead to timeouts.
            return false
        case .restricted, .denied:
            return false
        @unknown default:
            return false
        }
    }

    static func allowsWrite(status: EKAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .fullAccess, .writeOnly:
            return true
        case .notDetermined:
            // Don’t prompt during node.invoke; prompts block the invoke and lead to timeouts.
            return false
        case .restricted, .denied:
            return false
        @unknown default:
            return false
        }
    }
}
