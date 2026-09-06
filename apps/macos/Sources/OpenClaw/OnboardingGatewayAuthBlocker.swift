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

    func showConfiguredGatewayProbeUnavailable(
        summary: String = "The Gateway did not answer the inference check. Nothing was changed.")
    {
        guard !self.ownsInferenceTransition ||
            self.configuredGatewayBlocker != nil ||
            self.waitingForPendingActivationDeadline
        else { return }
        self.enterConfiguredGatewayBlocker(.unavailable, failure: Failure(summary: summary, detail: nil))
    }

    func showConfiguredGatewayAuthIssue(_ issue: RemoteGatewayAuthIssue) {
        guard !self.ownsInferenceTransition ||
            self.configuredGatewayBlocker != nil ||
            self.waitingForPendingActivationDeadline
        else { return }
        self.enterGatewayAuthBlocker(issue)
    }

    func enterGatewayAuthBlocker(_ issue: RemoteGatewayAuthIssue) {
        self.enterConfiguredGatewayBlocker(.authentication(issue))
    }
}
