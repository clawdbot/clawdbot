import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct SettingsHubTests {
    @Test func `Dashboard settings require an active admin session outside demo and screenshots`() {
        let cases: [(connected: Bool, admin: Bool, demo: Bool, screenshot: Bool, dashboard: Bool)] = [
            (true, true, false, false, true),
            (false, true, false, false, false),
            (true, false, false, false, false),
            (false, false, false, false, false),
            (true, true, true, false, false),
            (true, true, false, true, false),
        ]
        for testCase in cases {
            #expect(SettingsHubScreen.usesDashboard(
                isOperatorConnected: testCase.connected,
                hasOperatorAdminScope: testCase.admin,
                isDemoMode: testCase.demo,
                isScreenshotMode: testCase.screenshot) == testCase.dashboard)
        }
    }

    @Test func `device panels reach their native iOS destinations`() {
        let routes: [(DeviceSettingsPanel, SettingsRoute)] = [
            (.connection, .gateway),
            (.gateways, .gateway),
            (.watch, .appleWatch),
            (.diagnostics, .diagnostics),
            (.licenses, .licenses),
            (.about, .about),
        ]
        for (panel, route) in routes {
            #expect(SettingsHubScreen.route(for: panel) == route)
        }
        for panel in [DeviceSettingsPanel.quickChatShortcut, .microphoneTest, .browserImport, .debug] {
            #expect(SettingsHubScreen.route(for: panel) == nil)
        }
    }
}
