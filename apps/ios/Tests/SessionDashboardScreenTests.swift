import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct SessionDashboardScreenTests {
    @Test func `dashboard URL encodes the session and carries the one-shot face`() throws {
        let config = try GatewayConnectConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443/tenant%2Fblue?old=true#fragment")),
            stableID: "manual|gateway.example.com|8443",
            tls: nil,
            token: "secret-token",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Phone"))

        let url = SessionDashboardScreen.dashboardURL(
            config: config,
            sessionKey: "agent:main/phone & qa?x=1")

        #expect(
            url?.absoluteString ==
                "https://gateway.example.com:8443/tenant%2Fblue/chat?session=agent%3Amain%2Fphone%20%26%20qa%3Fx%3D1&face=dashboard")
        #expect(url?.absoluteString.contains("secret-token") == false)
    }
}
