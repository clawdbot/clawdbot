import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

/// Tool-result diff metadata rides on `OpenClawChatMessage.details`; every
/// field-enumerating message rebuild must carry it or inline diffs silently
/// disappear after cache-warm reconciliation.
@Suite("ChatMessageDetailsPreservation")
struct ChatMessageDetailsPreservationTests {
    private func toolResultMessage(id: UUID = UUID()) -> OpenClawChatMessage {
        OpenClawChatMessage(
            id: id,
            role: "toolResult",
            content: [
                OpenClawChatMessageContent(
                    type: "text",
                    text: "Successfully replaced 1 block(s).",
                    mimeType: nil,
                    fileName: nil,
                    content: nil),
            ],
            timestamp: 1,
            toolCallId: "call-1",
            toolName: "edit",
            details: AnyCodable(["diff": AnyCodable("+1 added\n-1 removed")]))
    }

    private func systemNoticeMessage(id: UUID = UUID()) -> OpenClawChatMessage {
        OpenClawChatMessage(
            id: id,
            role: "user",
            content: [
                OpenClawChatMessageContent(
                    type: "text",
                    text: "[System] gateway restarted",
                    mimeType: nil,
                    fileName: nil,
                    content: nil),
            ],
            timestamp: 2,
            provenance: OpenClawChatInputProvenance(
                kind: "internal_system",
                sourceTool: "restart-sentinel"))
    }

    @MainActor @Test func `decode pipeline keeps message details`() throws {
        let payloadData = try JSONEncoder().encode([self.toolResultMessage(), self.systemNoticeMessage()])
        let anyMessages = try JSONDecoder().decode([AnyCodable].self, from: payloadData)
        let decoded = OpenClawChatViewModel.decodeMessages(anyMessages)

        #expect(decoded.first?.details != nil)
        #expect(decoded.last?.provenance?.sourceTool == "restart-sentinel")
    }

    @MainActor @Test func `canonical adoption keeps incoming details`() {
        let incoming = self.toolResultMessage()
        let existing = self.toolResultMessage()

        let adopted = OpenClawChatViewModel.adoptingCanonicalMessage(incoming, over: existing)

        #expect(adopted.id == existing.id)
        #expect(adopted.details != nil)

        let incomingNotice = self.systemNoticeMessage()
        let adoptedNotice = OpenClawChatViewModel.adoptingCanonicalMessage(
            incomingNotice,
            over: self.systemNoticeMessage())
        #expect(adoptedNotice.provenance == incomingNotice.provenance)
    }
}
