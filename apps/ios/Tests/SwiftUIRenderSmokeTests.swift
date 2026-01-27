import MoltbotKit
import SwiftUI
import Testing
import UIKit
@testable import Moltbot

@Suite struct SwiftUIRenderSmokeTests {
    @MainActor private static func host(_ view: some View) -> UIWindow {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        return window
    }

    @Test @MainActor func statusPillConnectingBuildsAViewHierarchy() {
        let root = StatusPill(gateway: .connecting, voiceWakeEnabled: true, brighten: true) {}
        _ = Self.host(root)
    }

    @Test @MainActor func statusPillDisconnectedBuildsAViewHierarchy() {
        let root = StatusPill(gateway: .disconnected, voiceWakeEnabled: false) {}
        _ = Self.host(root)
    }

    @Test @MainActor func settingsTabBuildsAViewHierarchy() {
        let appModel = NodeAppModel()
        let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        let root = SettingsTab()
            .environment(appModel)
            .environment(appModel.voiceWake)
            .environment(gatewayController)

        _ = Self.host(root)
    }

    @Test @MainActor func rootTabsBuildAViewHierarchy() {
        let appModel = NodeAppModel()
        let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

        let root = RootTabs()
            .environment(appModel)
            .environment(appModel.voiceWake)
            .environment(gatewayController)

        _ = Self.host(root)
    }

    @Test @MainActor func voiceTabBuildsAViewHierarchy() {
        let appModel = NodeAppModel()

        let root = VoiceTab()
            .environment(appModel)
            .environment(appModel.voiceWake)

        _ = Self.host(root)
    }

    @Test @MainActor func voiceWakeWordsViewBuildsAViewHierarchy() {
        let appModel = NodeAppModel()
        let root = NavigationStack { VoiceWakeWordsSettingsView() }
            .environment(appModel)
        _ = Self.host(root)
    }

    @Test @MainActor func chatSheetBuildsAViewHierarchy() {
        let appModel = NodeAppModel()
        let gateway = GatewayNodeSession()
        let root = ChatSheet(gateway: gateway, sessionKey: "test")
            .environment(appModel)
            .environment(appModel.voiceWake)
        _ = Self.host(root)
    }

    @Test @MainActor func voiceWakeToastBuildsAViewHierarchy() {
        let root = VoiceWakeToast(command: "moltbot: do something")
        _ = Self.host(root)
    }
}
