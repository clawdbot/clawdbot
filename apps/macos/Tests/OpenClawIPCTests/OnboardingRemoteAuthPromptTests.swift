import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingRemoteAuthPromptTests {
    private let directInput = RemoteGatewayProbeInput(
        transport: .direct,
        target: "wss://gateway.example.test",
        token: "token-a")

    @Test func `auth detail codes map to remote auth issues`() {
        let tokenMissing = GatewayConnectAuthError(
            message: "token missing",
            detailCode: GatewayConnectAuthDetailCode.authTokenMissing.rawValue,
            canRetryWithDeviceToken: false)
        let tokenMismatch = GatewayConnectAuthError(
            message: "token mismatch",
            detailCode: GatewayConnectAuthDetailCode.authTokenMismatch.rawValue,
            canRetryWithDeviceToken: false)
        let tokenNotConfigured = GatewayConnectAuthError(
            message: "token not configured",
            detailCode: GatewayConnectAuthDetailCode.authTokenNotConfigured.rawValue,
            canRetryWithDeviceToken: false)
        let bootstrapInvalid = GatewayConnectAuthError(
            message: "setup code expired",
            detailCode: GatewayConnectAuthDetailCode.authBootstrapTokenInvalid.rawValue,
            canRetryWithDeviceToken: false)
        let passwordMissing = GatewayConnectAuthError(
            message: "password missing",
            detailCode: GatewayConnectAuthDetailCode.authPasswordMissing.rawValue,
            canRetryWithDeviceToken: false)
        let pairingRequired = GatewayConnectAuthError(
            message: "pairing required",
            detailCode: GatewayConnectAuthDetailCode.pairingRequired.rawValue,
            canRetryWithDeviceToken: false)
        let unknown = GatewayConnectAuthError(
            message: "other",
            detailCode: "SOMETHING_ELSE",
            canRetryWithDeviceToken: false)

        #expect(RemoteGatewayAuthIssue(error: tokenMissing) == .tokenRequired)
        #expect(RemoteGatewayAuthIssue(error: tokenMismatch) == .tokenMismatch)
        #expect(RemoteGatewayAuthIssue(error: tokenNotConfigured) == .gatewayTokenNotConfigured)
        #expect(RemoteGatewayAuthIssue(error: bootstrapInvalid) == .setupCodeExpired)
        #expect(RemoteGatewayAuthIssue(error: passwordMissing) == .passwordRequired)
        #expect(RemoteGatewayAuthIssue(error: pairingRequired) == .pairingRequired)
        #expect(RemoteGatewayAuthIssue(error: unknown) == nil)
    }

    @Test func `password detail family maps to password required issue`() {
        let mismatch = GatewayConnectAuthError(
            message: "password mismatch",
            detailCode: GatewayConnectAuthDetailCode.authPasswordMismatch.rawValue,
            canRetryWithDeviceToken: false)
        let notConfigured = GatewayConnectAuthError(
            message: "password not configured",
            detailCode: GatewayConnectAuthDetailCode.authPasswordNotConfigured.rawValue,
            canRetryWithDeviceToken: false)

        #expect(RemoteGatewayAuthIssue(error: mismatch) == .passwordRequired)
        #expect(RemoteGatewayAuthIssue(error: notConfigured) == .passwordRequired)
    }

    @Test func `token field visibility follows onboarding rules`() {
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: nil) == false)
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: true,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: nil))
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "secret",
            remoteTokenUnsupported: false,
            authIssue: nil))
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: true,
            authIssue: nil))
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: .tokenRequired))
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: .tokenMismatch))
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: .gatewayTokenNotConfigured) == false)
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: .setupCodeExpired) == false)
        #expect(OnboardingView.shouldShowRemoteTokenField(
            showAdvancedConnection: false,
            remoteToken: "",
            remoteTokenUnsupported: false,
            authIssue: .pairingRequired) == false)
    }

    @Test func `pairing required copy points users to pair approve`() {
        let issue = RemoteGatewayAuthIssue.pairingRequired

        #expect(issue.title == "This device needs pairing approval")
        #expect(issue.body.contains("`/pair approve`"))
        #expect(issue.statusMessage.contains("/pair approve"))
        #expect(issue.footnote?.contains("`openclaw devices approve`") == true)
    }

    @Test func `gateway token copy points to explicit interactive recovery`() {
        for issue in [RemoteGatewayAuthIssue.tokenRequired, .tokenMismatch] {
            #expect(issue.body.contains("`openclaw gateway auth-token --show`"))
            #expect(issue.body.contains("interactive terminal"))
            #expect(!issue.body.contains("config get gateway.auth.token"))
            #expect(issue.statusMessage.contains("openclaw gateway auth-token --show"))
        }
    }

    @Test func `paired device success copy explains auth source`() {
        let pairedDevice = RemoteGatewayProbeSuccess(authSource: .deviceToken)
        let bootstrap = RemoteGatewayProbeSuccess(authSource: .bootstrapToken)
        let sharedToken = RemoteGatewayProbeSuccess(authSource: .sharedToken)
        let noAuth = RemoteGatewayProbeSuccess(authSource: GatewayAuthSource.none)

        #expect(pairedDevice.title == "Connected via paired device")
        #expect(pairedDevice
            .detail == "This app used a stored device token. New or unpaired devices may still need the gateway token.")
        #expect(bootstrap.title == "Connected with setup code")
        #expect(bootstrap
            .detail ==
            "This app is still using the temporary setup code. Approve pairing to finish provisioning device-scoped auth.")
        #expect(sharedToken.title == "Connected with gateway token")
        #expect(sharedToken.detail == nil)
        #expect(noAuth.title == "Remote gateway ready")
        #expect(noAuth.detail == nil)
    }

    @Test func `transient probe mode restore does not clear probe feedback`() {
        #expect(OnboardingView.shouldResetRemoteProbeFeedback(for: .local, suppressReset: false))
        #expect(OnboardingView.shouldResetRemoteProbeFeedback(for: .unconfigured, suppressReset: false))
        #expect(OnboardingView.shouldResetRemoteProbeFeedback(for: .remote, suppressReset: false) == false)
        #expect(OnboardingView.shouldResetRemoteProbeFeedback(for: .local, suppressReset: true) == false)
    }

    @Test func `remote gateway next probes until the current tuple is verified`() {
        let failed = RemoteOnboardingProbeState.failed(self.directInput, "unauthorized")
        let checking = RemoteOnboardingProbeState.checking(self.directInput)
        let verified = RemoteOnboardingProbeState.ok(
            self.directInput,
            RemoteGatewayProbeSuccess(authSource: .sharedToken))

        #expect(self.decision(mode: .local, page: 1, state: .idle) == .init(
            canAdvance: true,
            shouldProbe: false))
        #expect(self.decision(mode: .remote, page: 3, state: .idle) == .init(
            canAdvance: true,
            shouldProbe: false))
        #expect(self.decision(mode: .remote, page: 1, state: .idle) == .init(
            canAdvance: false,
            shouldProbe: true))
        #expect(self.decision(mode: .remote, page: 1, state: failed) == .init(
            canAdvance: false,
            shouldProbe: true))
        #expect(self.decision(mode: .remote, page: 1, state: checking) == .init(
            canAdvance: false,
            shouldProbe: false))
        #expect(self.decision(mode: .remote, page: 1, state: verified) == .init(
            canAdvance: true,
            shouldProbe: false))
        #expect(self.decision(
            mode: .remote,
            page: 1,
            issue: .pairingRequired,
            state: verified) == .init(canAdvance: false, shouldProbe: true))
    }

    @Test func `target transport and token edits invalidate remote gateway success`() {
        let verified = RemoteOnboardingProbeState.ok(
            self.directInput,
            RemoteGatewayProbeSuccess(authSource: .sharedToken))
        let edits = [
            RemoteGatewayProbeInput(
                transport: .direct,
                target: "wss://other.example.test",
                token: "token-a"),
            RemoteGatewayProbeInput(
                transport: .ssh,
                target: "gateway.example.test",
                token: "token-a"),
            RemoteGatewayProbeInput(
                transport: .direct,
                target: "wss://gateway.example.test",
                token: "token-b"),
        ]

        for input in edits {
            #expect(self.decision(
                mode: .remote,
                page: 1,
                state: verified,
                input: input) == .init(canAdvance: false, shouldProbe: true))
        }
    }

    @Test func `probe attempt identity rejects ABA stale completion`() {
        let firstAttempt = UUID()
        let replacementAttempt = UUID()
        let checking = RemoteOnboardingProbeState.checking(self.directInput)

        #expect(OnboardingView.ownsRemoteGatewayProbeAttempt(
            attemptID: firstAttempt,
            currentAttemptID: replacementAttempt) == false)
        #expect(OnboardingView.ownsRemoteGatewayProbeAttempt(
            attemptID: replacementAttempt,
            currentAttemptID: replacementAttempt))
        #expect(OnboardingView.shouldAcceptRemoteGatewayProbeResult(
            attemptID: firstAttempt,
            currentAttemptID: replacementAttempt,
            probeState: checking,
            expectedInput: self.directInput,
            currentInput: self.directInput) == false)
        #expect(OnboardingView.shouldAcceptRemoteGatewayProbeResult(
            attemptID: replacementAttempt,
            currentAttemptID: replacementAttempt,
            probeState: checking,
            expectedInput: self.directInput,
            currentInput: self.directInput))
    }

    private func decision(
        mode: AppState.ConnectionMode,
        page: Int,
        issue: RemoteGatewayAuthIssue? = nil,
        state: RemoteOnboardingProbeState,
        input: RemoteGatewayProbeInput? = nil) -> RemoteGatewayAdvanceDecision
    {
        OnboardingView.remoteGatewayAdvanceDecision(
            connectionMode: mode,
            activePageIndex: page,
            connectionPageIndex: 1,
            authIssue: issue,
            probeState: state,
            input: input ?? self.directInput)
    }
}
