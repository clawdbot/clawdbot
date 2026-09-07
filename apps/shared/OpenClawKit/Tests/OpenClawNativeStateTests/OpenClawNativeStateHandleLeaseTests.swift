import Darwin
import Foundation
import SQLite3
import Testing
@testable import OpenClawNativeState

struct OpenClawNativeStateHandleLeaseTests {
    @Test func `matches the Node canonical coordinator vector`() throws {
        let url = try OpenClawNativeStateHandleLease.coordinatorURL(
            databaseURL: URL(fileURLWithPath: "/openclaw-device-identity-contract/state/openclaw.sqlite"),
            runtimeDirectory: URL(fileURLWithPath: "/openclaw-state-runtime"),
            uid: 501)
        #expect(url.path == "/openclaw-state-runtime/openclaw-state-locks-501/state-handles.e5c82e32.lock.sqlite")
    }

    @Test func `aliases and missing descendants use one physical lock key`() throws {
        try self.withDirectory { directory in
            let real = directory.appendingPathComponent("real", isDirectory: true)
            let alias = directory.appendingPathComponent("alias", isDirectory: true)
            try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)
            let source = real.appendingPathComponent("missing/openclaw.sqlite")
            let aliased = alias.appendingPathComponent("missing/openclaw.sqlite")
            let direct = try OpenClawNativeStateHandleLease.coordinatorURL(
                databaseURL: source, runtimeDirectory: directory, uid: getuid())
            let indirect = try OpenClawNativeStateHandleLease.coordinatorURL(
                databaseURL: aliased, runtimeDirectory: directory, uid: getuid())
            #expect(direct == indirect)
        }
    }

    @Test func `retained statements keep native connection exclusion until finalization`() throws {
        try self.withDirectory { directory in
            let source = directory.appendingPathComponent("state/openclaw.sqlite")
            var database: OpenClawNativeStateSQLite? = try OpenClawNativeStateSQLite(databaseURL: source)
            try database?.withImmediateTransaction {
                try database?.ensureCanonicalTable(.macosPortGuardianRecords)
            }
            var statement = try database?.prepare("SELECT pid FROM macos_port_guardian_records")
            #expect(statement != nil)
            let coordinator = try self.openCoordinator(source)
            defer { sqlite3_exec(coordinator, "ROLLBACK", nil, nil, nil)
                sqlite3_close(coordinator)
            }
            #expect(sqlite3_exec(coordinator, "BEGIN EXCLUSIVE", nil, nil, nil) == SQLITE_BUSY)
            database = nil
            // The statement owns its native connection after the caller releases it.
            #expect(sqlite3_exec(coordinator, "BEGIN EXCLUSIVE", nil, nil, nil) == SQLITE_BUSY)
            #expect(try statement?.step() == .done)
            statement = nil
            #expect(sqlite3_exec(coordinator, "BEGIN EXCLUSIVE", nil, nil, nil) == SQLITE_OK)
        }
    }

    @Test func `file exclusion refuses native admission before source directories are created`() throws {
        try self.withDirectory { directory in
            let parent = directory.appendingPathComponent("not-created", isDirectory: true)
            let source = parent.appendingPathComponent("openclaw.sqlite")
            let coordinator = try self.openCoordinator(source)
            defer { sqlite3_exec(coordinator, "ROLLBACK", nil, nil, nil)
                sqlite3_close(coordinator)
            }
            #expect(sqlite3_exec(coordinator, "BEGIN EXCLUSIVE", nil, nil, nil) == SQLITE_OK)
            #expect(throws: OpenClawNativeStateError.self) {
                try OpenClawNativeStateSQLite(databaseURL: source)
            }
            #expect(!FileManager.default.fileExists(atPath: parent.path))
        }
    }

    @Test func `failed native open releases its handle lease`() throws {
        try self.withDirectory { directory in
            let source = directory.appendingPathComponent("not-created/openclaw.sqlite")
            #expect(throws: OpenClawNativeStateError.self) {
                try OpenClawNativeStateSQLite(databaseURL: source, createIfMissing: false)
            }
            let coordinator = try self.openCoordinator(source)
            defer { sqlite3_exec(coordinator, "ROLLBACK", nil, nil, nil)
                sqlite3_close(coordinator)
            }
            #expect(sqlite3_exec(coordinator, "BEGIN EXCLUSIVE", nil, nil, nil) == SQLITE_OK)
            #expect(!FileManager.default.fileExists(atPath: source.path))
        }
    }

    private func openCoordinator(_ source: URL) throws -> OpaquePointer {
        let url = try OpenClawNativeStateHandleLease.coordinatorURL(
            databaseURL: source,
            runtimeDirectory: OpenClawNativeStateHandleLease.runtimeDirectory(for: source),
            uid: getuid())
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        var database: OpaquePointer?
        guard sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK,
              let database
        else {
            if let database { sqlite3_close(database) }
            throw OpenClawNativeStateError("Test coordinator could not open")
        }
        return database
    }

    private func withDirectory(_ operation: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try operation(directory)
    }
}
