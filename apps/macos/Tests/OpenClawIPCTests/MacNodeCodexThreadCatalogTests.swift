import ConcurrencyExtras
import Darwin
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct MacNodeCodexThreadCatalogTests {
    private final class FakeCodex: Sendable {
        let directory: URL
        let executable: URL
        var capture: URL {
            URL(fileURLWithPath: self.executable.path + ".requests")
        }

        var eof: URL {
            URL(fileURLWithPath: self.executable.path + ".eof")
        }

        var exited: URL {
            URL(fileURLWithPath: self.executable.path + ".exited")
        }

        var exitGate: URL {
            URL(fileURLWithPath: self.executable.path + ".exit-gate")
        }

        init(directory: URL, executable: URL) {
            self.directory = directory
            self.executable = executable
        }

        deinit {
            try? FileManager.default.removeItem(at: self.directory)
        }
    }

    private func makeFakeCodex(_ script: String) throws -> FakeCodex {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-fake-codex-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let executable = directory.appendingPathComponent("codex")
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        return FakeCodex(directory: directory, executable: executable)
    }

    private func makeAppServer(
        preamble: String = "",
        initializeResult: String = "{}",
        captureHandshake: Bool = false,
        body: String) throws -> FakeCodex
    {
        let captureCommand = captureHandshake ? "printf" : ":"
        return try self.makeFakeCodex(#"""
        #!/bin/sh
        \#(preamble)
        IFS= read -r initialize || exit 2
        \#(captureCommand) '%s\n' "$initialize" >> "${0}.requests"
        id=$(printf '%s\n' "$initialize" | /usr/bin/sed -E 's/.*"id":([0-9]+).*/\1/')
        printf '{"id":%s,"result":\#(initializeResult)}\n' "$id"
        IFS= read -r initialized || exit 3
        \#(captureCommand) '%s\n' "$initialized" >> "${0}.requests"
        \#(body)
        """#)
    }

    private func makeEmptyListServer(
        tracksLaunches: Bool = false,
        recordsEOFExit: Bool = false,
        blocksEOFExit: Bool = false,
        captureHandshake: Bool = false,
        exitsAfterResponse: Bool = false) throws -> FakeCodex
    {
        var preamble: [String] = []
        if tracksLaunches {
            preamble.append(#"""
            count=0
            [ ! -f "${0}.processes" ] || count=$(cat "${0}.processes")
            printf '%s\n' "$((count + 1))" > "${0}.processes"
            printf '%s\n' "${CODEX_HOME-}" > "${0}.codex-home"
            """#)
        }
        if blocksEOFExit {
            preamble.append(#"mkfifo "${0}.exit-gate""#)
            preamble.append(#"trap '' TERM"#)
        }
        let eofExit = blocksEOFExit ? #"""
        touch "${0}.eof"
        IFS= read -r _ < "${0}.exit-gate"
        touch "${0}.exited"
        """# : recordsEOFExit ? #"""
        touch "${0}.eof"
        touch "${0}.exited"
        """# : ""
        let body = exitsAfterResponse ? #"""
        IFS= read -r request || exit 4
        id=$(printf '%s\n' "$request" | /usr/bin/sed -E 's/.*"id":([0-9]+).*/\1/')
        printf '{"id":%s,"result":{"data":[]}}\n' "$id"
        """# : #"""
        while IFS= read -r request; do
          printf '%s\n' "$request" >> "${0}.requests"
          id=$(printf '%s\n' "$request" | /usr/bin/sed -E 's/.*"id":([0-9]+).*/\1/')
          printf '{"id":%s,"result":{"data":[],"nextCursor":null,"backwardsCursor":null}}\n' "$id"
        done
        \#(eofExit)
        """#
        return try self.makeAppServer(
            preamble: preamble.joined(separator: "\n"),
            captureHandshake: captureHandshake,
            body: body)
    }

    private func makeBlockedRequestServer(warmup: Bool = false) throws -> FakeCodex {
        let warmupResponse = warmup ? #"""
        id=$(printf '%s\n' "$request" | /usr/bin/sed -E 's/.*"id":([0-9]+).*/\1/')
        printf '{"id":%s,"result":{"data":[]}}\n' "$id"
        IFS= read -r request || exit 5
        """# : ""
        return try self.makeAppServer(
            preamble: #"""
            count=0
            [ ! -f "${0}.processes" ] || count=$(cat "${0}.processes")
            count=$((count + 1))
            printf '%s\n' "$count" > "${0}.processes"
            """#,
            body: #"""
            IFS= read -r request || exit 4
            if [ "$count" = 1 ]; then
              \#(warmupResponse)
              printf '%s\n' "$request" > "${0}.request-started"
              IFS= read -r unexpected || exit 0
              printf '%s\n' "$unexpected" > "${0}.unexpected-request"
              exit 6
            fi
            id=$(printf '%s\n' "$request" | /usr/bin/sed -E 's/.*"id":([0-9]+).*/\1/')
            printf '{"id":%s,"result":{"data":[]}}\n' "$id"
            """#)
    }

    private func codexRoot(
        config: Any = ["supervision": ["enabled": true]],
        entryKey: String = "codex",
        enabled: Bool? = true,
        pluginPolicy: [String: Any] = [:]) -> [String: Any]
    {
        var entry: [String: Any] = ["config": config]
        if let enabled {
            entry["enabled"] = enabled
        }
        var plugins = pluginPolicy
        plugins["entries"] = [entryKey: entry]
        return ["plugins": plugins]
    }

    private func codexRoot(
        appServer: [String: Any],
        pluginPolicy: [String: Any] = [:]) -> [String: Any]
    {
        self.codexRoot(
            config: [
                "supervision": ["enabled": true],
                "appServer": appServer,
            ],
            pluginPolicy: pluginPolicy)
    }

    private func listResponseJSON(
        id: Int = 2,
        names: [String],
        nextCursor: String?) throws -> String
    {
        let encodedNextCursor: Any = nextCursor.map { $0 as Any } ?? NSNull()
        let threads: [[String: Any]] = names.enumerated().map { index, name in
            [
                "id": "thread-\(name)-\(index)",
                "name": name,
                "status": ["type": "notLoaded"],
            ]
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "id": id,
            "result": [
                "data": threads,
                "nextCursor": encodedNextCursor,
                "backwardsCursor": NSNull(),
            ],
        ])
        return try #require(String(data: data, encoding: .utf8))
    }

    private func waitForFile(_ url: URL, timeout: Duration = .seconds(2)) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !FileManager.default.fileExists(atPath: url.path), clock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        return FileManager.default.fileExists(atPath: url.path)
    }

    private func readTrimmed(_ url: URL) throws -> String {
        try String(contentsOf: url, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func openFIFOForWriting(_ url: URL) async throws -> FileHandle {
        while true {
            try Task.checkCancellation()
            let descriptor = Darwin.open(url.path, O_WRONLY | O_NONBLOCK | O_CLOEXEC)
            if descriptor >= 0 {
                let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
                do {
                    try Task.checkCancellation()
                    // The FIFO reader is a spawned fake child; if it exits before the
                    // gate write, an unsuppressed SIGPIPE kills the whole test harness.
                    try TestProcessSupport.suppressSIGPIPE(handle)
                    return handle
                } catch {
                    try? handle.close()
                    throw error
                }
            }
            let openError = errno
            guard openError == ENXIO || openError == EINTR else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(openError))
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    private func requestEmptyList(
        client: CodexAppServerThreadClient,
        executable: URL,
        timeoutSeconds: Double = 2,
        maxLineBytes: Int = 1024 * 1024) async throws -> Data
    {
        try await client.request(
            invocation: MacNodeCodexThreadCatalog.ResolvedInvocation(
                executable: executable.path,
                arguments: [],
                cwd: nil),
            method: "thread/list",
            requestParams: ["limit": 1],
            timeoutSeconds: timeoutSeconds,
            maxLineBytes: maxLineBytes)
    }

    @Test func `normalizes App Server metadata and drops sensitive thread fields`() throws {
        let raw: [String: Any] = [
            "data": [[
                "id": "thread-1",
                "sessionId": "session-1",
                "name": "Current task",
                "preview": "Build the catalog",
                "cwd": "/Users/example/project",
                "status": [
                    "type": "active",
                    "activeFlags": ["waitingOnUserInput"],
                ],
                "createdAt": 100,
                "updatedAt": 200,
                "recencyAt": 190,
                "source": ["custom": "chatgpt"],
                "modelProvider": "openai",
                "cliVersion": "0.143.0",
                "gitInfo": [
                    "branch": "codex/feature",
                    "sha": "secret-sha",
                    "originUrl": "git@example.test:private/repo.git",
                ],
                "path": "/Users/example/.codex/sessions/private.jsonl",
                "turns": [["items": [["text": "private transcript"]]]],
            ]],
            "nextCursor": "next-page",
            "backwardsCursor": "previous-page",
        ]
        let data = try JSONSerialization.data(withJSONObject: raw)

        let json = try MacNodeCodexThreadCatalog.normalize(listResultData: data)
        let decoded = try #require(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let sessions = try #require(decoded["sessions"] as? [[String: Any]])
        let session = try #require(sessions.first)

        #expect(decoded["codexHome"] == nil)
        #expect(decoded["nextCursor"] as? String == "next-page")
        #expect(decoded["backwardsCursor"] as? String == "previous-page")
        #expect(session["threadId"] as? String == "thread-1")
        #expect(session["status"] as? String == "active")
        #expect(session["source"] as? String == "custom:chatgpt")
        #expect(session["gitBranch"] as? String == "codex/feature")
        #expect(session["archived"] as? Bool == false)
        #expect(session["preview"] == nil)
        #expect(session["path"] == nil)
        #expect(session["turns"] == nil)
        #expect(session["sha"] == nil)
        #expect(session["originUrl"] == nil)
    }

    @Test func `bounds normalized metadata to the Gateway catalog contract`() throws {
        let longName = String(repeating: "😀", count: 251)
        let longMetadata = String(repeating: "m", count: 501)
        let longId = String(repeating: "i", count: 257)
        let raw: [String: Any] = [
            "data": [
                ["id": longId, "name": "dropped"],
                [
                    "id": "thread-1",
                    "sessionId": longId,
                    "name": longName,
                    "cwd": String(repeating: "c", count: 4097),
                    "status": [
                        "type": String(repeating: "s", count: 65),
                        "activeFlags": [String(repeating: "f", count: 129)] +
                            (0..<17).map { "flag-\($0)" },
                    ],
                    "source": ["custom": longMetadata],
                    "modelProvider": longMetadata,
                    "cliVersion": longMetadata,
                    "gitInfo": ["branch": longMetadata],
                ],
            ],
            "nextCursor": String(repeating: "n", count: 4097),
            "backwardsCursor": "opaque-backwards",
        ]
        let data = try JSONSerialization.data(withJSONObject: raw)

        let json = try MacNodeCodexThreadCatalog.normalize(listResultData: data)
        let decoded = try #require(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let sessions = try #require(decoded["sessions"] as? [[String: Any]])
        let session = try #require(sessions.first)

        #expect(sessions.count == 1)
        #expect((session["name"] as? String)?.utf16.count == 500)
        #expect(!(session["name"] as? String ?? "").contains("�"))
        #expect(session["sessionId"] == nil)
        #expect(session["cwd"] == nil)
        #expect(session["status"] as? String == "notLoaded")
        #expect((session["activeFlags"] as? [String])?.count == 16)
        #expect((session["source"] as? String)?.utf16.count == 500)
        #expect((session["modelProvider"] as? String)?.utf16.count == 500)
        #expect((session["cliVersion"] as? String)?.utf16.count == 500)
        #expect((session["gitBranch"] as? String)?.utf16.count == 500)
        #expect(decoded["nextCursor"] == nil)
        #expect(decoded["backwardsCursor"] as? String == "opaque-backwards")
    }

    @Test func `resolves and runs the configured Codex App Server without a shell`() async throws {
        let clearEnvSentinel = "OPENCLAW_CODEX_CATALOG_CLEAR_ENV_SENTINEL"
        _ = setenv(clearEnvSentinel, "present", 1)
        defer { _ = unsetenv(clearEnvSentinel) }
        let fake = try makeAppServer(
            preamble: #"""
            [ "$1" = "custom-app-server" ] || exit 10
            [ "$2" = "--stdio" ] || exit 11
            [ -z "${OPENCLAW_CODEX_CATALOG_CLEAR_ENV_SENTINEL+x}" ] || exit 12
            """#,
            body: #"""
            IFS= read -r list || exit 4
            printf '%s\n' '{"id":2,"result":{"data":[],"nextCursor":null,"backwardsCursor":null}}'
            sleep 1
            """#)
        defer { withExtendedLifetime(fake) {} }
        let root = self.codexRoot(
            config: [
                "supervision": ["enabled": true],
                "appServer": [
                    "transport": "stdio",
                    "homeScope": "user",
                    "command": fake.executable.path,
                    "args": #"custom-app-server "--stdio" workspace\ path "C:\\Codex" 'literal\slash' tail\"#,
                    "clearEnv": [" \(clearEnvSentinel) ", ""],
                ],
            ],
            entryKey: " codex ")

        let resolved = try MacNodeCodexThreadCatalog.resolveInvocation(
            root: root,
            searchPaths: [],
            currentDirectoryURL: FileManager.default.temporaryDirectory)

        #expect(resolved.executable == fake.executable.standardizedFileURL.path)
        #expect(resolved.arguments == [
            "custom-app-server",
            "--stdio",
            "workspace\\",
            "path",
            "C:\\\\Codex",
            "literal\\slash",
            "tail\\",
        ])
        #expect(resolved.cwd == nil)
        #expect(resolved.clearEnv == [clearEnvSentinel])

        let payload = try await MacNodeCodexThreadCatalog.list(
            paramsJSON: nil,
            executable: resolved.executable,
            arguments: resolved.arguments,
            cwd: resolved.cwd,
            clearEnv: resolved.clearEnv)
        let response = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        #expect((response["sessions"] as? [Any])?.isEmpty == true)
    }

    @Test func `uses official environment command and argument fallbacks`() throws {
        let fake = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let chatGPTApp = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let missing = fake.directory.appendingPathComponent("missing").path

        let resolved = try MacNodeCodexThreadCatalog.resolveInvocation(
            root: [:],
            environment: [
                "OPENCLAW_CODEX_APP_SERVER_BIN": " \(fake.executable.path) ",
                "OPENCLAW_CODEX_APP_SERVER_ARGS": #"custom-app-server "--listen" 'stdio://'"#,
            ],
            searchPaths: [],
            defaultMacOSChatGPTAppExecutable: chatGPTApp.executable.path,
            defaultUserMacOSChatGPTAppExecutable: missing,
            defaultMacOSAppExecutable: missing,
            defaultUserMacOSAppExecutable: missing,
            defaultMacOSBetaAppExecutable: missing,
            defaultUserMacOSBetaAppExecutable: missing)

        #expect(resolved.executable == fake.executable.standardizedFileURL.path)
        #expect(resolved.arguments == ["custom-app-server", "--listen", "stdio://"])
    }

    @Test func `configured command stays ahead of an installed ChatGPT app`() throws {
        let configured = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let chatGPTApp = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let root = self.codexRoot(
            config: ["appServer": ["command": configured.executable.path]],
            enabled: nil)

        let resolved = try MacNodeCodexThreadCatalog.resolveInvocation(
            root: root,
            searchPaths: [],
            defaultMacOSChatGPTAppExecutable: chatGPTApp.executable.path)

        #expect(resolved.executable == configured.executable.path)
    }

    @Test func `blank configured command falls back to the environment command`() throws {
        let fallback = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let root = self.codexRoot(
            config: ["appServer": ["command": "  \n "]],
            enabled: nil)

        let resolved = try MacNodeCodexThreadCatalog.resolveInvocation(
            root: root,
            environment: ["OPENCLAW_CODEX_APP_SERVER_BIN": fallback.executable.path],
            searchPaths: [])

        #expect(resolved.executable == fallback.executable.path)
    }

    @Test func `complete official plugin config remains eligible for the catalog`() throws {
        let app = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let root = self.codexRoot(config: [
            "codexDynamicToolsLoading": "direct",
            "codexDynamicToolsExclude": ["private_tool"],
            "discovery": ["enabled": true, "timeoutMs": 1000],
            "computerUse": [
                "enabled": false,
                "autoInstall": false,
                "marketplaceDiscoveryTimeoutMs": 1000,
                "marketplaceSource": "source",
                "marketplacePath": "path",
                "marketplaceName": "marketplace",
                "pluginName": "plugin",
                "mcpServerName": "server",
            ],
            // The TypeScript parser treats this subtree independently.
            "codexPlugins": 42,
            "supervision": [
                "enabled": true,
                "allowRawTranscripts": false,
                "allowWriteControls": false,
                "endpoints": [
                    [
                        "id": "local",
                        "label": "Local",
                        "transport": "stdio-proxy",
                        "command": "codex",
                        "args": ["app-server"],
                        "cwd": "/tmp",
                    ],
                    [
                        "id": "remote",
                        "label": "Remote",
                        "transport": "websocket",
                        "url": "wss://codex.example.test",
                        "authTokenEnv": "CODEX_TOKEN",
                    ],
                ],
            ],
            "appServer": [
                "mode": "guardian",
                "transport": "stdio",
                "homeScope": "user",
                "command": app.executable.path,
                "args": ["app-server", "--listen", "stdio://"],
                "url": "",
                "authToken": [
                    "source": "env",
                    "provider": "default",
                    "id": "CODEX_TOKEN",
                ],
                "headers": [
                    "x-file": [
                        "source": "file",
                        "provider": "mounted-json",
                        "id": "/codex/token~1value",
                    ],
                    "x-exec": [
                        "source": "exec",
                        "provider": "vault",
                        "id": "codex/token#value",
                    ],
                ],
                "clearEnv": ["OPENAI_API_KEY"],
                "remoteWorkspaceRoot": "/workspaces",
                "codeModeOnly": true,
                "requestTimeoutMs": 1000,
                "turnCompletionIdleTimeoutMs": 1000,
                "postToolRawAssistantCompletionIdleTimeoutMs": 1000,
                "approvalPolicy": "on-failure",
                "sandbox": "workspace-write",
                "approvalsReviewer": "user",
                "serviceTier": "priority",
                "networkProxy": [
                    "enabled": true,
                    "profileName": "openclaw",
                    "baseProfile": "workspace",
                    "mode": "limited",
                    "domains": ["example.test": "allow"],
                    "unixSockets": ["/tmp/service.sock": "allow"],
                    "proxyUrl": "http://127.0.0.1:8080",
                    "socksUrl": "socks5://127.0.0.1:1080",
                    "enableSocks5": true,
                    "enableSocks5Udp": false,
                    "allowUpstreamProxy": false,
                    "allowLocalBinding": false,
                    "dangerouslyAllowNonLoopbackProxy": false,
                    "dangerouslyAllowAllUnixSockets": false,
                ],
                "defaultWorkspaceDir": "",
                "experimental": ["sandboxExecServer": false],
            ],
        ])

        #expect(MacNodeCodexThreadCatalog.shouldAdvertise(root: root))
        let invocation = try MacNodeCodexThreadCatalog.resolveInvocation(root: root, searchPaths: [])
        #expect(invocation.executable == app.executable.path)
        #expect(invocation.clearEnv == ["OPENAI_API_KEY"])
    }

    @Test func `malformed or unknown official plugin config fails closed`() throws {
        let app = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        var malformedConfigs: [Any] = [
            "enabled",
            ["supervision": ["enabled": true], "unknown": true] as [String: Any],
            ["supervision": ["enabled": true], "codexDynamicToolsLoading": "lazy"] as [String: Any],
            ["supervision": ["enabled": true], "codexDynamicToolsExclude": ["tool", 42]] as [String: Any],
            ["supervision": ["enabled": true], "discovery": ["enabled": true, "unknown": true]] as [String: Any],
            ["supervision": ["enabled": true], "computerUse": ["timeoutMs": 1000]] as [String: Any],
            ["supervision": "enabled"] as [String: Any],
            ["supervision": ["enabled": true, "unknown": true]] as [String: Any],
            ["supervision": ["enabled": true, "allowRawTranscripts": 1]] as [String: Any],
            ["supervision": ["enabled": true, "endpoints": true]] as [String: Any],
            [
                "supervision": [
                    "enabled": true,
                    "endpoints": [["transport": "websocket", "url": "wss://example.test", "cwd": "/tmp"]],
                ],
            ] as [String: Any],
        ]
        let malformedAppServers: [Any] = [
            "stdio",
            ["unknown": true] as [String: Any],
            ["mode": "automatic"] as [String: Any],
            ["command": 42] as [String: Any],
            ["args": 42] as [String: Any],
            ["args": ["app-server", 42]] as [String: Any],
            ["url": 42] as [String: Any],
            ["authToken": ["source": "env", "provider": "default", "id": "lowercase"]] as [String: Any],
            ["headers": ["authorization": ["source": "exec", "provider": "vault", "id": "../token"]]] as [String: Any],
            ["clearEnv": true] as [String: Any],
            ["clearEnv": ["OPENAI_API_KEY", false]] as [String: Any],
            ["remoteWorkspaceRoot": "  "] as [String: Any],
            ["codeModeOnly": "true"] as [String: Any],
            ["requestTimeoutMs": 0] as [String: Any],
            ["turnCompletionIdleTimeoutMs": "1000"] as [String: Any],
            ["postToolRawAssistantCompletionIdleTimeoutMs": false] as [String: Any],
            ["approvalPolicy": "always"] as [String: Any],
            ["sandbox": "full"] as [String: Any],
            ["approvalsReviewer": "agent"] as [String: Any],
            ["serviceTier": false] as [String: Any],
            ["networkProxy": ["unknown": true]] as [String: Any],
            ["networkProxy": ["domains": ["example.test": "prompt"]]] as [String: Any],
            ["networkProxy": ["proxyUrl": "  "]] as [String: Any],
            ["defaultWorkspaceDir": 42] as [String: Any],
            ["experimental": ["unknown": true]] as [String: Any],
            ["experimental": ["sandboxExecServer": "true"]] as [String: Any],
            ["transport": true] as [String: Any],
            ["homeScope": 42] as [String: Any],
        ]
        malformedConfigs.append(contentsOf: malformedAppServers.map { appServer in
            [
                "supervision": ["enabled": true],
                "appServer": appServer,
            ] as [String: Any]
        })

        for config in malformedConfigs {
            let root = self.codexRoot(config: config)

            #expect(!MacNodeCodexThreadCatalog.shouldAdvertise(root: root))
            #expect(throws: MacNodeCodexThreadCatalog.CatalogError.invalidAppServerConfiguration) {
                try MacNodeCodexThreadCatalog.resolveInvocation(
                    root: root,
                    searchPaths: [],
                    defaultMacOSAppExecutable: app.executable.path)
            }
        }
    }

    @Test func `list authorizes and resolves one config snapshot`() async throws {
        let fake = try makeAppServer(body: #"""
        IFS= read -r list || exit 4
        printf '%s\n' '{"id":2,"result":{"data":[]}}'
        sleep 1
        """#)
        defer { withExtendedLifetime(fake) {} }
        let enabled = self.codexRoot(appServer: [
            "transport": "stdio",
            "homeScope": "user",
            "command": fake.executable.path,
            "args": ["app-server", "--listen", "stdio://"],
        ])
        let revoked = self.codexRoot(pluginPolicy: ["deny": ["codex"]])
        var loadCount = 0

        let payload = try await MacNodeCodexThreadCatalog.list(paramsJSON: nil) {
            loadCount += 1
            return loadCount == 1 ? enabled : revoked
        }
        let response = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])

        #expect(loadCount == 1)
        #expect((response["sessions"] as? [Any])?.isEmpty == true)
    }

    @Test func `does not advertise when the plugin allowlist excludes Codex`() {
        let root = self.codexRoot(pluginPolicy: ["allow": ["discord"]])

        #expect(!MacNodeCodexThreadCatalog.shouldAdvertise(root: root))
    }

    @Test func `rejects agent home scope instead of exposing the user Codex home`() throws {
        let app = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let root = self.codexRoot(appServer: [
            "transport": "stdio",
            "homeScope": "agent",
        ])

        #expect(!MacNodeCodexThreadCatalog.shouldAdvertise(root: root))
        #expect(throws: MacNodeCodexThreadCatalog.CatalogError.unsupportedAppServerHomeScope) {
            try MacNodeCodexThreadCatalog.resolveInvocation(
                root: root,
                searchPaths: [],
                defaultMacOSAppExecutable: app.executable.path)
        }
    }

    @Test func `rejects configured non-stdio transports instead of spawning a local fallback`() throws {
        let app = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let pathCLI = try makeFakeCodex("#!/bin/sh\nexit 0\n")

        for transport in ["websocket", "unix"] {
            let root = self.codexRoot(appServer: [
                "transport": transport,
                "command": "/must/not/win",
                "args": ["must-not-win"],
            ])

            #expect(!MacNodeCodexThreadCatalog.shouldAdvertise(root: root))
            #expect(throws: MacNodeCodexThreadCatalog.CatalogError.unsupportedAppServerTransport) {
                try MacNodeCodexThreadCatalog.resolveInvocation(
                    root: root,
                    searchPaths: [pathCLI.directory.path],
                    defaultMacOSAppExecutable: app.executable.path)
            }
        }
    }

    @Test func `finds a Codex app installed in the user Applications directory`() throws {
        let userApp = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let pathCLI = try makeFakeCodex("#!/bin/sh\nexit 0\n")

        let resolved = try MacNodeCodexThreadCatalog.resolveInvocation(
            root: [:],
            searchPaths: [pathCLI.directory.path],
            defaultMacOSChatGPTAppExecutable: userApp.directory.appendingPathComponent("missing").path,
            defaultUserMacOSChatGPTAppExecutable: userApp.directory.appendingPathComponent("missing").path,
            defaultMacOSAppExecutable: userApp.directory.appendingPathComponent("missing").path,
            defaultUserMacOSAppExecutable: userApp.executable.path)

        #expect(resolved.executable == userApp.executable.path)
        #expect(resolved.arguments == ["app-server", "--listen", "stdio://"])
    }

    @Test func `finds a Codex Beta app when stable app bundles are absent`() throws {
        let betaApp = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let pathCLI = try makeFakeCodex("#!/bin/sh\nexit 0\n")

        let missing = betaApp.directory.appendingPathComponent("missing").path
        let resolved = try MacNodeCodexThreadCatalog.resolveInvocation(
            root: [:],
            searchPaths: [pathCLI.directory.path],
            defaultMacOSChatGPTAppExecutable: missing,
            defaultUserMacOSChatGPTAppExecutable: missing,
            defaultMacOSAppExecutable: missing,
            defaultUserMacOSAppExecutable: missing,
            defaultMacOSBetaAppExecutable: betaApp.executable.path,
            defaultUserMacOSBetaAppExecutable: missing)

        #expect(resolved.executable == betaApp.executable.path)
        #expect(resolved.arguments == ["app-server", "--listen", "stdio://"])
    }

    @Test func `finds ChatGPT app in the user Applications directory`() throws {
        let chatGPTApp = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let pathCLI = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let missing = chatGPTApp.directory.appendingPathComponent("missing").path

        let resolved = try MacNodeCodexThreadCatalog.resolveInvocation(
            root: [:],
            searchPaths: [pathCLI.directory.path],
            defaultMacOSChatGPTAppExecutable: missing,
            defaultUserMacOSChatGPTAppExecutable: chatGPTApp.executable.path,
            defaultMacOSAppExecutable: missing,
            defaultUserMacOSAppExecutable: missing,
            defaultMacOSBetaAppExecutable: missing,
            defaultUserMacOSBetaAppExecutable: missing)

        #expect(resolved.executable == chatGPTApp.executable.path)
    }

    @Test func `prefers ChatGPT app before legacy Codex app bundles`() throws {
        let chatGPTApp = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let codexApp = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let codexBetaApp = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        let missing = chatGPTApp.directory.appendingPathComponent("missing").path

        let resolved = try MacNodeCodexThreadCatalog.resolveInvocation(
            root: [:],
            searchPaths: [],
            defaultMacOSChatGPTAppExecutable: chatGPTApp.executable.path,
            defaultUserMacOSChatGPTAppExecutable: missing,
            defaultMacOSAppExecutable: codexApp.executable.path,
            defaultUserMacOSAppExecutable: missing,
            defaultMacOSBetaAppExecutable: codexBetaApp.executable.path,
            defaultUserMacOSBetaAppExecutable: missing)

        #expect(resolved.executable == chatGPTApp.executable.path)
    }

    @Test func `fake App Server receives handshake and bounded list request`() async throws {
        let fake = try makeAppServer(
            initializeResult: #"{"codexHome":"/Users/private/.codex","platformFamily":"unix","platformOs":"macos","userAgent":"fake"}"#,
            captureHandshake: true,
            body: #"""
            IFS= read -r list || exit 4
            printf '%s\n' "$list" >> "${0}.requests"
            printf '%s' '{"id":2,"result":{"data":[{"id":"thread-1","sessionId":"session-1",'
            printf '%s' '"name":"One","preview":"private transcript","cwd":"/work",'
            printf '%s' '"status":{"type":"notLoaded"},"source":{"custom":"chatgpt"},'
            printf '%s' '"path":"/private/rollout.jsonl","turns":[]},{"id":"thread-2",'
            printf '%s' '"name":"Two","preview":"One","cwd":"/other",'
            printf '%s\n' '"status":{"type":"notLoaded"}}],"nextCursor":null,"backwardsCursor":"back/+=="}}'
            sleep 1
            """#)

        let payload = try await MacNodeCodexThreadCatalog.list(
            paramsJSON: #"{"agentId":"gateway-owner","cursor":" cursor ","limit":25,"searchTerm":" oNe ","cwd":" /work "}"#,
            executable: fake.executable.path)
        let response = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        let sessions = try #require(response["sessions"] as? [[String: Any]])
        #expect(response["codexHome"] == nil)
        #expect(response["nextCursor"] == nil)
        #expect(response["backwardsCursor"] as? String == "back/+==")
        #expect(sessions.count == 1)
        #expect(sessions.first?["threadId"] as? String == "thread-1")
        #expect(sessions.first?["preview"] == nil)
        #expect(sessions.first?["path"] == nil)

        let captured = try String(contentsOf: fake.capture, encoding: .utf8)
            .split(whereSeparator: \.isNewline)
            .map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        #expect(captured.count == 3)
        #expect(captured[0]?["method"] as? String == "initialize")
        #expect(captured[1]?["method"] as? String == "initialized")
        #expect(captured[1]?["id"] == nil)
        #expect(captured[2]?["method"] as? String == "thread/list")
        let listParams = try #require(captured[2]?["params"] as? [String: Any])
        #expect(listParams["agentId"] == nil)
        #expect(listParams["cursor"] as? String == "cursor")
        #expect(listParams["limit"] as? Int == 25)
        #expect(listParams["archived"] as? Bool == false)
        #expect(listParams["searchTerm"] == nil)
        #expect(listParams["cwd"] as? String == "/work")
        #expect(listParams["sortKey"] as? String == "recency_at")
        #expect(listParams["sortDirection"] as? String == "desc")
        #expect((listParams["modelProviders"] as? [Any])?.isEmpty == true)
        #expect(listParams["sourceKinds"] == nil)
        #expect(listParams["useStateDbOnly"] as? Bool == false)
    }

    @Test @MainActor func `Mac node runtime keeps its user home across Gateway catalog owners`() async throws {
        let fake = try makeEmptyListServer(
            tracksLaunches: true,
            captureHandshake: true)
        var root = self.codexRoot(appServer: [
            "transport": "stdio",
            "homeScope": "user",
            "command": fake.executable.path,
        ])
        let nodeAgents: [String: Any] = [
            "ownership": "explicit",
            "entries": ["node-local": [String: Any]()],
        ]
        root["agents"] = nodeAgents
        let codexHome = fake.directory.appendingPathComponent("user-codex-home", isDirectory: true)
        try FileManager.default.createDirectory(at: codexHome, withIntermediateDirectories: true)

        try await TestIsolation.withEnvValues(["CODEX_HOME": codexHome.path]) {
            let client = MacNodeCodexThreadCatalogClient(
                idleTimeoutSeconds: 10,
                loadRoot: { root })
            let runtime = MacNodeRuntime(
                computerControlEnabled: { false },
                computerControlProvider: { .peekaboo },
                codexThreadCatalogEnabled: { true },
                codexThreadCatalogClient: client)
            // These are Gateway owners, deliberately absent from the node's roster.
            // Sidebar and continuation eligibility must keep the same native source.
            let requests = [
                #"{"agentId":"alpha","limit":50}"#,
                #"{"agentId":"beta","limit":100}"#,
                #"{"agentId":"gateway-only","limit":50}"#,
            ]
            var succeeded = true
            for (index, paramsJSON) in requests.enumerated() {
                let response = await runtime.handleInvoke(BridgeInvokeRequest(
                    id: "owner-\(index)",
                    command: MacNodeCodexThreadCatalogContract.listCommand,
                    paramsJSON: paramsJSON))
                #expect(response.ok, "\(response.error?.message ?? "missing catalog response")")
                succeeded = succeeded && response.ok
            }
            await runtime.shutdown()
            try #require(succeeded)

            #expect(try self.readTrimmed(
                URL(fileURLWithPath: fake.executable.path + ".processes")) == "1")
            #expect(try self.readTrimmed(
                URL(fileURLWithPath: fake.executable.path + ".codex-home")) == codexHome.path)
            let captured = try String(contentsOf: fake.capture, encoding: .utf8)
                .split(whereSeparator: \.isNewline)
                .map { try #require(
                    JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]) }
            #expect(captured.map { $0["method"] as? String } == [
                "initialize",
                "initialized",
                "thread/list",
                "thread/list",
                "thread/list",
            ])
            #expect(captured.compactMap { ($0["id"] as? NSNumber)?.intValue } == [1, 2, 3, 4])
            let listParams = try captured.dropFirst(2).map { request in
                try #require(request["params"] as? [String: Any])
            }
            #expect(listParams.compactMap { $0["limit"] as? Int } == [50, 100, 50])
            #expect(listParams.allSatisfy { $0["agentId"] == nil })
        }
    }

    @Test func `reads one paginated transcript turn page from App Server`() async throws {
        let fake = try makeAppServer(captureHandshake: true, body: #"""
        IFS= read -r list || exit 4
        printf '%s\n' "$list" >> "${0}.requests"
        printf '%s\n' '{"id":2,"result":{"data":[{"id":"thread-1","name":"Task","status":{"type":"notLoaded"}}],"nextCursor":null,"backwardsCursor":null}}'
        IFS= read -r turns || exit 5
        printf '%s\n' "$turns" >> "${0}.requests"
        printf '%s\n' '{"id":3,"result":{"data":[{"id":"turn-1","items":[{"id":"item-1","type":"agentMessage","text":"full answer"}]}],"nextCursor":"turns-2","backwardsCursor":null}}'
        sleep 1
        """#)

        let root = self.codexRoot(appServer: [
            "transport": "stdio",
            "homeScope": "user",
            "command": fake.executable.path,
        ])
        let client = MacNodeCodexThreadCatalogClient(loadRoot: { root })
        let runtime = MacNodeRuntime(
            computerControlEnabled: { false },
            computerControlProvider: { .peekaboo },
            codexThreadCatalogEnabled: { true },
            codexThreadCatalogClient: client)
        let result = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "gateway-transcript",
            command: MacNodeCodexThreadCatalogContract.turnsCommand,
            paramsJSON: #"{"agentId":"gateway-only","threadId":" thread-1 ","cursor":" turns-1 ","limit":25}"#))
        await runtime.shutdown()
        try #require(result.ok, "\(result.error?.message ?? "missing transcript response")")
        let payload = try #require(result.payloadJSON)
        let response = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        let firstTurn = try #require((response["data"] as? [[String: Any]])?.first)
        #expect((firstTurn["items"] as? [[String: Any]])?.first?["text"] as? String == "full answer")
        #expect(response["nextCursor"] as? String == "turns-2")

        let captured = try String(contentsOf: fake.capture, encoding: .utf8)
            .split(whereSeparator: \.isNewline)
            .map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        #expect(captured.count == 4)
        let initializeParams = try #require(captured[0]?["params"] as? [String: Any])
        let capabilities = try #require(initializeParams["capabilities"] as? [String: Any])
        #expect(capabilities["experimentalApi"] as? Bool == true)
        #expect(captured[2]?["method"] as? String == "thread/list")
        #expect(captured[3]?["method"] as? String == "thread/turns/list")
        #expect(captured.compactMap { ($0?["id"] as? NSNumber)?.intValue } == [1, 2, 3])
        let eligibilityParams = try #require(captured[2]?["params"] as? [String: Any])
        #expect(eligibilityParams["agentId"] == nil)
        let params = try #require(captured[3]?["params"] as? [String: Any])
        #expect(params["agentId"] == nil)
        #expect(params["threadId"] as? String == "thread-1")
        #expect(params["cursor"] as? String == "turns-1")
        #expect(params["limit"] as? Int == 25)
        #expect(params["sortDirection"] as? String == "desc")
        #expect(params["itemsView"] as? String == "full")
    }

    @Test func `title search fills one result page across bounded native pages`() async throws {
        let first = try listResponseJSON(
            id: 2,
            names: ["Target one", "Other one", "Other two"],
            nextCursor: "cursor-1")
        let second = try listResponseJSON(
            id: 3,
            names: ["Other three", "Other four"],
            nextCursor: "cursor-2")
        let third = try listResponseJSON(
            id: 4,
            names: ["Target two", "Target three"],
            nextCursor: "cursor-3")
        let fake = try makeAppServer(body: #"""
        count=0
        while IFS= read -r list; do
          count=$((count + 1))
          printf '%s\n' "$list" >> "${0}.requests"
          case "$count" in
          1) printf '%s\n' '\#(first)' ;;
          2) printf '%s\n' '\#(second)' ;;
          3) printf '%s\n' '\#(third)'; exit 0 ;;
          *) exit 9 ;;
          esac
        done
        """#)

        let payload = try await MacNodeCodexThreadCatalog.list(
            paramsJSON: #"{"limit":3,"searchTerm":"target"}"#,
            executable: fake.executable.path)
        let response = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        let sessions = try #require(response["sessions"] as? [[String: Any]])
        #expect(sessions.compactMap { $0["name"] as? String } == [
            "Target one",
            "Target two",
            "Target three",
        ])
        #expect(response["nextCursor"] as? String == "cursor-3")

        let requests = try String(contentsOf: fake.capture, encoding: .utf8)
            .split(whereSeparator: \.isNewline)
            .map { try #require(
                JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]) }
        let params = try requests.map { request in
            try #require(request["params"] as? [String: Any])
        }
        #expect(params.count == 3)
        #expect(params.compactMap { $0["limit"] as? Int } == [3, 2, 2])
        #expect(params[0]["cursor"] == nil)
        #expect(params[1]["cursor"] as? String == "cursor-1")
        #expect(params[2]["cursor"] as? String == "cursor-2")
        #expect(params.allSatisfy { $0["searchTerm"] == nil })
    }

    @Test func `title search scans at most four pages and returns the continuation cursor`() async throws {
        let names = (0..<40).map { "Other \($0)" }
        let responses = try (1...4).map { page in
            try self.listResponseJSON(
                id: page + 1,
                names: names,
                nextCursor: "cursor-\(page)")
        }
        let fake = try makeAppServer(body: #"""
        count=0
        while IFS= read -r list; do
          count=$((count + 1))
          printf '%s\n' "$list" >> "${0}.requests"
          case "$count" in
          1) printf '%s\n' '\#(responses[0])' ;;
          2) printf '%s\n' '\#(responses[1])' ;;
          3) printf '%s\n' '\#(responses[2])' ;;
          4) printf '%s\n' '\#(responses[3])'; exit 0 ;;
          *) exit 9 ;;
          esac
        done
        """#)

        let payload = try await MacNodeCodexThreadCatalog.list(
            paramsJSON: #"{"limit":40,"searchTerm":"target"}"#,
            executable: fake.executable.path)
        let response = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        #expect((response["sessions"] as? [Any])?.isEmpty == true)
        #expect(response["nextCursor"] as? String == "cursor-4")

        let requests = try String(contentsOf: fake.capture, encoding: .utf8)
            .split(whereSeparator: \.isNewline)
            .map { try #require(
                JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]) }
        #expect(requests.count == 4)
        #expect(requests.allSatisfy { request in
            let params = request["params"] as? [String: Any]
            return params?["limit"] as? Int == 40 && params?["searchTerm"] == nil
        })
    }

    @Test func `title search stops a native cursor cycle`() async throws {
        let first = try listResponseJSON(id: 2, names: ["Other one"], nextCursor: "same")
        let second = try listResponseJSON(id: 3, names: ["Other two"], nextCursor: "same")
        let fake = try makeAppServer(body: #"""
        count=0
        while IFS= read -r list; do
          count=$((count + 1))
          printf '%s\n' "$list" >> "${0}.requests"
          case "$count" in
          1) printf '%s\n' '\#(first)' ;;
          2) printf '%s\n' '\#(second)'; exit 0 ;;
          *) exit 9 ;;
          esac
        done
        """#)

        let payload = try await MacNodeCodexThreadCatalog.list(
            paramsJSON: #"{"limit":40,"searchTerm":"target"}"#,
            executable: fake.executable.path)
        let response = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        #expect(response["nextCursor"] == nil)
        let requests = try String(contentsOf: fake.capture, encoding: .utf8)
            .split(whereSeparator: \.isNewline)
        #expect(requests.count == 2)
    }
}

extension MacNodeCodexThreadCatalogTests {
    @Test func `restarts the lifecycle client when the resolved invocation changes`() async throws {
        let first = try makeEmptyListServer(
            tracksLaunches: true,
            blocksEOFExit: true)
        let second = try makeEmptyListServer(tracksLaunches: true)
        let client = CodexAppServerThreadClient(idleTimeoutSeconds: 10)

        _ = try await self.requestEmptyList(client: client, executable: first.executable)
        let replacement = Task {
            try await self.requestEmptyList(client: client, executable: second.executable)
        }
        let exitGate = try await self.openFIFOForWriting(first.exitGate)

        #expect(FileManager.default.fileExists(atPath: first.eof.path))
        #expect(!FileManager.default.fileExists(atPath: second.executable.path + ".processes"))
        try exitGate.write(contentsOf: Data("exit\n".utf8))
        try exitGate.close()
        _ = try await replacement.value

        #expect(try self.readTrimmed(
            URL(fileURLWithPath: first.executable.path + ".processes")) == "1")
        #expect(try self.readTrimmed(
            URL(fileURLWithPath: second.executable.path + ".processes")) == "1")
        #expect(FileManager.default.fileExists(atPath: first.exited.path))
        await client.shutdown()
    }

    @Test func `restarts the lifecycle client after the child exits`() async throws {
        let fake = try makeEmptyListServer(
            tracksLaunches: true,
            exitsAfterResponse: true)
        let client = CodexAppServerThreadClient(idleTimeoutSeconds: 10)

        _ = try await self.requestEmptyList(client: client, executable: fake.executable)
        try await Task.sleep(for: .milliseconds(50))
        _ = try await self.requestEmptyList(client: client, executable: fake.executable)

        #expect(try self.readTrimmed(
            URL(fileURLWithPath: fake.executable.path + ".processes")) == "2")
        await client.shutdown()
    }

    @Test func `explicit shutdown reaps a graceful App Server and its descendants`() async throws {
        let fake = try makeAppServer(
            preamble: #"""
            printf '%s\n' "$$" > "${0}.leader.pid"
            trap 'touch "${0}.term"; exit 0' TERM
            """#,
            body: #"""
            /bin/sh -c 'trap "" HUP TERM; printf "%s\n" "$$" > "$1"; while :; do /bin/sleep 1; done' \
              descendant "${0}.descendant.pid" </dev/null >/dev/null 2>&1 &
            while [ ! -s "${0}.descendant.pid" ]; do /bin/sleep 0.01; done
            while IFS= read -r request; do
              id=$(printf '%s\n' "$request" | /usr/bin/sed -E 's/.*"id":([0-9]+).*/\1/')
              printf '{"id":%s,"result":{"data":[]}}\n' "$id"
            done
            touch "${0}.eof"
            trap 'touch "${0}.term"' TERM
            /bin/sleep 0.35
            touch "${0}.graceful-exit"
            """#)
        let leaderPIDFile = URL(fileURLWithPath: fake.executable.path + ".leader.pid")
        let descendantPIDFile = URL(fileURLWithPath: fake.executable.path + ".descendant.pid")
        defer { TestProcessSupport.killLeakedProcesses(in: [descendantPIDFile, leaderPIDFile]) }
        let client = CodexAppServerThreadClient(idleTimeoutSeconds: 10)

        _ = try await self.requestEmptyList(client: client, executable: fake.executable)
        let leaderPID = try await TestProcessSupport.waitForPID(in: leaderPIDFile)
        let descendantPID = try await TestProcessSupport.waitForPID(in: descendantPIDFile)

        await client.shutdown()

        #expect(FileManager.default.fileExists(atPath: fake.executable.path + ".eof"))
        #expect(FileManager.default.fileExists(atPath: fake.executable.path + ".graceful-exit"))
        #expect(!FileManager.default.fileExists(atPath: fake.executable.path + ".term"))
        #expect(TestProcessSupport.processIsGone(leaderPID))
        #expect(TestProcessSupport.processIsGone(descendantPID))
    }

    @Test func `shuts down an idle lifecycle client`() async throws {
        let fake = try makeEmptyListServer(blocksEOFExit: true)
        let client = CodexAppServerThreadClient(idleTimeoutSeconds: 0.05)

        _ = try await self.requestEmptyList(client: client, executable: fake.executable)
        let exitGate = try await self.openFIFOForWriting(fake.exitGate)
        let shutdown = Task { await client.shutdown() }

        #expect(FileManager.default.fileExists(atPath: fake.eof.path))
        try exitGate.write(contentsOf: Data("exit\n".utf8))
        try exitGate.close()
        await shutdown.value
        #expect(FileManager.default.fileExists(atPath: fake.exited.path))
    }

    @Test func `explicit shutdown waits for EOF driven child exit`() async throws {
        let fake = try makeEmptyListServer(blocksEOFExit: true)
        let client = CodexAppServerThreadClient(idleTimeoutSeconds: 10)
        let shutdownStarted = AsyncTestGate()
        let shutdownReturned = LockIsolated(false)

        _ = try await self.requestEmptyList(
            client: client,
            executable: fake.executable)
        let shutdown = Task.detached(priority: .high) {
            shutdownStarted.open()
            await client.shutdown()
            shutdownReturned.withValue { $0 = true }
        }
        await shutdownStarted.wait()
        let exitGate = try await self.openFIFOForWriting(fake.exitGate)

        #expect(FileManager.default.fileExists(atPath: fake.eof.path))
        #expect(!shutdownReturned.withValue { $0 })
        try exitGate.write(contentsOf: Data("exit\n".utf8))
        try exitGate.close()
        await shutdown.value
        #expect(shutdownReturned.withValue { $0 })
        #expect(FileManager.default.fileExists(atPath: fake.exited.path))
    }

    @Test func `explicit shutdown force kills an unresponsive child`() async throws {
        let fake = try makeAppServer(
            preamble: #"""
            trap '' TERM
            mkfifo "${0}.descendant-gate"
            (
              trap '' TERM
              IFS= read -r _ < "${0}.descendant-gate"
            ) &
            printf '%s\n' "$$" > "${0}.pid"
            printf '%s\n' "$!" > "${0}.descendant-pid"
            """#,
            body: #"""
            IFS= read -r request || exit 4
            id=$(printf '%s\n' "$request" | /usr/bin/sed -E 's/.*"id":([0-9]+).*/\1/')
            printf '{"id":%s,"result":{"data":[]}}\n' "$id"
            wait
            """#)
        let client = CodexAppServerThreadClient(idleTimeoutSeconds: 10)

        _ = try await self.requestEmptyList(
            client: client,
            executable: fake.executable)
        let pid = try #require(Int32(self.readTrimmed(
            URL(fileURLWithPath: fake.executable.path + ".pid"))))
        let descendantPID = try #require(Int32(self.readTrimmed(
            URL(fileURLWithPath: fake.executable.path + ".descendant-pid"))))
        defer { _ = Darwin.kill(descendantPID, SIGKILL) }
        let shutdown = Task { await client.shutdown() }
        let watchdog = Task {
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            Issue.record("timed out waiting for Codex child shutdown")
            shutdown.cancel()
            _ = Darwin.kill(pid, SIGKILL)
            _ = Darwin.kill(descendantPID, SIGKILL)
        }
        defer {
            watchdog.cancel()
            shutdown.cancel()
        }
        await shutdown.value
        watchdog.cancel()

        errno = 0
        #expect(Darwin.kill(pid, 0) == -1)
        #expect(errno == ESRCH)
    }

    @Test @MainActor func `coordinator terminal stop awaits its runtime owned Codex child`() async throws {
        let fake = try makeEmptyListServer(recordsEOFExit: true)
        let root = self.codexRoot(appServer: [
            "transport": "stdio",
            "homeScope": "user",
            "command": fake.executable.path,
        ])
        let client = MacNodeCodexThreadCatalogClient(
            idleTimeoutSeconds: 10,
            loadRoot: { root })
        let runtime = MacNodeRuntime(
            codexThreadCatalogEnabled: { true },
            codexThreadCatalogClient: client)
        let coordinator = MacNodeModeCoordinator(
            session: GatewayNodeSession(),
            runtime: runtime)

        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "list",
            command: MacNodeCodexThreadCatalogContract.listCommand))
        #expect(response.ok)

        await coordinator.stopAndWait()

        #expect(FileManager.default.fileExists(atPath: fake.eof.path))
        #expect(FileManager.default.fileExists(atPath: fake.exited.path))
    }

    @Test func `oversized idle output resets the lifecycle client`() async throws {
        let fake = try makeAppServer(
            preamble: #"""
            count=0
            [ ! -f "${0}.processes" ] || count=$(cat "${0}.processes")
            count=$((count + 1))
            printf '%s\n' "$count" > "${0}.processes"
            printf '%s\n' "$$" > "${0}.pid"
            [ "$count" != 1 ] || mkfifo "${0}.idle-output-gate"
            """#,
            body: #"""
            while IFS= read -r request; do
              id=$(printf '%s\n' "$request" | /usr/bin/sed -E 's/.*"id":([0-9]+).*/\1/')
              printf '{"id":%s,"result":{"data":[]}}\n' "$id"
              if [ "$count" = 1 ]; then
                IFS= read -r _ < "${0}.idle-output-gate"
                printf '%512s\n' x
              fi
            done
            """#)
        let client = CodexAppServerThreadClient(
            idleTimeoutSeconds: 10,
            idleReadLimit: 128)

        _ = try await self.requestEmptyList(
            client: client,
            executable: fake.executable,
            maxLineBytes: 128)
        let outputGate = try await self.openFIFOForWriting(
            URL(fileURLWithPath: fake.executable.path + ".idle-output-gate"))
        let pid = try await TestProcessSupport.waitForPID(
            in: URL(fileURLWithPath: fake.executable.path + ".pid"))
        try outputGate.write(contentsOf: Data("emit\n".utf8))
        try outputGate.close()
        #expect(await TestProcessSupport.waitUntilGone(pid))
        _ = try await self.requestEmptyList(
            client: client,
            executable: fake.executable,
            maxLineBytes: 128)

        #expect(try self.readTrimmed(
            URL(fileURLWithPath: fake.executable.path + ".processes")) == "2")
        await client.shutdown()
    }

    @Test func `timeout restarts the client without dropping the next request`() async throws {
        let fake = try makeBlockedRequestServer(warmup: true)
        let client = CodexAppServerThreadClient(idleTimeoutSeconds: 10)
        // Complete the real handshake before exercising an active or queued deadline.
        _ = try await self.requestEmptyList(client: client, executable: fake.executable)

        let first = Task {
            try await self.requestEmptyList(
                client: client,
                executable: fake.executable,
                timeoutSeconds: 0.5)
        }
        #expect(await self.waitForFile(
            URL(fileURLWithPath: fake.executable.path + ".request-started")))
        let second = Task {
            try await self.requestEmptyList(client: client, executable: fake.executable)
        }

        await #expect(throws: MacNodeCodexThreadCatalog.CatalogError.timedOut) {
            try await first.value
        }
        let result = try await second.value
        #expect(try (JSONSerialization.jsonObject(with: result) as? [String: Any])?["data"] != nil)
        #expect(try self.readTrimmed(
            URL(fileURLWithPath: fake.executable.path + ".processes")) == "2")
        await client.shutdown()
    }

    @Test func `queued request consumes its wall-clock deadline`() async throws {
        let fake = try makeBlockedRequestServer(warmup: true)
        let client = CodexAppServerThreadClient(idleTimeoutSeconds: 10)
        // Complete the real handshake before exercising an active or queued deadline.
        _ = try await self.requestEmptyList(client: client, executable: fake.executable)

        let first = Task {
            try await self.requestEmptyList(
                client: client,
                executable: fake.executable,
                timeoutSeconds: 0.5)
        }
        #expect(await self.waitForFile(
            URL(fileURLWithPath: fake.executable.path + ".request-started")))
        let second = Task {
            try await self.requestEmptyList(
                client: client,
                executable: fake.executable,
                timeoutSeconds: 0.05)
        }

        await #expect(throws: MacNodeCodexThreadCatalog.CatalogError.timedOut) {
            try await second.value
        }
        await #expect(throws: MacNodeCodexThreadCatalog.CatalogError.timedOut) {
            try await first.value
        }
        #expect(!FileManager.default.fileExists(atPath: fake.executable.path + ".unexpected-request"))
        #expect(try self.readTrimmed(
            URL(fileURLWithPath: fake.executable.path + ".processes")) == "1")
        await client.shutdown()
    }

    @Test func `cancellation restarts the client without dropping the next request`() async throws {
        let fake = try makeBlockedRequestServer()
        let client = CodexAppServerThreadClient(idleTimeoutSeconds: 10)
        let first = Task {
            try await self.requestEmptyList(
                client: client,
                executable: fake.executable,
                timeoutSeconds: 5)
        }
        #expect(await self.waitForFile(
            URL(fileURLWithPath: fake.executable.path + ".request-started")))
        let second = Task {
            try await self.requestEmptyList(client: client, executable: fake.executable)
        }

        first.cancel()
        await #expect(throws: CancellationError.self) {
            try await first.value
        }
        let result = try await second.value
        #expect(try (JSONSerialization.jsonObject(with: result) as? [String: Any])?["data"] != nil)
        #expect(try self.readTrimmed(
            URL(fileURLWithPath: fake.executable.path + ".processes")) == "2")
        await client.shutdown()
    }

    @Test func `drains App Server frames larger than one pipe read while server stays open`() async throws {
        let threads: [[String: Any]] = (0..<50).map { index in
            [
                "id": "thread-\(index)",
                "name": "Large catalog \(index)",
                "cwd": "/workspace/\(String(repeating: "x", count: 2000))",
                "status": ["type": "notLoaded"],
            ]
        }
        let responseData = try JSONSerialization.data(withJSONObject: [
            "id": 2,
            "result": ["data": threads],
        ])
        let response = try #require(String(data: responseData, encoding: .utf8))
        #expect(response.utf8.count > 64 * 1024)
        let fake = try makeAppServer(body: #"""
        IFS= read -r list || exit 4
        printf '%s\n' '\#(response)'
        # Keep stdout open until the client closes stdin; completion must come
        # from draining the full JSONL frame, never from observing process EOF.
        IFS= read -r keep_open || exit 0
        """#)
        defer { withExtendedLifetime(fake) {} }

        let payload = try await MacNodeCodexThreadCatalog.list(
            paramsJSON: #"{"limit":50}"#,
            executable: fake.executable.path,
            timeoutSeconds: 10)
        let decoded = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        #expect((decoded["sessions"] as? [Any])?.count == 50)
    }

    @Test func `drains a large final frame before handling process exit`() async throws {
        let threads: [[String: Any]] = (0..<100).map { index in
            [
                "id": "thread-\(index)",
                "name": "Final catalog \(index)",
                "cwd": "/workspace/\(String(repeating: "x", count: 3500))",
                "status": ["type": "notLoaded"],
            ]
        }
        let responseData = try JSONSerialization.data(withJSONObject: [
            "id": 2,
            "result": ["data": threads],
        ])
        let response = try #require(String(data: responseData, encoding: .utf8))
        #expect(response.utf8.count > 256 * 1024)
        let fake = try makeAppServer(body: #"""
        IFS= read -r list || exit 4
        printf '%s\n' '\#(response)'
        """#)
        defer { withExtendedLifetime(fake) {} }

        let payload = try await MacNodeCodexThreadCatalog.list(
            paramsJSON: #"{"limit":100}"#,
            executable: fake.executable.path,
            timeoutSeconds: 10)
        let decoded = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        #expect((decoded["sessions"] as? [Any])?.count == 100)
    }

    @Test func `accepts coalesced JSONL frames within the per-frame limit`() async throws {
        let fake = try makeAppServer(body: #"""
        IFS= read -r list || exit 4
        printf '%s\n%s\n' \
          '{"method":"thread/started","params":{"padding":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}' \
          '{"id":2,"result":{"data":[]}}'
        sleep 1
        """#)
        defer { withExtendedLifetime(fake) {} }
        let client = CodexAppServerThreadClient(idleTimeoutSeconds: 10)

        let result = try await self.requestEmptyList(
            client: client,
            executable: fake.executable,
            maxLineBytes: 128)

        #expect(try (JSONSerialization.jsonObject(with: result) as? [String: Any])?["data"] != nil)
        await client.shutdown()
    }

    @Test func `uses the active request frame limit after advancing the queue`() async throws {
        let fake = try makeAppServer(preamble: #"mkfifo "${0}.response-gate""#, body: #"""
        IFS= read -r warmup || exit 3
        warmup_id=$(printf '%s\n' "$warmup" | /usr/bin/sed -E 's/.*"id":([0-9]+).*/\1/')
        printf '{"id":%s,"result":{"data":[]}}\n' "$warmup_id"
        IFS= read -r first || exit 4
        first_id=$(printf '%s\n' "$first" | /usr/bin/sed -E 's/.*"id":([0-9]+).*/\1/')
        IFS= read -r _ < "${0}.response-gate"
        printf '{"id":%s,"result":{"data":[]}}\n' "$first_id"
        IFS= read -r second || exit 5
        second_id=$(printf '%s\n' "$second" | /usr/bin/sed -E 's/.*"id":([0-9]+).*/\1/')
        padding=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
        printf '{"id":%s,"result":{"data":[],"padding":"%s"}}\n' "$second_id" "$padding"
        IFS= read -r _ || exit 0
        """#)
        defer { withExtendedLifetime(fake) {} }
        let client = CodexAppServerThreadClient(idleTimeoutSeconds: 10)
        do {
            _ = try await self.requestEmptyList(client: client, executable: fake.executable)

            let readiness = Task {
                try await self.openFIFOForWriting(
                    URL(fileURLWithPath: fake.executable.path + ".response-gate"))
            }
            let first = Task {
                defer { readiness.cancel() }
                return try await self.requestEmptyList(
                    client: client,
                    executable: fake.executable,
                    maxLineBytes: 1024)
            }
            defer {
                readiness.cancel()
                first.cancel()
            }
            do {
                // Acquiring the writer witnesses the first request reaching the fake's
                // reader, without a separate deadline starting before queue admission.
                let responseGate: FileHandle
                do {
                    responseGate = try await readiness.value
                } catch is CancellationError {
                    _ = try await first.value
                    // A response before FIFO readiness is a fixture failure too.
                    throw CancellationError()
                }
                defer { try? responseGate.close() }
                let second = Task {
                    try await self.requestEmptyList(
                        client: client,
                        executable: fake.executable,
                        maxLineBytes: 64)
                }
                defer { second.cancel() }
                do {
                    try responseGate.write(contentsOf: Data("respond\n".utf8))
                    try responseGate.close()
                    _ = try await first.value
                    await #expect(throws: MacNodeCodexThreadCatalog.CatalogError.responseTooLarge) {
                        try await second.value
                    }
                } catch {
                    second.cancel()
                    _ = await second.result
                    throw error
                }
            } catch {
                first.cancel()
                _ = await first.result
                throw error
            }
        } catch {
            await client.shutdown()
            throw error
        }
        await client.shutdown()
    }

    @Test func `default deadline allows cold large catalog scans`() {
        #expect(MacNodeCodexThreadCatalog.defaultTimeoutSeconds == 60)
    }

    @Test func `rejects unknown and out of range params before launch`() async {
        let cases = [
            (#"{"extra":true}"#, "unknown Codex session catalog parameter: extra"),
            (#"{"limit":0}"#, "limit must be an integer from 1 to 100"),
            (#"{"limit":101}"#, "limit must be an integer from 1 to 100"),
            (#"{"limit":1.5}"#, "limit must be an integer from 1 to 100"),
            (#"{"archived":true}"#, "unknown Codex session catalog parameter: archived"),
        ]
        for (paramsJSON, expected) in cases {
            do {
                _ = try await MacNodeCodexThreadCatalog.list(
                    paramsJSON: paramsJSON,
                    executable: "/path/that/must/not/launch")
                Issue.record("expected invalid params for \(paramsJSON)")
            } catch let error as MacNodeCodexThreadCatalog.CatalogError {
                #expect(error.localizedDescription.contains(expected))
            } catch {
                Issue.record("unexpected error: \(error)")
            }
        }
    }

    @Test func `rejects malformed Gateway agent ids before config access`() async {
        let client = MacNodeCodexThreadCatalogClient(loadRoot: {
            Issue.record("invalid agentId must fail before loading native config")
            return [:]
        })
        let runtime = MacNodeRuntime(
            computerControlEnabled: { false },
            computerControlProvider: { .peekaboo },
            codexThreadCatalogEnabled: { true },
            codexThreadCatalogClient: client)
        let malformed = ["null", "true", "42", "{}", "[]"].map {
            ($0, "agentId must be a string")
        } + [
            (#""\#(String(repeating: "x", count: 257))""#, "agentId must be at most 256 characters"),
            (#""\#(String(repeating: "😀", count: 129))""#, "agentId must be at most 256 characters"),
        ]
        for (agentIdJSON, message) in malformed {
            let requests = [
                (MacNodeCodexThreadCatalogContract.listCommand, #"{"agentId":\#(agentIdJSON),"limit":25}"#),
                (
                    MacNodeCodexThreadCatalogContract.turnsCommand,
                    #"{"agentId":\#(agentIdJSON),"threadId":"thread-1","limit":25}"#),
            ]
            for (command, paramsJSON) in requests {
                let result = await runtime.handleInvoke(BridgeInvokeRequest(
                    id: "invalid-owner",
                    command: command,
                    paramsJSON: paramsJSON))
                #expect(!result.ok)
                #expect(result.error?.code == .invalidRequest)
                #expect(result.error?.message == "INVALID_REQUEST: \(message)")
            }
        }
        await runtime.shutdown()
    }

    @Test func `bounds fake App Server output and wait time`() async throws {
        let oversized = try makeFakeCodex(#"""
        #!/bin/sh
        IFS= read -r initialize || exit 2
        printf '%512s\n' x
        sleep 1
        """#)
        defer { withExtendedLifetime(oversized) {} }
        do {
            _ = try await MacNodeCodexThreadCatalog.list(
                paramsJSON: nil,
                executable: oversized.executable.path,
                maxLineBytes: 128)
            Issue.record("expected oversized App Server response to fail")
        } catch let error as MacNodeCodexThreadCatalog.CatalogError {
            #expect(error == .responseTooLarge)
        }

        let stalled = try makeFakeCodex(#"""
        #!/bin/sh
        IFS= read -r initialize || exit 2
        sleep 1
        """#)
        defer { withExtendedLifetime(stalled) {} }
        do {
            _ = try await MacNodeCodexThreadCatalog.list(
                paramsJSON: nil,
                executable: stalled.executable.path,
                timeoutSeconds: 0.05)
            Issue.record("expected stalled App Server response to time out")
        } catch let error as MacNodeCodexThreadCatalog.CatalogError {
            #expect(error == .timedOut)
        }
    }

    @Test func `App Server error details stay on node`() async throws {
        let fake = try makeAppServer(
            initializeResult: #"{"codexHome":"/private"}"#,
            body: #"""
            IFS= read -r list || exit 4
            printf '%s\n' '{"id":2,"error":{"code":-32000,"message":"private /Users/secret/path"}}'
            sleep 1
            """#)
        defer { withExtendedLifetime(fake) {} }

        do {
            _ = try await MacNodeCodexThreadCatalog.list(
                paramsJSON: nil,
                executable: fake.executable.path)
            Issue.record("expected fake App Server error")
        } catch let error as MacNodeCodexThreadCatalog.CatalogError {
            #expect(error == .appServerUnavailable)
            #expect(error.localizedDescription == "UNAVAILABLE: Codex app-server request failed")
            #expect(!error.localizedDescription.contains("/Users/secret"))
        }
    }
}
