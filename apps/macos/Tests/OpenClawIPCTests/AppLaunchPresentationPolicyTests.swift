import Testing
@testable import OpenClaw

struct AppLaunchPresentationPolicyTests {
    @Test func `normal launches allow automatic presentation`() {
        let policy = AppLaunchPresentationPolicy(arguments: ["OpenClaw"])

        #expect(policy.allowsAutomaticPresentation)
        #expect(policy.shouldAutoOpenChat(arguments: ["OpenClaw", "--chat"]))
        #expect(policy.shouldAutoOpenDashboard(arguments: ["OpenClaw", "--dashboard"]))
    }

    @Test func `background-only wins over automatic presentation flags`() {
        let arguments = ["OpenClaw", "--background-only", "--chat", "--dashboard"]
        let policy = AppLaunchPresentationPolicy(arguments: arguments)

        #expect(!policy.allowsAutomaticPresentation)
        #expect(!policy.shouldAutoOpenChat(arguments: arguments))
        #expect(!policy.shouldAutoOpenDashboard(arguments: arguments))
    }

    @Test func `attach-only does not change presentation behavior`() {
        let arguments = ["OpenClaw", "--attach-only", "--dashboard"]
        let policy = AppLaunchPresentationPolicy(arguments: arguments)

        #expect(policy.allowsAutomaticPresentation)
        #expect(policy.shouldAutoOpenDashboard(arguments: arguments))
    }
}
