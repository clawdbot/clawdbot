import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized) struct GatewayConnectionIssueTests {
    @Test func `detects token missing`() {
        let issue = GatewayConnectionIssue.detect(from: "unauthorized: gateway token missing")
        #expect(issue == .tokenMissing)
        #expect(issue.needsAuthCredentials)
    }

    @Test func `detects password missing`() {
        let issue = GatewayConnectionIssue.detect(
            from: "unauthorized: gateway password missing (provide gateway auth password)")
        #expect(issue == .passwordMissing)
        #expect(issue.needsAuthCredentials)
    }

    @Test func `detects structured password missing`() {
        let problem = GatewayConnectionProblem(
            kind: .gatewayAuthPasswordMissing,
            owner: .gateway,
            title: "Gateway password required",
            message: "This gateway requires a password.",
            retryable: true,
            pauseReconnect: false)
        let issue = GatewayConnectionIssue.detect(problem: problem)
        #expect(issue == .passwordMissing)
        #expect(issue.needsAuthCredentials)
    }

    @Test func `detects unauthorized`() {
        let issue = GatewayConnectionIssue.detect(from: "Gateway error: unauthorized role")
        #expect(issue == .unauthorized)
        #expect(issue.needsAuthCredentials)
    }

    @Test func `detects pairing with request id`() {
        let issue = GatewayConnectionIssue.detect(from: "pairing required (requestId: abc123)")
        #expect(issue == .pairingRequired(requestId: "abc123"))
        #expect(issue.needsPairing)
        #expect(issue.requestId == "abc123")
    }

    @Test func `detects network error`() {
        let issue = GatewayConnectionIssue.detect(from: "Gateway error: Connection refused")
        #expect(issue == .network)
    }

    @Test func `returns none for benign status`() {
        let issue = GatewayConnectionIssue.detect(from: "Connected")
        #expect(issue == .none)
    }

    @Test func `legacy identity conflict does not advertise Mac recovery`() throws {
        let conflict = DeviceIdentityConflictError(candidates: [
            DeviceIdentityConflictCandidate(
                sourcePath: "~/Documents/identity/device.json",
                fingerprint: "0123456789ab",
                createdAtMs: 1_800_000_000_000),
        ], profile: .primary)
        let problem = try #require(GatewayConnectionProblemMapper.map(error: conflict))

        #expect(problem.kind == .legacyIdentityConflict)
        #expect(problem.actionLabel == nil)
        #expect(problem.docsURL == nil)
        #expect(!problem.message.contains("This Mac"))
        #expect(!(problem.actionLabel?.localizedCaseInsensitiveContains("reconcile") ?? false))

        let issue = GatewayConnectionIssue.detect(problem: problem)
        #expect(issue == .unknown(problem.message))
        if case let .unknown(message) = issue {
            #expect(!message.contains("This Mac"))
            #expect(!message.localizedCaseInsensitiveContains("reconcile"))
        }

        let actionTitle = GatewayProblemPrimaryAction.title(
            for: problem,
            retryTitle: "Retry connection",
            nonRetryableTitle: "Open Settings")
        #expect(actionTitle == "Open Settings")
    }
}
