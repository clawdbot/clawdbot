import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct SettingsDashboardHandoffTests {
    @Test func `settings tabs use verified Dashboard routes`() {
        let expected: [SettingsTab: String] = [
            .channels: "/settings/channels",
            .skills: "/skills",
            .cron: "/cron",
            .sessions: "/sessions",
            .instances: "/settings/devices",
        ]

        for tab in SettingsTab.allCases {
            #expect(tab.dashboardRoute == expected[tab])
        }
        // Host-native policy is read-only in the Dashboard; the companion app remains its editor.
        #expect(SettingsTab.execApprovals.dashboardRoute == nil)
    }

    @Test func `Dashboard tabs remain selectable while hidden tabs stay gated`() {
        for tab in SettingsTab.allCases where tab.dashboardRoute != nil {
            let selection = SettingsRootView.tabSelection(
                requested: tab,
                showDebug: false,
                inferenceConfiguration: .loaded(nil))
            #expect(selection.selected == tab)
            #expect(selection.deferred == nil)
        }

        #expect(SettingsRootView.tabSelection(
            requested: .debug,
            showDebug: false,
            inferenceConfiguration: .loaded(nil)).selected == .general)
        #expect(SettingsRootView.tabSelection(
            requested: .systemAgent,
            showDebug: false,
            inferenceConfiguration: .loaded(nil)).selected == .general)
    }

    @Test func `Dashboard navigation queues until the shell loads`() throws {
        let baseURL = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let fallbackURL = try #require(URL(string: "http://127.0.0.1:18789/control/skills"))
        let controller = DashboardWindowController(
            url: baseURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        let navigation = DashboardNativeNavigation(path: "/skills", fallbackURL: fallbackURL)

        controller.dispatchNativeNavigation(navigation)

        #expect(controller._testPendingNativeNavigation == navigation)
    }

    @Test func `new session supersedes an older queued Dashboard navigation`() throws {
        let baseURL = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let fallbackURL = try #require(URL(string: "http://127.0.0.1:18789/control/skills"))
        let controller = DashboardWindowController(
            url: baseURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))

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
        let first = DashboardNativeNavigation(
            path: "/skills",
            fallbackURL: try #require(URL(string: "http://127.0.0.1:18789/control/skills")))
        let second = DashboardNativeNavigation(
            path: "/cron",
            fallbackURL: try #require(URL(string: "http://127.0.0.1:18789/control/cron")))
        let controller = DashboardWindowController(
            url: baseURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))

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
