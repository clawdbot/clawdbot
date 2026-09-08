import Foundation
import Testing
@testable import OpenClaw

struct RemoteTunnelManagerTests {
    @Test func `shutdown rejects new tunnel work even after a reusable stop`() async {
        let manager = RemoteTunnelManager()
        await manager.shutdown()
        await manager.stopAll()

        #expect(await manager.controlTunnelRouteIfRunning() == nil)
        await #expect(throws: CancellationError.self) {
            try await manager.ensureControlTunnelRoute()
        }
        await #expect(throws: CancellationError.self) {
            try await manager.ensureControlTunnel()
        }
    }
}
