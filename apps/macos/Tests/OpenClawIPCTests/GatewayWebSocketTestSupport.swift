import Foundation
import OpenClawKit

extension WebSocketTasking {
    /// Keep unit-test doubles resilient to protocol additions.
    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
    }
}

enum GatewayWebSocketTestSupport {
    static func connectChallengeData(nonce: String = "test-nonce") -> Data {
        let json = """
        {
          "type": "event",
          "event": "connect.challenge",
          "payload": { "nonce": "\(nonce)" }
        }
        """
        return Data(json.utf8)
    }

    static func connectRequestID(from message: URLSessionWebSocketTask.Message) -> String? {
        guard let obj = self.requestFrameObject(from: message) else { return nil }
        guard (obj["type"] as? String) == "req", (obj["method"] as? String) == "connect" else {
            return nil
        }
        return obj["id"] as? String
    }

    static func connectOkData(id: String) -> Data {
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
            "auth": { "role": "operator", "scopes": [] },
            "policy": { "maxPayload": 1, "maxBufferedBytes": 1, "tickIntervalMs": 30000 }
          }
        }
        """
        return Data(json.utf8)
    }

    static func connectAuthFailureData(
        id: String,
        detailCode: String,
        message: String = "gateway auth rejected",
        canRetryWithDeviceToken: Bool = false,
        recommendedNextStep: String? = nil) -> Data
    {
        let recommendedNextStepJson = if let recommendedNextStep {
            """
            ,
                          "recommendedNextStep": "\(recommendedNextStep)"
            """
        } else {
            ""
        }
        let json = """
        {
          "type": "res",
          "id": "\(id)",
          "ok": false,
          "error": {
            "message": "\(message)",
            "details": {
              "code": "\(detailCode)",
              "canRetryWithDeviceToken": \(canRetryWithDeviceToken ? "true" : "false")
              \(recommendedNextStepJson)
            }
          }
        }
        """
        return Data(json.utf8)
    }

    static func requestID(from message: URLSessionWebSocketTask.Message) -> String? {
        guard let obj = self.requestFrameObject(from: message) else { return nil }
        guard (obj["type"] as? String) == "req" else {
            return nil
        }
        return obj["id"] as? String
    }

    private static func requestFrameObject(from message: URLSessionWebSocketTask.Message) -> [String: Any]? {
        let data: Data? = switch message {
        case let .data(d): d
        case let .string(s): s.data(using: .utf8)
        @unknown default: nil
        }
        guard let data else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    static func okResponseData(id: String) -> Data {
        let json = """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": { "ok": true }
        }
        """
        return Data(json.utf8)
    }
}

extension NSLock {
    @inline(__always)
    fileprivate func withLock<T>(_ body: () throws -> T) rethrows -> T {
        self.lock(); defer { self.unlock() }
        return try body()
    }
}

final class GatewayTestWebSocketTask: WebSocketTasking, @unchecked Sendable {
    typealias SendHook = @Sendable (GatewayTestWebSocketTask, URLSessionWebSocketTask.Message, Int) async throws -> Void
    typealias ReceiveHook = @Sendable (GatewayTestWebSocketTask, Int) async throws -> URLSessionWebSocketTask.Message

    private let lock = NSLock()
    private let sendHook: SendHook?
    private let receiveHook: ReceiveHook?
    private var _state: URLSessionTask.State = .suspended
    private var connectRequestID: String?
    private var sendCount = 0
    private var receiveCount = 0
    private var cancelCount = 0
    private var pendingReceiveHandler: (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?

    init(sendHook: SendHook? = nil, receiveHook: ReceiveHook? = nil) {
        self.sendHook = sendHook
        self.receiveHook = receiveHook
    }

    var state: URLSessionTask.State {
        get { self.lock.withLock { self._state } }
        set { self.lock.withLock { self._state = newValue } }
    }

    func snapshotCancelCount() -> Int {
        self.lock.withLock { self.cancelCount }
    }

    func snapshotConnectRequestID() -> String? {
        self.lock.withLock { self.connectRequestID }
    }

    func resume() {
        self.state = .running
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        _ = (closeCode, reason)
        let handler = self.lock.withLock { () -> (@Sendable (Result<
            URLSessionWebSocketTask.Message,
            Error,
        >) -> Void)? in
            self._state = .canceling
            self.cancelCount += 1
            defer { self.pendingReceiveHandler = nil }
            return self.pendingReceiveHandler
        }
        handler?(Result<URLSessionWebSocketTask.Message, Error>.failure(URLError(.cancelled)))
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let sendIndex = self.lock.withLock { () -> Int in
            let current = self.sendCount
            self.sendCount += 1
            return current
        }
        if sendIndex == 0, let id = GatewayWebSocketTestSupport.connectRequestID(from: message) {
            self.lock.withLock { self.connectRequestID = id }
        }
        try await self.sendHook?(self, message, sendIndex)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        let receiveIndex = self.lock.withLock { () -> Int in
            let current = self.receiveCount
            self.receiveCount += 1
            return current
        }
        if let receiveHook = self.receiveHook {
            return try await receiveHook(self, receiveIndex)
        }
        if receiveIndex == 0 {
            return .data(GatewayWebSocketTestSupport.connectChallengeData())
        }
        let id = self.snapshotConnectRequestID() ?? "connect"
        return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        self.lock.withLock { self.pendingReceiveHandler = completionHandler }
    }

    func emitReceiveSuccess(_ message: URLSessionWebSocketTask.Message) {
        let handler = self.lock.withLock { self.pendingReceiveHandler }
        handler?(Result<URLSessionWebSocketTask.Message, Error>.success(message))
    }

    func emitReceiveFailure(_ error: Error = URLError(.networkConnectionLost)) {
        let handler = self.lock.withLock { self.pendingReceiveHandler }
        handler?(Result<URLSessionWebSocketTask.Message, Error>.failure(error))
    }
}

final class GatewayTestWebSocketSession: WebSocketSessioning, @unchecked Sendable {
    typealias TaskFactory = @Sendable () -> GatewayTestWebSocketTask

    private let lock = NSLock()
    private let taskFactory: TaskFactory
    private var tasks: [GatewayTestWebSocketTask] = []
    private var makeCount = 0

    init(taskFactory: @escaping TaskFactory = { GatewayTestWebSocketTask() }) {
        self.taskFactory = taskFactory
    }

    func snapshotMakeCount() -> Int {
        self.lock.withLock { self.makeCount }
    }

    func snapshotCancelCount() -> Int {
        self.lock.withLock { self.tasks.reduce(0) { $0 + $1.snapshotCancelCount() } }
    }

    func latestTask() -> GatewayTestWebSocketTask? {
        self.lock.withLock { self.tasks.last }
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        _ = url
        let task = self.taskFactory()
        self.lock.withLock {
            self.makeCount += 1
            self.tasks.append(task)
        }
        return WebSocketTaskBox(task: task)
    }
}
