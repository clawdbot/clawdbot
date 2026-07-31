import Foundation
import OpenClawNativeState

public struct DeviceAuthEntry: Codable, Sendable, Equatable {
    public let token: String
    public let role: String
    public let scopes: [String]
    public let updatedAtMs: Int64
    public let gatewayID: String?

    public init(token: String, role: String, scopes: [String], updatedAtMs: Int64, gatewayID: String? = nil) {
        self.token = token
        self.role = role
        self.scopes = scopes
        self.updatedAtMs = updatedAtMs
        self.gatewayID = gatewayID
    }
}

struct DeviceAuthStoreFile: Codable, Equatable {
    var version: Int
    var deviceId: String
    var tokens: [String: DeviceAuthEntry]
}

public enum DeviceAuthStore {
    private typealias Database = OpenClawNativeStateSQLite

    static let maximumLegacyAuthBytes = 4 * 1024 * 1024
    private static let busyTimeoutMilliseconds: Int32 = 30000

    private enum LegacyImport {
        case missing
        case valid(DeviceAuthStoreFile)
        case invalid
    }

    public static func loadToken(
        deviceId: String,
        role: String,
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary) -> DeviceAuthEntry?
    {
        guard let key = self.tokenKey(role: role, gatewayID: gatewayID) else { return nil }
        return try? self.withStore(profile: profile) { database in
            try self.readEntry(database, deviceId: deviceId, storedRole: key)
        }
    }

    public static func storeToken(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = [],
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary) -> DeviceAuthEntry
    {
        self.storeTokenResult(
            deviceId: deviceId,
            role: role,
            token: token,
            scopes: scopes,
            gatewayID: gatewayID,
            profile: profile).entry
    }

    /// Stores a token and reports whether the durable write succeeded.
    @discardableResult
    public static func storeTokenPersisted(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = [],
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary) -> Bool
    {
        self.storeTokenResult(
            deviceId: deviceId,
            role: role,
            token: token,
            scopes: scopes,
            gatewayID: gatewayID,
            profile: profile).persisted
    }

    static func storeTokenResult(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = [],
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary) -> (entry: DeviceAuthEntry, persisted: Bool)
    {
        let normalizedRole = self.normalizeRole(role)
        let normalizedGatewayID = self.normalizeGatewayID(gatewayID)
        let entry = DeviceAuthEntry(
            token: token,
            role: normalizedRole,
            scopes: self.normalizeScopes(scopes),
            updatedAtMs: Int64(Date().timeIntervalSince1970 * 1000),
            gatewayID: normalizedGatewayID)
        guard gatewayID == nil || normalizedGatewayID != nil,
              let key = self.tokenKey(role: normalizedRole, gatewayID: normalizedGatewayID)
        else { return (entry, false) }
        let persisted = (try? self.withStore(profile: profile) { database in
            // SQLite intentionally keeps tokens for multiple devices instead of replacing the old file owner.
            try self.upsertEntry(database, deviceId: deviceId, storedRole: key, entry: entry)
            return true
        }) ?? false
        return (entry, persisted)
    }

    public static func clearToken(
        deviceId: String,
        role: String,
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary)
    {
        let normalizedRole = self.normalizeRole(role)
        if gatewayID == nil {
            try? self.withStore(profile: profile) { database in
                for key in try self.storedRoles(database, deviceId: deviceId)
                    where self.normalizeRole(self.decodeTokenKey(key).role) == normalizedRole
                {
                    try self.deleteEntry(database, deviceId: deviceId, storedRole: key)
                }
            }
        } else if let key = self.tokenKey(role: normalizedRole, gatewayID: gatewayID) {
            try? self.withStore(profile: profile) { database in
                try self.deleteEntry(database, deviceId: deviceId, storedRole: key)
            }
        }
    }

    public static func clearAll(profile: GatewayDeviceIdentityProfile = .primary) {
        let stateDirectoryURL = DeviceIdentityPaths.stateDirURL()
        let databaseURL = stateDirectoryURL
            .appendingPathComponent("state", isDirectory: true)
            .appendingPathComponent("openclaw.sqlite", isDirectory: false)
        guard let identity = try? DeviceIdentitySQLiteStore.loadExisting(
            databaseURL: databaseURL,
            profile: profile)
        else { return }
        try? self.withStore(profile: profile) { database in
            let statement = try database.prepare("DELETE FROM device_auth_tokens WHERE device_id = ?")
            try statement.bindText(identity.deviceId, at: 1)
            _ = try statement.step()
        }
    }

    /// Claims one legacy role token for a caller-proven gateway identity.
    /// Roles can have different gateway owners, so bulk migration is never safe.
    @discardableResult
    public static func migrateUnscopedToken(
        deviceId: String,
        role: String,
        toGatewayID gatewayID: String,
        profile: GatewayDeviceIdentityProfile = .primary) -> Bool
    {
        guard let gatewayID = self.normalizeGatewayID(gatewayID) else { return false }
        let normalizedRole = self.normalizeRole(role)
        guard let legacyKey = self.tokenKey(role: normalizedRole, gatewayID: nil),
              let scopedKey = self.tokenKey(role: normalizedRole, gatewayID: gatewayID)
        else { return false }
        return (try? self.withStore(profile: profile) { database in
            guard let entry = try self.readEntry(database, deviceId: deviceId, storedRole: legacyKey),
                  entry.gatewayID == nil
            else { return false }
            if try !self.storedRoles(database, deviceId: deviceId).contains(scopedKey) {
                try self.upsertEntry(
                    database,
                    deviceId: deviceId,
                    storedRole: scopedKey,
                    entry: DeviceAuthEntry(
                        token: entry.token,
                        role: normalizedRole,
                        scopes: entry.scopes,
                        updatedAtMs: entry.updatedAtMs,
                        gatewayID: gatewayID))
            }
            try self.deleteEntry(database, deviceId: deviceId, storedRole: legacyKey)
            return true
        }) ?? false
    }

    /// Removes legacy tokens when the app cannot prove which gateway issued them.
    @discardableResult
    public static func discardUnscopedTokens(
        deviceId: String,
        profile: GatewayDeviceIdentityProfile = .primary) -> Int
    {
        (try? self.withStore(profile: profile) { database in
            let keys = try self.storedRoles(database, deviceId: deviceId)
                .filter { self.decodeTokenKey($0).gatewayID == nil }
            for key in keys {
                try self.deleteEntry(database, deviceId: deviceId, storedRole: key)
            }
            return keys.count
        }) ?? 0
    }

    static func importLegacyStore(
        _ store: DeviceAuthStoreFile,
        stateDirectoryURL: URL,
        profile: GatewayDeviceIdentityProfile) throws
    {
        try self.withStore(stateDirectoryURL: stateDirectoryURL, profile: profile) { database in
            try self.importLegacyStore(store, into: database)
        }
    }

    static func normalizedStore(_ decoded: DeviceAuthStoreFile) -> DeviceAuthStoreFile? {
        guard decoded.version == 1 else { return nil }
        // Entries carry their owner, so migration compares one canonical role/scope/owner map
        // instead of depending on raw JSON key order or obsolete dictionary keys.
        var tokens: [String: DeviceAuthEntry] = [:]
        for entry in decoded.tokens.values {
            let role = self.normalizeRole(entry.role)
            let gatewayID = self.normalizeGatewayID(entry.gatewayID)
            guard entry.gatewayID == nil || gatewayID != nil,
                  let key = self.tokenKey(role: role, gatewayID: gatewayID)
            else { continue }
            let normalized = DeviceAuthEntry(
                token: entry.token,
                role: role,
                scopes: self.normalizeScopes(entry.scopes),
                updatedAtMs: entry.updatedAtMs,
                gatewayID: gatewayID)
            if let existing = tokens[key] {
                if existing.updatedAtMs > normalized.updatedAtMs { continue }
                if existing.updatedAtMs == normalized.updatedAtMs, existing != normalized { return nil }
            }
            tokens[key] = normalized
        }
        return DeviceAuthStoreFile(version: 1, deviceId: decoded.deviceId, tokens: tokens)
    }

    private static func withStore<Value>(
        profile: GatewayDeviceIdentityProfile,
        _ body: (Database) throws -> Value) throws -> Value
    {
        try self.withStore(
            stateDirectoryURL: DeviceIdentityPaths.stateDirURL(),
            profile: profile,
            body)
    }

    private static func withStore<Value>(
        stateDirectoryURL: URL,
        profile: GatewayDeviceIdentityProfile,
        _ body: (Database) throws -> Value) throws -> Value
    {
        let legacyURL = self.legacyFileURL(stateDirectoryURL: stateDirectoryURL, profile: profile)
        let legacy = try self.readLegacyStore(legacyURL)
        if case .invalid = legacy {
            try self.quarantineInvalidLegacyFile(legacyURL)
        }
        let database = try self.openDatabase(stateDirectoryURL: stateDirectoryURL)
        if case let .valid(store) = legacy {
            try database.withImmediateTransaction {
                try database.ensureCanonicalTable(.deviceAuthTokens)
                try self.importLegacyStore(store, into: database)
            }
            try self.removeLegacyFile(legacyURL)
        }
        // Retire legacy state before a clear can commit; otherwise a crash could reimport a revoked row.
        return try database.withImmediateTransaction {
            try database.ensureCanonicalTable(.deviceAuthTokens)
            return try body(database)
        }
    }

    private static func openDatabase(stateDirectoryURL: URL) throws -> Database {
        try Database(
            databaseURL: stateDirectoryURL
                .appendingPathComponent("state", isDirectory: true)
                .appendingPathComponent("openclaw.sqlite", isDirectory: false),
            busyTimeoutMilliseconds: self.busyTimeoutMilliseconds)
    }

    private static func importLegacyStore(
        _ store: DeviceAuthStoreFile,
        into database: Database) throws
    {
        for (key, entry) in store.tokens.sorted(by: { $0.key < $1.key }) {
            if try self.rowIsCanonical(database, deviceId: store.deviceId, storedRole: key) {
                continue
            }
            try self.upsertEntry(database, deviceId: store.deviceId, storedRole: key, entry: entry)
        }
    }

    private static func readEntry(
        _ database: Database,
        deviceId: String,
        storedRole: String) throws -> DeviceAuthEntry?
    {
        let statement = try database.prepare("""
        SELECT token, scopes_json, updated_at_ms
        FROM device_auth_tokens
        WHERE device_id = ? AND role = ?
        """)
        try statement.bindText(deviceId, at: 1)
        try statement.bindText(storedRole, at: 2)
        guard try statement.step() == .row else { return nil }
        let token = try statement.requiredText(at: 0, field: "device auth token")
        let scopesJSON = try statement.requiredText(at: 1, field: "device auth scopes_json")
        let updatedAtMs = statement.int64(at: 2)
        guard statement.valueType(at: 2) == .integer,
              let scopes = self.decodeScopes(scopesJSON)
        else { return nil }
        let decoded = self.decodeTokenKey(storedRole)
        return DeviceAuthEntry(
            token: token,
            role: decoded.role,
            scopes: scopes,
            updatedAtMs: updatedAtMs,
            gatewayID: decoded.gatewayID)
    }

    private static func upsertEntry(
        _ database: Database,
        deviceId: String,
        storedRole: String,
        entry: DeviceAuthEntry) throws
    {
        let scopesData = try JSONEncoder().encode(self.normalizeScopes(entry.scopes))
        guard let scopes = String(bytes: scopesData, encoding: .utf8) else {
            throw OpenClawNativeStateError("failed to encode device auth scopes as UTF-8")
        }
        let statement = try database.prepare("""
        INSERT INTO device_auth_tokens (device_id, role, token, scopes_json, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(device_id, role) DO UPDATE SET
          token = excluded.token,
          scopes_json = excluded.scopes_json,
          updated_at_ms = excluded.updated_at_ms
        """)
        try statement.bindText(deviceId, at: 1)
        try statement.bindText(storedRole, at: 2)
        try statement.bindText(entry.token, at: 3)
        try statement.bindText(scopes, at: 4)
        try statement.bindInt64(entry.updatedAtMs, at: 5)
        _ = try statement.step()
    }

    private static func storedRoles(
        _ database: Database,
        deviceId: String) throws -> [String]
    {
        let statement = try database.prepare(
            "SELECT role FROM device_auth_tokens WHERE device_id = ? ORDER BY role")
        try statement.bindText(deviceId, at: 1)
        var keys: [String] = []
        while try statement.step() == .row {
            try keys.append(statement.requiredText(at: 0, field: "device auth role"))
        }
        return keys
    }

    private static func rowIsCanonical(
        _ database: Database,
        deviceId: String,
        storedRole: String) throws -> Bool
    {
        let statement = try database.prepare(
            "SELECT scopes_json FROM device_auth_tokens WHERE device_id = ? AND role = ?")
        try statement.bindText(deviceId, at: 1)
        try statement.bindText(storedRole, at: 2)
        guard try statement.step() == .row else { return false }
        let scopesJSON = try statement.requiredText(at: 0, field: "device auth scopes_json")
        return self.jsonArray(scopesJSON) != nil
    }

    private static func deleteEntry(
        _ database: Database,
        deviceId: String,
        storedRole: String) throws
    {
        let statement = try database.prepare(
            "DELETE FROM device_auth_tokens WHERE device_id = ? AND role = ?")
        try statement.bindText(deviceId, at: 1)
        try statement.bindText(storedRole, at: 2)
        _ = try statement.step()
    }

    private static func decodeScopes(_ rawJSON: String) -> [String]? {
        guard let values = self.jsonArray(rawJSON) else { return nil }
        return self.normalizeScopes(values.compactMap { $0 as? String })
    }

    private static func jsonArray(_ rawJSON: String) -> [Any]? {
        guard let data = rawJSON.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [Any]
    }

    private static func decodeTokenKey(_ key: String) -> (role: String, gatewayID: String?) {
        let parts = key.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "v2",
              let gatewayID = self.decodeStorageComponent(String(parts[1])),
              let role = self.decodeStorageComponent(String(parts[2]))
        else { return (key, nil) }
        return (role, gatewayID)
    }

    private static func decodeStorageComponent(_ value: String) -> String? {
        let base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: padded) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func normalizeRole(_ role: String) -> String {
        role.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalizeGatewayID(_ gatewayID: String?) -> String? {
        guard let gatewayID, !gatewayID.isEmpty else { return nil }
        return gatewayID
    }

    private static func tokenKey(role: String, gatewayID: String?) -> String? {
        let normalizedRole = self.normalizeRole(role)
        guard !normalizedRole.isEmpty else { return nil }
        guard let gatewayID else { return normalizedRole }
        guard let gatewayID = self.normalizeGatewayID(gatewayID) else { return nil }
        // Swift String dictionary keys apply canonical equivalence. ASCII-encode both
        // byte sequences so distinct gateway owners cannot address the same token.
        return "v2.\(self.storageComponent(gatewayID)).\(self.storageComponent(normalizedRole))"
    }

    private static func storageComponent(_ value: String) -> String {
        Data(value.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func normalizeScopes(_ scopes: [String]) -> [String] {
        let trimmed = scopes
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return Array(Set(trimmed)).sorted()
    }

    private static func legacyFileURL(
        stateDirectoryURL: URL,
        profile: GatewayDeviceIdentityProfile) -> URL
    {
        stateDirectoryURL
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(profile.authFileName, isDirectory: false)
    }

    private static func readLegacyStore(_ url: URL) throws -> LegacyImport {
        let attributes: [FileAttributeKey: Any]
        do {
            attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        } catch where self.isMissingFileError(error) {
            return .missing
        }
        guard let size = attributes[.size] as? NSNumber,
              size.intValue <= self.maximumLegacyAuthBytes,
              attributes[.type] as? FileAttributeType == .typeRegular
        else { return .invalid }
        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: self.maximumLegacyAuthBytes + 1) ?? Data()
            guard data.count <= self.maximumLegacyAuthBytes,
                  let decoded = try? JSONDecoder().decode(DeviceAuthStoreFile.self, from: data),
                  let normalized = self.normalizedStore(decoded)
            else { return .invalid }
            return .valid(normalized)
        } catch where self.isMissingFileError(error) {
            return .missing
        }
    }

    private static func quarantineInvalidLegacyFile(_ url: URL) throws {
        let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        let destinationURL = URL(
            fileURLWithPath: "\(url.path).invalid-\(timestamp)",
            isDirectory: false)
        do {
            try FileManager.default.moveItem(at: url, to: destinationURL)
        } catch where self.isMissingFileError(error) {
            return
        }
    }

    private static func removeLegacyFile(_ url: URL) throws {
        do {
            try FileManager.default.removeItem(at: url)
        } catch where self.isMissingFileError(error) {
            return
        }
    }

    static func isMissingFileError(_ error: Error) -> Bool {
        let error = error as NSError
        return (error.domain == NSCocoaErrorDomain
            && (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError))
            || (error.domain == NSPOSIXErrorDomain
                && error.code == Int(POSIXErrorCode.ENOENT.rawValue))
    }
}
