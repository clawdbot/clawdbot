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
        Task { @MainActor in
            let resolvedSessionKey = if let sessionKey {
                sessionKey
            } else {
                await WebChatManager.shared.preferredSessionKey()
            }
            WebChatManager.shared.show(sessionKey: resolvedSessionKey, agentID: agentID, draft: draft)
        }
    }

    static func toggleCanvas() {
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor in
            if AppStateStore.shared.canvasPanelVisible {
                CanvasManager.shared.hideAll()
            } else {
                let sessionKey = await GatewayConnection.shared.mainSessionKey()
                _ = try? CanvasManager.shared.show(sessionKey: sessionKey, path: nil)
            }
        }
    }

    static func openSettings(tab: SettingsTab = .general) {
        SettingsTabRouter.request(tab)
        SettingsWindowOpener.shared.open()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: tab)
        }
    }
}
