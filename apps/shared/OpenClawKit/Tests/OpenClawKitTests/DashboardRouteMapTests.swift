import Foundation
import OpenClawKit
import Testing

struct DashboardRouteMapTests {
    @Test func `route constants match Control UI paths`() {
        #expect(DashboardRouteMap.channelsSettingsPath == "/settings/channels")
        #expect(DashboardRouteMap.talkSettingsPath == "/settings/talk")
        #expect(DashboardRouteMap.skillsPagePath == "/skills")
        #expect(DashboardRouteMap.cronJobsPagePath == "/cron")
        #expect(DashboardRouteMap.sessionsPagePath == "/sessions")
        #expect(DashboardRouteMap.devicesSettingsPath == "/settings/devices")
    }

    @Test(arguments: ["/settings/channels", "/settings/talk", "/skills", "/cron"])
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

    @Test func `Dashboard URL carries a same-app search alongside the token fragment`() throws {
        let baseURL = try #require(URL(string: "http://127.0.0.1:18789/control/#token=test-token"))
        let url = try #require(DashboardRouteMap.dashboardURL(
            byAppendingSameAppPath: DashboardRouteMap.custodianPagePath,
            search: DashboardRouteMap.custodianOnboardingSearch,
            to: baseURL))

        #expect(url.absoluteString == "http://127.0.0.1:18789/control/custodian?onboarding=1#token=test-token")
    }

    @Test(arguments: ["", "onboarding=1", "?onboarding=1#x", "?a=b#frag"])
    func `same-app search validation rejects non-query input`(_ search: String) throws {
        #expect(!DashboardRouteMap.isValidSameAppSearch(search))
        #expect(try DashboardRouteMap.dashboardURL(
            byAppendingSameAppPath: DashboardRouteMap.custodianPagePath,
            search: search,
            to: #require(URL(string: "http://127.0.0.1:18789/control/"))) == nil)
    }

    @Test func `same-app search validation accepts a plain query`() {
        #expect(DashboardRouteMap.isValidSameAppSearch("?onboarding=1"))
    }
}
