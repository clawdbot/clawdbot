import SwiftUI

struct GatewayAuthenticationReturnDecision: Equatable {
    let connectionPage: Int
    let authIssue: RemoteGatewayAuthIssue
    let probeState: RemoteOnboardingProbeState
    let showRemoteChoices: Bool
    let showAdvancedConnection: Bool
}

extension OnboardingView {
    /// Structured AI setup: detect what's already available on the Gateway, test the
    /// best option live, fall through automatically, offer an API-key form
    /// when nothing works. OpenClaw becomes available only after inference
    /// has completed a live round-trip.
    func aiSetupPage(contentHeight: CGFloat) -> some View {
        VStack(spacing: 12) {
            Group {
                if self.aiSetup.configuredGatewayAuthIssue != nil {
                    Text("Authenticate with your Gateway")
                } else {
                    Text("Connect your AI")
                }
            }
            .font(.largeTitle.weight(.semibold))
            Text(self.aiSetupSubtitle)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 540)
                .fixedSize(horizontal: false, vertical: true)

            OnboardingAISetupView(
                model: self.aiSetup,
                returnToGatewayAuthentication: { self.returnToGatewayAuthentication() },
                retryConfiguredGatewayProbe: { self.retryConfiguredGatewayProbe(intent: $0) })
        }
        .padding(.horizontal, 28)
        .padding(.top, 48)
        .frame(width: self.pageWidth, height: contentHeight, alignment: .top)
    }

    private var aiSetupSubtitle: String {
        if self.aiSetup.configuredGatewayAuthIssue != nil {
            return "Finish the remote Gateway connection before continuing."
        }
        if state.connectionMode == .remote {
            return "AI access is configured on the remote Gateway. OpenClaw will use that existing setup."
        }
        return "OpenClaw needs an AI account to think. " +
            "It reuses what you already have — nothing new to sign up for if " +
            "Claude Code, Codex, or an API key is on this Mac."
    }

    func maybeStartAISetup(for pageIndex: Int) {
        guard pageIndex == aiPageIndex else { return }
        // Only app-managed local installs need CLI activation; external attachments
        // proceed through the existing route-bound Gateway probe.
        guard !requiresLocalCLI || cliInstalled else { return }
        self.prepareSystemAgentHandoff()
        // A selected/reconnected Gateway may already have a configured default
        // agent. Check that route before setup tries to author inference.
        probeConfiguredGatewayForDashboard(intent: .startSetup)
    }

    func prepareSystemAgentHandoff() {
        aiSetup.onPendingActivationDeadline = { [self] deadline, routeIdentity in
            let currentRouteIdentity = self.aiSetupRouteIdentityProvider()
            guard currentRouteIdentity == routeIdentity else { return }
            self.configuredGatewayProbe.schedulePendingActivationRecheck(deadline: deadline) {
                guard self.aiSetupRouteIdentityProvider() == routeIdentity else { return }
                self.probeConfiguredGatewayForDashboard(intent: .resumePending)
            }
        }
        if aiSetup.onConnected == nil {
            aiSetup.onConnected = { [self] in
                // Activation already persisted the resume marker before its RPC.
                self.configuredGatewayProbe.cancelPendingActivationRecheck()
                self.finish()
            }
        }
    }

    @discardableResult
    func resumePendingSystemAgent(
        modelRef: String,
        intent: OnboardingAISetupModel.SetupIntent = .resumePending) -> Task<Void, Never>
    {
        self.prepareSystemAgentHandoff()
        let expectedRouteIdentity = self.aiSetupRouteIdentityProvider()
        aiSetup.resumeConfiguredInference(modelRef: modelRef)
        if let page = pageOrder.firstIndex(of: aiPageIndex) {
            currentPage = page
        }
        return Task {
            let outcome = await self.aiSetup.verifyPendingConfiguredInference()
            if case let .freshSetupAllowed(context) = outcome {
                if intent != .inspectOnly { self.aiSetup.resumeSetup(ifCurrent: context, intent: intent) }
                return
            }
            // The outcome belongs to the exact attempt and route captured by
            // verification. Never infer success from newer mutable UI state.
            let currentRouteIdentity = self.aiSetupRouteIdentityProvider()
            guard outcome == .connected,
                  self.aiSetup.connected,
                  currentRouteIdentity == expectedRouteIdentity,
                  !Task.isCancelled
            else { return }
            self.configuredGatewayProbe.cancelPendingActivationRecheck()
            self.finish()
        }
    }

    func waitForPendingInferenceSetup() {
        self.prepareSystemAgentHandoff()
        if let page = pageOrder.firstIndex(of: aiPageIndex) {
            currentPage = page
        }
        aiSetup.waitForPendingActivationDeadline()
    }

    @discardableResult
    func retryConfiguredGatewayProbe(intent: OnboardingAISetupModel.SetupIntent = .startSetup) -> Task<Void, Never>? {
        // The action carries intent; expiry or a changed view state must never
        // turn Check again into a new activation. Timer/reconnect callers own auto-resume.
        aiSetup.beginConfiguredGatewayProbeRetry()
        // The retry button itself proves the onboarding view is visible even
        // before SwiftUI commits an @State visibility write.
        return probeConfiguredGatewayForDashboard(
            intent: intent,
            knownVisible: true,
            knownAISetupPage: true)
    }

    func returnToGatewayAuthentication() {
        guard let decision = Self.gatewayAuthenticationReturnDecision(
            connectionMode: state.connectionMode,
            authIssue: aiSetup.configuredGatewayAuthIssue,
            pageOrder: pageOrder,
            connectionPageIndex: connectionPageIndex,
            probeInput: remoteGatewayProbeInput)
        else { return }
        remoteAuthIssue = decision.authIssue
        remoteProbeState = decision.probeState
        showRemoteChoices = decision.showRemoteChoices
        showAdvancedConnection = decision.showAdvancedConnection
        withAnimation { currentPage = decision.connectionPage }
    }

    static func gatewayAuthenticationReturnDecision(
        connectionMode: AppState.ConnectionMode,
        authIssue: RemoteGatewayAuthIssue?,
        pageOrder: [Int],
        connectionPageIndex: Int,
        probeInput: RemoteGatewayProbeInput) -> GatewayAuthenticationReturnDecision?
    {
        guard connectionMode == .remote,
              let authIssue,
              let connectionPage = pageOrder.firstIndex(of: connectionPageIndex)
        else { return nil }
        return GatewayAuthenticationReturnDecision(
            connectionPage: connectionPage,
            authIssue: authIssue,
            probeState: .failed(probeInput, authIssue.statusMessage),
            showRemoteChoices: true,
            showAdvancedConnection: true)
    }

    func resumePendingInferenceSetup() {
        self.prepareSystemAgentHandoff()
        if let page = pageOrder.firstIndex(of: aiPageIndex) {
            currentPage = page
        }
        aiSetup.resumeSetup()
    }
}
