import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct DeviceIdentityConflictRecoveryTests {
    @Test func `candidate titles include redacted path and fingerprint`() {
        let candidate = DeviceIdentityConflictCandidate(
            sourcePath: "~/Library/Group Containers/group.ai.openclaw/identity/device.json",
            fingerprint: "0123456789ab",
            createdAtMs: 1_800_000_000_000)
        let title = DeviceIdentityConflictRecovery.candidateMenuTitle(candidate)
        #expect(title.contains(candidate.sourcePath))
        #expect(title.contains(candidate.fingerprint))
        #expect(!title.contains(candidate.fingerprint + candidate.fingerprint))
    }

    @Test func `re-pair confirmation names Gateway re-approval`() {
        let message = DeviceIdentityConflictRecovery.confirmRePairMessage()
        #expect(message.contains("re-approving"))
        #expect(message.contains("archives"))
    }
}
