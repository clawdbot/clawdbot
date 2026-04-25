import Foundation
import Testing
@testable import OpenClaw

struct ExecApprovalHelpersTests {
    @Test func `parse decision trims and rejects invalid`() {
        #expect(ExecApprovalHelpers.parseDecision("allow-once") == .allowOnce)
        #expect(ExecApprovalHelpers.parseDecision(" allow-always ") == .allowAlways)
        #expect(ExecApprovalHelpers.parseDecision("deny") == .deny)
        #expect(ExecApprovalHelpers.parseDecision("") == nil)
        #expect(ExecApprovalHelpers.parseDecision("nope") == nil)
    }

    @Test func `allowlist pattern prefers resolution`() {
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

    @Test func `validate allowlist pattern returns reasons`() {
        #expect(ExecApprovalHelpers.isPathPattern("/usr/bin/rg"))
        #expect(ExecApprovalHelpers.isPathPattern(" ~/bin/rg "))
        #expect(!ExecApprovalHelpers.isPathPattern("rg"))
        #expect(ExecApprovalHelpers.isValidAllowlistPattern("rg"))

        if case let .invalid(reason) = ExecApprovalHelpers.validateAllowlistPattern("  ") {
            #expect(reason == .empty)
        } else {
            Issue.record("Expected empty pattern rejection")
        }
    }

    @Test func `requires ask matches policy`() {
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
