import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor GatewayChannelCountProbe {
    private var count = 0
    private var waiters: [(target: Int, continuation: CheckedContinuation<Void, Never>)] = []

    func record() {
        self.count += 1
        let ready = self.waiters.filter { self.count >= $0.target }
        self.waiters.removeAll { self.count >= $0.target }
        for waiter in ready {
            waiter.continuation.resume()
        }
    }

    func waitForCount(_ target: Int) async {
        guard self.count < target else { return }
        await withCheckedContinuation { continuation in
            self.waiters.append((target, continuation))
        }
    }

    func value() -> Int {
        self.count
    }
}

private actor GatewayChannelDisconnectProbe {
    private var reasons: [String] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func record(_ reason: String) {
        self.reasons.append(reason)
        let waiters = self.waiters
        self.waiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }

    func waitForDisconnect() async {
        guard self.reasons.isEmpty else { return }
        await withCheckedContinuation { continuation in
            self.waiters.append(continuation)
        }
    }

    func values() -> [String] {
        self.reasons
    }
}

private actor GatewayChannelDisconnectGate {
    private var hasStarted = false
    private var isOpen = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        self.hasStarted = true
        let startWaiters = self.startWaiters
        self.startWaiters.removeAll()
        for waiter in startWaiters {
            waiter.resume()
        }
        guard !self.isOpen else { return }
        await withCheckedContinuation { continuation in
            self.waiters.append(continuation)
        }
    }

    func waitForStart() async {
        guard !self.hasStarted else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func open() {
        self.isOpen = true
        let waiters = self.waiters
        self.waiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }
}

private final class GatewayChannelTaskAttemptCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func next() -> Int {
        self.lock.lock()
        defer { self.lock.unlock() }
        let current = self.value
        self.value += 1
        return current
    }
}

struct GatewayChannelDisconnectTests {
    @Test func `manual reconnect retires a terminal socket before replacement`() async throws {
        let session = GatewayTestWebSocketSession()
        let disconnects = GatewayChannelDisconnectProbe()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            disconnectHandler: { reason, _ in await disconnects.record(reason) })

        try await channel.connect()
        let firstTask = try #require(session.latestTask())
        let pending = Task { () -> Bool in
            do {
                _ = try await channel.request(method: "never.responds", params: nil, timeoutMs: 0)
                return false
            } catch {
                return true
            }
        }
        while firstTask.snapshotSendCount() < 2 {
            await Task.yield()
        }
        firstTask.state = .completed

        try await channel.connect()
        #expect(await pending.value)
        await channel.shutdown()

        let reasons = await disconnects.values()
        #expect(reasons.count == 1)
        #expect(reasons.first?.contains("socket stopped") == true)
        #expect(session.snapshotMakeCount() == 2)
    }

    @Test func `tick timeout notifies once before reconnect`() async throws {
        let attempts = GatewayChannelTaskAttemptCounter()
        let session = GatewayTestWebSocketSession(taskFactory: {
            let attempt = attempts.next()
            return GatewayTestWebSocketTask(receiveHook: { task, receiveIndex in
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                let id = task.snapshotConnectRequestID() ?? "connect"
                let tickIntervalMs = attempt == 0 ? 1 : 30000
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: id,
                    tickIntervalMs: tickIntervalMs))
            })
        })
        let disconnects = GatewayChannelDisconnectProbe()
        let cleanupGate = GatewayChannelDisconnectGate()
        let snapshots = GatewayChannelCountProbe()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            pushHandler: { push, _ in
                if case .snapshot = push {
                    await snapshots.record()
                }
            },
            disconnectHandler: { reason, _ in
                await disconnects.record(reason)
                await cleanupGate.wait()
            })

        try await channel.connect()
        await snapshots.waitForCount(1)
        await disconnects.waitForDisconnect()
        #expect(session.snapshotMakeCount() == 1)

        await cleanupGate.open()
        await snapshots.waitForCount(2)
        try await channel.connect()
        await channel.shutdown()

        let reasons = await disconnects.values()
        #expect(reasons.count == 1)
        #expect(reasons.first?.contains("tick missed") == true)
        #expect(session.snapshotMakeCount() == 2)
    }

    @Test func `request send failure notifies once before reconnect`() async throws {
        let (channel, session, disconnects, cleanupGate, snapshots) = try self.makeSendFailureChannel()
        try await channel.connect()
        await snapshots.waitForCount(1)

        let request = Task { () -> Bool in
            do {
                _ = try await channel.request(method: "test.request", params: nil, timeoutMs: 0)
                return false
            } catch {
                return true
            }
        }
        await disconnects.waitForDisconnect()
        #expect(session.snapshotMakeCount() == 1)

        await cleanupGate.open()
        #expect(await request.value)
        await snapshots.waitForCount(2)
        try await channel.connect()
        await channel.shutdown()

        let reasons = await disconnects.values()
        #expect(reasons.count == 1)
        #expect(reasons.first?.contains("gateway send test.request") == true)
        #expect(session.snapshotMakeCount() == 2)
    }

    @Test func `one way send failure notifies once before reconnect`() async throws {
        let (channel, session, disconnects, cleanupGate, snapshots) = try self.makeSendFailureChannel()
        try await channel.connect()
        await snapshots.waitForCount(1)

        let send = Task { () -> Bool in
            do {
                try await channel.send(method: "test.send", params: nil)
                return false
            } catch {
                return true
            }
        }
        await disconnects.waitForDisconnect()
        #expect(session.snapshotMakeCount() == 1)

        await cleanupGate.open()
        #expect(await send.value)
        await snapshots.waitForCount(2)
        try await channel.connect()
        await channel.shutdown()

        let reasons = await disconnects.values()
        #expect(reasons.count == 1)
        #expect(reasons.first?.contains("gateway send test.send") == true)
        #expect(session.snapshotMakeCount() == 2)
    }

    @Test func `failed manual connect transfers automatic reconnect ownership`() async throws {
        let attempts = GatewayChannelTaskAttemptCounter()
        let session = GatewayTestWebSocketSession(taskFactory: {
            let attempt = attempts.next()
            return GatewayTestWebSocketTask(
                sendHook: { _, _, sendIndex in
                    guard attempt == 0, sendIndex == 1 else { return }
                    throw URLError(.networkConnectionLost)
                },
                receiveHook: { task, receiveIndex in
                    if receiveIndex == 0 {
                        return .data(GatewayWebSocketTestSupport.connectChallengeData())
                    }
                    if attempt == 1 {
                        throw URLError(.cannotConnectToHost)
                    }
                    let id = task.snapshotConnectRequestID() ?? "connect"
                    return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
                })
        })
        let snapshots = GatewayChannelCountProbe()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            pushHandler: { push, _ in
                if case .snapshot = push {
                    await snapshots.record()
                }
            },
            disconnectHandler: { _, _ in })

        try await channel.connect()
        await snapshots.waitForCount(1)
        await #expect(throws: (any Error).self) {
            try await channel.send(method: "force.disconnect", params: nil)
        }

        let clock = ContinuousClock()
        let retryStartedAt = clock.now
        await #expect(throws: (any Error).self) {
            try await channel.connect()
        }
        await snapshots.waitForCount(2)
        let retryDuration = retryStartedAt.duration(to: clock.now)
        await channel.shutdown()

        #expect(session.snapshotMakeCount() == 3)
        #expect(retryDuration < .seconds(5))
    }

    @Test func `event waiting behind seq gap is dropped after disconnect`() async throws {
        let attempts = GatewayChannelTaskAttemptCounter()
        let session = GatewayTestWebSocketSession(taskFactory: {
            let attempt = attempts.next()
            return GatewayTestWebSocketTask(sendHook: { _, _, sendIndex in
                guard attempt == 0, sendIndex == 1 else { return }
                throw URLError(.networkConnectionLost)
            })
        })
        let snapshots = GatewayChannelCountProbe()
        let events = GatewayChannelCountProbe()
        let seqGapGate = GatewayChannelDisconnectGate()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            pushHandler: { push, _ in
                switch push {
                case .snapshot:
                    await snapshots.record()
                case .event:
                    await events.record()
                case .seqGap:
                    await seqGapGate.wait()
                }
            },
            disconnectHandler: { _, _ in })

        try await channel.connect()
        await snapshots.waitForCount(1)
        let firstTask = try #require(session.latestTask())
        firstTask.emitReceiveSuccessOnce(.data(GatewayWebSocketTestSupport.eventData(seq: 1)))
        await events.waitForCount(1)
        while !firstTask.hasPendingReceiveHandler() {
            await Task.yield()
        }

        firstTask.emitReceiveSuccessOnce(.data(GatewayWebSocketTestSupport.eventData(seq: 3)))
        await seqGapGate.waitForStart()
        await #expect(throws: (any Error).self) {
            try await channel.send(method: "force.disconnect", params: nil)
        }
        await seqGapGate.open()
        await snapshots.waitForCount(2)
        await channel.shutdown()

        #expect(await events.value() == 1)
    }

    @Test func `generation bound send never reconnects onto replacement socket`() async throws {
        let session = GatewayTestWebSocketSession()
        let snapshots = GatewayChannelCountProbe()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            pushHandler: { push, _ in
                if case .snapshot = push {
                    await snapshots.record()
                }
            },
            disconnectHandler: { _, _ in })

        try await channel.connect()
        await snapshots.waitForCount(1)
        let firstTask = try #require(session.latestTask())
        while !firstTask.hasPendingReceiveHandler() {
            await Task.yield()
        }
        firstTask.emitReceiveFailure()
        await snapshots.waitForCount(2)
        let replacementTask = try #require(session.latestTask())

        await #expect(throws: CancellationError.self) {
            try await channel.send(
                method: "node.invoke.result",
                params: nil,
                ifCurrentConnectionGeneration: 1)
        }

        // The replacement sent only its connect request; the stale result never
        // reached its socket and did not trigger a third connection.
        #expect(replacementTask.snapshotSendCount() == 1)
        #expect(session.snapshotMakeCount() == 2)
        await channel.shutdown()
    }

    private func makeSendFailureChannel() throws -> (
        GatewayChannelActor,
        GatewayTestWebSocketSession,
        GatewayChannelDisconnectProbe,
        GatewayChannelDisconnectGate,
        GatewayChannelCountProbe)
    {
        let attempts = GatewayChannelTaskAttemptCounter()
        let session = GatewayTestWebSocketSession(taskFactory: {
            let attempt = attempts.next()
            return GatewayTestWebSocketTask(sendHook: { _, _, sendIndex in
                guard attempt == 0, sendIndex == 1 else { return }
                throw URLError(.networkConnectionLost)
            })
        })
        let disconnects = GatewayChannelDisconnectProbe()
        let cleanupGate = GatewayChannelDisconnectGate()
        let snapshots = GatewayChannelCountProbe()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            pushHandler: { push, _ in
                if case .snapshot = push {
                    await snapshots.record()
                }
            },
            disconnectHandler: { reason, _ in
                await disconnects.record(reason)
                await cleanupGate.wait()
            })
        return (channel, session, disconnects, cleanupGate, snapshots)
    }
}
