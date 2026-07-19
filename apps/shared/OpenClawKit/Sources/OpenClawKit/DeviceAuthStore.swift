import Foundation

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
    public static func loadToken(
        deviceId: String,
        role: String,
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary) -> DeviceAuthEntry?
    {
        guard let store = readStore(profile: profile), store.deviceId == deviceId else { return nil }
        guard let key = self.tokenKey(role: role, gatewayID: gatewayID) else { return nil }
        return store.tokens[key]
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
            scopes: normalizeScopes(scopes),
            updatedAtMs: Int64(Date().timeIntervalSince1970 * 1000),
            gatewayID: normalizedGatewayID)
        guard gatewayID == nil || normalizedGatewayID != nil,
              let key = self.tokenKey(role: normalizedRole, gatewayID: normalizedGatewayID)
        else { return (entry, false) }
        var next = self.readStore(profile: profile)
        if next?.deviceId != deviceId {
            next = DeviceAuthStoreFile(version: 1, deviceId: deviceId, tokens: [:])
        }
        if next == nil {
            next = DeviceAuthStoreFile(version: 1, deviceId: deviceId, tokens: [:])
        }
        next?.tokens[key] = entry
        let persisted = next.map { self.writeStore($0, profile: profile) } ?? false
        return (entry, persisted)
    }

    public static func clearToken(
        deviceId: String,
        role: String,
        gatewayID: String? = nil,
        profile: GatewayDeviceIdentityProfile = .primary)
    {
        guard var store = readStore(profile: profile), store.deviceId == deviceId else { return }
        let normalizedRole = self.normalizeRole(role)
        if gatewayID == nil {
            store.tokens = store.tokens.filter { _, entry in
                self.normalizeRole(entry.role) != normalizedRole
            }
        } else {
            guard let key = self.tokenKey(role: normalizedRole, gatewayID: gatewayID) else { return }
            store.tokens.removeValue(forKey: key)
        }
        self.writeStore(store, profile: profile)
    }

    public static func clearAll(profile: GatewayDeviceIdentityProfile = .primary) {
        try? FileManager.default.removeItem(at: self.fileURL(profile: profile))
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
        guard let gatewayID = self.normalizeGatewayID(gatewayID),
              var store = self.readStore(profile: profile),
              store.deviceId == deviceId
        else { return false }

        let normalizedRole = self.normalizeRole(role)
        guard let legacyKey = self.tokenKey(role: normalizedRole, gatewayID: nil),
              let scopedKey = self.tokenKey(role: normalizedRole, gatewayID: gatewayID)
        else { return false }
        guard let entry = store.tokens[legacyKey], entry.gatewayID == nil else { return false }
        if store.tokens[scopedKey] == nil {
            store.tokens[scopedKey] = DeviceAuthEntry(
                token: entry.token,
                role: normalizedRole,
                scopes: entry.scopes,
                updatedAtMs: entry.updatedAtMs,
                gatewayID: gatewayID)
        }
        store.tokens.removeValue(forKey: legacyKey)
        return self.writeStore(store, profile: profile)
    }

    /// Removes legacy tokens when the app cannot prove which gateway issued them.
    @discardableResult
    public static func discardUnscopedTokens(
        deviceId: String,
        profile: GatewayDeviceIdentityProfile = .primary) -> Int
    {
        guard var store = self.readStore(profile: profile), store.deviceId == deviceId else { return 0 }
        let legacyKeys = store.tokens.compactMap { key, entry in entry.gatewayID == nil ? key : nil }
        guard !legacyKeys.isEmpty else { return 0 }
        for key in legacyKeys {
            store.tokens.removeValue(forKey: key)
        }
        return self.writeStore(store, profile: profile) ? legacyKeys.count : 0
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

    private static func fileURL(profile: GatewayDeviceIdentityProfile) -> URL {
        DeviceIdentityPaths.stateDirURL()
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(profile.authFileName, isDirectory: false)
    }

    private static func readStore(profile: GatewayDeviceIdentityProfile) -> DeviceAuthStoreFile? {
        let url = self.fileURL(profile: profile)
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let decoded = try? JSONDecoder().decode(DeviceAuthStoreFile.self, from: data) else {
            return nil
        }
        return self.normalizedStore(decoded)
    }

    static func normalizedStore(_ decoded: DeviceAuthStoreFile) -> DeviceAuthStoreFile? {
        guard decoded.version == 1 else { return nil }
        // Entries carry their owner, so reads and identity migration compare one canonical
        // role/scope/owner map instead of raw JSON key order or legacy dictionary keys.
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
                if existing.updatedAtMs > normalized.updatedAtMs {
                    continue
                }
                if existing.updatedAtMs == normalized.updatedAtMs, existing != normalized {
                    return nil
                }
            }
            tokens[key] = normalized
        }
        return DeviceAuthStoreFile(version: 1, deviceId: decoded.deviceId, tokens: tokens)
    }

    @discardableResult
    private static func writeStore(
        _ store: DeviceAuthStoreFile,
        profile: GatewayDeviceIdentityProfile) -> Bool
    {
        let url = self.fileURL(profile: profile)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(store)
            try data.write(to: url, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            return true
        } catch {
            return false
        }
    }
}
