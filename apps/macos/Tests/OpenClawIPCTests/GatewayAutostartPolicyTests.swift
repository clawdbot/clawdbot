import Testing
@testable import OpenClaw

@Suite(.serialized)
struct GatewayAutostartPolicyTests {
    @Test func `starts gateway only when local and not paused`() {
        #expect(GatewayAutostartPolicy.shouldStartGateway(mode: .local, paused: false))
        #expect(!GatewayAutostartPolicy.shouldStartGateway(mode: .local, paused: true))
        #expect(!GatewayAutostartPolicy.shouldStartGateway(mode: .remote, paused: false))
        #expect(!GatewayAutostartPolicy.shouldStartGateway(mode: .unconfigured, paused: false))
    }

    @MainActor
    @Test func `paused first-run recovery does not activate gateway`() {
        var activationCount = 0
        let activated = GatewayAutostartPolicy.activateGatewayForRecovery(
            mode: .local,
            paused: true,
            activate: { activationCount += 1 })

        #expect(!activated)
        #expect(activationCount == 0)
    }

    @Test func `ensures launch agent when local and not attach only`() {
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
