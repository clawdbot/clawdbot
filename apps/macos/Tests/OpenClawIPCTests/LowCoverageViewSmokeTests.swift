import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct LowCoverageViewSmokeTests {
    @Test func `notify overlay keeps replacement visible`() async {
        let controller = NotifyOverlayController()
        controller.present(title: "Hello", body: "World", autoDismissAfter: 0.05)
        controller.present(title: "Updated", body: "Again", autoDismissAfter: 0)
        try? await Task.sleep(nanoseconds: 250_000_000)
        #expect(controller.model.isVisible)
        #expect(controller.model.title == "Updated")

        controller.dismiss()
    }

    @Test func `talk overlay presents twice and dismisses`() async {
        let controller = TalkOverlayController()
        controller.present()
        controller.updateLevel(0.4)
        controller.present()
        controller.dismiss()
        try? await Task.sleep(nanoseconds: 250_000_000)
    }

    @Test func `visual effect view hosts in NS hosting view`() {
        let hosting = NSHostingView(rootView: VisualEffectView(material: .sidebar))
        _ = hosting.fittingSize
        hosting.rootView = VisualEffectView(material: .popover, emphasized: true)
        _ = hosting.fittingSize
    }

    @Test func `menu hosted item hosts content`() {
        let view = MenuHostedItem(width: 240, rootView: AnyView(Text("Menu")))
        let hosting = NSHostingView(rootView: view)
        _ = hosting.fittingSize
        hosting.rootView = MenuHostedItem(width: 320, rootView: AnyView(Text("Updated")))
        _ = hosting.fittingSize
    }

    @Test func `dock icon manager updates visibility`() {
        _ = NSApplication.shared
        UserDefaults.standard.set(false, forKey: showDockIconKey)
        DockIconManager.shared.updateDockVisibility()
        DockIconManager.shared.temporarilyShowDock()
    }
}
