import CryptoKit
import Foundation
import OpenClawProtocol

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

func gatewayErrorDetails(_ error: ErrorShape?) -> [String: OpenClawProtocol.AnyCodable] {
    var details: [String: OpenClawProtocol.AnyCodable] = [:]
    if let nested = error?.details?.value as? [String: OpenClawProtocol.AnyCodable] {
        details.merge(nested) { _, nestedValue in nestedValue }
    }
    if let error {
        if details["code"] == nil {
            details["code"] = OpenClawProtocol.AnyCodable(error.code)
        } else {
            details["errorCode"] = OpenClawProtocol.AnyCodable(error.code)
        }
        details["message"] = OpenClawProtocol.AnyCodable(error.message)
        if let retryable = error.retryable {
            details["retryable"] = OpenClawProtocol.AnyCodable(retryable)
        }
        if let retryAfterMs = error.retryafterms {
            details["retryAfterMs"] = OpenClawProtocol.AnyCodable(retryAfterMs)
        }
    }
    return details
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
    nonisolated static func resolveRequestTimeoutMs(_ timeoutMs: Double?, defaultMs: Double) -> Double? {
        timeoutMs == 0 ? nil : (timeoutMs ?? defaultMs)
    }

    nonisolated static func minimumProtocolVersion(role: String, clientMode: String) -> Int {
        // Node RPC frames stayed compatible across v3/v4. Operator chat surfaces require v4.
        if role == "node", clientMode == "node" {
            return GATEWAY_MIN_NODE_PROTOCOL_VERSION
        }
        return GATEWAY_MIN_PROTOCOL_VERSION
    }

    enum ConnectChallengeError: Error {
        case invalid
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

    struct PendingRequest {
        let continuation: CheckedContinuation<GatewayFrame, Error>
        let onResponse: (@Sendable (ResponseFrame) async -> Void)?
    }

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
