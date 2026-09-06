import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct WorkActivityStoreTests {
    @Test func `replacement primary clears old work without retiring the new same-key tool`() async throws {
        try await TestIsolation.withIsolatedState {
            let connection = makeActivityGatewayConnection(mainSessionKey: "main")
            let control = ControlChannel(gateway: connection, endpointRevision: { 1 })
            let store = WorkActivityStore.shared
            let previousMainKey = store.mainSessionKey
            defer {
                store.handleJob(sessionKey: "main", state: "done")
                store.setMainSessionKey(previousMainKey)
            }
            store.setMainSessionKey("before-primary")
            _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
            #expect(await self.eventually { store.mainSessionKey == "main" })

            store.handleJob(sessionKey: "main", state: "started")
            store.handleTool(sessionKey: "main", phase: "start", name: "read", meta: "old-tool", args: nil)
            store.handleTool(sessionKey: "main", phase: "result", name: "read", meta: "old-tool", args: nil)

            // The heartbeat acknowledges that the primary consumer processed the preceding hello.
            await connection.shutdown()
            _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
            let snapshot = try #require(await connection.lastSnapshot)
            await connection._test_handlePush(.snapshot(snapshot), socketGeneration: 1)
            await connection._test_handlePush(
                .event(EventFrame(
                    type: "event",
                    event: "heartbeat",
                    payload: AnyCodable(["ts": 1, "status": "work-lifetime-proof"]))),
                socketGeneration: 1)
            #expect(await self.eventually { control.lastHeartbeatEvent?.status == "work-lifetime-proof" })
            #expect(store.current == nil)
            #expect(store.iconState == .idle)
            #expect(store.lastToolUpdatedAt == nil)

            store.handleTool(sessionKey: "main", phase: "start", name: "read", meta: "new-tool", args: nil)
            let newTool = store.current
            let newToolUpdatedAt = store.lastToolUpdatedAt
            try? await Task.sleep(for: .seconds(3))
            #expect(store.current == newTool)
            #expect(store.iconState == .workingMain(.tool(.read)))
            #expect(store.lastToolUpdatedAt == newToolUpdatedAt)
            await control.disconnect()
        }
    }

    private func eventually(_ predicate: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            if predicate() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return predicate()
    }

    @Test func `main session job preempts other`() {
        let store = WorkActivityStore()

        store.handleJob(sessionKey: "discord:group:1", state: "started")
        #expect(store.iconState == .workingOther(.job))
        #expect(store.current?.sessionKey == "discord:group:1")

        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))
        #expect(store.current?.sessionKey == "main")

        store.handleJob(sessionKey: "main", state: "finished")
        #expect(store.iconState == .workingOther(.job))
        #expect(store.current?.sessionKey == "discord:group:1")

        store.handleJob(sessionKey: "discord:group:1", state: "finished")
        #expect(store.iconState == .idle)
        #expect(store.current == nil)
    }

    @Test func `job stays working after tool result grace`() async {
        let store = WorkActivityStore()

        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))

        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "read",
            meta: nil,
            args: ["path": AnyCodable("/tmp/file.txt")])
        #expect(store.iconState == .workingMain(.tool(.read)))

        store.handleTool(
            sessionKey: "main",
            phase: "result",
            name: "read",
            meta: nil,
            args: ["path": AnyCodable("/tmp/file.txt")])

        for _ in 0..<50 {
            if store.iconState == .workingMain(.job) { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(store.iconState == .workingMain(.job))

        store.handleJob(sessionKey: "main", state: "done")
        #expect(store.iconState == .idle)
    }

    @Test func `tool label extracts first line and shortens home`() {
        let store = WorkActivityStore()
        let home = NSHomeDirectory()

        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "bash",
            meta: nil,
            args: [
                "command": AnyCodable("echo hi\necho bye"),
                "path": AnyCodable("\(home)/Projects/openclaw"),
            ])

        #expect(store.current?.label == "bash: echo hi")
        #expect(store.iconState == .workingMain(.tool(.bash)))

        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "read",
            meta: nil,
            args: ["path": AnyCodable("\(home)/secret.txt")])

        #expect(store.current?.label == "read: ~/secret.txt")
        #expect(store.iconState == .workingMain(.tool(.read)))
    }

    @Test func `resolve icon state honors override selection`() {
        let store = WorkActivityStore()
        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))

        store.resolveIconState(override: .idle)
        #expect(store.iconState == .idle)

        store.resolveIconState(override: .otherEdit)
        #expect(store.iconState == .overridden(.tool(.edit)))
    }
}

func makeActivityGatewayConnection(mainSessionKey: String) -> GatewayConnection {
    let session = GatewayTestWebSocketSession(taskFactory: {
        GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
            guard sendIndex > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
        }, receiveHook: { socket, receiveIndex in
            if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
            return .data(GatewayWebSocketTestSupport.connectOkData(
                id: socket.snapshotConnectRequestID() ?? "connect", mainSessionKey: mainSessionKey))
        })
    })
    return GatewayConnection(
        testEndpointProvider: {
            GatewayConnection.EndpointSnapshot(
                config: (URL(string: "ws://127.0.0.1:49229")!, nil, nil), routeAuthority: nil, revision: 1)
        },
        currentEndpointRevision: { 1 },
        sessionBox: WebSocketSessionBox(session: session))
}
