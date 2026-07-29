import Foundation
import Testing
@testable import OpenClaw

struct LaunchAgentManagerTests {
    @Test func `enabling an already loaded login job only refreshes its plist`() async {
        var persistedBundlePaths: [String] = []
        let reloaded = await LaunchAgentManager.set(
            enabled: true,
            bundlePath: "/Applications/OpenClaw.app",
            loaded: true,
            writePlist: { persistedBundlePaths.append($0) })

        #expect(reloaded == false)
        #expect(persistedBundlePaths == ["/Applications/OpenClaw.app"])
    }

    @Test func `launch at login plist does not keep app alive after manual quit`() throws {
        let plist = LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app")
        let data = try #require(plist.data(using: .utf8))
        let object = try #require(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

        #expect(object["RunAtLoad"] as? Bool == true)
        #expect(object["KeepAlive"] == nil)

        let args = try #require(object["ProgramArguments"] as? [String])
        #expect(args == ["/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"])
    }

    @MainActor
    @Test func `launch at login plist preserves normalized profile environment once`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": "  /tmp/custom&<openclaw>\"'.json  ",
            "OPENCLAW_STATE_DIR": "/tmp/openclaw-state",
        ]) {
            let plist = LaunchAgentManager.plistContents(
                bundlePath: "/Applications/OpenClaw.app",
                preferredPaths: ["/tmp/custom&<bin>", "/usr/bin"])
            let data = try #require(plist.data(using: .utf8))
            let object = try #require(
                PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

            let environment = try #require(object["EnvironmentVariables"] as? [String: String])
            #expect(environment["OPENCLAW_CONFIG_PATH"] == "/tmp/custom&<openclaw>\"'.json")
            #expect(environment["OPENCLAW_STATE_DIR"] == "/tmp/openclaw-state")
            #expect(environment["PATH"]?.contains("/tmp/custom&<bin>") == true)
            #expect(plist.components(separatedBy: "<key>OPENCLAW_CONFIG_PATH</key>").count == 2)
            #expect(plist.components(separatedBy: "<key>OPENCLAW_STATE_DIR</key>").count == 2)
        }
    }

    @MainActor
    @Test func `launch at login plist omits unset and blank profile environment`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": " \n ",
        ]) {
            let plist = LaunchAgentManager.plistContents(bundlePath: "/Applications/OpenClaw.app")
            let data = try #require(plist.data(using: .utf8))
            let object = try #require(
                PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

            let environment = try #require(object["EnvironmentVariables"] as? [String: String])
            #expect(environment.keys.sorted() == ["PATH"])
            #expect(!plist.contains("OPENCLAW_CONFIG_PATH"))
            #expect(!plist.contains("OPENCLAW_STATE_DIR"))
        }
    }
}
