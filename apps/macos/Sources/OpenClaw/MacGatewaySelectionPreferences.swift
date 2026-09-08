import Foundation

@MainActor
final class MacGatewaySelectionPreferences {
    static let shared = MacGatewaySelectionPreferences(defaults: AppDefaults.standard)
    private static let profileKey = "openclaw.webchat.lastGatewayProfileID"
    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    var profileID: String? {
        self.defaults.string(forKey: Self.profileKey)?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    var target: DashboardGatewayTarget {
        self.profileID.map(DashboardGatewayTarget.profile) ?? .primary
    }

    func select(_ target: DashboardGatewayTarget) {
        switch target {
        case .primary:
            self.defaults.removeObject(forKey: Self.profileKey)
        case let .profile(id):
            self.defaults.set(id, forKey: Self.profileKey)
        }
    }

    func forget(profileID: String) {
        guard self.profileID == profileID else { return }
        self.select(.primary)
    }
}
