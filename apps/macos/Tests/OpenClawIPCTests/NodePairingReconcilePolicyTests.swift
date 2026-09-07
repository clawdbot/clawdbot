import Testing
@testable import OpenClaw

struct NodePairingReconcilePolicyTests {
    @Test func `policy polls only while requests are pending`() {
        #expect(NodePairingReconcilePolicy.shouldPoll(pendingCount: 0) == false)
        #expect(NodePairingReconcilePolicy.shouldPoll(pendingCount: 1))
    }

    @Test func `policy uses slow safety interval`() {
        #expect(NodePairingReconcilePolicy.activeIntervalMs >= 10000)
    }
}
