import Testing
@testable import Moltbot

@Suite(.serialized)
struct GatewayAutostartPolicyTests {
    @Test func startsGatewayOnlyWhenLocalAndNotPaused() {
        #expect(GatewayAutostartPolicy.shouldStartGateway(mode: .local, paused: false))
        #expect(!GatewayAutostartPolicy.shouldStartGateway(mode: .local, paused: true))
        #expect(!GatewayAutostartPolicy.shouldStartGateway(mode: .remote, paused: false))
        #expect(!GatewayAutostartPolicy.shouldStartGateway(mode: .unconfigured, paused: false))
    }

    @Test func ensuresLaunchAgentWhenLocalAndNotAttachOnly() {
        #expect(GatewayAutostartPolicy.shouldEnsureLaunchAgent(
            mode: .local,
            paused: false))
        #expect(!GatewayAutostartPolicy.shouldEnsureLaunchAgent(
            mode: .local,
            paused: true))
        #expect(!GatewayAutostartPolicy.shouldEnsureLaunchAgent(
            mode: .remote,
            paused: false))
    }
}
