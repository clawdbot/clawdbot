import Foundation
import OpenClawKit
import Testing

struct DashboardRouteMapTests {
    @Test func `route constants match Control UI paths`() {
        #expect(DashboardRouteMap.channelsSettingsPath == "/settings/channels")
        #expect(DashboardRouteMap.skillsPagePath == "/skills")
        #expect(DashboardRouteMap.cronJobsPagePath == "/cron")
        #expect(DashboardRouteMap.sessionsPagePath == "/sessions")
        #expect(DashboardRouteMap.devicesSettingsPath == "/settings/devices")
    }

    @Test(arguments: ["/settings/channels", "/skills", "/cron"])
    func `same-app path validation accepts rooted paths`(_ path: String) {
        #expect(DashboardRouteMap.isValidSameAppPath(path))
    }

    @Test(arguments: [
        "",
        "settings/channels",
        "//example.com/settings/channels",
        "https://example.com/settings/channels",
        "/settings/channels?section=telegram",
        "/settings/channels#telegram",
    ])
    func `same-app path validation rejects external or compound locations`(_ path: String) {
        #expect(!DashboardRouteMap.isValidSameAppPath(path))
    }

    @Test func `Dashboard URL appends route and preserves token fragment`() throws {
        let baseURL = try #require(URL(string: "http://127.0.0.1:18789/control/#token=test-token"))
        let url = try #require(DashboardRouteMap.dashboardURL(
            byAppendingSameAppPath: DashboardRouteMap.channelsSettingsPath,
            to: baseURL))

        #expect(url.absoluteString == "http://127.0.0.1:18789/control/settings/channels#token=test-token")
    }
}
