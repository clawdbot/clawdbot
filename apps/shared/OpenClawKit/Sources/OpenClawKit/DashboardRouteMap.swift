import Foundation

public enum DashboardRouteMap {
    public static let settingsPath = "/settings"
    public static let deviceSettingsPath = "/settings/device"
    public static let devicePermissionsSettingsPath = "/settings/device/permissions"
    public static let channelsSettingsPath = "/settings/channels"
    public static let skillsPagePath = "/skills"
    public static let cronJobsPagePath = "/automations"
    public static let activityPagePath = "/activity"
    public static let workboardPagePath = "/workboard"
    public static let skillWorkshopPagePath = "/skills/workshop"
    public static let dreamingPagePath = "/settings/memory/dreams"
    public static let usagePagePath = "/usage"
    public static let sessionsPagePath = "/sessions"
    public static let devicesSettingsPath = "/settings/devices"
    public static let custodianPagePath = "/custodian"
    /// Control UI query that renders /custodian with onboarding chrome.
    public static let custodianOnboardingSearch = "?onboarding=1"

    public static func isValidSameAppPath(_ path: String) -> Bool {
        guard path.hasPrefix("/"), !path.hasPrefix("//"),
              let components = URLComponents(string: path)
        else {
            return false
        }
        return components.scheme == nil &&
            components.host == nil &&
            components.query == nil &&
            components.fragment == nil
    }

    /// A same-app search must stay a plain query: no scheme/host smuggling and
    /// no fragment, which the dashboard URL reserves for the auth token.
    public static func isValidSameAppSearch(_ search: String) -> Bool {
        guard search.hasPrefix("?"), !search.contains("#") else { return false }
        // Parse bridge input: assigning an invalid percentEncodedQuery traps.
        return URLComponents(string: search, encodingInvalidCharacters: false)?.percentEncodedQuery != nil
    }

    public static func dashboardURL(
        byAppendingSameAppPath path: String,
        search: String? = nil,
        to baseURL: URL) -> URL?
    {
        guard self.isValidSameAppPath(path),
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        else {
            return nil
        }
        if let search {
            guard self.isValidSameAppSearch(search) else { return nil }
            components.percentEncodedQuery = String(search.dropFirst())
        }
        let basePath = components.path.hasSuffix("/") ? components.path : components.path + "/"
        components.path = basePath + path.dropFirst()
        return components.url
    }
}
