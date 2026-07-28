import CryptoKit
import Foundation

func gatewayIntValue(_ value: Any?) -> Int? {
    if let value = value as? Int {
        return value
    }
    if let value = value as? Int64 {
        return Int(exactly: value)
    }
    if let value = value as? Double, value.rounded() == value {
        return Int(exactly: value)
    }
    if let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() {
        let doubleValue = value.doubleValue
        guard doubleValue.rounded() == doubleValue else {
            return nil
        }
        return Int(exactly: doubleValue)
    }
    if let value = value as? String {
        return Int(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    return nil
}

/// Bridges task cancellation into the request continuation without racing send.
final class GatewayRequestCancellationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    var isCancelled: Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.cancelled
    }

    func cancel() {
        self.lock.lock()
        self.cancelled = true
        self.lock.unlock()
    }
}

extension GatewayChannelActor {
    enum ConnectChallengeError: Error {
        case timeout
    }

    public static let defaultOperatorConnectScopes: [String] = [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.questions",
        "operator.pairing",
    ]

    struct SelectedConnectAuth {
        let authToken: String?
        let authBootstrapToken: String?
        let authDeviceToken: String?
        let authPassword: String?
        let signatureToken: String?
        let storedToken: String?
        let storedScopes: [String]?
        let authSource: GatewayAuthSource
        let suppressedDeviceTokenRetry: Bool
    }
}

extension GatewayChannelActor.SelectedConnectAuth {
    func makeAuthBinding(key: SymmetricKey?, deviceId: String?) -> GatewayAuthBinding {
        let credentialFingerprint = key.map { key in
            var values = [
                self.authSource.rawValue,
                deviceId ?? "",
            ]
            if let authToken = self.authToken {
                values.append(contentsOf: ["token", authToken])
                if let authDeviceToken = self.authDeviceToken {
                    values.append(contentsOf: ["deviceToken", authDeviceToken])
                }
            } else if let authBootstrapToken = self.authBootstrapToken {
                values.append(contentsOf: ["bootstrapToken", authBootstrapToken])
            } else if let authPassword = self.authPassword {
                values.append(contentsOf: ["password", authPassword])
            }
            let framed = values.map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
            let tag = HMAC<SHA256>.authenticationCode(for: Data(framed.utf8), using: key)
            return tag.map { String(format: "%02x", $0) }.joined()
        }
        return GatewayAuthBinding(
            source: self.authSource,
            credentialFingerprint: credentialFingerprint)
    }
}
