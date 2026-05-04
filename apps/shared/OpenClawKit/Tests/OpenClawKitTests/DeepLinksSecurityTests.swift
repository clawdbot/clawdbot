import Foundation
import OpenClawKit
import Testing

private func setupCode(from payload: String) -> String {
    Data(payload.utf8)
        .base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

@Suite struct DeepLinksSecurityTests {
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
