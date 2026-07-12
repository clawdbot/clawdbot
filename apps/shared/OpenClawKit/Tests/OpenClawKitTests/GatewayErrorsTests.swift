import Foundation
import OpenClawKit
import Testing

struct GatewayErrorsTests {
    @Test func `bootstrap token invalid is non recoverable`() {
        let error = GatewayConnectAuthError(
            message: "setup code expired",
            detailCode: GatewayConnectAuthDetailCode.authBootstrapTokenInvalid.rawValue,
            canRetryWithDeviceToken: false)

        #expect(error.isNonRecoverable)
        #expect(error.detail == .authBootstrapTokenInvalid)
    }

    @Test func `connect auth error preserves structured metadata`() {
        let error = GatewayConnectAuthError(
            message: "pairing required",
            detailCode: GatewayConnectAuthDetailCode.pairingRequired.rawValue,
            canRetryWithDeviceToken: false,
            recommendedNextStep: "review_auth_configuration",
            requestId: "req-123",
            detailsReason: "scope-upgrade",
            ownerRaw: "gateway",
            titleOverride: "Additional permissions required",
            userMessageOverride: "Approve the requested permissions on the gateway, then reconnect.",
            actionLabel: "Approve on gateway",
            actionCommand: "openclaw devices approve req-123",
            docsURLString: "https://docs.openclaw.ai/gateway/pairing",
            retryableOverride: false,
            pauseReconnectOverride: true,
            clientMinProtocol: 4,
            clientMaxProtocol: 4,
            expectedProtocol: 5,
            minimumProbeProtocol: 4)

        #expect(error.requestId == "req-123")
        #expect(error.detailsReason == "scope-upgrade")
        #expect(error.ownerRaw == "gateway")
        #expect(error.titleOverride == "Additional permissions required")
        #expect(error.actionCommand == "openclaw devices approve req-123")
        #expect(error.docsURLString == "https://docs.openclaw.ai/gateway/pairing")
        #expect(error.pauseReconnectOverride == true)
        #expect(error.clientMinProtocol == 4)
        #expect(error.clientMaxProtocol == 4)
        #expect(error.expectedProtocol == 5)
        #expect(error.minimumProbeProtocol == 4)
    }

    @Test func `app owned gateway copy remains localizable`() throws {
        let error = GatewayConnectAuthError(
            message: "pairing required",
            detailCode: GatewayConnectAuthDetailCode.pairingRequired.rawValue,
            canRetryWithDeviceToken: false,
            requestId: "req-123")

        let problem = try #require(GatewayConnectionProblemMapper.map(error: error))

        #expect(problem.titlePresentation == .localized("Pairing approval required"))
        #expect(problem.messagePresentation == .localized(
            "Approve this device on the gateway, then reconnect."))
        #expect(problem.actionLabelPresentation == .localized("Approve on gateway"))
    }

    @Test func `gateway supplied copy remains verbatim`() throws {
        let error = GatewayConnectAuthError(
            message: "pairing required",
            detailCode: GatewayConnectAuthDetailCode.pairingRequired.rawValue,
            canRetryWithDeviceToken: false,
            titleOverride: "Custom gateway title",
            userMessageOverride: "Custom gateway instructions",
            actionLabel: "Custom gateway action")

        let problem = try #require(GatewayConnectionProblemMapper.map(error: error))

        #expect(problem.titlePresentation == .verbatim("Custom gateway title"))
        #expect(problem.messagePresentation == .verbatim("Custom gateway instructions"))
        #expect(problem.actionLabelPresentation == .verbatim("Custom gateway action"))
    }

    @Test func `protocol mismatch maps older app to update problem`() {
        let error = GatewayConnectAuthError(
            message: "protocol mismatch",
            detailCode: GatewayConnectAuthDetailCode.protocolMismatch.rawValue,
            canRetryWithDeviceToken: false,
            clientMinProtocol: 4,
            clientMaxProtocol: 4,
            expectedProtocol: 5,
            minimumProbeProtocol: 4)

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(error.detail == .protocolMismatch)
        #expect(error.isNonRecoverable)
        #expect(problem?.kind == .protocolMismatch)
        #expect(problem?.owner == .iphone)
        #expect(problem?.title == "App update required")
        #expect(problem?.message == "This app is older than the gateway. Update OpenClaw on this device, then retry.")
        #expect(problem?.retryable == false)
        #expect(problem?.pauseReconnect == true)
        #expect(problem?.technicalDetails?.contains("clientProtocol=4") == true)
        #expect(problem?.technicalDetails?.contains("gatewayProtocol=5") == true)
    }

    @Test func `protocol mismatch maps older gateway to update problem`() {
        let error = GatewayConnectAuthError(
            message: "protocol mismatch",
            detailCode: GatewayConnectAuthDetailCode.protocolMismatch.rawValue,
            canRetryWithDeviceToken: false,
            clientMinProtocol: 4,
            clientMaxProtocol: 4,
            expectedProtocol: 3,
            minimumProbeProtocol: 3)

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(problem?.kind == .protocolMismatch)
        #expect(problem?.owner == .gateway)
        #expect(problem?.title == "Gateway update required")
        #expect(problem?
            .message == "The gateway is older than this app. Update OpenClaw on the gateway host, then retry.")
        #expect(problem?.actionLabel == "Copy update command")
        #expect(problem?.actionCommand == "openclaw update")
        #expect(problem?.retryable == false)
        #expect(problem?.pauseReconnect == true)
    }

    @Test func `protocol mismatch without versions still gives actionable fallback`() {
        let error = GatewayConnectAuthError(
            message: "protocol mismatch",
            detailCode: GatewayConnectAuthDetailCode.protocolMismatch.rawValue,
            canRetryWithDeviceToken: false)

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(problem?.kind == .protocolMismatch)
        #expect(problem?.owner == .both)
        #expect(problem?
            .message == "The app and gateway use incompatible protocol versions. Update OpenClaw on both, then retry.")
        #expect(problem?.retryable == false)
        #expect(problem?.pauseReconnect == true)
    }

    @Test func `pairing problem uses structured request metadata`() {
        let error = GatewayConnectAuthError(
            message: "pairing required",
            detailCode: GatewayConnectAuthDetailCode.pairingRequired.rawValue,
            canRetryWithDeviceToken: false,
            requestId: "req-123",
            detailsReason: "scope-upgrade")

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(problem?.kind == .pairingScopeUpgradeRequired)
        #expect(problem?.requestId == "req-123")
        #expect(problem?.pauseReconnect == true)
        #expect(problem?.actionCommand == "openclaw devices approve req-123")
    }

    @Test func `scope mismatch maps to pairing or repair problem`() {
        let error = GatewayConnectAuthError(
            message: "device token scope mismatch",
            detailCode: GatewayConnectAuthDetailCode.authScopeMismatch.rawValue,
            canRetryWithDeviceToken: false)

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(error.detail == .authScopeMismatch)
        #expect(error.isNonRecoverable)
        #expect(problem?.kind == .deviceTokenScopeMismatch)
        #expect(problem?.needsPairingApproval == true)
        #expect(problem?.needsCredentialUpdate == false)
    }

    @Test func `token mismatch suggests onboarding reset`() {
        let error = GatewayConnectAuthError(
            message: "token mismatch",
            detailCode: GatewayConnectAuthDetailCode.authTokenMismatch.rawValue,
            canRetryWithDeviceToken: false)

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(problem?.kind == .gatewayAuthTokenMismatch)
        #expect(problem?.suggestsOnboardingReset == true)
        #expect(problem?.needsCredentialUpdate == true)
    }

    @Test func `cancelled transport does not replace structured pairing problem`() {
        let pairing = GatewayConnectAuthError(
            message: "pairing required",
            detailCode: GatewayConnectAuthDetailCode.pairingRequired.rawValue,
            canRetryWithDeviceToken: false,
            requestId: "req-123")
        let previousProblem = GatewayConnectionProblemMapper.map(error: pairing)
        let cancelled = NSError(
            domain: URLError.errorDomain,
            code: URLError.cancelled.rawValue,
            userInfo: [NSLocalizedDescriptionKey: "gateway receive: cancelled"])

        let preserved = GatewayConnectionProblemMapper.map(error: cancelled, preserving: previousProblem)

        #expect(preserved?.kind == .pairingRequired)
        #expect(preserved?.requestId == "req-123")
    }

    @Test func `unmapped transport error clears stale structured problem`() {
        let pairing = GatewayConnectAuthError(
            message: "pairing required",
            detailCode: GatewayConnectAuthDetailCode.pairingRequired.rawValue,
            canRetryWithDeviceToken: false,
            requestId: "req-123")
        let previousProblem = GatewayConnectionProblemMapper.map(error: pairing)
        let unknownTransport = NSError(
            domain: NSURLErrorDomain,
            code: -1202,
            userInfo: [NSLocalizedDescriptionKey: "certificate chain validation failed"])

        let mapped = GatewayConnectionProblemMapper.map(error: unknownTransport, preserving: previousProblem)

        #expect(mapped == nil)
    }

    @Test func `tls pin mismatch maps to actionable problem`() {
        let error = GatewayTLSValidationError(
            failure: GatewayTLSValidationFailure(
                kind: .pinMismatch,
                host: "gateway.example.ts.net",
                storeKey: "gateway.example.ts.net:443",
                expectedFingerprint: "old",
                observedFingerprint: "new",
                systemTrustOk: true),
            context: "connect to gateway")

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(problem?.kind == .tlsPinMismatch)
        #expect(problem?.retryable == false)
        #expect(problem?.pauseReconnect == true)
        #expect(problem?.actionLabel == "Review certificate")
        #expect(problem?.canTrustRotatedCertificate == true)
        #expect(problem?.tlsStoreKey == "gateway.example.ts.net:443")
        #expect(problem?.tlsExpectedFingerprint == "old")
        #expect(problem?.tlsObservedFingerprint == "new")
        #expect(problem?.messagePresentation == .localizedFormat(
            "The saved TLS certificate pin for %@ no longer matches the gateway certificate. "
                + "The new certificate is trusted by this device; this is commonly caused by certificate rotation.",
            ["gateway.example.ts.net"]))
    }

    @Test func `untrusted TLS certificate pauses reconnect`() {
        let error = GatewayTLSValidationError(
            failure: GatewayTLSValidationFailure(
                kind: .untrustedCertificate,
                host: "gateway.example.com",
                storeKey: "gateway.example.com:443",
                expectedFingerprint: nil,
                observedFingerprint: nil,
                systemTrustOk: false),
            context: "connect to gateway")

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(problem?.kind == .tlsCertificateUntrusted)
        #expect(problem?.retryable == false)
        #expect(problem?.pauseReconnect == true)
    }

    @Test func `untrusted TLS mismatch cannot be recovered in app`() {
        let error = GatewayTLSValidationError(
            failure: GatewayTLSValidationFailure(
                kind: .pinMismatch,
                host: "gateway.example.ts.net",
                storeKey: "gateway.example.ts.net:443",
                expectedFingerprint: "old",
                observedFingerprint: "new",
                systemTrustOk: false),
            context: "connect to gateway")

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(problem?.kind == .tlsPinMismatch)
        #expect(problem?.canTrustRotatedCertificate == false)
    }
}
