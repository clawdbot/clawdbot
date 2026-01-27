import MoltbotKit
import Foundation
import Testing

@Suite struct DeepLinkParserTests {
    @Test func parseRejectsUnknownHost() {
        let url = URL(string: "moltbot://nope?message=hi")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func parseHostIsCaseInsensitive() {
        let url = URL(string: "moltbot://AGENT?message=Hello")!
        #expect(DeepLinkParser.parse(url) == .agent(.init(
            message: "Hello",
            sessionKey: nil,
            thinking: nil,
            deliver: false,
            to: nil,
            channel: nil,
            timeoutSeconds: nil,
            key: nil)))
    }

    @Test func parseRejectsNonMoltbotScheme() {
        let url = URL(string: "https://example.com/agent?message=hi")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func parseRejectsEmptyMessage() {
        let url = URL(string: "moltbot://agent?message=%20%20%0A")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func parseAgentLinkParsesCommonFields() {
        let url =
            URL(string: "moltbot://agent?message=Hello&deliver=1&sessionKey=node-test&thinking=low&timeoutSeconds=30")!
        #expect(
            DeepLinkParser.parse(url) == .agent(
                .init(
                    message: "Hello",
                    sessionKey: "node-test",
                    thinking: "low",
                    deliver: true,
                    to: nil,
                    channel: nil,
                    timeoutSeconds: 30,
                    key: nil)))
    }

    @Test func parseAgentLinkParsesTargetRoutingFields() {
        let url =
            URL(
                string: "moltbot://agent?message=Hello%20World&deliver=1&to=%2B15551234567&channel=whatsapp&key=secret")!
        #expect(
            DeepLinkParser.parse(url) == .agent(
                .init(
                    message: "Hello World",
                    sessionKey: nil,
                    thinking: nil,
                    deliver: true,
                    to: "+15551234567",
                    channel: "whatsapp",
                    timeoutSeconds: nil,
                    key: "secret")))
    }

    @Test func parseRejectsNegativeTimeoutSeconds() {
        let url = URL(string: "moltbot://agent?message=Hello&timeoutSeconds=-1")!
        #expect(DeepLinkParser.parse(url) == .agent(.init(
            message: "Hello",
            sessionKey: nil,
            thinking: nil,
            deliver: false,
            to: nil,
            channel: nil,
            timeoutSeconds: nil,
            key: nil)))
    }
}
