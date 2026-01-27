import Testing
@testable import Moltbot

@Suite(.serialized) struct GatewayDiscoveryModelTests {
    @Test @MainActor func debugLoggingCapturesLifecycleAndResets() {
        let model = GatewayDiscoveryModel()

        #expect(model.debugLog.isEmpty)
        #expect(model.statusText == "Idle")

        model.setDebugLoggingEnabled(true)
        #expect(model.debugLog.count >= 2)

        model.stop()
        #expect(model.statusText == "Stopped")
        #expect(model.gateways.isEmpty)
        #expect(model.debugLog.count >= 3)

        model.setDebugLoggingEnabled(false)
        #expect(model.debugLog.isEmpty)
    }
}
