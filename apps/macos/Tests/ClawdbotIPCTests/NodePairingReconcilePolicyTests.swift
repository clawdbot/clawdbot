import Testing
@testable import Clawdbot

@Suite struct NodePairingReconcilePolicyTests {
    @Test func policyPollsOnlyWhenActive() {
        #expect(NodePairingReconcilePolicy.shouldPoll(pendingCount: 0, isPresenting: false) == false)
        #expect(NodePairingReconcilePolicy.shouldPoll(pendingCount: 1, isPresenting: false))
        #expect(NodePairingReconcilePolicy.shouldPoll(pendingCount: 0, isPresenting: true))
    }

    @Test func policyUsesSlowSafetyInterval() {
        #expect(NodePairingReconcilePolicy.activeIntervalMs >= 10000)
    }
}
