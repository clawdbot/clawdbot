import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct DashboardNavigationTests {
    @Test func `Dashboard navigation queues until the shell loads`() throws {
        let baseURL = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let fallbackURL = try #require(URL(string: "http://127.0.0.1:18789/control/skills"))
        let controller = DashboardWindowController(
            url: baseURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let navigation = DashboardNativeNavigation(path: "/skills", fallbackURL: fallbackURL)

        controller.dispatchNativeNavigation(navigation)

        #expect(controller._testPendingNativeNavigation == navigation)
    }

    @Test func `new session supersedes an older queued Dashboard navigation`() throws {
        let baseURL = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let fallbackURL = try #require(URL(string: "http://127.0.0.1:18789/control/skills"))
        let controller = DashboardWindowController(
            url: baseURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }

        controller.dispatchNativeNavigation(DashboardNativeNavigation(
            path: "/skills",
            fallbackURL: fallbackURL))
        let staleGeneration = controller._testNavigationGeneration
        controller.dispatchNativeCommand(.newSession)

        #expect(controller._testPendingNativeNavigation == nil)
        #expect(controller._testPendingNativeCommands == [.newSession])
        #expect(!controller._testNavigationFallbackIsCurrent(
            generation: staleGeneration,
            sourceURL: baseURL))
        #expect(controller.dashboardBaseURL == baseURL)
    }

    @Test func `newer Dashboard dispatch invalidates stale in-flight fallback`() throws {
        let baseURL = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let first = try DashboardNativeNavigation(
            path: "/skills",
            fallbackURL: #require(URL(string: "http://127.0.0.1:18789/control/skills")))
        let second = try DashboardNativeNavigation(
            path: "/cron",
            fallbackURL: #require(URL(string: "http://127.0.0.1:18789/control/cron")))
        let controller = DashboardWindowController(
            url: baseURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }

        controller.dispatchNativeNavigation(first)
        let staleGeneration = controller._testNavigationGeneration
        #expect(controller._testNavigationFallbackIsCurrent(
            generation: staleGeneration,
            sourceURL: baseURL))

        controller.dispatchNativeNavigation(second)

        #expect(!controller._testNavigationFallbackIsCurrent(
            generation: staleGeneration,
            sourceURL: baseURL))
        #expect(controller._testPendingNativeNavigation == second)
    }
}
