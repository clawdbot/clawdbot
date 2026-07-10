import Foundation
import OpenClawChatUI
import OpenClawKit
import os
import Testing
@testable import OpenClaw

struct GatewayConnectionTests {
    private func makeConnection(
        session: GatewayTestWebSocketSession,
        token: String? = nil) throws -> (GatewayConnection, ConfigSource)
    {
        let url = try #require(URL(string: "ws://example.invalid"))
        let cfg = ConfigSource(token: token)
        let conn = GatewayConnection(
            configProvider: { (url: url, token: cfg.snapshotToken(), password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        return (conn, cfg)
    }

    private func makeSession(
        helloDelayMs: Int = 0,
        serverCapabilities: [String] = []) -> GatewayTestWebSocketSession
    {
        GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0 else { return }
                        guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        let response = GatewayWebSocketTestSupport.okResponseData(id: id)
                        task.emitReceiveSuccess(.data(response))
                    },
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        if helloDelayMs > 0 {
                            try await Task.sleep(nanoseconds: UInt64(helloDelayMs) * 1_000_000)
                        }
                        let id = task.snapshotConnectRequestID() ?? "connect"
                        return .data(Self.connectOkData(id: id, capabilities: serverCapabilities))
                    })
            })
    }

    private static func connectOkData(id: String, capabilities: [String]) -> Data {
        let encodedCapabilities = capabilities.map { "\"\($0)\"" }.joined(separator: ",")
        return Data(
            """
            {
              "type":"res","id":"\(id)","ok":true,"payload":{
                "type":"hello-ok","protocol":4,
                "server":{"version":"test","connId":"test"},
                "features":{"methods":[],"events":[],"capabilities":[\(encodedCapabilities)]},
                "snapshot":{"presence":[],"health":{},"stateVersion":{"presence":0,"health":0},"uptimeMs":0},
                "auth":{},"policy":{}
              }
            }
            """.utf8)
    }

    private final class ConfigSource: @unchecked Sendable {
        private let token = OSAllocatedUnfairLock<String?>(initialState: nil)

        init(token: String?) {
            self.token.withLock { $0 = token }
        }

        func snapshotToken() -> String? {
            self.token.withLock { $0 }
        }

        func setToken(_ value: String?) {
            self.token.withLock { $0 = value }
        }
    }

    @Test func `request reuses single web socket for same config`() async throws {
        let session = self.makeSession()
        let (conn, _) = try makeConnection(session: session)

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.snapshotCancelCount() == 0)
    }

    @Test func `first connection admits hello capabilities before lease readiness`() async throws {
        let session = self.makeSession(serverCapabilities: ["crestodian-setup-model-ref"])
        let (conn, _) = try makeConnection(session: session)

        let lease = try await conn.acquireServerLease()

        #expect(await conn.supportsServerCapability(
            .crestodianSetupModelRef,
            ifCurrentServerLease: lease) == true)
        #expect(await conn.cachedGatewayVersion() == "test")
        #expect(session.snapshotMakeCount() == 1)
        // Connect handshake plus the recovery-aware health preflight.
        #expect(session.latestTask()?.snapshotSendCount() == 2)
        await conn.shutdown()
    }

    @Test func `disconnected server lease rejects before dispatch`() async throws {
        let session = self.makeSession(serverCapabilities: ["crestodian-setup-model-ref"])
        let (conn, _) = try makeConnection(session: session)
        let lease = try await conn.acquireServerLease()

        await conn._test_handleDisconnect(socketGeneration: 1)
        do {
            _ = try await conn.request(
                method: "crestodian.setup.detect",
                params: [:],
                ifCurrentServerLease: lease)
            Issue.record("expected disconnected server lease rejection")
        } catch is OpenClawChatTransportSendError {} catch {
            Issue.record("unexpected disconnected lease error: \(error)")
        }

        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
        await conn.shutdown()
    }

    @Test func `server lease preserves caller cancellation after dispatch`() async throws {
        let requestSent = AsyncStream<Void>.makeStream()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0 else { return }
                        if sendIndex == 2 {
                            requestSent.continuation.yield()
                            return
                        }
                        guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    },
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        let id = task.snapshotConnectRequestID() ?? "connect"
                        return .data(Self.connectOkData(
                            id: id,
                            capabilities: ["crestodian-setup-model-ref"]))
                    })
            })
        let (conn, _) = try makeConnection(session: session)
        let lease = try await conn.acquireServerLease()
        let request = Task {
            try await conn.request(
                method: "crestodian.setup.activate",
                params: [:],
                timeoutMs: 5000,
                ifCurrentServerLease: lease)
        }
        var sentIterator = requestSent.stream.makeAsyncIterator()
        _ = await sentIterator.next()

        request.cancel()

        await #expect(throws: CancellationError.self) {
            try await request.value
        }
        requestSent.continuation.finish()
        await conn.shutdown()
    }

    @Test func `request reconfigures and cancels on token change`() async throws {
        let session = self.makeSession()
        let (conn, cfg) = try makeConnection(session: session, token: "a")

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)

        cfg.setToken("b")
        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 2)
        #expect(session.snapshotCancelCount() == 1)
    }

    @Test func `captured route cancels instead of reconfiguring on token change`() async throws {
        let session = self.makeSession()
        let (conn, cfg) = try makeConnection(session: session, token: "a")

        _ = try await conn.request(method: "status", params: nil)
        let route = try #require(await conn.captureRoute())
        cfg.setToken("b")

        do {
            _ = try await conn.request(
                method: "status",
                params: nil,
                ifCurrentRoute: route)
            Issue.record("expected stale route cancellation")
        } catch is CancellationError {}

        do {
            _ = try await conn.request(
                method: "status",
                params: nil,
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: true)
            Issue.record("expected typed stale route rejection")
        } catch is OpenClawChatTransportSendError {}

        #expect(session.snapshotMakeCount() == 1)
        #expect(session.snapshotCancelCount() == 0)
    }

    @Test func `concurrent requests still use single web socket`() async throws {
        let session = self.makeSession(helloDelayMs: 150)
        let (conn, _) = try makeConnection(session: session)

        async let r1: Data = conn.request(method: "status", params: nil)
        async let r2: Data = conn.request(method: "status", params: nil)
        _ = try await (r1, r2)

        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func `request can disable retries for non idempotent mutations`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, _, sendIndex in
                    if sendIndex > 0 {
                        throw URLError(.timedOut)
                    }
                })
            })
        let (conn, _) = try makeConnection(session: session)

        do {
            _ = try await conn.request(
                method: "sessions.compact",
                params: nil,
                timeoutMs: 10,
                retryTransportFailures: false)
            Issue.record("expected sessions.compact transport failure")
        } catch {}

        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
    }

    @Test func `subscribe replays latest snapshot`() async throws {
        let session = self.makeSession()
        let (conn, _) = try makeConnection(session: session)

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

    @Test func `subscribe emits seq gap before event`() async throws {
        let session = self.makeSession()
        let (conn, _) = try makeConnection(session: session)

        let stream = await conn.subscribe(bufferingNewest: 10)
        var iterator = stream.makeAsyncIterator()

        _ = try await conn.request(method: "status", params: nil)
        _ = await iterator.next() // snapshot

        let evt1 = Data(
            """
            {"type":"event","event":"presence","payload":{"presence":[]},"seq":1}
            """.utf8)
        session.latestTask()?.emitReceiveSuccess(.data(evt1))

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
        session.latestTask()?.emitReceiveSuccess(.data(evt3))

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
