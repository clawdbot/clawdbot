import Testing
@testable import ClawdbotDiscovery

@Suite
struct WideAreaGatewayDiscoveryTests {
    @Test func discoversBeaconFromTailnetDnsSdFallback() {
        let statusJson = """
        {
          "Self": { "TailscaleIPs": ["100.69.232.64"] },
          "Peer": {
            "peer-1": { "TailscaleIPs": ["100.123.224.76"] }
          }
        }
        """

        let context = WideAreaGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: { statusJson },
            dig: { args, _ in
                let recordType = args.last ?? ""
                let nameserver = args.first(where: { $0.hasPrefix("@") }) ?? ""
                if recordType == "PTR" {
                    if nameserver == "@100.123.224.76" {
                        return "steipetacstudio-bridge._clawdbot-bridge._tcp.clawdbot.internal.\n"
                    }
                    return ""
                }
                if recordType == "SRV" {
                    return "0 0 18790 steipetacstudio.clawdbot.internal."
                }
                if recordType == "TXT" {
                    return "\"displayName=Peter\\226\\128\\153s Mac Studio (Clawdbot)\" \"transport=bridge\" \"bridgePort=18790\" \"gatewayPort=18789\" \"tailnetDns=peters-mac-studio-1.sheep-coho.ts.net\" \"cliPath=/Users/steipete/clawdbot/src/entry.ts\""
                }
                return ""
            })

        let beacons = WideAreaGatewayDiscovery.discover(
            timeoutSeconds: 2.0,
            context: context)

        #expect(beacons.count == 1)
        let beacon = beacons[0]
        let expectedDisplay = "Peter\u{2019}s Mac Studio (Clawdbot)"
        #expect(beacon.displayName == expectedDisplay)
        #expect(beacon.bridgePort == 18790)
        #expect(beacon.gatewayPort == 18789)
        #expect(beacon.tailnetDns == "peters-mac-studio-1.sheep-coho.ts.net")
        #expect(beacon.cliPath == "/Users/steipete/clawdbot/src/entry.ts")
    }
}
