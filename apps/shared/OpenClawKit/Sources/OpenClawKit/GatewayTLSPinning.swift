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

public enum GatewayTLSStore {
    private static let keychainService = "ai.openclaw.tls-pinning"

    // Legacy UserDefaults location used before Keychain migration.
    private static let legacySuiteName = "ai.openclaw.shared"
    private static let legacyKeyPrefix = "gateway.tls."

    public static func loadFingerprint(stableID: String) -> String? {
        self.migrateFromUserDefaultsIfNeeded(stableID: stableID)
        let raw = GenericPasswordKeychainStore.loadString(service: self.keychainService, account: stableID)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if raw?.isEmpty == false { return raw }
        return nil
    }

    public static func saveFingerprint(_ value: String, stableID: String) {
        _ = GenericPasswordKeychainStore.saveString(value, service: self.keychainService, account: stableID)
    }

    @discardableResult
    public static func clearFingerprint(stableID: String) -> Bool {
        let removedKeychain = GenericPasswordKeychainStore.delete(
            service: self.keychainService,
            account: stableID)
        self.clearLegacyFingerprint(stableID: stableID)
        return removedKeychain
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

    /// On first Keychain read for a given stableID, move any legacy UserDefaults
    /// fingerprint into Keychain and remove the old entry.
    private static func migrateFromUserDefaultsIfNeeded(stableID: String) {
        guard let defaults = UserDefaults(suiteName: self.legacySuiteName) else { return }
        let legacyKey = self.legacyKeyPrefix + stableID
        guard let existing = defaults.string(forKey: legacyKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        else { return }
        if GenericPasswordKeychainStore.loadString(service: self.keychainService, account: stableID) == nil {
            guard GenericPasswordKeychainStore.saveString(existing, service: self.keychainService, account: stableID)
            else {
                return
            }
        }
        defaults.removeObject(forKey: legacyKey)
    }

    private static func clearLegacyFingerprint(stableID: String) {
        guard let defaults = UserDefaults(suiteName: self.legacySuiteName) else { return }
        defaults.removeObject(forKey: self.legacyKeyPrefix + stableID)
    }

    private static func clearAllLegacyFingerprints() {
        guard let defaults = UserDefaults(suiteName: self.legacySuiteName) else { return }
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(self.legacyKeyPrefix) {
            defaults.removeObject(forKey: key)
        }
    }
}

public final class GatewayTLSPinningSession: NSObject, WebSocketSessioning, URLSessionDelegate, @unchecked Sendable {
    private let params: GatewayTLSParams
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    public init(params: GatewayTLSParams) {
        self.params = params
        super.init()
    }

    public func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        let task = self.session.webSocketTask(with: url)
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

        let expected = self.params.expectedFingerprint.map(normalizeFingerprint)
        if let fingerprint = certificateFingerprint(trust) {
            if let expected {
                if fingerprint == expected {
                    completionHandler(.useCredential, URLCredential(trust: trust))
                } else {
                    completionHandler(.cancelAuthenticationChallenge, nil)
                }
                return
            }
            if self.params.allowTOFU {
                if let storeKey = params.storeKey {
                    GatewayTLSStore.saveFingerprint(fingerprint, stableID: storeKey)
                }
                completionHandler(.useCredential, URLCredential(trust: trust))
                return
            }
        }

        let ok = SecTrustEvaluateWithError(trust, nil)
        if ok || !self.params.required {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
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
