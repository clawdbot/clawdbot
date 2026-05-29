import Foundation
import OpenClawKit
import Testing

@Suite struct ShareToAgentDeepLinkTests {
    @Test func buildMessageIncludesSharedFields() {
        let payload = SharedContentPayload(
            title: "Article",
            url: URL(string: "https://example.com/post")!,
            text: "Read this")

        let message = ShareToAgentDeepLink.buildMessage(
            from: payload,
            instruction: "Summarize and give next steps.")
        #expect(message.contains("Shared from iOS."))
        #expect(message.contains("Title: Article"))
        #expect(message.contains("URL: https://example.com/post"))
        #expect(message.contains("Text:\nRead this"))
        #expect(message.contains("Summarize and give next steps."))
    }

    @Test func buildURLEncodesAgentRoute() {
        let payload = SharedContentPayload(
            title: "",
            url: URL(string: "https://example.com")!,
            text: nil)

        let url = ShareToAgentDeepLink.buildURL(from: payload)
        let parsed = url.flatMap { DeepLinkParser.parse($0) }
        guard case let .agent(agent)? = parsed else {
            Issue.record("Expected openclaw://agent deep link")
            return
        }

        #expect(agent.thinking == "low")
        #expect(agent.message.contains("https://example.com"))
    }

    @Test func buildURLReturnsNilWhenPayloadEmpty() {
        ShareToAgentSettings.saveDefaultInstruction(nil)
        let payload = SharedContentPayload(title: nil, url: nil, text: nil)
        #expect(ShareToAgentDeepLink.buildURL(from: payload) == nil)
    }

    @Test func shareInstructionSettingsRoundTrip() {
        let value = "Focus on booking constraints and alternatives."
        ShareToAgentSettings.saveDefaultInstruction(nil)
        ShareToAgentSettings.saveDefaultInstruction(value)
        defer { ShareToAgentSettings.saveDefaultInstruction(nil) }

        #expect(ShareToAgentSettings.loadDefaultInstruction() == value)
    }
}
