import Foundation

enum PushEnrollmentConsent {
    static let disclosureAcceptedKey = "push.enrollment.disclosureAccepted"

    static var disclosureAccepted: Bool {
        UserDefaults.standard.bool(forKey: disclosureAcceptedKey)
    }

    static func markDisclosureAccepted() {
        UserDefaults.standard.set(true, forKey: self.disclosureAcceptedKey)
    }

    #if DEBUG
    static func reset() {
        UserDefaults.standard.removeObject(forKey: self.disclosureAcceptedKey)
    }
    #endif
}
