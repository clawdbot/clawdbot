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

    @Test func `session token stats percent used clamps to100`() {
        let stats = SessionTokenStats(total: 250_000, contextTokens: 200_000)
        #expect(stats.percentUsed == 100)
    }
}
