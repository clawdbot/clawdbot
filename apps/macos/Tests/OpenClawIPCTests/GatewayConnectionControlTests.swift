import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw
@testable import OpenClawIPC

private final class FakeWebSocketTask: WebSocketTasking, @unchecked Sendable {
    var state: URLSessionTask.State = .running
    var autoRespond = false
    private(set) var sentMessages: [URLSessionWebSocketTask.Message] = []
    private var sentChallenge = false
    private var respondedRequestIds = Set<String>()

    func resume() {}

    func cancel(with _: URLSessionWebSocketTask.CloseCode, reason _: Data?) {
        self.state = .canceling
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        self.sentMessages.append(message)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        if self.autoRespond {
            if !self.sentChallenge {
                self.sentChallenge = true
                return .string("""
                {"type":"event","event":"connect.challenge","payload":{"nonce":"test-nonce"}}
                """)
            }
            if let request = self.latestUnrespondedRequest() {
                self.respondedRequestIds.insert(request.id)
                if request.method == "connect" {
                    return .string("""
                    {"type":"res","id":"\(request.id)","ok":true,"payload":{"type":"hello","protocol":3,"server":{},"features":{},"snapshot":{"presence":[],"health":{},"stateVersion":{"presence":0,"health":0},"uptimeMs":0},"auth":{},"policy":{}}}
                    """)
                }
                return .string("""
                {"type":"res","id":"\(request.id)","ok":true,"payload":{}}
                """)
            }
        }
        throw URLError(.cannotConnectToHost)
    }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        completionHandler(.failure(URLError(.cannotConnectToHost)))
    }

    private func latestUnrespondedRequest() -> (id: String, method: String)? {
        for message in self.sentMessages.reversed() {
            let data: Data? = switch message {
            case let .string(text):
                Data(text.utf8)
            case let .data(raw):
                raw
            @unknown default:
                nil
            }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = json["id"] as? String,
                  let method = json["method"] as? String,
                  !self.respondedRequestIds.contains(id)
            else {
                continue
            }
            return (id, method)
        }
        return nil
    }
}

private final class FakeWebSocketSession: WebSocketSessioning, @unchecked Sendable {
    let task = FakeWebSocketTask()

    func makeWebSocketTask(url _: URL) -> WebSocketTaskBox {
        WebSocketTaskBox(task: self.task)
    }
}

private final class WebSocketMessageRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var messages: [URLSessionWebSocketTask.Message] = []

    func append(_ message: URLSessionWebSocketTask.Message) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.messages.append(message)
    }

    func snapshot() -> [URLSessionWebSocketTask.Message] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.messages
    }
}

private func makeTestGatewayConnection() -> (GatewayConnection, FakeWebSocketSession) {
    let session = FakeWebSocketSession()
    let connection = GatewayConnection(
        configProvider: {
            (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil)
        },
        sessionBox: WebSocketSessionBox(session: session))
    return (connection, session)
}

@Suite(.serialized) struct GatewayConnectionControlTests {
    @Test func `status fails when process missing`() async {
        let (connection, _) = makeTestGatewayConnection()
        let result = await connection.status()
        await connection.shutdown()
        #expect(result.ok == false)
        #expect(result.error != nil)
    }

    @Test func `reject empty message`() async {
        let (connection, _) = makeTestGatewayConnection()
        let result = await connection.sendAgent(
            message: "",
            thinking: nil,
            sessionKey: "main",
            deliver: false,
            to: nil)
        #expect(result.ok == false)
    }

    @Test func `send agent keeps empty voice wake trigger field`() async throws {
        let recorder = WebSocketMessageRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                recorder.append(message)
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            })
        })
        let connection = GatewayConnection(
            configProvider: {
                (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))
        let result = await connection.sendAgent(GatewayAgentInvocation(
            message: "test",
            sessionKey: "main",
            thinking: nil,
            deliver: false,
            to: nil,
            channel: .last,
            timeoutSeconds: nil,
            idempotencyKey: "idem-1",
            voiceWakeTrigger: "   "))
        await connection.shutdown()
        #expect(result.ok == true)

        guard let agentMessage = recorder.snapshot().reversed().first(where: { message in
            guard let data = Self.messageData(message),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return false }
            return json["method"] as? String == "agent"
        }) else {
            Issue.record("expected agent websocket send payload")
            return
        }

        guard let payloadData = Self.messageData(agentMessage) else {
            Issue.record("unexpected agent websocket message type")
            return
        }

        let json = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any]
        let params = json?["params"] as? [String: Any]
        #expect(params?["voiceWakeTrigger"] as? String == "")
    }

    private static func messageData(_ message: URLSessionWebSocketTask.Message) -> Data? {
        switch message {
        case let .string(text):
            Data(text.utf8)
        case let .data(data):
            data
        @unknown default:
            nil
        }
    }
}
