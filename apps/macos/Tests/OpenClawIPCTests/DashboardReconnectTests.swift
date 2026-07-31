import Foundation
import Testing
@testable import OpenClaw

private actor DashboardReconnectAuthGate {
    private var token: String?

    func authToken() -> String? {
        self.token
    }

    func replaceToken(_ token: String) {
        self.token = token
    }
}

@Suite(.serialized)
@MainActor
struct DashboardReconnectTests {
    @Test func `authenticated control reconnect recovers unchanged ready route`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=route-a-device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "route-a-device-token",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        controller.show()
        let authGate = DashboardReconnectAuthGate()
        let socketURL = try #require(URL(string: "ws://127.0.0.1:60002"))
        let endpointState = GatewayEndpointState.ready(
            mode: .remote,
            url: socketURL,
            token: nil,
            password: nil,
            routeRevision: 2)
        let manager = DashboardManager._testMake(
            authTokenProvider: { _ in await authGate.authToken() },
            endpointStateProvider: { endpointState })
        manager._testSetController(controller)
        defer { manager._testController()?.closeDashboard() }

        await manager.handleEndpointState(endpointState)
        let failureController = try #require(manager._testController())
        #expect(failureController !== controller)
        #expect(failureController.currentURL == URL(string: "about:blank"))

        await manager.handleEndpointState(endpointState)
        #expect(manager._testController() === failureController)

        await authGate.replaceToken("route-b-device-token")
        await manager._testHandleControlChannelStateChange(.connecting)
        #expect(manager._testController() === failureController)

        await manager._testHandleControlChannelStateChange(.connected)

        let recoveredController = try #require(manager._testController())
        #expect(recoveredController !== failureController)
        #expect(!failureController.isWindowOpen)
        #expect(recoveredController.currentURL.absoluteString ==
            "http://127.0.0.1:60002/#token=route-b-device-token")
    }
}
