import Foundation
import OpenClawDiscovery
import Testing
@testable import OpenClaw

struct GatewayDiscoveryHelpersTests {
    private func makeGateway(
        serviceHost: String?,
        servicePort: Int?,
        lanHost: String? = "txt-host.local",
        tailnetDns: String? = "txt-host.ts.net",
        sshPort: Int = 22,
        gatewayPort: Int? = 18789,
        gatewayTls: Bool = false) -> GatewayDiscoveryModel.DiscoveredGateway
    {
        GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Gateway",
            serviceHost: serviceHost,
            servicePort: servicePort,
            lanHost: lanHost,
            tailnetDns: tailnetDns,
            sshPort: sshPort,
            gatewayPort: gatewayPort,
            gatewayTls: gatewayTls,
            cliPath: "/tmp/openclaw",
            stableID: UUID().uuidString,
            debugID: UUID().uuidString,
            isLocal: false)
    }

    private func assertSSHTarget(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway,
        host: String,
        port: Int)
    {
        guard let target = GatewayDiscoveryHelpers.sshTarget(for: gateway) else {
            Issue.record("expected ssh target")
            return
        }
        let parsed = CommandResolver.parseSSHTarget(target)
        #expect(parsed?.host == host)
        #expect(parsed?.port == port)
    }

    @Test func `ssh target uses resolved service host only`() {
        let gateway = self.makeGateway(
            serviceHost: "resolved.example.ts.net",
            servicePort: 18789,
            sshPort: 2201)
        self.assertSSHTarget(for: gateway, host: "resolved.example.ts.net", port: 2201)
    }

    @Test func `ssh target allows missing resolved service port`() {
        let gateway = self.makeGateway(
            serviceHost: "resolved.example.ts.net",
            servicePort: nil,
            sshPort: 2201)
        self.assertSSHTarget(for: gateway, host: "resolved.example.ts.net", port: 2201)
    }

    @Test func `ssh target rejects txt only gateways`() {
        let gateway = self.makeGateway(
            serviceHost: nil,
            servicePort: nil,
            lanHost: "txt-only.local",
            tailnetDns: "txt-only.ts.net",
            sshPort: 2222)

        #expect(GatewayDiscoveryHelpers.sshTarget(for: gateway) == nil)
    }

    @Test func `direct url uses resolved service endpoint only`() {
        let tlsGateway = self.makeGateway(
            serviceHost: "resolved.example.ts.net",
            servicePort: 443,
            gatewayTls: true)
        #expect(GatewayDiscoveryHelpers.directUrl(for: tlsGateway) == "wss://resolved.example.ts.net")

        let wsGateway = self.makeGateway(
            serviceHost: "resolved.example.ts.net",
            servicePort: 18789)
        #expect(GatewayDiscoveryHelpers.directUrl(for: wsGateway) == "ws://resolved.example.ts.net:18789")

        let localGateway = self.makeGateway(
            serviceHost: "127.0.0.1",
            servicePort: 18789)
        #expect(GatewayDiscoveryHelpers.directUrl(for: localGateway) == "ws://127.0.0.1:18789")
    }

    @Test func `direct url rejects public plaintext service endpoint`() {
        let gateway = self.makeGateway(
            serviceHost: "gateway.example",
            servicePort: 18789,
            gatewayTls: false)

        #expect(GatewayDiscoveryHelpers.directUrl(for: gateway) == nil)
    }

    @Test func `direct url rejects txt only fallback`() {
        let gateway = self.makeGateway(
            serviceHost: nil,
            servicePort: nil,
            lanHost: "txt-only.local",
            tailnetDns: "txt-only.ts.net",
            gatewayPort: 22222)

        #expect(GatewayDiscoveryHelpers.directUrl(for: gateway) == nil)
    }
}
