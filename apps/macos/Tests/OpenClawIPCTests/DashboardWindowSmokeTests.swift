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

    @Test func `dashboard log string strips token fragment`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/#token=sekret")) // pragma: allowlist secret
        #expect(dashboardLogString(for: url) == "http://127.0.0.1:18789/control/")
    }

    @Test func `dashboard native chrome clears both desktop sidebars`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        let chromeScript = try #require(controller._testUserScripts.first {
            $0.source.contains("openclaw-native-macos-chrome")
        })

        #expect(chromeScript.source.contains(".sidebar-shell"))
        #expect(chromeScript.source.contains(".settings-sidebar__header"))
        #expect(chromeScript.source.contains("--openclaw-native-titlebar-height"))
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

    private func makeShownController() throws -> DashboardWindowController {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "device-token",
                password: nil))
        controller.show()
        return controller
    }

    @Test func `dashboard follows ready endpoint to a new tunnel port`() async throws {
        let controller = try self.makeShownController()
        defer { controller.closeDashboard() }
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: try #require(URL(string: "ws://127.0.0.1:60002")),
            token: "device-token",
            password: nil))

        #expect(controller.currentURL.absoluteString == "http://127.0.0.1:60002/#token=device-token")
        let authScripts = controller._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(authScripts.count == 1)
        // JSONSerialization escapes "/" so match on host:port, not the full origin.
        #expect(authScripts.first?.source.contains("127.0.0.1:60002") == true)
        #expect(authScripts.first?.source.contains("60001") == false)
    }

    @Test func `dashboard keeps endpoint when ready state matches current URL`() async throws {
        let controller = try self.makeShownController()
        defer { controller.closeDashboard() }
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)
        let scriptsBefore = controller._testUserScripts

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: try #require(URL(string: "ws://127.0.0.1:60001")),
            token: "device-token",
            password: nil))
        await manager.handleEndpointState(.connecting(mode: .remote, detail: "Connecting…"))
        await manager.handleEndpointState(.unavailable(mode: .remote, reason: "tunnel down"))

        #expect(controller.currentURL.absoluteString == "http://127.0.0.1:60001/#token=device-token")
        // Identity check: an unchanged endpoint must not re-inject scripts or reload.
        #expect(controller._testUserScripts.elementsEqual(scriptsBefore) { $0 === $1 })
    }

    @Test func `dashboard ignores endpoint changes while window is closed`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "device-token",
                password: nil))
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: try #require(URL(string: "ws://127.0.0.1:60002")),
            token: "device-token",
            password: nil))

        #expect(controller.currentURL == url)
    }
}
