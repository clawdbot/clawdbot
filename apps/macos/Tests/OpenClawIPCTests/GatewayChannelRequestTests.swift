import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private struct GatewayRequestCancellationTimeout: Error {}

private actor GatewayRequestProbe {
    private var value: String?
    private var waiter: CheckedContinuation<String, Never>?

    func record(_ value: String) {
        self.value = value
        self.waiter?.resume(returning: value)
        self.waiter = nil
    }

    func wait() async -> String {
        if let value {
            return value
        }
        return await withCheckedContinuation { self.waiter = $0 }
    }
}

private actor GatewayRequestStartGate {
    private var entered = false
    private var enteredWaiter: CheckedContinuation<Void, Never>?
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func wait() async {
        self.entered = true
        self.enteredWaiter?.resume()
        self.enteredWaiter = nil
        await withCheckedContinuation { self.releaseWaiter = $0 }
    }

    func waitUntilEntered() async {
        if self.entered {
            return
        }
        await withCheckedContinuation { self.enteredWaiter = $0 }
    }

    func release() {
        self.releaseWaiter?.resume()
        self.releaseWaiter = nil
    }
}

struct GatewayChannelRequestTests {
    private func makeSession(requestSendDelayMs: Int) -> GatewayTestWebSocketSession {
        GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { _, _, sendIndex in
                        guard sendIndex == 1 else { return }
                        try await Task.sleep(nanoseconds: UInt64(requestSendDelayMs) * 1_000_000)
                        throw URLError(.cannotConnectToHost)
                    })
            })
    }

    @Test func `request timeout then send failure does not double resume`() async throws {
        let session = self.makeSession(requestSendDelayMs: 100)
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
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

    @Test func `request cancellation removes pending waiter and ignores late response`() async throws {
        let probe = GatewayRequestProbe()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                    guard sendIndex == 1,
                          let requestID = GatewayWebSocketTestSupport.requestID(from: message)
                    else { return }
                    await probe.record(requestID)
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))
        let request = Task {
            try await channel.request(method: "cancel-me", params: nil, timeoutMs: 5000)
        }
        let requestID = await probe.wait()
        #expect(await channel._test_pendingRequestCount() == 1)

        request.cancel()

        await #expect(throws: CancellationError.self) {
            try await AsyncTimeout.withTimeout(
                seconds: 1,
                onTimeout: { GatewayRequestCancellationTimeout() },
                operation: { try await request.value })
        }
        #expect(await channel._test_pendingRequestCount() == 0)

        let socket = try #require(session.latestTask())
        socket.emitReceiveSuccessOnce(.data(GatewayWebSocketTestSupport.okResponseData(id: requestID)))
        await Task.yield()
        #expect(await channel._test_pendingRequestCount() == 0)
    }

    @Test func `request cancellation wins after response resumes`() async throws {
        let probe = GatewayRequestProbe()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                    guard sendIndex == 1,
                          let requestID = GatewayWebSocketTestSupport.requestID(from: message)
                    else { return }
                    await probe.record(requestID)
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))
        let resumedGate = GatewayRequestStartGate()
        await channel._test_setRequestResumedHandler { await resumedGate.wait() }
        let request = Task {
            try await channel.request(method: "response-cancel-race", params: nil, timeoutMs: 5000)
        }
        let requestID = await probe.wait()
        let socket = try #require(session.latestTask())

        socket.emitReceiveSuccessOnce(.data(GatewayWebSocketTestSupport.okResponseData(id: requestID)))
        await resumedGate.waitUntilEntered()
        request.cancel()
        await resumedGate.release()

        await #expect(throws: CancellationError.self) {
            try await request.value
        }
        #expect(await channel._test_pendingRequestCount() == 0)
    }

    @Test func `request cancellation wins after disconnect resumes an error`() async throws {
        let probe = GatewayRequestProbe()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                    guard sendIndex == 1,
                          let requestID = GatewayWebSocketTestSupport.requestID(from: message)
                    else { return }
                    await probe.record(requestID)
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))
        let resumedGate = GatewayRequestStartGate()
        await channel._test_setRequestResumedHandler { await resumedGate.wait() }
        let request = Task {
            try await channel.request(method: "disconnect-cancel-race", params: nil, timeoutMs: 5000)
        }
        _ = await probe.wait()
        let socket = try #require(session.latestTask())

        socket.emitReceiveFailure()
        await resumedGate.waitUntilEntered()
        request.cancel()
        await resumedGate.release()

        await #expect(throws: CancellationError.self) {
            try await request.value
        }
        #expect(await channel._test_pendingRequestCount() == 0)
    }

    @Test func `pre-cancelled request never dispatches`() async throws {
        let session = GatewayTestWebSocketSession()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))
        try await channel.connect()
        let socket = try #require(session.latestTask())
        #expect(socket.snapshotSendCount() == 1)
        let gate = GatewayRequestStartGate()
        let request = Task {
            await gate.wait()
            return try await channel.request(method: "never-send", params: nil, timeoutMs: 100)
        }
        await gate.waitUntilEntered()

        request.cancel()
        await gate.release()

        await #expect(throws: CancellationError.self) {
            try await request.value
        }
        await Task.yield()
        #expect(socket.snapshotSendCount() == 1)
        #expect(await channel._test_pendingRequestCount() == 0)
    }

    @Test func `pre-cancelled send never dispatches`() async throws {
        let session = GatewayTestWebSocketSession()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))
        try await channel.connect()
        let socket = try #require(session.latestTask())
        #expect(socket.snapshotSendCount() == 1)
        let gate = GatewayRequestStartGate()
        let send = Task {
            await gate.wait()
            try await channel.send(method: "never-send", params: nil)
        }
        await gate.waitUntilEntered()

        send.cancel()
        await gate.release()

        await #expect(throws: CancellationError.self) {
            try await send.value
        }
        await Task.yield()
        #expect(socket.snapshotSendCount() == 1)
    }

    @Test func `request cancellation leaves a shared connect promptly`() async throws {
        let connectGate = GatewayRequestStartGate()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, _, sendIndex in
                    guard sendIndex == 0 else { return }
                    await connectGate.wait()
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))
        let connecting = Task { try await channel.connect() }
        await connectGate.waitUntilEntered()
        let request = Task {
            try await channel.request(method: "cancel-during-connect", params: nil, timeoutMs: 5000)
        }
        for _ in 0..<1000 {
            if await channel._test_connectWaiterCount() == 2 {
                break
            }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(await channel._test_connectWaiterCount() == 2)

        request.cancel()

        await #expect(throws: CancellationError.self) {
            try await AsyncTimeout.withTimeout(
                seconds: 1,
                onTimeout: { GatewayRequestCancellationTimeout() },
                operation: { try await request.value })
        }
        #expect(await channel._test_connectWaiterCount() == 1)
        #expect(await channel._test_pendingRequestCount() == 0)
        let socket = try #require(session.latestTask())
        #expect(socket.snapshotSendCount() == 1)

        await connectGate.release()
        try await connecting.value
    }

    @Test func `cancelling the initiating connect leaves the shared attempt alive`() async throws {
        let connectGate = GatewayRequestStartGate()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, _, sendIndex in
                    guard sendIndex == 0 else { return }
                    await connectGate.wait()
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))
        let initiator = Task { try await channel.connect() }
        await connectGate.waitUntilEntered()
        let peer = Task { try await channel.connect() }
        for _ in 0..<1000 {
            if await channel._test_connectWaiterCount() == 2 {
                break
            }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(await channel._test_connectWaiterCount() == 2)

        initiator.cancel()

        await #expect(throws: CancellationError.self) {
            try await AsyncTimeout.withTimeout(
                seconds: 1,
                onTimeout: { GatewayRequestCancellationTimeout() },
                operation: { try await initiator.value })
        }
        #expect(await channel._test_connectWaiterCount() == 1)
        let socket = try #require(session.latestTask())
        #expect(socket.snapshotSendCount() == 1)

        await connectGate.release()
        try await peer.value
        #expect(await channel._test_connectWaiterCount() == 0)
        #expect(socket.snapshotSendCount() == 1)
    }
}
