import AppKit
import OpenClawKit

@MainActor
enum AppNavigationActions {
    static func openDashboard() {
        DashboardManager.shared.presentDashboard()
    }

    /// Post-AI-setup handoff: land in the dashboard's custodian onboarding,
    /// which owns everything after working inference (memory import, channels,
    /// app recommendations, hatch).
    static func openDashboardOnboarding() {
        Task { @MainActor in
            await DashboardManager.shared.show(
                atPath: DashboardRouteMap.custodianPagePath,
                search: DashboardRouteMap.custodianOnboardingSearch)
        }
    }

    static func openChat(sessionKey: String? = nil, agentID: String? = nil, draft: String? = nil) {
        NSApp.activate(ignoringOtherApps: true)
        WebChatManager.shared.show(sessionKey: sessionKey, agentID: agentID, draft: draft)
    }

    static func openSettings() {
        Task { await DashboardManager.shared.show(atPath: DashboardRouteMap.settingsPath) }
    }

    static func openConnection(tab: ConnectionTab = .connection) {
        NSApp.activate(ignoringOtherApps: true)
        ConnectionWindowOpener.shared.open(tab: tab, debugEnabled: AppStateStore.shared.debugPaneEnabled)
    }

    static func openAbout() {
        let build = ArtifactBuildInfo(infoDictionary: Bundle.main.infoDictionary ?? [:])
        let credits = NSMutableAttributedString(string: String(localized:
            "Menu bar companion for notifications, screenshots, and privileged agent actions."))
        credits.append(NSAttributedString(string: "\n\n" + build.copyText + "\n\n"))
        for (title, address) in [
            (String(localized: "Website"), "https://openclaw.ai"),
            (String(localized: "Docs"), "https://docs.openclaw.ai"),
            (String(localized: "GitHub"), "https://github.com/openclaw/openclaw"),
            (String(localized: "Discord"), "https://discord.gg/clawd"),
        ] {
            credits.append(NSAttributedString(string: title + "\n", attributes: [.link: address]))
        }
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "OpenClaw",
            .applicationVersion: build.version,
            .version: build.build,
            .credits: credits,
            NSApplication.AboutPanelOptionKey(rawValue: "Copyright"):
                String(localized: "© 2026 OpenClaw Foundation — MIT License."),
        ])
    }
}
