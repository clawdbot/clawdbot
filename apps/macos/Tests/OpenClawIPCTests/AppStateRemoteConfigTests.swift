import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct AppStateRemoteConfigTests {
    @Test
    func updatedRemoteGatewayConfigSetsTrimmedToken() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: [:],
            draft: .init(
                transport: .ssh,
                remoteUrl: "",
                remoteHost: "gateway.example",
                remoteTarget: "alice@gateway.example",
                remoteIdentity: "/tmp/id_ed25519",
                remoteToken: "  secret-token  ",
                remoteTokenDirty: true))

        #expect(remote["token"] as? String == "secret-token")
    }

    @Test
    func updatedRemoteGatewayConfigClearsTokenWhenBlank() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: ["token": "old-token"],
            draft: .init(
                transport: .direct,
                remoteUrl: "wss://gateway.example",
                remoteHost: nil,
                remoteTarget: "",
                remoteIdentity: "",
                remoteToken: "   ",
                remoteTokenDirty: true))

        #expect((remote["token"] as? String) == nil)
    }

    @Test
    func syncedGatewayRootPreservesObjectTokenAcrossModeAndTransportChangesWhenUntouched() {
        let initialRoot: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "direct",
                    "url": "wss://old-gateway.example",
                    "token": [
                        "$secretRef": "gateway-token", // pragma: allowlist secret
                    ],
                ],
            ],
        ]

        let sshRoot = AppState._testSyncedGatewayRoot(
            currentRoot: initialRoot,
            draft: .init(
                connectionMode: .remote,
                remoteTransport: .ssh,
                remoteTarget: "alice@gateway.example",
                remoteIdentity: "",
                remoteUrl: "",
                remoteToken: "",
                remoteTokenDirty: false))
        let sshRemote = (sshRoot["gateway"] as? [String: Any])?["remote"] as? [String: Any]
        #expect((sshRemote?["token"] as? [String: String])?["$secretRef"] == "gateway-token") // pragma: allowlist secret

        let localRoot = AppState._testSyncedGatewayRoot(
            currentRoot: sshRoot,
            draft: .init(
                connectionMode: .local,
                remoteTransport: .ssh,
                remoteTarget: "",
                remoteIdentity: "",
                remoteUrl: "",
                remoteToken: "",
                remoteTokenDirty: false))
        let localGateway = localRoot["gateway"] as? [String: Any]
        let localRemote = localGateway?["remote"] as? [String: Any]
        #expect(localGateway?["mode"] as? String == "local")
        #expect((localRemote?["token"] as? [String: String])?["$secretRef"] == "gateway-token") // pragma: allowlist secret
    }

    @Test
    func updatedRemoteGatewayConfigReplacesObjectTokenWhenUserEntersPlaintext() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: [
                "token": [
                    "$secretRef": "gateway-token", // pragma: allowlist secret
                ],
            ],
            draft: .init(
                transport: .direct,
                remoteUrl: "wss://gateway.example",
                remoteHost: nil,
                remoteTarget: "",
                remoteIdentity: "",
                remoteToken: "  fresh-token  ",
                remoteTokenDirty: true))

        #expect(remote["token"] as? String == "fresh-token")
    }

    @Test
    func updatedRemoteGatewayConfigClearsObjectTokenOnlyAfterExplicitEdit() {
        let current: [String: Any] = [
            "token": [
                "$secretRef": "gateway-token", // pragma: allowlist secret
            ],
        ]

        let preserved = AppState._testUpdatedRemoteGatewayConfig(
            current: current,
            draft: .init(
                transport: .direct,
                remoteUrl: "wss://gateway.example",
                remoteHost: nil,
                remoteTarget: "",
                remoteIdentity: "",
                remoteToken: "",
                remoteTokenDirty: false))
        #expect((preserved["token"] as? [String: String])?["$secretRef"] == "gateway-token") // pragma: allowlist secret

        let cleared = AppState._testUpdatedRemoteGatewayConfig(
            current: current,
            draft: .init(
                transport: .direct,
                remoteUrl: "wss://gateway.example",
                remoteHost: nil,
                remoteTarget: "",
                remoteIdentity: "",
                remoteToken: "   ",
                remoteTokenDirty: true))
        #expect((cleared["token"] as? String) == nil)
    }
}
