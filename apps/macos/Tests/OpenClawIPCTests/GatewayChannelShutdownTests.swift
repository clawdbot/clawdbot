import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private actor GatewayHandshakeGate {
    private var started = false
    private var released = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        self.started = true
        guard !self.released else { return }
        await withCheckedContinuation { continuation in
            self.waiters.append(continuation)
        }
    }

    func hasStarted() -> Bool {
        self.started
    }

    func release() {
        self.released = true
        let waiters = self.waiters
        self.waiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }
}

private actor GatewaySnapshotProbe {
    private var count = 0

    func record(_ push: GatewayPush) {
        if case .snapshot = push {
            self.count += 1
        }
    }

    func value() -> Int {
        self.count
    }
}

struct GatewayChannelShutdownTests {
    @Test func `shutdown prevents reconnect loop from receive failure`() async throws {
        let session = GatewayTestWebSocketSession()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        // Establish a connection so `listen()` is active.
        try await channel.connect()
        #expect(session.snapshotMakeCount() == 1)

        // Simulate a socket receive failure, which would normally schedule a reconnect.
        session.latestTask()?.emitReceiveFailure()

        // Shut down quickly, before backoff reconnect triggers.
        await channel.shutdown()

        // Wait longer than the default reconnect backoff (500ms) to ensure no reconnect happens.
        try? await Task.sleep(nanoseconds: 750 * 1_000_000)

        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func `shutdown rejects a buffered handshake before applying hello state`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try await DeviceIdentityStore.withStateDirectory(tempDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            let responseGate = GatewayHandshakeGate()
            let snapshots = GatewaySnapshotProbe()
            let session = GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(receiveHook: { task, receiveIndex in
                    if receiveIndex == 0 {
                        return .data(GatewayWebSocketTestSupport.connectChallengeData())
                    }
                    await responseGate.wait()
                    let id = task.snapshotConnectRequestID() ?? "connect"
                    return .data(GatewayWebSocketTestSupport.connectOkData(
                        id: id,
                        tickIntervalMs: 1,
                        deviceToken: "stale-device-token"))
                })
            })
            let channel = try GatewayChannelActor(
                url: #require(URL(string: "ws://example.invalid")),
                token: nil,
                session: WebSocketSessionBox(session: session),
                pushHandler: { push, _ in await snapshots.record(push) })

            let connect = Task { try await channel.connect() }
            for _ in 0..<100 {
                if await responseGate.hasStarted() { break }
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            #expect(await responseGate.hasStarted())

            await channel.shutdown()
            await responseGate.release()

            await #expect(throws: (any Error).self) {
                try await connect.value
            }
            #expect(await channel.currentIssuedDeviceAuthRoles().isEmpty)
            #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator") == nil)
            #expect(await snapshots.value() == 0)
        }
    }
}
