import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct MacNodeClaudeSessionCatalogTests {
    private final class EnumerationCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        func increment() {
            self.lock.withLock { self.count += 1 }
        }

        func value() -> Int {
            self.lock.withLock { self.count }
        }
    }

    private final class Fixture {
        let home: URL

        init() throws {
            self.home = FileManager.default.temporaryDirectory
                .appendingPathComponent("openclaw-claude-home-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: self.home, withIntermediateDirectories: true)
        }

        deinit {
            MacNodeClaudeSessionCatalog.setCatalogEnumerationObserverForTesting(nil)
            try? FileManager.default.removeItem(at: self.home)
        }

        var projects: URL {
            self.home.appendingPathComponent(".claude/projects", isDirectory: true)
        }

        func project(_ name: String = "-workspace") throws -> URL {
            let url = self.projects.appendingPathComponent(name, isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            return url
        }

        func file(_ sessionId: String, in project: URL) -> URL {
            project.appendingPathComponent("\(sessionId).jsonl")
        }

        func indexEntry(
            _ sessionId: String,
            in project: URL,
            summary: String? = nil,
            modified: String? = nil,
            projectPath: String? = nil,
            isSidechain: Bool = false) -> [String: Any]
        {
            var entry: [String: Any] = [
                "sessionId": sessionId,
                "fullPath": self.file(sessionId, in: project).path,
                "isSidechain": isSidechain,
            ]
            entry["summary"] = summary
            entry["modified"] = modified
            entry["projectPath"] = projectPath
            return entry
        }

        func writeIndex(_ entries: [[String: Any]], in project: URL) throws {
            try self.writeJSON(
                ["version": 1, "entries": entries],
                to: project.appendingPathComponent("sessions-index.json"))
        }

        func desktopMetadata(_ name: String) -> URL {
            self.home.appendingPathComponent(
                "Library/Application Support/Claude/claude-code-sessions/account/workspace/\(name).json")
        }

        func writeJSON(_ value: Any, to url: URL) throws {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: url)
        }

        func message(
            _ sessionId: String,
            _ text: String,
            role: String = "user",
            index: Int = 1,
            entrypoint: String? = nil,
            cwd: String? = nil,
            version: String? = nil,
            isSidechain: Bool = false) -> [String: Any]
        {
            var row: [String: Any] = [
                "type": role,
                "sessionId": sessionId,
                "uuid": "\(sessionId)-\(index)",
                "timestamp": "2026-07-0\(index)T00:00:00.000Z",
                "isSidechain": isSidechain,
                "message": [
                    "role": role,
                    "content": [["type": "text", "text": text]],
                    "model": "claude-opus-4-8",
                ],
            ]
            row["entrypoint"] = entrypoint
            row["cwd"] = cwd
            row["version"] = version
            return row
        }

        func writeTranscript(_ rows: [[String: Any]], to url: URL) throws {
            let lines = try rows.map { row in
                try #require(String(
                    data: JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]),
                    encoding: .utf8))
            }
            try (lines.joined(separator: "\n") + "\n").write(
                to: url,
                atomically: true,
                encoding: .utf8)
        }

        func params(_ value: [String: Any]) throws -> String? {
            try String(data: JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)
        }

        func decode(_ json: String) -> [String: Any]? {
            try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        }

        func list(paramsJSON: String? = nil) throws -> [String: Any]? {
            try self.decode(MacNodeClaudeSessionCatalog.list(paramsJSON: paramsJSON, homeURL: self.home))
        }

        func read(_ paramsJSON: String) throws -> [String: Any]? {
            try self.decode(self.readJSON(paramsJSON))
        }

        func readJSON(_ paramsJSON: String) throws -> String {
            try MacNodeClaudeSessionCatalog.read(paramsJSON: paramsJSON, homeURL: self.home)
        }

        func observeEnumerations() -> EnumerationCounter {
            let counter = EnumerationCounter()
            let projectsPath = self.projects.standardizedFileURL.path
            MacNodeClaudeSessionCatalog.setCatalogEnumerationObserverForTesting { rootPath in
                if rootPath == projectsPath { counter.increment() }
            }
            return counter
        }
    }

    @Test(arguments: [true, false])
    func `merges Desktop metadata with indexed or Desktop-only transcripts`(indexedDesktop: Bool) throws {
        let fixture = try Fixture()
        let desktopId = "desktop-session"
        let cliId = "cli-session"
        let archivedId = "archived-session"
        let project = try fixture.project()
        var indexEntries = [
            fixture.indexEntry(
                cliId,
                in: project,
                summary: "CLI title",
                modified: "2026-07-01T00:00:00.000Z",
                projectPath: "/work/cli"),
            fixture.indexEntry(
                desktopId,
                in: project,
                summary: "Index title",
                modified: "2026-07-02T00:00:00.000Z"),
            fixture.indexEntry(
                archivedId,
                in: project,
                summary: "Archived",
                modified: "2026-07-03T00:00:00.000Z"),
        ]
        if !indexedDesktop {
            indexEntries.removeAll { $0["sessionId"] as? String == desktopId }
        }
        try fixture.writeIndex(indexEntries, in: project)
        for sessionId in [desktopId, cliId, archivedId] {
            try fixture.writeTranscript(
                [fixture.message(sessionId, sessionId)],
                to: fixture.file(sessionId, in: project))
        }
        try fixture.writeJSON(
            [
                "sessionId": "local-active",
                "cliSessionId": desktopId,
                "title": "Desktop title",
                "cwd": "/desktop/cwd",
                "lastActivityAt": 1_783_137_600_000 as Int64,
                "isArchived": false,
            ],
            to: fixture.desktopMetadata("local_active"))
        try fixture.writeJSON(
            [
                "sessionId": "local-archived",
                "cliSessionId": archivedId,
                "isArchived": true,
            ],
            to: fixture.desktopMetadata("local_archived"))
        try fixture.writeJSON(
            ["cliSessionId": "missing-session", "title": "Stale Desktop metadata", "isArchived": false],
            to: fixture.desktopMetadata("local_missing"))

        let first = try #require(try fixture.list(paramsJSON: #"{"limit":1}"#))
        let firstSessions = try #require(first["sessions"] as? [[String: Any]])
        #expect(firstSessions.count == 1)
        #expect(firstSessions[0]["threadId"] as? String == desktopId)
        #expect(firstSessions[0]["name"] as? String == "Desktop title")
        #expect(firstSessions[0]["source"] as? String == "claude-desktop")
        #expect(firstSessions[0]["cwd"] as? String == "/desktop/cwd")
        let cursor = try #require(first["nextCursor"] as? String)

        let secondParams = try fixture.params(["limit": 1, "cursor": cursor])
        let second = try #require(try fixture.list(paramsJSON: secondParams))
        let secondSessions = try #require(second["sessions"] as? [[String: Any]])
        #expect(secondSessions.map { $0["threadId"] as? String } == [cliId])
        #expect(secondSessions[0]["updatedAt"] as? Int64 == 1_782_864_000_000)
        #expect(second["nextCursor"] == nil)
        #expect(throws: MacNodeClaudeSessionCatalog.CatalogError.self) {
            try fixture.read(#"{"threadId":"archived-session","limit":1}"#)
        }
    }

    @Test func `discovers CLI fallback transcripts and rejects sidechains foreign entrypoints and escapes`() throws {
        let fixture = try Fixture()
        let project = try fixture.project()
        let sidechainId = "sidechain-session"
        let cliSidechainId = "cli-sidechain-session"
        let discoveredSidechainId = "discovered-sidechain"
        let foreignEntrypointId = "foreign-entrypoint-session"
        let unindexedId = "unindexed-session"
        let cliId = "cli-session"
        let sdkCLIId = "sdk-cli-session"
        let escapedId = "escaped-session"
        let escapedURL = fixture.file(escapedId, in: project)
        let outsideURL = fixture.home.appendingPathComponent("outside.jsonl")
        try fixture.writeIndex([
            fixture.indexEntry(sidechainId, in: project, isSidechain: true),
            fixture.indexEntry(escapedId, in: project),
        ], in: project)
        try fixture.writeTranscript(
            [fixture.message(sidechainId, "sidechain")],
            to: fixture.file(sidechainId, in: project))
        try fixture.writeTranscript(
            [fixture.message(unindexedId, "unindexed")],
            to: fixture.file(unindexedId, in: project))
        for (id, text, entrypoint, cwd, version) in [
            (cliId, "Interactive CLI prompt", "cli", "/work/cli", "2.1.216"),
            (sdkCLIId, "Headless CLI prompt", "sdk-cli", "/work/sdk", "2.1.204"),
        ] {
            try fixture.writeTranscript(
                [fixture.message(
                    id,
                    text,
                    entrypoint: entrypoint,
                    cwd: cwd,
                    version: version)],
                to: fixture.file(id, in: project))
        }
        for (id, text, entrypoint, isSidechain) in [
            (cliSidechainId, "interactive sidechain", "cli", true),
            (discoveredSidechainId, "headless sidechain", "sdk-cli", true),
            (foreignEntrypointId, "SDK session", "sdk-ts", false),
        ] {
            try fixture.writeTranscript(
                [fixture.message(
                    id,
                    text,
                    entrypoint: entrypoint,
                    isSidechain: isSidechain)],
                to: fixture.file(id, in: project))
        }
        try fixture.writeTranscript(
            [fixture.message(escapedId, "outside")],
            to: outsideURL)
        try FileManager.default.createSymbolicLink(at: escapedURL, withDestinationURL: outsideURL)
        for (name, sessionId, title) in [
            ("local_sidechain", sidechainId, "Desktop sidechain"),
            ("local_cli_sidechain", cliSidechainId, "Interactive Desktop sidechain"),
            ("local_discovered_sidechain", discoveredSidechainId, "Headless Desktop sidechain"),
            ("local_escaped", escapedId, "Escaped Desktop session"),
        ] {
            try fixture.writeJSON(
                ["cliSessionId": sessionId, "title": title, "isArchived": false],
                to: fixture.desktopMetadata(name))
        }

        let list = try #require(try fixture.list())
        let sessions = try #require(list["sessions"] as? [[String: Any]])
        #expect(sessions.compactMap { $0["threadId"] as? String }.sorted() == [cliId, sdkCLIId])
        #expect(
            sessions.first(where: { $0["threadId"] as? String == cliId })?["name"] as? String ==
                "Interactive CLI prompt")
        for (threadId, expectedText) in [
            (cliId, "Interactive CLI prompt"),
            (sdkCLIId, "Headless CLI prompt"),
        ] {
            let read = try #require(try fixture.read(#"{"threadId":"\#(threadId)","limit":1}"#))
            let items = try #require(read["items"] as? [[String: Any]])
            #expect(items.first?["text"] as? String == expectedText)
        }
        for threadId in [
            sidechainId,
            cliSidechainId,
            discoveredSidechainId,
            foreignEntrypointId,
            unindexedId,
            escapedId,
        ] {
            #expect(throws: MacNodeClaudeSessionCatalog.CatalogError.self) {
                try fixture.read(#"{"threadId":"\#(threadId)","limit":1}"#)
            }
        }
    }

    @Test func `cached metadata honors access revocation and refreshes replaced transcripts`() throws {
        let fixture = try Fixture()
        let project = try fixture.project()
        let sessionId = "cached-session"
        let transcript = fixture.file(sessionId, in: project)
        try fixture.writeTranscript(
            [fixture.message(
                sessionId,
                "Alpha",
                entrypoint: "sdk-cli")],
            to: transcript)

        let first = try #require(try fixture.list())
        #expect((first["sessions"] as? [[String: Any]])?.first?["name"] as? String == "Alpha")

        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: transcript.path)
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: transcript.path)
        }
        let cached = try #require(try fixture.list())
        #expect((cached["sessions"] as? [[String: Any]])?.isEmpty == true)

        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: transcript.path)
        let restored = try #require(try fixture.list())
        #expect((restored["sessions"] as? [[String: Any]])?.first?["name"] as? String == "Alpha")

        try fixture.writeTranscript(
            [fixture.message(
                sessionId,
                "Bravo",
                index: 2,
                entrypoint: "sdk-cli")],
            to: transcript)
        let refreshed = try #require(try fixture.list())
        #expect((refreshed["sessions"] as? [[String: Any]])?.first?["name"] as? String == "Bravo")
    }

    @Test func `reuses catalog discovery only across transcript read pages`() throws {
        let fixture = try Fixture()
        let project = try fixture.project()
        let sessionId = "transcript-session"
        let oldUser = String(repeating: "old user 🦞 ", count: 20000)
        let transcript = fixture.file(sessionId, in: project)
        try fixture.writeIndex([
            fixture.indexEntry(
                sessionId,
                in: project,
                summary: "Transcript",
                modified: "2026-07-04T00:00:00.000Z"),
        ], in: project)
        try fixture.writeTranscript([
            ["type": "queue-operation", "sessionId": sessionId],
            fixture.message(sessionId, oldUser),
            fixture.message(sessionId, "old assistant", role: "assistant", index: 2),
            fixture.message(sessionId, "new user", index: 3),
            fixture.message(sessionId, "new assistant", role: "assistant", index: 4),
        ], to: transcript)

        let enumerations = fixture.observeEnumerations()

        let latest = try #require(try fixture.read(#"{"threadId":"transcript-session","limit":2}"#))
        let latestItems = try #require(latest["items"] as? [[String: Any]])
        #expect(latestItems.map { $0["text"] as? String } == ["new assistant", "new user"])
        let cursor = try #require(latest["nextCursor"] as? String)
        #expect(enumerations.value() == 1)

        let olderParams = try #require(try fixture.params([
            "threadId": sessionId,
            "limit": 2,
            "cursor": cursor,
        ]))
        let older = try #require(try fixture.read(olderParams))
        let olderItems = try #require(older["items"] as? [[String: Any]])
        #expect(olderItems.map { $0["text"] as? String } == ["old assistant", oldUser])
        #expect(older["nextCursor"] == nil)
        #expect(enumerations.value() == 1)

        for item in latestItems + olderItems {
            let resume = try #require(item["resumeCursor"] as? String)
            let resumeParams = try #require(try fixture.params([
                "threadId": sessionId, "limit": 1, "cursor": resume,
            ]))
            let resumed = try #require(try fixture.read(resumeParams))
            let resumedItem = try #require((resumed["items"] as? [[String: Any]])?.first)
            #expect(resumedItem["uuid"] as? String == item["uuid"] as? String)
            #expect(resumedItem["text"] as? String == item["text"] as? String)
        }
        #expect(enumerations.value() == 1)
    }

    @Test func `missing pagination lease falls back to current discovery`() throws {
        let fixture = try Fixture()
        let project = try fixture.project()
        let sessionId = "lease-session"
        let transcript = fixture.file(sessionId, in: project)
        try fixture.writeIndex([fixture.indexEntry(sessionId, in: project)], in: project)
        try fixture.writeTranscript([
            fixture.message(sessionId, "old"),
            fixture.message(sessionId, "new", role: "assistant", index: 2),
        ], to: transcript)

        let enumerations = fixture.observeEnumerations()

        let first = try #require(try fixture.read(#"{"threadId":"lease-session","limit":1}"#))
        var encoded = try #require(first["nextCursor"] as? String)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        let cursorData = try #require(Data(base64Encoded: encoded))
        var cursorValue = try #require(
            JSONSerialization.jsonObject(with: cursorData) as? [String: Any])
        cursorValue["lease"] = UUID().uuidString
        let missingLeaseCursor = try JSONSerialization.data(
            withJSONObject: cursorValue,
            options: [.sortedKeys]).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")

        let secondParams = try #require(try fixture.params([
            "threadId": sessionId,
            "limit": 1,
            "cursor": missingLeaseCursor,
        ]))
        let second = try #require(try fixture.read(secondParams))
        #expect((second["items"] as? [[String: Any]])?.first?["text"] as? String == "old")
        #expect(enumerations.value() == 2)
    }

    @Test func `fresh reads recheck catalog eligibility after a pagination lease`() throws {
        let fixture = try Fixture()
        let project = try fixture.project()
        let sessionId = "eligibility-session"
        try fixture.writeTranscript([
            fixture.message(sessionId, "old"),
            fixture.message(sessionId, "new", role: "assistant", index: 2),
        ], to: fixture.file(sessionId, in: project))
        try fixture.writeIndex([fixture.indexEntry(sessionId, in: project)], in: project)

        let first = try #require(try fixture.read(#"{"threadId":"eligibility-session","limit":1}"#))
        #expect(first["nextCursor"] is String)

        try fixture.writeIndex([
            fixture.indexEntry(sessionId, in: project, isSidechain: true),
        ], in: project)

        #expect(throws: MacNodeClaudeSessionCatalog.CatalogError.self) {
            try fixture.read(#"{"threadId":"eligibility-session","limit":1}"#)
        }
    }

    @Test func `fresh reads discover a moved session file`() throws {
        let fixture = try Fixture()
        let firstProject = try fixture.project("-first")
        let sessionId = "moving-session"
        let firstTranscript = fixture.file(sessionId, in: firstProject)
        try fixture.writeTranscript([
            fixture.message(sessionId, "first location"),
            fixture.message(sessionId, "latest", role: "assistant", index: 2),
        ], to: firstTranscript)
        try fixture.writeIndex([
            fixture.indexEntry(sessionId, in: firstProject, summary: "Moving"),
        ], in: firstProject)

        let enumerations = fixture.observeEnumerations()

        let firstPayload = try #require(try fixture.read(#"{"threadId":"moving-session","limit":1}"#))
        #expect((firstPayload["items"] as? [[String: Any]])?.first?["text"] as? String == "latest")
        #expect(enumerations.value() == 1)

        let secondProject = try fixture.project("-second")
        let secondTranscript = fixture.file(sessionId, in: secondProject)
        try FileManager.default.moveItem(at: firstTranscript, to: secondTranscript)
        try fixture.writeIndex([], in: firstProject)
        try fixture.writeIndex([
            fixture.indexEntry(sessionId, in: secondProject, summary: "Moving"),
        ], in: secondProject)

        let refreshedPayload = try #require(try fixture.read(#"{"threadId":"moving-session","limit":1}"#))
        #expect((refreshedPayload["items"] as? [[String: Any]])?.first?["text"] as? String == "latest")
        #expect(enumerations.value() == 2)

        _ = try fixture.read(#"{"threadId":"moving-session","limit":1}"#)
        #expect(enumerations.value() == 3)
    }

    @Test func `bounds oversized transcript items by encoded response size`() throws {
        let fixture = try Fixture()
        let project = try fixture.project()
        let sessionId = "oversized-session"
        let transcript = fixture.file(sessionId, in: project)
        try fixture.writeIndex([
            fixture.indexEntry(
                sessionId,
                in: project,
                summary: "Oversized",
                modified: "2026-07-04T00:00:00.000Z"),
        ], in: project)
        let oneGrapheme = "a" + String(repeating: "\u{0301}", count: 2_200_000)
        try fixture.writeTranscript(
            [fixture.message(sessionId, oneGrapheme)],
            to: transcript)

        let response = try fixture.readJSON(#"{"threadId":"oversized-session","limit":1}"#)
        #expect(response.utf8.count <= 20 * 1024 * 1024)
        let decoded = try #require(fixture.decode(response))
        let items = try #require(decoded["items"] as? [[String: Any]])
        #expect(items.first?["truncated"] as? Bool == true)
        let resume = try #require(items.first?["resumeCursor"] as? String)
        let resumeParams = try #require(try fixture.params([
            "threadId": sessionId, "limit": 1, "cursor": resume,
        ]))
        let resumed = try #require(try fixture.read(resumeParams))
        #expect((resumed["items"] as? [[String: Any]])?.first?["truncated"] as? Bool == true)
        let itemData = try JSONSerialization.data(withJSONObject: #require(items.first))
        #expect(itemData.count <= 4 * 1024 * 1024)
    }

    @Test func `advertises only when Anthropic is enabled and Claude projects exist`() throws {
        let fixture = try Fixture()
        let root: [String: Any] = ["plugins": ["entries": ["anthropic": ["enabled": true]]]]
        #expect(!MacNodeClaudeSessionCatalog.shouldAdvertise(root: root, homeURL: fixture.home))
        try FileManager.default.createDirectory(
            at: fixture.projects,
            withIntermediateDirectories: true)
        #expect(MacNodeClaudeSessionCatalog.shouldAdvertise(root: [:], homeURL: fixture.home))
        #expect(MacNodeClaudeSessionCatalog.shouldAdvertise(root: root, homeURL: fixture.home))
        let disabled: [String: Any] = ["plugins": ["entries": ["anthropic": ["enabled": false]]]]
        #expect(!MacNodeClaudeSessionCatalog.shouldAdvertise(root: disabled, homeURL: fixture.home))
        let denied: [String: Any] = ["plugins": ["deny": ["anthropic"]]]
        #expect(!MacNodeClaudeSessionCatalog.shouldAdvertise(root: denied, homeURL: fixture.home))
        let omittedByAllowlist: [String: Any] = ["plugins": ["allow": ["codex"]]]
        #expect(!MacNodeClaudeSessionCatalog.shouldAdvertise(root: omittedByAllowlist, homeURL: fixture.home))
        let entries: [String: Any] = ["anthropic": ["enabled": true], "Anthropic": ["enabled": false]]
        let ambiguous: [String: Any] = ["plugins": ["entries": entries]]
        #expect(!MacNodeClaudeSessionCatalog.shouldAdvertise(root: ambiguous, homeURL: fixture.home))
    }
}
