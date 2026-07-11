import Darwin
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct CommandResolverTests {
    private func makeDefaults() -> UserDefaults {
        // Use a unique suite to avoid cross-suite concurrency on UserDefaults.standard.
        UserDefaults(suiteName: "CommandResolverTests.\(UUID().uuidString)")!
    }

    private func makeLocalDefaults() -> UserDefaults {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)
        return defaults
    }

    private func makeProjectRootWithPnpm() throws -> (tmp: URL, pnpmPath: URL) {
        let tmp = try makeTempDirForTests()
        let pnpmPath = tmp.appendingPathComponent("node_modules/.bin/pnpm")
        try makeExecutableForTests(at: pnpmPath)
        return (tmp, pnpmPath)
    }

    @Test func `prefers open claw binary`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()

        let openclawPath = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try makeExecutableForTests(at: openclawPath)

        let searchPaths = [tmp.appendingPathComponent("node_modules/.bin").path]
        let cmd = CommandResolver.openclawCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: searchPaths,
            projectRoot: tmp)
        #expect(cmd.prefix(2).elementsEqual([openclawPath.path, "gateway"]))
    }

    @Test func `falls back to node and script`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()

        let nodePath = tmp.appendingPathComponent("node_modules/.bin/node")
        let scriptPath = tmp.appendingPathComponent("bin/openclaw.js")
        try makeExecutableForTests(at: nodePath)
        try "#!/bin/sh\necho v22.19.0\n".write(to: nodePath, atomically: true, encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodePath.path)
        try makeExecutableForTests(at: scriptPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path],
            projectRoot: tmp)

        #expect(cmd.count >= 3)
        if cmd.count >= 3 {
            #expect(cmd[0] == nodePath.path)
            #expect(cmd[1] == scriptPath.path)
            #expect(cmd[2] == "rpc")
        }
    }

    @Test func `prefers open claw binary over pnpm`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()

        let binDir = tmp.appendingPathComponent("bin")
        let openclawPath = binDir.appendingPathComponent("openclaw")
        let pnpmPath = binDir.appendingPathComponent("pnpm")
        try makeExecutableForTests(at: openclawPath)
        try makeExecutableForTests(at: pnpmPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [binDir.path],
            projectRoot: tmp)

        #expect(cmd.prefix(2).elementsEqual([openclawPath.path, "rpc"]))
    }

    @Test func `uses open claw binary without node runtime`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()

        let binDir = tmp.appendingPathComponent("bin")
        let openclawPath = binDir.appendingPathComponent("openclaw")
        try makeExecutableForTests(at: openclawPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [binDir.path],
            projectRoot: tmp)

        #expect(cmd.prefix(2).elementsEqual([openclawPath.path, "gateway"]))
    }

    @Test func `falls back to pnpm`() throws {
        let defaults = self.makeLocalDefaults()
        let (tmp, pnpmPath) = try self.makeProjectRootWithPnpm()

        let cmd = CommandResolver.openclawCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path],
            projectRoot: tmp)

        #expect(cmd.prefix(4).elementsEqual([pnpmPath.path, "--silent", "openclaw", "rpc"]))
    }

    @Test func `pnpm keeps extra args after subcommand`() throws {
        let defaults = self.makeLocalDefaults()
        let (tmp, pnpmPath) = try self.makeProjectRootWithPnpm()

        let cmd = CommandResolver.openclawCommand(
            subcommand: "health",
            extraArgs: ["--json", "--timeout", "5"],
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path],
            projectRoot: tmp)

        #expect(cmd.prefix(5).elementsEqual([pnpmPath.path, "--silent", "openclaw", "health", "--json"]))
        #expect(cmd.suffix(2).elementsEqual(["--timeout", "5"]))
    }

    @Test func `preferred paths start with project node bins`() throws {
        let tmp = try makeTempDirForTests()

        let first = CommandResolver.preferredPaths(
            home: FileManager().homeDirectoryForCurrentUser,
            current: [],
            projectRoot: tmp).first
        #expect(first == tmp.appendingPathComponent("node_modules/.bin").path)
    }

    @Test func `managed install only precedes external installs after validation`() throws {
        let home = try makeTempDirForTests()
        let managedBin = home.appendingPathComponent(".openclaw/bin")
        try FileManager().createDirectory(at: managedBin, withIntermediateDirectories: true)
        let managedExecutable = managedBin.appendingPathComponent("openclaw")

        let fallbackPaths = CommandResolver.preferredPaths(
            home: home,
            current: [],
            projectRoot: home)
        let validatedPaths = CommandResolver.preferredPaths(
            home: home,
            current: [],
            projectRoot: home,
            validatedExecutable: managedExecutable.path)

        let packageManagerPath = home.appendingPathComponent("Library/pnpm").path
        let fallbackManagedIndex = try #require(fallbackPaths.firstIndex(of: managedBin.path))
        let fallbackPackageManagerIndex = try #require(fallbackPaths.firstIndex(of: packageManagerPath))
        let validatedManagedIndex = try #require(validatedPaths.firstIndex(of: managedBin.path))
        let validatedPackageManagerIndex = try #require(validatedPaths.firstIndex(of: packageManagerPath))
        #expect(fallbackManagedIndex > fallbackPackageManagerIndex)
        #expect(validatedManagedIndex < validatedPackageManagerIndex)
    }

    @Test func `node manager runtimes precede system runtimes`() throws {
        let home = try makeTempDirForTests()
        let nodeManagerBin = home.appendingPathComponent(".nvm/versions/node/v22.19.0/bin")
        try makeExecutableForTests(at: nodeManagerBin.appendingPathComponent("node"))

        let paths = CommandResolver.preferredPaths(
            home: home,
            current: [],
            projectRoot: home)

        let managerIndex = try #require(paths.firstIndex(of: nodeManagerBin.path))
        let systemIndex = try #require(paths.firstIndex(of: "/opt/homebrew/bin"))
        #expect(managerIndex < systemIndex)
    }

    @Test func `preferred paths include local user bin after system bins`() throws {
        let home = try makeTempDirForTests()
        let localBin = home.appendingPathComponent(".local/bin").path
        let paths = CommandResolver.preferredPaths(
            home: home,
            current: [],
            projectRoot: home)

        let localIndex = try #require(paths.firstIndex(of: localBin))
        let systemIndex = try #require(paths.firstIndex(of: "/bin"))
        #expect(localIndex > systemIndex)
        #expect(paths.count(where: { $0 == localBin }) == 1)
    }

    @Test func `SSH environment replaces path without dropping inherited values`() {
        let paths = ["/usr/bin", "/bin", "/Users/test/.local/bin", "/opt/homebrew/bin"]
        let environment = CommandResolver.sshEnvironment(
            base: [
                "HOME": "/Users/test",
                "PATH": "/stale/path",
                "SSH_AUTH_SOCK": "/tmp/ssh-agent.sock",
            ],
            searchPaths: paths)

        #expect(environment["PATH"] == paths.joined(separator: ":"))
        #expect(environment["HOME"] == "/Users/test")
        #expect(environment["SSH_AUTH_SOCK"] == "/tmp/ssh-agent.sock")
    }

    @Test func `validated CLI preference expires when the app requires a newer version`() throws {
        let defaults = self.makeDefaults()
        let root = try makeTempDirForTests()
        let executable = root.appendingPathComponent("openclaw")
        FileManager().createFile(atPath: executable.path, contents: Data())
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        defaults.set(executable.path, forKey: cliValidatedExecutableKey)
        defaults.set("2026.7.3", forKey: cliValidatedVersionKey)

        #expect(CommandResolver.validatedOpenClawExecutable(
            defaults: defaults,
            fileManager: .default,
            requiredVersion: "2026.7.3") == executable.path)
        #expect(CommandResolver.validatedOpenClawExecutable(
            defaults: defaults,
            fileManager: .default,
            requiredVersion: "2026.8.0") == nil)

        defaults.set("2026.7.3-beta.1", forKey: cliValidatedVersionKey)
        #expect(CommandResolver.validatedOpenClawExecutable(
            defaults: defaults,
            fileManager: .default,
            requiredVersion: "2026.7.3") == nil)
        defaults.set("2026.7.3", forKey: cliValidatedVersionKey)
        #expect(CommandResolver.validatedOpenClawExecutable(
            defaults: defaults,
            fileManager: .default,
            requiredVersion: "2026.7.3-beta.1") == nil)
    }

    @Test func `builds SSH command for remote mode`() {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("openclaw@example.com:2222", forKey: remoteTargetKey)
        defaults.set("/tmp/id_ed25519", forKey: remoteIdentityKey)
        defaults.set("/srv/openclaw", forKey: remoteProjectRootKey)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "status",
            extraArgs: ["--json"],
            defaults: defaults,
            configRoot: [:])

        #expect(cmd.first == "/usr/bin/ssh")
        if let marker = cmd.firstIndex(of: "--") {
            #expect(cmd[marker + 1] == "openclaw@example.com")
        } else {
            #expect(Bool(false))
        }
        #expect(cmd.contains("StrictHostKeyChecking=yes"))
        #expect(!cmd.contains("StrictHostKeyChecking=accept-new"))
        #expect(cmd.contains("UpdateHostKeys=yes"))
        #expect(cmd.contains("ControlPath=none"))
        #expect(cmd.contains("-i"))
        #expect(cmd.contains("/tmp/id_ed25519"))
        if let script = cmd.last {
            #expect(script.contains("PRJ='/srv/openclaw'"))
            #expect(script.contains("cd \"$PRJ\""))
            #expect(script.contains("openclaw"))
            #expect(script.contains("status"))
            #expect(script.contains("--json"))
            #expect(script.contains("CLI="))
        }
    }

    @Test func `explicit SSH config host key policy omits strict override`() {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("gateway-alias", forKey: remoteTargetKey)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "status",
            defaults: defaults,
            configRoot: [
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "sshHostKeyPolicy": "openssh",
                        "sshTarget": "gateway-alias",
                    ],
                ],
            ])

        #expect(cmd.first == "/usr/bin/ssh")
        #expect(!cmd.contains { $0.hasPrefix("StrictHostKeyChecking=") })
        #expect(cmd.contains("ControlPath=none"))
    }

    @Test func `explicit SSH config replaces stale defaults with its host key policy`() {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("new-gateway-alias", forKey: remoteTargetKey)
        defaults.set("/tmp/stale-id", forKey: remoteIdentityKey)

        let configRoot: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "remote": [
                    "sshHostKeyPolicy": "openssh",
                    "sshTarget": "old-gateway-alias",
                    "sshIdentity": "/tmp/config-id",
                ],
            ],
        ]

        let cmd = CommandResolver.openclawCommand(
            subcommand: "status",
            defaults: defaults,
            configRoot: configRoot)
        let settings = CommandResolver.connectionSettings(
            defaults: defaults,
            configRoot: configRoot)

        #expect(settings.target == "old-gateway-alias")
        #expect(settings.identity == "/tmp/config-id")
        #expect(settings.sshHostKeyPolicy == .openssh)
        #expect(!cmd.contains { $0.hasPrefix("StrictHostKeyChecking=") })
        #expect(cmd.contains("/tmp/config-id"))
        #expect(!cmd.contains("/tmp/stale-id"))
    }

    @Test func `explicit blank SSH config clears stale defaults`() {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("stale-gateway-alias", forKey: remoteTargetKey)
        defaults.set("/tmp/stale-id", forKey: remoteIdentityKey)

        let settings = CommandResolver.connectionSettings(
            defaults: defaults,
            configRoot: [
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "sshTarget": "   ",
                        "sshIdentity": "   ",
                    ],
                ],
            ])

        #expect(settings.target.isEmpty)
        #expect(settings.identity.isEmpty)
        #expect(settings.sshHostKeyPolicy == .strict)
    }

    @Test func `remote SSH with explicit blank target fails closed`() throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("stale-gateway-alias", forKey: remoteTargetKey)
        let tmp = try makeTempDirForTests()
        let localOpenClaw = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try makeExecutableForTests(at: localOpenClaw)

        let command = CommandResolver.openclawCommand(
            subcommand: "status",
            defaults: defaults,
            configRoot: [
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "ssh",
                        "sshTarget": "   ",
                    ],
                ],
            ],
            searchPaths: [localOpenClaw.deletingLastPathComponent().path],
            projectRoot: tmp)

        #expect(command.first == "/bin/sh")
        #expect(command.last?.contains("Remote SSH gateway target is missing or invalid.") == true)
        #expect(!command.contains(localOpenClaw.path))
    }

    @Test func `direct remote route uses local CLI despite stale SSH defaults`() throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("stale-gateway-alias", forKey: remoteTargetKey)
        let tmp = try makeTempDirForTests()
        let localOpenClaw = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try makeExecutableForTests(at: localOpenClaw)

        let command = CommandResolver.openclawCommand(
            subcommand: "status",
            defaults: defaults,
            configRoot: [
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://gateway.example.test",
                    ],
                ],
            ],
            searchPaths: [localOpenClaw.deletingLastPathComponent().path],
            projectRoot: tmp)

        #expect(command == [localOpenClaw.path, "status"])
    }

    @Test func `invalid SSH host key policy fails closed`() {
        let settings = CommandResolver.connectionSettings(configRoot: [
            "gateway": [
                "mode": "remote",
                "remote": ["sshHostKeyPolicy": " OPENSSH "],
            ],
        ])

        #expect(settings.sshHostKeyPolicy == .strict)
    }

    @Test func `remote gateway probe applies SSH host key policy`() throws {
        let strict = try #require(RemoteGatewayProbe._testSSHCheckCommand(
            target: "gateway-alias",
            hostKeyPolicy: .strict))
        let openssh = try #require(RemoteGatewayProbe._testSSHCheckCommand(
            target: "gateway-alias",
            hostKeyPolicy: .openssh))

        #expect(strict.contains("StrictHostKeyChecking=yes"))
        #expect(strict.contains("UpdateHostKeys=yes"))
        #expect(strict.contains("ControlPath=none"))
        #expect(!openssh.contains { $0.hasPrefix("StrictHostKeyChecking=") })
        #expect(!openssh.contains { $0.hasPrefix("UpdateHostKeys=") })
        #expect(openssh.contains("ControlPath=none"))
    }

    @Test func `empty remote defaults fall back to config remote values`() {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set(" ", forKey: remoteTargetKey)
        defaults.set("", forKey: remoteIdentityKey)

        let settings = CommandResolver.connectionSettings(
            defaults: defaults,
            configRoot: [
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "sshTarget": "alice@gateway.local",
                        "sshIdentity": "/tmp/config-id",
                    ],
                ],
            ])

        #expect(settings.target == "alice@gateway.local")
        #expect(settings.identity == "/tmp/config-id")
    }

    @Test func `rejects unsafe SSH targets`() {
        #expect(CommandResolver.parseSSHTarget("-oProxyCommand=calc") == nil)
        #expect(CommandResolver.parseSSHTarget("host:-oProxyCommand=calc") == nil)
        #expect(CommandResolver.parseSSHTarget("user@host:2222")?.port == 2222)
    }

    @Test func `config root local overrides remote defaults`() throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("openclaw@example.com:2222", forKey: remoteTargetKey)

        let tmp = try makeTempDirForTests()

        let openclawPath = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try makeExecutableForTests(at: openclawPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "daemon",
            defaults: defaults,
            configRoot: ["gateway": ["mode": "local"]],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path],
            projectRoot: tmp)

        #expect(cmd.first == openclawPath.path)
        #expect(cmd.count >= 2)
        if cmd.count >= 2 {
            #expect(cmd[1] == "daemon")
        }
    }

    @Test func `remote settings fall back to config ssh target`() {
        let defaults = self.makeDefaults()
        let settings = CommandResolver.connectionSettings(
            defaults: defaults,
            configRoot: [
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "sshTarget": "alice@gateway.example:2222",
                        "sshIdentity": "/tmp/id_ed25519",
                    ],
                ],
            ])

        #expect(settings.mode == .remote)
        #expect(settings.target == "alice@gateway.example:2222")
        #expect(settings.identity == "/tmp/id_ed25519")
    }
}
