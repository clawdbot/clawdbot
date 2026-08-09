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
            scriptPath: "/Applications/OpenClaw.app/Contents/Resources/install-cli.sh",
            compatibleWith: "2026.7.4")

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
        #expect(!command.contains("--compatible-with"))
    }

    @Test func `channel installer checks compatibility before replacing the managed CLI`() {
        let command = CLIInstaller.installScriptCommand(
            target: .channel(.stable),
            prefix: "/Users/Test User/.openclaw",
            scriptPath: "/Applications/OpenClaw.app/Contents/Resources/install-cli.sh",
            compatibleWith: "2026.7.3-beta.8")

        #expect(command.suffix(3) == [
            "latest",
            "--compatible-with",
            "2026.7.3-beta.8",
        ])
    }

    @Test func `dev installer uses a managed git main checkout`() {
        let command = CLIInstaller.installScriptCommand(
            target: .channel(.dev),
            prefix: "/Users/Test User/.openclaw",
            scriptPath: "/Applications/OpenClaw.app/Contents/Resources/install-cli.sh",
            compatibleWith: "2026.7.3")

        #expect(command.suffix(5) == [
            "2026.7.3",
            "--install-method",
            "git",
            "--git-dir",
            "/Users/Test User/.openclaw/dev/openclaw",
        ])
    }

    @Test func `dev source installs allow a full cold build`() {
        #expect(CLIInstaller.installWatchdogTimeout(for: .channel(.dev)) == 7200)
        #expect(CLIInstaller.installWatchdogTimeout(for: .channel(.stable)) == 900)
        #expect(CLIInstaller.installWatchdogTimeout(for: .channel(.beta)) == 900)
        #expect(CLIInstaller.installWatchdogTimeout(for: .exact(String())) == 900)
    }

    @Test func `installer events map to concise live status`() {
        let cases: [(String, String)] = [
            (#"{"event":"step","name":"disk-space","status":"start"}"#, "Checking available disk space…"),
            (#"{"event":"step","name":"node","status":"start"}"#, "Installing Node.js runtime…"),
            (#"{"event":"step","name":"git-tools","status":"start"}"#, "Preparing Git and pnpm…"),
            (#"{"event":"step","name":"git-clone","status":"start"}"#, "Downloading OpenClaw source…"),
            (#"{"event":"step","name":"git-update","status":"start"}"#, "Updating OpenClaw source…"),
            (#"{"event":"step","name":"dependencies","status":"start"}"#, "Installing dependencies…"),
            (#"{"event":"step","name":"control-ui","status":"start"}"#, "Building interface…"),
            (#"{"event":"step","name":"cli-build","status":"start"}"#, "Building OpenClaw CLI…"),
            (#"{"event":"step","name":"openclaw","status":"retry"}"#, "Retrying OpenClaw CLI install…"),
            (
                #"{"event":"step","name":"disk-space","status":"warn"}"#,
                "Couldn’t verify free disk space; continuing…"),
            (
                #"{"event":"step","name":"git-update","status":"warn"}"#,
                "Using the existing modified OpenClaw source…"),
            (
                #"{"event":"step","name":"control-ui","status":"warn"}"#,
                "Interface build did not finish; continuing…"),
        ]

        for (line, expected) in cases {
            #expect(CLIInstaller.installStatus(forEventLine: line) == expected)
        }
    }

    @Test func `installer status ignores malformed unknown and terminal events`() {
        for line in [
            "not json",
            #"{"event":"step","name":"future-stage","status":"start"}"#,
            #"{"event":"step","name":"dependencies","status":"ok"}"#,
            #"{"event":"done","ok":true,"version":"2026.7.3"}"#,
            #"{"event":"error","message":"failed"}"#,
        ] {
            #expect(CLIInstaller.installStatus(forEventLine: line) == nil)
        }
    }

    @Test func `installer extracts one actionable disk preflight error`() {
        let output = """
        {"event":"step","name":"disk-space","status":"start"}
        {"event":"error","message":"Fresh Git installs require at least 6 GiB of free disk space; only 2.0 GiB is available. Free disk space and retry."}
        """

        #expect(CLIInstaller.installErrorMessage(from: output) ==
            "Fresh Git installs require at least 6 GiB of free disk space; only 2.0 GiB is available. Free disk space and retry.")
    }

    @Test func `managed update uses the canonical updater without accepting downgrades`() {
        let command = CLIInstaller.managedUpdateCommand(
            executable: "/Users/Test User/.openclaw/bin/openclaw",
            targetVersion: "2026.7.4")

        #expect(command == [
            "/Users/Test User/.openclaw/bin/openclaw",
            "update",
            "--tag",
            "2026.7.4",
            "--json",
            "--timeout",
            "900",
        ])
        #expect(!command.contains("--yes"))

        let withoutRestart = CLIInstaller.managedUpdateCommand(
            executable: "/Users/Test User/.openclaw/bin/openclaw",
            targetVersion: "2026.7.4",
            restartGateway: false)
        #expect(withoutRestart == command + ["--no-restart"])

        let repair = CLIInstaller.managedUpdateCommand(
            executable: "/Users/Test User/.openclaw/bin/openclaw",
            targetVersion: "2026.7.4",
            restartGateway: false,
            repair: true)
        #expect(repair == [
            "/Users/Test User/.openclaw/bin/openclaw",
            "update",
            "repair",
            "--json",
            "--timeout",
            "900",
            "--yes",
            "--no-restart",
        ])
    }

    @Test func `managed update parses structured updater diagnostics`() throws {
        let summary = try #require(CLIInstaller.parseManagedUpdateSummary("""
        {
          "status": "error",
          "mode": "npm",
          "reason": "package-update-failed",
          "before": { "version": "2026.7.3" },
          "after": { "version": "2026.7.3" },
          "steps": [
            { "name": "package update", "exitCode": 1, "stderrTail": "registry unavailable" }
          ],
          "durationMs": 42
        }
        """))

        #expect(summary.status == "error")
        #expect(summary.reason == "package-update-failed")
        #expect(summary.before?.version == "2026.7.3")
        #expect(summary.steps?.first?.name == "package update")
        #expect(summary.steps?.first?.stderrTail == "registry unavailable")
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

    @Test func `channel install cannot bootstrap with an older config writer`() {
        #expect(!CLIInstaller.channelInstallIsCompatible(
            installedVersion: "2026.7.1-2",
            appVersion: "2026.7.2"))
        #expect(!CLIInstaller.channelInstallIsCompatible(
            installedVersion: "2026.7.2-beta.6",
            appVersion: "2026.7.2-beta.7"))
        #expect(CLIInstaller.channelInstallIsCompatible(
            installedVersion: "2026.7.2",
            appVersion: "2026.7.2-beta.7"))
        #expect(CLIInstaller.channelInstallIsCompatible(
            installedVersion: "2026.7.2-beta.7",
            appVersion: "2026.7.2"))
        #expect(CLIInstaller.channelInstallIsCompatible(
            installedVersion: "2026.7.2-1",
            appVersion: "2026.7.2-2"))
        #expect(CLIInstaller.channelInstallIsCompatible(
            installedVersion: "2026.7.3-beta.1",
            appVersion: "2026.7.2"))
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
