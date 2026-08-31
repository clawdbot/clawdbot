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
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let url = server.url("/#token=route-a-device-token")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "route-a-device-token",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        let authGate = DashboardReconnectAuthGate()
        let socketURL = replacementServer.websocketURL("")
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
            replacementServer.url("/#token=route-b-device-token").absoluteString)
    }
}
