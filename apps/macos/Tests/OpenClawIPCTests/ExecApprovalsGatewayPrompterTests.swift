import Testing
@testable import OpenClaw

@MainActor
struct ExecApprovalsGatewayPrompterTests {
    @Test func `session match prefers active session`() {
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

    @Test func `session fallback uses recent activity`() {
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

    @Test func `default behavior matches mode`() {
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

    // MARK: - shouldAsk

    @Test func `ask always prompts regardless of security`() {
        #expect(ExecApprovalsGatewayPrompter._testShouldAsk(security: .deny, ask: .always))
        #expect(ExecApprovalsGatewayPrompter._testShouldAsk(security: .allowlist, ask: .always))
        #expect(ExecApprovalsGatewayPrompter._testShouldAsk(security: .full, ask: .always))
    }

    @Test func `ask on miss prompts only for allowlist`() {
        #expect(ExecApprovalsGatewayPrompter._testShouldAsk(security: .allowlist, ask: .onMiss))
        #expect(!ExecApprovalsGatewayPrompter._testShouldAsk(security: .deny, ask: .onMiss))
        #expect(!ExecApprovalsGatewayPrompter._testShouldAsk(security: .full, ask: .onMiss))
    }

    @Test func `ask off never prompts`() {
        #expect(!ExecApprovalsGatewayPrompter._testShouldAsk(security: .deny, ask: .off))
        #expect(!ExecApprovalsGatewayPrompter._testShouldAsk(security: .allowlist, ask: .off))
        #expect(!ExecApprovalsGatewayPrompter._testShouldAsk(security: .full, ask: .off))
    }

    @Test func `fallback allowlist allows matching resolved path`() {
        let decision = ExecApprovalsGatewayPrompter._testFallbackDecision(
            command: "git status",
            resolvedPath: "/usr/bin/git",
            askFallback: .allowlist,
            allowlistPatterns: ["/usr/bin/git"])
        #expect(decision == .allowOnce)
    }

    @Test func `fallback allowlist denies allowlist miss`() {
        let decision = ExecApprovalsGatewayPrompter._testFallbackDecision(
            command: "git status",
            resolvedPath: "/usr/bin/git",
            askFallback: .allowlist,
            allowlistPatterns: ["/usr/bin/rg"])
        #expect(decision == .deny)
    }

    @Test func `fallback full allows when prompt cannot be shown`() {
        let decision = ExecApprovalsGatewayPrompter._testFallbackDecision(
            command: "git status",
            resolvedPath: "/usr/bin/git",
            askFallback: .full,
            allowlistPatterns: [])
        #expect(decision == .allowOnce)
    }
}
