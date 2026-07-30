import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct QuickChatRecentsTests {
    @Test func `menu builds new-message target and five newest session rows`() throws {
        let now = Date(timeIntervalSince1970: 10_000)
        let rows = (0..<6).map { index in
            Self.row(
                key: "agent:main:session:\(index)",
                displayName: "Session \(index)",
                updatedAt: now.addingTimeInterval(Double(-120 - (index * 60))))
        }

        let items = QuickChatRecentMenuLogic.items(
            rows: rows,
            agentName: "Molty",
            selectedTarget: nil,
            now: now)

        #expect(items.count == 6)
        #expect(items[0] == QuickChatRecentMenuItem(
            id: "new-message",
            title: "New message to Molty",
            target: nil,
            isSelected: true))
        #expect(items[1].title == "Session 0 — 2m ago")
        #expect(items.last?.title == "Session 4 — 6m ago")
    }

    @Test func `menu checkmarks the selected recent session`() throws {
        let now = Date(timeIntervalSince1970: 10_000)
        let row = Self.row(
            key: "agent:main:session:one",
            displayName: "One",
            updatedAt: now)
        let target = QuickChatSessionTargetOverride(key: row.key, displayName: row.label)

        let items = QuickChatRecentMenuLogic.items(
            rows: [row],
            agentName: "Molty",
            selectedTarget: target,
            now: now)

        #expect(!items[0].isSelected)
        #expect(items[1].isSelected)
        #expect(items[1].target == target)
    }

    private static func row(
        key: String,
        displayName: String,
        updatedAt: Date) -> SessionRow
    {
        SessionRow(
            id: key,
            key: key,
            kind: .direct,
            displayName: displayName,
            provider: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: updatedAt,
            sessionId: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            systemSent: false,
            abortedLastRun: false,
            tokens: SessionTokenStats(input: 0, output: 0, total: 0, contextTokens: 0),
            model: nil)
    }
}
