import OpenClawKit
import Foundation
import Testing

private func setupCode(from payload: String) -> String {
    Data(payload.utf8)
        .base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func agentAction(
    message: String,
    sessionKey: String? = nil,
    thinking: String? = nil,
    deliver: Bool = false,
    to: String? = nil,
    channel: String? = nil,
    timeoutSeconds: Int? = nil,
    key: String? = nil) -> DeepLinkRoute
{
    .agent(
        .init(
            message: message,
            sessionKey: sessionKey,
            thinking: thinking,
            deliver: deliver,
            to: to,
            channel: channel,
            timeoutSeconds: timeoutSeconds,
            key: key))
}

@Suite struct DeepLinkParserTests {
    @Test func parseRejectsUnknownHost() {
        let url = URL(string: "openclaw://nope?message=hi")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func parseHostIsCaseInsensitive() {
        let url = URL(string: "openclaw://AGENT?message=Hello")!
        #expect(DeepLinkParser.parse(url) == agentAction(message: "Hello"))
    }

    @Test func parseRejectsNonOpenClawScheme() {
        let url = URL(string: "https://example.com/agent?message=hi")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func parseRejectsEmptyMessage() {
        let url = URL(string: "openclaw://agent?message=%20%20%0A")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func parseAgentLinkParsesCommonFields() {
        let url =
            URL(string: "openclaw://agent?message=Hello&deliver=1&sessionKey=node-test&thinking=low&timeoutSeconds=30")!
        #expect(DeepLinkParser.parse(url) == agentAction(
            message: "Hello",
            sessionKey: "node-test",
            thinking: "low",
            deliver: true,
            timeoutSeconds: 30))
    }

    @Test func parseAgentLinkParsesTargetRoutingFields() {
        let url =
            URL(
                string: "openclaw://agent?message=Hello%20World&deliver=1&to=%2B15551234567&channel=whatsapp&key=secret")!
        #expect(DeepLinkParser.parse(url) == agentAction(
            message: "Hello World",
            deliver: true,
            to: "+15551234567",
            channel: "whatsapp",
            key: "secret"))
    }

    @Test func parseRejectsNegativeTimeoutSeconds() {
        let url = URL(string: "openclaw://agent?message=Hello&timeoutSeconds=-1")!
        #expect(DeepLinkParser.parse(url) == agentAction(message: "Hello"))
    }

    @Test func parseGatewayLinkParsesCommonFields() {
        let url = URL(
            string: "openclaw://gateway?host=openclaw.local&port=18789&tls=1&token=abc&password=def")!
        #expect(
            DeepLinkParser.parse(url) == .gateway(
                .init(
                    host: "openclaw.local",
                    port: 18789,
                    tls: true,
                    bootstrapToken: nil,
                    token: "abc",
                    password: "def")))
    }

    @Test func parseGatewayLinkRejectsInsecureNonLoopbackWs() {
        let url = URL(
            string: "openclaw://gateway?host=attacker.example&port=18789&tls=0&token=abc")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func parseGatewayLinkAllowsPrivateLanWs() {
        let url = URL(
            string: "openclaw://gateway?host=openclaw.local&port=18789&tls=0&token=abc")!
        #expect(
            DeepLinkParser.parse(url) == .gateway(
                .init(
                    host: "openclaw.local",
                    port: 18789,
                    tls: false,
                    bootstrapToken: nil,
                    token: "abc",
                    password: nil)))
    }

    @Test func parseGatewayLinkRejectsInsecurePrefixBypassHost() {
        let url = URL(
            string: "openclaw://gateway?host=127.attacker.example&port=18789&tls=0&token=abc")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func parseGatewaySetupCodeParsesBase64UrlPayload() {
        let payload = #"{"url":"wss://gateway.example.com:443","bootstrapToken":"tok","password":"pw"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link == .init(
            host: "gateway.example.com",
            port: 443,
            tls: true,
            bootstrapToken: "tok",
            token: nil,
            password: "pw"))
    }

    @Test func parseGatewaySetupCodeRejectsInvalidInput() {
        #expect(GatewayConnectDeepLink.fromSetupCode("not-a-valid-setup-code") == nil)
    }

    @Test func parseGatewaySetupCodeDefaultsTo443ForWssWithoutPort() {
        let payload = #"{"url":"wss://gateway.example.com","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link == .init(
            host: "gateway.example.com",
            port: 443,
            tls: true,
            bootstrapToken: "tok",
            token: nil,
            password: nil))
    }

    @Test func parseGatewaySetupCodeRejectsInsecureNonLoopbackWs() {
        let payload = #"{"url":"ws://attacker.example:18789","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))
        #expect(link == nil)
    }

    @Test func parseGatewaySetupCodeRejectsInsecurePrefixBypassHost() {
        let payload = #"{"url":"ws://127.attacker.example:18789","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))
        #expect(link == nil)
    }

    @Test func parseGatewaySetupCodeAllowsLoopbackWs() {
        let payload = #"{"url":"ws://127.0.0.1:18789","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link == .init(
            host: "127.0.0.1",
            port: 18789,
            tls: false,
            bootstrapToken: "tok",
            token: nil,
            password: nil))
    }

    @Test func parseGatewaySetupCodeAllowsPrivateLanWs() {
        let payload = #"{"url":"ws://openclaw.local:18789","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link == .init(
            host: "openclaw.local",
            port: 18789,
            tls: false,
            bootstrapToken: "tok",
            token: nil,
            password: nil))
    }

    @Test func parseGatewaySetupCodeRejectsTailnetPlaintextWs() {
        let payload = #"{"url":"ws://gateway.tailnet.ts.net:18789","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))
        #expect(link == nil)
    }

    @Test func parseGatewaySetupInputParsesFullCopiedSetupMessage() {
        let payload = #"{"url":"wss://gateway.example.com","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupInput("""
        Pairing setup code generated.

        Setup code:
        \(setupCode(from: payload))
        """)

        #expect(link == .init(
            host: "gateway.example.com",
            port: 443,
            tls: true,
            bootstrapToken: "tok",
            token: nil,
            password: nil))
    }

    @Test func parseGatewaySetupInputParsesRawGatewayURL() {
        let link = GatewayConnectDeepLink.fromSetupInput("wss://gateway.example.com:444")

        #expect(link == .init(
            host: "gateway.example.com",
            port: 444,
            tls: true,
            bootstrapToken: nil,
            token: nil,
            password: nil))
    }
}
