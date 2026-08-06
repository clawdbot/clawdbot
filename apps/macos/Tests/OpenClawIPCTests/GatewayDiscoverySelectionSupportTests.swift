import Foundation
import OpenClawDiscovery
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayDiscoverySelectionSupportTests {
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

    @Test func `selecting tailscale serve gateway switches to direct transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
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
                currentRouteIsDiscoveryOwned: false,
                state: state)

            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "wss://\(tailnetHost)")
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == tailnetHost)
        }
    }

    @Test func `selecting txt advertised tailnet gateway keeps ssh transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    gatewayTls: true,
                    stableID: "wide-area|openclaw.internal.|gateway-host"),
                currentRouteIsDiscoveryOwned: false,
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:18789")
        }
    }

    @Test func `tailnet discovery without verified serve source keeps ssh transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 18789,
                    tailnetDns: tailnetHost,
                    stableID: "wide-area|openclaw.internal.|gateway-host"),
                currentRouteIsDiscoveryOwned: false,
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:18789")
        }
    }

    @Test func `selecting nearby lan gateway keeps ssh without direct reachability signal`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host"
            state.remoteUrl = "ws://localhost:29876"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 18789,
                    stableID: "bonjour|nearby-gateway"),
                currentRouteIsDiscoveryOwned: false,
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:29876")
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == "nearby-gateway.local")
        }
    }

    @Test func `selecting direct reachable lan gateway keeps ssh transport`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteUrl = "ws://localhost:29876"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 19999,
                    gatewayDirectReachable: true,
                    stableID: "bonjour|nearby-gateway-custom"),
                currentRouteIsDiscoveryOwned: false,
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:29876")
        }
    }

    @Test func `selecting tls advertised lan gateway keeps ssh transport`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteUrl = "ws://localhost:29876"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 443,
                    gatewayTls: true,
                    stableID: "bonjour|nearby-gateway-tls"),
                currentRouteIsDiscoveryOwned: false,
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:29876")
        }
    }

    @Test func `selecting lan gateway preserves explicit direct transport`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .direct

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 19999,
                    stableID: "bonjour|nearby-gateway-manual"),
                currentRouteIsDiscoveryOwned: false,
                state: state)

            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "ws://nearby-gateway.local:19999")
        }
    }

    @Test func `selecting raw tailnet gateway preserves explicit direct transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .direct

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 18789,
                    stableID: "wide-area|openclaw.internal.|gateway-host"),
                currentRouteIsDiscoveryOwned: false,
                state: state)

            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "ws://\(tailnetHost):18789")
        }
    }

    @Test func `new lan selection retires prior discovery owned direct transport`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .direct
            state.remoteUrl = "wss://old-gateway.example.ts.net"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 18789,
                    gatewayDirectReachable: true,
                    stableID: "bonjour|nearby-gateway-new"),
                currentRouteIsDiscoveryOwned: true,
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:18789")
        }
    }
}
