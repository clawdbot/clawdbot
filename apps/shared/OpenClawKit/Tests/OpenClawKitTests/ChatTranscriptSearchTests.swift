#if os(macOS)
import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatTranscriptSearchTests {
    @Test func `find searches message text without exposing reasoning or tool payloads`() {
        let user = self.message("Find the café", role: "user")
        let assistant = self.message("<think>hidden needle</think>\nThe CAFÉ is open")
        let tool = self.message("café tool payload", role: "toolResult")
        let rows = ChatTranscriptRow.build(from: [user, assistant, tool])

        #expect(ChatTranscriptSearchResults(rows: rows, query: " cafe ").messageIDs == [user.id, assistant.id])
        #expect(ChatTranscriptSearchResults(rows: rows, query: "hidden needle").messageIDs.isEmpty)
        #expect(ChatTranscriptSearchResults(rows: rows, query: "tool payload").messageIDs.isEmpty)
        #expect(ChatTranscriptSearchResults(rows: rows, query: " \n ").messageIDs.isEmpty)
    }

    @Test func `find wraps in both directions and recovers when the selected message disappears`() {
        let first = self.message("match one", role: "user")
        let second = self.message("match two")
        let results = ChatTranscriptSearchResults(rows: [.message(first), .message(second)], query: "match")

        #expect(results.selection(after: nil) == first.id)
        #expect(results.selection(after: first.id) == second.id)
        #expect(results.selection(after: second.id) == first.id)
        #expect(results.selection(after: first.id, backwards: true) == second.id)
        let refreshed = ChatTranscriptSearchResults(rows: [.message(first)], query: "match")
        #expect(refreshed.selection(after: second.id) == first.id)
        #expect(refreshed.selection(after: first.id) == first.id)
        #expect(ChatTranscriptSearchResults(rows: [], query: "match").selection(after: first.id) == nil)
    }

    private func message(_ text: String, role: String = "assistant") -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: role,
            content: [OpenClawChatMessageContent(
                type: "text", text: text, mimeType: nil, fileName: nil, content: nil)],
            timestamp: 1)
    }
}
#endif
