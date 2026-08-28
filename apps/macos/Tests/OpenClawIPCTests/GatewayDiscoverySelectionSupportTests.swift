import Foundation
import OpenClawDiscovery
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayDiscoverySelectionSupportTests {
    private func withIsolation(
        configPath: String,
        _ body: () async -> Void) async
    {
        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: [
                "gateway.preferredStableID": nil,
                "bridge.preferredStableID": nil,
                "gateway.preferredStableIDRouteBinding.v1": nil,
            ],
            body)
    }

    private func makeGateway(
        serviceHost: String?,
        servicePort: Int?,
        tailnetDns: String? = nil,
        sshPort: Int = 22,
        gatewayTls: Bool = false,
        gatewayDirectReachable: Bool = false,
        stableID: String) -> GatewayDiscoveryModel.DiscoveredGateway
    {
        GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Gateway",
            serviceHost: serviceHost,
            servicePort: servicePort,
            lanHost: nil,
            tailnetDns: tailnetDns,
            sshPort: sshPort,
            gatewayPort: servicePort,
            gatewayTls: gatewayTls,
            gatewayDirectReachable: gatewayDirectReachable,
            cliPath: nil,
            stableID: stableID,
            debugID: UUID().uuidString,
            isLocal: false)
    }

    @Test func `selecting tailscale serve gateway uses secure direct transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    gatewayTls: true,
                    stableID: "tailscale-serve|\(tailnetHost)"),
                state: state)

            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "wss://\(tailnetHost)")
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == tailnetHost)
        }
    }

    @Test func `selecting wide area tailnet gateway keeps SSH transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    gatewayTls: true,
                    stableID: "wide-area|openclaw.internal.|gateway-host"),
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:18789")
        }
    }

    @Test func `legacy tailnet discovery keeps SSH transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 18789,
                    tailnetDns: tailnetHost,
                    stableID: "wide-area|openclaw.internal.|gateway-host"),
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:18789")
        }
    }

    @Test func `selecting nearby lan gateway keeps ssh without direct reachability signal`() async {
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host"
            state.remoteUrl = "ws://localhost:29876"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 18789,
                    stableID: "bonjour|nearby-gateway"),
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:29876")
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == "nearby-gateway.local")
        }
    }

    @Test func `Bonjour direct reachability flag keeps SSH`() async {
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteUrl = "ws://localhost:29876"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 19999,
                    gatewayDirectReachable: true,
                    stableID: "bonjour|nearby-gateway-custom"),
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:29876")
        }
    }

    @Test func `Bonjour TLS flag keeps SSH`() async {
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 443,
                    gatewayTls: true,
                    stableID: "bonjour|nearby-gateway-tls"),
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:18789")
        }
    }

    @Test func `different discovery route atomically clears config credentials and fences ambient auth`() async {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_GATEWAY_TOKEN": "ambient-token",
                "OPENCLAW_GATEWAY_PASSWORD": "ambient-password",
            ],
            defaults: [
                "gateway.preferredStableID": nil,
                "bridge.preferredStableID": nil,
                "gateway.preferredStableIDRouteBinding.v1": nil,
            ])
        {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "ssh",
                        "url": "ws://127.0.0.1:18789",
                        "sshTarget": "\(NSUserName())@gateway-a.local",
                        "token": "gateway-a-token",
                        "password": "gateway-a-password",
                    ],
                ],
            ]))
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "attacker.local",
                    servicePort: 18789,
                    stableID: "bonjour|gateway-a"),
                state: state)

            await state._testAwaitGatewayConfigSync()
            let persistedRemote = (OpenClawConfigFile.loadDict()["gateway"] as? [String: Any])?["remote"]
                as? [String: Any]
            #expect(persistedRemote?["token"] == nil)
            #expect(persistedRemote?["password"] == nil)
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == "attacker.local")

            var source = await GatewayEndpointStore._testLiveSourceSnapshot(
                state: state,
                beforeConfigRead: {})
            #expect(source.token == nil)
            #expect(source.password == nil)

            var root = OpenClawConfigFile.loadDict()
            var gateway = root["gateway"] as? [String: Any] ?? [:]
            var remote = gateway["remote"] as? [String: Any] ?? [:]
            remote["password"] = "attacker-password"
            gateway["remote"] = remote
            root["gateway"] = gateway
            #expect(OpenClawConfigFile.saveDict(root))
            state._testApplyConfigFromDisk()
            source = await GatewayEndpointStore._testLiveSourceSnapshot(
                state: state,
                beforeConfigRead: {})
            #expect(source.token == nil)
            #expect(source.password == "attacker-password")

            GatewayDiscoveryPreferences.setPreferredStableID(nil)
            remote.removeValue(forKey: "password")
            gateway["remote"] = remote
            root["gateway"] = gateway
            #expect(OpenClawConfigFile.saveDict(root))
            state._testApplyConfigFromDisk()
            source = await GatewayEndpointStore._testLiveSourceSnapshot(
                state: state,
                beforeConfigRead: {})
            #expect(source.token == "ambient-token")
            #expect(source.password == "ambient-password")
        }
    }

    @Test func `same discovery route preserves its active token`() async {
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.connectionMode = .remote
            state.remoteTransport = .ssh
            state.remoteTarget = "\(NSUserName())@gateway-a.local"
            state.remoteToken = "gateway-a-token"
            let routeBinding = GatewayDiscoveryPreferences.routeBinding(
                connectionMode: .remote,
                remoteTransport: .ssh,
                remoteURL: state.remoteUrl,
                remoteTarget: state.remoteTarget)
            GatewayDiscoveryPreferences.setPreferredStableID(
                "bonjour|gateway-a",
                routeBinding: routeBinding)

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "gateway-a.local",
                    servicePort: 18789,
                    stableID: "bonjour|gateway-a"),
                state: state)

            #expect(state.remoteToken == "gateway-a-token")
        }
    }
}
