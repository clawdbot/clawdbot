import OpenClawChatUI
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingMascotMoodTests {
    private func mood(_ snapshot: OnboardingView.MascotMoodSnapshot) -> OpenClawMascotMood {
        OnboardingView.mascotMood(for: snapshot)
    }

    @Test func `welcome page idles`() {
        #expect(self.mood(.init(page: .welcome)) == .idle)
    }

    @Test func `connection page follows probe`() {
        #expect(self.mood(.init(page: .connection)) == .curious)
        #expect(self.mood(.init(page: .connection, remoteProbeState: .checking)) == .thinking)
        #expect(self.mood(.init(page: .connection, remoteProbeState: .failed("no route"))) == .sad)
        #expect(self.mood(.init(
            page: .connection,
            remoteProbeState: .ok(RemoteGatewayProbeSuccess(authSource: nil)))) == .happy)
    }

    @Test func `cli page tracks install lifecycle`() {
        #expect(self.mood(.init(page: .cli, installingCLI: true)) == .working)
        #expect(self.mood(.init(page: .cli)) == .working, "status probe still deciding")
        #expect(self.mood(.init(page: .cli, cliStatusKnown: true)) == .sad, "install failed")
        #expect(self.mood(.init(page: .cli, cliInstalled: true, cliStatusKnown: true)) == .happy)
    }

    @Test func `ai page celebrates thinks and mourns`() {
        #expect(self.mood(.init(page: .ai)) == .curious)
        #expect(self.mood(.init(page: .ai, aiPhase: .testing, aiBusy: true)) == .thinking)
        #expect(self.mood(.init(page: .ai, aiFailed: true)) == .sad)
        #expect(self.mood(.init(page: .ai, aiPhase: .connected)) == .celebrating)
        #expect(
            self.mood(.init(page: .ai, aiPhase: .connected, aiFailed: true)) == .celebrating,
            "a live connection outranks stale failures")
    }

    @Test func `permissions page warms up when everything is granted`() {
        #expect(self.mood(.init(page: .permissions)) == .curious)
        #expect(self.mood(.init(page: .permissions, allPermissionsGranted: true)) == .happy)
    }

    @Test func `chat and ready pages`() {
        #expect(self.mood(.init(page: .chat)) == .attentive)
        #expect(self.mood(.init(page: .ready)) == .celebrating)
    }

    @Test func `fresh AI setup model does not look failed`() {
        #expect(!OnboardingView.aiSetupLooksFailed(OnboardingAISetupModel()))
    }
}
