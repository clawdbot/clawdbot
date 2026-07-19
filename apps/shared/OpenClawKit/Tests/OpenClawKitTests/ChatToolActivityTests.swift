import Testing
@testable import OpenClawChatUI

@Suite("ChatToolActivity")
struct ChatToolActivityTests {
    @Test func `pairs call and result by ID`() {
        let items = ChatToolActivity.items(
            calls: [self.content(type: "toolCall", id: "call-1", name: "exec")],
            results: [self.content(type: "toolResult", text: "done", id: "call-1", name: "exec")])

        #expect(items == [ChatToolActivityItem(
            id: "call-1",
            name: "exec",
            arguments: nil,
            resultText: "done",
            isPending: false)])
    }

    @Test func `appends orphan result`() {
        let items = ChatToolActivity.items(
            calls: [],
            results: [self.content(type: "toolResult", text: "orphaned", name: "read")])

        #expect(items == [ChatToolActivityItem(
            id: "result-0",
            name: "read",
            arguments: nil,
            resultText: "orphaned",
            isPending: false)])
    }

    @Test func `preserves call order`() {
        let items = ChatToolActivity.items(
            calls: [
                self.content(type: "toolCall", id: "call-1", name: "read"),
                self.content(type: "toolCall", id: "call-2", name: "write"),
            ],
            results: [
                self.content(type: "toolResult", text: "second", id: "call-2", name: "write"),
                self.content(type: "toolResult", text: "first", id: "call-1", name: "read"),
            ])

        #expect(items.map(\.id) == ["call-1", "call-2"])
        #expect(items.map(\.resultText) == ["first", "second"])
    }

    @Test func `leaves call without result unexpandable`() {
        let items = ChatToolActivity.items(
            calls: [self.content(type: "toolCall", name: "search")],
            results: [])

        #expect(items == [ChatToolActivityItem(
            id: "call-0",
            name: "search",
            arguments: nil,
            resultText: nil,
            isPending: false)])
    }

    private func content(
        type: String,
        text: String? = nil,
        id: String? = nil,
        name: String? = nil) -> OpenClawChatMessageContent
    {
        OpenClawChatMessageContent(
            type: type,
            text: text,
            mimeType: nil,
            fileName: nil,
            content: nil,
            id: id,
            name: name)
    }
}
