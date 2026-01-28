import Foundation

extension OnboardingView {
    func maybeKickoffOnboardingChat(for pageIndex: Int) {
        guard pageIndex == self.onboardingChatPageIndex else { return }
        guard self.showOnboardingChat else { return }
        guard !self.didAutoKickoff else { return }
        self.didAutoKickoff = true

        Task { @MainActor in
            for _ in 0..<20 {
                if !self.onboardingChatModel.isLoading { break }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            guard self.onboardingChatModel.messages.isEmpty else { return }
            let kickoff =
                "Hi! I just installed Moltbot and you’re my brand‑new agent. " +
                "Please start the first‑run ritual from BOOTSTRAP.md, ask one question at a time, " +
                "and before we talk about WhatsApp/Telegram, visit soul.md with me to craft SOUL.md: " +
                "ask what matters to me and how you should be. Then guide me through choosing " +
                "how we should talk (web‑only, WhatsApp, or Telegram)."
            self.onboardingChatModel.input = kickoff
            self.onboardingChatModel.send()
        }
    }
}
