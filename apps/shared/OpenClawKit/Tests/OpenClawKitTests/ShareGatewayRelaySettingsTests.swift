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

    @Test func `extension-first upgrade discards and rejects legacy credentials`() {
        var migrations = 0
        var discards = 0

        let resolved = ShareGatewayRelaySettings.resolveLegacyConfig(
            self.config,
            isAppExtension: true,
            migrate: { _ in
                migrations += 1
                return true
            },
            discard: { discards += 1 })

        #expect(resolved == nil)
        #expect(migrations == 0)
        #expect(discards == 1)
    }

    @Test func `host app owns legacy migration`() {
        var migrated: ShareGatewayRelayConfig?
        var discards = 0

        let resolved = ShareGatewayRelaySettings.resolveLegacyConfig(
            self.config,
            isAppExtension: false,
            migrate: { config in
                migrated = config
                return true
            },
            discard: { discards += 1 })

        #expect(resolved == self.config)
        #expect(migrated == self.config)
        #expect(discards == 0)
    }

    @Test func `failed host migration discards and rejects legacy credentials`() {
        var calls: [String] = []

        let resolved = ShareGatewayRelaySettings.resolveLegacyConfig(
            self.config,
            isAppExtension: false,
            migrate: { _ in
                calls.append("migrate")
                return false
            },
            discard: { calls.append("discard") })

        #expect(resolved == nil)
        #expect(calls == ["migrate", "discard"])
    }
}
