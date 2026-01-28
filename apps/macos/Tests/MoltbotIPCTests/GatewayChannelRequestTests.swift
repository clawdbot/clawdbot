import MoltbotKit
import Foundation
import os
import Testing
@testable import Moltbot

@Suite struct GatewayChannelRequestTests {
    private final class FakeWebSocketTask: WebSocketTasking, @unchecked Sendable {
        private let requestSendDelayMs: Int
        private let connectRequestID = OSAllocatedUnfairLock<String?>(initialState: nil)
        private let pendingReceiveHandler =
            OSAllocatedUnfairLock<(@Sendable (Result<URLSessionWebSocketTask.Message, Error>)
                    -> Void)?>(initialState: nil)
        private let sendCount = OSAllocatedUnfairLock(initialState: 0)

        var state: URLSessionTask.State = .suspended

        init(requestSendDelayMs: Int) {
            self.requestSendDelayMs = requestSendDelayMs
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
            _ = message
            let currentSendCount = self.sendCount.withLock { count in
                defer { count += 1 }
                return count
            }

            // First send is the connect handshake. Second send is the request frame.
            if currentSendCount == 0 {
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
            if currentSendCount == 1 {
                try await Task.sleep(nanoseconds: UInt64(self.requestSendDelayMs) * 1_000_000)
                throw URLError(.cannotConnectToHost)
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
        private let requestSendDelayMs: Int

        init(requestSendDelayMs: Int) {
            self.requestSendDelayMs = requestSendDelayMs
        }

        func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
            _ = url
            let task = FakeWebSocketTask(requestSendDelayMs: self.requestSendDelayMs)
            return WebSocketTaskBox(task: task)
        }
    }

    @Test func requestTimeoutThenSendFailureDoesNotDoubleResume() async {
        let session = FakeWebSocketSession(requestSendDelayMs: 100)
        let channel = GatewayChannelActor(
            url: URL(string: "ws://example.invalid")!,
            token: nil,
            session: WebSocketSessionBox(session: session))

        do {
            _ = try await channel.request(method: "test", params: nil, timeoutMs: 10)
            Issue.record("Expected request to time out")
        } catch {
            let ns = error as NSError
            #expect(ns.domain == "Gateway")
            #expect(ns.code == 5)
        }

        // Give the delayed send failure task time to run; this used to crash due to a double-resume.
        try? await Task.sleep(nanoseconds: 250 * 1_000_000)
    }
}
