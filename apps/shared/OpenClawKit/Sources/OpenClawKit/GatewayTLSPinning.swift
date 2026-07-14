import CryptoKit
import Foundation
import Security

public struct GatewayTLSParams: Sendable {
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
}

public struct GatewayTLSValidationFailure: Equatable, Sendable {
    public let kind: GatewayTLSValidationFailureKind
    public let host: String
    public let storeKey: String?
    public let expectedFingerprint: String?
    public let observedFingerprint: String?
    public let systemTrustOk: Bool

    public init(
        kind: GatewayTLSValidationFailureKind,
        host: String,
        storeKey: String?,
        expectedFingerprint: String?,
        observedFingerprint: String?,
        systemTrustOk: Bool)
    {
        self.kind = kind
        self.host = host
        self.storeKey = storeKey
        self.expectedFingerprint = expectedFingerprint
        self.observedFingerprint = observedFingerprint
        self.systemTrustOk = systemTrustOk
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

public enum GatewayTLSStore {
    private static let keychainService = "ai.openclaw.tls-pinning"
    private static let keychainAccountPrefix = "fingerprint.v2."

    // Legacy UserDefaults location used before Keychain migration.
    private static let legacySuiteName = "ai.openclaw.shared"
    private static let legacyKeyPrefix = "gateway.tls."

    public static func loadFingerprint(stableID: String) -> String? {
        guard let account = self.keychainAccount(stableID: stableID) else { return nil }
        self.migrateLegacyFingerprintIfNeeded(stableID: stableID, account: account)
        let raw = GenericPasswordKeychainStore.loadString(service: self.keychainService, account: account)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if raw?.isEmpty == false { return raw }
        return nil
    }

    public static func saveFingerprint(_ value: String, stableID: String) {
        guard let account = self.keychainAccount(stableID: stableID),
              GenericPasswordKeychainStore.saveString(
                  value,
                  service: self.keychainService,
                  account: account)
        else { return }
        _ = self.clearSafeLegacyFingerprint(stableID: stableID)
    }

    @discardableResult
    public static func replaceFingerprint(_ value: String, stableID: String) -> Bool {
        guard let account = self.keychainAccount(stableID: stableID),
              GenericPasswordKeychainStore.saveString(
                  value,
                  service: self.keychainService,
                  account: account)
        else {
            return false
        }
        return self.clearSafeLegacyFingerprint(stableID: stableID)
    }

    @discardableResult
    public static func clearFingerprint(stableID: String) -> Bool {
        guard let account = self.keychainAccount(stableID: stableID) else { return false }
        let removedCanonical = GenericPasswordKeychainStore.delete(
            service: self.keychainService,
            account: account)
        let removedLegacy = self.clearSafeLegacyFingerprint(stableID: stableID)
        return removedCanonical && removedLegacy
    }

    @discardableResult
    public static func clearAllFingerprints() -> Bool {
        let removedKeychain = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.keychainService,
        ] as CFDictionary)
        self.clearAllLegacyFingerprints()
        return removedKeychain == errSecSuccess || removedKeychain == errSecItemNotFound
    }

    // MARK: - Migration

    /// Legacy raw Keychain/UserDefaults keys can apply Unicode equivalence without
    /// embedding their owner. Only ASCII owners are safe to attribute and migrate.
    private static func migrateLegacyFingerprintIfNeeded(stableID: String, account: String) {
        guard self.canSafelyReadLegacyRawStorageKey(stableID) else { return }
        let canonical = self.normalizedFingerprint(GenericPasswordKeychainStore.loadString(
            service: self.keychainService,
            account: account))
        if canonical != nil {
            _ = self.clearSafeLegacyFingerprint(stableID: stableID)
            return
        }

        let legacyKeychain = self.normalizedFingerprint(GenericPasswordKeychainStore.loadString(
            service: self.keychainService,
            account: stableID))
        let defaults = UserDefaults(suiteName: self.legacySuiteName)
        let legacyDefaults = self.normalizedFingerprint(defaults?.string(
            forKey: self.legacyKeyPrefix + stableID))
        guard let existing = legacyKeychain ?? legacyDefaults,
              GenericPasswordKeychainStore.saveString(
                  existing,
                  service: self.keychainService,
                  account: account)
        else { return }
        _ = self.clearSafeLegacyFingerprint(stableID: stableID)
    }

    private static func keychainAccount(stableID: String) -> String? {
        guard !stableID.isEmpty else { return nil }
        let component = Data(stableID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return self.keychainAccountPrefix + component
    }

    private static func canSafelyReadLegacyRawStorageKey(_ stableID: String) -> Bool {
        !stableID.isEmpty &&
            !stableID.hasPrefix(self.keychainAccountPrefix) &&
            stableID.unicodeScalars.allSatisfy(\.isASCII)
    }

    private static func normalizedFingerprint(_ value: String?) -> String? {
        let value = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }

    @discardableResult
    private static func clearSafeLegacyFingerprint(stableID: String) -> Bool {
        guard self.canSafelyReadLegacyRawStorageKey(stableID) else { return true }
        let removedKeychain = GenericPasswordKeychainStore.delete(
            service: self.keychainService,
            account: stableID)
        UserDefaults(suiteName: self.legacySuiteName)?
            .removeObject(forKey: self.legacyKeyPrefix + stableID)
        return removedKeychain
    }

    private static func clearAllLegacyFingerprints() {
        guard let defaults = UserDefaults(suiteName: self.legacySuiteName) else { return }
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(self.legacyKeyPrefix) {
            defaults.removeObject(forKey: key)
        }
    }
}

public final class GatewayTLSPinningSession: NSObject, WebSocketSessioning, URLSessionDelegate,
GatewayTLSFailureProviding, GatewayDeviceTokenRetryTrustProviding, @unchecked Sendable {
    private let params: GatewayTLSParams
    private let failureLock = NSLock()
    private var lastTLSFailure: GatewayTLSValidationFailure?
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    public init(params: GatewayTLSParams) {
        self.params = params
        super.init()
    }

    public var allowsDeviceTokenRetryAuth: Bool {
        self.params.expectedFingerprint?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
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

    private func clearTLSFailure() {
        self.failureLock.lock()
        self.lastTLSFailure = nil
        self.failureLock.unlock()
    }

    public func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    public func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
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
        let systemTrustOk = SecTrustEvaluateWithError(trust, nil)
        let expected = self.params.expectedFingerprint.map(normalizeFingerprint)
        let fingerprint = certificateFingerprint(trust)
        if let fingerprint {
            if let expected {
                if fingerprint == expected {
                    self.clearTLSFailure()
                    completionHandler(.useCredential, URLCredential(trust: trust))
                } else {
                    self.recordTLSFailure(GatewayTLSValidationFailure(
                        kind: .pinMismatch,
                        host: host,
                        storeKey: self.params.storeKey,
                        expectedFingerprint: expected,
                        observedFingerprint: fingerprint,
                        systemTrustOk: systemTrustOk))
                    completionHandler(.cancelAuthenticationChallenge, nil)
                }
                return
            }
            if self.params.allowTOFU {
                if GatewayTLSFirstUsePolicy.allowsFirstUsePin(systemTrustOk: systemTrustOk) {
                    if let storeKey = params.storeKey {
                        GatewayTLSStore.saveFingerprint(fingerprint, stableID: storeKey)
                    }
                    self.clearTLSFailure()
                    completionHandler(.useCredential, URLCredential(trust: trust))
                    return
                }
            }
        }

        if systemTrustOk || !self.params.required {
            self.clearTLSFailure()
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            self.recordTLSFailure(GatewayTLSValidationFailure(
                kind: fingerprint == nil ? .certificateUnavailable : .untrustedCertificate,
                host: host,
                storeKey: self.params.storeKey,
                expectedFingerprint: expected,
                observedFingerprint: fingerprint,
                systemTrustOk: false))
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
