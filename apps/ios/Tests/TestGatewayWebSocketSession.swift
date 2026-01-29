import MoltbotKit
import Foundation
import os

final class TestGatewayWebSocketTask: WebSocketTasking, @unchecked Sendable {
    private let connectRequestID = OSAllocatedUnfairLock<String?>(initialState: nil)
    private let connectParamsData = OSAllocatedUnfairLock<Data?>(initialState: nil)
    private let requestMethods = OSAllocatedUnfairLock<[String]>(initialState: [])
    private let pendingReceiveHandler =
        OSAllocatedUnfairLock<(@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?>(
            initialState: nil)
    private let queuedMessages = OSAllocatedUnfairLock<[URLSessionWebSocketTask.Message]>(initialState: [])
    private let sentChallenge = OSAllocatedUnfairLock(initialState: false)

    var state: URLSessionTask.State = .suspended

    func snapshotConnectParams() -> [String: Any]? {
        guard let data = self.connectParamsData.withLock({ $0 }) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    func snapshotRequestMethods() -> [String] {
        self.requestMethods.withLock { $0 }
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
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              obj["type"] as? String == "req",
              let id = obj["id"] as? String,
              let method = obj["method"] as? String
        else { return }

        if method == "connect" {
            self.connectRequestID.withLock { $0 = id }
            let paramsData = obj["params"].flatMap { try? JSONSerialization.data(withJSONObject: $0) }
            self.connectParamsData.withLock { $0 = paramsData }
            return
        }

        self.requestMethods.withLock { $0.append(method) }
        guard let responseData = Self.responseData(for: method, id: id) else { return }
        self.deliver(.data(responseData))
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        if self.sentChallenge.withLock({ $0 == false }) {
            self.sentChallenge.withLock { $0 = true }
            return .data(Self.connectChallengeData())
        }
        let id = self.connectRequestID.withLock { $0 } ?? "connect"
        return .data(Self.connectOkData(id: id))
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        let message = self.queuedMessages.withLock { messages -> URLSessionWebSocketTask.Message? in
            guard !messages.isEmpty else { return nil }
            return messages.removeFirst()
        }
        if let message {
            completionHandler(.success(message))
            return
        }
        self.pendingReceiveHandler.withLock { $0 = completionHandler }
    }

    private func deliver(_ message: URLSessionWebSocketTask.Message) {
        let handler = self.pendingReceiveHandler.withLock { handler -> ((@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void))? in
            let h = handler
            handler = nil
            return h
        }
        if let handler {
            handler(.success(message))
        } else {
            self.queuedMessages.withLock { $0.append(message) }
        }
    }

    private static func connectChallengeData() -> Data {
        let json = """
        {
          "type": "event",
          "event": "connect.challenge",
          "payload": { "nonce": "test-nonce" }
        }
        """
        return Data(json.utf8)
    }

    private static func connectOkData(id: String) -> Data {
        let json = """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "type": "hello-ok",
            "protocol": 3,
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

    private static func responseData(for method: String, id: String) -> Data? {
        switch method {
        case "chat.send":
            return Data("""
            {
              "type": "res",
              "id": "\(id)",
              "ok": true,
              "payload": { "runId": "run-1", "status": "ok" }
            }
            """.utf8)
        case "chat.history":
            return Data("""
            {
              "type": "res",
              "id": "\(id)",
              "ok": true,
              "payload": {
                "sessionKey": "main",
                "sessionId": null,
                "messages": [],
                "thinkingLevel": "low"
              }
            }
            """.utf8)
        case "health":
            return Data("""
            {
              "type": "res",
              "id": "\(id)",
              "ok": true,
              "payload": { "ok": true }
            }
            """.utf8)
        case "config.get":
            return Data("""
            {
              "type": "res",
              "id": "\(id)",
              "ok": true,
              "payload": {
                "config": {
                  "ui": { "seamColor": "#ffffff" },
                  "session": { "mainKey": "main" }
                }
              }
            }
            """.utf8)
        case "voicewake.get":
            return Data("""
            {
              "type": "res",
              "id": "\(id)",
              "ok": true,
              "payload": { "triggers": ["clawd"] }
            }
            """.utf8)
        default:
            return nil
        }
    }
}

final class TestGatewayWebSocketSession: WebSocketSessioning, @unchecked Sendable {
    private let taskLock = OSAllocatedUnfairLock<[TestGatewayWebSocketTask]>(initialState: [])

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        _ = url
        let task = TestGatewayWebSocketTask()
        self.taskLock.withLock { $0.append(task) }
        return WebSocketTaskBox(task: task)
    }

    func snapshotConnectRoles() -> [String] {
        self.taskLock.withLock { tasks in
            tasks.compactMap { $0.snapshotConnectParams()?["role"] as? String }
        }
    }

    func snapshotRequestMethods() -> [String] {
        self.taskLock.withLock { tasks in
            tasks.flatMap { $0.snapshotRequestMethods() }
        }
    }
}
