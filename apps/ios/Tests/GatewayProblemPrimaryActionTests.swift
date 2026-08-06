import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct GatewayProblemPrimaryActionTests {
    @Test func `protocol mismatch uses update action instead of retry`() {
        let problem = GatewayConnectionProblem(
            kind: .protocolMismatch,
            owner: .iphone,
            title: "App update required",
            message: "This app is older than the gateway.",
            actionLabel: "Update app",
            retryable: false,
            pauseReconnect: true)

        let title = GatewayProblemPrimaryAction.title(for: problem, retryTitle: "Retry connection")

        #expect(title == "Update app")
    }

    @Test func `older gateway exposes its copyable update command`() {
        let problem = GatewayConnectionProblem(
            kind: .protocolMismatch,
            owner: .gateway,
            title: "Gateway update required",
            message: "The gateway is older than this app.",
            actionLabel: "Copy update command",
            actionCommand: "openclaw update",
            retryable: false,
            pauseReconnect: true)

        let title = GatewayProblemPrimaryAction.title(for: problem, retryTitle: "Retry connection")

        #expect(title == "Copy update command")
        #expect(problem.actionCommand == "openclaw update")
    }

    @Test func `reset-suggesting problem uses reset title when provided`() {
        let problem = GatewayConnectionProblem(
            kind: .gatewayAuthTokenMismatch,
            owner: .iphone,
            title: "Stored gateway token rejected",
            message: "Reset onboarding to pair again.",
            retryable: false,
            pauseReconnect: true)

        let title = GatewayProblemPrimaryAction.title(
            for: problem,
            retryTitle: "Retry",
            resetTitle: "Reset onboarding",
            nonRetryableTitle: "Open Settings")

        #expect(title == "Reset onboarding")
    }

    @Test func `retryable problem uses mapped action label`() {
        let problem = GatewayConnectionProblem(
            kind: .timeout,
            owner: .network,
            title: "Connection timed out",
            message: "Check the gateway network path.",
            actionLabel: "Try again",
            retryable: true,
            pauseReconnect: false)

        let title = GatewayProblemPrimaryAction.title(for: problem, retryTitle: "Retry connection")

        #expect(title == "Try again")
    }
}
