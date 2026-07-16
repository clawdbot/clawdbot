import SwiftUI

extension OnboardingView {
    /// Structured AI setup: detect what's already on this machine, test the
    /// best option live, fall through automatically, offer an API-key form
    /// when nothing works. OpenClaw becomes available only after inference
    /// has completed a live round-trip.
    func aiSetupPage(contentHeight: CGFloat) -> some View {
        VStack(spacing: 12) {
            Text("Connect your AI")
                .font(.largeTitle.weight(.semibold))
            Text(self.aiSetupSubtitle)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 540)
                .fixedSize(horizontal: false, vertical: true)

            ScrollView {
                OnboardingAISetupView(
                    model: self.aiSetup,
                    systemAgentChat: self.systemAgentState.chat,
                    showSystemAgentChat: self.$systemAgentState.isPresented,
                    retryConfiguredGatewayProbe: { self.retryConfiguredGatewayProbe() })
                    .padding(.vertical, 4)
                    .padding(.trailing, 12)
            }
            .scrollIndicators(.automatic)
        }
        .padding(.horizontal, 28)
        .padding(.top, 48)
        .frame(width: self.pageWidth, height: contentHeight, alignment: .top)
    }

    private var aiSetupSubtitle: String {
        if aiSetup.connected {
            return "All good — your assistant has a working AI connection."
        }
        return "OpenClaw needs an AI account to think. " +
            "It reuses what you already have — nothing new to sign up for if " +
            "Claude Code, Codex, or an API key is on this Mac."
    }

    func maybeStartAISetup(for pageIndex: Int) {
        guard pageIndex == aiPageIndex else { return }
        // Local mode reaches this page only after the CLI/gateway install page,
        // so the gateway is up before the first RPC.
        guard state.connectionMode != .local || cliInstalled else { return }
        self.prepareSystemAgentHandoff()
        // A selected/reconnected Gateway may already have a configured default
        // agent. Check that route before setup tries to author inference.
        probeConfiguredGatewayForDashboard(startAISetupWhenMissing: true)
    }

    func prepareSystemAgentHandoff() {
        systemAgentState.chat.onAgentHandoff = { [self] in self.finish() }
        aiSetup.onPendingActivationDeadline = { [self] deadline, routeIdentity in
            let currentRouteIdentity = self.aiSetupRouteIdentityProvider()
            guard currentRouteIdentity == routeIdentity else { return }
            self.configuredGatewayProbe.schedulePendingActivationRecheck(deadline: deadline) {
                self.probeConfiguredGatewayForDashboard(startAISetupWhenMissing: true)
            }
        }
        if aiSetup.onConnected == nil {
            aiSetup.onConnected = { [self] in
                // Activation already persisted the resume marker before its RPC.
                self.configuredGatewayProbe.cancelPendingActivationRecheck()
                self.systemAgentState.presentAndStart()
            }
        }
    }

    @discardableResult
    func resumePendingSystemAgent(modelRef: String) -> Task<Void, Never> {
        self.prepareSystemAgentHandoff()
        let expectedRouteIdentity = self.aiSetupRouteIdentityProvider()
        aiSetup.resumeConfiguredInference(modelRef: modelRef)
        if let page = pageOrder.firstIndex(of: aiPageIndex) {
            currentPage = page
        }
        return Task {
            let outcome = await self.aiSetup.verifyPendingConfiguredInference()
            // The outcome belongs to the exact attempt and route captured by
            // verification. Never infer success from newer mutable UI state.
            let currentRouteIdentity = self.aiSetupRouteIdentityProvider()
            guard outcome == .connected,
                  self.aiSetup.connected,
                  currentRouteIdentity == expectedRouteIdentity,
                  !Task.isCancelled
            else { return }
            self.configuredGatewayProbe.cancelPendingActivationRecheck()
            // `onConnected` already owns presentation. Await that exact start
            // task without starting a replacement route's chat after suspension.
            await self.systemAgentState.waitForStartIfNeeded()
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
    func retryConfiguredGatewayProbe() -> Task<Void, Never>? {
        aiSetup.beginConfiguredGatewayProbeRetry()
        // The retry button itself proves the onboarding view is visible even
        // before SwiftUI commits an @State visibility write.
        return probeConfiguredGatewayForDashboard(
            startAISetupWhenMissing: true,
            knownVisible: true,
            knownAISetupPage: true)
    }

    func resumePendingInferenceSetup() {
        self.prepareSystemAgentHandoff()
        if let page = pageOrder.firstIndex(of: aiPageIndex) {
            currentPage = page
        }
        aiSetup.resetForGatewayChange(clearPendingHandoff: false)
        aiSetup.startIfNeeded()
    }
}
