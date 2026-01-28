import Foundation
import Testing
@testable import Moltbot

@Suite struct ExecApprovalHelpersTests {
    @Test func parseDecisionTrimsAndRejectsInvalid() {
        #expect(ExecApprovalHelpers.parseDecision("allow-once") == .allowOnce)
        #expect(ExecApprovalHelpers.parseDecision(" allow-always ") == .allowAlways)
        #expect(ExecApprovalHelpers.parseDecision("deny") == .deny)
        #expect(ExecApprovalHelpers.parseDecision("") == nil)
        #expect(ExecApprovalHelpers.parseDecision("nope") == nil)
    }

    @Test func allowlistPatternPrefersResolution() {
        let resolved = ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
        #expect(ExecApprovalHelpers.allowlistPattern(command: ["rg"], resolution: resolved) == resolved.resolvedPath)

        let rawOnly = ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: nil,
            executableName: "rg",
            cwd: nil)
        #expect(ExecApprovalHelpers.allowlistPattern(command: ["rg"], resolution: rawOnly) == "rg")
        #expect(ExecApprovalHelpers.allowlistPattern(command: ["rg"], resolution: nil) == "rg")
        #expect(ExecApprovalHelpers.allowlistPattern(command: [], resolution: nil) == nil)
    }

    @Test func requiresAskMatchesPolicy() {
        let entry = ExecAllowlistEntry(pattern: "/bin/ls", lastUsedAt: nil, lastUsedCommand: nil, lastResolvedPath: nil)
        #expect(ExecApprovalHelpers.requiresAsk(
            ask: .always,
            security: .deny,
            allowlistMatch: nil,
            skillAllow: false))
        #expect(ExecApprovalHelpers.requiresAsk(
            ask: .onMiss,
            security: .allowlist,
            allowlistMatch: nil,
            skillAllow: false))
        #expect(!ExecApprovalHelpers.requiresAsk(
            ask: .onMiss,
            security: .allowlist,
            allowlistMatch: entry,
            skillAllow: false))
        #expect(!ExecApprovalHelpers.requiresAsk(
            ask: .onMiss,
            security: .allowlist,
            allowlistMatch: nil,
            skillAllow: true))
        #expect(!ExecApprovalHelpers.requiresAsk(
            ask: .off,
            security: .allowlist,
            allowlistMatch: nil,
            skillAllow: false))
    }
}
