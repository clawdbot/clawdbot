import CryptoKit
import Testing
@testable import OpenClaw

struct AppLaunchPresentationPolicyTests {
    @Test func `normal launches allow automatic presentation`() {
        let policy = AppLaunchPresentationPolicy(arguments: ["OpenClaw"])

        #expect(policy.allowsAutomaticPresentation)
        #expect(policy.allowsGatewayUIKeychainAccess)
        #expect(policy.shouldAutoOpenChat(arguments: ["OpenClaw", "--chat"]))
        #expect(policy.shouldAutoOpenDashboard(arguments: ["OpenClaw", "--dashboard"]))
    }

    @Test func `background-only wins over automatic presentation flags`() {
        let arguments = ["OpenClaw", "--attach-only", "--background-only", "--chat", "--dashboard"]
        let policy = AppLaunchPresentationPolicy(arguments: arguments)

        #expect(!policy.allowsAutomaticPresentation)
        #expect(!policy.allowsGatewayUIKeychainAccess)
        #expect(!policy.shouldAutoOpenChat(arguments: arguments))
        #expect(!policy.shouldAutoOpenDashboard(arguments: arguments))
    }

    @Test func `attach-only does not change presentation behavior`() {
        let arguments = ["OpenClaw", "--attach-only", "--dashboard"]
        let policy = AppLaunchPresentationPolicy(arguments: arguments)

        #expect(policy.allowsAutomaticPresentation)
        #expect(policy.allowsGatewayUIKeychainAccess)
        #expect(policy.shouldAutoOpenDashboard(arguments: arguments))
    }

    @Test func `background launch never calls the prompt bearing activation key loader`() {
        var loadCount = 0
        let key = GatewayConnection.activationBindingKey(
            launchPolicy: AppLaunchPresentationPolicy(arguments: ["OpenClaw", "--background-only"]),
            loadOrCreate: {
                loadCount += 1
                return SymmetricKey(size: .bits256)
            })

        #expect(key == nil)
        #expect(loadCount == 0)
    }

    @Test func `interactive launch retains the activation binding key`() {
        var loadCount = 0
        let key = GatewayConnection.activationBindingKey(
            launchPolicy: AppLaunchPresentationPolicy(arguments: ["OpenClaw"]),
            loadOrCreate: {
                loadCount += 1
                return SymmetricKey(size: .bits256)
            })

        #expect(key != nil)
        #expect(loadCount == 1)
    }
}
