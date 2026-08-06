import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing

private func setupCode(from payload: String) -> String {
    Data(payload.utf8)
        .base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func gatewayLink(from raw: String) -> GatewayConnectDeepLink? {
    guard let url = URL(string: raw),
          case let .gateway(link)? = DeepLinkParser.parse(url)
    else { return nil }
    return link
}

@Suite struct DeepLinksSecurityTests {
    @Test func setupResultInitializerKeepsLegacySignature() {
        let result = DevicePairSetupCodeResult(
            setupcode: "code",
            qrdataurl: nil,
            gatewayurl: "wss://gateway.example.com",
            auth: AnyCodable("token"),
            urlsource: "config")

        #expect(result.gatewayurls == nil)
    }

    @Test func dashboardDeepLinkParses() {
        let url = URL(string: "openclaw://dashboard")!
        #expect(DeepLinkParser.parse(url) == .dashboard)
    }

    @Test func debugDashboardDeepLinkParses() {
        let url = URL(string: "openclaw-debug://dashboard")!
        #expect(DeepLinkParser.parse(url) == .dashboard)
    }

    @Test func gatewayDeepLinkUsesTlsDefaultPortWhenPortMissing() {
        let link = gatewayLink(from: "openclaw://gateway?host=gateway.example.com&tls=1")
        #expect(link?.port == 443)
        #expect(link?.tls == true)
    }

    @Test func gatewayDeepLinkUsesPlaintextDefaultPortWhenPortMissing() {
        let link = gatewayLink(from: "openclaw://gateway?host=127.0.0.1&tls=0")
        #expect(link?.port == 18789)
        #expect(link?.tls == false)
    }

    @Test func gatewayDeepLinkPreservesExplicitTlsPort() {
        let link = gatewayLink(from: "openclaw://gateway?host=gateway.example.com&port=18789&tls=1")
        #expect(link?.port == 18789)
        #expect(link?.tls == true)
    }

    @Test func gatewayDeepLinkRejectsInsecureNonLoopbackWs() {
        let url = URL(
            string: "openclaw://gateway?host=attacker.example&port=18789&tls=0&token=abc")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func gatewayDeepLinkRejectsInsecurePrefixBypassHost() {
        let url = URL(
            string: "openclaw://gateway?host=127.attacker.example&port=18789&tls=0&token=abc")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func gatewayDeepLinkAllowsLoopbackWs() {
        let url = URL(
            string: "openclaw://gateway?host=127.0.0.1&port=18789&tls=0&token=abc")!
        #expect(
            DeepLinkParser.parse(url) == .gateway(
                .init(
                    host: "127.0.0.1",
                    port: 18789,
                    tls: false,
                    bootstrapToken: nil,
                    token: "abc",
                    password: nil)))
    }

    @Test func setupCodeRejectsInsecureNonLoopbackWs() {
        let payload = #"{"url":"ws://attacker.example:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func setupCodeRejectsInsecurePrefixBypassHost() {
        let payload = #"{"url":"ws://127.attacker.example:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func setupCodeAllowsLoopbackWs() {
        let payload = #"{"url":"ws://127.0.0.1:18789","bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "127.0.0.1",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupCodeAllowsPrivateLanWs() {
        let payload = #"{"url":"ws://192.168.1.20:18789","bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "192.168.1.20",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupCodeAllowsMDNSWs() {
        let payload = #"{"url":"ws://openclaw.local:18789","bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "openclaw.local",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupCodeParsesOrderedGatewayFallbacks() throws {
        let payload = #"{"url":"ws://192.168.1.20:18789","urls":["ws://192.168.1.20:18789","wss://gateway.tailnet.ts.net:8443"],"bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.connectionEndpoints == [
            .init(host: "192.168.1.20", port: 18789, tls: false),
            .init(host: "gateway.tailnet.ts.net", port: 8443, tls: true),
        ])
        #expect(try link?.selectingEndpoint(#require(link?.connectionEndpoints[1])) == .init(
            host: "gateway.tailnet.ts.net",
            port: 8443,
            tls: true,
            bootstrapToken: "tok",
            token: nil,
            password: nil))
    }

    @Test func legacyEncodedGatewayLinkDecodesWithoutFallbacks() throws {
        let payload = #"{"host":"gateway.tailnet.ts.net","port":443,"tls":true}"#

        let link = try JSONDecoder().decode(
            GatewayConnectDeepLink.self,
            from: Data(payload.utf8))

        #expect(link.fallbackEndpoints.isEmpty)
    }

    @Test func setupCodeDropsInsecureGatewayFallbacks() {
        let payload = #"{"url":"ws://attacker.example:18789","urls":["ws://attacker.example:18789","wss://gateway.tailnet.ts.net"],"bootstrapToken":"tok"}"#

        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
            host: "gateway.tailnet.ts.net",
            port: 443,
            tls: true,
            bootstrapToken: "tok",
            token: nil,
            password: nil))
    }

    @Test func setupCodeCapsGatewayEndpoints() throws {
        let urls = (0..<10).map { "wss://gateway-\($0).example.com" }
        let data = try JSONSerialization.data(withJSONObject: ["url": urls[0], "urls": urls])
        let payload = try #require(String(data: data, encoding: .utf8))

        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.connectionEndpoints.count == 8)
        #expect(link?.connectionEndpoints.last?.host == "gateway-7.example.com")
    }

    @Test func setupCodeRejectsTailnetPlaintextWs() {
        let payload = #"{"url":"ws://gateway.tailnet.ts.net:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func setupCodeRejectsCgnatPlaintextWs() {
        let payload = #"{"url":"ws://100.64.0.9:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func setupCodeParsesHostPayload() {
        let payload = #"{"host":"gateway.tailnet.ts.net","port":443,"tls":true,"bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "gateway.tailnet.ts.net",
                port: 443,
                tls: true,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupCodeParsesHostPayloadWithTLSDefaultPort() {
        let payload = #"{"host":"gateway.tailnet.ts.net","tls":true,"bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "gateway.tailnet.ts.net",
                port: 443,
                tls: true,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupCodeRejectsInsecureHostPayload() {
        let payload = #"{"host":"gateway.tailnet.ts.net","port":18789,"tls":false,"bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func setupCodeAllowsPrivateLanHostPayload() {
        let payload = #"{"host":"openclaw.local","port":18789,"tls":false,"bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "openclaw.local",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupInputParsesFullCopiedSetupMessage() {
        let payload = #"{"url":"wss://gateway.tailnet.ts.net","bootstrapToken":"tok"}"#
        let message = """
        Pairing setup code generated.

        Setup code:
        \(setupCode(from: payload))
        """
        #expect(
            GatewayConnectDeepLink.fromSetupInput(message) == .init(
                host: "gateway.tailnet.ts.net",
                port: 443,
                tls: true,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupInputParsesRawGatewayURL() {
        #expect(
            GatewayConnectDeepLink.fromSetupInput("wss://gateway.example.com:444") == .init(
                host: "gateway.example.com",
                port: 444,
                tls: true,
                bootstrapToken: nil,
                token: nil,
                password: nil))
    }
}
