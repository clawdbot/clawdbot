import Testing
@testable import OpenClawChatUI

@Suite("ChatUserMessageDisclosurePolicy")
struct ChatUserMessageDisclosurePolicyTests {
    @Test func `short prompts remain fully visible`() {
        #expect(ChatUserMessageDisclosurePolicy.collapsedPreview("Short prompt") == nil)
        #expect(ChatUserMessageDisclosurePolicy.collapsedPreview(
            Array(repeating: "line", count: 12).joined(separator: "\n")) == nil)
        #expect(ChatUserMessageDisclosurePolicy.collapsedPreview(
            String(repeating: "a", count: 700)) == nil)
    }

    @Test func `long prompts produce a bounded plain text preview`() {
        let lines = Array(repeating: "line", count: 13).joined(separator: "\n")
        #expect(ChatUserMessageDisclosurePolicy.collapsedPreview(lines) ==
            Array(repeating: "line", count: 12).joined(separator: "\n") + "…")
        #expect(ChatUserMessageDisclosurePolicy.collapsedPreview(
            String(repeating: "a", count: 701)) == String(repeating: "a", count: 700) + "…")
    }
}
