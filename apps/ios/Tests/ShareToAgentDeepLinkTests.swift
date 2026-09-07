import Foundation
import OpenClawKit
import Testing

@Suite(.serialized) struct ShareToAgentDeepLinkTests {
    @Test func `build message ignores retired default instruction`() throws {
        let defaults = try #require(UserDefaults(suiteName: OpenClawAppGroup.identifier))
        let previous = defaults.object(forKey: "share.defaultInstruction")
        defaults.set("Use the stale saved instruction.", forKey: "share.defaultInstruction")
        defer {
            if let previous {
                defaults.set(previous, forKey: "share.defaultInstruction")
            } else {
                defaults.removeObject(forKey: "share.defaultInstruction")
            }
        }
        let payload = SharedContentPayload(title: nil, url: nil, text: "Read this")

        #expect(ShareToAgentDeepLink.buildMessage(from: payload) == "Shared from iOS.\n\nText:\nRead this")
        #expect(ShareToAgentDeepLink.buildMessage(from: payload, instruction: " \n ") ==
            "Shared from iOS.\n\nText:\nRead this")
        #expect(ShareToAgentDeepLink.buildMessage(from: payload, instruction: " Summarize this. ") ==
            "Shared from iOS.\n\nText:\nRead this\n\nSummarize this.")
        #expect(ShareToAgentDeepLink.buildURL(from: SharedContentPayload(title: nil, url: nil, text: nil)) == nil)
    }

    @Test func `app group identifier uses canonical open claw group`() {
        #expect(OpenClawAppGroup.canonicalIdentifier == "group.ai.openclawfoundation.app.shared")
    }

    @Test func `build message includes shared fields`() throws {
        let payload = try SharedContentPayload(
            title: "Article",
            url: #require(URL(string: "https://example.com/post")),
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

    @Test func `build URL encodes agent route`() throws {
        let payload = try SharedContentPayload(
            title: "",
            url: #require(URL(string: "https://example.com")),
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

    @Test func `build URL returns nil when payload empty`() {
        let payload = SharedContentPayload(title: nil, url: nil, text: nil)
        #expect(ShareToAgentDeepLink.buildURL(from: payload) == nil)
    }
}
