import Testing
@testable import OpenClaw

struct ExecApprovalPolicySnapshotTests {
    @Test
    func `allow always source promotion is additive`() {
        let expected = Self.snapshot(source: nil)
        let current = Self.snapshot(source: "allow-always")

        #expect(expected.isCurrent(current))
    }

    @Test
    func `allow always source downgrade is rejected`() {
        let expected = Self.snapshot(source: "allow-always")
        let current = Self.snapshot(source: nil)

        #expect(!expected.isCurrent(current))
    }

    private static func snapshot(source: String?) -> ExecApprovalPolicySnapshot {
        ExecApprovalPolicySnapshot(
            security: .allowlist,
            ask: .always,
            askFallback: .deny,
            autoAllowSkills: false,
            allowlist: [ExecAllowlistEntry(
                pattern: "/usr/bin/printf",
                source: source,
                argPattern: "^ok$")])
    }
}
