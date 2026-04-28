import Foundation

enum OnboardingConnectionMode: String, CaseIterable {
    case homeNetwork = "home_network"
    case remoteDomain = "remote_domain"
    case developerLocal = "developer_local"

    var title: String {
        switch self {
        case .homeNetwork:
            "Home Network"
        case .remoteDomain:
            "Remote Domain"
        case .developerLocal:
            "Same Machine (Dev)"
        }
    }
}

enum OnboardingStateStore {
    private static let completedDefaultsKey = "onboarding.completed"
    private static let firstRunIntroSeenDefaultsKey = "onboarding.first_run_intro_seen"
    private static let lastModeDefaultsKey = "onboarding.last_mode"
    private static let lastSuccessTimeDefaultsKey = "onboarding.last_success_time"

    @MainActor
    static func shouldPresentOnLaunch(appModel: NodeAppModel, defaults: UserDefaults = .standard) -> Bool {
        if defaults.bool(forKey: self.completedDefaultsKey) { return false }
        // If we have a last-known connection config, don't force onboarding on launch. Auto-connect
        // should handle reconnecting, and users can always open onboarding manually if needed.
        if GatewaySettingsStore.loadLastGatewayConnection() != nil { return false }
        return appModel.gatewayServerName == nil
    }

    static func markCompleted(mode: OnboardingConnectionMode? = nil, defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: self.completedDefaultsKey)
        if let mode {
            defaults.set(mode.rawValue, forKey: self.lastModeDefaultsKey)
        }
        defaults.set(Int(Date().timeIntervalSince1970), forKey: Self.lastSuccessTimeDefaultsKey)
    }

    static func shouldPresentFirstRunIntro(defaults: UserDefaults = .standard) -> Bool {
        !defaults.bool(forKey: self.firstRunIntroSeenDefaultsKey)
    }

    static func markFirstRunIntroSeen(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: self.firstRunIntroSeenDefaultsKey)
    }

    static func markIncomplete(defaults: UserDefaults = .standard) {
        defaults.set(false, forKey: self.completedDefaultsKey)
    }

    static func reset(defaults: UserDefaults = .standard) {
        defaults.set(false, forKey: self.completedDefaultsKey)
        defaults.set(false, forKey: self.firstRunIntroSeenDefaultsKey)
    }

    static func lastMode(defaults: UserDefaults = .standard) -> OnboardingConnectionMode? {
        let raw = defaults.string(forKey: Self.lastModeDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !raw.isEmpty else { return nil }
        return OnboardingConnectionMode(rawValue: raw)
    }
}
