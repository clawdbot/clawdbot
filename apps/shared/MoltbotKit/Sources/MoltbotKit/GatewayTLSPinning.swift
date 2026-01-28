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
    private static let suiteName = "bot.molt.shared"
    private static let legacySuiteName = "com.clawdbot.shared"
    private static let keyPrefix = "gateway.tls."

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    private static var legacyDefaults: UserDefaults? {
        UserDefaults(suiteName: legacySuiteName)
    }

    public static func loadFingerprint(stableID: String) -> String? {
        let key = self.keyPrefix + stableID
        let raw = self.defaults.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw?.isEmpty == false { return raw }

        let legacy = self.legacyDefaults?.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if legacy?.isEmpty == false {
            self.defaults.set(legacy, forKey: key)
            return legacy
        }

        return nil
    }

    public static func saveFingerprint(_ value: String, stableID: String) {
        let key = self.keyPrefix + stableID
        self.defaults.set(value, forKey: key)
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
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        let expected = params.expectedFingerprint.map(normalizeFingerprint)
        if let fingerprint = certificateFingerprint(trust) {
            if let expected {
                if fingerprint == expected {
                    completionHandler(.useCredential, URLCredential(trust: trust))
                } else {
                    completionHandler(.cancelAuthenticationChallenge, nil)
                }
                return
            }
            if params.allowTOFU {
                if let storeKey = params.storeKey {
                    GatewayTLSStore.saveFingerprint(fingerprint, stableID: storeKey)
                }
                completionHandler(.useCredential, URLCredential(trust: trust))
                return
            }
        }

        let ok = SecTrustEvaluateWithError(trust, nil)
        if ok || !params.required {
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
