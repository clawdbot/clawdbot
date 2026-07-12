import CryptoKit
import Foundation
#if canImport(Security)
import Security
#endif

public enum GatewayDeviceIdentityProfile: String, Sendable {
    case primary
    case node
    case shareExtension

    var identityFileName: String {
        switch self {
        case .primary:
            "device.json"
        case .node:
            "node-device.json"
        case .shareExtension:
            "share-device.json"
        }
    }

    var authFileName: String {
        switch self {
        case .primary:
            "device-auth.json"
        case .node:
            "node-device-auth.json"
        case .shareExtension:
            "share-device-auth.json"
        }
    }
}

public struct DeviceIdentity: Codable, Sendable {
    public var deviceId: String
    public var publicKey: String
    public var privateKey: String
    public var createdAtMs: Int64

    public init(deviceId: String, publicKey: String, privateKey: String, createdAtMs: Int64) {
        self.deviceId = deviceId
        self.publicKey = publicKey
        self.privateKey = privateKey
        self.createdAtMs = createdAtMs
    }
}

enum DeviceIdentityPaths {
    private static let stateDirEnv = ["OPENCLAW_STATE_DIR"]
    @TaskLocal static var scopedStateDirURL: URL?

    /// Entitlements are baked into the code signature, so resolve the gate once per process.
    /// Every identity load and DeviceAuthStore read/write resolves the state dir through here;
    /// re-creating a SecTask each time is wasted work for a process-immutable fact.
    private static let appGroupStateDirAvailable =
        DeviceIdentityPaths.hasAppGroupEntitlement(OpenClawAppGroup.identifier)

    static func stateDirURL() -> URL {
        self.stateDirURL(
            overrideURL: self.stateDirOverrideURL(),
            legacyStateDirURL: self.legacyStateDirURL(),
            appGroupStateDirURL: self.appGroupStateDirURL(),
            appGroupStateDirAvailable: self.appGroupStateDirAvailable,
            temporaryDirectory: FileManager.default.temporaryDirectory)
    }

    static func stateDirURL(
        overrideURL: URL?,
        legacyStateDirURL: URL?,
        appGroupStateDirURL: URL?,
        appGroupStateDirAvailable: Bool = true,
        temporaryDirectory: URL) -> URL
    {
        if let overrideURL {
            return overrideURL
        }
        if appGroupStateDirAvailable, let appGroupStateDirURL {
            return appGroupStateDirURL
        }
        if let legacyStateDirURL {
            return legacyStateDirURL
        }
        return temporaryDirectory.appendingPathComponent("openclaw", isDirectory: true)
    }

    private static func stateDirOverrideURL() -> URL? {
        // Test-scoped stores must win over the process environment. Parallel Swift tests
        // otherwise race whenever another suite temporarily swaps OPENCLAW_STATE_DIR.
        if let scopedStateDirURL = self.scopedStateDirURL {
            return scopedStateDirURL
        }
        for key in self.stateDirEnv {
            if let raw = getenv(key) {
                let value = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty {
                    return URL(fileURLWithPath: value, isDirectory: true)
                }
            }
        }
        return nil
    }

    private static func legacyStateDirURL() -> URL? {
        if let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            return appSupport.appendingPathComponent("OpenClaw", isDirectory: true)
        }
        return nil
    }

    private static func hasAppGroupEntitlement(_ identifier: String) -> Bool {
        // macOS resolves containerURL(forSecurityApplicationGroupIdentifier:) even without the
        // App Groups entitlement, but macOS 15+ gates actual access behind a user consent prompt.
        // Unentitled builds (the shipped mac app) must not depend on that container. iOS requires
        // the entitlement for containerURL to resolve at all, so the gate is macOS-only.
        #if os(macOS) && canImport(Security)
        guard
            let task = SecTaskCreateFromSelf(nil),
            let value = SecTaskCopyValueForEntitlement(
                task,
                "com.apple.security.application-groups" as CFString,
                nil)
        else {
            return false
        }
        guard let groups = value as? [String] else {
            return false
        }
        return groups.contains(identifier)
        #else
        return true
        #endif
    }

    private static func appGroupStateDirURL() -> URL? {
        guard
            let containerURL = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: OpenClawAppGroup.identifier)
        else {
            return nil
        }
        return containerURL.appendingPathComponent("OpenClaw", isDirectory: true)
    }

    /// Files a one-time fallback migration may carry from the App Group container into the
    /// selected store. Stored device tokens are keyed by deviceId, so the identity file is
    /// only useful together with its auth sibling; migrating one without the other forces
    /// an unnecessary re-pair even though the deviceId survived.
    struct AppGroupMigrationSource {
        let identityURL: URL
        let authURL: URL
    }

    static func appGroupMigrationSource(
        profile: GatewayDeviceIdentityProfile) -> AppGroupMigrationSource?
    {
        self.appGroupMigrationSource(
            appGroupStateDirURL: self.appGroupStateDirURL(),
            appGroupStateDirAvailable: self.appGroupStateDirAvailable,
            stateDirOverridden: self.stateDirOverrideURL() != nil,
            profile: profile)
    }

    /// Non-nil only for unentitled builds whose store selection fell back to legacy storage;
    /// entitled builds keep using the App Group container and must never migrate out of it.
    /// An explicit OPENCLAW_STATE_DIR override selects a caller-chosen store, not the legacy
    /// fallback; importing container identity/tokens there would leak the machine's real
    /// pairing into unrelated stores (test dirs, relocated installs).
    static func appGroupMigrationSource(
        appGroupStateDirURL: URL?,
        appGroupStateDirAvailable: Bool,
        stateDirOverridden: Bool,
        profile: GatewayDeviceIdentityProfile) -> AppGroupMigrationSource?
    {
        guard !stateDirOverridden, !appGroupStateDirAvailable, let appGroupStateDirURL else {
            return nil
        }
        let identityDirURL = appGroupStateDirURL.appendingPathComponent("identity", isDirectory: true)
        return AppGroupMigrationSource(
            identityURL: identityDirURL.appendingPathComponent(profile.identityFileName, isDirectory: false),
            authURL: identityDirURL.appendingPathComponent(profile.authFileName, isDirectory: false))
    }
}

public enum DeviceIdentityStore {
    private static let ed25519SPKIPrefix = Data([
        0x30, 0x2A, 0x30, 0x05, 0x06, 0x03, 0x2B, 0x65,
        0x70, 0x03, 0x21, 0x00,
    ])
    private static let ed25519PKCS8PrivatePrefix = Data([
        0x30, 0x2E, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
        0x03, 0x2B, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ])

    public static func loadOrCreate() -> DeviceIdentity {
        self.loadOrCreate(profile: .primary)
    }

    static func withStateDirectory<T>(
        _ url: URL,
        operation: () async throws -> T,
        isolation: isolated (any Actor)? = #isolation) async rethrows -> T
    {
        try await DeviceIdentityPaths.$scopedStateDirURL.withValue(
            url,
            operation: operation,
            isolation: isolation)
    }

    public static func loadOrCreate(profile: GatewayDeviceIdentityProfile) -> DeviceIdentity {
        self.loadOrCreate(
            fileURL: self.fileURL(profile: profile),
            migrationSource: DeviceIdentityPaths.appGroupMigrationSource(profile: profile))
    }

    /// Loads or creates an identity, returning nil unless its key material was durably persisted.
    public static func loadOrCreatePersisted(
        profile: GatewayDeviceIdentityProfile = .primary) -> DeviceIdentity?
    {
        self.loadOrCreatePersisted(
            fileURL: self.fileURL(profile: profile),
            migrationSource: DeviceIdentityPaths.appGroupMigrationSource(profile: profile))
    }

    static func loadOrCreate(
        fileURL url: URL,
        migrationSource: DeviceIdentityPaths.AppGroupMigrationSource? = nil) -> DeviceIdentity
    {
        if let data = try? Data(contentsOf: url) {
            switch self.decodeStoredIdentity(data) {
            case let .identity(decoded):
                return decoded
            case .recognizedInvalid, .unknown:
                // Existing bytes may hold a newer schema or recoverable key material; never
                // overwrite them. Callers run with a transient identity instead.
                return self.generate()
            }
        }
        if FileManager.default.fileExists(atPath: url.path) {
            return self.generate()
        }
        if let migrated = self.migratedIdentity(from: migrationSource, to: url) {
            return migrated
        }
        let identity = self.generate()
        self.save(identity, to: url)
        return identity
    }

    static func loadOrCreatePersisted(
        fileURL url: URL,
        migrationSource: DeviceIdentityPaths.AppGroupMigrationSource? = nil) -> DeviceIdentity?
    {
        let identity = self.loadOrCreate(fileURL: url, migrationSource: migrationSource)
        guard let data = try? Data(contentsOf: url),
              case let .identity(stored) = self.decodeStoredIdentity(data),
              stored.deviceId == identity.deviceId,
              stored.publicKey == identity.publicKey,
              stored.privateKey == identity.privateKey
        else {
            return nil
        }
        return stored
    }

    /// One-time upgrade path for builds that lost App Group storage: it runs only while the
    /// selected store has no identity file, so steady state never re-reads the old container.
    private static func migratedIdentity(
        from source: DeviceIdentityPaths.AppGroupMigrationSource?,
        to destinationURL: URL) -> DeviceIdentity?
    {
        guard
            let source,
            let data = try? Data(contentsOf: source.identityURL),
            case let .identity(identity) = self.decodeStoredIdentity(data)
        else {
            return nil
        }
        self.save(identity, to: destinationURL)
        // Stored device tokens only load when their store's deviceId matches (DeviceAuthStore),
        // so they must move together with the identity or the install re-pairs for no reason.
        // A mismatched copy is inert behind that same check; no validation needed here.
        self.copyAuthStoreFile(
            from: source.authURL,
            toDirectory: destinationURL.deletingLastPathComponent())
        return identity
    }

    private static func copyAuthStoreFile(from sourceURL: URL, toDirectory directoryURL: URL) {
        let fileManager = FileManager.default
        let destinationURL = directoryURL
            .appendingPathComponent(sourceURL.lastPathComponent, isDirectory: false)
        guard
            !fileManager.fileExists(atPath: destinationURL.path),
            fileManager.fileExists(atPath: sourceURL.path)
        else {
            return
        }
        try? fileManager.copyItem(at: sourceURL, to: destinationURL)
        try? fileManager.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: destinationURL.path)
    }

    private enum DecodeResult {
        case identity(DeviceIdentity)
        case recognizedInvalid
        case unknown
    }

    private static func decodeStoredIdentity(_ data: Data) -> DecodeResult {
        let decoder = JSONDecoder()
        if let decoded = try? decoder.decode(DeviceIdentity.self, from: data) {
            guard let identity = self.normalizedRawIdentity(decoded) else {
                return .recognizedInvalid
            }
            return .identity(identity)
        }

        if let decoded = try? decoder.decode(PemDeviceIdentity.self, from: data) {
            guard decoded.version == 1,
                  let publicKeyData = self.rawPublicKey(fromPEM: decoded.publicKeyPem),
                  let privateKeyData = self.rawPrivateKey(fromPEM: decoded.privateKeyPem),
                  self.keyPairMatches(publicKeyData: publicKeyData, privateKeyData: privateKeyData)
            else {
                return .recognizedInvalid
            }
            return .identity(DeviceIdentity(
                deviceId: self.deviceId(publicKeyData: publicKeyData),
                publicKey: publicKeyData.base64EncodedString(),
                privateKey: privateKeyData.base64EncodedString(),
                createdAtMs: decoded.createdAtMs))
        }

        return self.hasRecognizedIdentityShape(data) ? .recognizedInvalid : .unknown
    }

    public static func signPayload(_ payload: String, identity: DeviceIdentity) -> String? {
        guard let privateKeyData = Data(base64Encoded: identity.privateKey) else { return nil }
        do {
            let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: privateKeyData)
            let signature = try privateKey.signature(for: Data(payload.utf8))
            return self.base64UrlEncode(signature)
        } catch {
            return nil
        }
    }

    private static func generate() -> DeviceIdentity {
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKey = privateKey.publicKey
        let publicKeyData = publicKey.rawRepresentation
        let privateKeyData = privateKey.rawRepresentation
        let deviceId = self.deviceId(publicKeyData: publicKeyData)
        return DeviceIdentity(
            deviceId: deviceId,
            publicKey: publicKeyData.base64EncodedString(),
            privateKey: privateKeyData.base64EncodedString(),
            createdAtMs: Int64(Date().timeIntervalSince1970 * 1000))
    }

    private static func base64UrlEncode(_ data: Data) -> String {
        let base64 = data.base64EncodedString()
        return base64
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func publicKeyBase64Url(_ identity: DeviceIdentity) -> String? {
        guard let data = Data(base64Encoded: identity.publicKey) else { return nil }
        return self.base64UrlEncode(data)
    }

    private static func normalizedRawIdentity(_ identity: DeviceIdentity) -> DeviceIdentity? {
        guard !identity.deviceId.isEmpty,
              let publicKeyData = Data(base64Encoded: identity.publicKey),
              let privateKeyData = Data(base64Encoded: identity.privateKey)
        else { return nil }

        guard publicKeyData.count == 32, privateKeyData.count == 32,
              self.keyPairMatches(publicKeyData: publicKeyData, privateKeyData: privateKeyData)
        else { return nil }
        return DeviceIdentity(
            deviceId: self.deviceId(publicKeyData: publicKeyData),
            publicKey: identity.publicKey,
            privateKey: identity.privateKey,
            createdAtMs: identity.createdAtMs)
    }

    private static func rawPublicKey(fromPEM pem: String) -> Data? {
        guard let der = self.derData(fromPEM: pem),
              der.count == self.ed25519SPKIPrefix.count + 32,
              der.prefix(self.ed25519SPKIPrefix.count) == self.ed25519SPKIPrefix
        else { return nil }
        return der.suffix(32)
    }

    private static func rawPrivateKey(fromPEM pem: String) -> Data? {
        guard let der = self.derData(fromPEM: pem),
              der.count == self.ed25519PKCS8PrivatePrefix.count + 32,
              der.prefix(self.ed25519PKCS8PrivatePrefix.count) == self.ed25519PKCS8PrivatePrefix
        else { return nil }
        return der.suffix(32)
    }

    private static func keyPairMatches(publicKeyData: Data, privateKeyData: Data) -> Bool {
        guard let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: privateKeyData)
        else {
            return false
        }
        return privateKey.publicKey.rawRepresentation == publicKeyData
    }

    private static func derData(fromPEM pem: String) -> Data? {
        let body = pem
            .split(whereSeparator: \.isNewline)
            .filter { !$0.hasPrefix("-----") }
            .joined()
        return Data(base64Encoded: body)
    }

    private static func hasRecognizedIdentityShape(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        return object.keys.contains("publicKeyPem")
            || object.keys.contains("privateKeyPem")
            || object.keys.contains("publicKey")
            || object.keys.contains("privateKey")
    }

    private static func deviceId(publicKeyData: Data) -> String {
        SHA256.hash(data: publicKeyData).compactMap { String(format: "%02x", $0) }.joined()
    }

    private static func save(_ identity: DeviceIdentity, to url: URL) {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(identity)
            try data.write(to: url, options: [.atomic])
        } catch {
            // best-effort only
        }
    }

    private static func fileURL(profile: GatewayDeviceIdentityProfile) -> URL {
        let base = DeviceIdentityPaths.stateDirURL()
        return base
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(profile.identityFileName, isDirectory: false)
    }
}

private struct PemDeviceIdentity: Codable {
    var version: Int
    var deviceId: String
    var publicKeyPem: String
    var privateKeyPem: String
    var createdAtMs: Int64
}
