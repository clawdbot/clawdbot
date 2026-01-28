import MoltbotKit
import Foundation
import os
import Testing
@testable import Moltbot

@Suite struct GatewayChannelConnectTests {
    private enum FakeResponse {
        case helloOk(delayMs: Int)
        case invalid(delayMs: Int)
    }

    private final class FakeWebSocketTask: WebSocketTasking, @unchecked Sendable {
        private let response: FakeResponse
        private let connectRequestID = OSAllocatedUnfairLock<String?>(initialState: nil)
        private let pendingReceiveHandler =
            OSAllocatedUnfairLock<(@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?>(
                initialState: nil)

        var state: URLSessionTask.State = .suspended

        init(response: FakeResponse) {
            self.response = response
        }

        func resume() {
            self.state = .running
        }

        func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
            _ = (closeCode, reason)
            self.state = .canceling
            let handler = self.pendingReceiveHandler.withLock { handler in
                defer { handler = nil }
                return handler
            }
            handler?(Result<URLSessionWebSocketTask.Message, Error>.failure(URLError(.cancelled)))
        }

        func send(_ message: URLSessionWebSocketTask.Message) async throws {
            let data: Data? = switch message {
            case let .data(d): d
            case let .string(s): s.data(using: .utf8)
            @unknown default: nil
            }
            guard let data else { return }
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               obj["type"] as? String == "req",
               obj["method"] as? String == "connect",
               let id = obj["id"] as? String
            {
                self.connectRequestID.withLock { $0 = id }
            }
        }

        func receive() async throws -> URLSessionWebSocketTask.Message {
            let delayMs: Int
            let msg: URLSessionWebSocketTask.Message
            switch self.response {
            case let .helloOk(ms):
                delayMs = ms
                let id = self.connectRequestID.withLock { $0 } ?? "connect"
                msg = .data(Self.connectOkData(id: id))
            case let .invalid(ms):
                delayMs = ms
                msg = .string("not json")
            }
            try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            return msg
        }

        func receive(
            completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
        {
            // The production channel sets up a continuous receive loop after hello.
            // Tests only need the handshake receive; keep the loop idle.
            self.pendingReceiveHandler.withLock { $0 = completionHandler }
        }

        private static func connectOkData(id: String) -> Data {
            let json = """
            {
              "type": "res",
              "id": "\(id)",
              "ok": true,
              "payload": {
                "type": "hello-ok",
                "protocol": 2,
                "server": { "version": "test", "connId": "test" },
                "features": { "methods": [], "events": [] },
                "snapshot": {
                  "presence": [ { "ts": 1 } ],
                  "health": {},
                  "stateVersion": { "presence": 0, "health": 0 },
                  "uptimeMs": 0
                },
                "policy": { "maxPayload": 1, "maxBufferedBytes": 1, "tickIntervalMs": 30000 }
              }
            }
            """
            return Data(json.utf8)
        }
    }

    private final class FakeWebSocketSession: WebSocketSessioning, @unchecked Sendable {
        private let response: FakeResponse
        private let makeCount = OSAllocatedUnfairLock(initialState: 0)

        init(response: FakeResponse) {
            self.response = response
        }

        func snapshotMakeCount() -> Int { self.makeCount.withLock { $0 } }

        func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
            _ = url
            self.makeCount.withLock { $0 += 1 }
            let task = FakeWebSocketTask(response: self.response)
            return WebSocketTaskBox(task: task)
        }
    }

    @Test func concurrentConnectIsSingleFlightOnSuccess() async throws {
        let session = FakeWebSocketSession(response: .helloOk(delayMs: 200))
        let channel = GatewayChannelActor(
            url: URL(string: "ws://example.invalid")!,
            token: nil,
            session: WebSocketSessionBox(session: session))

        let t1 = Task { try await channel.connect() }
        let t2 = Task { try await channel.connect() }

        _ = try await t1.value
        _ = try await t2.value

        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func concurrentConnectSharesFailure() async {
        let session = FakeWebSocketSession(response: .invalid(delayMs: 200))
        let channel = GatewayChannelActor(
            url: URL(string: "ws://example.invalid")!,
            token: nil,
            session: WebSocketSessionBox(session: session))

        let t1 = Task { try await channel.connect() }
        let t2 = Task { try await channel.connect() }

        let r1 = await t1.result
        let r2 = await t2.result

        #expect({
            if case .failure = r1 { true } else { false }
        }())
        #expect({
            if case .failure = r2 { true } else { false }
        }())
        #expect(session.snapshotMakeCount() == 1)
    }
}
