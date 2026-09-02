import Foundation
import OpenClawKit
@preconcurrency import WebRTC
import XCTest
@testable import OpenClaw

@MainActor
final class TalkRealtimeConsultCancellationTests: XCTestCase {
    func testStopBeforeAcknowledgementAbortsTheReturnedGlobalTarget() async throws {
        let held = XCTestExpectation(description: "consult request reached Gateway")
        let aborted = XCTestExpectation(description: "late acknowledged consult was aborted")
        let requests = ConsultRequestCapture()
        let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
            let data: Data
            switch message {
            case let .data(value): data = value
            case let .string(value): data = Data(value.utf8)
            @unknown default: return
            }
            let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            await requests.append(data)
            if frame["method"] as? String == "talk.client.toolCall" {
                held.fulfill()
            } else if frame["method"] as? String == "chat.abort" {
                aborted.fulfill()
                let id = try XCTUnwrap(frame["id"] as? String)
                socket.emitReceiveSuccessOnce(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            }
        })
        let gateway = GatewayNodeSession()
        let delegate = ConsultCancellationDelegate()
        let talk = TalkRealtimeWebRTCSession(
            gateway: gateway,
            sessionKey: "main",
            transcriptStore: TalkRealtimeTranscriptStore(),
            delegate: delegate)
        RTCInitializeSSL()
        let factory = RTCPeerConnectionFactory()
        let peer = try XCTUnwrap(factory.peerConnection(
            with: RTCConfiguration(),
            constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil),
            delegate: nil))
        defer {
            talk.stop()
            peer.close()
        }
        do {
            try await gateway.connect(
                url: XCTUnwrap(URL(string: "ws://talk-test.invalid")),
                credentials: .init(),
                connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions,
                sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: { socket })),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            let channel = try XCTUnwrap(peer.dataChannel(
                forLabel: "synthetic-consult",
                configuration: RTCDataChannelConfiguration()))
            let event = #"{"type":"response.function_call_arguments.done","call_id":"call-1","name":"openclaw_agent_consult","arguments":"{\"question\":\"Synthetic consult\"}"}"#
            talk.dataChannel(channel, didReceiveMessageWith: RTCDataBuffer(data: Data(event.utf8), isBinary: false))
            let sent = await XCTWaiter.fulfillment(of: [held], timeout: 5)
            XCTAssertEqual(sent, .completed)
            let capturedID = await requests.requestID(method: "talk.client.toolCall")
            let requestID = try XCTUnwrap(capturedID)

            // Stopping before the response must not abandon the side-effecting request's run.
            talk.stop()
            let ack = try JSONSerialization.data(withJSONObject: [
                "type": "res", "id": requestID, "ok": true,
                "payload": [
                    "runId": "run-1",
                    "idempotencyKey": "run-1",
                    "agentId": "voice",
                    "agentSessionKey": "global",
                ],
            ])
            socket.emitReceiveSuccessOnce(.data(ack))
            let cancelled = await XCTWaiter.fulfillment(of: [aborted], timeout: 5)
            XCTAssertEqual(cancelled, .completed)
            let capturedAbort = await requests.request(method: "chat.abort")
            let abortData = try XCTUnwrap(capturedAbort)
            let abort = try XCTUnwrap(JSONSerialization.jsonObject(with: abortData) as? [String: Any])
            let params = try XCTUnwrap(abort["params"] as? [String: String])
            XCTAssertEqual(params, ["sessionKey": "global", "agentId": "voice", "runId": "run-1"])
            XCTAssertEqual(delegate.finishes, 1)
            XCTAssertFalse(delegate.statuses.contains("Listening"))
        } catch {
            await gateway.disconnect()
            throw error
        }
        await gateway.disconnect()
    }
}

private actor ConsultRequestCapture {
    private var frames: [Data] = []
    func append(_ data: Data) {
        self.frames.append(data)
    }

    func request(method: String) -> Data? {
        self.frames.last { data in
            let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return frame?["method"] as? String == method
        }
    }

    func requestID(method: String) -> String? {
        guard let data = self.request(method: method),
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return frame["id"] as? String
    }
}

@MainActor
private final class ConsultCancellationDelegate: TalkRealtimeWebRTCSessionDelegate {
    var finishes = 0
    var statuses: [String] = []
    func realtimeSession(_: TalkRealtimeWebRTCSession, didChangeStatus status: String) {
        self.statuses.append(status)
    }

    func realtimeSession(_: TalkRealtimeWebRTCSession, didDetectInputSpeech _: Bool) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didUpdateAudioLevels _: Double?, output _: Double?) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didReceiveUserTranscript _: String) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didReceiveAssistantTranscript _: String) {}
    func realtimeSession(
        _: TalkRealtimeWebRTCSession,
        didFailTranscriptPersistenceForEntry _: String,
        error _: Error) {}
    func realtimeSessionDidFinish(_: TalkRealtimeWebRTCSession) {
        self.finishes += 1
    }
}
