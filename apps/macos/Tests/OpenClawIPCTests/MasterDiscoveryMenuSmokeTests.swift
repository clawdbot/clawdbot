import OpenClawDiscovery
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct MasterDiscoveryMenuSmokeTests {
    @Test func `inline list builds body when empty`() {
        let discovery = GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName)
        discovery.statusText = "Searching…"
        discovery.gateways = []

        let view = GatewayDiscoveryInlineList(
            discovery: discovery,
            currentTarget: nil,
            currentUrl: nil,
            transport: .ssh,
            onSelect: { _ in })
        _ = view.body
    }

    @Test func `inline list builds body with master and selection`() {
        let discovery = GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName)
        discovery.statusText = "Found 1"
        discovery.gateways = [
            GatewayDiscoveryModel.DiscoveredGateway(
                displayName: "Office Mac",
                lanHost: "office.local",
                tailnetDns: "office.tailnet-123.ts.net",
                sshPort: 2222,
                gatewayPort: nil,
                cliPath: nil,
                stableID: "office",
                debugID: "office",
                isLocal: false),
        ]

        let currentTarget = "\(NSUserName())@office.tailnet-123.ts.net:2222"
        let view = GatewayDiscoveryInlineList(
            discovery: discovery,
            currentTarget: currentTarget,
            currentUrl: nil,
            transport: .ssh,
            onSelect: { _ in })
        _ = view.body
    }

    @Test func `menu builds body with masters`() {
        let discovery = GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName)
        discovery.statusText = "Found 2"
        discovery.gateways = [
            GatewayDiscoveryModel.DiscoveredGateway(
                displayName: "A",
                lanHost: "a.local",
                tailnetDns: nil,
                sshPort: 22,
                gatewayPort: nil,
                cliPath: nil,
                stableID: "a",
                debugID: "a",
                isLocal: false),
            GatewayDiscoveryModel.DiscoveredGateway(
                displayName: "B",
                lanHost: nil,
                tailnetDns: "b.ts.net",
                sshPort: 22,
                gatewayPort: nil,
                cliPath: nil,
                stableID: "b",
                debugID: "b",
                isLocal: false),
        ]

        let view = GatewayDiscoveryMenu(discovery: discovery, onSelect: { _ in })
        _ = view.body
    }
}
