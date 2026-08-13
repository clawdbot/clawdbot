extension OnboardingAISetupModel {
    struct ConfiguredGatewayVerificationFailure: Equatable {
        let modelRef: String
        let status: String?
        let error: String?

        var presentation: Failure {
            OnboardingAISetupModel.failure(
                label: "Configured AI",
                status: self.status,
                error: self.error)
        }
    }

    enum ConfiguredGatewayBlocker: Equatable {
        case unavailable
        case authentication(RemoteGatewayAuthIssue)
        case verificationFailed(ConfiguredGatewayVerificationFailure)
    }

    var configuredGatewayProbeUnavailable: Bool {
        self.configuredGatewayBlocker == .unavailable
    }

    var configuredGatewayAuthIssue: RemoteGatewayAuthIssue? {
        guard case let .authentication(issue) = self.configuredGatewayBlocker else { return nil }
        return issue
    }

    var configuredGatewayVerificationFailure: ConfiguredGatewayVerificationFailure? {
        guard case let .verificationFailed(failure) = self.configuredGatewayBlocker else { return nil }
        return failure
    }

    func showConfiguredGatewayProbeUnavailable() {
        guard !self.ownsInferenceTransition ||
            self.configuredGatewayBlocker != nil ||
            self.waitingForPendingActivationDeadline
        else { return }
        // Retire stale candidates and `started` state. A later successful
        // missing-model probe must be able to run a fresh detect/activate flow.
        self.resetForGatewayChange(clearPendingHandoff: false)
        self.updateConfiguredGatewayBlockerState(
            .unavailable,
            phase: .ready,
            detectError: Failure(
                summary: "The Gateway did not answer the inference check. Nothing was changed.",
                detail: nil))
    }

    func showConfiguredGatewayAuthIssue(_ issue: RemoteGatewayAuthIssue) {
        guard !self.ownsInferenceTransition ||
            self.configuredGatewayBlocker != nil ||
            self.waitingForPendingActivationDeadline
        else { return }
        self.enterGatewayAuthBlocker(issue)
    }

    func beginConfiguredGatewayProbeRetry() {
        guard self.configuredGatewayBlocker != nil else { return }
        self.updateConfiguredGatewayBlockerState(
            self.configuredGatewayBlocker,
            phase: .detecting,
            detectError: nil)
    }

    func recoverConfiguredGatewayVerification(
        modelRef: String,
        status: String?,
        error: String?)
    {
        self.resetForGatewayChange(clearPendingHandoff: false)
        self.updateConfiguredGatewayBlockerState(
            .verificationFailed(ConfiguredGatewayVerificationFailure(
                modelRef: modelRef,
                status: status,
                error: error)),
            phase: .detecting,
            detectError: nil)
        self.started = true
        self.scheduleDetection()
    }

    func enterGatewayAuthBlocker(_ issue: RemoteGatewayAuthIssue) {
        self.resetForGatewayChange(clearPendingHandoff: false)
        self.updateConfiguredGatewayBlockerState(
            .authentication(issue),
            phase: .ready,
            detectError: nil)
    }
}
