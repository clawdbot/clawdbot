import MoltbotKit
import Foundation
import os
import Testing
@testable import Moltbot

@Suite struct GatewayConnectionTests {
    private final class FakeWebSocketTask: WebSocketTasking, @unchecked Sendable {
        private let connectRequestID = OSAllocatedUnfairLock<String?>(initialState: nil)
        private let pendingReceiveHandler =
            OSAllocatedUnfairLock<(@Sendable (Result<URLSessionWebSocketTask.Message, Error>)
                    -> Void)?>(initialState: nil)
        private let cancelCount = OSAllocatedUnfairLock(initialState: 0)
        private let sendCount = OSAllocatedUnfairLock(initialState: 0)
        private let helloDelayMs: Int

        var state: URLSessionTask.State = .suspended

        init(helloDelayMs: Int = 0) {
            self.helloDelayMs = helloDelayMs
        }

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
            let currentSendCount = self.sendCount.withLock { count in
                defer { count += 1 }
                return count
            }

            // First send is the connect handshake request. Subsequent sends are request frames.
            if currentSendCount == 0 {
                guard case let .data(data) = message else { return }
                if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   (obj["type"] as? String) == "req",
                   (obj["method"] as? String) == "connect",
                   let id = obj["id"] as? String
                {
                    self.connectRequestID.withLock { $0 = id }
                }
                return
            }

            guard case let .data(data) = message else { return }
            guard
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                (obj["type"] as? String) == "req",
                let id = obj["id"] as? String
            else {
                return
            }

            let response = Self.responseData(id: id)
            let handler = self.pendingReceiveHandler.withLock { $0 }
            handler?(Result<URLSessionWebSocketTask.Message, Error>.success(.data(response)))
        }

        func receive() async throws -> URLSessionWebSocketTask.Message {
            if self.helloDelayMs > 0 {
                try await Task.sleep(nanoseconds: UInt64(self.helloDelayMs) * 1_000_000)
            }
            let id = self.connectRequestID.withLock { $0 } ?? "connect"
            return .data(Self.connectOkData(id: id))
        }

        func receive(
            completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
        {
            self.pendingReceiveHandler.withLock { $0 = completionHandler }
        }

        func emitIncoming(_ data: Data) {
            let handler = self.pendingReceiveHandler.withLock { $0 }
            handler?(Result<URLSessionWebSocketTask.Message, Error>.success(.data(data)))
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

        private static func responseData(id: String) -> Data {
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

    private final class FakeWebSocketSession: WebSocketSessioning, @unchecked Sendable {
        private let makeCount = OSAllocatedUnfairLock(initialState: 0)
        private let tasks = OSAllocatedUnfairLock(initialState: [FakeWebSocketTask]())
        private let helloDelayMs: Int

        init(helloDelayMs: Int = 0) {
            self.helloDelayMs = helloDelayMs
        }

        func snapshotMakeCount() -> Int { self.makeCount.withLock { $0 } }
        func snapshotCancelCount() -> Int {
            self.tasks.withLock { tasks in
                tasks.reduce(0) { $0 + $1.snapshotCancelCount() }
            }
        }

        func latestTask() -> FakeWebSocketTask? {
            self.tasks.withLock { $0.last }
        }

        func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
            _ = url
            self.makeCount.withLock { $0 += 1 }
            let task = FakeWebSocketTask(helloDelayMs: self.helloDelayMs)
            self.tasks.withLock { $0.append(task) }
            return WebSocketTaskBox(task: task)
        }
    }

    private final class ConfigSource: @unchecked Sendable {
        private let token = OSAllocatedUnfairLock<String?>(initialState: nil)

        init(token: String?) {
            self.token.withLock { $0 = token }
        }

        func snapshotToken() -> String? { self.token.withLock { $0 } }
        func setToken(_ value: String?) { self.token.withLock { $0 = value } }
    }

    @Test func requestReusesSingleWebSocketForSameConfig() async throws {
        let session = FakeWebSocketSession()
        let url = URL(string: "ws://example.invalid")!
        let cfg = ConfigSource(token: nil)
        let conn = GatewayConnection(
            configProvider: { (url: url, token: cfg.snapshotToken(), password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.snapshotCancelCount() == 0)
    }

    @Test func requestReconfiguresAndCancelsOnTokenChange() async throws {
        let session = FakeWebSocketSession()
        let url = URL(string: "ws://example.invalid")!
        let cfg = ConfigSource(token: "a")
        let conn = GatewayConnection(
            configProvider: { (url: url, token: cfg.snapshotToken(), password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)

        cfg.setToken("b")
        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 2)
        #expect(session.snapshotCancelCount() == 1)
    }

    @Test func concurrentRequestsStillUseSingleWebSocket() async throws {
        let session = FakeWebSocketSession(helloDelayMs: 150)
        let url = URL(string: "ws://example.invalid")!
        let cfg = ConfigSource(token: nil)
        let conn = GatewayConnection(
            configProvider: { (url: url, token: cfg.snapshotToken(), password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        async let r1: Data = conn.request(method: "status", params: nil)
        async let r2: Data = conn.request(method: "status", params: nil)
        _ = try await (r1, r2)

        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func subscribeReplaysLatestSnapshot() async throws {
        let session = FakeWebSocketSession()
        let url = URL(string: "ws://example.invalid")!
        let cfg = ConfigSource(token: nil)
        let conn = GatewayConnection(
            configProvider: { (url: url, token: cfg.snapshotToken(), password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        _ = try await conn.request(method: "status", params: nil)

        let stream = await conn.subscribe(bufferingNewest: 10)
        var iterator = stream.makeAsyncIterator()
        let first = await iterator.next()

        guard case let .snapshot(snap) = first else {
            Issue.record("expected snapshot, got \(String(describing: first))")
            return
        }
        #expect(snap.type == "hello-ok")
    }

    @Test func subscribeEmitsSeqGapBeforeEvent() async throws {
        let session = FakeWebSocketSession()
        let url = URL(string: "ws://example.invalid")!
        let cfg = ConfigSource(token: nil)
        let conn = GatewayConnection(
            configProvider: { (url: url, token: cfg.snapshotToken(), password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        let stream = await conn.subscribe(bufferingNewest: 10)
        var iterator = stream.makeAsyncIterator()

        _ = try await conn.request(method: "status", params: nil)
        _ = await iterator.next() // snapshot

        let evt1 = Data(
            """
            {"type":"event","event":"presence","payload":{"presence":[]},"seq":1}
            """.utf8)
        session.latestTask()?.emitIncoming(evt1)

        let firstEvent = await iterator.next()
        guard case let .event(firstFrame) = firstEvent else {
            Issue.record("expected event, got \(String(describing: firstEvent))")
            return
        }
        #expect(firstFrame.seq == 1)

        let evt3 = Data(
            """
            {"type":"event","event":"presence","payload":{"presence":[]},"seq":3}
            """.utf8)
        session.latestTask()?.emitIncoming(evt3)

        let gap = await iterator.next()
        guard case let .seqGap(expected, received) = gap else {
            Issue.record("expected seqGap, got \(String(describing: gap))")
            return
        }
        #expect(expected == 2)
        #expect(received == 3)

        let secondEvent = await iterator.next()
        guard case let .event(secondFrame) = secondEvent else {
            Issue.record("expected event, got \(String(describing: secondEvent))")
            return
        }
        #expect(secondFrame.seq == 3)
    }
}
