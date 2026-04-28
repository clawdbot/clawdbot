import Foundation
import Testing
@testable import OpenClaw

struct GatewayEndpointStoreTests {
    private func makeLaunchAgentSnapshot(
        env: [String: String],
        token: String?,
        password: String?) -> LaunchAgentPlistSnapshot
    {
        LaunchAgentPlistSnapshot(
            programArguments: [],
            environment: env,
            stdoutPath: nil,
            stderrPath: nil,
            port: nil,
            bind: nil,
            token: token,
            password: password)
    }

    private func makeDefaults() -> UserDefaults {
        let suiteName = "GatewayEndpointStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    @Test func `resolve gateway token prefers env and falls back to launchd`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["OPENCLAW_GATEWAY_TOKEN": "launchd-token"],
            token: "launchd-token",
            password: nil)

        let envToken = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: [:],
            env: ["OPENCLAW_GATEWAY_TOKEN": "env-token"],
            launchdSnapshot: snapshot)
        #expect(envToken == "env-token")

        let fallbackToken = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: [:],
            env: [:],
            launchdSnapshot: snapshot)
        #expect(fallbackToken == "launchd-token")
    }

    @Test func `resolve gateway token ignores launchd in remote mode`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["OPENCLAW_GATEWAY_TOKEN": "launchd-token"],
            token: "launchd-token",
            password: nil)

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: true,
            root: [:],
            env: [:],
            launchdSnapshot: snapshot)
        #expect(token == nil)
    }

    @Test func `resolve gateway token uses remote config token`() {
        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: true,
            root: [
                "gateway": [
                    "remote": [
                        "token": "  remote-token  ",
                    ],
                ],
            ],
            env: [:],
            launchdSnapshot: nil)
        #expect(token == "remote-token")
    }

    @Test func `resolve gateway password falls back to launchd`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["OPENCLAW_GATEWAY_PASSWORD": "launchd-pass"],
            token: nil,
            password: "launchd-pass")

        let password = GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: [:],
            env: [:],
            launchdSnapshot: snapshot)
        #expect(password == "launchd-pass")
    }

    @Test func `connection mode resolver prefers config mode over defaults`() {
        let defaults = self.makeDefaults()
        defaults.set("remote", forKey: connectionModeKey)

        let root: [String: Any] = [
            "gateway": [
                "mode": " local ",
            ],
        ]

        let resolved = ConnectionModeResolver.resolve(root: root, defaults: defaults)
        #expect(resolved.mode == .local)
    }

    @Test func `connection mode resolver trims config mode`() {
        let defaults = self.makeDefaults()
        defaults.set("local", forKey: connectionModeKey)

        let root: [String: Any] = [
            "gateway": [
                "mode": " remote ",
            ],
        ]

        let resolved = ConnectionModeResolver.resolve(root: root, defaults: defaults)
        #expect(resolved.mode == .remote)
    }

    @Test func `connection mode resolver falls back to defaults when missing config`() {
        let defaults = self.makeDefaults()
        defaults.set("remote", forKey: connectionModeKey)

        let resolved = ConnectionModeResolver.resolve(root: [:], defaults: defaults)
        #expect(resolved.mode == .remote)
    }

    @Test func `connection mode resolver falls back to defaults on unknown config`() {
        let defaults = self.makeDefaults()
        defaults.set("local", forKey: connectionModeKey)

        let root: [String: Any] = [
            "gateway": [
                "mode": "staging",
            ],
        ]

        let resolved = ConnectionModeResolver.resolve(root: root, defaults: defaults)
        #expect(resolved.mode == .local)
    }

    @Test func `connection mode resolver prefers remote URL when mode missing`() {
        let defaults = self.makeDefaults()
        defaults.set("local", forKey: connectionModeKey)

        let root: [String: Any] = [
            "gateway": [
                "remote": [
                    "url": " ws://umbrel:18789 ",
                ],
            ],
        ]

        let resolved = ConnectionModeResolver.resolve(root: root, defaults: defaults)
        #expect(resolved.mode == .remote)
    }

    @Test func `resolve local gateway host uses loopback for auto even with tailnet`() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "auto",
            tailscaleIP: "100.64.1.2")
        #expect(host == "127.0.0.1")
    }

    @Test func `resolve local gateway host uses loopback for auto without tailnet`() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "auto",
            tailscaleIP: nil)
        #expect(host == "127.0.0.1")
    }

    @Test func `resolve local gateway host prefers tailnet for tailnet mode`() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "tailnet",
            tailscaleIP: "100.64.1.5")
        #expect(host == "100.64.1.5")
    }

    @Test func `resolve local gateway host falls back to loopback for tailnet mode`() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "tailnet",
            tailscaleIP: nil)
        #expect(host == "127.0.0.1")
    }

    @Test func `resolve local gateway host uses custom bind host`() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "custom",
            tailscaleIP: "100.64.1.9",
            customBindHost: "192.168.1.10")
        #expect(host == "192.168.1.10")
    }

    @Test func `local config uses local gateway auth and host resolution`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: [:],
            token: "launchd-token",
            password: "launchd-pass")
        let root: [String: Any] = [
            "gateway": [
                "bind": "tailnet",
                "tls": ["enabled": true],
                "remote": [
                    "url": "wss://remote.example:443",
                    "token": "remote-token",
                ],
            ],
        ]

        let config = GatewayEndpointStore._testLocalConfig(
            root: root,
            env: [:],
            launchdSnapshot: snapshot,
            tailscaleIP: "100.64.1.8")

        #expect(config.url.absoluteString == "wss://100.64.1.8:\(GatewayEnvironment.gatewayPort())")
        #expect(config.token == "launchd-token")
        #expect(config.password == "launchd-pass")
    }

    @Test func `dashboard URL uses local base path in local mode`() throws {
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            token: nil,
            password: nil)

        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: .local,
            localBasePath: " control ")
        #expect(url.absoluteString == "http://127.0.0.1:18789/control/")
    }

    @Test func `dashboard URL skips local base path in remote mode`() throws {
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "ws://gateway.example:18789")),
            token: nil,
            password: nil)

        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: .remote,
            localBasePath: "/local-ui")
        #expect(url.absoluteString == "http://gateway.example:18789/")
    }

    @Test func `dashboard URL prefers path from config URL`() throws {
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "wss://gateway.example:443/remote-ui")),
            token: nil,
            password: nil)

        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: .remote,
            localBasePath: "/local-ui")
        #expect(url.absoluteString == "https://gateway.example:443/remote-ui/")
    }

    @Test func `dashboard URL uses fragment token and omits password`() throws {
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            token: "abc123",
            password: "sekret") // pragma: allowlist secret

        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: .local,
            localBasePath: "/control")
        #expect(url.absoluteString == "http://127.0.0.1:18789/control/#token=abc123")
        #expect(url.query == nil)
    }

    @Test func `normalize gateway url adds default port for loopback ws`() {
        let url = GatewayRemoteConfig.normalizeGatewayUrl("ws://127.0.0.1")
        #expect(url?.port == 18789)
        #expect(url?.absoluteString == "ws://127.0.0.1:18789")
    }

    @Test func `normalize gateway url rejects non loopback ws`() {
        let url = GatewayRemoteConfig.normalizeGatewayUrl("ws://gateway.example:18789")
        #expect(url == nil)
    }

    @Test func `normalize gateway url rejects prefix bypass loopback host`() {
        let url = GatewayRemoteConfig.normalizeGatewayUrl("ws://127.attacker.example")
        #expect(url == nil)
    }
}
