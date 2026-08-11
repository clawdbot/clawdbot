import Testing
@testable import OpenClawKit

struct ShareGatewayRelaySettingsTests {
    private let config = ShareGatewayRelayConfig(
        gatewayURLString: "wss://relay.example.com",
        gatewayStableID: "manual|relay.example.com|443",
        token: "token",
        password: "password",
        sessionKey: "main")

    @Test func `failed credential persistence leaves metadata unchanged`() {
        var metadataWrites = 0

        let saved = ShareGatewayRelaySettings.commitConfig(
            self.config,
            saveCredentials: { _ in false },
            saveMetadata: { _ in metadataWrites += 1 })

        #expect(!saved)
        #expect(metadataWrites == 0)
    }

    @Test func `successful credential persistence commits metadata once`() {
        var metadataWrites = 0

        let saved = ShareGatewayRelaySettings.commitConfig(
            self.config,
            saveCredentials: { _ in true },
            saveMetadata: { _ in metadataWrites += 1 })

        #expect(saved)
        #expect(metadataWrites == 1)
    }
}
