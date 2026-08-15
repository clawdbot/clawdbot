import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private func remoteProbeHealthResponse(id: String) -> Data {
    Data(
        """
        {"type":"res","id":"\(
            id)","ok":true,"payload":{"ts":0,"durationMs":0,"channels":{},"sessions":{"path":"","count":0,"recent":[]}}}
        """.utf8)
}

@Suite(.serialized)
struct RemoteGatewayProbeTests {
    @Test func `direct probe starts websocket and health request`() async {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex == 1,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(remoteProbeHealthResponse(id: id)))
            })
        })
        let gateway = GatewayConnection(
            configProvider: {
                try (url: #require(URL(string: "ws://gateway.example.test")), token: nil, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))

        let result = await RemoteGatewayProbe._testProbeGateway(
            connection: gateway,
            timeoutMs: 0)

        #expect(result == .ready(RemoteGatewayProbeSuccess(authSource: GatewayAuthSource.none)))
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.state == .running)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
        await gateway.shutdown()
    }

    @Test func `direct probe timeout reaches terminal failure`() async {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(receiveHook: { _, _ in
                try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
                throw URLError(.timedOut)
            })
        })
        let gateway = GatewayConnection(
            configProvider: {
                try (url: #require(URL(string: "ws://gateway.example.test")), token: nil, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))

        let result = await RemoteGatewayProbe._testProbeGateway(
            connection: gateway,
            timeoutMs: 10)

        #expect(result == .failed("Remote gateway check timed out after 10ms"))
        #expect(session.snapshotMakeCount() == 1)
        await gateway.shutdown()
    }
}
