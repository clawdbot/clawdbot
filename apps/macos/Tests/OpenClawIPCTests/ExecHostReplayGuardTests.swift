import Testing
@testable import OpenClaw

struct ExecHostReplayGuardTests {
    @Test
    func `nonce is consumed once within the freshness retention window`() {
        let replayGuard = ExecHostReplayGuard()

        #expect(replayGuard.consume(nonce: "first", nowMs: 1000))
        #expect(!replayGuard.consume(nonce: "first", nowMs: 1001))
        #expect(replayGuard.consume(nonce: "second", nowMs: 1001))
        #expect(!replayGuard.consume(nonce: "", nowMs: 1002))
        #expect(replayGuard.consume(nonce: "first", nowMs: 21001))
    }
}
