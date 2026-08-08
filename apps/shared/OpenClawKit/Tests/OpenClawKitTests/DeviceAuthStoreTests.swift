import Foundation
import SQLite3
import Testing
@testable import OpenClawKit

@Suite(.serialized)
struct DeviceAuthStoreTests {
    @Test(.stateDirectoryIsolated)
    func `store and load round trip without legacy files`() throws {
        let deviceID = "device-round-trip"
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: deviceID,
            role: " node ",
            token: "unscoped-token",
            scopes: [" write ", "read", "write", " "]))
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: deviceID,
            role: "operator",
            token: "scoped-token",
            scopes: ["zeta", "alpha"],
            gatewayID: "gateway-a"))

        #expect(try DeviceAuthStore.loadToken(deviceId: deviceID, role: "node") == DeviceAuthEntry(
            token: "unscoped-token",
            role: "node",
            scopes: ["read", "write"],
            updatedAtMs: #require(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node")?.updatedAtMs)))
        let scoped = try #require(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "operator",
            gatewayID: "gateway-a"))
        #expect(scoped.role == "operator")
        #expect(scoped.gatewayID == "gateway-a")
        #expect(scoped.scopes == ["alpha", "zeta"])

        for profile in [
            GatewayDeviceIdentityProfile.primary,
            .node,
            .shareExtension,
        ] {
            #expect(try !FileManager.default.fileExists(atPath: Self.authURL(profile: profile).path))
        }
    }

    @Test(.stateDirectoryIsolated)
    func `same device id across profiles shares the token cache`() {
        let deviceID = "shared-device-id"
        // Matching device IDs imply matching key material and therefore one gateway device,
        // so profiles share this cache. The Node runtime reads device_auth_tokens only.
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: deviceID,
            role: "node",
            token: "primary-token",
            profile: .primary))
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            profile: .node)?.token == "primary-token")
    }

    @Test(.stateDirectoryIsolated)
    func `distinct device ids remain disjoint across profiles`() {
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: "primary-device",
            role: "node",
            token: "primary-token",
            profile: .primary))
        #expect(DeviceAuthStore.loadToken(
            deviceId: "node-device",
            role: "node",
            profile: .node) == nil)
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: "node-device",
            role: "node",
            token: "node-token",
            profile: .node))

        #expect(DeviceAuthStore.loadToken(
            deviceId: "primary-device",
            role: "node",
            profile: .primary)?.token == "primary-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: "node-device",
            role: "node",
            profile: .node)?.token == "node-token")
    }

    @Test(.stateDirectoryIsolated)
    func `legacy file imports once and reconstructs scoped metadata`() throws {
        let deviceID = "legacy-device"
        let gatewayID = "gateway-a"
        let scopedKey = "v2.\(Self.storageComponent(gatewayID)).\(Self.storageComponent("operator"))"
        try Self.writeLegacy(DeviceAuthStoreFile(
            version: 1,
            deviceId: deviceID,
            tokens: [
                "node": DeviceAuthEntry(
                    token: "legacy-node",
                    role: "node",
                    scopes: [" beta ", "alpha"],
                    updatedAtMs: 100),
                scopedKey: DeviceAuthEntry(
                    token: "legacy-operator",
                    role: "operator",
                    scopes: ["write"],
                    updatedAtMs: 200,
                    gatewayID: gatewayID),
            ]))

        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node")?.token == "legacy-node")
        #expect(try !FileManager.default.fileExists(atPath: Self.authURL().path))
        let scoped = try #require(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "operator",
            gatewayID: gatewayID))
        #expect(scoped.token == "legacy-operator")
        #expect(scoped.role == "operator")
        #expect(scoped.gatewayID == gatewayID)
        #expect(scoped.scopes == ["write"])
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node")?.scopes == ["alpha", "beta"])
    }

    @Test(.stateDirectoryIsolated)
    func `legacy import preserves a canonical SQLite row`() throws {
        let deviceID = "preserve-device"
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: deviceID,
            role: "node",
            token: "sqlite-token",
            scopes: ["sqlite-scope"]))
        try Self.writeLegacy(DeviceAuthStoreFile(
            version: 1,
            deviceId: deviceID,
            tokens: [
                "node": DeviceAuthEntry(
                    token: "legacy-token",
                    role: "node",
                    scopes: ["legacy-scope"],
                    updatedAtMs: 1),
            ]))

        let loaded = try #require(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node"))
        #expect(loaded.token == "sqlite-token")
        #expect(loaded.scopes == ["sqlite-scope"])
        #expect(try !FileManager.default.fileExists(atPath: Self.authURL().path))
    }

    @Test(.stateDirectoryIsolated)
    func `failed legacy removal cannot commit a clear`() throws {
        let deviceID = "removal-failure-device"
        try Self.writeLegacy(DeviceAuthStoreFile(
            version: 1,
            deviceId: deviceID,
            tokens: [
                "node": DeviceAuthEntry(
                    token: "legacy-token",
                    role: "node",
                    scopes: [],
                    updatedAtMs: 100),
            ]))
        let authURL = try Self.authURL()
        let identityDirectory = authURL.deletingLastPathComponent()
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: identityDirectory.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: identityDirectory.path)
        }

        DeviceAuthStore.clearToken(deviceId: deviceID, role: "node")

        #expect(FileManager.default.fileExists(atPath: authURL.path))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: identityDirectory.path)
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node")?.token == "legacy-token")
        #expect(!FileManager.default.fileExists(atPath: authURL.path))
    }

    @Test(.stateDirectoryIsolated)
    func `temporary legacy access failure remains retryable`() throws {
        let deviceID = "access-failure-device"
        try Self.writeLegacy(DeviceAuthStoreFile(
            version: 1,
            deviceId: deviceID,
            tokens: [
                "node": DeviceAuthEntry(
                    token: "legacy-token",
                    role: "node",
                    scopes: [],
                    updatedAtMs: 100),
            ]))
        let authURL = try Self.authURL()
        let identityDirectory = authURL.deletingLastPathComponent()
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: identityDirectory.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: identityDirectory.path)
        }

        #expect(!DeviceAuthStore.storeTokenPersisted(
            deviceId: deviceID,
            role: "operator",
            token: "must-not-persist"))

        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: identityDirectory.path)
        #expect(FileManager.default.fileExists(atPath: authURL.path))
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node")?.token == "legacy-token")
        #expect(!FileManager.default.fileExists(atPath: authURL.path))
    }

    @Test(.stateDirectoryIsolated)
    func `failed invalid-file quarantine aborts the requested write`() throws {
        let authURL = try Self.authURL()
        let identityDirectory = authURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: identityDirectory, withIntermediateDirectories: true)
        try Data([0xFF]).write(to: authURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: identityDirectory.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: identityDirectory.path)
        }

        #expect(!DeviceAuthStore.storeTokenPersisted(
            deviceId: "quarantine-device",
            role: "node",
            token: "must-not-persist"))
        #expect(FileManager.default.fileExists(atPath: authURL.path))

        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: identityDirectory.path)
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: "quarantine-device",
            role: "node",
            token: "sqlite-token"))
        #expect(DeviceAuthStore.loadToken(
            deviceId: "quarantine-device",
            role: "node")?.token == "sqlite-token")
    }

    @Test(.stateDirectoryIsolated)
    func `corrupt legacy file is quarantined and SQLite remains writable`() throws {
        let authURL = try Self.authURL()
        try FileManager.default.createDirectory(
            at: authURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try Data([0xFF, 0x00, 0xAA]).write(to: authURL)

        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: "corrupt-device",
            role: "node",
            token: "sqlite-token"))
        #expect(DeviceAuthStore.loadToken(
            deviceId: "corrupt-device",
            role: "node")?.token == "sqlite-token")
        #expect(!FileManager.default.fileExists(atPath: authURL.path))
        let quarantined = try FileManager.default.contentsOfDirectory(
            atPath: authURL.deletingLastPathComponent().path)
            .filter { $0.hasPrefix("device-auth.json.invalid-") }
        #expect(quarantined.count == 1)
    }

    @Test(.stateDirectoryIsolated)
    func `clear token distinguishes one scope from every scope`() {
        let deviceID = "clear-device"
        _ = DeviceAuthStore.storeToken(deviceId: deviceID, role: "node", token: "unscoped")
        _ = DeviceAuthStore.storeToken(
            deviceId: deviceID,
            role: "node",
            token: "gateway-a",
            gatewayID: "gateway-a")
        _ = DeviceAuthStore.storeToken(
            deviceId: deviceID,
            role: "node",
            token: "gateway-b",
            gatewayID: "gateway-b")
        _ = DeviceAuthStore.storeToken(
            deviceId: deviceID,
            role: "operator",
            token: "operator",
            gatewayID: "gateway-a")

        DeviceAuthStore.clearToken(deviceId: deviceID, role: "node", gatewayID: "gateway-a")
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node")?.token == "unscoped")
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: "gateway-a") == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: "gateway-b")?.token == "gateway-b")

        DeviceAuthStore.clearToken(deviceId: deviceID, role: "node")
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node") == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: "gateway-b") == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "operator",
            gatewayID: "gateway-a")?.token == "operator")
    }

    @Test(.stateDirectoryIsolated)
    func `clear all removes only the selected profile identity rows`() {
        let primary = DeviceIdentityStore.loadOrCreate(profile: .primary)
        let node = DeviceIdentityStore.loadOrCreate(profile: .node)
        let share = DeviceIdentityStore.loadOrCreate(profile: .shareExtension)
        _ = DeviceAuthStore.storeToken(deviceId: primary.deviceId, role: "node", token: "primary")
        _ = DeviceAuthStore.storeToken(
            deviceId: node.deviceId,
            role: "node",
            token: "node",
            profile: .node)
        _ = DeviceAuthStore.storeToken(
            deviceId: share.deviceId,
            role: "node",
            token: "share",
            profile: .shareExtension)

        DeviceAuthStore.clearAll(profile: .shareExtension)

        #expect(DeviceAuthStore.loadToken(deviceId: primary.deviceId, role: "node")?.token == "primary")
        #expect(DeviceAuthStore.loadToken(
            deviceId: node.deviceId,
            role: "node",
            profile: .node)?.token == "node")
        #expect(DeviceAuthStore.loadToken(
            deviceId: share.deviceId,
            role: "node",
            profile: .shareExtension) == nil)
    }

    @Test(.stateDirectoryIsolated)
    func `clear all without an identity leaves legacy state untouched`() throws {
        let legacy = DeviceAuthStoreFile(
            version: 1,
            deviceId: "orphaned-device",
            tokens: [
                "node": DeviceAuthEntry(
                    token: "legacy-token",
                    role: "node",
                    scopes: [],
                    updatedAtMs: 100),
            ])
        try Self.writeLegacy(legacy)
        let authURL = try Self.authURL()
        let original = try Data(contentsOf: authURL)

        DeviceAuthStore.clearAll()

        #expect(try Data(contentsOf: authURL) == original)
        #expect(try !FileManager.default.fileExists(atPath: Self.databaseURL().path))
    }

    @Test(.stateDirectoryIsolated)
    func `version zero bootstrap creates the exact composite key table`() throws {
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: "bootstrap-device",
            role: "node",
            token: "bootstrap-token"))
        let databaseURL = try Self.databaseURL()

        #expect(try Self.scalarInt(databaseURL, "PRAGMA user_version") == 0)
        #expect(try Self.scalarText(
            databaseURL,
            """
            SELECT group_concat(name || ':' || pk, ',')
            FROM (SELECT name, pk FROM pragma_table_xinfo('device_auth_tokens') WHERE pk > 0 ORDER BY cid)
            """) == "device_id:1,role:2")
        #expect(try Self.scalarText(
            databaseURL,
            """
            SELECT group_concat(name || ':' || "desc", ',')
            FROM (
              SELECT name, "desc" FROM pragma_index_xinfo('idx_device_auth_tokens_updated')
              WHERE key = 1 ORDER BY seqno
            )
            """) == "updated_at_ms:1,device_id:0,role:0")
    }

    @Test(.stateDirectoryIsolated)
    func `versioned database never synthesizes a missing auth table`() throws {
        let databaseURL = try Self.databaseURL()
        try Self.execute(databaseURL, """
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL
        ) STRICT;
        INSERT INTO schema_meta (meta_key, role, schema_version) VALUES ('primary', 'global', 6);
        PRAGMA user_version = 6;
        """)

        #expect(!DeviceAuthStore.storeTokenPersisted(
            deviceId: "versioned-device",
            role: "node",
            token: "must-not-persist"))
        #expect(try Self.scalarInt(
            databaseURL,
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'device_auth_tokens'") == 0)
    }

}

extension DeviceAuthStoreTests {
    private static func stateDirectoryURL() throws -> URL {
        let path = try #require(getenv("OPENCLAW_STATE_DIR").map { String(cString: $0) })
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    private static func databaseURL() throws -> URL {
        try self.stateDirectoryURL()
            .appendingPathComponent("state", isDirectory: true)
            .appendingPathComponent("openclaw.sqlite", isDirectory: false)
    }

    private static func authURL(
        profile: GatewayDeviceIdentityProfile = .primary) throws -> URL
    {
        try self.stateDirectoryURL()
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(profile.authFileName, isDirectory: false)
    }

    private static func writeLegacy(
        _ store: DeviceAuthStoreFile,
        profile: GatewayDeviceIdentityProfile = .primary) throws
    {
        let url = try self.authURL(profile: profile)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try JSONEncoder().encode(store).write(to: url, options: [.atomic])
    }

    private static func storageComponent(_ value: String) -> String {
        Data(value.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func execute(_ databaseURL: URL, _ sql: String) throws {
        try FileManager.default.createDirectory(
            at: databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
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
