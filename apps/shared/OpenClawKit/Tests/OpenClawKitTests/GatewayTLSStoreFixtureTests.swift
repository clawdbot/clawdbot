import Testing
@testable import OpenClawKit

struct GatewayTLSStoreFixtureTests {
    private struct FixtureFailure: Error {}

    @Test func `storage scopes release pins and first use claims even after failure`() async throws {
        let stableID = "test-storage-scope"
        await #expect(throws: FixtureFailure.self) {
            try await GatewayTLSStoreFixture.withStorage {
                #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == nil)
                #expect(GatewayTLSStore.claimedFirstUseFingerprint(stableID: stableID) == nil)
                #expect(GatewayTLSStore.claimFirstUseFingerprint("first", stableID: stableID) == "first")
                #expect(GatewayTLSStore.claimedFirstUseFingerprint(stableID: stableID) == "first")
                throw FixtureFailure()
            }
        }

        try await GatewayTLSStoreFixture.withStorage {
            #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == nil)
            #expect(GatewayTLSStore.claimedFirstUseFingerprint(stableID: stableID) == nil)
            #expect(GatewayTLSStore.claimFirstUseFingerprint("second", stableID: stableID) == "second")
            #expect(GatewayTLSStore.claimedFirstUseFingerprint(stableID: stableID) == "second")
        }
    }
}
