import Foundation
import SQLite3
import Testing
@testable import OpenClawKit

struct ExecApprovalsSQLiteStoreTests {
    @Test
    func `missing singleton row returns nil`() throws {
        try self.withStateDirectory { stateDirectoryURL in
            let record = try ExecApprovalsSQLiteStore.read(stateDirectoryURL: stateDirectoryURL)
            #expect(record == nil)
        }
    }

    @Test
    func `document round trips and update replaces singleton`() throws {
        try self.withStateDirectory { stateDirectoryURL in
            let original = Self.document(token: "first-token", agentCount: 1)
            try ExecApprovalsSQLiteStore.write(original, stateDirectoryURL: stateDirectoryURL)
            #expect(try ExecApprovalsSQLiteStore.read(
                stateDirectoryURL: stateDirectoryURL)?.document == original)

            let updated = Self.document(token: "second-token", agentCount: 2)
            try ExecApprovalsSQLiteStore.write(updated, stateDirectoryURL: stateDirectoryURL)
            let stored = try ExecApprovalsSQLiteStore.read(stateDirectoryURL: stateDirectoryURL)
            let record = try #require(stored)
            #expect(record.document == updated)
            #expect(record.rawJSON.contains("\"version\" : 1"))
            #expect(record.rawJSON.contains("\"socket\""))
            #expect(record.rawJSON.contains("\"defaults\""))
            #expect(record.rawJSON.contains("\"agents\""))
        }
    }

    @Test
    func `write derives every projection from authoritative document`() throws {
        try self.withStateDirectory { stateDirectoryURL in
            let document = ExecApprovalsDocument(
                version: 1,
                socket: ExecApprovalsSocketDocument(path: "/tmp/openclaw.sock", token: "secret"),
                defaults: ExecApprovalsDefaultsDocument(
                    security: .allowlist,
                    ask: .onMiss,
                    askFallback: .deny,
                    autoAllowSkills: true),
                agents: [
                    "main": ExecApprovalsAgentDocument(allowlist: [
                        ExecApprovalsAllowlistEntry(id: "one", pattern: "/usr/bin/git"),
                        ExecApprovalsAllowlistEntry(id: "two", pattern: "/usr/bin/swift"),
                    ]),
                    "worker": ExecApprovalsAgentDocument(allowlist: [
                        ExecApprovalsAllowlistEntry(id: "three", pattern: "/usr/bin/node"),
                    ]),
                ])
            try ExecApprovalsSQLiteStore.write(
                document,
                stateDirectoryURL: stateDirectoryURL,
                updatedAtMilliseconds: 123_456)

            let projection = try Self.readProjection(
                ExecApprovalsSQLiteStore.databaseURL(stateDirectoryURL: stateDirectoryURL))
            #expect(projection == Projection(
                socketPath: "/tmp/openclaw.sock",
                hasSocketToken: 1,
                defaultSecurity: "allowlist",
                defaultAsk: "on-miss",
                defaultAskFallback: "deny",
                autoAllowSkills: 1,
                agentCount: 2,
                allowlistCount: 3,
                updatedAtMilliseconds: 123_456))
        }
    }

    @Test
    func `deletion journal fences only the affected agent`() throws {
        try self.withStateDirectory { stateDirectoryURL in
            var original = Self.document(token: "original", agentCount: 1)
            let originalAgent = original.agents?.removeValue(forKey: "agent-0")
            original.agents?["Agent A"] = originalAgent
            try ExecApprovalsSQLiteStore.write(original, stateDirectoryURL: stateDirectoryURL)
            let databaseURL = ExecApprovalsSQLiteStore.databaseURL(
                stateDirectoryURL: stateDirectoryURL)
            try Self.execute(databaseURL, """
            CREATE TABLE schema_meta (
              meta_key TEXT NOT NULL PRIMARY KEY,
              role TEXT NOT NULL,
              schema_version INTEGER NOT NULL,
              agent_id TEXT,
              app_version TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            ) STRICT;
            INSERT INTO schema_meta (
              meta_key, role, schema_version, agent_id,
              app_version, created_at, updated_at
            ) VALUES ('primary', 'global', 6, NULL, NULL, 1, 1);
            CREATE TABLE agent_deletion_journal (
              agent_id TEXT PRIMARY KEY,
              operation_id TEXT NOT NULL DEFAULT '',
              agent_dir TEXT NOT NULL,
              workspace_dir TEXT NOT NULL,
              sessions_dir TEXT NOT NULL,
              database_paths_json TEXT NOT NULL DEFAULT '[]',
              cleanup_paths_json TEXT NOT NULL DEFAULT '[]',
              created_at INTEGER NOT NULL,
              cleanup_completed INTEGER NOT NULL DEFAULT 0,
              delete_files INTEGER NOT NULL DEFAULT 1
            ) STRICT;
            INSERT INTO agent_deletion_journal (
              agent_id, operation_id, agent_dir, workspace_dir, sessions_dir, created_at
            ) VALUES ('agent-a', 'typescript-deletion', '/agent', '/workspace', '/sessions', 1);
            PRAGMA user_version = 6;
            """)

            var replacement = Self.document(token: "replacement", agentCount: 2)
            let replacementAgent = replacement.agents?.removeValue(forKey: "agent-0")
            replacement.agents?["Agent A"] = replacementAgent
            replacement.agents?["Agent A"]?.security = .deny
            do {
                try ExecApprovalsSQLiteStore.write(
                    replacement,
                    stateDirectoryURL: stateDirectoryURL)
                Issue.record("Expected active agent deletion journal to fence the write")
            } catch {
                #expect(error.localizedDescription.contains("agent deletion is in progress; retry"))
            }
            #expect(try ExecApprovalsSQLiteStore.read(
                stateDirectoryURL: stateDirectoryURL)?.document == original)

            var unrelated = original
            unrelated.socket?.token = "unrelated"
            try ExecApprovalsSQLiteStore.write(unrelated, stateDirectoryURL: stateDirectoryURL)
            #expect(try ExecApprovalsSQLiteStore.read(
                stateDirectoryURL: stateDirectoryURL)?.document == unrelated)

            try Self.execute(databaseURL, "DELETE FROM agent_deletion_journal")
            try ExecApprovalsSQLiteStore.write(
                replacement,
                stateDirectoryURL: stateDirectoryURL)
            #expect(try ExecApprovalsSQLiteStore.read(
                stateDirectoryURL: stateDirectoryURL)?.document == replacement)
        }
    }

    @Test
    func `projections use TypeScript normalization rules`() throws {
        try self.withStateDirectory { stateDirectoryURL in
            let shared = ExecApprovalsAllowlistEntry(id: "shared", pattern: " /USR/BIN/GIT ")
            let document = ExecApprovalsDocument(
                version: 1,
                socket: ExecApprovalsSocketDocument(path: " /tmp/openclaw.sock ", token: "   "),
                agents: [
                    "default": ExecApprovalsAgentDocument(allowlist: [shared]),
                    "main": ExecApprovalsAgentDocument(allowlist: [
                        ExecApprovalsAllowlistEntry(id: "current", pattern: "/usr/bin/git"),
                    ]),
                ])
            try ExecApprovalsSQLiteStore.write(
                document,
                stateDirectoryURL: stateDirectoryURL,
                updatedAtMilliseconds: 42)

            let projection = try Self.readProjection(
                ExecApprovalsSQLiteStore.databaseURL(stateDirectoryURL: stateDirectoryURL))
            #expect(projection.socketPath == "/tmp/openclaw.sock")
            #expect(projection.hasSocketToken == 0)
            #expect(projection.agentCount == 1)
            #expect(projection.allowlistCount == 1)
        }
    }

    @Test
    func `malformed raw json fails closed`() throws {
        try self.withStateDirectory { stateDirectoryURL in
            try ExecApprovalsSQLiteStore.write(
                Self.document(token: "token", agentCount: 1),
                stateDirectoryURL: stateDirectoryURL)
            try Self.execute(
                ExecApprovalsSQLiteStore.databaseURL(stateDirectoryURL: stateDirectoryURL),
                "UPDATE exec_approvals_config SET raw_json = '{\"version\":2}'")

            #expect(throws: (any Error).self) {
                try ExecApprovalsSQLiteStore.read(stateDirectoryURL: stateDirectoryURL)
            }
        }
    }

    @Test
    func `invalid allowlist pattern is rejected before write`() throws {
        try self.withStateDirectory { stateDirectoryURL in
            let invalid = ExecApprovalsDocument(
                version: 1,
                agents: [
                    "main": ExecApprovalsAgentDocument(allowlist: [
                        ExecApprovalsAllowlistEntry(pattern: "   "),
                    ]),
                ])

            #expect(throws: (any Error).self) {
                try ExecApprovalsSQLiteStore.write(
                    invalid,
                    stateDirectoryURL: stateDirectoryURL)
            }
            let record = try ExecApprovalsSQLiteStore.read(stateDirectoryURL: stateDirectoryURL)
            #expect(record == nil)
        }
    }

    @Test(arguments: ["", ".doctor-importing"])
    func `legacy source or Doctor claim refuses SQLite access`(suffix: String) throws {
        try self.withStateDirectory { stateDirectoryURL in
            let legacyURL = stateDirectoryURL.appendingPathComponent(
                "exec-approvals.json\(suffix)",
                isDirectory: false)
            try Data("{\"version\":1,\"agents\":{}}".utf8).write(to: legacyURL)

            do {
                _ = try ExecApprovalsSQLiteStore.read(stateDirectoryURL: stateDirectoryURL)
                Issue.record("Expected pending legacy approvals to refuse SQLite access")
            } catch let error as ExecApprovalsLegacyMigrationRequiredError {
                #expect(error.stateDirectoryURL == stateDirectoryURL)
                #expect(error.legacyFileURL == legacyURL)
                // The blocked state directory must be named; a bare command repairs the
                // default root, and an app store never shares the CLI's default root.
                #expect(
                    error.localizedDescription.contains(
                        "Run `openclaw doctor --fix` with OPENCLAW_STATE_DIR set to "
                            + stateDirectoryURL.path))
            } catch {
                Issue.record("Expected typed migration error, got \(error)")
            }
        }
    }

    @Test
    func `Doctor recovery rename cannot cross an absent probe window`() {
        var probeResults = [false, false, true]
        #expect(throws: (any Error).self) {
            try ExecApprovalsLegacyMigrationGate.assertReady(
                stateDirectoryURL: URL(fileURLWithPath: "/unused"),
                pathMayExist: { _ in probeResults.removeFirst() })
        }
        #expect(probeResults.isEmpty)
    }

    private struct Projection: Equatable {
        let socketPath: String?
        let hasSocketToken: Int64
        let defaultSecurity: String?
        let defaultAsk: String?
        let defaultAskFallback: String?
        let autoAllowSkills: Int64?
        let agentCount: Int64
        let allowlistCount: Int64
        let updatedAtMilliseconds: Int64
    }

    private static func document(token: String, agentCount: Int) -> ExecApprovalsDocument {
        let agents = Dictionary(uniqueKeysWithValues: (0..<agentCount).map { index in
            ("agent-\(index)", ExecApprovalsAgentDocument(
                allowlist: [ExecApprovalsAllowlistEntry(
                    id: "entry-\(index)",
                    pattern: "/usr/bin/tool-\(index)")]))
        })
        return ExecApprovalsDocument(
            version: 1,
            socket: ExecApprovalsSocketDocument(path: "/tmp/openclaw.sock", token: token),
            defaults: ExecApprovalsDefaultsDocument(
                security: .full,
                ask: .off,
                askFallback: .deny,
                autoAllowSkills: false),
            agents: agents)
    }

    private static func readProjection(_ databaseURL: URL) throws -> Projection {
        var database: OpaquePointer?
        guard sqlite3_open(databaseURL.path, &database) == SQLITE_OK, let database else {
            throw TestError.sqlite("Could not open test database")
        }
        defer { sqlite3_close(database) }
        var statement: OpaquePointer?
        let sql = """
        SELECT socket_path, has_socket_token, default_security, default_ask,
               default_ask_fallback, auto_allow_skills, agent_count,
               allowlist_count, updated_at_ms
        FROM exec_approvals_config WHERE config_key = 'current'
        """
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
              let statement,
              sqlite3_step(statement) == SQLITE_ROW
        else {
            throw TestError.sqlite(String(cString: sqlite3_errmsg(database)))
        }
        defer { sqlite3_finalize(statement) }
        return Projection(
            socketPath: self.optionalText(statement, 0),
            hasSocketToken: sqlite3_column_int64(statement, 1),
            defaultSecurity: self.optionalText(statement, 2),
            defaultAsk: self.optionalText(statement, 3),
            defaultAskFallback: self.optionalText(statement, 4),
            autoAllowSkills: sqlite3_column_type(statement, 5) == SQLITE_NULL
                ? nil
                : sqlite3_column_int64(statement, 5),
            agentCount: sqlite3_column_int64(statement, 6),
            allowlistCount: sqlite3_column_int64(statement, 7),
            updatedAtMilliseconds: sqlite3_column_int64(statement, 8))
    }

    private static func optionalText(_ statement: OpaquePointer, _ column: Int32) -> String? {
        sqlite3_column_text(statement, column).map { String(cString: $0) }
    }

    private static func execute(_ databaseURL: URL, _ sql: String) throws {
        var database: OpaquePointer?
        guard sqlite3_open(databaseURL.path, &database) == SQLITE_OK, let database else {
            throw TestError.sqlite("Could not open test database")
        }
        defer { sqlite3_close(database) }
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
            throw TestError.sqlite(String(cString: sqlite3_errmsg(database)))
        }
    }

    private func withStateDirectory(
        _ body: (URL) throws -> Void) throws
    {
        let stateDirectoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: stateDirectoryURL,
            withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDirectoryURL) }
        try body(stateDirectoryURL)
    }

    private enum TestError: Error {
        case sqlite(String)
    }
}
