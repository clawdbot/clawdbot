import Foundation
import Testing
@testable import OpenClaw

struct PrimaryGatewayControlConfigurationTests {
    private let previous: [String: Any] = [
        "agents": ["defaults": ["workspace": "/example/workspace"]],
        "gateway": [
            "mode": "remote",
            "port": 19000,
            "auth": ["token": "local-credential"],
            "remote": [
                "transport": "ssh",
                "url": "ws://127.0.0.1:19000",
                "remotePort": 19100,
                "sshTarget": "operator@old.example",
                "sshIdentity": "/example/old-key",
                "sshHostKeyPolicy": "openssh",
                "token": "old-token",
                "password": "old-password",
                "tlsFingerprint": "old-pin",
            ],
        ],
    ]

    @Test
    func `direct replacement owns authentication and retains local gateway settings`() throws {
        let selection = try PrimaryGatewayControlConfiguration.direct(
            url: #require(URL(string: "wss://new.example/operator/")),
            token: nil,
            password: "replacement-password",
            tlsFingerprint: "replacement-pin")
        let replacement = try selection.replacingRoot(self.previous, effectiveLocalPort: 19000)
        #expect(replacement.clearsTargetDefaults)
        #expect(!replacement.removesGatewayMode)
        #expect(GatewayRemoteConfig.resolvePasswordString(root: replacement.root) == "replacement-password")
        #expect(GatewayRemoteConfig.resolveTokenString(root: replacement.root) == nil)
        #expect(GatewayRemoteConfig.resolveTLSFingerprint(root: replacement.root) == "replacement-pin")
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        let remote = try #require(gateway["remote"] as? [String: Any])
        #expect(remote["sshTarget"] == nil)
        #expect(remote["sshIdentity"] == nil)
        #expect(remote["remotePort"] == nil)
        #expect(gateway["port"] as? Int == 19000)
        #expect((gateway["auth"] as? [String: String])?["token"] == "local-credential")
        #expect(replacement.root["agents"] as? [String: [String: String]] ==
            self.previous["agents"] as? [String: [String: String]])
    }

    @Test(arguments: [false, true])
    func `ssh replacement resets host scoped options only when the target changes`(changesTarget: Bool) throws {
        let selection = PrimaryGatewayControlConfiguration.ssh(
            target: changesTarget ? "operator@new.example" : "operator@old.example",
            remotePort: nil,
            localPort: nil,
            identity: nil,
            hostKeyPolicy: nil,
            token: "new-token",
            password: nil)
        let replacement = try selection.replacingRoot(self.previous, effectiveLocalPort: 19000)
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        let remote = try #require(gateway["remote"] as? [String: Any])
        #expect(replacement.clearsTargetDefaults == changesTarget)
        #expect(!replacement.removesGatewayMode)
        #expect(remote["sshIdentity"] as? String == (changesTarget ? nil : "/example/old-key"))
        #expect(remote["sshHostKeyPolicy"] as? String == (changesTarget ? "strict" : "openssh"))
        #expect(GatewayRemoteConfig.resolveRemotePort(root: replacement.root) == (changesTarget ? 18789 : 19100))
        #expect(GatewayRemoteConfig.resolveTokenString(root: replacement.root) == "new-token")
        #expect(GatewayRemoteConfig.resolvePasswordString(root: replacement.root) == nil)
        #expect(GatewayRemoteConfig.resolveTLSFingerprint(root: replacement.root) == nil)
    }

    @Test
    func `explicit SSH options replace the previous route as one selection`() throws {
        let selection = PrimaryGatewayControlConfiguration.ssh(
            target: "operator@new.example:2222",
            remotePort: 22000,
            localPort: 23000,
            identity: "/example/new-key",
            hostKeyPolicy: .openssh,
            token: nil,
            password: "new-password")
        let replacement = try selection.replacingRoot(self.previous, effectiveLocalPort: 23000)
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        let remote = try #require(gateway["remote"] as? [String: Any])
        #expect(gateway["port"] as? Int == 23000)
        #expect(remote["url"] as? String == "ws://127.0.0.1:23000")
        #expect(remote["remotePort"] as? Int == 22000)
        #expect(remote["sshIdentity"] as? String == "/example/new-key")
        #expect(remote["sshHostKeyPolicy"] as? String == "openssh")
        #expect(remote["password"] as? String == "new-password")
    }

    @Test
    func `fresh SSH selection uses the prepared named profile port`() throws {
        let selection = PrimaryGatewayControlConfiguration.ssh(
            target: "operator@new.example", remotePort: nil, localPort: nil,
            identity: nil, hostKeyPolicy: nil, token: nil, password: nil)
        let replacement = try selection.replacingRoot([:], effectiveLocalPort: 19789)
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        let remote = try #require(gateway["remote"] as? [String: Any])
        #expect(remote["url"] as? String == "ws://127.0.0.1:19789")
        #expect(remote["remotePort"] as? Int == 18789)
        #expect(gateway["port"] == nil)
    }

    @Test
    func `SSH URL follows environment precedence while preserving the requested config port`() throws {
        let selection = PrimaryGatewayControlConfiguration.ssh(
            target: "operator@new.example", remotePort: nil, localPort: 23000,
            identity: nil, hostKeyPolicy: nil, token: nil, password: nil)
        let effectiveLocalPort = GatewayEnvironment.resolvedGatewayPort(
            environment: ["OPENCLAW_GATEWAY_PORT": "23456"],
            configPort: selection.requestedLocalPort,
            storedPort: 19789,
            profile: AppProfile(environment: ["OPENCLAW_PROFILE": "control-test"]))
        let replacement = try selection.replacingRoot([:], effectiveLocalPort: effectiveLocalPort)
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        let remote = try #require(gateway["remote"] as? [String: Any])
        #expect(remote["url"] as? String == "ws://127.0.0.1:23456")
        #expect(gateway["port"] as? Int == 23000)
    }

    @Test
    func `clearing removes the remote URL and permits a subsequent direct selection`() throws {
        let replacement = try PrimaryGatewayControlConfiguration.clear.replacingRoot(
            self.previous, effectiveLocalPort: 19000)
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        #expect(gateway["mode"] == nil)
        #expect(replacement.removesGatewayMode)
        #expect(GatewayRemoteConfig.resolveUrlString(root: replacement.root) == nil)
        #expect(gateway["remote"] == nil)
        #expect(gateway["auth"] as? [String: String] == ["token": "local-credential"])
        #expect(replacement.clearsTargetDefaults)

        let clearedAgain = try PrimaryGatewayControlConfiguration.clear.replacingRoot(
            replacement.root, effectiveLocalPort: 19000)
        #expect(!clearedAgain.removesGatewayMode)

        let local = try PrimaryGatewayControlConfiguration.local.replacingRoot(
            self.previous, effectiveLocalPort: 19000)
        #expect(!local.removesGatewayMode)

        let direct = try PrimaryGatewayControlConfiguration.direct(
            url: #require(URL(string: "wss://new.example/")), token: nil, password: nil, tlsFingerprint: nil)
            .replacingRoot(replacement.root, effectiveLocalPort: 19000)
        #expect((direct.root["gateway"] as? [String: Any])?["mode"] as? String == "remote")
        #expect(GatewayRemoteConfig.resolveUrlString(root: direct.root) == "wss://new.example/")
    }

    @Test(arguments: ["ws://public.example", "wss://user:secret@public.example", "wss://public.example?token=secret"])
    func `invalid direct selections fail before persistence`(address: String) throws {
        let selection = try PrimaryGatewayControlConfiguration.direct(
            url: #require(URL(string: address)), token: nil, password: nil, tlsFingerprint: nil)
        #expect(throws: PrimaryGatewayControlError.self) {
            try selection.replacingRoot(self.previous, effectiveLocalPort: 19000)
        }
    }

    @Test(arguments: [0, 65536])
    func `invalid SSH ports fail before persistence`(port: Int) {
        let selection = PrimaryGatewayControlConfiguration.ssh(
            target: "operator@new.example", remotePort: port, localPort: nil,
            identity: nil, hostKeyPolicy: nil, token: nil, password: nil)
        #expect(throws: PrimaryGatewayControlError.self) {
            try selection.replacingRoot(self.previous, effectiveLocalPort: 19000)
        }
    }
}
