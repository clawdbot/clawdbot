import Foundation
import OpenClawKit

enum GatewayConnectionIssue: Equatable {
    case none
    case tokenMissing
    case unauthorized
    case pairingRequired(requestId: String?)
    case network
    case unknown(String)

    var requestId: String? {
        if case let .pairingRequired(requestId) = self {
            return requestId
        }
        return nil
    }

    var needsAuthToken: Bool {
        switch self {
        case .tokenMissing, .unauthorized:
            true
        default:
            false
        }
    }

    var needsPairing: Bool {
        if case .pairingRequired = self { return true }
        return false
    }

    static func detect(problem: GatewayConnectionProblem?) -> Self {
        guard let problem else { return .none }
        if problem.needsPairingApproval {
            return .pairingRequired(requestId: problem.requestId)
        }
        if problem.needsCredentialUpdate {
            return problem.kind == .gatewayAuthTokenMissing ? .tokenMissing : .unauthorized
        }
        switch problem.kind {
        case .deviceIdentityRequired,
             .deviceSignatureExpired,
             .deviceNonceRequired,
             .deviceNonceMismatch,
             .deviceSignatureInvalid,
             .devicePublicKeyInvalid,
             .deviceIdMismatch,
             .tailscaleIdentityMissing,
             .tailscaleProxyMissing,
             .tailscaleWhoisFailed,
             .tailscaleIdentityMismatch,
             .authRateLimited:
            return .unauthorized
        case .timeout, .connectionRefused, .reachabilityFailed, .websocketCancelled:
            return .network
        case .unknown:
            return .unknown(problem.message)
        default:
            return .none
        }
    }

    static func detect(from statusText: String) -> Self {
        let trimmed = statusText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .none }
        let lower = trimmed.lowercased()

        if lower.contains("pairing required") || lower.contains("not_paired") || lower.contains("not paired") {
            return .pairingRequired(requestId: self.extractRequestId(from: trimmed))
        }
        if lower.contains("gateway token missing") {
            return .tokenMissing
        }
        if lower.contains("unauthorized") {
            return .unauthorized
        }
        if lower.contains("connection refused") ||
            lower.contains("timed out") ||
            lower.contains("network is unreachable") ||
            lower.contains("cannot find host") ||
            lower.contains("could not connect")
        {
            return .network
        }
        if lower.hasPrefix("gateway error:") {
            return .unknown(trimmed)
        }
        return .none
    }

    private static func extractRequestId(from statusText: String) -> String? {
        let marker = "requestId:"
        guard let range = statusText.range(of: marker) else { return nil }
        let suffix = statusText[range.upperBound...]
        let trimmed = suffix.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = trimmed.firstIndex(where: { ch in
            ch == ")" || ch.isWhitespace || ch == "," || ch == ";"
        }) ?? trimmed.endIndex
        let id = String(trimmed[..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? nil : id
    }
}
