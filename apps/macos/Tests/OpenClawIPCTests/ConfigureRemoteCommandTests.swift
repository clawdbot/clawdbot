import Darwin
import Foundation
import Testing
@testable import OpenClawMacCLI

@Suite(.serialized)
struct ConfigureRemoteCommandTests {
    @Test(arguments: ["token", "password"], ["file", "stdin", "argv"])
    @MainActor func `configure remote reads secret sources and warns only for argv`(
        kind: String,
        source: String) async throws
    {
        // Standard input belongs to the test process; keep it separate from parallel runner events.
        let result = try await #require(processExitsWith: .success, observing: [\.standardErrorContent]) { [
            kind = kind as String,
            source = source as String,
        ] in
            try await ConfigureRemoteCommandTests.checkSecretSource(kind: kind, source: source)
        }
        let warningText = String(decoding: result.standardErrorContent, as: UTF8.self)
        if source == "argv" {
            #expect(warningText.contains("--\(kind) is deprecated; use --\(kind)-file or --\(kind)-stdin."))
        } else {
            #expect(!warningText.contains("deprecated"))
        }
        #expect(!warningText.contains("synthetic-\(kind)"))
    }

    @MainActor private static func checkSecretSource(kind: String, source: String) async throws {
        let directory = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-secret-\(UUID().uuidString)", isDirectory: true)
        try FileManager().createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: directory) }
        let configURL = directory.appendingPathComponent("openclaw.json")
        let secretURL = directory.appendingPathComponent("secret.txt")
        let secret = "synthetic-\(kind)"
        try Data("\(secret)\r\n\n".utf8).write(to: secretURL)
        let secretArguments = switch source {
        case "file": ["--\(kind)-file", secretURL.path]
        case "stdin": ["--\(kind)-stdin"]
        default: ["--\(kind)", secret]
        }
        let transportArguments = kind == "token"
            ? ["--ssh-target", "alice@gateway.example"]
            : ["--direct-url", "wss://gateway.example"]

        try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configURL.path]) {
            let configure: () throws -> Void = {
                try configureRemote(
                    ConfigureRemoteOptions.parse(transportArguments + secretArguments),
                    defaultsSuites: [])
            }
            if source == "stdin" {
                let input = try FileHandle(forReadingFrom: secretURL)
                defer { try? input.close() }
                try self.withStandardInput(from: input, configure)
            } else {
                try configure()
            }
        }

        let root = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as? [String: Any])
        let gateway = try #require(root["gateway"] as? [String: Any])
        let remote = try #require(gateway["remote"] as? [String: Any])
        try #require(remote[kind] as? String == secret)
    }

    @Test(arguments: ["token", "password"])
    func `configure remote rejects conflicting secret sources before reading input`(kind: String) {
        for arguments in [
            ["--\(kind)", "synthetic-secret", "--\(kind)-file", "/does-not-exist"],
            ["--\(kind)-file", "/does-not-exist", "--\(kind)", "synthetic-secret"],
            ["--\(kind)", "synthetic-secret", "--\(kind)-stdin"],
            ["--\(kind)-stdin", "--\(kind)", "synthetic-secret"],
            ["--\(kind)-file", "/does-not-exist", "--\(kind)-stdin"],
            ["--\(kind)-stdin", "--\(kind)-file", "/does-not-exist"],
            ["--\(kind)-file"],
            ["--\(kind)-file", "--json"],
            ["--\(kind)", "--\(kind)-file", "/does-not-exist"],
            ["--token-stdin", "--password-stdin"],
        ] {
            #expect(throws: Error.self) { try ConfigureRemoteOptions.parse(arguments) }
        }
    }

    private static func withStandardInput(
        from handle: FileHandle,
        _ body: () throws -> Void) throws
    {
        let original = dup(STDIN_FILENO)
        try #require(original >= 0)
        defer {
            dup2(original, STDIN_FILENO)
            close(original)
        }
        try #require(dup2(handle.fileDescriptor, STDIN_FILENO) >= 0)
        try body()
    }

    @Test @MainActor func `configure remote writes ssh config and app defaults`() async throws {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-remote-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        let defaultSuites = [
            "ConfigureRemoteCommandTests.release.\(UUID().uuidString)",
            "ConfigureRemoteCommandTests.debug.\(UUID().uuidString)",
        ]
        let defaultsBySuite = defaultSuites.compactMap { suite in
            UserDefaults(suiteName: suite).map { (suite, $0) }
        }
        defer {
            for (suite, _) in defaultsBySuite {
                UserDefaults.standard.removePersistentDomain(forName: suite)
            }
        }

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            let output = try configureRemote(
                .init(
                    sshTarget: "alice@gateway.example",
                    localPort: 19089,
                    remotePort: 18789,
                    sshHostKeyPolicy: "openssh",
                    token: "test-token", // pragma: allowlist secret
                    password: nil,
                    identity: nil,
                    projectRoot: nil,
                    cliPath: "/opt/homebrew/bin/openclaw"),
                defaultsSuites: defaultSuites)

            #expect(output.status == "ok")
            #expect(output.localUrl == "ws://127.0.0.1:19089")
            #expect(output.remotePort == 18789)
            #expect(output.sshHostKeyPolicy == "openssh")

            let data = try Data(contentsOf: configURL)
            let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let gateway = try #require(root["gateway"] as? [String: Any])
            let remote = try #require(gateway["remote"] as? [String: Any])
            #expect(gateway["mode"] as? String == "remote")
            #expect(gateway["port"] as? Int == 19089)
            #expect(remote["transport"] as? String == "ssh")
            #expect(remote["url"] as? String == "ws://127.0.0.1:19089")
            #expect(remote["remotePort"] as? Int == 18789)
            #expect(remote["sshTarget"] as? String == "alice@gateway.example")
            #expect(remote["sshHostKeyPolicy"] as? String == "openssh")
            #expect(remote["token"] as? String == "test-token") // pragma: allowlist secret

            for (_, defaults) in defaultsBySuite {
                #expect(defaults.string(forKey: "openclaw.connectionMode") == "remote")
                #expect(defaults.string(forKey: "openclaw.remoteTarget") == "alice@gateway.example")
                #expect(defaults.bool(forKey: "openclaw.onboardingSeen") == true)
                #expect(defaults.string(forKey: "openclaw.remoteCliPath") == "/opt/homebrew/bin/openclaw")
            }
        }
    }

    @Test @MainActor func `configure remote clears host defaults only when target changes`() async throws {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-retarget-\(UUID().uuidString).json")
        let suite = "ConfigureRemoteCommandTests.retarget.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer {
            try? FileManager().removeItem(at: configURL)
            defaults.removePersistentDomain(forName: suite)
        }

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            try configureRemote(
                .init(
                    sshTarget: "alice@first.example",
                    identity: "/tmp/first-identity",
                    projectRoot: "/srv/first",
                    cliPath: "/opt/first/openclaw"),
                defaultsSuites: [suite])
            try configureRemote(.init(sshTarget: "alice@first.example"), defaultsSuites: [suite])
            #expect(defaults.string(forKey: "openclaw.remoteIdentity") == "/tmp/first-identity")
            #expect(defaults.string(forKey: "openclaw.remoteProjectRoot") == "/srv/first")
            #expect(defaults.string(forKey: "openclaw.remoteCliPath") == "/opt/first/openclaw")

            try configureRemote(
                .init(sshTarget: "alice@second.example", cliPath: "/opt/second/openclaw"),
                defaultsSuites: [suite])
            #expect(defaults.string(forKey: "openclaw.remoteIdentity") == nil)
            #expect(defaults.string(forKey: "openclaw.remoteProjectRoot") == nil)
            #expect(defaults.string(forKey: "openclaw.remoteCliPath") == "/opt/second/openclaw")

            try configureRemote(.init(directUrl: "wss://third.example"), defaultsSuites: [suite])
            #expect(defaults.string(forKey: "openclaw.remoteTarget") == nil)
            #expect(defaults.string(forKey: "openclaw.remoteIdentity") == nil)
            #expect(defaults.string(forKey: "openclaw.remoteProjectRoot") == nil)
            #expect(defaults.string(forKey: "openclaw.remoteCliPath") == nil)

            try configureRemote(
                .init(directUrl: "wss://third.example", projectRoot: "/srv/third"), defaultsSuites: [suite])
            try configureRemote(.init(directUrl: "wss://third.example"), defaultsSuites: [suite])
            #expect(defaults.string(forKey: "openclaw.remoteProjectRoot") == "/srv/third")
            try configureRemote(.init(directUrl: "wss://fourth.example"), defaultsSuites: [suite])
            #expect(defaults.string(forKey: "openclaw.remoteProjectRoot") == nil)
        }
    }

    @Test @MainActor func `configure remote preserves existing optional credentials when flags omitted`() async throws {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-remote-preserve-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        let initial: [String: Any] = [
            "gateway": [
                "remote": [
                    "token": "keep-token", // pragma: allowlist secret
                    "sshIdentity": "/tmp/id",
                    "sshHostKeyPolicy": "openssh",
                    "sshTarget": "alice@gateway.example",
                ],
            ],
        ]
        let initialData = try JSONSerialization.data(withJSONObject: initial, options: [.prettyPrinted])
        try FileManager().createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try initialData.write(to: configURL)

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            try configureRemote(.init(sshTarget: "alice@gateway.example"), defaultsSuites: [])

            let data = try Data(contentsOf: configURL)
            let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let gateway = try #require(root["gateway"] as? [String: Any])
            let remote = try #require(gateway["remote"] as? [String: Any])
            #expect(remote["token"] as? String == "keep-token") // pragma: allowlist secret
            #expect(remote["sshIdentity"] as? String == "/tmp/id")
            #expect(remote["sshHostKeyPolicy"] as? String == "openssh")
        }
    }

    @Test @MainActor func `configure remote defaults SSH host key policy to strict`() async throws {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-remote-strict-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        let initial: [String: Any] = [
            "gateway": [
                "remote": [
                    "sshHostKeyPolicy": "openssh",
                    "sshTarget": "old-gateway-alias",
                ],
            ],
        ]
        let initialData = try JSONSerialization.data(withJSONObject: initial, options: [.prettyPrinted])
        try initialData.write(to: configURL)

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            let output = try configureRemote(.init(sshTarget: "gateway-alias"), defaultsSuites: [])

            #expect(output.sshHostKeyPolicy == "strict")
            let data = try Data(contentsOf: configURL)
            let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let gateway = try #require(root["gateway"] as? [String: Any])
            let remote = try #require(gateway["remote"] as? [String: Any])
            #expect(remote["sshHostKeyPolicy"] as? String == "strict")
        }
    }

    @Test func `configure remote rejects invalid explicit ports`() throws {
        #expect(throws: Error.self) {
            _ = try ConfigureRemoteOptions.parse(["--ssh-target", "alice@gateway.example", "--remote-port", "99999"])
        }
        #expect(throws: Error.self) {
            _ = try ConfigureRemoteOptions.parse(["--ssh-target", "alice@gateway.example", "--local-port", "nope"])
        }
    }

    @Test func `configure remote validates SSH host key policy`() throws {
        #expect(ConfigureRemoteOptions().sshHostKeyPolicy == nil)
        #expect(try ConfigureRemoteOptions.parse([
            "--ssh-target", "gateway-alias",
            "--ssh-host-key-policy", "openssh",
        ]).sshHostKeyPolicy == "openssh")
        #expect(throws: Error.self) {
            _ = try ConfigureRemoteOptions.parse([
                "--ssh-target", "gateway-alias",
                "--ssh-host-key-policy", "accept-new",
            ])
        }
    }

    @Test func `configure remote rejects ssh targets without a host`() throws {
        #expect(throws: Error.self) {
            try configureRemote(.init(sshTarget: "user@"))
        }
        #expect(throws: Error.self) {
            try configureRemote(.init(sshTarget: "alice@:2222"))
        }
    }

    @Test @MainActor func `configure remote can write direct private url`() async throws {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-direct-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        let initial: [String: Any] = [
            "gateway": [
                "port": 19089,
                "remote": ["sshHostKeyPolicy": "openssh"],
            ],
        ]
        let initialData = try JSONSerialization.data(withJSONObject: initial, options: [.prettyPrinted])
        try FileManager().createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try initialData.write(to: configURL)

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            let output = try configureRemote(
                .init(
                    directUrl: "ws://192.168.0.202:18789",
                    token: "test-token"), // pragma: allowlist secret
                defaultsSuites: [])

            #expect(output.transport == "direct")
            #expect(output.remoteUrl == "ws://192.168.0.202:18789")
            #expect(output.localUrl == nil)
            #expect(output.sshTarget == nil)
            #expect(output.sshHostKeyPolicy == nil)

            let data = try Data(contentsOf: configURL)
            let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let gateway = try #require(root["gateway"] as? [String: Any])
            let remote = try #require(gateway["remote"] as? [String: Any])
            #expect(gateway["mode"] as? String == "remote")
            #expect(gateway["port"] as? Int == 19089)
            #expect(remote["transport"] as? String == "direct")
            #expect(remote["url"] as? String == "ws://192.168.0.202:18789")
            #expect(remote["remotePort"] == nil)
            #expect(remote["sshTarget"] == nil)
            #expect(remote["sshHostKeyPolicy"] == nil)
            #expect(remote["token"] as? String == "test-token") // pragma: allowlist secret
        }
    }

    @Test @MainActor func `configure remote writes state dir config when config path is unset`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-state-\(UUID().uuidString)", isDirectory: true)
        let configURL = stateDir.appendingPathComponent("openclaw.json")
        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            try #require(resolveOpenClawConfigURL().path == configURL.path)
            let output = try configureRemote(
                .init(
                    directUrl: "ws://192.168.0.203:18789",
                    token: "state-dir-token"), // pragma: allowlist secret
                defaultsSuites: [])

            #expect(output.configPath == configURL.path)
            let data = try Data(contentsOf: configURL)
            let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let gateway = try #require(root["gateway"] as? [String: Any])
            let remote = try #require(gateway["remote"] as? [String: Any])
            #expect(gateway["mode"] as? String == "remote")
            #expect(remote["transport"] as? String == "direct")
            #expect(remote["url"] as? String == "ws://192.168.0.203:18789")
            #expect(remote["token"] as? String == "state-dir-token") // pragma: allowlist secret
        }
    }

    @Test @MainActor func `configure remote rejects plaintext public prefix bypass`() async {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-direct-reject-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        _ = await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            #expect(throws: Error.self) {
                try configureRemote(.init(directUrl: "ws://fd-example.com:18789"))
            }
            #expect(throws: Error.self) {
                try configureRemote(.init(directUrl: "ws://192.168.0.202.attacker.example:18789"))
            }
        }
    }
}

@Suite(.serialized)
struct GatewayConfigTests {
    @Test @MainActor func `config path wins when both config and state dir are set`() async throws {
        let rootDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-cli-config-precedence-\(UUID().uuidString)", isDirectory: true)
        let explicitConfigURL = rootDir.appendingPathComponent("explicit.json")
        let stateConfigURL = rootDir.appendingPathComponent("state/openclaw.json")
        defer { try? FileManager().removeItem(at: rootDir) }

        try self.writeGatewayConfig(
            to: explicitConfigURL,
            port: 19101,
            remoteURL: "wss://explicit-config.example:19101",
            token: "explicit-config-token") // pragma: allowlist secret
        try self.writeGatewayConfig(
            to: stateConfigURL,
            port: 19102,
            remoteURL: "wss://state-config.example:19102",
            token: "state-config-token") // pragma: allowlist secret

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": explicitConfigURL.path,
            "OPENCLAW_STATE_DIR": stateConfigURL.deletingLastPathComponent().path,
        ]) {
            let config = loadGatewayConfig()

            #expect(config.port == 19101)
            #expect(config.remoteUrl == "wss://explicit-config.example:19101")
            #expect(config.remoteToken == "explicit-config-token") // pragma: allowlist secret
        }
    }

    @Test @MainActor func `config path trims surrounding whitespace and expands tilde`() async {
        let relativePath = ".openclaw-cli-config-\(UUID().uuidString)/openclaw.json"

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": "  ~/\(relativePath)\n",
            "OPENCLAW_STATE_DIR": "/tmp/openclaw-unused-state-dir",
        ]) {
            let expectedURL = FileManager().homeDirectoryForCurrentUser.appendingPathComponent(relativePath)
            #expect(resolveOpenClawConfigURL().path == expectedURL.path)
        }
    }

    @Test @MainActor func `state dir trims surrounding whitespace for connect and wizard`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw cli state profile \(UUID().uuidString)", isDirectory: true)
        let configURL = stateDir.appendingPathComponent("openclaw.json")
        defer { try? FileManager().removeItem(at: stateDir) }

        try self.writeGatewayConfig(
            to: configURL,
            port: 19201,
            remoteURL: "wss://state-profile.example:19202",
            remotePort: 19203,
            token: "state-profile-token") // pragma: allowlist secret

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": "\t\(stateDir.path)  ",
        ]) {
            let config = loadGatewayConfig()

            #expect(config.mode == "remote")
            #expect(config.port == 19201)
            #expect(config.remoteUrl == "wss://state-profile.example:19202")
            #expect(config.remotePort == 19203)
            #expect(config.remoteToken == "state-profile-token") // pragma: allowlist secret
        }
    }

    private func writeGatewayConfig(
        to url: URL,
        port: Int,
        remoteURL: String,
        remotePort: Int = 18789,
        token: String) throws
    {
        let root: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "port": port,
                "remote": [
                    "url": remoteURL,
                    "remotePort": remotePort,
                    "token": token,
                ],
            ],
        ]
        try FileManager().createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: [.atomic])
    }
}
