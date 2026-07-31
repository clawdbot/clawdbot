import AppKit

@MainActor
enum AppNavigationActions {
    static func openDashboard() {
        NSApp.activate(ignoringOtherApps: true)
        if DashboardManager.shared.showConfiguredWindowIfPossible() {
            return
        }
        Task { @MainActor in
            if DashboardManager.shared.showConfiguredWindowIfPossible() {
                return
            }
            do {
                try await DashboardManager.shared.show()
            } catch {
                DashboardManager.shared.showFailure(error)
            }
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
