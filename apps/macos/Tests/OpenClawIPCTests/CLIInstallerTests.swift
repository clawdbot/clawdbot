import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CLIInstallerTests {
    @Test func `installed location finds executable`() throws {
        let fm = FileManager()
        let root = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-cli-installer-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }

        let binDir = root.appendingPathComponent("bin")
        try fm.createDirectory(at: binDir, withIntermediateDirectories: true)
        let cli = binDir.appendingPathComponent("openclaw")
        fm.createFile(atPath: cli.path, contents: Data())
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cli.path)

        let found = CLIInstaller.installedLocation(
            searchPaths: [binDir.path],
            fileManager: fm)
        #expect(found == cli.path)

        try fm.removeItem(at: cli)
        fm.createFile(atPath: cli.path, contents: Data())
        try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: cli.path)

        let missing = CLIInstaller.installedLocation(
            searchPaths: [binDir.path],
            fileManager: fm)
        #expect(missing == nil)
    }

    @Test func `installer command runs the signed bundled script without a shell pipeline`() {
        let command = CLIInstaller.installScriptCommand(
            target: .exact("2026.7.3-beta.1"),
            prefix: "/Users/Test User/.openclaw",
            scriptPath: "/Applications/OpenClaw.app/Contents/Resources/install-cli.sh")

        #expect(command == [
            "/bin/bash",
            "/Applications/OpenClaw.app/Contents/Resources/install-cli.sh",
            "--json",
            "--no-onboard",
            "--prefix",
            "/Users/Test User/.openclaw",
            "--version",
            "2026.7.3-beta.1",
        ])
        #expect(!command.contains("curl"))
    }

    @Test func `dev installer uses a managed git main checkout`() {
        let command = CLIInstaller.installScriptCommand(
            target: .channel(.dev),
            prefix: "/Users/Test User/.openclaw",
            scriptPath: "/Applications/OpenClaw.app/Contents/Resources/install-cli.sh")

        #expect(command.suffix(6) == [
            "--version",
            "main",
            "--install-method",
            "git",
            "--git-dir",
            "/Users/Test User/.openclaw/dev/openclaw",
        ])
    }

    @Test func `release builds install exact while unreleased builds choose a channel`() {
        #expect(CLIInstaller.automaticInstallTarget(
            appVersion: "2026.7.2",
            isDebug: false) == .exact("2026.7.2"))
        #expect(CLIInstaller.automaticInstallTarget(
            appVersion: "2026.7.2-1",
            isDebug: false) == .exact("2026.7.2-1"))
        #expect(CLIInstaller.automaticInstallTarget(
            appVersion: "2026.7.2-beta.1",
            isDebug: false) == nil)
        #expect(CLIInstaller.automaticInstallTarget(
            appVersion: "2026.7.2",
            isDebug: true) == nil)
        #expect(CLIInstaller.suggestedChannel(
            appVersion: "2026.7.2-beta.1",
            isDebug: false) == .beta)
        #expect(CLIInstaller.suggestedChannel(
            appVersion: "2026.7.2",
            isDebug: true) == .dev)
    }

    @Test func `channel policy accepts the selected channel version`() throws {
        let suite = "CLIInstallerTests.channel-policy.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        #expect(CLIInstallPolicy.storedPolicy(defaults: defaults) == nil)
        #expect(CLIInstallPolicy.requiredGatewayVersionString(
            appVersion: "2026.7.2",
            isDebug: true,
            defaults: defaults) == "2026.7.2")
        defaults.set("beta", forKey: cliInstallPolicyKey)
        #expect(CLIInstallPolicy.storedPolicy(defaults: defaults) == "beta")
        #expect(CLIInstallPolicy.requiredGatewayVersionString(
            appVersion: "2026.7.2",
            isDebug: true,
            defaults: defaults) == nil)
        #expect(CLIInstallPolicy.requiredGatewayVersionString(
            appVersion: "2026.7.2-beta.1",
            isDebug: false,
            defaults: defaults) == nil)
        #expect(CLIInstallPolicy.requiredGatewayVersionString(
            appVersion: "2026.7.2",
            isDebug: false,
            defaults: defaults) == "2026.7.2")
    }

    @Test func `managed setup requires a parseable compatible version`() {
        let location = "/Users/test/.openclaw/bin/openclaw"

        #expect(CLIInstaller.classifyVersion(
            location: location,
            output: "OpenClaw 2026.7.3\n",
            expectedVersion: "2026.7.3") == .ready(location: location, version: "2026.7.3"))
        #expect(CLIInstaller.classifyVersion(
            location: location,
            output: "OpenClaw\n",
            expectedVersion: "2026.7.3") == .unusable(location: location))
        #expect(CLIInstaller.classifyVersion(
            location: location,
            output: "2026.6.1\n",
            expectedVersion: "2026.7.3") == .incompatible(
            location: location,
            found: "2026.6.1",
            required: "2026.7.3"))
        #expect(CLIInstaller.classifyVersion(
            location: location,
            output: "2026.7.3-beta.1\n",
            expectedVersion: "2026.7.3-beta.2") == .incompatible(
            location: location,
            found: "2026.7.3-beta.1",
            required: "2026.7.3-beta.2"))
        #expect(CLIInstaller.classifyVersion(
            location: location,
            output: "2026.7.3-beta.2\n",
            expectedVersion: "2026.7.3") == .incompatible(
            location: location,
            found: "2026.7.3-beta.2",
            required: "2026.7.3"))
        #expect(CLIInstaller.classifyVersion(
            location: location,
            output: "2026.7.3\n",
            expectedVersion: "2026.7.3-beta.2") == .incompatible(
            location: location,
            found: "2026.7.3",
            required: "2026.7.3-beta.2"))
        #expect(CLIInstaller.classifyVersion(
            location: location,
            output: "2026.7.3-alpha.1\n",
            expectedVersion: "2026.7.3") == .incompatible(
            location: location,
            found: "2026.7.3-alpha.1",
            required: "2026.7.3"))
    }

    @Test func `compatible external CLI satisfies setup`() async throws {
        let root = FileManager().temporaryDirectory.appendingPathComponent(
            "openclaw-compatible-cli-\(UUID().uuidString)")
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        let executable = root.appendingPathComponent("openclaw")
        try "#!/bin/sh\necho 'OpenClaw 2026.7.3'\n".write(
            to: executable,
            atomically: true,
            encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        let status = await CLIInstaller.status(location: executable.path)

        #expect(status == .ready(location: executable.path, version: "2026.7.3"))
    }

    @Test func `matching external CLI with unsupported Node is unusable`() async throws {
        let root = FileManager().temporaryDirectory.appendingPathComponent(
            "openclaw-old-node-cli-\(UUID().uuidString)")
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        let executable = root.appendingPathComponent("openclaw")
        let node = root.appendingPathComponent("node")
        try "#!/bin/sh\necho 'OpenClaw 2026.7.3'\n".write(
            to: executable,
            atomically: true,
            encoding: .utf8)
        try "#!/bin/sh\necho 'v20.18.0'\n".write(
            to: node,
            atomically: true,
            encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)

        let status = await CLIInstaller.status(location: executable.path)

        #expect(status == .unusable(location: executable.path))
    }

    @Test func `CLI probe preserves environment and resolves shebang tools beside executable`() {
        let location = "/custom/bin/openclaw"
        let environment = CLIInstaller.probeEnvironment(
            location: location,
            processEnvironment: ["HOME": "/Users/test", "PATH": "/usr/bin"],
            preferredPaths: ["/opt/homebrew/bin", "/usr/bin"])

        #expect(environment["HOME"] == "/Users/test")
        #expect(environment["PATH"] == "/custom/bin:/opt/homebrew/bin:/usr/bin")
    }

    @Test func `managed CLI probe prefers its private runtime`() {
        let executable = "/Users/test/.openclaw/bin/openclaw"
        let environment = CLIInstaller.probeEnvironment(
            location: executable,
            processEnvironment: [:],
            preferredPaths: ["/Users/test/.nvm/versions/node/v20/bin", "/usr/bin"],
            managedExecutable: executable,
            managedRuntimeDirectory: "/Users/test/.openclaw/tools/node/bin")

        #expect(environment["PATH"] == [
            "/Users/test/.openclaw/bin",
            "/Users/test/.openclaw/tools/node/bin",
            "/Users/test/.nvm/versions/node/v20/bin",
            "/usr/bin",
        ].joined(separator: ":"))
    }

    @Test func `successful CLI setup starts the local gateway and waits for readiness`() async {
        var didStart = false
        var didWait = false

        let activation = await CLIInstaller.activateLocalGateway(
            mode: .local,
            paused: false,
            start: { didStart = true },
            waitUntilReady: {
                didWait = true
                return true
            })

        #expect(didStart)
        #expect(didWait)
        #expect(activation == .ready)
    }

    @Test func `paused CLI setup defers gateway activation`() async {
        var didStart = false
        var didWait = false

        let activation = await CLIInstaller.activateLocalGateway(
            mode: .local,
            paused: true,
            start: { didStart = true },
            waitUntilReady: {
                didWait = true
                return true
            })

        #expect(!didStart)
        #expect(!didWait)
        #expect(activation == .deferred)
    }
}
