import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct MacNodeHostWorkerPipeTests {
    @Test func `closed worker input cannot terminate the app with SIGPIPE`() async throws {
        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        let script = """
        exec 0<&-
        printf '%s\\n' '{"type":"ready","version":"test","manifest":{"caps":[],"commands":[],"pathEnv":"/bin"}}'
        sleep 1
        """
        _ = try await worker.start(command: ["/bin/sh", "-c", script])

        let response = await worker.invoke(BridgeInvokeRequest(
            id: "closed",
            command: "system.run",
            paramsJSON: #"{"command":["/usr/bin/true"]}"#))

        #expect(!response.ok)
        await worker.stop()
    }
}
