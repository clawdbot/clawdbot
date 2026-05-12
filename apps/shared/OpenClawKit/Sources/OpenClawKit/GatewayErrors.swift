import Foundation
import OpenClawProtocol

public enum GatewayConnectAuthDetailCode: String, Sendable {
    case authRequired = "AUTH_REQUIRED"
    case authUnauthorized = "AUTH_UNAUTHORIZED"
    case authTokenMismatch = "AUTH_TOKEN_MISMATCH"
    case authBootstrapTokenInvalid = "AUTH_BOOTSTRAP_TOKEN_INVALID"
    case authDeviceTokenMismatch = "AUTH_DEVICE_TOKEN_MISMATCH"
    case authScopeMismatch = "AUTH_SCOPE_MISMATCH"
    case authTokenMissing = "AUTH_TOKEN_MISSING"
    case authTokenNotConfigured = "AUTH_TOKEN_NOT_CONFIGURED"
    case authPasswordMissing = "AUTH_PASSWORD_MISSING"
    case authPasswordMismatch = "AUTH_PASSWORD_MISMATCH"
    case authPasswordNotConfigured = "AUTH_PASSWORD_NOT_CONFIGURED"
    case authRateLimited = "AUTH_RATE_LIMITED"
    case authTailscaleIdentityMissing = "AUTH_TAILSCALE_IDENTITY_MISSING"
    case authTailscaleProxyMissing = "AUTH_TAILSCALE_PROXY_MISSING"
    case authTailscaleWhoisFailed = "AUTH_TAILSCALE_WHOIS_FAILED"
    case authTailscaleIdentityMismatch = "AUTH_TAILSCALE_IDENTITY_MISMATCH"
    case pairingRequired = "PAIRING_REQUIRED"
    case controlUiDeviceIdentityRequired = "CONTROL_UI_DEVICE_IDENTITY_REQUIRED"
    case deviceIdentityRequired = "DEVICE_IDENTITY_REQUIRED"
    case deviceAuthInvalid = "DEVICE_AUTH_INVALID"
    case deviceAuthDeviceIdMismatch = "DEVICE_AUTH_DEVICE_ID_MISMATCH"
    case deviceAuthSignatureExpired = "DEVICE_AUTH_SIGNATURE_EXPIRED"
    case deviceAuthNonceRequired = "DEVICE_AUTH_NONCE_REQUIRED"
    case deviceAuthNonceMismatch = "DEVICE_AUTH_NONCE_MISMATCH"
    case deviceAuthSignatureInvalid = "DEVICE_AUTH_SIGNATURE_INVALID"
    case deviceAuthPublicKeyInvalid = "DEVICE_AUTH_PUBLIC_KEY_INVALID"
}

public enum GatewayConnectRecoveryNextStep: String, Sendable {
    case retryWithDeviceToken = "retry_with_device_token"
    case updateAuthConfiguration = "update_auth_configuration"
    case updateAuthCredentials = "update_auth_credentials"
    case waitThenRetry = "wait_then_retry"
    case reviewAuthConfiguration = "review_auth_configuration"
}

/// Structured websocket connect-auth rejection surfaced before the channel is usable.
public struct GatewayConnectAuthError: LocalizedError, Sendable {
    public let message: String
    public let detailCodeRaw: String?
    public let recommendedNextStepRaw: String?
    public let canRetryWithDeviceToken: Bool
    public let requestId: String?
    public let detailsReason: String?
    public let ownerRaw: String?
    public let titleOverride: String?
    public let userMessageOverride: String?
    public let actionLabel: String?
    public let actionCommand: String?
    public let docsURLString: String?
    public let retryableOverride: Bool?
    public let pauseReconnectOverride: Bool?

    public init(
        message: String,
        detailCodeRaw: String?,
        canRetryWithDeviceToken: Bool,
        recommendedNextStepRaw: String? = nil,
        requestId: String? = nil,
        detailsReason: String? = nil,
        ownerRaw: String? = nil,
        titleOverride: String? = nil,
        userMessageOverride: String? = nil,
        actionLabel: String? = nil,
        actionCommand: String? = nil,
        docsURLString: String? = nil,
        retryableOverride: Bool? = nil,
        pauseReconnectOverride: Bool? = nil)
    {
        let trimmedMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedDetailCode = detailCodeRaw?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedRecommendedNextStep =
            recommendedNextStepRaw?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.message = trimmedMessage.isEmpty ? "gateway connect failed" : trimmedMessage
        self.detailCodeRaw = trimmedDetailCode?.isEmpty == false ? trimmedDetailCode : nil
        self.canRetryWithDeviceToken = canRetryWithDeviceToken
        self.recommendedNextStepRaw =
            trimmedRecommendedNextStep?.isEmpty == false ? trimmedRecommendedNextStep : nil
        self.requestId = Self.trimmedOrNil(requestId)
        self.detailsReason = Self.trimmedOrNil(detailsReason)
        self.ownerRaw = Self.trimmedOrNil(ownerRaw)
        self.titleOverride = Self.trimmedOrNil(titleOverride)
        self.userMessageOverride = Self.trimmedOrNil(userMessageOverride)
        self.actionLabel = Self.trimmedOrNil(actionLabel)
        self.actionCommand = Self.trimmedOrNil(actionCommand)
        self.docsURLString = Self.trimmedOrNil(docsURLString)
        self.retryableOverride = retryableOverride
        self.pauseReconnectOverride = pauseReconnectOverride
    }

    public init(
        message: String,
        detailCode: String?,
        canRetryWithDeviceToken: Bool,
        recommendedNextStep: String? = nil,
        requestId: String? = nil,
        detailsReason: String? = nil,
        ownerRaw: String? = nil,
        titleOverride: String? = nil,
        userMessageOverride: String? = nil,
        actionLabel: String? = nil,
        actionCommand: String? = nil,
        docsURLString: String? = nil,
        retryableOverride: Bool? = nil,
        pauseReconnectOverride: Bool? = nil)
    {
        self.init(
            message: message,
            detailCodeRaw: detailCode,
            canRetryWithDeviceToken: canRetryWithDeviceToken,
            recommendedNextStepRaw: recommendedNextStep,
            requestId: requestId,
            detailsReason: detailsReason,
            ownerRaw: ownerRaw,
            titleOverride: titleOverride,
            userMessageOverride: userMessageOverride,
            actionLabel: actionLabel,
            actionCommand: actionCommand,
            docsURLString: docsURLString,
            retryableOverride: retryableOverride,
            pauseReconnectOverride: pauseReconnectOverride)
    }

    private static func trimmedOrNil(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    public var detailCode: String? {
        self.detailCodeRaw
    }

    public var recommendedNextStepCode: String? {
        self.recommendedNextStepRaw
    }

    public var detail: GatewayConnectAuthDetailCode? {
        guard let detailCodeRaw else { return nil }
        return GatewayConnectAuthDetailCode(rawValue: detailCodeRaw)
    }

    public var recommendedNextStep: GatewayConnectRecoveryNextStep? {
        guard let recommendedNextStepRaw else { return nil }
        return GatewayConnectRecoveryNextStep(rawValue: recommendedNextStepRaw)
    }

    public var errorDescription: String? {
        self.message
    }

    public var isNonRecoverable: Bool {
        switch self.detail {
        case .authTokenMissing,
             .authBootstrapTokenInvalid,
             .authTokenNotConfigured,
             .authPasswordMissing,
             .authPasswordMismatch,
             .authPasswordNotConfigured,
             .authRateLimited,
             .authScopeMismatch,
             .pairingRequired,
             .controlUiDeviceIdentityRequired,
             .deviceIdentityRequired:
            true
        default:
            false
        }
    }
}

/// Structured error surfaced when the gateway responds with `{ ok: false }`.
public struct GatewayResponseError: LocalizedError, @unchecked Sendable {
    public let method: String
    public let code: String
    public let message: String
    public let details: [String: AnyCodable]

    public init(method: String, code: String?, message: String?, details: [String: AnyCodable]?) {
        self.method = method
        self.code = (code?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? code!.trimmingCharacters(in: .whitespacesAndNewlines)
            : "GATEWAY_ERROR"
        self.message = (message?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? message!.trimmingCharacters(in: .whitespacesAndNewlines)
            : "gateway error"
        self.details = details ?? [:]
    }

    public var detailsReason: String? {
        let raw = self.details["reason"]?.value as? String
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    public var errorDescription: String? {
        if self.code == "GATEWAY_ERROR" { return "\(self.method): \(self.message)" }
        return "\(self.method): [\(self.code)] \(self.message)"
    }
}

public struct GatewayDecodingError: LocalizedError, Sendable {
    public let method: String
    public let message: String

    public init(method: String, message: String) {
        self.method = method
        self.message = message
    }

    public var errorDescription: String? {
        "\(self.method): \(self.message)"
    }
}
