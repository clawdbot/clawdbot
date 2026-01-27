import MoltbotKit
import Foundation
import os
import Testing
@testable import Moltbot

@Suite struct GatewayChannelShutdownTests {
    private final class FakeWebSocketTask: WebSocketTasking, @unchecked Sendable {
        private let connectRequestID = OSAllocatedUnfairLock<String?>(initialState: nil)
        private let pendingReceiveHandler =
            OSAllocatedUnfairLock<(@Sendable (Result<URLSessionWebSocketTask.Message, Error>)
                    -> Void)?>(initialState: nil)
        private let cancelCount = OSAllocatedUnfairLock(initialState: 0)

        var state: URLSessionTask.State = .suspended

        func snapshotCancelCount() -> Int { self.cancelCount.withLock { $0 } }

        func resume() {
            self.state = .running
        }

        func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
            _ = (closeCode, reason)
            self.state = .canceling
            self.cancelCount.withLock { $0 += 1 }
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
            let id = self.connectRequestID.withLock { $0 } ?? "connect"
            return .data(Self.connectOkData(id: id))
        }

        func receive(
            completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
        {
            self.pendingReceiveHandler.withLock { $0 = completionHandler }
        }

        func triggerReceiveFailure() {
            let handler = self.pendingReceiveHandler.withLock { $0 }
            handler?(Result<URLSessionWebSocketTask.Message, Error>.failure(URLError(.networkConnectionLost)))
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
        private let makeCount = OSAllocatedUnfairLock(initialState: 0)
        private let tasks = OSAllocatedUnfairLock(initialState: [FakeWebSocketTask]())

        func snapshotMakeCount() -> Int { self.makeCount.withLock { $0 } }
        func latestTask() -> FakeWebSocketTask? { self.tasks.withLock { $0.last } }

        func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
            _ = url
            self.makeCount.withLock { $0 += 1 }
            let task = FakeWebSocketTask()
            self.tasks.withLock { $0.append(task) }
            return WebSocketTaskBox(task: task)
        }
    }

    @Test func shutdownPreventsReconnectLoopFromReceiveFailure() async throws {
        let session = FakeWebSocketSession()
        let channel = GatewayChannelActor(
            url: URL(string: "ws://example.invalid")!,
            token: nil,
            session: WebSocketSessionBox(session: session))

        // Establish a connection so `listen()` is active.
        try await channel.connect()
        #expect(session.snapshotMakeCount() == 1)

        // Simulate a socket receive failure, which would normally schedule a reconnect.
        session.latestTask()?.triggerReceiveFailure()

        // Shut down quickly, before backoff reconnect triggers.
        await channel.shutdown()

        // Wait longer than the default reconnect backoff (500ms) to ensure no reconnect happens.
        try? await Task.sleep(nanoseconds: 750 * 1_000_000)

        #expect(session.snapshotMakeCount() == 1)
    }
}
