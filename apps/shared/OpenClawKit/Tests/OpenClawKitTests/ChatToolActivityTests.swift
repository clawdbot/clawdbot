import OpenClawKit
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
            details: nil,
            resultText: "done",
            isError: false,
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
            details: nil,
            resultText: "orphaned",
            isError: false,
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
            details: nil,
            resultText: nil,
            isError: false,
            isPending: false)])
    }

    @Test func `threads paired result details`() {
        let details = AnyCodable(["diff": AnyCodable("+1 added")])
        let items = ChatToolActivity.items(
            calls: [self.content(type: "toolCall", id: "call-1", name: "edit")],
            results: [self.content(
                type: "toolResult",
                text: "done",
                id: "call-1",
                name: "edit",
                details: details)])

        #expect(items.first?.details == details)
    }

    @Test func `threads paired and orphan result errors`() {
        let paired = ChatToolActivity.items(
            calls: [self.content(type: "toolCall", id: "call-1", name: "edit")],
            results: [self.content(
                type: "toolResult",
                text: "failed",
                id: "call-1",
                name: "edit",
                isError: true)])
        let orphan = ChatToolActivity.items(
            calls: [],
            results: [self.content(type: "toolResult", text: "failed", isError: true)])

        #expect(paired.first?.isError == true)
        #expect(orphan.first?.isError == true)
    }

    private func content(
        type: String,
        text: String? = nil,
        id: String? = nil,
        name: String? = nil,
        details: AnyCodable? = nil,
        isError: Bool? = nil) -> OpenClawChatMessageContent
    {
        OpenClawChatMessageContent(
            type: type,
            text: text,
            mimeType: nil,
            fileName: nil,
            content: nil,
            id: id,
            name: name,
            details: details,
            isError: isError)
    }
}
