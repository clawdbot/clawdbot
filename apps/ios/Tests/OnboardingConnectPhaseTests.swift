import OpenClawKit
import Testing
@testable import OpenClaw

struct OnboardingConnectPhaseTests {
    @Test func `previous error remains visible while reconnecting`() {
        let problem = GatewayConnectionProblem(
            kind: .timeout,
            owner: .network,
            title: "Connection timed out",
            message: "The gateway did not respond before the connection timed out.",
            retryable: true,
            pauseReconnect: false)

        let phase = OnboardingConnectPhase.resolve(
            problem: problem,
            connectingDetail: "Reconnecting…",
            localFailure: nil,
            retryableFailure: nil)

        #expect(phase == .failed(problem))
    }

    @Test func `reconnect progress shows when no error remains`() {
        let phase = OnboardingConnectPhase.resolve(
            problem: nil,
            connectingDetail: "Reconnecting…",
            localFailure: nil,
            retryableFailure: nil)

        #expect(phase == .connecting(detail: "Reconnecting…"))
    }

    @Test func `local failure keeps precedence over reconnect progress`() {
        let phase = OnboardingConnectPhase.resolve(
            problem: nil,
            connectingDetail: "Reconnecting…",
            localFailure: "No connection to retry.",
            retryableFailure: nil)

        #expect(phase == .failedStatus(message: "No connection to retry.", allowsRetry: false))
    }
}
