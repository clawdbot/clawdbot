import Foundation
import Testing
@testable import OpenClaw

struct GatewayLaunchAgentManagerTests {
    @Test func `attach only runtime override does not uninstall gateway launch agent`() throws {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-attach-only-\(UUID().uuidString)", isDirectory: true)
        let marker = dir.appendingPathComponent("disable-launchagent")
        try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: dir) }
        defer {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
        }

        GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
        GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
        GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

        let error = GatewayLaunchAgentManager.applyAttachOnlyRuntimeOverride()

        #expect(error == nil)
        #expect(FileManager().fileExists(atPath: marker.path))
        #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
    }

    @Test func `launch agent plist snapshot parses args and env`() throws {
        let url = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-\(UUID().uuidString).plist")
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway", "--port", "18789", "--bind", "loopback"],
            "EnvironmentVariables": [
                "OPENCLAW_GATEWAY_TOKEN": " secret ",
                "OPENCLAW_GATEWAY_PASSWORD": "pw",
            ],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: url, options: [.atomic])
        defer { try? FileManager().removeItem(at: url) }

        let snapshot = try #require(LaunchAgentPlist.snapshot(url: url))
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == "loopback")
        #expect(snapshot.token == "secret")
        #expect(snapshot.password == "pw")
    }

    @Test func `launch agent plist snapshot allows missing bind`() throws {
        let url = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-\(UUID().uuidString).plist")
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway", "--port", "18789"],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: url, options: [.atomic])
        defer { try? FileManager().removeItem(at: url) }

        let snapshot = try #require(LaunchAgentPlist.snapshot(url: url))
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == nil)
    }
}
