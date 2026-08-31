import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

struct SessionDataTests {
    @Test func `session kinds follow authoritative gateway metadata`() throws {
        let response = try JSONDecoder().decode(
            OpenClawChatSessionsListResponse.self,
            from: Data("""
            {"path":"synthetic.sqlite","sessions":[
              {"key":"provider-owned-room-key","kind":"group","classification":"group"},
              {"key":"opaque-scheduled-task","kind":"direct","classification":"cron"},
              {"key":"future-session","kind":"future"},
              {"key":"missing-session-kind"},
              {"key":"opaque-direct","kind":"direct"},
              {"key":"opaque-global","kind":"global"},
              {"key":"opaque-unknown","kind":"unknown"}
            ]}
            """.utf8))

        #expect(response.sessions.map(SessionKind.from) == [
            .group, .cron, .unknown, .unknown, .direct, .global, .unknown,
        ])
    }

    @Test func `session token stats format K tokens rounds as expected`() {
        #expect(SessionTokenStats.formatKTokens(999) == "999")
        #expect(SessionTokenStats.formatKTokens(1000) == "1.0k")
        #expect(SessionTokenStats.formatKTokens(12340) == "12k")
    }

    @Test func `session token stats percent used clamps to100`() {
        let stats = SessionTokenStats(input: 0, output: 0, total: 250_000, contextTokens: 200_000)
        #expect(stats.percentUsed == 100)
    }

    @Test func `session row flag labels include non default flags`() {
        let row = SessionRow(
            id: "x",
            key: "user@example.com",
            kind: .direct,
            displayName: nil,
            updatedAt: Date(),
            sessionId: nil,
            thinkingLevel: "high",
            verboseLevel: "debug",
            systemSent: true,
            abortedLastRun: true,
            tokens: SessionTokenStats(input: 1, output: 2, total: 3, contextTokens: 10),
            model: nil)
        #expect(row.flagLabels.contains("think high"))
        #expect(row.flagLabels.contains("verbose debug"))
        #expect(row.flagLabels.contains("system sent"))
        #expect(row.flagLabels.contains("aborted"))
    }
}
