import Foundation

public enum DashboardRouteMap {
    public static let channelsSettingsPath = "/settings/channels"
    public static let skillsPagePath = "/skills"
    public static let cronJobsPagePath = "/cron"
    public static let sessionsPagePath = "/sessions"
    public static let devicesSettingsPath = "/settings/devices"

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

    public static func dashboardURL(
        byAppendingSameAppPath path: String,
        to baseURL: URL) -> URL?
    {
        guard self.isValidSameAppPath(path),
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        else {
            return nil
        }
        let basePath = components.path.hasSuffix("/") ? components.path : components.path + "/"
        components.path = basePath + path.dropFirst()
        return components.url
    }
}
