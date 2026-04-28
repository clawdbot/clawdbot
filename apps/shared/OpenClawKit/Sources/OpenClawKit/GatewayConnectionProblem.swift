import Foundation

public struct GatewayConnectionProblem: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable {
        case gatewayAuthTokenMissing
        case gatewayAuthTokenMismatch
        case gatewayAuthTokenNotConfigured
        case gatewayAuthPasswordMissing
        case gatewayAuthPasswordMismatch
        case gatewayAuthPasswordNotConfigured
        case bootstrapTokenInvalid
        case deviceTokenMismatch
        case pairingRequired
        case pairingRoleUpgradeRequired
        case pairingScopeUpgradeRequired
        case pairingMetadataUpgradeRequired
        case deviceIdentityRequired
        case deviceSignatureExpired
        case deviceNonceRequired
        case deviceNonceMismatch
        case deviceSignatureInvalid
        case devicePublicKeyInvalid
        case deviceIdMismatch
        case tailscaleIdentityMissing
        case tailscaleProxyMissing
        case tailscaleWhoisFailed
        case tailscaleIdentityMismatch
        case authRateLimited
        case timeout
        case connectionRefused
        case reachabilityFailed
        case websocketCancelled
        case unknown
    }

    public enum Owner: String, Equatable, Sendable {
        case gateway
        case iphone
        case both
        case network
        case unknown
    }

    public let kind: Kind
    public let owner: Owner
    public let title: String
    public let message: String
    public let actionLabel: String?
    public let actionCommand: String?
    public let docsURL: URL?
    public let requestId: String?
    public let retryable: Bool
    public let pauseReconnect: Bool
    public let technicalDetails: String?

    public init(
        kind: Kind,
        owner: Owner,
        title: String,
        message: String,
        actionLabel: String? = nil,
        actionCommand: String? = nil,
        docsURL: URL? = nil,
        requestId: String? = nil,
        retryable: Bool,
        pauseReconnect: Bool,
        technicalDetails: String? = nil)
    {
        self.kind = kind
        self.owner = owner
        self.title = title
        self.message = message
        self.actionLabel = Self.trimmedOrNil(actionLabel)
        self.actionCommand = Self.trimmedOrNil(actionCommand)
        self.docsURL = docsURL
        self.requestId = Self.trimmedOrNil(requestId)
        self.retryable = retryable
        self.pauseReconnect = pauseReconnect
        self.technicalDetails = Self.trimmedOrNil(technicalDetails)
    }

    public var needsPairingApproval: Bool {
        switch self.kind {
        case .pairingRequired, .pairingRoleUpgradeRequired, .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired:
            true
        default:
            false
        }
    }

    public var needsCredentialUpdate: Bool {
        switch self.kind {
        case .gatewayAuthTokenMissing,
             .gatewayAuthTokenMismatch,
             .gatewayAuthTokenNotConfigured,
             .gatewayAuthPasswordMissing,
             .gatewayAuthPasswordMismatch,
             .gatewayAuthPasswordNotConfigured,
             .bootstrapTokenInvalid,
             .deviceTokenMismatch:
            true
        default:
            false
        }
    }

    public var statusText: String {
        switch self.kind {
        case .pairingRequired, .pairingRoleUpgradeRequired, .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired:
            if let requestId {
                return "\(self.title) (request ID: \(requestId))"
            }
            return self.title
        default:
            return self.title
        }
    }

    private static func trimmedOrNil(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

public enum GatewayConnectionProblemMapper {
    public static func map(
        error: Error,
        preserving previousProblem: GatewayConnectionProblem? = nil) -> GatewayConnectionProblem?
    {
        guard let nextProblem = self.rawMap(error) else {
            return nil
        }
        guard let previousProblem else {
            return nextProblem
        }
        if self.shouldPreserve(previousProblem: previousProblem, over: nextProblem) {
            return previousProblem
        }
        return nextProblem
    }

    public static func shouldPreserve(
        previousProblem: GatewayConnectionProblem,
        over nextProblem: GatewayConnectionProblem) -> Bool
    {
        if nextProblem.kind == .websocketCancelled {
            return previousProblem.pauseReconnect || previousProblem.requestId != nil
        }
        return false
    }

    public static func shouldPreserve(
        previousProblem: GatewayConnectionProblem,
        overDisconnectReason reason: String) -> Bool
    {
        let normalized = reason.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return false }
        if normalized.contains("cancelled") || normalized.contains("canceled") {
            return previousProblem.pauseReconnect || previousProblem.requestId != nil
        }
        return false
    }

    private static func rawMap(_ error: Error) -> GatewayConnectionProblem? {
        if let authError = error as? GatewayConnectAuthError {
            return self.map(authError)
        }
        if let responseError = error as? GatewayResponseError {
            return self.map(responseError)
        }
        return self.mapTransportError(error)
    }

    private static func map(_ authError: GatewayConnectAuthError) -> GatewayConnectionProblem {
        let pairingCommand = self.approvalCommand(requestId: authError.requestId)

        switch authError.detail {
        case .authTokenMissing:
            return self.problem(
                kind: .gatewayAuthTokenMissing,
                owner: .both,
                title: authError.titleOverride ?? "Gateway token required",
                message: authError.userMessageOverride
                    ?? "This gateway requires an auth token, but this iPhone did not send one.",
                actionLabel: authError.actionLabel ?? "Open Settings",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(
                    authError.docsURLString,
                    fallback: "https://docs.openclaw.ai/gateway/authentication"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authTokenMismatch:
            return self.problem(
                kind: .gatewayAuthTokenMismatch,
                owner: .both,
                title: authError.titleOverride ?? "Gateway token is out of date",
                message: authError.userMessageOverride
                    ?? "The token on this iPhone does not match the gateway token.",
                actionLabel: authError
                    .actionLabel ?? (authError.canRetryWithDeviceToken ? "Retry once" : "Update gateway token"),
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(
                    authError.docsURLString,
                    fallback: "https://docs.openclaw.ai/gateway/authentication"),
                requestId: authError.requestId,
                retryable: authError.retryableOverride ?? authError.canRetryWithDeviceToken,
                pauseReconnect: authError.pauseReconnectOverride ?? !authError.canRetryWithDeviceToken,
                authError: authError)
        case .authTokenNotConfigured:
            return self.problem(
                kind: .gatewayAuthTokenNotConfigured,
                owner: .gateway,
                title: authError.titleOverride ?? "Gateway token is not configured",
                message: authError.userMessageOverride
                    ?? "This gateway is set to token auth, but no gateway token is configured on the gateway.",
                actionLabel: authError.actionLabel ?? "Fix on gateway",
                actionCommand: authError.actionCommand ?? "openclaw config set gateway.auth.token <new-token>",
                docsURL: self.docsURL(
                    authError.docsURLString,
                    fallback: "https://docs.openclaw.ai/gateway/authentication"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authPasswordMissing:
            return self.problem(
                kind: .gatewayAuthPasswordMissing,
                owner: .both,
                title: authError.titleOverride ?? "Gateway password required",
                message: authError.userMessageOverride
                    ?? "This gateway requires a password, but this iPhone did not send one.",
                actionLabel: authError.actionLabel ?? "Open Settings",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(
                    authError.docsURLString,
                    fallback: "https://docs.openclaw.ai/gateway/authentication"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authPasswordMismatch:
            return self.problem(
                kind: .gatewayAuthPasswordMismatch,
                owner: .both,
                title: authError.titleOverride ?? "Gateway password is out of date",
                message: authError.userMessageOverride
                    ?? "The saved password on this iPhone does not match the gateway password.",
                actionLabel: authError.actionLabel ?? "Update password",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(
                    authError.docsURLString,
                    fallback: "https://docs.openclaw.ai/gateway/authentication"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authPasswordNotConfigured:
            return self.problem(
                kind: .gatewayAuthPasswordNotConfigured,
                owner: .gateway,
                title: authError.titleOverride ?? "Gateway password is not configured",
                message: authError.userMessageOverride
                    ?? "This gateway is set to password auth, but no gateway password is configured on the gateway.",
                actionLabel: authError.actionLabel ?? "Fix on gateway",
                actionCommand: authError.actionCommand ?? "openclaw config set gateway.auth.password <new-password>",
                docsURL: self.docsURL(
                    authError.docsURLString,
                    fallback: "https://docs.openclaw.ai/gateway/authentication"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authBootstrapTokenInvalid:
            return self.problem(
                kind: .bootstrapTokenInvalid,
                owner: .iphone,
                title: authError.titleOverride ?? "Setup code expired",
                message: authError.userMessageOverride
                    ?? "The setup QR or bootstrap token is no longer valid.",
                actionLabel: authError.actionLabel ?? "Scan QR again",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/platforms/ios"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authDeviceTokenMismatch:
            return self.problem(
                kind: .deviceTokenMismatch,
                owner: .both,
                title: authError.titleOverride ?? "This iPhone's saved device token is no longer valid",
                message: authError.userMessageOverride
                    ?? "The gateway rejected the stored device token for this role.",
                actionLabel: authError.actionLabel ?? "Repair pairing",
                actionCommand: authError.actionCommand ?? pairingCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/pairing"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .pairingRequired:
            return self.pairingProblem(for: authError)
        case .controlUiDeviceIdentityRequired, .deviceIdentityRequired:
            return self.problem(
                kind: .deviceIdentityRequired,
                owner: .iphone,
                title: authError.titleOverride ?? "Secure device identity is required",
                message: authError.userMessageOverride
                    ??
                    "This connection must include a signed device identity before the gateway can bind permissions to this iPhone.",
                actionLabel: authError.actionLabel ?? "Retry from the app",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/platforms/ios"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .deviceAuthSignatureExpired:
            return self.problem(
                kind: .deviceSignatureExpired,
                owner: .iphone,
                title: authError.titleOverride ?? "Secure handshake expired",
                message: authError.userMessageOverride ?? "The device signature is too old to use.",
                actionLabel: authError.actionLabel ?? "Check iPhone time",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(
                    authError.docsURLString,
                    fallback: "https://docs.openclaw.ai/gateway/troubleshooting"),
                requestId: authError.requestId,
                retryable: true,
                pauseReconnect: true,
                authError: authError)
        case .deviceAuthNonceRequired:
            return self.problem(
                kind: .deviceNonceRequired,
                owner: .iphone,
                title: authError.titleOverride ?? "Secure handshake is incomplete",
                message: authError.userMessageOverride
                    ?? "The gateway expected a one-time challenge response, but the nonce was missing.",
                actionLabel: authError.actionLabel ?? "Retry",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(
                    authError.docsURLString,
                    fallback: "https://docs.openclaw.ai/gateway/troubleshooting"),
                requestId: authError.requestId,
                retryable: true,
                pauseReconnect: true,
                authError: authError)
        case .deviceAuthNonceMismatch:
            return self.problem(
                kind: .deviceNonceMismatch,
                owner: .iphone,
                title: authError.titleOverride ?? "Secure handshake did not match",
                message: authError.userMessageOverride ?? "The challenge response was stale or mismatched.",
                actionLabel: authError.actionLabel ?? "Retry",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(
                    authError.docsURLString,
                    fallback: "https://docs.openclaw.ai/gateway/troubleshooting"),
                requestId: authError.requestId,
                retryable: true,
                pauseReconnect: true,
                authError: authError)
        case .deviceAuthSignatureInvalid, .deviceAuthInvalid:
            return self.problem(
                kind: .deviceSignatureInvalid,
                owner: .iphone,
                title: authError.titleOverride ?? "This device identity could not be verified",
                message: authError.userMessageOverride
                    ?? "The gateway could not verify the identity this iPhone presented.",
                actionLabel: authError.actionLabel ?? "Re-pair this iPhone",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/pairing"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .deviceAuthPublicKeyInvalid:
            return self.problem(
                kind: .devicePublicKeyInvalid,
                owner: .iphone,
                title: authError.titleOverride ?? "This device identity could not be verified",
                message: authError.userMessageOverride
                    ?? "The gateway could not verify the public key this iPhone presented.",
                actionLabel: authError.actionLabel ?? "Re-pair this iPhone",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/pairing"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .deviceAuthDeviceIdMismatch:
            return self.problem(
                kind: .deviceIdMismatch,
                owner: .iphone,
                title: authError.titleOverride ?? "This device identity could not be verified",
                message: authError.userMessageOverride
                    ?? "The gateway rejected the device identity because the device ID did not match.",
                actionLabel: authError.actionLabel ?? "Re-pair this iPhone",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/pairing"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authTailscaleIdentityMissing:
            return self.problem(
                kind: .tailscaleIdentityMissing,
                owner: .network,
                title: authError.titleOverride ?? "Tailscale identity check failed",
                message: authError.userMessageOverride
                    ?? "This connection expected Tailscale identity headers, but they were not available.",
                actionLabel: authError.actionLabel ?? "Turn on Tailscale",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/tailscale"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authTailscaleProxyMissing:
            return self.problem(
                kind: .tailscaleProxyMissing,
                owner: .network,
                title: authError.titleOverride ?? "Tailscale identity check failed",
                message: authError.userMessageOverride
                    ?? "The gateway expected a Tailscale auth proxy, but it was not configured.",
                actionLabel: authError.actionLabel ?? "Review Tailscale setup",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/tailscale"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authTailscaleWhoisFailed:
            return self.problem(
                kind: .tailscaleWhoisFailed,
                owner: .network,
                title: authError.titleOverride ?? "Tailscale identity check failed",
                message: authError.userMessageOverride
                    ?? "The gateway could not verify this Tailscale client identity.",
                actionLabel: authError.actionLabel ?? "Review Tailscale setup",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/tailscale"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authTailscaleIdentityMismatch:
            return self.problem(
                kind: .tailscaleIdentityMismatch,
                owner: .network,
                title: authError.titleOverride ?? "Tailscale identity check failed",
                message: authError.userMessageOverride
                    ?? "The forwarded Tailscale identity did not match the verified identity.",
                actionLabel: authError.actionLabel ?? "Review Tailscale setup",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/tailscale"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authRateLimited:
            return self.problem(
                kind: .authRateLimited,
                owner: .gateway,
                title: authError.titleOverride ?? "Too many failed attempts",
                message: authError.userMessageOverride
                    ?? "The gateway is temporarily refusing new auth attempts after repeated failures.",
                actionLabel: authError.actionLabel ?? "Wait and retry",
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(
                    authError.docsURLString,
                    fallback: "https://docs.openclaw.ai/gateway/troubleshooting"),
                requestId: authError.requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case .authRequired, .authUnauthorized, .none:
            return self.problem(
                kind: .unknown,
                owner: authError.ownerRaw.flatMap { self.owner(from: $0) } ?? .unknown,
                title: authError.titleOverride ?? "Gateway rejected the connection",
                message: authError.userMessageOverride ?? authError.message,
                actionLabel: authError.actionLabel,
                actionCommand: authError.actionCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: nil),
                requestId: authError.requestId,
                retryable: authError.retryableOverride ?? false,
                pauseReconnect: authError.pauseReconnectOverride ?? authError.isNonRecoverable,
                authError: authError)
        }
    }

    private static func map(_ responseError: GatewayResponseError) -> GatewayConnectionProblem? {
        let code = responseError.code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if code == "NOT_PAIRED" || responseError.detailsReason == "not-paired" {
            let authError = GatewayConnectAuthError(
                message: responseError.message,
                detailCodeRaw: GatewayConnectAuthDetailCode.pairingRequired.rawValue,
                canRetryWithDeviceToken: false,
                recommendedNextStepRaw: nil,
                requestId: self.stringValue(responseError.details["requestId"]?.value),
                detailsReason: responseError.detailsReason,
                ownerRaw: nil,
                titleOverride: nil,
                userMessageOverride: nil,
                actionLabel: nil,
                actionCommand: nil,
                docsURLString: nil,
                retryableOverride: nil,
                pauseReconnectOverride: nil)
            return self.map(authError)
        }
        return nil
    }

    private static func mapTransportError(_ error: Error) -> GatewayConnectionProblem? {
        let nsError = error as NSError
        let rawMessage = nsError.userInfo[NSLocalizedDescriptionKey] as? String ?? nsError.localizedDescription
        let lower = rawMessage.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower.isEmpty {
            return nil
        }

        let urlErrorCode = URLError.Code(rawValue: nsError.code)
        if nsError.domain == URLError.errorDomain {
            switch urlErrorCode {
            case .timedOut:
                return GatewayConnectionProblem(
                    kind: .timeout,
                    owner: .network,
                    title: "Connection timed out",
                    message: "The gateway did not respond before the connection timed out.",
                    actionLabel: "Retry",
                    actionCommand: nil,
                    docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                    retryable: true,
                    pauseReconnect: false,
                    technicalDetails: rawMessage)
            case .cannotConnectToHost:
                return GatewayConnectionProblem(
                    kind: .connectionRefused,
                    owner: .network,
                    title: "Gateway refused the connection",
                    message: "The gateway host was reachable, but it refused the connection.",
                    actionLabel: "Retry",
                    actionCommand: nil,
                    docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                    retryable: true,
                    pauseReconnect: false,
                    technicalDetails: rawMessage)
            case .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet, .networkConnectionLost,
                 .internationalRoamingOff, .callIsActive, .dataNotAllowed:
                return GatewayConnectionProblem(
                    kind: .reachabilityFailed,
                    owner: .network,
                    title: "Gateway is not reachable",
                    message: "OpenClaw could not reach the gateway over the current network.",
                    actionLabel: "Check network",
                    actionCommand: nil,
                    docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                    retryable: true,
                    pauseReconnect: false,
                    technicalDetails: rawMessage)
            case .cancelled:
                return GatewayConnectionProblem(
                    kind: .websocketCancelled,
                    owner: .network,
                    title: "Connection interrupted",
                    message: "The connection to the gateway was interrupted before setup completed.",
                    actionLabel: "Retry",
                    actionCommand: nil,
                    docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                    retryable: true,
                    pauseReconnect: false,
                    technicalDetails: rawMessage)
            default:
                break
            }
        }

        if lower.contains("timed out") {
            return GatewayConnectionProblem(
                kind: .timeout,
                owner: .network,
                title: "Connection timed out",
                message: "The gateway did not respond before the connection timed out.",
                actionLabel: "Retry",
                actionCommand: nil,
                docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                retryable: true,
                pauseReconnect: false,
                technicalDetails: rawMessage)
        }
        if lower.contains("connection refused") || lower.contains("refused") {
            return GatewayConnectionProblem(
                kind: .connectionRefused,
                owner: .network,
                title: "Gateway refused the connection",
                message: "The gateway host was reachable, but it refused the connection.",
                actionLabel: "Retry",
                actionCommand: nil,
                docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                retryable: true,
                pauseReconnect: false,
                technicalDetails: rawMessage)
        }
        if lower.contains("cannot find host") || lower.contains("could not connect") || lower
            .contains("network is unreachable")
        {
            return GatewayConnectionProblem(
                kind: .reachabilityFailed,
                owner: .network,
                title: "Gateway is not reachable",
                message: "OpenClaw could not reach the gateway over the current network.",
                actionLabel: "Check network",
                actionCommand: nil,
                docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                retryable: true,
                pauseReconnect: false,
                technicalDetails: rawMessage)
        }
        if lower.contains("cancelled") || lower.contains("canceled") {
            return GatewayConnectionProblem(
                kind: .websocketCancelled,
                owner: .network,
                title: "Connection interrupted",
                message: "The connection to the gateway was interrupted before setup completed.",
                actionLabel: "Retry",
                actionCommand: nil,
                docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                retryable: true,
                pauseReconnect: false,
                technicalDetails: rawMessage)
        }
        return nil
    }

    private static func pairingProblem(for authError: GatewayConnectAuthError) -> GatewayConnectionProblem {
        let requestId = authError.requestId
        let pairingCommand = self.approvalCommand(requestId: requestId)

        switch authError.detailsReason {
        case "role-upgrade":
            return self.problem(
                kind: .pairingRoleUpgradeRequired,
                owner: .gateway,
                title: authError.titleOverride ?? "Additional approval required",
                message: authError.userMessageOverride
                    ??
                    "This iPhone is already paired, but it is requesting a new role that was not previously approved.",
                actionLabel: authError.actionLabel ?? "Approve on gateway",
                actionCommand: authError.actionCommand ?? pairingCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/pairing"),
                requestId: requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case "scope-upgrade":
            return self.problem(
                kind: .pairingScopeUpgradeRequired,
                owner: .gateway,
                title: authError.titleOverride ?? "Additional permissions required",
                message: authError.userMessageOverride
                    ?? "This iPhone is already paired, but it is requesting new permissions that require approval.",
                actionLabel: authError.actionLabel ?? "Approve on gateway",
                actionCommand: authError.actionCommand ?? pairingCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/pairing"),
                requestId: requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        case "metadata-upgrade":
            return self.problem(
                kind: .pairingMetadataUpgradeRequired,
                owner: .gateway,
                title: authError.titleOverride ?? "Device approval needs refresh",
                message: authError.userMessageOverride
                    ??
                    "The gateway detected a change in this device's approved identity metadata and requires re-approval.",
                actionLabel: authError.actionLabel ?? "Approve on gateway",
                actionCommand: authError.actionCommand ?? pairingCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/pairing"),
                requestId: requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        default:
            return self.problem(
                kind: .pairingRequired,
                owner: .gateway,
                title: authError.titleOverride ?? "This iPhone is not approved yet",
                message: authError.userMessageOverride
                    ?? "The gateway received the connection request, but this device must be approved first.",
                actionLabel: authError.actionLabel ?? "Approve on gateway",
                actionCommand: authError.actionCommand ?? pairingCommand,
                docsURL: self.docsURL(authError.docsURLString, fallback: "https://docs.openclaw.ai/gateway/pairing"),
                requestId: requestId,
                retryable: false,
                pauseReconnect: true,
                authError: authError)
        }
    }

    private static func problem(
        kind: GatewayConnectionProblem.Kind,
        owner: GatewayConnectionProblem.Owner,
        title: String,
        message: String,
        actionLabel: String?,
        actionCommand: String?,
        docsURL: URL?,
        requestId: String?,
        retryable: Bool,
        pauseReconnect: Bool,
        authError: GatewayConnectAuthError)
        -> GatewayConnectionProblem
    {
        GatewayConnectionProblem(
            kind: kind,
            owner: authError.ownerRaw.flatMap(self.owner(from:)) ?? owner,
            title: title,
            message: message,
            actionLabel: actionLabel,
            actionCommand: actionCommand,
            docsURL: docsURL,
            requestId: requestId,
            retryable: authError.retryableOverride ?? retryable,
            pauseReconnect: authError.pauseReconnectOverride ?? pauseReconnect,
            technicalDetails: self.technicalDetails(for: authError))
    }

    private static func approvalCommand(requestId: String?) -> String {
        if let requestId = self.nonEmpty(requestId) {
            return "openclaw devices approve \(requestId)"
        }
        return "openclaw devices list"
    }

    private static func technicalDetails(for authError: GatewayConnectAuthError) -> String? {
        var parts: [String] = []
        if let detail = self.nonEmpty(authError.detailCodeRaw) {
            parts.append(detail)
        }
        if let reason = self.nonEmpty(authError.detailsReason) {
            parts.append("reason=\(reason)")
        }
        if let requestId = self.nonEmpty(authError.requestId) {
            parts.append("requestId=\(requestId)")
        }
        if let nextStep = self.nonEmpty(authError.recommendedNextStepRaw) {
            parts.append("next=\(nextStep)")
        }
        if authError.canRetryWithDeviceToken {
            parts.append("deviceTokenRetry=true")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func docsURL(_ preferred: String?, fallback: String?) -> URL? {
        if let preferred = self.nonEmpty(preferred), let url = URL(string: preferred) {
            return url
        }
        if let fallback = self.nonEmpty(fallback), let url = URL(string: fallback) {
            return url
        }
        return nil
    }

    private static func owner(from raw: String) -> GatewayConnectionProblem.Owner? {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "gateway":
            .gateway
        case "iphone", "ios", "device":
            .iphone
        case "both":
            .both
        case "network":
            .network
        case "unknown", "":
            .unknown
        default:
            nil
        }
    }

    private static func stringValue(_ value: Any?) -> String? {
        self.nonEmpty(value as? String)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
