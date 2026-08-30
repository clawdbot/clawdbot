import Foundation
import SQLite3
import Testing
@testable import OpenClawKit

struct NativeStateBootstrapTests {
    @Test
    func `version zero database composes identity and port guardian tables`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let databaseURL = tempDir.appendingPathComponent("openclaw.sqlite", isDirectory: false)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        try Self.execute(databaseURL, """
        CREATE TABLE macos_port_guardian_records (
          pid INTEGER NOT NULL PRIMARY KEY,
          port INTEGER NOT NULL,
          command TEXT NOT NULL,
          mode TEXT NOT NULL,
          timestamp REAL NOT NULL
        ) STRICT;
        CREATE INDEX idx_macos_port_guardian_records_port
          ON macos_port_guardian_records(port, timestamp DESC);
        INSERT INTO macos_port_guardian_records VALUES (4242, 18789, '/usr/bin/ssh', 'remote', 42.5);
        """)

        _ = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: databaseURL,
            destinationStateDirURL: tempDir,
            profile: .primary)

        #expect(try Self.scalarInt(databaseURL, "PRAGMA user_version") == 0)
        #expect(try Self.scalarInt(
            databaseURL,
            "SELECT COUNT(*) FROM macos_port_guardian_records WHERE pid = 4242") == 1)
        #expect(try Self.scalarText(
            databaseURL,
            """
            SELECT group_concat(type || ':' || name, ',')
            FROM (SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name)
            """) == "index:idx_device_identities_device,index:idx_macos_port_guardian_records_port," +
            "table:device_identities,table:macos_port_guardian_records")
    }

    private static func execute(_ databaseURL: URL, _ sql: String) throws {
        var database: OpaquePointer?
        guard sqlite3_open(databaseURL.path, &database) == SQLITE_OK, let database else {
            throw DeviceIdentityStore.storageError("Could not open test database")
        }
        defer { sqlite3_close(database) }
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
            throw DeviceIdentityStore.storageError(String(cString: sqlite3_errmsg(database)))
        }
    }

    private static func scalarInt(_ databaseURL: URL, _ sql: String) throws -> Int64 {
        try self.scalar(databaseURL, sql) { sqlite3_column_int64($0, 0) }
    }

    private static func scalarText(_ databaseURL: URL, _ sql: String) throws -> String? {
        try self.scalar(databaseURL, sql) { statement in
            sqlite3_column_text(statement, 0).map { String(cString: $0) }
        }
    }

    private static func scalar<T>(
        _ databaseURL: URL,
        _ sql: String,
        transform: (OpaquePointer) -> T) throws -> T
    {
        var database: OpaquePointer?
        guard sqlite3_open(databaseURL.path, &database) == SQLITE_OK, let database else {
            throw DeviceIdentityStore.storageError("Could not open test database")
        }
        defer { sqlite3_close(database) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw DeviceIdentityStore.storageError(String(cString: sqlite3_errmsg(database)))
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else {
            throw DeviceIdentityStore.storageError(String(cString: sqlite3_errmsg(database)))
        }
        return transform(statement)
    }
}
