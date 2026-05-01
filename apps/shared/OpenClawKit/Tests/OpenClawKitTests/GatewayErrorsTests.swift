import Foundation
import OpenClawKit
import Testing

@Suite struct GatewayErrorsTests {
    @Test func bootstrapTokenInvalidIsNonRecoverable() {
        let error = GatewayConnectAuthError(
            message: "setup code expired",
            detailCode: GatewayConnectAuthDetailCode.authBootstrapTokenInvalid.rawValue,
            canRetryWithDeviceToken: false)

        #expect(error.isNonRecoverable)
        #expect(error.detail == .authBootstrapTokenInvalid)
    }

    @Test func connectAuthErrorPreservesStructuredMetadata() {
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
            pauseReconnectOverride: true)

        #expect(error.requestId == "req-123")
        #expect(error.detailsReason == "scope-upgrade")
        #expect(error.ownerRaw == "gateway")
        #expect(error.titleOverride == "Additional permissions required")
        #expect(error.actionCommand == "openclaw devices approve req-123")
        #expect(error.docsURLString == "https://docs.openclaw.ai/gateway/pairing")
        #expect(error.pauseReconnectOverride == true)
    }

    @Test func pairingProblemUsesStructuredRequestMetadata() {
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

    @Test func cancelledTransportDoesNotReplaceStructuredPairingProblem() {
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

    @Test func unmappedTransportErrorClearsStaleStructuredProblem() {
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

    @Test func tlsPinMismatchMapsToActionableProblem() {
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
    }

    @Test func untrustedTLSCertificatePausesReconnect() {
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
}
