import CryptoKit
import Foundation
import Security

public struct GatewayTLSParams: Equatable, Sendable {
    public let required: Bool
    public let expectedFingerprint: String?
    public let allowTOFU: Bool
    public let storeKey: String?

    public init(required: Bool, expectedFingerprint: String?, allowTOFU: Bool, storeKey: String?) {
        self.required = required
        self.expectedFingerprint = expectedFingerprint
        self.allowTOFU = allowTOFU
        self.storeKey = storeKey
    }
}

public enum GatewayTLSValidationFailureKind: String, Sendable {
    case pinMismatch
    case certificateUnavailable
    case untrustedCertificate
    case pinStorageUnavailable
    case authorityMismatch
}

public struct GatewayTLSValidationFailure: Equatable, Sendable {
    public let kind: GatewayTLSValidationFailureKind
    public let host: String
    public let storeKey: String?
    public let expectedFingerprint: String?
    public let observedFingerprint: String?
    public let systemTrustOk: Bool
    public let port: Int?

    public init(
        kind: GatewayTLSValidationFailureKind,
        host: String,
        storeKey: String?,
        expectedFingerprint: String?,
        observedFingerprint: String?,
        systemTrustOk: Bool,
        port: Int? = nil)
    {
        self.kind = kind
        self.host = host
        self.storeKey = storeKey
        self.expectedFingerprint = expectedFingerprint
        self.observedFingerprint = observedFingerprint
        self.systemTrustOk = systemTrustOk
        self.port = port
    }
}

public struct GatewayTLSValidationError: LocalizedError, Sendable {
    public let failure: GatewayTLSValidationFailure
    public let context: String

    public init(failure: GatewayTLSValidationFailure, context: String) {
        self.failure = failure
        self.context = context
    }

    public var errorDescription: String? {
        let prefix = self.context.trimmingCharacters(in: .whitespacesAndNewlines)
        switch self.failure.kind {
        case .pinMismatch:
            let expected = self.failure.expectedFingerprint ?? "unknown"
            let observed = self.failure.observedFingerprint ?? "unknown"
            let mismatch = "expected \(expected), observed \(observed)"
            return "\(prefix): TLS certificate pin mismatch for \(self.failure.host) (\(mismatch))"
        case .certificateUnavailable:
            return "\(prefix): TLS certificate unavailable for \(self.failure.host)"
        case .untrustedCertificate:
            return "\(prefix): TLS certificate is not trusted for \(self.failure.host)"
        case .pinStorageUnavailable:
            return "\(prefix): TLS certificate pin could not be saved for \(self.failure.host)"
        case .authorityMismatch:
            return "\(prefix): TLS authority does not match the requested gateway for \(self.failure.host)"
        }
    }
}

protocol GatewayTLSFailureProviding: AnyObject {
    func consumeLastTLSFailure() -> GatewayTLSValidationFailure?
}

protocol GatewayDeviceTokenRetryTrustProviding: AnyObject {
    var allowsDeviceTokenRetryAuth: Bool { get }
}

enum GatewayTLSFirstUsePolicy {
    static func allowsFirstUsePin(systemTrustOk: Bool) -> Bool {
        systemTrustOk
    }
}

enum GatewayTLSChallengeDecision: Equatable {
    case accept(fingerprint: String?, enforcePin: Bool, saveFirstUse: Bool)
    case reject(GatewayTLSValidationFailureKind)
}

enum GatewayTLSValidationPolicy {
    static func decide(
        expectedFingerprint: String?,
        observedFingerprint: String?,
        allowTOFU: Bool,
        required: Bool,
        systemTrustOk: Bool) -> GatewayTLSChallengeDecision
    {
        if let expectedFingerprint {
            guard let observedFingerprint else {
                return .reject(.certificateUnavailable)
            }
            return observedFingerprint == expectedFingerprint
                ? .accept(fingerprint: observedFingerprint, enforcePin: true, saveFirstUse: false)
                : .reject(.pinMismatch)
        }
        if allowTOFU,
           let observedFingerprint,
           GatewayTLSFirstUsePolicy.allowsFirstUsePin(systemTrustOk: systemTrustOk)
        {
            return .accept(fingerprint: observedFingerprint, enforcePin: true, saveFirstUse: true)
        }
        if allowTOFU, required {
            return .reject(observedFingerprint == nil ? .certificateUnavailable : .untrustedCertificate)
        }
        if systemTrustOk || !required {
            return .accept(fingerprint: observedFingerprint, enforcePin: false, saveFirstUse: false)
        }
        return .reject(observedFingerprint == nil ? .certificateUnavailable : .untrustedCertificate)
    }
}

final class GatewayTLSFirstUseClaims: @unchecked Sendable {
    private let lock = NSLock()
    private var fingerprints: [String: String] = [:]

    func record(_ fingerprint: String, stableID: String) {
        self.lock.lock()
        self.fingerprints[stableID] = fingerprint
        self.lock.unlock()
    }

    func fingerprint(stableID: String) -> String? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.fingerprints[stableID]
    }

    func clear(stableID: String) {
        self.lock.lock()
        self.fingerprints[stableID] = nil
        self.lock.unlock()
    }

    func clearAll() {
        self.lock.lock()
        self.fingerprints.removeAll()
        self.lock.unlock()
    }
}

struct GatewayTLSKeychainOperations: @unchecked Sendable {
    let copyMatching: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    let add: (CFDictionary) -> OSStatus
    let update: (CFDictionary, CFDictionary) -> OSStatus
    let delete: (CFDictionary) -> OSStatus

    static let live = GatewayTLSKeychainOperations(
        copyMatching: { SecItemCopyMatching($0, $1) },
        add: { SecItemAdd($0, nil) },
        update: { SecItemUpdate($0, $1) },
        delete: { SecItemDelete($0) })
}

public enum GatewayTLSStore {
    @TaskLocal static var keychainOperations = GatewayTLSKeychainOperations.live

    private enum FingerprintRead {
        case missing
        case value(String)
        case unavailable
    }

    private static let keychainService = "ai.openclaw.tls-pinning"
    private static let keychainAccountPrefix = "fingerprint.v3."
    private static let legacyCanonicalAccountPrefix = "fingerprint.v2."

    // Legacy UserDefaults location used before Keychain migration.
    private static let legacySuiteName = "ai.openclaw.shared"
    private static let legacyKeyPrefix = "gateway.tls."
    private static let firstUseClaims = GatewayTLSFirstUseClaims()

    public static func loadFingerprint(stableID: String) -> String? {
        guard case let .value(fingerprint) = self.loadFingerprintResult(stableID: stableID) else {
            return nil
        }
        return fingerprint
    }

    public static func saveFingerprint(_ value: String, stableID: String) {
        guard self.writeCanonicalFingerprint(value, stableID: stableID) else { return }
        _ = self.clearSafeLegacyFingerprint(stableID: stableID)
    }

    static func claimFirstUseFingerprint(_ value: String, stableID: String) -> String? {
        guard let account = self.keychainAccount(stableID: stableID) else { return nil }
        switch self.loadFingerprintResult(stableID: stableID) {
        case let .value(existing):
            self.firstUseClaims.record(existing, stableID: stableID)
            return existing
        case .unavailable:
            return nil
        case .missing:
            break
        }

        let claimed = self.createCanonicalFingerprintIfAbsent(value, account: account)
        if claimed != nil {
            _ = self.clearSafeLegacyFingerprint(stableID: stableID)
        }
        if let claimed {
            self.firstUseClaims.record(claimed, stableID: stableID)
        }
        return claimed
    }

    public static func claimedFirstUseFingerprint(stableID: String) -> String? {
        self.firstUseClaims.fingerprint(stableID: stableID)
    }

    @discardableResult
    public static func replaceFingerprint(_ value: String, stableID: String) -> Bool {
        guard self.writeCanonicalFingerprint(value, stableID: stableID) else { return false }
        return self.clearSafeLegacyFingerprint(stableID: stableID)
    }

    @discardableResult
    public static func replaceFingerprint(
        _ value: String,
        ifCurrent expectedValue: String,
        stableID: String) -> Bool
    {
        guard let account = self.keychainAccount(stableID: stableID) else { return false }
        let expectedData = Data(self.canonicalStoredFingerprint(expectedValue).utf8)
        let replacementData = Data(self.canonicalStoredFingerprint(value).utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.keychainService,
            kSecAttrAccount as String: account,
            kSecAttrGeneric as String: expectedData,
        ]
        let updates: [String: Any] = [
            kSecValueData as String: replacementData,
            kSecAttrGeneric as String: replacementData,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        guard self.keychainOperations.update(query as CFDictionary, updates as CFDictionary) == errSecSuccess else {
            return false
        }
        return self.clearSafeLegacyFingerprint(stableID: stableID)
    }

    @discardableResult
    public static func clearFingerprint(stableID: String) -> Bool {
        guard let account = self.keychainAccount(stableID: stableID) else { return false }
        let removedCanonical = self.deleteFingerprint(account: account)
        let removedLegacy = self.clearSafeLegacyFingerprint(stableID: stableID)
        let removed = removedCanonical && removedLegacy
        if removed {
            self.firstUseClaims.clear(stableID: stableID)
        }
        return removed
    }

    @discardableResult
    public static func clearAllFingerprints() -> Bool {
        let removedKeychain = self.keychainOperations.delete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.keychainService,
        ] as CFDictionary)
        self.clearAllLegacyFingerprints()
        let removed = removedKeychain == errSecSuccess || removedKeychain == errSecItemNotFound
        if removed {
            self.firstUseClaims.clearAll()
        }
        return removed
    }

    // MARK: - Migration

    /// v3 stores the canonical fingerprint in both value data and a searchable
    /// comparison attribute. Older records migrate by atomically creating v3;
    /// concurrent writers always keep the first complete v3 record.
    private static func loadFingerprintResult(stableID: String) -> FingerprintRead {
        guard let account = self.keychainAccount(stableID: stableID) else { return .unavailable }
        switch self.readCanonicalFingerprint(account: account) {
        case let .value(fingerprint):
            _ = self.clearSafeLegacyFingerprint(stableID: stableID)
            return .value(fingerprint)
        case .unavailable:
            return .unavailable
        case .missing:
            return self.migrateLegacyFingerprint(stableID: stableID, account: account)
        }
    }

    private static func migrateLegacyFingerprint(
        stableID: String,
        account: String) -> FingerprintRead
    {
        let v2Account = self.keychainAccount(
            stableID: stableID,
            prefix: self.legacyCanonicalAccountPrefix)
        if let v2Account {
            switch self.readLegacyKeychainFingerprint(account: v2Account) {
            case let .value(fingerprint):
                return self.migrateLegacyFingerprint(
                    fingerprint,
                    stableID: stableID,
                    account: account)
            case .unavailable:
                return .unavailable
            case .missing:
                break
            }
        }
        guard self.canSafelyReadLegacyRawStorageKey(stableID) else { return .missing }

        switch self.readLegacyKeychainFingerprint(account: stableID) {
        case let .value(fingerprint):
            return self.migrateLegacyFingerprint(
                fingerprint,
                stableID: stableID,
                account: account)
        case .unavailable:
            return .unavailable
        case .missing:
            break
        }
        switch self.readLegacyDefaultsFingerprint(stableID: stableID) {
        case let .value(fingerprint):
            return self.migrateLegacyFingerprint(
                fingerprint,
                stableID: stableID,
                account: account)
        case .unavailable:
            return .unavailable
        case .missing:
            return .missing
        }
    }

    private static func migrateLegacyFingerprint(
        _ fingerprint: String,
        stableID: String,
        account: String) -> FingerprintRead
    {
        guard let winner = self.createCanonicalFingerprintIfAbsent(fingerprint, account: account) else {
            return .unavailable
        }
        _ = self.clearSafeLegacyFingerprint(stableID: stableID)
        return .value(winner)
    }

    private static func readCanonicalFingerprint(account: String) -> FingerprintRead {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.keychainService,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = self.keychainOperations.copyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return .missing
        }
        guard status == errSecSuccess,
              let item = result as? [String: Any],
              let data = item[kSecValueData as String] as? Data,
              let comparisonData = item[kSecAttrGeneric as String] as? Data,
              let value = String(data: data, encoding: .utf8),
              let comparison = String(data: comparisonData, encoding: .utf8)
        else { return .unavailable }
        let fingerprint = self.canonicalStoredFingerprint(value)
        return comparison == fingerprint ? .value(fingerprint) : .unavailable
    }

    private static func loadCanonicalFingerprint(account: String) -> String? {
        guard case let .value(fingerprint) = self.readCanonicalFingerprint(account: account) else {
            return nil
        }
        return fingerprint
    }

    private static func readLegacyKeychainFingerprint(account: String) -> FingerprintRead {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.keychainService,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = self.keychainOperations.copyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return .missing
        }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8),
              let fingerprint = self.normalizedFingerprint(value)
        else { return .unavailable }
        return .value(fingerprint)
    }

    private static func readLegacyDefaultsFingerprint(stableID: String) -> FingerprintRead {
        guard let defaults = UserDefaults(suiteName: self.legacySuiteName) else { return .unavailable }
        let key = self.legacyKeyPrefix + stableID
        guard let value = defaults.object(forKey: key) else { return .missing }
        guard let raw = value as? String,
              let fingerprint = self.normalizedFingerprint(raw)
        else { return .unavailable }
        return .value(fingerprint)
    }

    private static func writeCanonicalFingerprint(_ value: String, stableID: String) -> Bool {
        guard let account = self.keychainAccount(stableID: stableID) else { return false }
        return self.writeCanonicalFingerprint(value, account: account)
    }

    private static func writeCanonicalFingerprint(_ value: String, account: String) -> Bool {
        let data = Data(self.canonicalStoredFingerprint(value).utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.keychainService,
            kSecAttrAccount as String: account,
        ]
        let updates: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrGeneric as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = self.keychainOperations.update(query as CFDictionary, updates as CFDictionary)
        if updateStatus == errSecSuccess {
            return true
        }
        guard updateStatus == errSecItemNotFound else { return false }
        return self.createCanonicalFingerprintIfAbsent(value, account: account) != nil
    }

    private static func createCanonicalFingerprintIfAbsent(
        _ value: String,
        account: String) -> String?
    {
        let fingerprint = self.canonicalStoredFingerprint(value)
        let data = Data(fingerprint.utf8)
        let insert: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.keychainService,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrGeneric as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let addStatus = self.keychainOperations.add(insert as CFDictionary)
        if addStatus == errSecSuccess {
            return fingerprint
        }
        guard addStatus == errSecDuplicateItem else { return nil }
        return self.loadCanonicalFingerprint(account: account)
    }

    private static func keychainAccount(stableID: String) -> String? {
        self.keychainAccount(stableID: stableID, prefix: self.keychainAccountPrefix)
    }

    private static func keychainAccount(stableID: String, prefix: String) -> String? {
        guard !stableID.isEmpty else { return nil }
        let component = Data(stableID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return prefix + component
    }

    private static func canSafelyReadLegacyRawStorageKey(_ stableID: String) -> Bool {
        !stableID.isEmpty &&
            !stableID.hasPrefix(self.keychainAccountPrefix) &&
            !stableID.hasPrefix(self.legacyCanonicalAccountPrefix) &&
            stableID.unicodeScalars.allSatisfy(\.isASCII)
    }

    private static func canonicalStoredFingerprint(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = normalizeFingerprint(trimmed)
        return normalized.count == 64 ? normalized : trimmed
    }

    private static func normalizedFingerprint(_ value: String?) -> String? {
        let value = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }

    @discardableResult
    private static func clearSafeLegacyFingerprint(stableID: String) -> Bool {
        let removedV2 = self.keychainAccount(
            stableID: stableID,
            prefix: self.legacyCanonicalAccountPrefix).map {
            self.deleteFingerprint(account: $0)
        } ?? true
        guard self.canSafelyReadLegacyRawStorageKey(stableID) else { return removedV2 }
        let removedRaw = self.deleteFingerprint(account: stableID)
        UserDefaults(suiteName: self.legacySuiteName)?
            .removeObject(forKey: self.legacyKeyPrefix + stableID)
        return removedRaw && removedV2
    }

    private static func deleteFingerprint(account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.keychainService,
            kSecAttrAccount as String: account,
        ]
        let status = self.keychainOperations.delete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private static func clearAllLegacyFingerprints() {
        guard let defaults = UserDefaults(suiteName: self.legacySuiteName) else { return }
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(self.legacyKeyPrefix) {
            defaults.removeObject(forKey: key)
        }
    }
}

public protocol GatewayTLSRouteMetadataProviding: AnyObject {
    var effectiveTLSFingerprintSHA256: String? { get }
}

struct GatewayTLSAuthority: Equatable, Sendable {
    let host: String
    let port: Int

    init?(url: URL) {
        guard let host = Self.normalizedHost(url.host) else { return nil }
        self.host = host
        self.port = url.port ?? (url.scheme?.lowercased() == "wss" ? 443 : 80)
    }

    init?(host: String, port: Int) {
        guard let host = Self.normalizedHost(host) else { return nil }
        self.host = host
        self.port = port
    }

    private static func normalizedHost(_ host: String?) -> String? {
        let value = host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return value.isEmpty ? nil : value
    }
}

struct GatewayTLSPinningState {
    private(set) var acceptedFingerprint: String?
    private(set) var enforcedFingerprint: String?

    init(expectedFingerprint: String?) {
        let expected = expectedFingerprint.map(normalizeFingerprint)
        self.enforcedFingerprint = expected
        self.acceptedFingerprint = expected.flatMap { $0.count == 64 ? $0 : nil }
    }

    mutating func enforceFingerprint(_ fingerprint: String) {
        self.enforcedFingerprint = fingerprint
    }

    mutating func recordAcceptance(_ fingerprint: String?, enforcePin: Bool) {
        guard let fingerprint else { return }
        self.acceptedFingerprint = fingerprint
        if enforcePin {
            self.enforcedFingerprint = fingerprint
        }
    }
}

public final class GatewayTLSPinningSession: NSObject, WebSocketSessioning, URLSessionDelegate,
    GatewayTLSFailureProviding, GatewayDeviceTokenRetryTrustProviding, GatewayTLSRouteMetadataProviding,
    @unchecked Sendable
{
    private let params: GatewayTLSParams
    private let failureLock = NSLock()
    private var lastTLSFailure: GatewayTLSValidationFailure?
    private var pinningState: GatewayTLSPinningState
    private var expectedAuthority: GatewayTLSAuthority?
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    public init(params: GatewayTLSParams) {
        self.params = params
        self.pinningState = GatewayTLSPinningState(expectedFingerprint: params.expectedFingerprint)
        super.init()
    }

    public var allowsDeviceTokenRetryAuth: Bool {
        self.failureLock.lock()
        defer { self.failureLock.unlock() }
        return self.pinningState.enforcedFingerprint != nil
    }

    public var effectiveTLSFingerprintSHA256: String? {
        self.failureLock.lock()
        defer { self.failureLock.unlock() }
        return self.pinningState.acceptedFingerprint
    }

    public func consumeLastTLSFailure() -> GatewayTLSValidationFailure? {
        self.failureLock.lock()
        defer { self.failureLock.unlock() }
        let failure = self.lastTLSFailure
        self.lastTLSFailure = nil
        return failure
    }

    private func recordTLSFailure(_ failure: GatewayTLSValidationFailure) {
        self.failureLock.lock()
        self.lastTLSFailure = failure
        self.failureLock.unlock()
    }

    private func currentEnforcedFingerprint() -> String? {
        self.failureLock.lock()
        defer { self.failureLock.unlock() }
        return self.pinningState.enforcedFingerprint
    }

    private func recordTLSPinExpectation(_ fingerprint: String) {
        self.failureLock.lock()
        self.pinningState.enforceFingerprint(fingerprint)
        self.failureLock.unlock()
    }

    private func recordTLSAcceptance(_ fingerprint: String?, enforcePin: Bool) {
        self.failureLock.lock()
        self.lastTLSFailure = nil
        self.pinningState.recordAcceptance(fingerprint, enforcePin: enforcePin)
        self.failureLock.unlock()
    }

    private func registerExpectedAuthority(url: URL?) {
        guard let url, let authority = GatewayTLSAuthority(url: url) else { return }
        self.failureLock.lock()
        if self.expectedAuthority == nil {
            self.expectedAuthority = authority
        }
        self.failureLock.unlock()
    }

    private func currentExpectedAuthority() -> GatewayTLSAuthority? {
        self.failureLock.lock()
        defer { self.failureLock.unlock() }
        return self.expectedAuthority
    }

    public func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    public func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        self.registerExpectedAuthority(url: request.url)
        let task = self.session.webSocketTask(with: request)
        task.maximumMessageSize = 16 * 1024 * 1024
        return WebSocketTaskBox(task: task)
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        let host = challenge.protectionSpace.host
        let port = challenge.protectionSpace.port
        let expected = self.currentEnforcedFingerprint()
        let challengedAuthority = GatewayTLSAuthority(host: host, port: port)
        guard let expectedAuthority = self.currentExpectedAuthority(),
              challengedAuthority == expectedAuthority
        else {
            self.recordTLSFailure(GatewayTLSValidationFailure(
                kind: .authorityMismatch,
                host: host,
                storeKey: self.params.storeKey,
                expectedFingerprint: expected,
                observedFingerprint: nil,
                systemTrustOk: false,
                port: port))
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let systemTrustOk = SecTrustEvaluateWithError(trust, nil)
        let fingerprint = certificateFingerprint(trust)
        let decision = GatewayTLSValidationPolicy.decide(
            expectedFingerprint: expected,
            observedFingerprint: fingerprint,
            allowTOFU: self.params.allowTOFU,
            required: self.params.required,
            systemTrustOk: systemTrustOk)

        switch decision {
        case let .accept(acceptedFingerprint, enforcePin, saveFirstUse):
            if saveFirstUse {
                guard let acceptedFingerprint,
                      let storeKey = self.params.storeKey,
                      let claimedFingerprint = GatewayTLSStore.claimFirstUseFingerprint(
                          acceptedFingerprint,
                          stableID: storeKey)
                else {
                    self.recordTLSFailure(GatewayTLSValidationFailure(
                        kind: .pinStorageUnavailable,
                        host: host,
                        storeKey: self.params.storeKey,
                        expectedFingerprint: nil,
                        observedFingerprint: acceptedFingerprint,
                        systemTrustOk: systemTrustOk,
                        port: challenge.protectionSpace.port))
                    completionHandler(.cancelAuthenticationChallenge, nil)
                    return
                }
                guard claimedFingerprint == acceptedFingerprint else {
                    self.recordTLSPinExpectation(claimedFingerprint)
                    self.recordTLSFailure(GatewayTLSValidationFailure(
                        kind: .pinMismatch,
                        host: host,
                        storeKey: storeKey,
                        expectedFingerprint: claimedFingerprint,
                        observedFingerprint: acceptedFingerprint,
                        systemTrustOk: systemTrustOk,
                        port: challenge.protectionSpace.port))
                    completionHandler(.cancelAuthenticationChallenge, nil)
                    return
                }
            }
            self.recordTLSAcceptance(acceptedFingerprint, enforcePin: enforcePin)
            completionHandler(.useCredential, URLCredential(trust: trust))
        case let .reject(kind):
            self.recordTLSFailure(GatewayTLSValidationFailure(
                kind: kind,
                host: host,
                storeKey: self.params.storeKey,
                expectedFingerprint: expected,
                observedFingerprint: fingerprint,
                systemTrustOk: systemTrustOk,
                port: challenge.protectionSpace.port))
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}

private func certificateFingerprint(_ trust: SecTrust) -> String? {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
          let cert = chain.first
    else {
        return nil
    }
    return sha256Hex(SecCertificateCopyData(cert) as Data)
}

private func sha256Hex(_ data: Data) -> String {
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
}

private func normalizeFingerprint(_ raw: String) -> String {
    let stripped = raw.replacingOccurrences(
        of: #"(?i)^sha-?256\s*:?\s*"#,
        with: "",
        options: .regularExpression)
    return stripped.lowercased().filter(\.isHexDigit)
}
