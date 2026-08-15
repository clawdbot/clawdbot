import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct DesktopHubScreenTests {
    private static func makeConfig(
        url: URL,
        token: String? = nil,
        password: String? = nil) -> GatewayConnectConfig
    {
        GatewayConnectConfig(
            url: url,
            stableID: "manual|gateway.example.com|443",
            tls: nil,
            token: token,
            bootstrapToken: nil,
            password: password,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Phone"))
    }

    @Test func `standalone desktop URL uses document mode without credentials`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443/openclaw")),
            token: "secret-token",
            password: "secret-password")

        let url = DesktopHubScreen.desktopURL(config: config, source: nil, session: nil)

        #expect(url?.absoluteString == "https://gateway.example.com:8443/openclaw/?view=desktop")
        #expect(url?.absoluteString.contains("secret-token") == false)
        #expect(url?.absoluteString.contains("secret-password") == false)
    }

    @Test func `session desktop URL includes the session key`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "ws://192.168.1.10:18789")),
            token: "secret-token")

        let url = DesktopHubScreen.desktopURL(
            config: config,
            source: nil,
            session: "agent:main:mobile session")

        #expect(url?.absoluteString == "http://192.168.1.10:18789/?view=desktop&session=agent%3Amain%3Amobile%20session")
        #expect(url?.absoluteString.contains("secret-token") == false)
    }

    @Test func `explicit desktop source is retained alongside the session`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")))

        let url = DesktopHubScreen.desktopURL(
            config: config,
            source: "node:worker-1",
            session: "agent:main:mobile")

        #expect(url?.absoluteString == "https://gateway.example.com/?view=desktop&source=node%3Aworker-1&session=agent%3Amain%3Amobile")
    }

    @Test func `empty desktop source is omitted`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")))

        let url = DesktopHubScreen.desktopURL(config: config, source: "  ", session: "  ")

        #expect(url?.absoluteString == "https://gateway.example.com/?view=desktop")
    }

    @Test func `desktop auth script carries credentials outside the URL`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com")),
            token: " secret-token ",
            password: "secret-password")

        let url = DesktopHubScreen.desktopURL(config: config, source: "gateway")
        let script = DesktopHubScreen.desktopAuthUserScript(config: config, source: "gateway")

        #expect(url?.absoluteString == "https://gateway.example.com/?view=desktop&source=gateway")
        #expect(url?.absoluteString.contains("secret-token") == false)
        #expect(url?.absoluteString.contains("secret-password") == false)
        #expect(script?.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") == true)
        #expect(script?.contains("\"token\":\"secret-token\"") == true)
        #expect(script?.contains("\"password\":\"secret-password\"") == true)
    }
}
