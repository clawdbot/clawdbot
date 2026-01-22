import Testing
@testable import Clawdbot

@Suite
@MainActor
struct ExecApprovalsGatewayPrompterTests {
    @Test func sessionMatchPrefersActiveSession() {
        let matches = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .remote,
            activeSession: " main ",
            requestSession: "main",
            lastInputSeconds: nil)
        #expect(matches)

        let mismatched = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .remote,
            activeSession: "other",
            requestSession: "main",
            lastInputSeconds: 0)
        #expect(!mismatched)
    }

    @Test func sessionFallbackUsesRecentActivity() {
        let recent = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .remote,
            activeSession: nil,
            requestSession: "main",
            lastInputSeconds: 10,
            thresholdSeconds: 120)
        #expect(recent)

        let stale = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .remote,
            activeSession: nil,
            requestSession: "main",
            lastInputSeconds: 200,
            thresholdSeconds: 120)
        #expect(!stale)
    }

    @Test func defaultBehaviorMatchesMode() {
        let local = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .local,
            activeSession: nil,
            requestSession: nil,
            lastInputSeconds: 400)
        #expect(local)

        let remote = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .remote,
            activeSession: nil,
            requestSession: nil,
            lastInputSeconds: 400)
        #expect(!remote)
    }
}
