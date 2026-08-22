import Foundation
import Testing
@testable import OpenClawDiscovery

struct TailscaleServeGatewayDiscoveryTests {
    @Test func `discovers serve gateway from tailnet peers`() async {
        let statusJson = """
        {
          "Self": {
            "DNSName": "local-mac.tailnet-example.ts.net.",
            "HostName": "local-mac",
            "Online": true
          },
          "Peer": {
            "peer-1": {
              "DNSName": "gateway-host.tailnet-example.ts.net.",
              "HostName": "gateway-host",
              "Online": true
            },
            "peer-2": {
              "DNSName": "offline.tailnet-example.ts.net.",
              "HostName": "offline-box",
              "Online": false
            },
            "peer-3": {
              "DNSName": "local-mac.tailnet-example.ts.net.",
              "HostName": "local-mac",
              "Online": true
            }
          }
        }
        """

        let context = TailscaleServeGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: { statusJson },
            probeHost: { host, _ in
                host == "gateway-host.tailnet-example.ts.net"
            })

        let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: 2.0, context: context)
        #expect(beacons.count == 1)
        #expect(beacons.first?.displayName == "gateway-host")
        #expect(beacons.first?.tailnetDns == "gateway-host.tailnet-example.ts.net")
        #expect(beacons.first?.host == "gateway-host.tailnet-example.ts.net")
        #expect(beacons.first?.port == 443)
    }

    @Test func `returns empty when status unavailable`() async {
        let context = TailscaleServeGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: { nil },
            probeHost: { _, _ in true })

        let beacons = await TailscaleServeGatewayDiscovery.discover(timeoutSeconds: 2.0, context: context)
        #expect(beacons.isEmpty)
    }

    @Test func `resolves bare executable from PATH`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let executable = tempDir.appendingPathComponent("tailscale")
        try "#!/bin/sh\necho ok\n".write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        let env: [String: String] = ["PATH": tempDir.path]
        let resolved = TailscaleServeGatewayDiscovery.resolveExecutablePath("tailscale", env: env)
        #expect(resolved == executable.path)
    }

    @Test func `rejects missing executable candidate`() {
        #expect(TailscaleServeGatewayDiscovery.resolveExecutablePath("", env: [:]) == nil)
        #expect(TailscaleServeGatewayDiscovery
            .resolveExecutablePath("definitely-not-here", env: ["PATH": "/tmp"]) == nil)
    }

    @Test func `adds TERM for GUI-launched tailscale subprocesses`() {
        let env = TailscaleServeGatewayDiscovery.commandEnvironment(base: [
            "HOME": "/Users/tester",
            "PATH": "/usr/bin:/bin",
        ])

        #expect(env["TERM"] == "dumb")
        #expect(env["HOME"] == "/Users/tester")
        #expect(env["PATH"] == "/usr/bin:/bin")
    }

    @Test func `preserves existing TERM when building tailscale subprocess environment`() {
        let env = TailscaleServeGatewayDiscovery.commandEnvironment(base: [
            "TERM": "xterm-256color",
            "HOME": "/Users/tester",
        ])

        #expect(env["TERM"] == "xterm-256color")
        #expect(env["HOME"] == "/Users/tester")
    }
}
