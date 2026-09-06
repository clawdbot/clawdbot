import Foundation
import OpenClawDiscovery
import Testing
@testable import OpenClaw

@MainActor
struct PairingSSHTargetOwnershipTests {
    @Test func `direct gateway never uses the previous SSH gateway target`() throws {
        let settings = self.settings(transport: .direct, target: "operator@gateway-a.local:2222")
        let target = try NodePairingApprovalPrompter.silentPairingSSHTarget(
            settings: settings,
            gatewayURL: #require(URL(string: "ws://gateway-b.local:18789")),
            gateways: [],
            preferredStableID: nil,
            user: "operator")
        #expect(target == nil)
    }

    @Test func `discovery SSH proof follows the connected endpoint rather than the preferred gateway`() throws {
        let gateways = [self.gateway("gateway-a.local", sshPort: 2201), self.gateway("gateway-b.local", sshPort: 2202)]
        let target = try NodePairingApprovalPrompter.silentPairingSSHTarget(
            settings: self.settings(transport: .direct),
            gatewayURL: #require(URL(string: "ws://gateway-b.local:18789/")),
            gateways: gateways,
            preferredStableID: "gateway-a.local",
            user: "operator")
        #expect(target == .init(host: "gateway-b.local", port: 2202))
    }

    @Test func `active SSH transport keeps its configured host and checks the local user`() throws {
        let url = try #require(URL(string: "ws://127.0.0.1:18789"))
        let settings = self.settings(transport: .ssh, target: "operator@gateway-a.local:2222")
        #expect(NodePairingApprovalPrompter.silentPairingSSHTarget(
            settings: settings,
            gatewayURL: url,
            gateways: [],
            preferredStableID: nil,
            user: "operator") == .init(host: "gateway-a.local", port: 2222))
        #expect(NodePairingApprovalPrompter.silentPairingSSHTarget(
            settings: settings,
            gatewayURL: url,
            gateways: [],
            preferredStableID: nil,
            user: "other") == nil)
    }

    private func settings(transport: AppState.RemoteTransport, target: String = "") -> CommandResolver.RemoteSettings {
        .init(
            mode: .remote,
            transport: transport,
            target: target,
            identity: "",
            projectRoot: "",
            cliPath: "",
            sshHostKeyPolicy: .strict)
    }

    private func gateway(_ host: String, sshPort: Int) -> GatewayDiscoveryModel.DiscoveredGateway {
        .init(
            displayName: host,
            serviceHost: host,
            servicePort: 18789,
            lanHost: nil,
            tailnetDns: nil,
            sshPort: sshPort,
            gatewayPort: 18789,
            gatewayTls: false,
            cliPath: nil,
            stableID: host,
            debugID: host,
            isLocal: false)
    }
}
