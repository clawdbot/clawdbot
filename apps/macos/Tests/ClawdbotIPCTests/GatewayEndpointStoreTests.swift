import Foundation
import Testing
@testable import Clawdbot

@Suite struct GatewayEndpointStoreTests {
    private func makeDefaults() -> UserDefaults {
        let suiteName = "GatewayEndpointStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    @Test func resolveGatewayTokenPrefersEnvAndFallsBackToLaunchd() {
        let snapshot = LaunchAgentPlistSnapshot(
            programArguments: [],
            environment: ["CLAWDBOT_GATEWAY_TOKEN": "launchd-token"],
            stdoutPath: nil,
            stderrPath: nil,
            port: nil,
            bind: nil,
            token: "launchd-token",
            password: nil)

        let envToken = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: [:],
            env: ["CLAWDBOT_GATEWAY_TOKEN": "env-token"],
            launchdSnapshot: snapshot)
        #expect(envToken == "env-token")

        let fallbackToken = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: [:],
            env: [:],
            launchdSnapshot: snapshot)
        #expect(fallbackToken == "launchd-token")
    }

    @Test func resolveGatewayTokenIgnoresLaunchdInRemoteMode() {
        let snapshot = LaunchAgentPlistSnapshot(
            programArguments: [],
            environment: ["CLAWDBOT_GATEWAY_TOKEN": "launchd-token"],
            stdoutPath: nil,
            stderrPath: nil,
            port: nil,
            bind: nil,
            token: "launchd-token",
            password: nil)

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: true,
            root: [:],
            env: [:],
            launchdSnapshot: snapshot)
        #expect(token == nil)
    }

    @Test func resolveGatewayPasswordFallsBackToLaunchd() {
        let snapshot = LaunchAgentPlistSnapshot(
            programArguments: [],
            environment: ["CLAWDBOT_GATEWAY_PASSWORD": "launchd-pass"],
            stdoutPath: nil,
            stderrPath: nil,
            port: nil,
            bind: nil,
            token: nil,
            password: "launchd-pass")

        let password = GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: [:],
            env: [:],
            launchdSnapshot: snapshot)
        #expect(password == "launchd-pass")
    }

    @Test func connectionModeResolverPrefersConfigModeOverDefaults() {
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

    @Test func connectionModeResolverTrimsConfigMode() {
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

    @Test func connectionModeResolverFallsBackToDefaultsWhenMissingConfig() {
        let defaults = self.makeDefaults()
        defaults.set("remote", forKey: connectionModeKey)

        let resolved = ConnectionModeResolver.resolve(root: [:], defaults: defaults)
        #expect(resolved.mode == .remote)
    }

    @Test func connectionModeResolverFallsBackToDefaultsOnUnknownConfig() {
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

    @Test func connectionModeResolverPrefersRemoteURLWhenModeMissing() {
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

    @Test func resolveLocalGatewayHostUsesLoopbackForAutoEvenWithTailnet() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "auto",
            tailscaleIP: "100.64.1.2")
        #expect(host == "127.0.0.1")
    }

    @Test func resolveLocalGatewayHostUsesLoopbackForAutoWithoutTailnet() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "auto",
            tailscaleIP: nil)
        #expect(host == "127.0.0.1")
    }

    @Test func resolveLocalGatewayHostPrefersTailnetForTailnetMode() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "tailnet",
            tailscaleIP: "100.64.1.5")
        #expect(host == "100.64.1.5")
    }

    @Test func resolveLocalGatewayHostFallsBackToLoopbackForTailnetMode() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "tailnet",
            tailscaleIP: nil)
        #expect(host == "127.0.0.1")
    }

    @Test func resolveLocalGatewayHostUsesCustomBindHost() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "custom",
            tailscaleIP: "100.64.1.9",
            customBindHost: "192.168.1.10")
        #expect(host == "192.168.1.10")
    }
}
