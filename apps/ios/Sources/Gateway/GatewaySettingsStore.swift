import Foundation
import OpenClawKit
import os

enum GatewayCredentialPersistenceError: Error, Equatable, LocalizedError {
    case invalidOwner
    case encodingFailed
    case keychain(GenericPasswordKeychainStore.MutationError)

    var errorDescription: String? {
        switch self {
        case .invalidOwner:
            "Gateway credential owner is invalid."
        case .encodingFailed:
            "Gateway credential encoding failed."
        case let .keychain(error):
            error.localizedDescription
        }
    }
}

enum GatewaySettingsStore {
    private static let productionGatewayService = "ai.openclawfoundation.app.gateway"
    private static var gatewayService: String {
        #if DEBUG
        // Hosted tests share the app's Keychain access group; keep fixtures away from installed-app state.
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
            return "\(self.productionGatewayService).tests"
        }
        #endif
        return self.productionGatewayService
    }

    #if DEBUG
    static var _testGatewayService: String {
        self.gatewayService
    }
    #endif
    private static let nodeService = "ai.openclawfoundation.app.node"
    private static let talkService = "ai.openclawfoundation.app.talk"

    private static let instanceIdDefaultsKey = "node.instanceId"
    private static let preferredGatewayStableIDDefaultsKey = "gateway.preferredStableID"
    private static let lastDiscoveredGatewayStableIDDefaultsKey = "gateway.lastDiscoveredStableID"
    private static let lastGatewayKindDefaultsKey = "gateway.last.kind"
    private static let lastGatewayHostDefaultsKey = "gateway.last.host"
    private static let lastGatewayPortDefaultsKey = "gateway.last.port"
    private static let lastGatewayTlsDefaultsKey = "gateway.last.tls"
    private static let lastGatewayStableIDDefaultsKey = "gateway.last.stableID"
    private static let clientIdOverrideDefaultsPrefix = "gateway.clientIdOverride."
    private static let selectedAgentDefaultsPrefix = "gateway.selectedAgentId."

    private static let instanceIdAccount = "instanceId"
    private static let preferredGatewayStableIDAccount = "preferredStableID"
    private static let lastDiscoveredGatewayStableIDAccount = "lastDiscoveredStableID"
    private static let gatewayRegistryAccount = "gateway-registry"
    private static let lastGatewayConnectionAccount = "lastConnection"
    private static let gatewayCustomHeadersService = "ai.openclawfoundation.app.gateway.custom-headers"
    private static let talkProviderApiKeyAccountPrefix = "provider.apiKey." // pragma: allowlist secret

    struct GatewayRegistryEntry: Codable, Equatable, Identifiable, Sendable {
        enum Kind: String, Codable, Sendable {
            case manual
            case discovered
        }

        var stableID: String
        var kind: Kind
        var name: String
        var host: String?
        var port: Int?
        var useTLS: Bool
        var lastConnectedAtMs: Int?

        var id: GatewayStableIdentifier.Key {
            GatewayStableIdentifier.Key(self.stableID)
        }

        static func == (lhs: Self, rhs: Self) -> Bool {
            GatewayStableIdentifier.matches(lhs.stableID, rhs.stableID) &&
                lhs.kind == rhs.kind &&
                lhs.name == rhs.name &&
                lhs.host == rhs.host &&
                lhs.port == rhs.port &&
                lhs.useTLS == rhs.useTLS &&
                lhs.lastConnectedAtMs == rhs.lastConnectedAtMs
        }
    }

    struct GatewayCredentialMetadata: Codable, Equatable {
        let gatewayStableID: String
        let suppressStoredDeviceAuth: Bool
    }

    /// Credential ownership and secrets must move together. Separate Keychain
    /// entries can survive a partial update and bind one gateway's secret to another.
    private struct GatewayCredentialBundle: Codable {
        let gatewayStableID: String
        let suppressStoredDeviceAuth: Bool
        let token: String?
        let bootstrapToken: String?
        let password: String?

        var hasCredentials: Bool {
            self.token != nil || self.bootstrapToken != nil || self.password != nil
        }
    }

    struct GatewayCredentials: Equatable {
        let token: String?
        let bootstrapToken: String?
        let password: String?
        let suppressStoredDeviceAuth: Bool

        static let empty = GatewayCredentials(
            token: nil,
            bootstrapToken: nil,
            password: nil,
            suppressStoredDeviceAuth: false)

        var hasCredentials: Bool {
            self.token != nil || self.bootstrapToken != nil || self.password != nil
        }
    }

    static func bootstrapPersistence() {
        self.ensureStableInstanceID()
        self.ensurePreferredGatewayStableID()
        self.ensureLastDiscoveredGatewayStableID()
        self.migrateGatewayRegistryIfNeeded()
        if let instanceID = self.loadStableInstanceID() {
            self.migrateGatewayCredentialBundleIfNeeded(instanceId: instanceID)
        }
    }

    static func currentInstanceID(defaults: UserDefaults = .standard) -> String {
        self.bootstrapPersistence()
        if let value = defaults.string(forKey: self.instanceIdDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }
        return self.loadStableInstanceID() ?? ""
    }

    static func loadStableInstanceID() -> String? {
        if let value = KeychainStore.loadString(service: self.nodeService, account: self.instanceIdAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }

        return nil
    }

    static func saveStableInstanceID(_ instanceId: String) {
        _ = KeychainStore.saveString(instanceId, service: self.nodeService, account: self.instanceIdAccount)
    }

    static func loadPreferredGatewayStableID() -> String? {
        GatewayStableIdentifier.exact(KeychainStore.loadString(
            service: self.gatewayService,
            account: self.preferredGatewayStableIDAccount))
    }

    static func savePreferredGatewayStableID(_ stableID: String) {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return }
        _ = KeychainStore.saveString(
            stableID,
            service: self.gatewayService,
            account: self.preferredGatewayStableIDAccount)
    }

    static func clearPreferredGatewayStableID(defaults: UserDefaults = .standard) {
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.preferredGatewayStableIDAccount)
        defaults.removeObject(forKey: self.preferredGatewayStableIDDefaultsKey)
    }

    static func loadLastDiscoveredGatewayStableID() -> String? {
        GatewayStableIdentifier.exact(KeychainStore.loadString(
            service: self.gatewayService,
            account: self.lastDiscoveredGatewayStableIDAccount))
    }

    static func saveLastDiscoveredGatewayStableID(_ stableID: String) {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return }
        _ = KeychainStore.saveString(
            stableID,
            service: self.gatewayService,
            account: self.lastDiscoveredGatewayStableIDAccount)
    }

    static func clearLastDiscoveredGatewayStableID(defaults: UserDefaults = .standard) {
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.lastDiscoveredGatewayStableIDAccount)
        defaults.removeObject(forKey: self.lastDiscoveredGatewayStableIDDefaultsKey)
    }

    static func loadGatewayCredentialMetadata(
        instanceId: String,
        gatewayStableID: String) -> GatewayCredentialMetadata?
    {
        guard let bundle = self.loadGatewayCredentialBundle(
            instanceId: instanceId,
            gatewayStableID: gatewayStableID)
        else { return nil }
        return GatewayCredentialMetadata(
            gatewayStableID: bundle.gatewayStableID,
            suppressStoredDeviceAuth: bundle.suppressStoredDeviceAuth)
    }

    static func loadGatewayCredentials(instanceId: String, gatewayStableID: String) -> GatewayCredentials {
        let stableID = self.authenticationOwnerID(routeStableID: gatewayStableID)
        guard !stableID.isEmpty,
              let bundle = self.loadGatewayCredentialBundle(
                  instanceId: instanceId,
                  gatewayStableID: stableID)
        else { return .empty }
        return GatewayCredentials(
            token: bundle.token,
            bootstrapToken: bundle.bootstrapToken,
            password: bundle.password,
            suppressStoredDeviceAuth: bundle.suppressStoredDeviceAuth)
    }

    @discardableResult
    static func saveGatewayCredentials(
        token: String?,
        bootstrapToken: String?,
        password: String?,
        gatewayStableID: String,
        suppressStoredDeviceAuth: Bool,
        instanceId: String) -> Bool
    {
        do {
            try self.persistGatewayCredentials(
                token: token,
                bootstrapToken: bootstrapToken,
                password: password,
                gatewayStableID: gatewayStableID,
                suppressStoredDeviceAuth: suppressStoredDeviceAuth,
                instanceId: instanceId)
            return true
        } catch {
            GatewayDiagnostics.log("gateway credential persistence failed: \(error.localizedDescription)")
            return false
        }
    }

    @discardableResult
    static func updateGatewayCredentials(
        token: String?,
        password: String?,
        gatewayStableID: String,
        instanceId: String) -> Bool
    {
        let stableID = self.authenticationOwnerID(routeStableID: gatewayStableID)
        let existing = self.loadGatewayCredentialBundle(
            instanceId: instanceId,
            gatewayStableID: stableID)
        return self.saveGatewayCredentials(
            token: token,
            bootstrapToken: existing?.bootstrapToken,
            password: password,
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: existing?.suppressStoredDeviceAuth == true,
            instanceId: instanceId)
    }

    static func discardUnscopedGatewayCredentials(instanceId: String) {
        // The legacy UI saved fields before a successful connection, so the last route
        // cannot prove who owns these secrets. Re-entry is safer than cross-gateway reuse.
        self.deleteLegacyGatewayCredentials(instanceId: instanceId)
    }

    /// Certificate pins prove transport trust for one route; they are not gateway identities.
    /// Wildcard certificates and reverse proxies may legitimately reuse a leaf certificate.
    static func authenticationOwnerID(routeStableID: String) -> String {
        GatewayStableIdentifier.exact(routeStableID) ?? ""
    }

    /// Custom proxy headers are per-gateway credentials (Cloudflare Access-style service
    /// tokens). They live in the Keychain like the other gateway secrets and are read at
    /// connect time; never log their values.
    static func loadGatewayCustomHeaders(gatewayStableID: String) -> [String: String] {
        self.loadGatewayCustomHeaders(gatewayStableID: gatewayStableID, service: self.gatewayCustomHeadersService)
    }

    static func loadGatewayCustomHeaders(
        gatewayStableID: String,
        service: String) -> [String: String]
    {
        let stableID = self.authenticationOwnerID(routeStableID: gatewayStableID)
        guard !stableID.isEmpty else { return [:] }
        let account = self.customHeadersAccount(stableID: stableID)
        let legacyAccount = self.legacyCustomHeadersAccount(stableID: stableID)
        let canonicalJSON = KeychainStore.loadString(service: service, account: account)
        let legacyJSON = self.canSafelyReadLegacyRawStorageKey(stableID)
            ? KeychainStore.loadString(service: service, account: legacyAccount)
            : nil
        guard let json = canonicalJSON ?? legacyJSON,
              let data = json.data(using: .utf8),
              let headers = try? JSONDecoder().decode([String: String].self, from: data)
        else { return [:] }
        if canonicalJSON == nil,
           KeychainStore.saveString(json, service: service, account: account)
        {
            _ = KeychainStore.delete(service: service, account: legacyAccount)
        }
        return GatewayCustomHeaders.sanitized(headers)
    }

    @discardableResult
    static func saveGatewayCustomHeaders(_ headers: [String: String], gatewayStableID: String) -> Bool {
        self.saveGatewayCustomHeaders(
            headers,
            gatewayStableID: gatewayStableID,
            service: self.gatewayCustomHeadersService)
    }

    @discardableResult
    static func saveGatewayCustomHeaders(
        _ headers: [String: String],
        gatewayStableID: String,
        service: String) -> Bool
    {
        let stableID = self.authenticationOwnerID(routeStableID: gatewayStableID)
        guard !stableID.isEmpty else { return false }
        let sanitized = GatewayCustomHeaders.sanitized(headers)
        guard !sanitized.isEmpty else {
            return self.clearGatewayCustomHeaders(gatewayStableID: stableID, service: service)
        }
        let account = self.customHeadersAccount(stableID: stableID)
        guard let data = try? JSONEncoder().encode(sanitized),
              let json = String(data: data, encoding: .utf8)
        else { return false }
        guard KeychainStore.saveString(json, service: service, account: account) else { return false }
        if self.canSafelyReadLegacyRawStorageKey(stableID) {
            _ = KeychainStore.delete(
                service: service,
                account: self.legacyCustomHeadersAccount(stableID: stableID))
        }
        return true
    }

    /// Full onboarding reset is the explicit forget boundary for every gateway's proxy secrets.
    @discardableResult
    static func clearGatewayCustomHeaders() -> Bool {
        self.clearGatewayCustomHeaders(service: self.gatewayCustomHeadersService)
    }

    @discardableResult
    static func clearGatewayCustomHeaders(gatewayStableID: String) -> Bool {
        self.clearGatewayCustomHeaders(
            gatewayStableID: gatewayStableID,
            service: self.gatewayCustomHeadersService)
    }

    @discardableResult
    static func clearGatewayCustomHeaders(gatewayStableID: String, service: String) -> Bool {
        let stableID = self.authenticationOwnerID(routeStableID: gatewayStableID)
        guard !stableID.isEmpty else { return false }
        let account = self.customHeadersAccount(stableID: stableID)
        let canonicalDeleted = KeychainStore.delete(service: service, account: account)
        var legacyCleared = true
        if self.canSafelyReadLegacyRawStorageKey(stableID) {
            let legacyAccount = self.legacyCustomHeadersAccount(stableID: stableID)
            let legacyDeleted = KeychainStore.delete(service: service, account: legacyAccount)
            legacyCleared = legacyDeleted || KeychainStore.loadString(service: service, account: legacyAccount) == nil
        }
        let canonicalCleared = canonicalDeleted || KeychainStore.loadString(service: service, account: account) == nil
        return canonicalCleared && legacyCleared
    }

    @discardableResult
    static func clearGatewayCustomHeaders(service: String) -> Bool {
        KeychainStore.deleteAll(service: service)
    }

    private static func customHeadersAccount(stableID: String) -> String {
        "customHeaders.v2.\(GatewayStableIdentifier.storageComponent(stableID)!)"
    }

    private static func legacyCustomHeadersAccount(stableID: String) -> String {
        "customHeaders.\(stableID)"
    }

    @discardableResult
    static func migrateProvenRelayCredentials(
        instanceId: String,
        gatewayStableID: String,
        token: String?,
        password: String?) -> Bool
    {
        let trimmedInstanceID = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let stableID = GatewayStableIdentifier.exact(gatewayStableID),
              !trimmedInstanceID.isEmpty
        else { return false }
        let legacyAccounts = [
            self.gatewayTokenAccount(instanceId: trimmedInstanceID),
            self.gatewayBootstrapTokenAccount(instanceId: trimmedInstanceID),
            self.gatewayPasswordAccount(instanceId: trimmedInstanceID),
        ]
        let hasLegacyCredentials = legacyAccounts.contains { account in
            self.normalizedCredential(KeychainStore.loadString(
                service: self.gatewayService,
                account: account)) != nil
        }
        guard hasLegacyCredentials else { return true }

        // A canonical bundle already owns the fields atomically. Never replace it with
        // older relay data merely because legacy per-field entries still exist.
        if self.loadGatewayCredentialBundle(
            instanceId: trimmedInstanceID,
            gatewayStableID: stableID) != nil
        {
            self.deleteLegacyGatewayCredentials(instanceId: trimmedInstanceID)
            return true
        }

        let relayToken = self.normalizedCredential(token)
        let relayPassword = self.normalizedCredential(password)
        guard relayToken != nil || relayPassword != nil else {
            self.deleteLegacyGatewayCredentials(instanceId: trimmedInstanceID)
            return true
        }
        // Relay config is written only after a successful connection and therefore proves
        // both the credential values and their gateway owner. Preserve it before cleanup.
        return self.saveGatewayCredentials(
            token: relayToken,
            bootstrapToken: nil,
            password: relayPassword,
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: false,
            instanceId: trimmedInstanceID)
    }

    static func saveLegacyGatewayTokenForMigrationTest(_ token: String, instanceId: String) {
        _ = KeychainStore.saveString(
            token,
            service: self.gatewayService,
            account: self.gatewayTokenAccount(instanceId: instanceId))
    }

    private struct LegacyLastGatewayConnectionData: Codable {
        var kind: GatewayRegistryEntry.Kind
        var stableID: String
        var useTLS: Bool
        var host: String?
        var port: Int?
    }

    static func loadTalkProviderApiKey(provider: String) -> String? {
        guard let providerId = self.normalizedTalkProviderID(provider) else { return nil }
        let account = self.talkProviderApiKeyAccount(providerId: providerId)
        let value = KeychainStore.loadString(
            service: self.talkService,
            account: account)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value?.isEmpty == false { return value }
        return nil
    }

    static func loadGatewayRegistry() -> GatewayRegistry {
        guard let json = KeychainStore.loadString(
            service: self.gatewayService,
            account: self.gatewayRegistryAccount),
            let data = json.data(using: .utf8),
            let registry = try? JSONDecoder().decode(GatewayRegistry.self, from: data),
            (1...2).contains(registry.version)
        else { return .empty }
        return self.normalizedGatewayRegistry(registry)
    }

    @discardableResult
    static func upsertGatewayRegistryEntry(_ entry: GatewayRegistryEntry) -> Bool {
        self.upsertGatewayRegistryEntry(entry, activate: false)
    }

    @discardableResult
    static func upsertGatewayRegistryEntry(_ entry: GatewayRegistryEntry, activate: Bool) -> Bool {
        guard let normalized = self.normalizedGatewayRegistryEntry(entry) else { return false }
        var registry = self.loadGatewayRegistry()
        if let index = registry.entries.firstIndex(where: {
            GatewayStableIdentifier.matches($0.stableID, normalized.stableID)
        }) {
            var replacement = normalized
            if replacement.lastConnectedAtMs == nil {
                replacement.lastConnectedAtMs = registry.entries[index].lastConnectedAtMs
            }
            registry.entries[index] = replacement
        } else {
            registry.entries.append(normalized)
        }
        if activate {
            registry.activeStableID = normalized.stableID
            if !registry.connectedStableIDs.contains(where: {
                GatewayStableIdentifier.matches($0, normalized.stableID)
            }) {
                registry.connectedStableIDs.append(normalized.stableID)
            }
        }
        return self.saveGatewayRegistry(registry)
    }

    @discardableResult
    static func markGatewayConnected(stableID: String, atMs: Int) -> Bool {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return false }
        var registry = self.loadGatewayRegistry()
        guard let index = registry.entries.firstIndex(where: {
            GatewayStableIdentifier.matches($0.stableID, stableID)
        }) else { return false }
        registry.entries[index].lastConnectedAtMs = atMs
        return self.saveGatewayRegistry(registry)
    }

    @discardableResult
    static func removeGatewayRegistryEntry(stableID: String) -> Bool {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return false }
        var registry = self.loadGatewayRegistry()
        registry.entries.removeAll { GatewayStableIdentifier.matches($0.stableID, stableID) }
        registry.connectedStableIDs.removeAll { GatewayStableIdentifier.matches($0, stableID) }
        if GatewayStableIdentifier.matches(registry.activeStableID, stableID) {
            registry.activeStableID = nil
        }
        return self.saveGatewayRegistry(registry)
    }

    static func activeGatewayEntry() -> GatewayRegistryEntry? {
        let registry = self.loadGatewayRegistry()
        guard let activeStableID = registry.activeStableID else { return nil }
        return registry.entries.first {
            GatewayStableIdentifier.matches($0.stableID, activeStableID)
        }
    }

    static func clearLegacyGatewaySelectors(stableID: String) {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return }
        let defaults = UserDefaults.standard
        for (defaultsKey, account) in [
            (self.preferredGatewayStableIDDefaultsKey, self.preferredGatewayStableIDAccount),
            (self.lastDiscoveredGatewayStableIDDefaultsKey, self.lastDiscoveredGatewayStableIDAccount),
        ] {
            let defaultsValue = defaults.string(forKey: defaultsKey)
            if GatewayStableIdentifier.matches(defaultsValue, stableID) {
                defaults.removeObject(forKey: defaultsKey)
            }
            let keychainValue = KeychainStore.loadString(service: self.gatewayService, account: account)
            if GatewayStableIdentifier.matches(keychainValue, stableID) {
                _ = KeychainStore.delete(service: self.gatewayService, account: account)
            }
        }
    }

    static func clearGatewayRegistry(defaults: UserDefaults = .standard) {
        _ = KeychainStore.delete(service: self.gatewayService, account: self.gatewayRegistryAccount)
        _ = KeychainStore.delete(service: self.gatewayService, account: self.lastGatewayConnectionAccount)
        self.removeLastGatewayDefaults(defaults)
    }

    static func saveGatewayRegistry(_ registry: GatewayRegistry) -> Bool {
        guard self.gatewayRegistryMutationsAllowed() else { return false }
        let normalized = self.normalizedGatewayRegistry(registry)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(normalized),
              let json = String(data: data, encoding: .utf8)
        else { return false }
        return KeychainStore.saveString(
            json,
            service: self.gatewayService,
            account: self.gatewayRegistryAccount)
    }

    private static func gatewayRegistryMutationsAllowed() -> Bool {
        guard let json = KeychainStore.loadString(
            service: self.gatewayService,
            account: self.gatewayRegistryAccount)
        else { return true }
        guard let data = json.data(using: .utf8),
              let registry = try? JSONDecoder().decode(GatewayRegistry.self, from: data)
        else { return false }
        return (1...2).contains(registry.version)
    }

    private static func normalizedGatewayRegistry(_ registry: GatewayRegistry) -> GatewayRegistry {
        var seen = Set<GatewayStableIdentifier.Key>()
        let entries = registry.entries
            .compactMap(self.normalizedGatewayRegistryEntry)
            .filter { entry in
                guard let key = GatewayStableIdentifier.key(entry.stableID) else { return false }
                return seen.insert(key).inserted
            }
            .sorted { lhs, rhs in
                if lhs.name != rhs.name { return lhs.name < rhs.name }
                return GatewayStableIdentifier.sortsBefore(lhs.stableID, rhs.stableID)
            }
        let activeStableID = registry.activeStableID.flatMap { activeID in
            entries.first(where: {
                GatewayStableIdentifier.matches($0.stableID, activeID)
            })?.stableID
        }
        var seenConnected = Set<GatewayStableIdentifier.Key>()
        let connectedStableIDs: [String] = registry.connectedStableIDs.compactMap { connectedID in
            guard let entry = entries.first(where: {
                GatewayStableIdentifier.matches($0.stableID, connectedID)
            }), let key = GatewayStableIdentifier.key(entry.stableID), seenConnected.insert(key).inserted
            else { return nil }
            return entry.stableID
        }
        return GatewayRegistry(
            version: 1,
            activeStableID: activeStableID,
            connectedStableIDs: connectedStableIDs,
            entries: entries)
    }

    private static func normalizedGatewayRegistryEntry(
        _ entry: GatewayRegistryEntry) -> GatewayRegistryEntry?
    {
        guard let stableID = GatewayStableIdentifier.exact(entry.stableID) else { return nil }
        let name = entry.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if entry.kind == .manual {
            let host = entry.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !host.isEmpty, let port = entry.port, (1...65535).contains(port) else { return nil }
            return GatewayRegistryEntry(
                stableID: stableID,
                kind: .manual,
                name: name.isEmpty ? "\(host):\(port)" : name,
                host: host,
                port: port,
                useTLS: entry.useTLS,
                lastConnectedAtMs: entry.lastConnectedAtMs)
        }
        return GatewayRegistryEntry(
            stableID: stableID,
            kind: .discovered,
            name: name.isEmpty ? stableID : name,
            host: nil,
            port: nil,
            useTLS: entry.useTLS,
            lastConnectedAtMs: entry.lastConnectedAtMs)
    }

    private static func migrateGatewayRegistryIfNeeded(defaults: UserDefaults = .standard) {
        if let json = KeychainStore.loadString(
            service: self.gatewayService,
            account: self.gatewayRegistryAccount)
        {
            guard let data = json.data(using: .utf8),
                  let registry = try? JSONDecoder().decode(GatewayRegistry.self, from: data),
                  (1...2).contains(registry.version)
            else { return }
            _ = self.saveGatewayRegistry(registry)
            _ = KeychainStore.delete(service: self.gatewayService, account: self.lastGatewayConnectionAccount)
            self.removeLastGatewayDefaults(defaults)
            return
        }

        let legacy = self.loadLegacyLastGatewayConnection(defaults: defaults)
        guard let entry = legacy.flatMap(self.gatewayRegistryEntry(from:)) else { return }
        let registry = GatewayRegistry(
            activeStableID: entry.stableID,
            connectedStableIDs: [entry.stableID],
            entries: [entry])
        guard self.saveGatewayRegistry(registry) else { return }
        _ = KeychainStore.delete(service: self.gatewayService, account: self.lastGatewayConnectionAccount)
        self.removeLastGatewayDefaults(defaults)
    }

    private static func loadLegacyLastGatewayConnection(
        defaults: UserDefaults) -> LegacyLastGatewayConnectionData?
    {
        if let json = KeychainStore.loadString(
            service: self.gatewayService,
            account: self.lastGatewayConnectionAccount),
            let data = json.data(using: .utf8),
            let stored = try? JSONDecoder().decode(LegacyLastGatewayConnectionData.self, from: data)
        {
            return stored
        }
        guard let stableID = GatewayStableIdentifier.exact(
            defaults.string(forKey: self.lastGatewayStableIDDefaultsKey))
        else { return nil }
        let kindRaw = defaults.string(forKey: self.lastGatewayKindDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let kind = GatewayRegistryEntry.Kind(rawValue: kindRaw) ?? .manual
        return LegacyLastGatewayConnectionData(
            kind: kind,
            stableID: stableID,
            useTLS: defaults.bool(forKey: self.lastGatewayTlsDefaultsKey),
            host: kind == .manual ? defaults.string(forKey: self.lastGatewayHostDefaultsKey) : nil,
            port: kind == .manual ? defaults.object(forKey: self.lastGatewayPortDefaultsKey) as? Int : nil)
    }

    private static func gatewayRegistryEntry(
        from legacy: LegacyLastGatewayConnectionData) -> GatewayRegistryEntry?
    {
        self.normalizedGatewayRegistryEntry(GatewayRegistryEntry(
            stableID: legacy.stableID,
            kind: legacy.kind,
            name: legacy.kind == .manual
                ? "\(legacy.host ?? ""):\(legacy.port ?? 0)"
                : legacy.stableID,
            host: legacy.host,
            port: legacy.port,
            useTLS: legacy.useTLS,
            lastConnectedAtMs: nil))
    }

    private static func removeLastGatewayDefaults(_ defaults: UserDefaults) {
        defaults.removeObject(forKey: self.lastGatewayKindDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayHostDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayPortDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayTlsDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayStableIDDefaultsKey)
    }

    static func deleteGatewayCredentials(instanceId: String, stableID: String) {
        let trimmed = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let stableID = GatewayStableIdentifier.exact(stableID), !trimmed.isEmpty else { return }
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.gatewayCredentialBundleAccount(instanceId: trimmed, stableID: stableID))
        self.deleteLegacyScopedCredentialBundleIfOwned(instanceId: trimmed, stableID: stableID)
    }

    static func deleteAllGatewayCredentials(instanceId: String) {
        let trimmed = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        _ = KeychainStore.deleteAccounts(
            service: self.gatewayService,
            accountPrefix: self.legacyGatewayCredentialBundleAccount(instanceId: trimmed) + ".")
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.legacyGatewayCredentialBundleAccount(instanceId: trimmed))
        self.deleteLegacyGatewayCredentials(instanceId: trimmed)
    }

    static func loadGatewayClientIdOverride(stableID: String) -> String? {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return nil }
        let defaults = UserDefaults.standard
        let key = self.gatewayDefaultsKey(prefix: self.clientIdOverrideDefaultsPrefix, stableID: stableID)
        let legacyKey = self.clientIdOverrideDefaultsPrefix + stableID
        let value = (defaults.string(forKey: key) ??
            (self.canSafelyReadLegacyRawStorageKey(stableID) ? defaults.string(forKey: legacyKey) : nil))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value?.isEmpty == false {
            if defaults.string(forKey: key) == nil {
                defaults.set(value, forKey: key)
                defaults.removeObject(forKey: legacyKey)
            }
            return value
        }
        return nil
    }

    static func saveGatewayClientIdOverride(stableID: String, clientId: String?) {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return }
        let key = self.gatewayDefaultsKey(prefix: self.clientIdOverrideDefaultsPrefix, stableID: stableID)
        let trimmedClientId = clientId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmedClientId.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else {
            UserDefaults.standard.set(trimmedClientId, forKey: key)
        }
        if self.canSafelyReadLegacyRawStorageKey(stableID) {
            UserDefaults.standard.removeObject(forKey: self.clientIdOverrideDefaultsPrefix + stableID)
        }
    }

    static func loadGatewaySelectedAgentId(stableID: String) -> String? {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return nil }
        let defaults = UserDefaults.standard
        let key = self.gatewayDefaultsKey(prefix: self.selectedAgentDefaultsPrefix, stableID: stableID)
        let legacyKey = self.selectedAgentDefaultsPrefix + stableID
        let value = (defaults.string(forKey: key) ??
            (self.canSafelyReadLegacyRawStorageKey(stableID) ? defaults.string(forKey: legacyKey) : nil))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value?.isEmpty == false {
            if defaults.string(forKey: key) == nil {
                defaults.set(value, forKey: key)
                defaults.removeObject(forKey: legacyKey)
            }
            return value
        }
        return nil
    }

    static func saveGatewaySelectedAgentId(stableID: String, agentId: String?) {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return }
        let key = self.gatewayDefaultsKey(prefix: self.selectedAgentDefaultsPrefix, stableID: stableID)
        let trimmedAgentId = agentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmedAgentId.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else {
            UserDefaults.standard.set(trimmedAgentId, forKey: key)
        }
        if self.canSafelyReadLegacyRawStorageKey(stableID) {
            UserDefaults.standard.removeObject(forKey: self.selectedAgentDefaultsPrefix + stableID)
        }
    }

    private static func gatewayDefaultsKey(prefix: String, stableID: String) -> String {
        "\(prefix)v2.\(GatewayStableIdentifier.storageComponent(stableID)!)"
    }

    private static func gatewayTokenAccount(instanceId: String) -> String {
        "gateway-token.\(instanceId)"
    }

    private static func gatewayBootstrapTokenAccount(instanceId: String) -> String {
        "gateway-bootstrap-token.\(instanceId)"
    }

    private static func gatewayPasswordAccount(instanceId: String) -> String {
        "gateway-password.\(instanceId)"
    }

    private static func legacyGatewayCredentialBundleAccount(instanceId: String) -> String {
        "gateway-credentials.\(instanceId)"
    }

    private static func gatewayCredentialBundleAccount(instanceId: String, stableID: String) -> String {
        "gateway-credentials.\(instanceId).v2.\(GatewayStableIdentifier.storageComponent(stableID)!)"
    }

    private static func legacyScopedGatewayCredentialBundleAccount(
        instanceId: String,
        stableID: String) -> String
    {
        "gateway-credentials.\(instanceId).\(stableID)"
    }

    private static func loadGatewayCredentialBundle(
        instanceId: String,
        gatewayStableID: String) -> GatewayCredentialBundle?
    {
        let trimmedInstanceID = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let stableID = GatewayStableIdentifier.exact(gatewayStableID),
              !trimmedInstanceID.isEmpty
        else { return nil }
        let account = self.gatewayCredentialBundleAccount(
            instanceId: trimmedInstanceID,
            stableID: stableID)
        let legacyAccount = self.legacyScopedGatewayCredentialBundleAccount(
            instanceId: trimmedInstanceID,
            stableID: stableID)
        let canonicalJSON = KeychainStore.loadString(service: self.gatewayService, account: account)
        guard let json = canonicalJSON ?? KeychainStore.loadString(
            service: self.gatewayService,
            account: legacyAccount),
            let data = json.data(using: .utf8),
            let decoded = try? JSONDecoder().decode(GatewayCredentialBundle.self, from: data)
        else { return nil }
        guard let decodedStableID = GatewayStableIdentifier.exact(decoded.gatewayStableID),
              GatewayStableIdentifier.matches(decodedStableID, stableID)
        else { return nil }
        let bundle = GatewayCredentialBundle(
            gatewayStableID: decodedStableID,
            suppressStoredDeviceAuth: decoded.suppressStoredDeviceAuth,
            token: self.normalizedCredential(decoded.token),
            bootstrapToken: self.normalizedCredential(decoded.bootstrapToken),
            password: self.normalizedCredential(decoded.password))
        if canonicalJSON == nil,
           let migratedData = try? JSONEncoder().encode(bundle),
           let migratedJSON = String(data: migratedData, encoding: .utf8),
           KeychainStore.saveString(migratedJSON, service: self.gatewayService, account: account)
        {
            _ = KeychainStore.delete(service: self.gatewayService, account: legacyAccount)
        }
        return bundle
    }

    private static func migrateGatewayCredentialBundleIfNeeded(instanceId: String) {
        let instanceID = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instanceID.isEmpty else { return }
        let legacyAccount = self.legacyGatewayCredentialBundleAccount(instanceId: instanceID)
        guard let json = KeychainStore.loadString(service: self.gatewayService, account: legacyAccount),
              let data = json.data(using: .utf8),
              let legacy = try? JSONDecoder().decode(GatewayCredentialBundle.self, from: data)
        else { return }
        guard let stableID = GatewayStableIdentifier.exact(legacy.gatewayStableID) else { return }
        let scopedAccount = self.gatewayCredentialBundleAccount(instanceId: instanceID, stableID: stableID)
        let scopedExists = KeychainStore.loadString(service: self.gatewayService, account: scopedAccount) != nil
        guard scopedExists || KeychainStore.saveString(
            json,
            service: self.gatewayService,
            account: scopedAccount)
        else { return }
        _ = KeychainStore.delete(service: self.gatewayService, account: legacyAccount)
        self.deleteLegacyGatewayCredentials(instanceId: instanceID)
    }

    private static func deleteLegacyScopedCredentialBundleIfOwned(
        instanceId: String,
        stableID: String)
    {
        let account = self.legacyScopedGatewayCredentialBundleAccount(
            instanceId: instanceId,
            stableID: stableID)
        guard let json = KeychainStore.loadString(service: self.gatewayService, account: account),
              let data = json.data(using: .utf8),
              let bundle = try? JSONDecoder().decode(GatewayCredentialBundle.self, from: data),
              GatewayStableIdentifier.matches(bundle.gatewayStableID, stableID)
        else { return }
        _ = KeychainStore.delete(service: self.gatewayService, account: account)
    }

    private static func canSafelyReadLegacyRawStorageKey(_ stableID: String) -> Bool {
        // Legacy header/default records do not embed their owner. Only ASCII keys outside
        // the v2 namespace can be attributed without aliasing another owner's encoded key.
        !stableID.hasPrefix("v2.") && stableID.unicodeScalars.allSatisfy(\.isASCII)
    }

    private static func normalizedCredential(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func deleteLegacyGatewayCredentials(instanceId: String) {
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.gatewayTokenAccount(instanceId: instanceId))
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.gatewayBootstrapTokenAccount(instanceId: instanceId))
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.gatewayPasswordAccount(instanceId: instanceId))
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: "gateway-credential-metadata.\(instanceId)")
    }

    private static func talkProviderApiKeyAccount(providerId: String) -> String {
        self.talkProviderApiKeyAccountPrefix + providerId
    }

    private static func normalizedTalkProviderID(_ provider: String) -> String? {
        let trimmed = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func ensureStableInstanceID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.instanceIdDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadStableInstanceID() == nil {
                self.saveStableInstanceID(existing)
            }
            return
        }

        if let stored = self.loadStableInstanceID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.instanceIdDefaultsKey)
            return
        }

        let fresh = UUID().uuidString
        self.saveStableInstanceID(fresh)
        defaults.set(fresh, forKey: self.instanceIdDefaultsKey)
    }

    private static func ensurePreferredGatewayStableID() {
        let defaults = UserDefaults.standard

        if let existing = GatewayStableIdentifier.exact(
            defaults.string(forKey: self.preferredGatewayStableIDDefaultsKey))
        {
            if self.loadPreferredGatewayStableID() == nil {
                self.savePreferredGatewayStableID(existing)
            }
            return
        }

        if let stored = self.loadPreferredGatewayStableID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.preferredGatewayStableIDDefaultsKey)
        }
    }

    private static func ensureLastDiscoveredGatewayStableID() {
        let defaults = UserDefaults.standard

        if let existing = GatewayStableIdentifier.exact(
            defaults.string(forKey: self.lastDiscoveredGatewayStableIDDefaultsKey))
        {
            if self.loadLastDiscoveredGatewayStableID() == nil {
                self.saveLastDiscoveredGatewayStableID(existing)
            }
            return
        }

        if let stored = self.loadLastDiscoveredGatewayStableID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.lastDiscoveredGatewayStableIDDefaultsKey)
        }
    }
}

extension GatewaySettingsStore {
    @discardableResult
    static func completeGatewayCredentialHandoff(
        instanceId: String,
        gatewayStableID: String,
        deleteCredentialBundle: (String, String) -> Result<
            Void,
            GenericPasswordKeychainStore.MutationError,
        > = { service, account in
            KeychainStore.deleteResult(service: service, account: account)
        }) throws -> Bool
    {
        let stableID = self.authenticationOwnerID(routeStableID: gatewayStableID)
        guard let bundle = self.loadGatewayCredentialBundle(
            instanceId: instanceId,
            gatewayStableID: stableID),
            bundle.suppressStoredDeviceAuth
        else { return false }
        // Device-token issuance and bootstrap consumption are one durable handoff. A relaunch
        // must never observe a spent bootstrap token while stored device auth remains disabled.
        let completedBundle = GatewayCredentialBundle(
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: false,
            token: bundle.token,
            bootstrapToken: nil,
            password: bundle.password)
        let trimmedInstanceID = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !stableID.isEmpty, !trimmedInstanceID.isEmpty else {
            throw GatewayCredentialPersistenceError.invalidOwner
        }
        let account = self.gatewayCredentialBundleAccount(
            instanceId: trimmedInstanceID,
            stableID: stableID)
        try self.saveGatewayCredentialBundle(completedBundle, account: account)
        self.deleteLegacyScopedCredentialBundleIfOwned(
            instanceId: trimmedInstanceID,
            stableID: stableID)
        self.deleteLegacyGatewayCredentials(instanceId: trimmedInstanceID)

        guard !completedBundle.hasCredentials else { return true }
        switch deleteCredentialBundle(self.gatewayService, account) {
        case .success:
            return true
        case let .failure(error):
            // Deletion is cleanup after the atomic overwrite. Only continue when readback
            // proves that no bootstrap or shared credential survived in the retained item.
            guard let retained = self.loadGatewayCredentialBundle(
                instanceId: trimmedInstanceID,
                gatewayStableID: stableID),
                !retained.hasCredentials,
                !retained.suppressStoredDeviceAuth
            else {
                throw GatewayCredentialPersistenceError.keychain(error)
            }
            GatewayDiagnostics.log("gateway credential cleanup deferred: \(error.localizedDescription)")
            return true
        }
    }

    private static func persistGatewayCredentials(
        token: String?,
        bootstrapToken: String?,
        password: String?,
        gatewayStableID: String,
        suppressStoredDeviceAuth: Bool,
        instanceId: String) throws
    {
        let stableID = self.authenticationOwnerID(routeStableID: gatewayStableID)
        let trimmedInstanceID = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !stableID.isEmpty, !trimmedInstanceID.isEmpty else {
            throw GatewayCredentialPersistenceError.invalidOwner
        }
        let bundle = GatewayCredentialBundle(
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: suppressStoredDeviceAuth,
            token: self.normalizedCredential(token),
            bootstrapToken: self.normalizedCredential(bootstrapToken),
            password: self.normalizedCredential(password))
        let account = self.gatewayCredentialBundleAccount(
            instanceId: trimmedInstanceID,
            stableID: stableID)
        if bundle.hasCredentials || suppressStoredDeviceAuth {
            try self.saveGatewayCredentialBundle(bundle, account: account)
        } else {
            switch KeychainStore.deleteResult(service: self.gatewayService, account: account) {
            case .success:
                break
            case let .failure(error):
                guard KeychainStore.loadString(service: self.gatewayService, account: account) == nil else {
                    throw GatewayCredentialPersistenceError.keychain(error)
                }
            }
        }
        self.deleteLegacyScopedCredentialBundleIfOwned(
            instanceId: trimmedInstanceID,
            stableID: stableID)
        self.deleteLegacyGatewayCredentials(instanceId: trimmedInstanceID)
    }

    private static func saveGatewayCredentialBundle(
        _ bundle: GatewayCredentialBundle,
        account: String) throws
    {
        guard let data = try? JSONEncoder().encode(bundle),
              let json = String(data: data, encoding: .utf8)
        else {
            throw GatewayCredentialPersistenceError.encodingFailed
        }
        do {
            try KeychainStore.saveStringResult(
                json,
                service: self.gatewayService,
                account: account).get()
        } catch {
            throw GatewayCredentialPersistenceError.keychain(error)
        }
    }
}

enum GatewayDiagnostics {
    struct ScopedLogger {
        private let prefix: String

        fileprivate init(prefix: String) {
            self.prefix = prefix
        }

        func stage(_ message: String) {
            GatewayDiagnostics.log("\(self.prefix): \(GatewayDiagnostics.sanitizeScopedMessage(message))")
        }

        func skipped(_ reason: String) {
            self.stage("registration skipped reason=\(reason)")
        }

        func failed(_ stage: String, error: Error) {
            let nsError = error as NSError
            let errorType = String(reflecting: type(of: error))
            self
                .stage(
                    "\(stage) failed errorType=\(errorType) domain=\(nsError.domain) code=\(nsError.code)")
        }
    }

    private static let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "GatewayDiag")
    private static let queue = DispatchQueue(label: "ai.openclawfoundation.app.gateway.diagnostics")
    private static let maxLogBytes: Int64 = 512 * 1024
    private static let keepLogBytes: Int64 = 256 * 1024
    private static let logSizeCheckEveryWrites = 50
    private static let logWritesSinceCheck = OSAllocatedUnfairLock(initialState: 0)
    private static let maxScopedMessageCharacters = 320

    /// Keep relay diagnostics stage-based. Push tokens, relay grants, proofs,
    /// receipts, signed payloads, and handles must never enter this cache log.
    static let pushRelay = ScopedLogger(prefix: "push relay")

    private static func sanitizeScopedMessage(_ value: String) -> String {
        let collapsed = value
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard collapsed.count > self.maxScopedMessageCharacters else {
            return collapsed
        }
        let end = collapsed.index(collapsed.startIndex, offsetBy: self.maxScopedMessageCharacters)
        return String(collapsed[..<end]) + "..."
    }

    private static func isoTimestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static var fileURL: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("openclaw-gateway.log")
    }

    private static func truncateLogIfNeeded(url: URL) {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let sizeNumber = attrs[.size] as? NSNumber
        else { return }
        let size = sizeNumber.int64Value
        guard size > self.maxLogBytes else { return }

        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }

            let start = max(Int64(0), size - self.keepLogBytes)
            try handle.seek(toOffset: UInt64(start))
            var tail = try handle.readToEnd() ?? Data()

            // If we truncated mid-line, drop the first partial line so logs remain readable.
            if start > 0, let nl = tail.firstIndex(of: 10) {
                let next = tail.index(after: nl)
                if next < tail.endIndex {
                    tail = tail.suffix(from: next)
                } else {
                    tail = Data()
                }
            }

            try tail.write(to: url, options: .atomic)
        } catch {
            // Best-effort only.
        }
    }

    private static func appendToLog(url: URL, data: Data) {
        if FileManager.default.fileExists(atPath: url.path) {
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            }
        } else {
            try? data.write(to: url, options: .atomic)
        }
    }

    private static func applyFileProtection(url: URL) {
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path)
    }

    static func bootstrap() {
        guard let url = fileURL else { return }
        self.queue.async {
            self.truncateLogIfNeeded(url: url)
            let timestamp = self.isoTimestamp()
            let line = "[\(timestamp)] gateway diagnostics started\n"
            if let data = line.data(using: .utf8) {
                self.appendToLog(url: url, data: data)
                self.applyFileProtection(url: url)
            }
        }
    }

    static func log(_ message: String) {
        let timestamp = self.isoTimestamp()
        let line = "[\(timestamp)] \(message)"
        self.logger.info("\(line, privacy: .public)")

        guard let url = fileURL else { return }
        self.queue.async {
            let shouldTruncate = self.logWritesSinceCheck.withLock { count in
                count += 1
                if count >= self.logSizeCheckEveryWrites {
                    count = 0
                    return true
                }
                return false
            }
            if shouldTruncate {
                self.truncateLogIfNeeded(url: url)
            }
            let entry = line + "\n"
            if let data = entry.data(using: .utf8) {
                self.appendToLog(url: url, data: data)
            }
        }
    }
}
