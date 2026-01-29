import MoltbotKit
import Foundation
import Testing
@testable import Moltbot

@Suite(.serialized) struct GatewayDualSessionStateTests {
    @Test @MainActor func connectToGatewayStartsOperatorAndNodeSessions() async {
        let session = TestGatewayWebSocketSession()
        let appModel = NodeAppModel(
            gatewaySession: GatewayOperatorSession(),
            nodeSession: GatewayNodeSession())

        let operatorOptions = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "moltbot-ios",
            clientMode: "ui",
            clientDisplayName: "Test")
        // Node role should have empty scopes - operator scopes are operator-only
        let nodeOptions = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["camera"],
            commands: [],
            permissions: [:],
            clientId: "moltbot-ios",
            clientMode: "node",
            clientDisplayName: "Test")

        appModel.connectToGateway(
            url: URL(string: "ws://example.invalid")!,
            gatewayStableID: "test",
            tls: nil,
            token: nil,
            password: nil,
            operatorConnectOptions: operatorOptions,
            nodeConnectOptions: nodeOptions,
            sessionBox: WebSocketSessionBox(session: session))

        try? await Task.sleep(nanoseconds: 200_000_000)

        let roles = Set(session.snapshotConnectRoles())
        #expect(roles == ["operator", "node"])
        #expect(appModel.gatewayStatusText == "Connected (operator + node)")

        appModel.disconnectGateway()
        #expect(appModel.gatewayStatusText == "Offline")
    }
}
