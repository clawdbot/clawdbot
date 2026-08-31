import Foundation
import Testing
@testable import OpenClawNativeState

struct OpenClawNativeStateSQLiteTests {
    @Test
    func `version zero composes exact canonical tables`() throws {
        try self.withDatabase { database in
            try database.withImmediateTransaction {
                try database.ensureCanonicalTable(.macosPortGuardianRecords)
                try database.execute("""
                INSERT INTO macos_port_guardian_records (pid, port, command, mode, timestamp)
                VALUES (4242, 18789, '/usr/bin/ssh', 'remote', 42.5)
                """)
                try database.ensureCanonicalTable(.deviceIdentities)
            }

            #expect(try database.scalarInt64("PRAGMA user_version") == 0)
            #expect(try database.scalarInt64(
                "SELECT COUNT(*) FROM macos_port_guardian_records WHERE pid = 4242") == 1)
            #expect(try database.scalarInt64(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'") == 4)
        }
    }

    @Test
    func `version zero rejects incomplete known sibling schema`() throws {
        try self.withDatabase { database in
            try database.execute("""
            CREATE TABLE macos_port_guardian_records (
              pid INTEGER NOT NULL PRIMARY KEY,
              port INTEGER NOT NULL,
              command TEXT NOT NULL,
              mode TEXT NOT NULL,
              timestamp REAL NOT NULL
            ) STRICT
            """)

            #expect(throws: OpenClawNativeStateError.self) {
                try database.ensureCanonicalTable(.deviceIdentities)
            }
        }
    }

    @Test
    func `versioned database never synthesizes a missing canonical table`() throws {
        try self.withDatabase { database in
            try database.execute("""
            CREATE TABLE schema_meta (
              meta_key TEXT NOT NULL PRIMARY KEY,
              role TEXT NOT NULL,
              schema_version INTEGER NOT NULL
            ) STRICT;
            INSERT INTO schema_meta (meta_key, role, schema_version)
            VALUES ('primary', 'global', 3);
            PRAGMA user_version = 3;
            """)

            #expect(throws: OpenClawNativeStateError.self) {
                try database.ensureCanonicalTable(.deviceIdentities)
            }
            #expect(try database.schemaObjectExists(type: "table", name: "device_identities") == false)
        }
    }

    @Test
    func `immediate transaction rolls back all writes`() throws {
        try self.withDatabase { database in
            try database.withImmediateTransaction {
                try database.ensureCanonicalTable(.macosPortGuardianRecords)
            }

            #expect(throws: TestError.self) {
                try database.withImmediateTransaction {
                    try database.execute("""
                    INSERT INTO macos_port_guardian_records (pid, port, command, mode, timestamp)
                    VALUES (4242, 18789, '/usr/bin/ssh', 'remote', 42.5)
                    """)
                    throw TestError.expected
                }
            }
            #expect(try database.scalarInt64("SELECT COUNT(*) FROM macos_port_guardian_records") == 0)
        }
    }

    @Test
    func `concurrent version zero stores compose different tables`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databaseURL = directory.appendingPathComponent("openclaw.sqlite", isDirectory: false)

        try await withThrowingTaskGroup(of: Void.self) { group in
            for table in [
                OpenClawNativeStateCanonicalTable.deviceIdentities,
                .macosPortGuardianRecords,
            ] {
                group.addTask {
                    let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
                    try database.withImmediateTransaction {
                        try database.ensureCanonicalTable(table)
                    }
                }
            }
            try await group.waitForAll()
        }

        let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
        #expect(try database.scalarInt64(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'") == 4)
    }

    @Test
    func `vanished transient sidecar does not fail committed write cleanup`() throws {
        let databaseURL = URL(fileURLWithPath: "/tmp/openclaw-native-state.sqlite")
        var attemptedPaths: [String] = []

        try OpenClawNativeStateSQLite.secureDatabaseFiles(
            databaseURL,
            fileExists: { _ in true },
            setAttributes: { _, path in
                attemptedPaths.append(path)
                if path.hasSuffix("-wal") {
                    throw NSError(domain: NSCocoaErrorDomain, code: NSFileNoSuchFileError)
                }
            })

        #expect(attemptedPaths == [
            databaseURL.path,
            databaseURL.path + "-wal",
            databaseURL.path + "-shm",
            databaseURL.path + "-journal",
        ])
    }

    @Test
    func `missing database or nonmissing sidecar failure remains fatal`() {
        let databaseURL = URL(fileURLWithPath: "/tmp/openclaw-native-state.sqlite")
        let missing = NSError(domain: NSPOSIXErrorDomain, code: Int(POSIXErrorCode.ENOENT.rawValue))
        let denied = NSError(domain: NSPOSIXErrorDomain, code: Int(POSIXErrorCode.EACCES.rawValue))

        #expect(throws: NSError.self) {
            try OpenClawNativeStateSQLite.secureDatabaseFiles(
                databaseURL,
                fileExists: { _ in true },
                setAttributes: { _, path in
                    if path == databaseURL.path { throw missing }
                })
        }
        #expect(throws: NSError.self) {
            try OpenClawNativeStateSQLite.secureDatabaseFiles(
                databaseURL,
                fileExists: { _ in true },
                setAttributes: { _, path in
                    if path.hasSuffix("-wal") { throw denied }
                })
        }
    }

    private enum TestError: Error {
        case expected
    }

    private func withDatabase(
        body: (OpenClawNativeStateSQLite) throws -> Void) throws
    {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try OpenClawNativeStateSQLite(
            databaseURL: directory.appendingPathComponent("openclaw.sqlite", isDirectory: false))
        try body(database)
    }
}
