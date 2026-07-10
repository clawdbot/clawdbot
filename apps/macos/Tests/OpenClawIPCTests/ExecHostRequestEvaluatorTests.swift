import Foundation
import Testing
@testable import OpenClaw

struct ExecHostRequestEvaluatorTests {
    @Test func `validate request rejects empty command`() {
        let request = ExecHostRequest(
            command: [],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: nil)
        switch ExecHostRequestEvaluator.validateRequest(request) {
        case .success:
            Issue.record("expected invalid request")
        case let .failure(error):
            #expect(error.code == "INVALID_REQUEST")
            #expect(error.message == "command required")
        }
    }

    @Test func `validate request rejects a blank executable`() {
        let request = ExecHostRequest(
            command: [" \t\n", "operand"],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: nil)

        switch ExecHostRequestEvaluator.validateRequest(request) {
        case .success:
            Issue.record("expected invalid request")
        case let .failure(error):
            #expect(error.code == "INVALID_REQUEST")
            #expect(error.message == "command required")
        }
    }

    @Test func `validate request preserves argv exactly`() {
        let command = ["/usr/bin/printf", "<%s>|<%s>", "  padded  ", "-n"]
        let request = ExecHostRequest(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: nil)

        switch ExecHostRequestEvaluator.validateRequest(request) {
        case let .success(validated):
            #expect(validated.command == command)
        case let .failure(error):
            Issue.record("unexpected invalid request: \(error.message)")
        }
    }

    @Test func `validate request separates canonical wrapper display from allowlist payload`() {
        let command = ["/bin/sh", "-lc", "/usr/bin/printf ok"]
        let request = ExecHostRequest(
            command: command,
            rawCommand: "/usr/bin/printf ok",
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: nil)

        switch ExecHostRequestEvaluator.validateRequest(request) {
        case let .success(validated):
            #expect(validated.command == command)
            #expect(validated.displayCommand == ExecCommandFormatter.displayString(for: command))
            #expect(validated.evaluationRawCommand == "/usr/bin/printf ok")
            #expect(validated.displayCommand != validated.evaluationRawCommand)
        case let .failure(error):
            Issue.record("unexpected invalid request: \(error.message)")
        }
    }

    @Test func `validate request rejects a padded executable without normalizing it`() {
        let request = ExecHostRequest(
            command: [" /usr/bin/touch ", "/tmp/must-not-run"],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: nil)

        switch ExecHostRequestEvaluator.validateRequest(request) {
        case .success:
            Issue.record("expected invalid request")
        case let .failure(error):
            #expect(error.code == "INVALID_REQUEST")
            #expect(error.message == "executable has surrounding whitespace")
        }
    }

    @Test func `validate request preserves source only timeout fallback`() {
        let request = ExecHostRequest(
            command: ["/usr/bin/printf", "ok"],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: nil,
            approvalSource: "ask-fallback")

        switch ExecHostRequestEvaluator.validateRequest(request) {
        case let .success(validated):
            #expect(validated.approvalSource == .askFallback)
        case let .failure(error):
            Issue.record("unexpected invalid request: \(error.message)")
        }
    }

    @Test func `validate request rejects fallback mixed with explicit approval`() {
        let request = ExecHostRequest(
            command: ["/usr/bin/printf", "ok"],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: .allowOnce,
            approvalSource: "ask-fallback")

        switch ExecHostRequestEvaluator.validateRequest(request) {
        case .success:
            Issue.record("expected invalid request")
        case let .failure(error):
            #expect(error.message == "approvalSource cannot be combined with explicit approval")
        }
    }

    @Test func `validate request preserves marker only auto review authority`() {
        let request = ExecHostRequest(
            command: ["/usr/bin/printf", "ok"],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: nil,
            approvalSource: "auto-review")

        switch ExecHostRequestEvaluator.validateRequest(request) {
        case let .success(validated):
            #expect(validated.approvalSource == .autoReview)
        case let .failure(error):
            Issue.record("unexpected invalid request: \(error.message)")
        }
    }

    @Test func `validate request rejects auto review mixed with explicit approval`() {
        let request = ExecHostRequest(
            command: ["/usr/bin/printf", "ok"],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: .allowOnce,
            approvalSource: "auto-review")

        switch ExecHostRequestEvaluator.validateRequest(request) {
        case .success:
            Issue.record("expected invalid request")
        case let .failure(error):
            #expect(error.message == "approvalSource cannot be combined with explicit approval")
        }
    }

    @Test func `evaluate requires prompt on allowlist miss without decision`() {
        let context = Self.makeContext(security: .allowlist, ask: .onMiss, allowlistSatisfied: false, skillAllow: false)
        let decision = ExecHostRequestEvaluator.evaluate(context: context, approvalDecision: nil)
        switch decision {
        case .requiresPrompt:
            break
        case .allow:
            Issue.record("expected prompt requirement")
        case let .deny(error):
            Issue.record("unexpected deny: \(error.message)")
        }
    }

    @Test func `evaluate allows allow once decision on allowlist miss`() {
        let context = Self.makeContext(security: .allowlist, ask: .onMiss, allowlistSatisfied: false, skillAllow: false)
        let decision = ExecHostRequestEvaluator.evaluate(context: context, approvalDecision: .allowOnce)
        switch decision {
        case let .allow(approvedByAsk):
            #expect(approvedByAsk)
        case .requiresPrompt:
            Issue.record("expected allow decision")
        case let .deny(error):
            Issue.record("unexpected deny: \(error.message)")
        }
    }

    @Test func `evaluate denies on explicit deny decision`() {
        let context = Self.makeContext(security: .full, ask: .off, allowlistSatisfied: true, skillAllow: false)
        let decision = ExecHostRequestEvaluator.evaluate(context: context, approvalDecision: .deny)
        switch decision {
        case let .deny(error):
            #expect(error.reason == "user-denied")
        case .requiresPrompt:
            Issue.record("expected deny decision")
        case .allow:
            Issue.record("expected deny decision")
        }
    }

    @Test func `timeout fallback applies full policy without prompting`() {
        let context = Self.makeContext(
            security: .full,
            ask: .always,
            askFallback: .full,
            allowlistSatisfied: false,
            skillAllow: false)
        let decision = ExecHostRequestEvaluator.evaluate(
            context: context,
            approvalDecision: nil,
            approvalSource: .askFallback)
        switch decision {
        case let .allow(approvedByAsk):
            #expect(!approvedByAsk)
        case .requiresPrompt:
            Issue.record("fallback must not open another prompt")
        case let .deny(error):
            Issue.record("unexpected deny: \(error.message)")
        }
    }

    @Test func `auto review is one shot authority for an allowlist miss`() {
        let context = Self.makeContext(
            security: .allowlist,
            ask: .onMiss,
            allowlistSatisfied: false,
            skillAllow: false)
        let decision = ExecHostRequestEvaluator.evaluate(
            context: context,
            approvalDecision: nil,
            approvalSource: .autoReview)

        switch decision {
        case let .allow(approvedByAsk):
            #expect(approvedByAsk)
        case .requiresPrompt:
            Issue.record("auto review should not prompt")
        case let .deny(error):
            Issue.record("unexpected deny: \(error.message)")
        }
    }

    @Test func `auto review cannot bypass ask always`() {
        let context = Self.makeContext(
            security: .full,
            ask: .always,
            allowlistSatisfied: false,
            skillAllow: false)
        let decision = ExecHostRequestEvaluator.evaluate(
            context: context,
            approvalDecision: nil,
            approvalSource: .autoReview)

        switch decision {
        case let .deny(error):
            #expect(error.reason == "ask=always")
        case .allow, .requiresPrompt:
            Issue.record("auto review must not bypass ask=always")
        }
    }

    @Test func `execution commit builder covers current explicit and fallback sources`() {
        let currentContext = Self.makeContext(
            security: .full,
            ask: .off,
            allowlistSatisfied: false,
            skillAllow: false)
        let current = ExecApprovalExecutionCommit.build(
            context: currentContext,
            effectiveSecurity: .full,
            approvalSource: nil,
            explicitlyApproved: false,
            persistAllowlist: false)
        if case let .currentPolicy(security, ask, basis) = current.authorization {
            #expect(security == .full)
            #expect(ask == .off)
            #expect(basis == nil)
        } else {
            Issue.record("expected current-policy authorization")
        }

        let explicit = ExecApprovalExecutionCommit.build(
            context: currentContext,
            effectiveSecurity: .full,
            approvalSource: nil,
            explicitlyApproved: true,
            persistAllowlist: false)
        if case let .explicitOnce(security) = explicit.authorization {
            #expect(security == .full)
        } else {
            Issue.record("expected explicit authorization")
        }

        let fallbackContext = Self.makeContext(
            security: .full,
            ask: .always,
            askFallback: .full,
            allowlistSatisfied: false,
            skillAllow: false)
        let fallback = ExecApprovalExecutionCommit.build(
            context: fallbackContext,
            effectiveSecurity: .full,
            approvalSource: .askFallback,
            explicitlyApproved: false,
            persistAllowlist: false)
        if case let .askFallback(security, basis) = fallback.authorization {
            #expect(security == .full)
            #expect(basis == nil)
        } else {
            Issue.record("expected fallback authorization")
        }

        let autoReviewContext = Self.makeContext(
            security: .allowlist,
            ask: .onMiss,
            allowlistSatisfied: false,
            skillAllow: false)
        let autoReview = ExecApprovalExecutionCommit.build(
            context: autoReviewContext,
            effectiveSecurity: .allowlist,
            approvalSource: .autoReview,
            explicitlyApproved: true,
            persistAllowlist: false)
        if case let .autoReview(security) = autoReview.authorization {
            #expect(security == .allowlist)
        } else {
            Issue.record("expected auto-review authorization")
        }
    }

    @Test func `execution commit does not audit dormant allowlist matches under full policy`() {
        let entry = ExecAllowlistEntry(pattern: "/usr/bin/echo")
        let resolution = ExecCommandResolution(
            rawExecutable: "/usr/bin/echo",
            resolvedPath: "/usr/bin/echo",
            executableName: "echo",
            cwd: nil)
        let context = ExecApprovalEvaluation(
            displayCommand: "/usr/bin/echo hi",
            agentId: nil,
            security: .full,
            ask: .off,
            askFallback: .deny,
            env: [:],
            resolution: resolution,
            allowlistResolutions: [resolution],
            boundCommand: ["/usr/bin/echo", "hi"],
            allowAlwaysPatterns: [],
            allowlistMatches: [entry],
            allowlistAuthorizationSatisfied: true,
            allowlistSatisfied: false,
            allowlistMatch: nil,
            skillAllow: false,
            policySnapshot: ExecApprovalPolicySnapshot(
                security: .full,
                ask: .off,
                askFallback: .deny,
                autoAllowSkills: false,
                allowlist: [entry]))

        let commit = ExecApprovalExecutionCommit.build(
            context: context,
            effectiveSecurity: .full,
            approvalSource: nil,
            explicitlyApproved: false,
            persistAllowlist: false)

        #expect(commit.uses.isEmpty)
    }

    private static func makeContext(
        security: ExecSecurity,
        ask: ExecAsk,
        askFallback: ExecSecurity = .deny,
        allowlistSatisfied: Bool,
        skillAllow: Bool) -> ExecApprovalEvaluation
    {
        ExecApprovalEvaluation(
            displayCommand: "/usr/bin/echo hi",
            agentId: nil,
            security: security,
            ask: ask,
            askFallback: askFallback,
            env: [:],
            resolution: nil,
            allowlistResolutions: [],
            boundCommand: nil,
            allowAlwaysPatterns: [],
            allowlistMatches: [],
            allowlistAuthorizationSatisfied: allowlistSatisfied,
            allowlistSatisfied: allowlistSatisfied,
            allowlistMatch: nil,
            skillAllow: skillAllow,
            policySnapshot: ExecApprovalPolicySnapshot(
                security: security,
                ask: ask,
                askFallback: askFallback,
                autoAllowSkills: false,
                allowlist: []))
    }
}
