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

    @Test func `stale extension migration cannot replace newer host route`() {
        let newerHostConfig = ShareGatewayRelayConfig(
            gatewayURLString: "wss://newer.example.com",
            gatewayStableID: "manual|newer.example.com|443",
            token: "newer-token",
            password: nil,
            sessionKey: "main")
        var persisted = newerHostConfig
        var commits = 0

        ShareGatewayRelaySettings.migrateLegacyConfigIfOwner(
            self.config,
            isAppExtension: true,
            commit: { staleConfig in
                commits += 1
                persisted = staleConfig
                return true
            })

        #expect(commits == 0)
        #expect(persisted == newerHostConfig)
    }

    @Test func `host app owns legacy migration`() {
        var migrated: ShareGatewayRelayConfig?

        ShareGatewayRelaySettings.migrateLegacyConfigIfOwner(
            self.config,
            isAppExtension: false,
            commit: { config in
                migrated = config
                return true
            })

        #expect(migrated == self.config)
    }
}
