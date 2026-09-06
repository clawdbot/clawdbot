import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct BundledNodeWorkerTests {
    private func makeBundle(at root: URL, builtAt: String, command: String) throws -> URL {
        let info: [String: Any] = [
            "CFBundleIdentifier": "ai.openclaw.mac.debug",
            "CFBundleExecutable": "OpenClaw",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "2026.8.1",
            "CFBundleVersion": "1",
            "OpenClawGitCommit": String(repeating: "a", count: 40),
            "OpenClawBuildTimestamp": builtAt,
            "OpenClawWorkerBuildID": builtAt,
        ]
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("Contents/MacOS"),
            withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: root.appendingPathComponent("Contents/Info.plist"))
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x86_64"
        #endif
        let runtime = root.appendingPathComponent("Contents/Resources/node-worker/\(arch)")
        let dist = runtime.appendingPathComponent("lib/node_modules/openclaw/dist")
        try FileManager.default.createDirectory(at: dist, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: runtime.appendingPathComponent("bin"),
            withIntermediateDirectories: true)
        // A real child process protects selection/lifecycle; package proof runs actual Node separately.
        try "#!/bin/sh\nexec /bin/sh \"$@\"\n".write(
            to: runtime.appendingPathComponent("bin/node"),
            atomically: true,
            encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: runtime.appendingPathComponent("bin/node").path)
        try JSONSerialization.data(withJSONObject: [
            "version": "2026.8.1", "commit": String(repeating: "a", count: 40),
            "builtAt": builtAt, "buildId": builtAt,
        ]).write(to: dist.appendingPathComponent("build-info.json"))
        try """
        printf '%s\\n' '{"type":"ready","version":"2026.8.1","manifest":{"caps":["system"],"commands":["\(
            command)"],"pathEnv":"/usr/bin:/bin"}}'
        while IFS= read -r line; do :; done
        """.write(to: dist.appendingPathComponent("entry.js"), atomically: true, encoding: .utf8)
        return dist
    }

    @Test func `dirty same-SHA rebuild selects relocated worker over accepted external CLI`() async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let external = root.appendingPathComponent("external/openclaw")
        try makeExecutableForTests(at: external)
        let defaults = try #require(UserDefaults(suiteName: "BundledNodeWorkerTests.\(UUID().uuidString)"))
        defaults.set(external.path, forKey: cliValidatedExecutableKey)
        defaults.set("2026.8.1", forKey: cliValidatedVersionKey)
        #expect(CommandResolver.validatedOpenClawExecutable(
            defaults: defaults, fileManager: .default, requiredVersion: "2026.8.1") == external.path)

        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        for (index, command) in ["worker.before", "worker.dirty"].enumerated() {
            let source = root.appendingPathComponent("source-\(index)")
            let app = source.appendingPathComponent("OpenClaw.app")
            _ = try self.makeBundle(at: app, builtAt: "2026-08-27T00:00:0\(index).000Z", command: command)
            let relocated = root.appendingPathComponent("relocated-\(index)/OpenClaw.app")
            try FileManager.default.createDirectory(
                at: relocated.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: app, to: relocated)
            try FileManager.default.removeItem(at: source)
            let bundle = try #require(Bundle(url: relocated))
            let launch = try await CommandResolver.nodeHostWorkerLaunch(
                bundle: bundle, projectRoot: source, searchPaths: [external.deletingLastPathComponent().path])
            do {
                let manifest = try await worker.start(launch: launch)
                #expect(manifest.commands == [command])
                #expect(launch.command[0].hasPrefix(relocated.path + "/"))
                #expect(!launch.command.contains(external.path))
            } catch {
                await worker.stop()
                throw error
            }
        }
        await worker.stop()
    }

    @Test(arguments: ["missing", "mismatched"])
    func `incomplete payload never falls back to development source`(failure: String) async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appendingPathComponent("OpenClaw.app")
        let dist = try makeBundle(at: app, builtAt: "2026-08-27T00:00:00.000Z", command: "unused")
        let info = dist.appendingPathComponent("build-info.json")
        if failure == "missing" {
            try FileManager.default.removeItem(at: info)
        } else {
            var payload = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: info)) as? [String: String])
            payload["builtAt"] = "2026-08-26T00:00:00.000Z"
            try JSONSerialization.data(withJSONObject: payload).write(to: info)
        }
        let bundle = try #require(Bundle(url: app))
        await #expect(throws: MacNodeHostWorker.WorkerError.self) {
            try await CommandResolver.nodeHostWorkerLaunch(bundle: bundle, projectRoot: root, searchPaths: [])
        }
    }
}
