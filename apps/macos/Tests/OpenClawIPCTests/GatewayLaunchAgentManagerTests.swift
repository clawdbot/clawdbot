import Foundation
import Testing
@testable import OpenClaw

struct GatewayLaunchAgentManagerTests {
    @Test func `reads Gateway service ownership command directly from launchd`() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-gateway-\(UUID().uuidString).plist")
        defer { try? FileManager.default.removeItem(at: url) }
        let arguments = [
            "/Users/Test/.openclaw/tools/node/bin/node",
            "/Users/Test/.openclaw/lib/node_modules/openclaw/dist/index.js",
            "gateway",
        ]
        let data = try PropertyListSerialization.data(
            fromPropertyList: ["ProgramArguments": arguments],
            format: .xml,
            options: 0)
        try data.write(to: url, options: .atomic)

        #expect(GatewayLaunchAgentManager._testLaunchdProgramArguments(plistURL: url) == arguments)
        try Data("not a plist".utf8).write(to: url, options: .atomic)
        #expect(GatewayLaunchAgentManager._testLaunchdProgramArguments(plistURL: url) == nil)
        try FileManager.default.removeItem(at: url)
        #expect(GatewayLaunchAgentManager._testLaunchdProgramArguments(plistURL: url) == [])
    }

    @Test func `daemon status exposes only a loaded running gateway pid`() {
        #expect(GatewayLaunchAgentManager._testRunningGatewayPID(from: """
        {
          "service": {
            "loaded": true,
            "runtime": { "status": "running", "pid": 4242 }
          }
        }
        """) == 4242)

        let rejected = [
            #"{"service":{"loaded":false,"runtime":{"status":"running","pid":4242}}}"#,
            #"{"service":{"loaded":true,"runtime":{"status":"stopped","pid":4242}}}"#,
            #"{"service":{"loaded":true,"runtime":{"status":"running","pid":0}}}"#,
            #"{"service":{"loaded":true,"runtime":{"status":"running","pid":2147483648}}}"#,
            #"{"service":{"loaded":true,"runtime":{"status":"running","pid":"4242"}}}"#,
            #"{"service":{"loaded":true,"runtime":{"status":"running"}}}"#,
            #"{"service":null}"#,
            "not-json",
        ]
        for json in rejected {
            #expect(GatewayLaunchAgentManager._testRunningGatewayPID(from: json) == nil)
        }
    }

    @Test func `attach only runtime override blocks gateway launch agent writes`() async throws {
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
        let kickstartError = await GatewayLaunchAgentManager.kickstart()

        #expect(error == nil)
        #expect(kickstartError == nil)
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

    @Test func `launch agent plist snapshot merges canonical generated environment`() throws {
        let directory = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-env-\(UUID().uuidString)", isDirectory: true)
        let plistURL = directory.appendingPathComponent("ai.openclaw.gateway.plist")
        let environmentFileURL = directory.appendingPathComponent("ai.openclaw.gateway.env")
        let wrapperURL = directory.appendingPathComponent("ai.openclaw.gateway-env-wrapper.sh")
        try FileManager().createDirectory(at: directory, withIntermediateDirectories: true)
        try "#!/bin/sh\n".write(to: wrapperURL, atomically: true, encoding: .utf8)
        try """
        # Generated by OpenClaw. Do not edit while the gateway service is installed.
        export CUSTOM_GATEWAY_TOKEN='custom-token'
        export OPENCLAW_GATEWAY_PASSWORD='service'\\''pass'
        export OPENCLAW_GATEWAY_TOKEN=' service-token '

        """.write(to: environmentFileURL, atomically: true, encoding: .utf8)
        let plist: [String: Any] = [
            "ProgramArguments": [
                "/bin/sh",
                wrapperURL.path,
                environmentFileURL.path,
                "openclaw",
                "gateway",
                "--port",
                "18789",
            ],
            "EnvironmentVariables": ["OPENCLAW_GATEWAY_TOKEN": "stale-inline-token"],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL, options: [.atomic])
        defer { try? FileManager().removeItem(at: directory) }

        let snapshot = try #require(LaunchAgentPlist.snapshot(
            url: plistURL,
            generatedEnvironmentFileURL: environmentFileURL,
            generatedEnvironmentWrapperURL: wrapperURL))
        #expect(snapshot.environment["CUSTOM_GATEWAY_TOKEN"] == "custom-token")
        #expect(snapshot.token == "service-token")
        #expect(snapshot.password == "service'pass")
        #expect(snapshot.port == 18789)
    }

    @Test func `launch agent plist snapshot ignores unreferenced generated environment`() throws {
        let directory = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-env-\(UUID().uuidString)", isDirectory: true)
        let plistURL = directory.appendingPathComponent("ai.openclaw.gateway.plist")
        let environmentFileURL = directory.appendingPathComponent("ai.openclaw.gateway.env")
        let wrapperURL = directory.appendingPathComponent("ai.openclaw.gateway-env-wrapper.sh")
        try FileManager().createDirectory(at: directory, withIntermediateDirectories: true)
        try "#!/bin/sh\n".write(to: wrapperURL, atomically: true, encoding: .utf8)
        try "export OPENCLAW_GATEWAY_TOKEN='unreferenced-token'\n"
            .write(to: environmentFileURL, atomically: true, encoding: .utf8)
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway"],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL, options: [.atomic])
        defer { try? FileManager().removeItem(at: directory) }

        let snapshot = try #require(LaunchAgentPlist.snapshot(
            url: plistURL,
            generatedEnvironmentFileURL: environmentFileURL,
            generatedEnvironmentWrapperURL: wrapperURL))
        #expect(snapshot.token == nil)
        #expect(snapshot.environment.isEmpty)
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
