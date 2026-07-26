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
    func `active deletion lease fences writes until expiry`() throws {
        try self.withStateDirectory { stateDirectoryURL in
            let original = Self.document(token: "original", agentCount: 1)
            try ExecApprovalsSQLiteStore.write(original, stateDirectoryURL: stateDirectoryURL)
            let databaseURL = ExecApprovalsSQLiteStore.databaseURL(
                stateDirectoryURL: stateDirectoryURL)
            let expiresAt = Int64(Date().timeIntervalSince1970 * 1000) + 120_000
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
            CREATE TABLE state_leases (
              scope TEXT NOT NULL,
              lease_key TEXT NOT NULL,
              owner TEXT NOT NULL,
              expires_at INTEGER,
              heartbeat_at INTEGER,
              payload_json TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (scope, lease_key)
            ) STRICT;
            INSERT INTO state_leases (
              scope, lease_key, owner, expires_at, heartbeat_at,
              payload_json, created_at, updated_at
            ) VALUES (
              '\(ExecApprovalsSQLiteStore.mutationLeaseScope)',
              '\(ExecApprovalsSQLiteStore.mutationLeaseKey)',
              'typescript-deletion', \(expiresAt), 1, NULL, 1, 1
            );
            PRAGMA user_version = 6;
            """)

            let replacement = Self.document(token: "replacement", agentCount: 2)
            do {
                try ExecApprovalsSQLiteStore.write(
                    replacement,
                    stateDirectoryURL: stateDirectoryURL)
                Issue.record("Expected active agent deletion lease to fence the write")
            } catch {
                #expect(error.localizedDescription.contains("agent deletion is in progress; retry"))
            }
            #expect(try ExecApprovalsSQLiteStore.read(
                stateDirectoryURL: stateDirectoryURL)?.document == original)

            try Self.execute(databaseURL, "UPDATE state_leases SET expires_at = 0")
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
            } catch {
                #expect(error.localizedDescription.contains("Run `openclaw doctor --fix`"))
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
