import Foundation
import SQLite3

public struct OpenClawNativeStateError: Error, LocalizedError, Sendable {
    public let message: String

    public var errorDescription: String? {
        self.message
    }

    public init(_ message: String) {
        self.message = message
    }
}

public enum OpenClawNativeStateCanonicalTable: Sendable {
    case deviceIdentities
    case macosPortGuardianRecords
}

public enum OpenClawNativeStateSQLiteStep: Equatable, Sendable {
    case row
    case done
}

public enum OpenClawNativeStateSQLiteValueType: Equatable, Sendable {
    case integer
    case float
    case text
    case blob
    case null
}

/// Synchronous access to the shared native SQLite bootstrap surface.
/// One recursive connection lock serializes transactions and statement access.
public final class OpenClawNativeStateSQLite: @unchecked Sendable {
    // Keep aligned with OPENCLAW_STATE_SCHEMA_VERSION. Native clients never upgrade this database.
    private static let maximumSupportedSchemaVersion: Int64 = 5
    private static let defaultBusyTimeoutMilliseconds: Int32 = 5000

    private struct SchemaObject: Hashable {
        let type: String
        let name: String
    }

    private struct Column: Equatable {
        let name: String
        let type: String
        let notNull: Bool
        let primaryKeyPosition: Int32
        let hidden: Int32
    }

    private struct IndexColumn: Equatable {
        let name: String
        let descending: Bool
    }

    private struct CanonicalTable {
        let name: String
        let indexName: String
        let createSQL: String
        let columns: [Column]
        let indexColumns: [IndexColumn]

        var objects: Set<SchemaObject> {
            [
                SchemaObject(type: "index", name: self.indexName),
                SchemaObject(type: "table", name: self.name),
            ]
        }
    }

    private static let deviceIdentities = CanonicalTable(
        name: "device_identities",
        indexName: "idx_device_identities_device",
        createSQL: """
        CREATE TABLE IF NOT EXISTS device_identities (
          identity_key TEXT NOT NULL PRIMARY KEY,
          device_id TEXT NOT NULL,
          public_key_pem TEXT NOT NULL,
          private_key_pem TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_device_identities_device
          ON device_identities(device_id, updated_at_ms DESC);
        """,
        columns: [
            Column(name: "identity_key", type: "TEXT", notNull: true, primaryKeyPosition: 1, hidden: 0),
            Column(name: "device_id", type: "TEXT", notNull: true, primaryKeyPosition: 0, hidden: 0),
            Column(name: "public_key_pem", type: "TEXT", notNull: true, primaryKeyPosition: 0, hidden: 0),
            Column(name: "private_key_pem", type: "TEXT", notNull: true, primaryKeyPosition: 0, hidden: 0),
            Column(name: "created_at_ms", type: "INTEGER", notNull: true, primaryKeyPosition: 0, hidden: 0),
            Column(name: "updated_at_ms", type: "INTEGER", notNull: true, primaryKeyPosition: 0, hidden: 0),
        ],
        indexColumns: [
            IndexColumn(name: "device_id", descending: false),
            IndexColumn(name: "updated_at_ms", descending: true),
        ])

    private static let macosPortGuardianRecords = CanonicalTable(
        name: "macos_port_guardian_records",
        indexName: "idx_macos_port_guardian_records_port",
        createSQL: """
        CREATE TABLE IF NOT EXISTS macos_port_guardian_records (
          pid INTEGER NOT NULL PRIMARY KEY,
          port INTEGER NOT NULL,
          command TEXT NOT NULL,
          mode TEXT NOT NULL,
          timestamp REAL NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_macos_port_guardian_records_port
          ON macos_port_guardian_records(port, timestamp DESC);
        """,
        columns: [
            Column(name: "pid", type: "INTEGER", notNull: true, primaryKeyPosition: 1, hidden: 0),
            Column(name: "port", type: "INTEGER", notNull: true, primaryKeyPosition: 0, hidden: 0),
            Column(name: "command", type: "TEXT", notNull: true, primaryKeyPosition: 0, hidden: 0),
            Column(name: "mode", type: "TEXT", notNull: true, primaryKeyPosition: 0, hidden: 0),
            Column(name: "timestamp", type: "REAL", notNull: true, primaryKeyPosition: 0, hidden: 0),
        ],
        indexColumns: [
            IndexColumn(name: "port", descending: false),
            IndexColumn(name: "timestamp", descending: true),
        ])

    private static let canonicalTables = [
        OpenClawNativeStateSQLite.deviceIdentities,
        OpenClawNativeStateSQLite.macosPortGuardianRecords,
    ]

    private let databaseURL: URL
    fileprivate let database: OpaquePointer
    fileprivate let connectionLock = NSRecursiveLock()

    public init(databaseURL: URL, busyTimeoutMilliseconds: Int32 = 5000) throws {
        self.databaseURL = databaseURL
        try Self.secureDirectory(databaseURL.deletingLastPathComponent())
        var database: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let result = sqlite3_open_v2(databaseURL.path, &database, flags, nil)
        guard result == SQLITE_OK, let database else {
            let detail = database.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown SQLite error"
            if let database { sqlite3_close(database) }
            throw OpenClawNativeStateError("Could not open native state database: \(detail)")
        }
        var initializationSucceeded = false
        defer {
            if !initializationSucceeded { sqlite3_close(database) }
        }
        self.database = database
        let timeout = busyTimeoutMilliseconds > 0
            ? busyTimeoutMilliseconds
            : Self.defaultBusyTimeoutMilliseconds
        guard sqlite3_busy_timeout(database, timeout) == SQLITE_OK else {
            throw self.databaseError(operation: "configure SQLite busy timeout")
        }
        try Self.secureDatabaseFiles(databaseURL)
        initializationSucceeded = true
    }

    deinit {
        sqlite3_close(self.database)
        try? Self.secureDatabaseFiles(self.databaseURL)
    }

    public var changes: Int32 {
        self.withConnectionLock { sqlite3_changes(self.database) }
    }

    public func withImmediateTransaction<T>(_ body: () throws -> T) throws -> T {
        try self.withConnectionLock {
            try self.execute("BEGIN IMMEDIATE")
            var committed = false
            defer {
                if !committed { try? self.execute("ROLLBACK") }
            }
            let value = try body()
            try self.execute("COMMIT")
            committed = true
            try Self.secureDatabaseFiles(self.databaseURL)
            return value
        }
    }

    /// Creates a requested table only in an owned schema-version-zero bootstrap database.
    /// Node-owned versioned databases must already contain the canonical table.
    public func ensureCanonicalTable(
        _ table: OpenClawNativeStateCanonicalTable,
        allowVersionZeroCreation: Bool = true) throws
    {
        try self.withConnectionLock {
            let descriptor = Self.descriptor(table)
            let userVersion = try self.scalarInt64("PRAGMA user_version")
            guard userVersion <= Self.maximumSupportedSchemaVersion else {
                throw OpenClawNativeStateError(
                    "Native state database uses newer schema version \(userVersion); " +
                        "this build supports \(Self.maximumSupportedSchemaVersion)")
            }

            if userVersion == 0 {
                try self.validateVersionZeroOwnership()
                if try !self.schemaObjectExists(type: "table", name: descriptor.name) {
                    guard allowVersionZeroCreation else {
                        throw OpenClawNativeStateError(
                            "Schema version zero database is missing \(descriptor.name)")
                    }
                    try self.execute(descriptor.createSQL)
                }
                try self.validateVersionZeroOwnership()
            } else {
                try self.validateSharedDatabaseMetadata(userVersion: userVersion)
                guard try self.schemaObjectExists(type: "table", name: descriptor.name) else {
                    throw OpenClawNativeStateError(
                        "Versioned OpenClaw state database is missing \(descriptor.name)")
                }
            }
            try self.validateCanonicalTable(table)
        }
    }

    public func validateCanonicalTable(_ table: OpenClawNativeStateCanonicalTable) throws {
        try self.withConnectionLock {
            try self.validateTableShape(Self.descriptor(table))
        }
    }

    public func prepare(_ sql: String) throws -> OpenClawNativeStateSQLiteStatement {
        try self.withConnectionLock {
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(self.database, sql, -1, &statement, nil) == SQLITE_OK,
                  let statement
            else {
                throw self.databaseError(operation: "prepare SQLite statement")
            }
            return OpenClawNativeStateSQLiteStatement(connection: self, statement: statement)
        }
    }

    public func execute(_ sql: String) throws {
        try self.withConnectionLock {
            var errorMessage: UnsafeMutablePointer<CChar>?
            let result = sqlite3_exec(self.database, sql, nil, nil, &errorMessage)
            guard result == SQLITE_OK else {
                let detail = errorMessage.map { String(cString: $0) }
                    ?? String(cString: sqlite3_errmsg(self.database))
                sqlite3_free(errorMessage)
                throw OpenClawNativeStateError("SQLite operation failed: \(detail)")
            }
        }
    }

    public func scalarInt64(_ sql: String) throws -> Int64 {
        try self.withConnectionLock {
            let statement = try self.prepare(sql)
            guard try statement.step() == .row,
                  statement.valueType(at: 0) == .integer
            else {
                throw OpenClawNativeStateError("SQLite integer query did not return one integer row")
            }
            let value = statement.int64(at: 0)
            guard try statement.step() == .done else {
                throw OpenClawNativeStateError("SQLite integer query returned multiple rows")
            }
            return value
        }
    }

    public func scalarText(_ sql: String) throws -> String? {
        try self.withConnectionLock {
            let statement = try self.prepare(sql)
            let result = try statement.step()
            if result == .done { return nil }
            let value = try statement.requiredText(at: 0, field: "query result")
            guard try statement.step() == .done else {
                throw OpenClawNativeStateError("SQLite text query returned multiple rows")
            }
            return value
        }
    }

    public func schemaObjectExists(type: String, name: String) throws -> Bool {
        try self.withConnectionLock {
            let statement = try self.prepare(
                "SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ? LIMIT 1")
            try statement.bindText(type, at: 1)
            try statement.bindText(name, at: 2)
            let result = try statement.step()
            if result == .done { return false }
            guard try statement.step() == .done else {
                throw OpenClawNativeStateError("SQLite schema query returned multiple rows")
            }
            return true
        }
    }

    fileprivate func databaseError(operation: String) -> OpenClawNativeStateError {
        OpenClawNativeStateError(
            "Could not \(operation): \(String(cString: sqlite3_errmsg(self.database)))")
    }

    fileprivate func withConnectionLock<T>(_ body: () throws -> T) rethrows -> T {
        self.connectionLock.lock()
        defer { self.connectionLock.unlock() }
        return try body()
    }

    private static func descriptor(_ table: OpenClawNativeStateCanonicalTable) -> CanonicalTable {
        switch table {
        case .deviceIdentities: self.deviceIdentities
        case .macosPortGuardianRecords: self.macosPortGuardianRecords
        }
    }

    private func validateVersionZeroOwnership() throws {
        let statement = try self.prepare("""
        SELECT type, name
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
        """)
        var objects = Set<SchemaObject>()
        while try statement.step() == .row {
            try objects.insert(SchemaObject(
                type: statement.requiredText(at: 0, field: "schema object type"),
                name: statement.requiredText(at: 1, field: "schema object name")))
        }
        let allowedObjects = Self.canonicalTables.reduce(into: Set<SchemaObject>()) {
            $0.formUnion($1.objects)
        }
        guard objects.isSubset(of: allowedObjects) else {
            throw OpenClawNativeStateError(
                "Schema version zero database contains objects not owned by a native OpenClaw store")
        }

        // A known name is not enough: every present native table must be complete and exact
        // before another store composes its own schema into the same version-zero database.
        for table in Self.canonicalTables where !objects.isDisjoint(with: table.objects) {
            guard table.objects.isSubset(of: objects) else {
                throw OpenClawNativeStateError(
                    "Schema version zero database has incomplete objects for \(table.name)")
            }
            try self.validateTableShape(table)
        }
    }

    private func validateSharedDatabaseMetadata(userVersion: Int64) throws {
        guard try self.schemaObjectExists(type: "table", name: "schema_meta") else {
            throw OpenClawNativeStateError("Versioned OpenClaw state database is missing schema_meta")
        }
        let statement = try self.prepare(
            "SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
        guard try statement.step() == .row,
              try statement.requiredText(at: 0, field: "schema role") == "global",
              statement.valueType(at: 1) == .integer,
              statement.int64(at: 1) == userVersion,
              try statement.step() == .done
        else {
            throw OpenClawNativeStateError(
                "OpenClaw state database schema metadata does not match its global schema version")
        }
    }

    private func validateTableShape(_ table: CanonicalTable) throws {
        guard try self.tableColumns(table.name) == table.columns else {
            throw OpenClawNativeStateError("\(table.name) has an incompatible schema")
        }
        let tableSQL = try self.scalarText(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '\(table.name)'") ?? ""
        let normalizedTableSQL = tableSQL
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .uppercased()
        guard normalizedTableSQL.hasSuffix(") STRICT") else {
            throw OpenClawNativeStateError("\(table.name) must be a STRICT table")
        }
        guard try self.validRequiredIndex(table) else {
            throw OpenClawNativeStateError("\(table.indexName) has an incompatible schema")
        }
    }

    private func tableColumns(_ tableName: String) throws -> [Column] {
        let statement = try self.prepare("PRAGMA table_xinfo('\(tableName)')")
        var columns: [Column] = []
        while try statement.step() == .row {
            try columns.append(Column(
                name: statement.requiredText(at: 1, field: "column name"),
                type: statement.requiredText(at: 2, field: "column type").uppercased(),
                notNull: statement.int32(at: 3) == 1,
                primaryKeyPosition: statement.int32(at: 5),
                hidden: statement.int32(at: 6)))
        }
        return columns
    }

    private func validRequiredIndex(_ table: CanonicalTable) throws -> Bool {
        let list = try self.prepare("PRAGMA index_list('\(table.name)')")
        var found = false
        while try list.step() == .row {
            let name = try list.requiredText(at: 1, field: "index name")
            if name == table.indexName {
                found = try list.int32(at: 2) == 0
                    && (list.requiredText(at: 3, field: "index origin")) == "c"
                    && list.int32(at: 4) == 0
            }
        }
        guard found else { return false }

        let details = try self.prepare("PRAGMA index_xinfo('\(table.indexName)')")
        var keyColumns: [IndexColumn] = []
        while try details.step() == .row {
            guard details.int32(at: 5) == 1 else { continue }
            try keyColumns.append(IndexColumn(
                name: details.requiredText(at: 2, field: "index column"),
                descending: details.int32(at: 3) == 1))
        }
        return keyColumns == table.indexColumns
    }

    private static func secureDirectory(_ url: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        #if os(iOS) || os(watchOS)
        attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        try fileManager.setAttributes(attributes, ofItemAtPath: url.path)
    }

    static func secureDatabaseFiles(
        _ databaseURL: URL,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        setAttributes: ([FileAttributeKey: Any], String) throws -> Void = {
            try FileManager.default.setAttributes($0, ofItemAtPath: $1)
        }) throws
    {
        for (url, isTransient) in [
            (databaseURL, false),
            (URL(fileURLWithPath: databaseURL.path + "-wal", isDirectory: false), true),
            (URL(fileURLWithPath: databaseURL.path + "-shm", isDirectory: false), true),
            (URL(fileURLWithPath: databaseURL.path + "-journal", isDirectory: false), true),
        ] where fileExists(url.path) {
            var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
            #if os(iOS) || os(watchOS)
            attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
            #endif
            do {
                try setAttributes(attributes, url.path)
            } catch where isTransient && Self.isMissingFileError(error) {
                // SQLite can remove sidecars between the probe and chmod. A vanished sidecar is
                // already secure; surfacing it after COMMIT would misreport a durable write.
                continue
            }
        }
    }

    private static func isMissingFileError(_ error: Error) -> Bool {
        let error = error as NSError
        return (error.domain == NSCocoaErrorDomain && error.code == NSFileNoSuchFileError)
            || (error.domain == NSPOSIXErrorDomain
                && error.code == Int(POSIXErrorCode.ENOENT.rawValue))
    }
}

public final class OpenClawNativeStateSQLiteStatement {
    private let connection: OpenClawNativeStateSQLite
    private let statement: OpaquePointer

    fileprivate init(connection: OpenClawNativeStateSQLite, statement: OpaquePointer) {
        self.connection = connection
        self.statement = statement
    }

    deinit {
        _ = self.connection.withConnectionLock {
            sqlite3_finalize(self.statement)
        }
    }

    public func step() throws -> OpenClawNativeStateSQLiteStep {
        try self.connection.withConnectionLock {
            switch sqlite3_step(self.statement) {
            case SQLITE_ROW: .row
            case SQLITE_DONE: .done
            default: throw self.connection.databaseError(operation: "step SQLite statement")
            }
        }
    }

    public func bindText(_ value: String, at index: Int32) throws {
        try self.connection.withConnectionLock {
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            guard sqlite3_bind_text(self.statement, index, value, -1, transient) == SQLITE_OK else {
                throw self.connection.databaseError(operation: "bind SQLite text")
            }
        }
    }

    public func bindInt64(_ value: Int64, at index: Int32) throws {
        try self.connection.withConnectionLock {
            guard sqlite3_bind_int64(self.statement, index, value) == SQLITE_OK else {
                throw self.connection.databaseError(operation: "bind SQLite integer")
            }
        }
    }

    public func bindDouble(_ value: Double, at index: Int32) throws {
        try self.connection.withConnectionLock {
            guard sqlite3_bind_double(self.statement, index, value) == SQLITE_OK else {
                throw self.connection.databaseError(operation: "bind SQLite double")
            }
        }
    }

    public func valueType(at column: Int32) -> OpenClawNativeStateSQLiteValueType {
        self.connection.withConnectionLock {
            switch sqlite3_column_type(self.statement, column) {
            case SQLITE_INTEGER: .integer
            case SQLITE_FLOAT: .float
            case SQLITE_TEXT: .text
            case SQLITE_BLOB: .blob
            default: .null
            }
        }
    }

    public func int32(at column: Int32) -> Int32 {
        self.connection.withConnectionLock {
            sqlite3_column_int(self.statement, column)
        }
    }

    public func int64(at column: Int32) -> Int64 {
        self.connection.withConnectionLock {
            sqlite3_column_int64(self.statement, column)
        }
    }

    public func double(at column: Int32) -> Double {
        self.connection.withConnectionLock {
            sqlite3_column_double(self.statement, column)
        }
    }

    public func requiredText(at column: Int32, field: String) throws -> String {
        try self.connection.withConnectionLock {
            guard self.valueType(at: column) == .text,
                  let value = sqlite3_column_text(self.statement, column)
            else {
                throw OpenClawNativeStateError("SQLite \(field) must be text")
            }
            return String(cString: value)
        }
    }
}
