import ClawdbotDiscovery
import Testing

@Suite
@MainActor
struct GatewayDiscoveryModelTests {
    @Test func localGatewayMatchesLanHost() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: [])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: "studio.local",
            tailnetDns: nil,
            displayName: nil,
            serviceName: nil,
            local: local))
    }

    @Test func localGatewayMatchesTailnetDns() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: [])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: "studio.tailnet.example",
            displayName: nil,
            serviceName: nil,
            local: local))
    }

    @Test func localGatewayMatchesDisplayName() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: [],
            displayTokens: ["peter's mac studio"])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: "Peter's Mac Studio (Clawdbot)",
            serviceName: nil,
            local: local))
    }

    @Test func remoteGatewayDoesNotMatch() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: ["peter's mac studio"])
        #expect(!GatewayDiscoveryModel.isLocalGateway(
            lanHost: "other.local",
            tailnetDns: "other.tailnet.example",
            displayName: "Other Mac",
            serviceName: "other-bridge",
            local: local))
    }

    @Test func localGatewayMatchesServiceName() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["studio"],
            displayTokens: [])
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: nil,
            serviceName: "studio-bridge",
            local: local))
    }

    @Test func serviceNameDoesNotFalsePositiveOnSubstringHostToken() {
        let local = GatewayDiscoveryModel.LocalIdentity(
            hostTokens: ["steipete"],
            displayTokens: [])
        #expect(!GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: nil,
            serviceName: "steipetacstudio (Clawdbot)",
            local: local))
        #expect(GatewayDiscoveryModel.isLocalGateway(
            lanHost: nil,
            tailnetDns: nil,
            displayName: nil,
            serviceName: "steipete (Clawdbot)",
            local: local))
    }

    @Test func parsesGatewayTXTFields() {
        let parsed = GatewayDiscoveryModel.parseGatewayTXT([
            "lanHost": "  studio.local  ",
            "tailnetDns": "  peters-mac-studio-1.ts.net  ",
            "sshPort": " 2222 ",
            "gatewayPort": " 18799 ",
            "cliPath": " /opt/clawdbot ",
        ])
        #expect(parsed.lanHost == "studio.local")
        #expect(parsed.tailnetDns == "peters-mac-studio-1.ts.net")
        #expect(parsed.sshPort == 2222)
        #expect(parsed.gatewayPort == 18799)
        #expect(parsed.cliPath == "/opt/clawdbot")
    }

    @Test func parsesGatewayTXTDefaults() {
        let parsed = GatewayDiscoveryModel.parseGatewayTXT([
            "lanHost": "  ",
            "tailnetDns": "\n",
            "gatewayPort": "nope",
            "sshPort": "nope",
        ])
        #expect(parsed.lanHost == nil)
        #expect(parsed.tailnetDns == nil)
        #expect(parsed.sshPort == 22)
        #expect(parsed.gatewayPort == nil)
        #expect(parsed.cliPath == nil)
    }

    @Test func buildsSSHTarget() {
        #expect(GatewayDiscoveryModel.buildSSHTarget(
            user: "peter",
            host: "studio.local",
            port: 22) == "peter@studio.local")
        #expect(GatewayDiscoveryModel.buildSSHTarget(
            user: "peter",
            host: "studio.local",
            port: 2201) == "peter@studio.local:2201")
    }
}
