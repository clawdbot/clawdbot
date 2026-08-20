import Testing
@testable import OpenClawChatUI

@Suite("ChatTranscriptRow")
struct ChatTranscriptRowTests {
    private enum Input: Sendable {
        case notice(sourceTool: String?, text: String)
        case marker(kind: String, tokensBefore: Double? = nil, tokensAfter: Double? = nil)
    }

    private enum Expected: Sendable {
        case notice(label: String, body: String)
        case divider(label: String, metric: String?, description: String?)
        case hidden
    }

    private struct Case: Sendable {
        let name: String
        let input: Input
        let expected: Expected
    }

    @Test(arguments: [
        Case(
            name: "restart recovery hides producer prompt",
            input: .notice(
                sourceTool: "main_session_restart_recovery",
                text: "[System] private recovery prompt"),
            expected: .notice(
                label: "System · restart recovery",
                body: "Turn interrupted by a gateway restart — asked the agent to resume and finish the response.")),
        Case(
            name: "restart sentinel keeps producer text",
            input: .notice(
                sourceTool: "restart-sentinel",
                text: "[System] Gateway restarted after an update."),
            expected: .notice(
                label: "System · gateway restarted",
                body: "Gateway restarted after an update.")),
        Case(
            name: "other source tool is generic without fuzzy matching",
            input: .notice(
                sourceTool: "Restart-Sentinel",
                text: "[System] Doctor repaired the gateway."),
            expected: .notice(
                label: "System",
                body: "Doctor repaired the gateway.")),
        Case(
            name: "compaction reports finite token savings",
            input: .marker(kind: "compaction", tokensBefore: 22750, tokensAfter: 9200),
            expected: .divider(
                label: "Compacted history",
                metric: "saved 13.6k tokens",
                description: nil)),
        Case(
            name: "reset explains cleared history",
            input: .marker(kind: "reset"),
            expected: .divider(
                label: "Session reset",
                metric: nil,
                description: "The earlier conversation was cleared.")),
        Case(
            name: "unknown marker is hidden without fuzzy matching",
            input: .marker(kind: "Compaction", tokensBefore: 10000, tokensAfter: 1000),
            expected: .hidden),
    ])
    private func `classifies control UI system row contracts`(testCase: Case) {
        let message = switch testCase.input {
        case let .notice(sourceTool, text):
            OpenClawChatMessage(
                role: "user",
                content: [OpenClawChatMessageContent(
                    type: "text",
                    text: text,
                    mimeType: nil,
                    fileName: nil,
                    content: nil)],
                timestamp: 1,
                provenance: OpenClawChatInputProvenance(
                    kind: "internal_system",
                    sourceTool: sourceTool))
        case let .marker(kind, tokensBefore, tokensAfter):
            OpenClawChatMessage(
                role: "system",
                content: [],
                timestamp: 1,
                historyMarker: OpenClawChatHistoryMarker(
                    kind: kind,
                    id: "marker-1",
                    tokensBefore: tokensBefore,
                    tokensAfter: tokensAfter))
        }

        let row = ChatTranscriptRow(message)
        switch (testCase.expected, row) {
        case (.hidden, nil):
            break
        case let (.notice(expectedLabel, expectedBody), .systemNotice(notice)):
            #expect(notice.label == expectedLabel)
            #expect(notice.body == expectedBody)
        case let (.divider(expectedLabel, expectedMetric, expectedDescription), .historyDivider(divider)):
            #expect(divider.label == expectedLabel)
            #expect(divider.metric == expectedMetric)
            #expect(divider.description == expectedDescription)
        default:
            Issue.record("Unexpected row classification for \(testCase.name)")
        }
    }

    @Test(arguments: [
        (nil, nil),
        (10000, nil),
        (10000, 10000),
        (10000, 12000),
        (Double.infinity, 1000),
    ])
    func `compaction omits invalid token metrics`(tokensBefore: Double?, tokensAfter: Double?) throws {
        let message = OpenClawChatMessage(
            role: "system",
            content: [],
            timestamp: 1,
            historyMarker: OpenClawChatHistoryMarker(
                kind: "compaction",
                tokensBefore: tokensBefore,
                tokensAfter: tokensAfter))

        guard case let .historyDivider(divider) = try #require(ChatTranscriptRow(message)) else {
            Issue.record("Expected a compaction divider")
            return
        }
        #expect(divider.metric == nil)
    }

    @Test(arguments: [
        (0, "0"),
        (999, "999"),
        (1000, "1k"),
        (214_500, "214.5k"),
        (999_950, "1M"),
        (1_050_000, "1.1M"),
    ])
    func `compact token counts mirror the control UI`(tokens: Double, expected: String) {
        #expect(ChatCompactTokenCountFormatter.string(tokens) == expected)
    }
}
