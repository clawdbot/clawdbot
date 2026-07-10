import Foundation
import Testing
@testable import OpenClaw

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

        let json = try MacNodeCodexThreadCatalog.normalize(
            listResultData: data,
            archived: false)
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

        let json = try MacNodeCodexThreadCatalog.normalize(
            listResultData: data,
            archived: false)
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

    @Test func `resolves and runs the first configured stdio endpoint without a shell`() async throws {
        let fake = try self.makeFakeCodex(#"""
        #!/bin/sh
        [ "$1" = "custom-app-server" ] || exit 10
        [ "$2" = "--stdio" ] || exit 11
        pwd > "${0}.cwd"
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
                    " codex-supervisor ": [
                        "enabled": true,
                        "config": [
                            "endpoints": [
                                ["transport": "websocket", "url": "unix://"],
                                [
                                    "transport": "stdio-proxy",
                                    "command": "./codex",
                                    "args": ["custom-app-server", "--stdio"],
                                    "cwd": fake.directory.path,
                                ],
                                ["transport": "stdio-proxy", "command": "/must/not/win"],
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
        #expect(resolved.arguments == ["custom-app-server", "--stdio"])
        #expect(resolved.cwd == fake.directory.standardizedFileURL)

        let payload = try await MacNodeCodexThreadCatalog.list(
            paramsJSON: nil,
            executable: resolved.executable,
            arguments: resolved.arguments,
            cwd: resolved.cwd)
        let response = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        #expect((response["sessions"] as? [Any])?.isEmpty == true)
        let capturedCwd = try String(
            contentsOf: URL(fileURLWithPath: fake.executable.path + ".cwd"),
            encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        #expect(
            URL(fileURLWithPath: capturedCwd).resolvingSymlinksInPath() ==
                fake.directory.resolvingSymlinksInPath())
    }

    @Test func `prefers the installed Codex app binary for the default endpoint`() throws {
        let app = try self.makeFakeCodex("#!/bin/sh\nexit 0\n")
        let pathCLI = try self.makeFakeCodex("#!/bin/sh\nexit 0\n")
        defer {
            try? FileManager.default.removeItem(at: app.directory)
            try? FileManager.default.removeItem(at: pathCLI.directory)
        }

        let resolved = try MacNodeCodexThreadCatalog.resolveInvocation(
            root: [:],
            searchPaths: [pathCLI.directory.path],
            defaultMacOSAppExecutable: app.executable.path)

        #expect(resolved.executable == app.executable.path)
        #expect(resolved.arguments == ["app-server", "--listen", "stdio://"])
    }

    @Test func `fake App Server receives handshake and bounded list request`() async throws {
        let fake = try self.makeFakeCodex(#"""
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
        printf '%s' '"name":"one","preview":"One","cwd":"/other",'
        printf '%s\n' '"status":{"type":"notLoaded"}}],"nextCursor":"opaque/+==","backwardsCursor":"back/+=="}}'
        sleep 1
        """#)
        defer { try? FileManager.default.removeItem(at: fake.directory) }

        let payload = try await MacNodeCodexThreadCatalog.list(
            paramsJSON: #"{"cursor":" cursor ","limit":25,"archived":true,"searchTerm":" One ","cwd":" /work "}"#,
            executable: fake.executable.path)
        let response = try #require(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        let sessions = try #require(response["sessions"] as? [[String: Any]])
        #expect(response["codexHome"] == nil)
        #expect(response["nextCursor"] as? String == "opaque/+==")
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
        #expect(listParams["archived"] as? Bool == true)
        #expect(listParams["searchTerm"] == nil)
        #expect(listParams["cwd"] as? String == "/work")
        #expect(listParams["sortKey"] as? String == "recency_at")
        #expect(listParams["sortDirection"] as? String == "desc")
        #expect((listParams["modelProviders"] as? [Any])?.isEmpty == true)
        #expect(listParams["sourceKinds"] == nil)
        #expect(listParams["useStateDbOnly"] as? Bool == false)
    }

    @Test func `drains App Server frames larger than one pipe read while server stays open`() async throws {
        let threads: [[String: Any]] = (0..<50).map { index in
            [
                "id": "thread-\(index)",
                "name": "Large catalog \(index)",
                "cwd": "/workspace/\(String(repeating: "x", count: 2_000))",
                "status": ["type": "notLoaded"],
            ]
        }
        let responseData = try JSONSerialization.data(withJSONObject: [
            "id": 2,
            "result": ["data": threads],
        ])
        let response = try #require(String(data: responseData, encoding: .utf8))
        #expect(response.utf8.count > 64 * 1024)
        let fake = try self.makeFakeCodex("""
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

    @Test func `rejects unknown and out of range params before launch`() async {
        let cases = [
            (#"{"extra":true}"#, "unknown Codex session catalog parameter: extra"),
            (#"{"limit":0}"#, "limit must be an integer from 1 to 100"),
            (#"{"limit":101}"#, "limit must be an integer from 1 to 100"),
            (#"{"limit":1.5}"#, "limit must be an integer from 1 to 100"),
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
        let oversized = try self.makeFakeCodex(#"""
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

        let stalled = try self.makeFakeCodex(#"""
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
        let fake = try self.makeFakeCodex(#"""
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
