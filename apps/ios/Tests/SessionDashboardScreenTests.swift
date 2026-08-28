import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct SessionDashboardScreenTests {
    @Test func `session roster preserves the dashboard face`() throws {
        let data = Data(
            #"{"key":"agent:main:dashboard:cleanup","displayName":"Nightly Disk Cleanup","boardFace":"dashboard"}"#
                .utf8)

        let session = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: data)

        #expect(session.boardFace == "dashboard")
    }

    @Test func `sidebar sends dashboard sessions to the dashboard and ordinary sessions to chat`() throws {
        let dashboard = try Self.session(boardFace: "dashboard")
        let chat = try Self.session(boardFace: "chat")
        let legacyChat = try Self.session(boardFace: nil)

        #expect(RootTabs.sidebarPresentation(for: dashboard) == .dashboard)
        #expect(RootTabs.sidebarPresentation(for: chat) == .chat)
        #expect(RootTabs.sidebarPresentation(for: legacyChat) == .chat)
    }

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

    private static func session(boardFace: String?) throws -> OpenClawChatSessionEntry {
        var object: [String: String] = [
            "key": "agent:main:dashboard:cleanup",
            "displayName": "Nightly Disk Cleanup",
        ]
        object["boardFace"] = boardFace
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: data)
    }
}
