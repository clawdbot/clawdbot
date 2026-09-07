import Foundation
import OpenClawIPC
import Testing
@testable import OpenClaw

struct MacControlRequestAuthenticatorTests {
    @Test func `rejects wrong user without consuming request and rejects replay`() async throws {
        let authenticator = MacControlRequestAuthenticator()
        let now = Date(timeIntervalSince1970: 1000)
        let envelope = try MacControlEnvelope(
            request: MacControlRequest(operation: "primary.clear"),
            token: "fixture",
            now: now)
        await #expect(throws: MacControlError.self) {
            try await authenticator.authenticate(envelope, token: "fixture", peerUID: 502, ownerUID: 501, now: now)
        }
        let accepted = try await authenticator.authenticate(
            envelope, token: "fixture", peerUID: 501, ownerUID: 501, now: now)
        #expect(accepted.operation == "primary.clear")
        await #expect(throws: MacControlError.self) {
            try await authenticator.authenticate(envelope, token: "fixture", peerUID: 501, ownerUID: 501, now: now)
        }
    }

    @Test func `missing token does not authorize request`() async throws {
        let authenticator = MacControlRequestAuthenticator()
        let envelope = try MacControlEnvelope(request: MacControlRequest(operation: "status"), token: "fixture")
        await #expect(throws: MacControlError.self) {
            try await authenticator.authenticate(envelope, token: "", peerUID: 501, ownerUID: 501)
        }
    }
}
