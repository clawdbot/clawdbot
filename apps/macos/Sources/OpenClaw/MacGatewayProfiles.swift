import CryptoKit
import Foundation
import OpenClawKit
import Security

struct MacGatewayProfile: Codable, Equatable, Identifiable, Sendable {
    let id: String
    var name: String
    var url: URL
}

enum MacGatewayProfileError: LocalizedError, Equatable {
    case invalidURL
    case insecureRemoteURL
    case profileNotFound
    case unsupportedRegistryVersion(Int)
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            "Enter a ws:// or wss:// Gateway URL."
        case .insecureRemoteURL:
            "Public Gateway hosts require wss://. Use ws:// only on loopback, a trusted private network, or Tailnet."
        case .profileNotFound:
            "That Gateway profile no longer exists."
        case let .unsupportedRegistryVersion(version):
            "Gateway profiles were written by a newer OpenClaw version (schema \(version))."
        case let .keychain(status):
            "Could not save Gateway settings in Keychain (\(status))."
        }
    }
}

/// Persistent gateway identities and credentials for independently routed windows.
/// Profiles are Keychain-backed so endpoint ownership and its secrets commit together.
actor MacGatewayProfileStore {
    static let shared = MacGatewayProfileStore()

    struct StoredProfile: Codable, Equatable {
        var profile: MacGatewayProfile
        var credentials: Credentials
    }

    struct Registry: Codable, Equatable {
        var version = 1
        var legacyPrimaryMigrationVersion: Int?
        var profiles: [StoredProfile] = []
    }

    struct Credentials: Codable, Equatable {
        var token: String?
        var password: String?
    }

    private static let service = "ai.openclaw.gateway-profiles"
    private static let registryAccount = "registry-v1"
    private static let currentLegacyPrimaryMigrationVersion = 1

    static func migratingLegacyPrimaryConnection(
        root: [String: Any],
        registry: Registry) -> Registry
    {
        guard (registry.legacyPrimaryMigrationVersion ?? 0) < self.currentLegacyPrimaryMigrationVersion else {
            return registry
        }
        var migrated = registry
        migrated.legacyPrimaryMigrationVersion = self.currentLegacyPrimaryMigrationVersion

        let mode = ConnectionModeResolver.resolve(root: root)
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        guard mode.mode == .remote,
              mode.source == .configMode || mode.source == .configRemoteURL,
              resolution.transport == .direct,
              let directURL = resolution.directURL,
              let profile = try? self.makeProfile(name: "", url: directURL),
              !migrated.profiles.contains(where: { $0.profile.id == profile.id })
        else {
            return migrated
        }

        migrated.profiles.append(StoredProfile(
            profile: profile,
            credentials: Credentials(
                token: GatewayRemoteConfig.resolveTokenString(root: root),
                password: GatewayRemoteConfig.resolvePasswordString(root: root))))
        return migrated
    }

    func upsert(
        name: String,
        url: URL,
        token: String?,
        password: String?) throws -> MacGatewayProfile
    {
        let profile = try Self.makeProfile(name: name, url: url)
        var registry = try self.loadRegistry()
        let id = profile.id
        let savedCredentials = registry.profiles.first { $0.profile.id == id }?.credentials
        let credentials = Self.resolvedCredentials(
            saved: savedCredentials,
            submittedToken: token,
            submittedPassword: password)
        registry.profiles.removeAll { $0.profile.id == id }
        registry.profiles.append(StoredProfile(profile: profile, credentials: credentials))
        // Metadata and secrets share one Keychain value, so the profile becomes
        // reachable only when the complete record commits.
        try self.saveRegistry(registry)
        return profile
    }

    func profiles() throws -> [MacGatewayProfile] {
        try Self.sortedProfiles(self.loadRegistryMigratingLegacyPrimary().profiles.map(\.profile))
    }

    func remove(profileID: String) throws {
        var registry = try self.loadRegistry()
        guard registry.profiles.contains(where: { $0.profile.id == profileID }) else {
            throw MacGatewayProfileError.profileNotFound
        }
        registry.profiles.removeAll { $0.profile.id == profileID }
        try self.saveRegistry(registry)
    }

    func endpoint(profileID: String) throws -> GatewayConnection.EndpointSnapshot {
        let registry = try self.loadRegistry()
        guard let stored = registry.profiles.first(where: { $0.profile.id == profileID }) else {
            throw MacGatewayProfileError.profileNotFound
        }
        let url = try Self.canonicalURL(stored.profile.url)
        return GatewayConnection.EndpointSnapshot(
            config: (
                url: url,
                token: stored.credentials.token,
                password: stored.credentials.password),
            tls: Self.tlsRoute(for: stored.profile),
            routeAuthority: nil,
            deviceAuthGatewayID: stored.profile.id)
    }

    private func loadRegistry() throws -> Registry {
        guard let data = try Self.load(account: Self.registryAccount) else { return Registry() }
        return try Self.decodeRegistry(data)
    }

    private func loadRegistryMigratingLegacyPrimary() throws -> Registry {
        let registry = try self.loadRegistry()
        // Keep the receipt in the registry so removing the imported profile is durable.
        // A failed Keychain commit leaves both changes unapplied and retries on the next read.
        guard (registry.legacyPrimaryMigrationVersion ?? 0) < Self.currentLegacyPrimaryMigrationVersion else {
            return registry
        }
        let migrated = Self.migratingLegacyPrimaryConnection(
            root: OpenClawConfigFile.loadDict(),
            registry: registry)
        guard migrated != registry else { return registry }
        try self.saveRegistry(migrated)
        return migrated
    }

    private func saveRegistry(_ registry: Registry) throws {
        try Self.save(JSONEncoder().encode(registry), account: Self.registryAccount)
    }

    private static func decodeRegistry(_ data: Data) throws -> Registry {
        let registry = try JSONDecoder().decode(Registry.self, from: data)
        guard registry.version == 1 else {
            throw MacGatewayProfileError.unsupportedRegistryVersion(registry.version)
        }
        return registry
    }

    static func validateRegistryData(_ data: Data) throws {
        _ = try MacGatewayProfileStore.decodeRegistry(data)
    }

    static func sortedProfiles(_ profiles: [MacGatewayProfile]) -> [MacGatewayProfile] {
        profiles.sorted { lhs, rhs in
            let nameOrder = lhs.name.localizedCaseInsensitiveCompare(rhs.name)
            if nameOrder != .orderedSame {
                return nameOrder == .orderedAscending
            }
            return lhs.url.absoluteString.localizedCaseInsensitiveCompare(rhs.url.absoluteString) == .orderedAscending
        }
    }

    private static func makeProfile(name: String, url: URL) throws -> MacGatewayProfile {
        let canonicalURL = try self.canonicalURL(url)
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return MacGatewayProfile(
            id: self.profileID(url: canonicalURL),
            name: trimmedName.isEmpty ? (canonicalURL.host ?? canonicalURL.absoluteString) : trimmedName,
            url: canonicalURL)
    }

    static func canonicalURL(_ url: URL) throws -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              ["ws", "wss"].contains(scheme),
              let host = components.host?.lowercased(),
              !host.isEmpty
        else { throw MacGatewayProfileError.invalidURL }
        if scheme == "ws", !GatewayRemoteConfig.allowsPlaintextGatewayHost(host) {
            throw MacGatewayProfileError.insecureRemoteURL
        }
        components.scheme = scheme
        components.host = host
        if components.port == nil {
            components.port = scheme == "wss" ? 443 : 18789
        }
        if components.percentEncodedPath.isEmpty {
            components.percentEncodedPath = "/"
        }
        components.fragment = nil
        guard let canonical = components.url else { throw MacGatewayProfileError.invalidURL }
        return canonical
    }

    static func profileID(url: URL) -> String {
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        return "manual-" + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    static func tlsRoute(for profile: MacGatewayProfile) -> GatewayTLSRoute? {
        GatewayTLSRoute.resolve(
            url: profile.url,
            connectionMode: .remote,
            configuredFingerprint: nil,
            storeKey: "profile:\(profile.id)")
    }

    static func resolvedCredentials(
        saved: Credentials?,
        submittedToken: String?,
        submittedPassword: String?) -> Credentials
    {
        let submitted = Credentials(
            token: Self.normalizedSecret(submittedToken),
            password: Self.normalizedSecret(submittedPassword))
        // An empty New Gateway form means "reuse this saved route", not
        // "erase its authentication". Supplying either field replaces both.
        if submitted.token == nil, submitted.password == nil {
            return saved ?? submitted
        }
        return submitted
    }

    private static func normalizedSecret(_ value: String?) -> String? {
        let value = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : nil
    }

    private static func load(account: String) throws -> Data? {
        var query = self.baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw MacGatewayProfileError.keychain(status)
        }
        return data
    }

    private static func save(_ data: Data, account: String) throws {
        let query = self.baseQuery(account: account)
        let update = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw MacGatewayProfileError.keychain(update) }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw MacGatewayProfileError.keychain(status) }
    }

    private static func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }
}

actor MacGatewayConnectionFleet {
    static let shared = MacGatewayConnectionFleet()

    private var connections: [String: GatewayConnection] = [:]

    func connection(profileID: String) -> GatewayConnection {
        if let connection = self.connections[profileID] { return connection }
        let connection = GatewayConnection(
            endpointProvider: {
                try await MacGatewayProfileStore.shared.endpoint(profileID: profileID)
            },
            supportsSharedEndpointRecovery: false)
        self.connections[profileID] = connection
        return connection
    }

    func remove(profileID: String) async {
        guard let connection = self.connections.removeValue(forKey: profileID) else { return }
        await connection.shutdown()
    }

    func shutdown() async {
        let connections = self.connections.values
        self.connections.removeAll()
        for connection in connections {
            await connection.shutdown()
        }
    }
}
