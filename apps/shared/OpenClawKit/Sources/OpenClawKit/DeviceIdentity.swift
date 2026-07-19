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

public struct DeviceIdentity: Codable, Sendable, Equatable {
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
        if let scopedStateDirURL {
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

    static func legacyStateDirURL() -> URL? {
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

    static func appGroupStateDirURL() -> URL? {
        guard
            let containerURL = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: OpenClawAppGroup.identifier)
        else {
            return nil
        }
        return containerURL.appendingPathComponent("OpenClaw", isDirectory: true)
    }

    struct LegacyIdentitySource: Equatable {
        let stateDirURL: URL
        let identityURL: URL
        let authURL: URL
    }

    static func legacyIdentitySources(
        profile: GatewayDeviceIdentityProfile) -> [LegacyIdentitySource]
    {
        // Node doctor cannot traverse sandboxed Apple App Group/Application Support containers.
        // Native startup therefore owns this one-time import before runtime becomes SQLite-only.
        let selectedStateDirURL = self.stateDirURL()
        let roots: [URL] = if self.scopedStateDirURL != nil || self.stateDirOverrideURL() != nil {
            // Explicit and task-local stores must never import the machine's real identity.
            [selectedStateDirURL]
        } else {
            // Unentitled macOS builds intentionally probe the former App Group once: shipped
            // installs must carry their identity and auth together instead of rotating/re-pairing.
            [selectedStateDirURL, self.appGroupStateDirURL(), self.legacyStateDirURL()]
                .compactMap(\.self)
        }

        var seen = Set<String>()
        return roots.compactMap { root in
            let standardizedRoot = root.standardizedFileURL
            guard seen.insert(standardizedRoot.path).inserted else { return nil }
            let identityDirURL = standardizedRoot.appendingPathComponent("identity", isDirectory: true)
            return LegacyIdentitySource(
                stateDirURL: standardizedRoot,
                identityURL: identityDirURL.appendingPathComponent(profile.identityFileName, isDirectory: false),
                authURL: identityDirURL.appendingPathComponent(profile.authFileName, isDirectory: false))
        }
    }
}

struct DeviceIdentityMaterial: Equatable {
    let identity: DeviceIdentity
    let publicKeyPEM: String
    let privateKeyPEM: String
}

public enum DeviceIdentityStore {
    static let ed25519SPKIPrefix = Data([
        0x30, 0x2A, 0x30, 0x05, 0x06, 0x03, 0x2B, 0x65,
        0x70, 0x03, 0x21, 0x00,
    ])
    static let ed25519PKCS8PrivatePrefix = Data([
        0x30, 0x2E, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
        0x03, 0x2B, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ])

    static func storageError(_ message: String) -> NSError {
        NSError(
            domain: "ai.openclaw.device-identity-store",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: message])
    }

    public static func loadOrCreate() -> DeviceIdentity {
        self.loadOrCreate(profile: .primary)
    }

    #if compiler(>=6.4)
    static func withStateDirectory<T>(
        _ url: URL,
        operation: nonisolated(nonsending) () async throws -> T) async rethrows -> T
    {
        try await DeviceIdentityPaths.$scopedStateDirURL.withValue(
            url,
            operation: operation)
    }
    #else
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
    #endif

    public static func loadOrCreate(profile: GatewayDeviceIdentityProfile) -> DeviceIdentity {
        guard let identity = loadOrCreatePersisted(profile: profile) else {
            preconditionFailure("Could not persist the OpenClaw device identity")
        }
        return identity
    }

    /// Loads or creates an identity, returning nil unless its key material was durably persisted.
    public static func loadOrCreatePersisted(
        profile: GatewayDeviceIdentityProfile = .primary) -> DeviceIdentity?
    {
        let stateDirURL = DeviceIdentityPaths.stateDirURL()
        return try? DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: self.databaseURL(stateDirURL: stateDirURL),
            destinationStateDirURL: stateDirURL,
            profile: profile,
            legacySources: DeviceIdentityPaths.legacyIdentitySources(profile: profile))
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

    static func generateMaterial() -> DeviceIdentityMaterial {
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKey = privateKey.publicKey
        let publicKeyData = publicKey.rawRepresentation
        let privateKeyData = privateKey.rawRepresentation
        let deviceId = self.deviceId(publicKeyData: publicKeyData)
        let identity = DeviceIdentity(
            deviceId: deviceId,
            publicKey: publicKeyData.base64EncodedString(),
            privateKey: privateKeyData.base64EncodedString(),
            createdAtMs: Int64(Date().timeIntervalSince1970 * 1000))
        return DeviceIdentityMaterial(
            identity: identity,
            publicKeyPEM: self.pem(label: "PUBLIC KEY", der: self.ed25519SPKIPrefix + publicKeyData),
            privateKeyPEM: self.pem(label: "PRIVATE KEY", der: self.ed25519PKCS8PrivatePrefix + privateKeyData))
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

    static func material(fromLegacyData data: Data) throws -> DeviceIdentityMaterial {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DeviceIdentityStore.storageError("Legacy device identity is not a JSON object")
        }
        let keys = Set(object.keys)
        let decoder = JSONDecoder()
        if keys == ["deviceId", "publicKey", "privateKey", "createdAtMs"],
           let decoded = try? decoder.decode(DeviceIdentity.self, from: data),
           decoded.createdAtMs >= 0
        {
            guard let normalized = normalizedRawIdentity(decoded),
                  let publicKeyData = Data(base64Encoded: normalized.publicKey),
                  let privateKeyData = Data(base64Encoded: normalized.privateKey)
            else {
                throw DeviceIdentityStore
                    .storageError("Legacy raw device identity has invalid key material or deviceId")
            }
            return DeviceIdentityMaterial(
                identity: normalized,
                publicKeyPEM: self.pem(label: "PUBLIC KEY", der: self.ed25519SPKIPrefix + publicKeyData),
                privateKeyPEM: self.pem(label: "PRIVATE KEY", der: self.ed25519PKCS8PrivatePrefix + privateKeyData))
        }
        if keys == ["version", "deviceId", "publicKeyPem", "privateKeyPem", "createdAtMs"],
           let decoded = try? decoder.decode(PemDeviceIdentity.self, from: data)
        {
            guard decoded.version == 1, decoded.createdAtMs >= 0,
                  let publicKeyData = rawPublicKey(fromPEM: decoded.publicKeyPem),
                  let privateKeyData = rawPrivateKey(fromPEM: decoded.privateKeyPem),
                  keyPairMatches(publicKeyData: publicKeyData, privateKeyData: privateKeyData)
            else {
                throw DeviceIdentityStore.storageError("Legacy PEM device identity has invalid key material")
            }
            return self.material(
                publicKeyData: publicKeyData,
                privateKeyData: privateKeyData,
                createdAtMs: decoded.createdAtMs)
        }
        throw DeviceIdentityStore.storageError("Legacy device identity has an unsupported shape")
    }

    static func material(
        deviceId: String,
        publicKeyPEM: String,
        privateKeyPEM: String,
        createdAtMs: Int64) throws -> DeviceIdentityMaterial
    {
        guard createdAtMs >= 0,
              let publicKeyData = rawPublicKey(fromPEM: publicKeyPEM),
              let privateKeyData = rawPrivateKey(fromPEM: privateKeyPEM),
              keyPairMatches(publicKeyData: publicKeyData, privateKeyData: privateKeyData)
        else {
            throw DeviceIdentityStore.storageError("SQLite device identity has invalid key material")
        }
        let canonical = self.material(
            publicKeyData: publicKeyData,
            privateKeyData: privateKeyData,
            createdAtMs: createdAtMs)
        guard canonical.identity.deviceId == deviceId else {
            throw DeviceIdentityStore.storageError("SQLite device identity deviceId does not match its public key")
        }
        guard canonical.publicKeyPEM == publicKeyPEM, canonical.privateKeyPEM == privateKeyPEM else {
            throw DeviceIdentityStore.storageError("SQLite device identity PEM is not canonical")
        }
        return canonical
    }

    private static func normalizedRawIdentity(_ rawIdentity: DeviceIdentity) -> DeviceIdentity? {
        let rawKey = rawIdentity.privateKey
        guard !rawIdentity.deviceId.isEmpty,
              let publicKeyData = Data(base64Encoded: rawIdentity.publicKey),
              let privateKeyData = Data(base64Encoded: rawKey)
        else { return nil }

        guard publicKeyData.count == 32, privateKeyData.count == 32,
              self.keyPairMatches(publicKeyData: publicKeyData, privateKeyData: privateKeyData)
        else { return nil }
        return DeviceIdentity(
            deviceId: self.deviceId(publicKeyData: publicKeyData),
            publicKey: rawIdentity.publicKey,
            privateKey: rawKey,
            createdAtMs: rawIdentity.createdAtMs)
    }

    static func rawPublicKey(fromPEM pem: String) -> Data? {
        guard let der = derData(fromPEM: pem, label: "PUBLIC KEY"),
              der.count == self.ed25519SPKIPrefix.count + 32,
              der.prefix(self.ed25519SPKIPrefix.count) == self.ed25519SPKIPrefix
        else { return nil }
        return der.suffix(32)
    }

    static func rawPrivateKey(fromPEM pem: String) -> Data? {
        guard let der = derData(fromPEM: pem, label: "PRIVATE KEY"),
              der.count == self.ed25519PKCS8PrivatePrefix.count + 32,
              der.prefix(self.ed25519PKCS8PrivatePrefix.count) == self.ed25519PKCS8PrivatePrefix
        else { return nil }
        return der.suffix(32)
    }

    static func keyPairMatches(publicKeyData: Data, privateKeyData: Data) -> Bool {
        guard let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: privateKeyData)
        else {
            return false
        }
        return privateKey.publicKey.rawRepresentation == publicKeyData
    }

    private static func derData(fromPEM pem: String, label: String) -> Data? {
        let lines = pem.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count >= 4,
              lines.first == "-----BEGIN \(label)-----",
              lines[lines.count - 2] == "-----END \(label)-----",
              lines.last?.isEmpty == true
        else { return nil }
        let body = lines.dropFirst().dropLast(2)
        guard !body.isEmpty, body.allSatisfy({ !$0.isEmpty && $0.count <= 64 }) else { return nil }
        return Data(base64Encoded: body.joined())
    }

    static func deviceId(publicKeyData: Data) -> String {
        SHA256.hash(data: publicKeyData).compactMap { String(format: "%02x", $0) }.joined()
    }

    static func material(
        publicKeyData: Data,
        privateKeyData: Data,
        createdAtMs: Int64) -> DeviceIdentityMaterial
    {
        let identity = DeviceIdentity(
            deviceId: deviceId(publicKeyData: publicKeyData),
            publicKey: publicKeyData.base64EncodedString(),
            privateKey: privateKeyData.base64EncodedString(),
            createdAtMs: createdAtMs)
        return DeviceIdentityMaterial(
            identity: identity,
            publicKeyPEM: self.pem(label: "PUBLIC KEY", der: self.ed25519SPKIPrefix + publicKeyData),
            privateKeyPEM: self.pem(label: "PRIVATE KEY", der: self.ed25519PKCS8PrivatePrefix + privateKeyData))
    }

    private static func pem(label: String, der: Data) -> String {
        let base64 = der.base64EncodedString()
        let fence = String(repeating: "-", count: 5)
        let lines = stride(from: 0, to: base64.count, by: 64).map { offset -> String in
            let start = base64.index(base64.startIndex, offsetBy: offset)
            let end = base64.index(start, offsetBy: min(64, base64.distance(from: start, to: base64.endIndex)))
            return String(base64[start..<end])
        }
        return "\(fence)BEGIN \(label)\(fence)\n\(lines.joined(separator: "\n"))\n\(fence)END \(label)\(fence)\n"
    }

    private static func databaseURL(stateDirURL: URL) -> URL {
        stateDirURL
            .appendingPathComponent("state", isDirectory: true)
            .appendingPathComponent("openclaw.sqlite", isDirectory: false)
    }
}

private struct PemDeviceIdentity: Codable {
    var version: Int
    var deviceId: String
    var publicKeyPem: String
    var privateKeyPem: String
    var createdAtMs: Int64
}
