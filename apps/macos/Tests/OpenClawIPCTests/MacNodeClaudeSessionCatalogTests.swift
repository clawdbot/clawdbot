import Foundation
@testable import OpenClaw
import Testing

@Suite(.serialized)
struct MacNodeClaudeSessionCatalogTests {
    private func makeHome() throws -> URL {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-claude-home-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        return home
    }

    private func writeJSON(_ value: Any, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: url)
    }

    private func message(
        sessionId: String,
        role: String,
        text: String,
        index: Int
    ) -> [String: Any] {
        [
            "type": role,
            "sessionId": sessionId,
            "uuid": "\(sessionId)-\(index)",
            "timestamp": "2026-07-0\(index)T00:00:00.000Z",
            "isSidechain": false,
            "message": [
                "role": role,
                "content": [["type": "text", "text": text]],
                "model": "claude-opus-4-8",
            ],
        ]
    }

    private func writeTranscript(_ rows: [[String: Any]], to url: URL) throws {
        let lines = try rows.map { row in
            try #require(String(
                data: JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]),
                encoding: .utf8
            ))
        }
        try (lines.joined(separator: "\n") + "\n").write(
            to: url,
            atomically: true,
            encoding: .utf8
        )
    }

    @Test func `merges Desktop metadata over CLI indexes and filters archived sessions`() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let project = home.appendingPathComponent(".claude/projects/-workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let desktopId = "desktop-session"
        let cliId = "cli-session"
        let archivedId = "archived-session"
        let entries: [[String: Any]] = [
            [
                "sessionId": cliId,
                "fullPath": project.appendingPathComponent("\(cliId).jsonl").path,
                "summary": "CLI title",
                "modified": "2026-07-01T00:00:00.000Z",
                "projectPath": "/work/cli",
                "isSidechain": false,
            ],
            [
                "sessionId": desktopId,
                "fullPath": project.appendingPathComponent("\(desktopId).jsonl").path,
                "summary": "Index title",
                "modified": "2026-07-02T00:00:00.000Z",
                "isSidechain": false,
            ],
            [
                "sessionId": archivedId,
                "fullPath": project.appendingPathComponent("\(archivedId).jsonl").path,
                "summary": "Archived",
                "modified": "2026-07-03T00:00:00.000Z",
                "isSidechain": false,
            ],
        ]
        try writeJSON(
            ["version": 1, "entries": entries],
            to: project.appendingPathComponent("sessions-index.json")
        )
        for sessionId in [desktopId, cliId, archivedId] {
            try writeTranscript(
                [message(sessionId: sessionId, role: "user", text: sessionId, index: 1)],
                to: project.appendingPathComponent("\(sessionId).jsonl")
            )
        }
        let metadata = home.appendingPathComponent(
            "Library/Application Support/Claude/claude-code-sessions/account/workspace",
            isDirectory: true
        )
        try writeJSON(
            [
                "sessionId": "local-active",
                "cliSessionId": desktopId,
                "title": "Desktop title",
                "cwd": "/desktop/cwd",
                "lastActivityAt": 1_783_137_600_000 as Int64,
                "isArchived": false,
            ],
            to: metadata.appendingPathComponent("local_active.json")
        )
        try writeJSON(
            [
                "sessionId": "local-archived",
                "cliSessionId": archivedId,
                "isArchived": true,
            ],
            to: metadata.appendingPathComponent("local_archived.json")
        )

        let firstJSON = try MacNodeClaudeSessionCatalog.list(
            paramsJSON: #"{"limit":1}"#,
            homeURL: home
        )
        let first = try #require(
            JSONSerialization.jsonObject(with: Data(firstJSON.utf8)) as? [String: Any]
        )
        let firstSessions = try #require(first["sessions"] as? [[String: Any]])
        #expect(firstSessions.count == 1)
        #expect(firstSessions[0]["threadId"] as? String == desktopId)
        #expect(firstSessions[0]["name"] as? String == "Desktop title")
        #expect(firstSessions[0]["source"] as? String == "claude-desktop")
        #expect(firstSessions[0]["cwd"] as? String == "/desktop/cwd")
        let cursor = try #require(first["nextCursor"] as? String)

        let secondParams = try String(
            data: JSONSerialization.data(withJSONObject: ["limit": 1, "cursor": cursor]),
            encoding: .utf8
        )
        let secondJSON = try MacNodeClaudeSessionCatalog.list(
            paramsJSON: secondParams,
            homeURL: home
        )
        let second = try #require(
            JSONSerialization.jsonObject(with: Data(secondJSON.utf8)) as? [String: Any]
        )
        let secondSessions = try #require(second["sessions"] as? [[String: Any]])
        #expect(secondSessions.map { $0["threadId"] as? String } == [cliId])
        #expect(secondSessions[0]["updatedAt"] as? Int64 == 1_782_864_000_000)
        #expect(second["nextCursor"] == nil)
        #expect(throws: MacNodeClaudeSessionCatalog.CatalogError.self) {
            try MacNodeClaudeSessionCatalog.read(
                paramsJSON: #"{"threadId":"archived-session","limit":1}"#,
                homeURL: home
            )
        }
    }

    @Test func `rejects sidechain unindexed and symlink escaped transcript ids`() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let project = home.appendingPathComponent(".claude/projects/-workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let sidechainId = "sidechain-session"
        let discoveredSidechainId = "discovered-sidechain"
        let unindexedId = "unindexed-session"
        let sdkCLIId = "sdk-cli-session"
        let escapedId = "escaped-session"
        let escapedURL = project.appendingPathComponent("\(escapedId).jsonl")
        let outsideURL = home.appendingPathComponent("outside.jsonl")
        try writeJSON(
            [
                "version": 1,
                "entries": [
                    [
                        "sessionId": sidechainId,
                        "fullPath": project.appendingPathComponent("\(sidechainId).jsonl").path,
                        "isSidechain": true,
                    ],
                    [
                        "sessionId": escapedId,
                        "fullPath": escapedURL.path,
                        "isSidechain": false,
                    ],
                ],
            ],
            to: project.appendingPathComponent("sessions-index.json")
        )
        try writeTranscript(
            [message(sessionId: sidechainId, role: "user", text: "sidechain", index: 1)],
            to: project.appendingPathComponent("\(sidechainId).jsonl")
        )
        try writeTranscript(
            [message(sessionId: unindexedId, role: "user", text: "unindexed", index: 1)],
            to: project.appendingPathComponent("\(unindexedId).jsonl")
        )
        var sdkCLIMessage = message(sessionId: sdkCLIId, role: "user", text: "CLI prompt", index: 1)
        sdkCLIMessage["entrypoint"] = "sdk-cli"
        sdkCLIMessage["cwd"] = "/work/sdk"
        sdkCLIMessage["version"] = "2.1.204"
        try writeTranscript(
            [sdkCLIMessage],
            to: project.appendingPathComponent("\(sdkCLIId).jsonl")
        )
        var discoveredSidechain = message(
            sessionId: discoveredSidechainId,
            role: "user",
            text: "sidechain",
            index: 1
        )
        discoveredSidechain["entrypoint"] = "sdk-cli"
        discoveredSidechain["isSidechain"] = true
        try writeTranscript(
            [discoveredSidechain],
            to: project.appendingPathComponent("\(discoveredSidechainId).jsonl")
        )
        try writeTranscript(
            [message(sessionId: escapedId, role: "user", text: "outside", index: 1)],
            to: outsideURL
        )
        try FileManager.default.createSymbolicLink(at: escapedURL, withDestinationURL: outsideURL)
        try writeJSON(
            [
                "cliSessionId": sidechainId,
                "title": "Desktop sidechain",
                "isArchived": false,
            ],
            to: home.appendingPathComponent(
                "Library/Application Support/Claude/claude-code-sessions/account/workspace/local_sidechain.json"
            )
        )
        try writeJSON(
            [
                "cliSessionId": discoveredSidechainId,
                "title": "Discovered Desktop sidechain",
                "isArchived": false,
            ],
            to: home.appendingPathComponent(
                "Library/Application Support/Claude/claude-code-sessions/account/workspace/local_discovered_sidechain.json"
            )
        )

        let listJSON = try MacNodeClaudeSessionCatalog.list(paramsJSON: nil, homeURL: home)
        let list = try #require(
            JSONSerialization.jsonObject(with: Data(listJSON.utf8)) as? [String: Any]
        )
        let sessions = try #require(list["sessions"] as? [[String: Any]])
        #expect(sessions.map { $0["threadId"] as? String } == [sdkCLIId])
        #expect(sessions.first?["name"] as? String == "CLI prompt")
        _ = try MacNodeClaudeSessionCatalog.read(
            paramsJSON: #"{"threadId":"sdk-cli-session","limit":1}"#,
            homeURL: home
        )
        for threadId in [sidechainId, discoveredSidechainId, unindexedId, escapedId] {
            #expect(throws: MacNodeClaudeSessionCatalog.CatalogError.self) {
                try MacNodeClaudeSessionCatalog.read(
                    paramsJSON: #"{"threadId":"\#(threadId)","limit":1}"#,
                    homeURL: home
                )
            }
        }
    }

    @Test func `cached metadata honors access revocation and refreshes replaced transcripts`() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let project = home.appendingPathComponent(".claude/projects/-workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let sessionId = "cached-session"
        let transcript = project.appendingPathComponent("\(sessionId).jsonl")
        var firstMessage = self.message(sessionId: sessionId, role: "user", text: "Alpha", index: 1)
        firstMessage["entrypoint"] = "sdk-cli"
        try self.writeTranscript([firstMessage], to: transcript)

        let firstJSON = try MacNodeClaudeSessionCatalog.list(paramsJSON: nil, homeURL: home)
        let first = try #require(
            JSONSerialization.jsonObject(with: Data(firstJSON.utf8)) as? [String: Any])
        #expect((first["sessions"] as? [[String: Any]])?.first?["name"] as? String == "Alpha")

        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: transcript.path)
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: transcript.path)
        }
        let cachedJSON = try MacNodeClaudeSessionCatalog.list(paramsJSON: nil, homeURL: home)
        let cached = try #require(
            JSONSerialization.jsonObject(with: Data(cachedJSON.utf8)) as? [String: Any])
        #expect((cached["sessions"] as? [[String: Any]])?.isEmpty == true)

        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: transcript.path)
        let restoredJSON = try MacNodeClaudeSessionCatalog.list(paramsJSON: nil, homeURL: home)
        let restored = try #require(
            JSONSerialization.jsonObject(with: Data(restoredJSON.utf8)) as? [String: Any])
        #expect((restored["sessions"] as? [[String: Any]])?.first?["name"] as? String == "Alpha")

        var replacement = self.message(sessionId: sessionId, role: "user", text: "Bravo", index: 2)
        replacement["entrypoint"] = "sdk-cli"
        try self.writeTranscript([replacement], to: transcript)
        let refreshedJSON = try MacNodeClaudeSessionCatalog.list(paramsJSON: nil, homeURL: home)
        let refreshed = try #require(
            JSONSerialization.jsonObject(with: Data(refreshedJSON.utf8)) as? [String: Any])
        #expect((refreshed["sessions"] as? [[String: Any]])?.first?["name"] as? String == "Bravo")
    }


    @Test func `reads transcript pages backward without loading the whole history`() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let project = home.appendingPathComponent(".claude/projects/-workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let sessionId = "transcript-session"
        let oldUser = String(repeating: "old user ", count: 20000)
        let transcript = project.appendingPathComponent("\(sessionId).jsonl")
        try writeJSON(
            [
                "version": 1,
                "entries": [[
                    "sessionId": sessionId,
                    "fullPath": transcript.path,
                    "summary": "Transcript",
                    "modified": "2026-07-04T00:00:00.000Z",
                    "isSidechain": false,
                ]],
            ],
            to: project.appendingPathComponent("sessions-index.json")
        )
        try writeTranscript([
            ["type": "queue-operation", "sessionId": sessionId],
            message(sessionId: sessionId, role: "user", text: oldUser, index: 1),
            message(sessionId: sessionId, role: "assistant", text: "old assistant", index: 2),
            message(sessionId: sessionId, role: "user", text: "new user", index: 3),
            message(sessionId: sessionId, role: "assistant", text: "new assistant", index: 4),
        ], to: transcript)

        let latestJSON = try MacNodeClaudeSessionCatalog.read(
            paramsJSON: #"{"threadId":"transcript-session","limit":2}"#,
            homeURL: home
        )
        let latest = try #require(
            JSONSerialization.jsonObject(with: Data(latestJSON.utf8)) as? [String: Any]
        )
        let latestItems = try #require(latest["items"] as? [[String: Any]])
        #expect(latestItems.map { $0["text"] as? String } == ["new assistant", "new user"])
        let cursor = try #require(latest["nextCursor"] as? String)

        let olderParams = try #require(String(
            data: JSONSerialization.data(withJSONObject: [
                "threadId": sessionId,
                "limit": 2,
                "cursor": cursor,
            ]),
            encoding: .utf8
        ))
        let olderJSON = try MacNodeClaudeSessionCatalog.read(paramsJSON: olderParams, homeURL: home)
        let older = try #require(
            JSONSerialization.jsonObject(with: Data(olderJSON.utf8)) as? [String: Any]
        )
        let olderItems = try #require(older["items"] as? [[String: Any]])
        #expect(olderItems.map { $0["text"] as? String } == ["old assistant", oldUser])
        #expect(older["nextCursor"] == nil)
    }

    @Test func `bounds oversized transcript items by encoded response size`() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let project = home.appendingPathComponent(".claude/projects/-workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let sessionId = "oversized-session"
        let transcript = project.appendingPathComponent("\(sessionId).jsonl")
        try writeJSON(
            [
                "version": 1,
                "entries": [[
                    "sessionId": sessionId,
                    "fullPath": transcript.path,
                    "summary": "Oversized",
                    "modified": "2026-07-04T00:00:00.000Z",
                    "isSidechain": false,
                ]],
            ],
            to: project.appendingPathComponent("sessions-index.json")
        )
        let oneGrapheme = "a" + String(repeating: "\u{0301}", count: 2_200_000)
        try writeTranscript(
            [message(sessionId: sessionId, role: "user", text: oneGrapheme, index: 1)],
            to: transcript
        )

        let response = try MacNodeClaudeSessionCatalog.read(
            paramsJSON: #"{"threadId":"oversized-session","limit":1}"#,
            homeURL: home
        )
        #expect(response.utf8.count <= 20 * 1024 * 1024)
        let decoded = try #require(
            JSONSerialization.jsonObject(with: Data(response.utf8)) as? [String: Any]
        )
        let items = try #require(decoded["items"] as? [[String: Any]])
        #expect(items.first?["truncated"] as? Bool == true)
        let itemData = try JSONSerialization.data(withJSONObject: #require(items.first))
        #expect(itemData.count <= 4 * 1024 * 1024)
    }

    @Test func `advertises only when Anthropic is enabled and Claude projects exist`() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let root: [String: Any] = [
            "plugins": ["entries": ["anthropic": ["enabled": true]]],
        ]
        #expect(!MacNodeClaudeSessionCatalog.shouldAdvertise(root: root, homeURL: home))
        try FileManager.default.createDirectory(
            at: home.appendingPathComponent(".claude/projects", isDirectory: true),
            withIntermediateDirectories: true
        )
        #expect(MacNodeClaudeSessionCatalog.shouldAdvertise(root: [:], homeURL: home))
        #expect(MacNodeClaudeSessionCatalog.shouldAdvertise(root: root, homeURL: home))
        let disabled: [String: Any] = [
            "plugins": ["entries": ["anthropic": ["enabled": false]]],
        ]
        #expect(!MacNodeClaudeSessionCatalog.shouldAdvertise(root: disabled, homeURL: home))
        let denied: [String: Any] = ["plugins": ["deny": ["anthropic"]]]
        #expect(!MacNodeClaudeSessionCatalog.shouldAdvertise(root: denied, homeURL: home))
        let omittedByAllowlist: [String: Any] = ["plugins": ["allow": ["codex"]]]
        #expect(!MacNodeClaudeSessionCatalog.shouldAdvertise(root: omittedByAllowlist, homeURL: home))
        let ambiguous: [String: Any] = [
            "plugins": [
                "entries": [
                    "anthropic": ["enabled": true],
                    "Anthropic": ["enabled": false],
                ],
            ],
        ]
        #expect(!MacNodeClaudeSessionCatalog.shouldAdvertise(root: ambiguous, homeURL: home))
    }
}
