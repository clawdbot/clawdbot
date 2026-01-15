import Foundation
import Testing
@testable import Clawdbot

@Suite struct GatewayEndpointStoreTests {
    @Test func resolveGatewayTokenPrefersEnvAndFallsBackToLaunchd() {
        let snapshot = LaunchAgentPlistSnapshot(
            programArguments: [],
            environment: ["CLAWDBOT_GATEWAY_TOKEN": "launchd-token"],
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
}
