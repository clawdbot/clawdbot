import SwiftUI

extension OnboardingView {
    /// Structured AI setup: detect what's already on this machine, test the
    /// best option live, fall through automatically, offer an API-key form
    /// when nothing works. Crestodian becomes available only after inference
    /// has completed a live round-trip.
    func aiSetupPage() -> some View {
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
                    crestodianChat: self.crestodianState.chat,
                    showCrestodianChat: self.$crestodianState.isPresented)
                    .padding(.vertical, 4)
                    .padding(.trailing, 12)
            }
            .scrollIndicators(.automatic)
        }
        .padding(.horizontal, 28)
        .padding(.top, 48)
        .frame(width: self.pageWidth, height: self.contentHeight, alignment: .top)
    }

    private var aiSetupSubtitle: String {
        if self.aiSetup.connected {
            return "All good — your assistant has a working AI connection."
        }
        return "OpenClaw needs an AI account to think. " +
            "It reuses what you already have — nothing new to sign up for if " +
            "Claude Code, Codex, or an API key is on this Mac."
    }

    func maybeStartAISetup(for pageIndex: Int) {
        guard pageIndex == self.aiPageIndex else { return }
        // Local mode reaches this page only after the CLI/gateway install page,
        // so the gateway is up before the first RPC.
        guard self.state.connectionMode != .local || self.cliInstalled else { return }
        if self.aiSetup.onConnected == nil {
            self.aiSetup.onConnected = { [self] in
                // Setup authored the workspace (BOOTSTRAP.md); re-check so the
                // Meet-your-agent page joins the flow.
                self.refreshBootstrapStatus()
            }
        }
        self.aiSetup.startIfNeeded()
    }
}
