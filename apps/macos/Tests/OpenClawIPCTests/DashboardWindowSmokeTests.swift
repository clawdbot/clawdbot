import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct DashboardWindowSmokeTests {
    @Test func `dashboard window controller shows and closes`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/#token=device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:18789/control/",
                token: "device-token",
                password: nil))
        controller.show()
        #expect(controller.window?.styleMask.contains(.titled) == true)
        #expect(controller.window?.styleMask.contains(.closable) == true)
        #expect(controller.window?.contentViewController != nil)
        #expect(controller.window?.standardWindowButton(.closeButton) != nil)
        #expect((controller.window?.frame.width ?? 0) >= DashboardWindowLayout.windowMinSize.width)
        #expect((controller.window?.frame.height ?? 0) >= DashboardWindowLayout.windowMinSize.height)
        controller.closeDashboard()
    }

    @Test func `dashboard navigation stays on same endpoint`() throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        #expect(DashboardWindowController.shouldAllowNavigation(
            to: try #require(URL(string: "http://127.0.0.1:18789/control/chat")),
            dashboardURL: dashboard))
        #expect(!DashboardWindowController.shouldAllowNavigation(
            to: try #require(URL(string: "https://docs.openclaw.ai/")),
            dashboardURL: dashboard))
    }

    @Test func `dashboard origin brackets ipv6 literals`() throws {
        let url = try #require(URL(string: "http://[fd12:3456:789a::1]:18789/control/"))
        #expect(DashboardWindowController.originString(for: url) == "http://[fd12:3456:789a::1]:18789")
    }

    @Test func `dashboard failure state opens in dashboard window`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        controller.showFailure(
            title: "Dashboard unavailable",
            message: "Remote control tunnel failed",
            detail: "Reset the remote tunnel and try again.")
        #expect(controller.window?.isVisible == true)
        #expect(controller.window?.styleMask.contains(.closable) == true)
        controller.closeDashboard()
    }
}
