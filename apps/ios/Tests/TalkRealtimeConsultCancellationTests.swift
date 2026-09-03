import Foundation
import OpenClawKit
@preconcurrency import WebRTC
import XCTest
@testable import OpenClaw

@MainActor
final class TalkRealtimeConsultCancellationTests: XCTestCase {
    func testHistoryFallbackWaitsForTheAcknowledgedRunInsteadOfANewerForeignReply() async throws {
        let completed = XCTestExpectation(description: "consult returned to listening")
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
            let payload: [String: Any]
            switch frame["method"] as? String {
            case "talk.client.toolCall":
                payload = ["runId": "owned-run", "agentId": "voice", "agentSessionKey": "global"]
            case "agent.wait":
                payload = ["status": "ok"]
            case "chat.history":
                let owned = await requests.count(method: "chat.history") > 1
                payload = [
                    "sessionKey": "global",
                    "messages": [[
                        "role": "assistant",
                        "content": [["type": "text", "text": owned ? "Owned answer" : "Unrelated answer"]],
                        "timestamp": Date().timeIntervalSince1970 * 1000,
                        "stopReason": "stop",
                        "idempotencyKey": "owned-run",
                        "__openclaw": ["runId": owned ? "owned-run" : "foreign-run"],
                    ]],
                ]
            default:
                return
            }
            let response = try JSONSerialization.data(withJSONObject: [
                "type": "res", "id": XCTUnwrap(frame["id"] as? String), "ok": true, "payload": payload,
            ])
            socket.emitReceiveSuccessOnce(.data(response))
        })
        let delegate = ConsultCancellationDelegate()
        delegate.onListening = { completed.fulfill() }
        try await Self.withSubmittedConsult(socket: socket, delegate: delegate) { _ in
            let finished = await XCTWaiter.fulfillment(of: [completed], timeout: 5)
            XCTAssertEqual(finished, .completed)
            let historyReads = await requests.count(method: "chat.history")
            XCTAssertGreaterThanOrEqual(historyReads, 2, "A foreign reply must not complete the consult")
            XCTAssertFalse(delegate.statuses.contains("OpenClaw unavailable"))
        }
    }

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
        let delegate = ConsultCancellationDelegate()
        try await Self.withSubmittedConsult(socket: socket, delegate: delegate) { talk in
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
        }
    }

    private static func withSubmittedConsult(
        socket: GatewayTestWebSocketTask,
        delegate: ConsultCancellationDelegate,
        body: (TalkRealtimeWebRTCSession) async throws -> Void) async throws
    {
        let gateway = GatewayNodeSession()
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
            try await body(talk)
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

    func count(method: String) -> Int {
        self.frames.count { data in
            let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return frame?["method"] as? String == method
        }
    }
}

@MainActor
private final class ConsultCancellationDelegate: TalkRealtimeWebRTCSessionDelegate {
    var finishes = 0
    var statuses: [String] = []
    var onListening: (() -> Void)?
    func realtimeSession(_: TalkRealtimeWebRTCSession, didChangeStatus status: String) {
        self.statuses.append(status)
        if status == "Listening" { self.onListening?() }
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
