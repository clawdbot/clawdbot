import Darwin
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct MacNodeCodexThreadCatalogTests {
    private struct FakeCodex {
        var directory: URL
        var executable: URL
        var capture: URL
    }

    private func makeFakeCodex(_ script: String) throws -> FakeCodex {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-fake-codex-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let executable = directory.appendingPathComponent("codex")
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        return FakeCodex(
            directory: directory,
            executable: executable,
            capture: URL(fileURLWithPath: executable.path + ".requests"))
    }

    private func listResponseJSON(names: [String], nextCursor: String?) throws -> String {
        let encodedNextCursor: Any = if let nextCursor {
            nextCursor
        } else {
            NSNull()
        }
        let threads: [[String: Any]] = names.enumerated().map { index, name in
            [
                "id": "thread-\(name)-\(index)",
                "name": name,
                "status": ["type": "notLoaded"],
            ]
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "id": 2,
            "result": [
                "data": threads,
                "nextCursor": encodedNextCursor,
                "backwardsCursor": NSNull(),
            ],
        ])
        return try #require(String(data: data, encoding: .utf8))
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
        let fake = try makeFakeCodex(#"""
        #!/bin/sh
        [ "$1" = "custom-app-server" ] || exit 10
        [ "$2" = "--stdio" ] || exit 11
        [ -z "${OPENCLAW_CODEX_CATALOG_CLEAR_ENV_SENTINEL+x}" ] || exit 12
        IFS= read -r initialize || exit 2
        printf '%s\n' '{"id":1,"result":{}}'
        IFS= read -r initialized || exit 3
        IFS= read -r list || exit 4
        printf '%s\n' '{"id":2,"result":{"data":[],"nextCursor":null,"backwardsCursor":null}}'
        sleep 1
        """#)
        defer { try? FileManager.default.removeItem(at: fake.directory) }
        let root: [String: Any] = [
            "plugins": [
                "entries": [
                    " codex ": [
                        "enabled": true,
                        "config": [
                            "supervision": ["enabled": true],
                            "appServer": [
                                "transport": "stdio",
                                "homeScope": "user",
                                "command": fake.executable.path,
                                "args": #"custom-app-server "--stdio" workspace\ path "C:\\Codex" 'literal\slash' tail\"#,
                                "clearEnv": [" \(clearEnvSentinel) ", ""],
                            ],
                        ],
                    ],
                ],
            ],
        ]

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
        defer {
            try? FileManager.default.removeItem(at: fake.directory)
            try? FileManager.default.removeItem(at: chatGPTApp.directory)
        }
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
        defer {
            try? FileManager.default.removeItem(at: configured.directory)
            try? FileManager.default.removeItem(at: chatGPTApp.directory)
        }
        let root: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "config": [
                            "appServer": ["command": configured.executable.path],
                        ],
                    ],
                ],
            ],
        ]

        let resolved = try MacNodeCodexThreadCatalog.resolveInvocation(
            root: root,
            searchPaths: [],
            defaultMacOSChatGPTAppExecutable: chatGPTApp.executable.path)

        #expect(resolved.executable == configured.executable.path)
    }

    @Test func `blank configured command falls back to the environment command`() throws {
        let fallback = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        defer { try? FileManager.default.removeItem(at: fallback.directory) }
        let root: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "config": [
                            "appServer": ["command": "  \n "],
                        ],
                    ],
                ],
            ],
        ]

        let resolved = try MacNodeCodexThreadCatalog.resolveInvocation(
            root: root,
            environment: ["OPENCLAW_CODEX_APP_SERVER_BIN": fallback.executable.path],
            searchPaths: [])

        #expect(resolved.executable == fallback.executable.path)
    }

    @Test func `complete official plugin config remains eligible for the catalog`() throws {
        let app = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        defer { try? FileManager.default.removeItem(at: app.directory) }
        let root: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": [
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
                        ],
                    ],
                ],
            ],
        ]

        #expect(MacNodeCodexThreadCatalog.shouldAdvertise(root: root))
        let invocation = try MacNodeCodexThreadCatalog.resolveInvocation(root: root, searchPaths: [])
        #expect(invocation.executable == app.executable.path)
        #expect(invocation.clearEnv == ["OPENAI_API_KEY"])
    }

    @Test func `malformed or unknown official plugin config fails closed`() throws {
        let app = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        defer { try? FileManager.default.removeItem(at: app.directory) }
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
            let root: [String: Any] = [
                "plugins": [
                    "entries": [
                        "codex": [
                            "enabled": true,
                            "config": config,
                        ],
                    ],
                ],
            ]

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
        let fake = try makeFakeCodex(#"""
        #!/bin/sh
        IFS= read -r initialize || exit 2
        printf '%s\n' '{"id":1,"result":{}}'
        IFS= read -r initialized || exit 3
        IFS= read -r list || exit 4
        printf '%s\n' '{"id":2,"result":{"data":[]}}'
        sleep 1
        """#)
        defer { try? FileManager.default.removeItem(at: fake.directory) }
        let enabled: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": [
                            "supervision": ["enabled": true],
                            "appServer": [
                                "transport": "stdio",
                                "homeScope": "user",
                                "command": fake.executable.path,
                                "args": ["app-server", "--listen", "stdio://"],
                            ],
                        ],
                    ],
                ],
            ],
        ]
        let revoked: [String: Any] = [
            "plugins": [
                "deny": ["codex"],
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]
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
        let root: [String: Any] = [
            "plugins": [
                "allow": ["discord"],
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]

        #expect(!MacNodeCodexThreadCatalog.shouldAdvertise(root: root))
    }

    @Test func `rejects agent home scope instead of exposing the user Codex home`() throws {
        let app = try makeFakeCodex("#!/bin/sh\nexit 0\n")
        defer { try? FileManager.default.removeItem(at: app.directory) }
        let root: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": [
                            "supervision": ["enabled": true],
                            "appServer": [
                                "transport": "stdio",
                                "homeScope": "agent",
                            ],
                        ],
                    ],
                ],
            ],
        ]

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
        defer {
            try? FileManager.default.removeItem(at: app.directory)
            try? FileManager.default.removeItem(at: pathCLI.directory)
        }

        for transport in ["websocket", "unix"] {
            let root: [String: Any] = [
                "plugins": [
                    "entries": [
                        "codex": [
                            "enabled": true,
                            "config": [
                                "supervision": ["enabled": true],
                                "appServer": [
                                    "transport": transport,
                                    "command": "/must/not/win",
                                    "args": ["must-not-win"],
                                ],
                            ],
                        ],
                    ],
                ],
            ]

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
        defer {
            try? FileManager.default.removeItem(at: userApp.directory)
            try? FileManager.default.removeItem(at: pathCLI.directory)
        }

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
        defer {
            try? FileManager.default.removeItem(at: betaApp.directory)
            try? FileManager.default.removeItem(at: pathCLI.directory)
        }

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
        defer {
            try? FileManager.default.removeItem(at: chatGPTApp.directory)
            try? FileManager.default.removeItem(at: pathCLI.directory)
        }
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
        defer {
            try? FileManager.default.removeItem(at: chatGPTApp.directory)
            try? FileManager.default.removeItem(at: codexApp.directory)
            try? FileManager.default.removeItem(at: codexBetaApp.directory)
        }
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
        let fake = try makeFakeCodex(#"""
        #!/bin/sh
        capture="${0}.requests"
        IFS= read -r initialize || exit 2
        printf '%s\n' "$initialize" > "$capture"
        printf '%s' '{"id":1,"result":{"codexHome":"/Users/private/.codex",'
        printf '%s\n' '"platformFamily":"unix","platformOs":"macos","userAgent":"fake"}}'
        IFS= read -r initialized || exit 3
        printf '%s\n' "$initialized" >> "$capture"
        IFS= read -r list || exit 4
        printf '%s\n' "$list" >> "$capture"
        printf '%s' '{"id":2,"result":{"data":[{"id":"thread-1","sessionId":"session-1",'
        printf '%s' '"name":"One","preview":"private transcript","cwd":"/work",'
        printf '%s' '"status":{"type":"notLoaded"},"source":{"custom":"chatgpt"},'
        printf '%s' '"path":"/private/rollout.jsonl","turns":[]},{"id":"thread-2",'
        printf '%s' '"name":"Two","preview":"One","cwd":"/other",'
        printf '%s\n' '"status":{"type":"notLoaded"}}],"nextCursor":null,"backwardsCursor":"back/+=="}}'
        sleep 1
        """#)
        defer { try? FileManager.default.removeItem(at: fake.directory) }

        let payload = try await MacNodeCodexThreadCatalog.list(
            paramsJSON: #"{"cursor":" cursor ","limit":25,"searchTerm":" oNe ","cwd":" /work "}"#,
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

    @Test func `title search fills one result page across bounded native pages`() async throws {
        let first = try listResponseJSON(
            names: ["Target one", "Other one", "Other two"],
            nextCursor: "cursor-1")
        let second = try listResponseJSON(
            names: ["Other three", "Other four"],
            nextCursor: "cursor-2")
        let third = try listResponseJSON(
            names: ["Target two", "Target three"],
            nextCursor: "cursor-3")
        let fake = try makeFakeCodex(#"""
        #!/bin/sh
        counter="${0}.counter"
        count=0
        [ ! -f "$counter" ] || count=$(cat "$counter")
        count=$((count + 1))
        printf '%s\n' "$count" > "$counter"
        IFS= read -r initialize || exit 2
        printf '%s\n' '{"id":1,"result":{}}'
        IFS= read -r initialized || exit 3
        IFS= read -r list || exit 4
        printf '%s\n' "$list" >> "${0}.requests"
        case "$count" in
          1) printf '%s\n' '\#(first)' ;;
          2) printf '%s\n' '\#(second)' ;;
          3) printf '%s\n' '\#(third)' ;;
          *) exit 9 ;;
        esac
        """#)
        defer { try? FileManager.default.removeItem(at: fake.directory) }

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
            try self.listResponseJSON(names: names, nextCursor: "cursor-\(page)")
        }
        let fake = try makeFakeCodex(#"""
        #!/bin/sh
        counter="${0}.counter"
        count=0
        [ ! -f "$counter" ] || count=$(cat "$counter")
        count=$((count + 1))
        printf '%s\n' "$count" > "$counter"
        IFS= read -r initialize || exit 2
        printf '%s\n' '{"id":1,"result":{}}'
        IFS= read -r initialized || exit 3
        IFS= read -r list || exit 4
        printf '%s\n' "$list" >> "${0}.requests"
        case "$count" in
          1) printf '%s\n' '\#(responses[0])' ;;
          2) printf '%s\n' '\#(responses[1])' ;;
          3) printf '%s\n' '\#(responses[2])' ;;
          4) printf '%s\n' '\#(responses[3])' ;;
          *) exit 9 ;;
        esac
        """#)
        defer { try? FileManager.default.removeItem(at: fake.directory) }

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
        let first = try listResponseJSON(names: ["Other one"], nextCursor: "same")
        let second = try listResponseJSON(names: ["Other two"], nextCursor: "same")
        let fake = try makeFakeCodex(#"""
        #!/bin/sh
        counter="${0}.counter"
        count=0
        [ ! -f "$counter" ] || count=$(cat "$counter")
        count=$((count + 1))
        printf '%s\n' "$count" > "$counter"
        IFS= read -r initialize || exit 2
        printf '%s\n' '{"id":1,"result":{}}'
        IFS= read -r initialized || exit 3
        IFS= read -r list || exit 4
        printf '%s\n' "$list" >> "${0}.requests"
        case "$count" in
          1) printf '%s\n' '\#(first)' ;;
          2) printf '%s\n' '\#(second)' ;;
          *) exit 9 ;;
        esac
        """#)
        defer { try? FileManager.default.removeItem(at: fake.directory) }

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
        let fake = try makeFakeCodex("""
        #!/bin/sh
        IFS= read -r initialize || exit 2
        printf '%s\n' '{"id":1,"result":{}}'
        IFS= read -r initialized || exit 3
        IFS= read -r list || exit 4
        printf '%s\n' '\(response)'
        # Keep stdout open until the client closes stdin; completion must come
        # from draining the full JSONL frame, never from observing process EOF.
        IFS= read -r keep_open || exit 0
        """)
        defer { try? FileManager.default.removeItem(at: fake.directory) }

        let payload = try await MacNodeCodexThreadCatalog.list(
            paramsJSON: #"{"limit":50}"#,
            executable: fake.executable.path,
            timeoutSeconds: 10)
        let decoded = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        #expect((decoded["sessions"] as? [Any])?.count == 50)
    }

    @Test func `default deadline allows cold large catalog scans`() {
        #expect(MacNodeCodexThreadCatalog.defaultTimeoutSeconds == 24)
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

    @Test func `bounds fake App Server output and wait time`() async throws {
        let oversized = try makeFakeCodex(#"""
        #!/bin/sh
        IFS= read -r initialize || exit 2
        printf '%512s\n' x
        sleep 1
        """#)
        defer { try? FileManager.default.removeItem(at: oversized.directory) }
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
        defer { try? FileManager.default.removeItem(at: stalled.directory) }
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
        let fake = try makeFakeCodex(#"""
        #!/bin/sh
        IFS= read -r initialize || exit 2
        printf '%s\n' '{"id":1,"result":{"codexHome":"/private"}}'
        IFS= read -r initialized || exit 3
        IFS= read -r list || exit 4
        printf '%s\n' '{"id":2,"error":{"code":-32000,"message":"private /Users/secret/path"}}'
        sleep 1
        """#)
        defer { try? FileManager.default.removeItem(at: fake.directory) }

        do {
            _ = try await MacNodeCodexThreadCatalog.list(
                paramsJSON: nil,
                executable: fake.executable.path)
            Issue.record("expected fake App Server error")
        } catch let error as MacNodeCodexThreadCatalog.CatalogError {
            #expect(error == .appServerUnavailable)
            #expect(error.localizedDescription == "UNAVAILABLE: Codex app-server thread list failed")
            #expect(!error.localizedDescription.contains("/Users/secret"))
        }
    }
}
