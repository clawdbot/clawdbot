extension OnboardingAISetupModel {
    enum ConfiguredGatewayBlocker: Equatable {
        case unavailable
        case authentication(RemoteGatewayAuthIssue)
    }

    var configuredGatewayProbeUnavailable: Bool {
        self.configuredGatewayBlocker == .unavailable
    }

    var configuredGatewayAuthIssue: RemoteGatewayAuthIssue? {
        guard case let .authentication(issue) = self.configuredGatewayBlocker else { return nil }
        return issue
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

    func enterGatewayAuthBlocker(_ issue: RemoteGatewayAuthIssue) {
        self.resetForGatewayChange(clearPendingHandoff: false)
        self.updateConfiguredGatewayBlockerState(
            .authentication(issue),
            phase: .ready,
            detectError: nil)
    }
}
